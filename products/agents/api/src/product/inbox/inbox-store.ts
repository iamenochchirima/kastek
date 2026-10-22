import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { recordEvent } from "../../observability/event-store";
import { createCursorCodec, cursorKeysFromEnvironment } from "../../infrastructure/read-pages";
import { transaction } from "../../infrastructure/database";
import type { ChannelBinding } from "../../contracts/channel";
import type { ChannelKind } from "../../contracts/channel-adapters";
import { enqueueChannelMessage, type PreparedChannelDelivery } from "../channels/channel-outbound";
import {channelToolReviewText,channelToolReviewButtons,assertChannelToolReviewPrompt} from "../channels/channel-tool-reviews";
export type { ChannelBinding } from "../../contracts/channel";

type Db = Pool | PoolClient;
export interface InboxScope { organizationId: string; accountId: string }
export interface VisitorScope { deploymentId: string; sessionId: string }
export interface CustomerConversation {
  id: string; organization_id: string; deployment_id: string | null; agent_id: string; version_id: string; session_id: string | null;
  channel_kind: ChannelKind; channel_deployment_id: string | null; external_conversation_id: string | null; external_sender_id: string | null;
  execution_conversation_id: string | null; state: "automation_active" | "handoff_pending" | "human_owned" | "resolved";
  assignee_account_id: string | null; revision: string; ownership_generation: string; next_sequence: string;
  return_watermark: string; created_at: Date; updated_at: Date;
}
export interface CustomerMessage { id: string; conversation_id: string; sequence: string; author_kind: "visitor" | "human" | "assistant";
  author_account_id: string | null; body: string; task_id: string | null; ownership_generation: string; created_at: Date;
  channelFacts?: { occurredAt: Date | null; replyToProviderMessageId: string | null; attachments: {kind:string;fileName?:string;index:number}[] };
  deliveries?: {id:string;segment:number;state:string;reason:string|null}[] }
export interface InboxPorts {
  admit(db: PoolClient, input: { deploymentId: string; sessionId: string; versionId: string; executionConversationId: string | null;
    input: string; requestKey: string; channelBinding: ChannelBinding }): Promise<{ id: string; conversation_id: string }>;
  admitChannel?(db: PoolClient, input: { deploymentId: string; participantId: string; versionId: string; executionConversationId: string | null;
    input: string; requestKey: string; channelBinding: ChannelBinding }): Promise<{ id: string; conversation_id: string }>;
  readableOutput(db: Db, taskId: string, body: string): Promise<string | null>;
  cancelRoot(taskId: string): Promise<unknown>;
}
export type InboxCommand = { commandId: string; expectedRevision: string; action: "claim" | "assign" | "unassign" | "takeover" | "reply" | "resolve" | "reopen" | "return";
  assigneeAccountId?: string | null; body?: string };
const denied = (): never => { throw new PlatformError("INBOX_ACCESS_DENIED", 403, "Conversation access denied"); };
const conflict = (): never => { throw new PlatformError("INBOX_CONFLICT", 409, "Conversation changed. Refresh and try again"); };
const absent = (): never => { throw new PlatformError("INBOX_NOT_FOUND", 404, "Conversation not found"); };

export class InboxStore {
  constructor(readonly pool: Pool, readonly ports: InboxPorts, readonly cursors = createCursorCodec(cursorKeysFromEnvironment())) {}
  private async membership(db: Db, scope: InboxScope): Promise<"owner" | "member"> {
    const row = (await db.query(`SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE`, [scope.organizationId, scope.accountId])).rows[0];
    return row?.role ?? denied();
  }
  private async conversation(db: Db, id: string, lock = false): Promise<CustomerConversation> {
    return (await db.query<CustomerConversation>(`SELECT c.*,cn.id connection_id,cn.name connection_name,cn.asset_id FROM agents_platform.customer_conversations c
      LEFT JOIN agents_platform.channel_deployments cd ON cd.id=c.channel_deployment_id LEFT JOIN agents_platform.channel_connections cn ON cn.id=cd.connection_id
      WHERE c.id=$1 ${lock ? "FOR UPDATE OF c" : ""}`, [id])).rows[0] ?? absent();
  }
  private async visitor(db: Db, scope: VisitorScope): Promise<{ organization_id: string; agent_id: string; version_id: string }> {
    return (await db.query(`SELECT d.organization_id,d.agent_id,d.version_id FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.id=$1 AND s.id=$2 AND s.expires_at>now() AND d.revoked_at IS NULL AND d.paused=false FOR SHARE OF d,s`, [scope.deploymentId, scope.sessionId])).rows[0] ?? denied();
  }
  private async activeBinding(db:Db,row:CustomerConversation):Promise<boolean> {
    return Boolean(row.channel_kind==="website"
      ? (await db.query("SELECT 1 FROM agents_platform.website_deployments WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL AND paused=false FOR SHARE",[row.deployment_id,row.organization_id])).rowCount
      : (await db.query(`SELECT 1 FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections c ON c.id=d.connection_id
          WHERE d.id=$1 AND d.organization_id=$2 AND d.state='active' AND c.state='active' FOR SHARE OF d,c`,[row.channel_deployment_id,row.organization_id])).rowCount);
  }
  private async trialStaff(db:Db,scope:InboxScope,row:CustomerConversation,mutate=false):Promise<void> {
    const trial=(await db.query(`SELECT e.account_id,e.state,e.expires_at FROM agents_platform.evaluation_trials e
      WHERE EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels f WHERE f.trial_id=e.id AND f.session_id=$1)
        OR EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels f WHERE f.trial_id=e.id AND f.deployment_id=$2)
      LIMIT 1`,[row.session_id,row.channel_deployment_id])).rows[0];
    if(trial&&(trial.account_id!==scope.accountId||mutate&&(trial.state!=="active"||trial.expires_at.getTime()<=Date.now())))denied();
  }
  private async visitorConversation(db: Db, scope: VisitorScope, id: string, lock = false): Promise<CustomerConversation> {
    await this.visitor(db, scope); const row = await this.conversation(db, id, lock);
    if (row.deployment_id !== scope.deploymentId || row.session_id !== scope.sessionId) denied();
    return row;
  }
  async open(scope: VisitorScope): Promise<CustomerConversation> {
    return transaction(this.pool, async db => { const deployment = await this.visitor(db, scope);
      return (await db.query<CustomerConversation>(`INSERT INTO agents_platform.customer_conversations(id,organization_id,deployment_id,agent_id,version_id,session_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(deployment_id,session_id) DO UPDATE SET session_id=excluded.session_id RETURNING *`,
      [randomUUID(), deployment.organization_id, scope.deploymentId, deployment.agent_id, deployment.version_id, scope.sessionId])).rows[0]!;
    });
  }
  private async append(db: PoolClient, row: CustomerConversation, input: { key: string; digest: string; kind: CustomerMessage["author_kind"]; body: string; accountId?: string; taskId?: string }): Promise<CustomerMessage> {
    const message = (await db.query<CustomerMessage>(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,author_account_id,body,request_key,request_digest,task_id,ownership_generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), row.id, row.next_sequence, input.kind, input.accountId ?? null, input.body, input.key, input.digest, input.taskId ?? null, row.ownership_generation])).rows[0]!;
    const next = (await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET next_sequence=next_sequence+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0]!;
    Object.assign(row, next); return message;
  }
  async ingress(scope: VisitorScope, id: string, input: { requestKey: string; body: string }) {
    return transaction(this.pool, async db => {
      const location = (await db.query("SELECT organization_id FROM agents_platform.website_deployments WHERE id=$1", [scope.deploymentId])).rows[0] ?? denied();
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [location.organization_id]);
      const deployment = await this.visitor(db, scope);
      const row = await this.visitorConversation(db, scope, id, true), digest = requestDigest(input);
      const existing = (await db.query<CustomerMessage & { request_digest: string }>("SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2", [id, `visitor:${input.requestKey}`])).rows[0];
      if (existing) { if (existing.request_digest !== digest) conflict(); return { conversation: row, message: existing, replayed: true }; }
      if (row.state === "resolved") throw new PlatformError("CONVERSATION_RESOLVED", 409, "Conversation is resolved");
      const message = await this.append(db, row, { key: `visitor:${input.requestKey}`, digest, kind: "visitor", body: input.body });
      if (row.state === "automation_active") {
        const binding = { customerConversationId: row.id, ownershipGeneration: row.ownership_generation, inputMessageId: message.id };
        const task = await this.ports.admit(db, { deploymentId: scope.deploymentId, sessionId: scope.sessionId, versionId: deployment.version_id,
          executionConversationId: row.execution_conversation_id, input: input.body, requestKey: `channel:${message.id}`, channelBinding: binding });
        await db.query("UPDATE agents_platform.customer_messages SET task_id=$2 WHERE id=$1", [message.id, task.id]); message.task_id = task.id;
        await db.query("UPDATE agents_platform.customer_conversations SET execution_conversation_id=$2 WHERE id=$1", [id, task.conversation_id]); row.execution_conversation_id = task.conversation_id;
        await db.query("INSERT INTO agents_platform.customer_task_links(task_id,conversation_id,input_message_id,ownership_generation) VALUES($1,$2,$3,$4)", [task.id, id, message.id, row.ownership_generation]);
      }
      return { conversation: row, message, replayed: false };
    });
  }
  async ingressChannel(input: { deploymentId: string; externalConversationId: string; senderId: string; requestKey: string; body: string; requireHandoff?: boolean }) {
    if (![input.externalConversationId, input.senderId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) ||
      !input.requestKey || input.requestKey.length > 100 || !input.body.trim() || Buffer.byteLength(input.body) > 32768) throw new PlatformError("CHANNEL_INPUT_INVALID", 400, "Invalid channel message");
    return transaction(this.pool, async db => {
      const location = (await db.query("SELECT organization_id FROM agents_platform.channel_deployments WHERE id=$1", [input.deploymentId])).rows[0] ?? denied();
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [location.organization_id]);
      const deployment = (await db.query(`SELECT d.*,c.kind FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections c
        ON c.id=d.connection_id AND c.organization_id=d.organization_id WHERE d.id=$1 AND d.state='active' AND c.state='active' AND c.kind<>'website' FOR SHARE OF d,c`, [input.deploymentId])).rows[0] ?? denied();
      const row = (await db.query<CustomerConversation>(`INSERT INTO agents_platform.customer_conversations
        (id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(channel_deployment_id,external_conversation_id) WHERE channel_deployment_id IS NOT NULL
        DO UPDATE SET updated_at=agents_platform.customer_conversations.updated_at RETURNING *`,
      [randomUUID(), deployment.organization_id, deployment.agent_id, deployment.version_id, deployment.kind, deployment.id, input.externalConversationId, input.senderId])).rows[0]!;
      const digest = requestDigest(input), key = `channel:${input.requestKey}`;
      const existing = (await db.query<CustomerMessage & { request_digest: string }>("SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2", [row.id,key])).rows[0];
      if (existing) { if (existing.request_digest !== digest) conflict(); return { conversation: row, message: existing, replayed: true }; }
      if (row.state === "resolved") throw new PlatformError("CONVERSATION_RESOLVED",409,"Conversation is resolved");
      const message = await this.append(db,row,{key,digest,kind:"visitor",body:input.body});
      if (input.requireHandoff && row.state === "automation_active") {
        Object.assign(row,(await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET state='handoff_pending',revision=revision+1,ownership_generation=ownership_generation+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0]);
        await this.queueCancellation(db,row.id,row.ownership_generation);
      }
      if (row.state === "automation_active") {
        if (!this.ports.admitChannel) throw new PlatformError("CHANNEL_RUNTIME_UNAVAILABLE",503,"Channel execution is unavailable");
        const binding = {customerConversationId:row.id,ownershipGeneration:row.ownership_generation,inputMessageId:message.id};
        const task = await this.ports.admitChannel(db,{deploymentId:deployment.id,participantId:row.id,versionId:deployment.version_id,
          executionConversationId:row.execution_conversation_id,input:input.body,requestKey:`channel:${message.id}`,channelBinding:binding});
        await db.query("UPDATE agents_platform.customer_messages SET task_id=$2 WHERE id=$1",[message.id,task.id]); message.task_id=task.id;
        await db.query("UPDATE agents_platform.customer_conversations SET execution_conversation_id=$2 WHERE id=$1",[row.id,task.conversation_id]); row.execution_conversation_id=task.conversation_id;
        await db.query("INSERT INTO agents_platform.customer_task_links(task_id,conversation_id,input_message_id,ownership_generation) VALUES($1,$2,$3,$4)",[task.id,row.id,message.id,row.ownership_generation]);
      }
      return {conversation:row,message,replayed:false};
    });
  }
  private async messages(db: Db, id: string, after: string, limit: number, before?: string): Promise<CustomerMessage[]> {
    const rows = (await db.query<CustomerMessage>(after === "0" || before ? `SELECT * FROM (SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3) m ORDER BY sequence` :
      "SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", [id, before ?? (after === "0" ? null : after), limit])).rows;
    for (const message of rows) if (message.author_kind === "assistant") message.body = await this.readableMessage(db,message)??"[Response unavailable]";
    if (rows.length) {
      const facts = (await db.query("SELECT * FROM agents_platform.channel_message_facts WHERE message_id=ANY($1::uuid[])",[rows.map(row=>row.id)])).rows;
      const deliveries = (await db.query("SELECT id,message_id,segment,state,reason FROM agents_platform.channel_outbound WHERE message_id=ANY($1::uuid[]) ORDER BY segment",[rows.map(row=>row.id)])).rows;
      for (const message of rows) {
        const fact = facts.find(fact=>fact.message_id===message.id);
        if (fact) message.channelFacts={occurredAt:fact.provider_occurred_at,replyToProviderMessageId:fact.reply_to_provider_message_id,
          attachments:fact.attachments.map((attachment:{kind:string;fileName?:string},index:number)=>({kind:attachment.kind,fileName:attachment.fileName,index}))};
        message.deliveries=deliveries.filter(delivery=>delivery.message_id===message.id).map(delivery=>({id:delivery.id,segment:delivery.segment,state:delivery.state,reason:delivery.reason}));
      }
    }
    return rows;
  }
  async readVisitor(scope: VisitorScope, id: string, after = "0", limit = 100, before?: string) {
    return transaction(this.pool, async db => { const conversation = await this.visitorConversation(db, scope, id); return { conversation, messages: await this.messages(db, id, after, limit, before) }; });
  }
  async readStaff(scope: InboxScope, id: string, after = "0", limit = 100, before?: string) {
    return transaction(this.pool, async db => { await this.membership(db, scope); const conversation = await this.conversation(db, id); if (conversation.organization_id !== scope.organizationId) denied();
      await this.trialStaff(db,scope,conversation);
      return { conversation, messages: await this.messages(db, id, after, limit, before) }; });
  }
  async list(scope: InboxScope, filters: { state?: string; agentId?: string; channel?: ChannelKind; connectionId?: string; assigned?: string; cursor?: string; limit: number }) {
    return transaction(this.pool, async db => { await this.membership(db, scope);
      const scopeKey = { kind: "customer-inbox-v2", ...scope, state: filters.state ?? null, agentId: filters.agentId ?? null, assigned: filters.assigned ?? null, channel: filters.channel ?? null, connectionId: filters.connectionId ?? null };
      const anchor = this.cursors.read(filters.cursor, scopeKey);
      const rows = (await db.query<CustomerConversation & { cursor_position: string }>(`SELECT c.*,a.name AS agent_name,cn.id connection_id,cn.name connection_name,cn.asset_id,c.updated_at::text AS cursor_position FROM agents_platform.customer_conversations c JOIN agents_platform.agents a ON a.id=c.agent_id
        LEFT JOIN agents_platform.channel_deployments cd ON cd.id=c.channel_deployment_id LEFT JOIN agents_platform.channel_connections cn ON cn.id=cd.connection_id
        WHERE c.organization_id=$1 AND ($2::text IS NULL OR c.state=$2) AND ($3::uuid IS NULL OR c.agent_id=$3)
        AND ($4::text IS NULL OR ($4='mine' AND c.assignee_account_id=$5) OR ($4='unassigned' AND c.assignee_account_id IS NULL))
        AND ($10::text IS NULL OR c.channel_kind=$10)
        AND ($11::uuid IS NULL OR cn.id=$11)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id=c.session_id)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=c.channel_deployment_id)
        AND c.updated_at<=$6::timestamptz AND ($7::timestamptz IS NULL OR (c.updated_at,c.id)<($7::timestamptz,$8::uuid))
        ORDER BY c.updated_at DESC,c.id DESC LIMIT $9`, [scope.organizationId, filters.state ?? null, filters.agentId ?? null, filters.assigned ?? null, scope.accountId,
        anchor.snapshot, anchor.position || null, anchor.id || null, filters.limit + 1, filters.channel ?? null, filters.connectionId ?? null])).rows;
      const items = rows.slice(0, filters.limit), last = items.at(-1);
      return { items, nextCursor: rows.length > filters.limit && last ? this.cursors.next({ snapshot: anchor.snapshot, position: last.cursor_position, id: last.id }, scopeKey) : null };
    });
  }
  async members(scope: InboxScope) { return transaction(this.pool, async db => { await this.membership(db, scope); return (await db.query(`SELECT a.id,a.display_name FROM agents_platform.memberships m JOIN agents_platform.accounts a ON a.id=m.account_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL ORDER BY a.display_name,a.id LIMIT 200`, [scope.organizationId])).rows; }); }
  async command(scope: InboxScope, id: string, input: InboxCommand, preparedDelivery?:PreparedChannelDelivery, sourceDigest?:string) {
    const result = await transaction(this.pool, async db => {
      const role = await this.membership(db, scope), row = await this.conversation(db, id, true); if (row.organization_id !== scope.organizationId) denied();
      await this.trialStaff(db,scope,row,true);
      if(preparedDelivery&&input.action!=="reply")throw new PlatformError("CHANNEL_TEMPLATE_INVALID",400,"Templates require a staff reply");
      const digest = sourceDigest??requestDigest(preparedDelivery?{input,preparedDelivery}:input), existing = (await db.query("SELECT * FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2", [id, input.commandId])).rows[0];
      if (existing) { if (existing.actor_account_id !== scope.accountId || existing.request_digest !== digest) conflict(); return existing.result as CustomerConversation; }
      if (row.revision !== input.expectedRevision) conflict();
      const assigned = row.assignee_account_id === scope.accountId;
      let state = row.state, assignee = row.assignee_account_id, fence = false;
      switch (input.action) {
        case "claim": if (assignee && !assigned) denied(); assignee = scope.accountId; break;
        case "assign": { if (role !== "owner") denied(); const accountId = input.assigneeAccountId ?? denied(); await this.membership(db, { ...scope, accountId }); assignee = accountId; break; }
        case "unassign": if (role !== "owner" && !assigned) denied(); assignee = null; if (state === "human_owned") state = "handoff_pending"; fence = true; break;
        case "takeover": if (!assigned || state === "resolved") denied(); state = "human_owned"; fence = true; break;
        case "reply": if (!assigned || state !== "human_owned" || !input.body?.trim()) denied();
          { if(!await this.activeBinding(db,row))throw new PlatformError("CHANNEL_UNAVAILABLE",409,"Reconnect or resume this channel before replying");
            const body = input.body ?? denied(); const message = await this.append(db, row, { key: `human:${input.commandId}`, digest, kind: "human", body, accountId: scope.accountId });
            await db.query("INSERT INTO agents_platform.customer_deliveries(id,conversation_id,message_id,ownership_generation,state) VALUES($1,$2,$3,$4,'published')", [randomUUID(), id, message.id, row.ownership_generation]);
            await enqueueChannelMessage(db,row,message,preparedDelivery); } break;
        case "resolve": if (!assigned) denied(); state = "resolved"; fence = true; break;
        case "reopen": if (!assigned || state !== "resolved") denied(); state = "human_owned"; fence = true; break;
        case "return": if (!assigned || !["human_owned", "handoff_pending"].includes(state)) denied(); state = "automation_active"; fence = true; break;
      }
      const updated = (await db.query<CustomerConversation>(`UPDATE agents_platform.customer_conversations SET state=$2,assignee_account_id=$3,revision=revision+1,
        ownership_generation=ownership_generation+$4,return_watermark=CASE WHEN $5 THEN next_sequence-1 ELSE return_watermark END,updated_at=now() WHERE id=$1 RETURNING *`, [id, state, assignee, fence ? 1 : 0, input.action === "return" || input.action === "resolve"])).rows[0]!;
      if (fence) await this.queueCancellation(db, id, updated.ownership_generation);
      await db.query("INSERT INTO agents_platform.customer_commands(conversation_id,command_id,actor_account_id,action,request_digest,result) VALUES($1,$2,$3,$4,$5,$6)", [id, input.commandId, scope.accountId, input.action, digest, updated]);
      await this.observeCommand(db,id,input.commandId,input.action);
      return updated;
    });
    // The durable generation fence already applies if process loss interrupts this fast path.
    await this.drainCancellations().catch(() => undefined); return result;
  }
  private async observeCommand(db:PoolClient,conversationId:string,commandId:string,action:string) {
    // The most recent native turn is the causal context; body and staff identity stay in authorized Inbox reads.
    const task=(await db.query("SELECT l.task_id FROM agents_platform.customer_task_links l JOIN agents_platform.customer_messages m ON m.id=l.input_message_id WHERE l.conversation_id=$1 ORDER BY m.sequence DESC LIMIT 1",[conversationId])).rows[0];
    if(task)await recordEvent(db,task.task_id,`channel:command:${commandId}`,`channel.${action}`,{count:1});
  }
  private async queueCancellation(db: PoolClient, id: string, generation: string) {
    await db.query(`INSERT INTO agents_platform.customer_cancellations(task_id) SELECT task_id FROM agents_platform.customer_task_links WHERE conversation_id=$1 AND ownership_generation<$2 ON CONFLICT DO NOTHING`, [id, generation]);
  }
  async drainCancellations() {
    const rows = (await this.pool.query("SELECT task_id FROM agents_platform.customer_cancellations WHERE completed_at IS NULL ORDER BY created_at LIMIT 20")).rows;
    for (const row of rows) { await this.ports.cancelRoot(row.task_id); await this.pool.query("UPDATE agents_platform.customer_cancellations SET completed_at=now() WHERE task_id=$1", [row.task_id]); }
  }
  async assertBinding(db: Db, binding: ChannelBinding, task: { organization_id: string; version_id: string; root_task_id?: string }): Promise<void> {
    const row = (await db.query<CustomerConversation>("SELECT * FROM agents_platform.customer_conversations WHERE id=$1 FOR SHARE", [binding.customerConversationId])).rows[0];
    if (!row || row.organization_id !== task.organization_id || row.state !== "automation_active" || row.ownership_generation !== binding.ownershipGeneration) throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED", 403, "Conversation is under human control");
    if(!await this.activeBinding(db,row))throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED",403,"Customer channel is unavailable");
    if (row.version_id !== task.version_id) {
      const authorized = task.root_task_id === "admitting"
        ? row.channel_kind === "website"
          ? (await db.query("SELECT 1 FROM agents_platform.website_deployments WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND version_id=$4 AND revoked_at IS NULL AND paused=false FOR SHARE", [row.deployment_id,row.organization_id,row.agent_id,task.version_id])).rowCount
          : (await db.query("SELECT 1 FROM agents_platform.channel_deployments WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND version_id=$4 AND state='active' FOR SHARE", [row.channel_deployment_id,row.organization_id,row.agent_id,task.version_id])).rowCount
        : (await db.query(`SELECT 1 FROM agents_platform.customer_task_links l JOIN agents_platform.tasks t ON t.id=l.task_id
          WHERE l.conversation_id=$1 AND l.task_id=$2 AND t.version_id=$3 AND l.input_message_id=$4 AND l.ownership_generation=$5`,
          [row.id,task.root_task_id ?? null,task.version_id,binding.inputMessageId,binding.ownershipGeneration])).rowCount;
      if (!authorized) throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED",403,"Customer turn is unavailable");
    }
    const message = (await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE id=$1 AND conversation_id=$2 AND author_kind='visitor' AND ownership_generation=$3 AND sequence>$4", [binding.inputMessageId, row.id, binding.ownershipGeneration, row.return_watermark])).rowCount;
    if (!message) throw new PlatformError("CHANNEL_INPUT_DENIED", 403, "Customer message is unavailable");
  }
  async requestHandoff(db: PoolClient, binding: ChannelBinding, taskId: string): Promise<{ state: "handoff_pending" }> {
    const row = await this.conversation(db, binding.customerConversationId, true);
    if (!(await db.query("SELECT 1 FROM agents_platform.customer_task_links WHERE task_id=$1 AND conversation_id=$2 AND input_message_id=$3 AND ownership_generation=$4", [taskId, row.id, binding.inputMessageId, binding.ownershipGeneration])).rowCount) denied();
    const existing = (await db.query("SELECT action FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2", [row.id, taskId])).rows[0];
    if (existing?.action === "request_handoff") return { state: "handoff_pending" };
    if (row.ownership_generation !== binding.ownershipGeneration || row.state !== "automation_active") throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED", 403, "Conversation ownership changed");
    const updated = (await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET state='handoff_pending',revision=revision+1,ownership_generation=ownership_generation+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0]!;
    await this.queueCancellation(db, row.id, updated.ownership_generation);
    await db.query("INSERT INTO agents_platform.customer_commands(conversation_id,command_id,action,request_digest,result) VALUES($1,$2,'request_handoff',$3,$4)", [row.id, taskId, requestDigest(binding), updated]);
    await recordEvent(db,taskId,`channel:handoff:${taskId}`,"channel.request_handoff",{count:1});
    return { state: "handoff_pending" };
  }
  async publishToolReview(db:PoolClient,input:{taskId:string;binding:ChannelBinding;reviewId:string;requestDigest:string;arguments:unknown}):Promise<void>{
    const row=await this.conversation(db,input.binding.customerConversationId,true);
    if(row.channel_kind==="website")return;
    if(!(await db.query("SELECT 1 FROM agents_platform.customer_task_links WHERE task_id=$1 AND conversation_id=$2 AND input_message_id=$3 AND ownership_generation=$4",[input.taskId,row.id,input.binding.inputMessageId,input.binding.ownershipGeneration])).rowCount)denied();
    if(row.state!=="automation_active"||row.ownership_generation!==input.binding.ownershipGeneration||!await this.activeBinding(db,row))throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED",403,"Conversation ownership changed");
    const key=`tool-review:${input.reviewId}`;
    if((await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[row.id,key])).rowCount)return;
    const body=channelToolReviewText(input.arguments),buttons=channelToolReviewButtons(input.reviewId),toolReview={id:input.reviewId,taskId:input.taskId,requestDigest:input.requestDigest};
    await assertChannelToolReviewPrompt(db,{assetId:"pending",recipientId:"pending",text:body,buttons,toolReview},row.id);
    const message=await this.append(db,row,{key,digest:requestDigest({body,toolReview}),kind:"assistant",body,taskId:input.taskId});
    await enqueueChannelMessage(db,row,message,{requestText:body,buttons,toolReview});
  }
  private async readableMessage(db:Db,message:CustomerMessage):Promise<string|null>{
    if(!message.task_id)return null;
    const prompt=(await db.query(`SELECT r.arguments,r.request_digest,r.binding_digest,o.request FROM agents_platform.channel_outbound o
      JOIN agents_platform.tool_invocation_reviews r ON r.id::text=o.request#>>'{toolReview,id}'
      WHERE o.message_id=$1 AND r.task_id=$2 LIMIT 1`,[message.id,message.task_id])).rows[0];
    if(prompt){const text=channelToolReviewText(prompt.arguments);return message.body===text&&prompt.request_digest===requestDigest({bindingDigest:prompt.binding_digest,arguments:prompt.arguments})&&prompt.request.toolReview?.requestDigest===prompt.request_digest?text:null;}
    return this.ports.readableOutput(db,message.task_id,message.body);
  }
  async publishAutomated(db: PoolClient, input: { taskId: string; binding: ChannelBinding; output: string }): Promise<void> {
    const row = await this.conversation(db, input.binding.customerConversationId, true);
    if (!(await db.query("SELECT 1 FROM agents_platform.customer_task_links WHERE task_id=$1 AND conversation_id=$2 AND input_message_id=$3 AND ownership_generation=$4", [input.taskId, row.id, input.binding.inputMessageId, input.binding.ownershipGeneration])).rowCount) denied();
    if ((await db.query("SELECT id FROM agents_platform.customer_deliveries WHERE task_id=$1", [input.taskId])).rowCount) return;
    if (row.state !== "automation_active" || row.ownership_generation !== input.binding.ownershipGeneration || !await this.activeBinding(db,row)) {
      await db.query("INSERT INTO agents_platform.customer_deliveries(id,conversation_id,task_id,ownership_generation,state,reason) VALUES($1,$2,$3,$4,'suppressed','ownership_changed')", [randomUUID(), row.id, input.taskId, input.binding.ownershipGeneration]);
      await recordEvent(db,input.taskId,`channel:delivery:${input.taskId}`,"channel.delivery",{outcome:"suppressed"}); return;
    }
    if (!input.output) return;
    const message = await this.append(db, row, { key: `assistant:${input.taskId}`, digest: requestDigest(input.output), kind: "assistant", body: input.output, taskId: input.taskId });
    await db.query("INSERT INTO agents_platform.customer_deliveries(id,conversation_id,task_id,message_id,ownership_generation,state) VALUES($1,$2,$3,$4,$5,'published')", [randomUUID(), row.id, input.taskId, message.id, row.ownership_generation]);
    await enqueueChannelMessage(db,row,message);
    await recordEvent(db,input.taskId,`channel:delivery:${input.taskId}`,"channel.delivery",{outcome:"completed"});
  }
  async context(db: Db, binding: ChannelBinding, beforeMessageId: string) {
    const target = (await db.query("SELECT sequence FROM agents_platform.customer_messages WHERE id=$1 AND conversation_id=$2", [beforeMessageId, binding.customerConversationId])).rows[0]; if (!target) denied();
    const rows = (await db.query<CustomerMessage>("SELECT * FROM (SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND sequence<$2 ORDER BY sequence DESC LIMIT 40) m ORDER BY sequence", [binding.customerConversationId, target.sequence])).rows;
    const result: { id: string; role: "user" | "assistant"; authorKind: CustomerMessage["author_kind"]; content: string; taskId: string | null }[] = [];
    for (const row of rows) { const content = row.author_kind === "assistant" ? await this.readableMessage(db,row) : row.body;
      if (content) result.push({ id: row.id, role: row.author_kind === "visitor" ? "user" : "assistant", authorKind: row.author_kind, content, taskId: row.task_id }); }
    return result;
  }
}
