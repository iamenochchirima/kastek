import { requestHumanAssistance, updateHumanAssistance, currentHumanRequest, humanAssistanceNoticeValid, type HumanRequestView } from "./human-assistance";
import {enquiryReviewText,enquiryReviewButtons,assertEnquiryReviewPrompt} from "../channels/channel-enquiry-reviews";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { recordEvent } from "../../observability/event-store";
import { createCursorCodec, cursorKeysFromEnvironment } from "../../infrastructure/read-pages";
import { transaction } from "../../infrastructure/database";
import { handoffBriefSchema, type ChannelBinding, type HandoffBrief } from "../../contracts/channel";
import type { ChannelKind } from "../../contracts/channel-adapters";
import { enqueueChannelMessage, type PreparedChannelDelivery } from "../channels/channel-outbound";
import {channelToolReviewText,channelToolReviewButtons,assertChannelToolReviewPrompt} from "../channels/channel-tool-reviews";
import { BOOKING_UNCERTAIN_RECEIPT, HANDOFF_RECEIPT } from "./handoff-receipt";
import { currentHandoff, systemMessageIds, transitionMessages } from "./inbox-presentation";
import { assertConnectedUncertaintyNotice } from "./connected-uncertainty-notice";
import { recordHandoffWaiting, recordMessageHandoffWaiting } from "./support-waiting";
import type { Receipt } from "./handoff-pending-receipt";
import { reserveReceipt } from "./handoff-pending-receipt";
import { parseHandoffFeedbackRequest, type HandoffFeedbackRequest } from "../../execution/lifecycle/handoff-feedback-contract";
import { publishSupportStatus,assertSupportStatusNotice,assertSupportStatusNoticeVisible,type StatusNoticeBinding,type StatusEvidenceVerifier } from './support-status-notice';
import { recordSupportLifecycle } from "../reporting/support-lifecycle";
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
  customer_name?: string | null; customer_contact_id?: string | null; assignee_display_name?: string | null; channel_available?: boolean; last_message_body?: string | null; last_message_author_kind?: CustomerMessage["author_kind"] | null; last_message_created_at?: Date | null;
  humanRequest?: HumanRequestView | null;
  last_message_id?: string | null; last_message_task_id?: string | null;
  last_message_ownership_generation?: string | null;
}
// A conversation can have multiple enquiries; only expose a name when they resolve to one contact.
const customerIdentityJoin = `LEFT JOIN LATERAL (
  SELECT CASE WHEN count(DISTINCT contact.id)=1 THEN max(NULLIF(trim(contact.name),'')) END AS customer_name,
    CASE WHEN count(DISTINCT contact.id)=1 THEN min(contact.id::text)::uuid END AS customer_contact_id
  FROM agents_platform.customer_record_enquiries record
  JOIN agents_platform.customer_contacts contact ON contact.organization_id=record.organization_id AND contact.id=record.contact_id
  WHERE record.organization_id=c.organization_id AND record.customer_conversation_id=c.id
) identity ON true`;
export interface CustomerMessage { id: string; conversation_id: string; sequence: string; author_kind: "visitor" | "human" | "assistant";
  author_account_id: string | null; body: string; task_id: string | null; ownership_generation: string; created_at: Date; request_key?: string;
  displayKind?: "system";
  channelFacts?: { occurredAt: Date | null; replyToProviderMessageId: string | null; attachments: {kind:string;fileName?:string;index:number}[] };
  deliveries?: {id:string;segment:number;state:string;reason:string|null}[] }
export interface InboxPorts {
  followupAccess?(db: Db, scope: VisitorScope, conversationId?: string): Promise<string | null>;
  enqueueFollowup?(db: PoolClient, conversationId: string, messageId: string): Promise<string | null>;
  followupFailures?(db: Db, conversationId: string): Promise<Array<{id:string;state:"rejected"|"unknown";createdAt:Date}>>;
  admit(db: PoolClient, input: { deploymentId: string; sessionId: string; versionId: string; executionConversationId: string | null;
    input: string; requestKey: string; channelBinding: ChannelBinding }): Promise<{ id: string; conversation_id: string }>;
  admitChannel?(db: PoolClient, input: { deploymentId: string; participantId: string; versionId: string; executionConversationId: string | null;
    input: string; requestKey: string; channelBinding: ChannelBinding }): Promise<{ id: string; conversation_id: string }>;
  admitSupportStatus?(db:PoolClient,input:{deploymentId:string;sessionId?:string;participantId?:string;versionId:string;executionConversationId:string|null;
    input:string;requestKey:string;channelBinding:ChannelBinding;episodeCommandId:string}):Promise<{id:string;conversation_id:string}>;
  readableOutput(db: Db, taskId: string, body: string): Promise<string | null>;
  // Must revalidate input evidence and, for model output, its operation receipt and grounding.
  verifyPendingHandoffReceipt?(db: Db, input: { receipt: Receipt; origin: "model" | "fallback"; text: string }): Promise<boolean>;
  verifySupportStatus?:StatusEvidenceVerifier;
  verifyHistoricalSupportStatus?:StatusEvidenceVerifier;
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
    return (await db.query<CustomerConversation>(`SELECT c.*,cn.id connection_id,cn.name connection_name,cn.asset_id,identity.customer_name,identity.customer_contact_id,assignee.display_name AS assignee_display_name FROM agents_platform.customer_conversations c
      LEFT JOIN agents_platform.channel_deployments cd ON cd.id=c.channel_deployment_id LEFT JOIN agents_platform.channel_connections cn ON cn.id=cd.connection_id
      LEFT JOIN agents_platform.accounts assignee ON assignee.id=c.assignee_account_id
      ${customerIdentityJoin}
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
    if (row.deployment_id !== scope.deploymentId || (row.session_id !== scope.sessionId && await this.ports.followupAccess?.(db, scope, id) !== id)) denied();
    return row;
  }
  async open(scope: VisitorScope): Promise<CustomerConversation> {
    return transaction(this.pool, async db => { const deployment = await this.visitor(db, scope);
      const recovered = await this.ports.followupAccess?.(db, scope);
      if (recovered) return this.visitorConversation(db, scope, recovered);
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
  private async admitWaitingStatus(db:PoolClient,row:CustomerConversation,message:CustomerMessage,sessionId?:string):Promise<void> {
    if(row.state!=="handoff_pending" || !this.ports.admitSupportStatus)return;
    if((await db.query("SELECT 1 FROM agents_platform.human_assistance_requests WHERE conversation_id=$1 AND human_only=true AND status IN ('requested','human_owned')",[row.id])).rowCount)return;
    const episode=(await db.query(`SELECT w.task_id,w.source_message_id,c.action FROM agents_platform.support_waiting w
      JOIN agents_platform.customer_commands c ON c.conversation_id=w.conversation_id AND c.command_id=w.task_id
      WHERE w.conversation_id=$1 AND w.ownership_generation<=$2 AND c.action IN ('request_handoff','message_handoff')
      ORDER BY w.requested_at DESC LIMIT 1`,[row.id,row.ownership_generation])).rows[0];
    if(!episode || (!row.execution_conversation_id && (row.channel_kind==='website' || episode.action!=='message_handoff' || episode.source_message_id!==episode.task_id)))return;
    // Keep the cost of classifying waiting messages bounded without hiding those messages from staff.
    const usage=(await db.query(`SELECT count(*) FILTER (WHERE t.created_at>now()-interval '5 minutes')::int recent,
      count(*) FILTER (WHERE t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain'))::int active
      FROM agents_platform.support_status_executions s JOIN agents_platform.tasks t ON t.id=s.task_id
      WHERE s.conversation_id=$1 AND s.episode_command_id=$2`,[row.id,episode.task_id])).rows[0];
    if(usage.recent>=3 || usage.active>0)return;
    await db.query('SAVEPOINT support_status_admission');
    try {
      const task=await this.ports.admitSupportStatus(db,{deploymentId:(row.channel_kind==='website'?row.deployment_id:row.channel_deployment_id)!,
        ...(row.channel_kind==='website'?{sessionId}:{participantId:row.id}),versionId:row.version_id,executionConversationId:row.execution_conversation_id,
        input:message.body,requestKey:`support-status:${message.id}`,episodeCommandId:episode.task_id,
        channelBinding:{customerConversationId:row.id,ownershipGeneration:row.ownership_generation,inputMessageId:message.id}});
      if(!row.execution_conversation_id)row.execution_conversation_id=task.conversation_id;
      await db.query('UPDATE agents_platform.customer_messages SET task_id=$2 WHERE id=$1',[message.id,task.id]);message.task_id=task.id;
      await db.query('RELEASE SAVEPOINT support_status_admission');
    } catch(error) {
      await db.query('ROLLBACK TO SAVEPOINT support_status_admission');await db.query('RELEASE SAVEPOINT support_status_admission');
      if(!(error instanceof PlatformError))throw error;
    }
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
      } else await this.admitWaitingStatus(db,row,message,scope.sessionId);
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
        const receipt = await this.append(db,row,{key:`handoff-message:${message.id}`,digest:requestDigest(HANDOFF_RECEIPT),kind:"assistant",body:HANDOFF_RECEIPT});
        await db.query(`INSERT INTO agents_platform.customer_commands(conversation_id,command_id,action,request_digest,result)
          VALUES($1,$2,'message_handoff',$3,$4)`,[row.id,message.id,requestDigest({messageId:message.id}),{ownership_generation:row.ownership_generation,handoffReceiptId:receipt.id}]);
        const requestedAt=await recordMessageHandoffWaiting(db,{messageId:message.id,conversationId:row.id,ownershipGeneration:row.ownership_generation});
        await recordSupportLifecycle(db,{conversationId:row.id,sourceKey:`handoff:${message.id}:acknowledgement`,action:"acknowledgement_committed",outcome:"fallback",
          occurredAt:receipt.created_at,durationMs:Math.max(0,receipt.created_at.getTime()-requestedAt.getTime())});
        await enqueueChannelMessage(db,row,receipt);
      }
      if (row.state === "automation_active") {
        if (!this.ports.admitChannel) throw new PlatformError("CHANNEL_RUNTIME_UNAVAILABLE",503,"Channel execution is unavailable");
        const binding = {customerConversationId:row.id,ownershipGeneration:row.ownership_generation,inputMessageId:message.id};
        const task = await this.ports.admitChannel(db,{deploymentId:deployment.id,participantId:row.id,versionId:deployment.version_id,
          executionConversationId:row.execution_conversation_id,input:input.body,requestKey:`channel:${message.id}`,channelBinding:binding});
        await db.query("UPDATE agents_platform.customer_messages SET task_id=$2 WHERE id=$1",[message.id,task.id]); message.task_id=task.id;
        await db.query("UPDATE agents_platform.customer_conversations SET execution_conversation_id=$2 WHERE id=$1",[row.id,task.conversation_id]); row.execution_conversation_id=task.conversation_id;
        await db.query("INSERT INTO agents_platform.customer_task_links(task_id,conversation_id,input_message_id,ownership_generation) VALUES($1,$2,$3,$4)",[task.id,row.id,message.id,row.ownership_generation]);
      } else if(!input.requireHandoff) await this.admitWaitingStatus(db,row,message);
      return {conversation:row,message,replayed:false};
    });
  }
  private async messages(db: Db, id: string, after: string, limit: number, before?: string): Promise<CustomerMessage[]> {
    const rows = (await db.query<CustomerMessage>(after === "0" || before ? `SELECT * FROM (SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3) m ORDER BY sequence` :
      "SELECT * FROM agents_platform.customer_messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", [id, before ?? (after === "0" ? null : after), limit])).rows;
    for (const message of rows) if (message.author_kind === "assistant") message.body = await this.readableMessage(db,message)??"[Response unavailable]";
    if (rows.length) {
      const systemIds = await systemMessageIds(db,id,rows.map(row=>row.id));
      for (const message of rows) if (systemIds.has(message.id)) message.displayKind="system";
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
    return transaction(this.pool, async db => {
      const conversation = await this.visitorConversation(db, scope, id);
      let responseStatus: "working" | "incomplete" | "failed" | "cancelled" | "uncertain" | null = null;
      if (conversation.state === "automation_active") {
        const latest = (await db.query<{ state: string | null; replied: boolean }>(`SELECT t.state,
          EXISTS(SELECT 1 FROM agents_platform.customer_messages reply WHERE reply.conversation_id=m.conversation_id
            AND reply.sequence>m.sequence AND reply.author_kind IN ('assistant','human')) AS replied
          FROM agents_platform.customer_messages m
          LEFT JOIN agents_platform.customer_task_links l ON l.input_message_id=m.id AND l.conversation_id=m.conversation_id AND l.task_id=m.task_id
          LEFT JOIN agents_platform.tasks t ON t.id=l.task_id AND t.organization_id=$2 AND t.root_task_id=t.id
          WHERE m.conversation_id=$1 AND m.author_kind='visitor' AND m.ownership_generation=$3 AND m.sequence>$4
          ORDER BY m.sequence DESC LIMIT 1`, [id, conversation.organization_id, conversation.ownership_generation, conversation.return_watermark])).rows[0];
        if (latest?.state && !latest.replied) {
          if (["completed", "incomplete", "refused"].includes(latest.state)) responseStatus = "incomplete";
          else if (latest.state === "failed" || latest.state === "cancelled" || latest.state === "uncertain") responseStatus = latest.state;
          else responseStatus = "working";
        }
      }
      return { conversation, messages: await this.messages(db, id, after, limit, before), responseStatus };
    });
  }
  async readStaff(scope: InboxScope, id: string, after = "0", limit = 100, before?: string) {
    return transaction(this.pool, async db => { await this.membership(db, scope); const conversation = await this.conversation(db, id); if (conversation.organization_id !== scope.organizationId) denied();
      await this.trialStaff(db,scope,conversation);
      const receipt = (await db.query(`SELECT c.result->'handoffBrief' brief FROM agents_platform.customer_commands c
        JOIN agents_platform.support_waiting w ON w.task_id=c.command_id AND w.conversation_id=c.conversation_id
        JOIN agents_platform.customer_task_links l ON l.task_id=c.command_id AND l.conversation_id=c.conversation_id
        JOIN agents_platform.customer_messages m ON m.id=l.input_message_id AND m.conversation_id=c.conversation_id
        WHERE c.conversation_id=$1 AND c.action='request_handoff' AND $2::text IN ('handoff_pending','human_owned') AND m.sequence>$3::bigint
        ORDER BY w.requested_at DESC LIMIT 1`,[id,conversation.state,conversation.return_watermark])).rows[0];
      const parsed = handoffBriefSchema.safeParse(receipt?.brief);
      const followupFailures = await this.ports.followupFailures?.(db, id) ?? [];
      const handoff = await currentHandoff(db,id,conversation.state,conversation.return_watermark);
      const uncertainEffects = (await db.query(`SELECT e.operation_id,attempt.state AS reconciliation_state,attempt.observed_at AS reconciliation_observed_at FROM agents_platform.connected_uncertain_escalations e
        LEFT JOIN agents_platform.customer_commands c ON c.conversation_id=e.conversation_id AND c.command_id=e.command_id AND c.action='request_handoff'
        LEFT JOIN agents_platform.support_waiting w ON w.task_id=c.command_id AND w.conversation_id=c.conversation_id
        JOIN agents_platform.customer_task_links l ON l.task_id=e.task_id AND l.conversation_id=e.conversation_id AND l.input_message_id=e.input_message_id AND l.ownership_generation=e.ownership_generation
        JOIN agents_platform.customer_messages m ON m.id=l.input_message_id AND m.conversation_id=l.conversation_id
        LEFT JOIN LATERAL (SELECT a.state,a.observed_at FROM agents_platform.connected_reconciliation_attempts a
          WHERE a.operation_id=e.operation_id AND a.organization_id=e.organization_id AND a.conversation_id=e.conversation_id
            AND a.state IN ('found','inconclusive','unavailable')
          ORDER BY a.observed_at DESC,a.id DESC LIMIT 1) attempt ON true
        WHERE e.organization_id=$1 AND e.conversation_id=$2
          AND ((e.state='recorded' AND w.task_id IS NOT NULL) OR e.state='ownership_changed'
            OR (e.state='pending' AND e.last_error_code='authority_unavailable'))
        ORDER BY e.operation_id`,[scope.organizationId,id])).rows.map(row=>({operationId:row.operation_id,kind:'contact_save_uncertain' as const,
          ...(row.reconciliation_state?{reconciliation:{state:row.reconciliation_state,observedAt:row.reconciliation_observed_at}}:{})}));
      conversation.humanRequest = await currentHumanRequest(db,id);
      return { conversation, handoff, handoffBrief: parsed.success ? parsed.data : null, uncertainEffects, followupFailures, channelAvailable: await this.activeBinding(db, conversation), messages: await this.messages(db, id, after, limit, before) }; });
  }
  async list(scope: InboxScope, filters: { state?: string; agentId?: string; channel?: ChannelKind; connectionId?: string; assigned?: string; search?: string; sort?: "newest" | "oldest"; cursor?: string; limit: number }) {
    return transaction(this.pool, async db => { await this.membership(db, scope);
      const sort = filters.sort ?? "newest";
      const search = filters.search?.trim() || null;
      const scopeKey = { kind: "customer-inbox-v3", ...scope, state: filters.state ?? null, agentId: filters.agentId ?? null, assigned: filters.assigned ?? null, channel: filters.channel ?? null, connectionId: filters.connectionId ?? null, search, ...(sort === "oldest" ? { sort } : {}) };
      const anchor = this.cursors.read(filters.cursor, scopeKey);
      const rows = (await db.query<CustomerConversation & { cursor_position: string }>(`SELECT c.*,a.name AS agent_name,cn.id connection_id,cn.name connection_name,cn.asset_id,identity.customer_name,identity.customer_contact_id,assignee.display_name AS assignee_display_name,
        CASE WHEN c.channel_kind='website' THEN (wd.id IS NOT NULL AND wd.revoked_at IS NULL AND wd.paused=false)
          ELSE (cd.id IS NOT NULL AND cd.state='active' AND cn.id IS NOT NULL AND cn.state='active') END AS channel_available,
        last_message.id AS last_message_id,last_message.task_id AS last_message_task_id,last_message.request_key AS last_message_request_key,last_message.body AS last_message_body,last_message.author_kind AS last_message_author_kind,last_message.created_at AS last_message_created_at,last_message.ownership_generation AS last_message_ownership_generation,c.updated_at::text AS cursor_position FROM agents_platform.customer_conversations c JOIN agents_platform.agents a ON a.id=c.agent_id
        LEFT JOIN agents_platform.channel_deployments cd ON cd.id=c.channel_deployment_id AND cd.organization_id=c.organization_id LEFT JOIN agents_platform.channel_connections cn ON cn.id=cd.connection_id AND cn.organization_id=c.organization_id
        LEFT JOIN agents_platform.website_deployments wd ON wd.id=c.deployment_id AND wd.organization_id=c.organization_id
        LEFT JOIN agents_platform.accounts assignee ON assignee.id=c.assignee_account_id
        ${customerIdentityJoin}
        LEFT JOIN LATERAL (SELECT id,task_id,request_key,body,author_kind,created_at,ownership_generation FROM agents_platform.customer_messages WHERE conversation_id=c.id ORDER BY sequence DESC LIMIT 1) last_message ON true
        WHERE c.organization_id=$1 AND ($2::text IS NULL OR c.state=$2 OR ($2='human_requested' AND EXISTS(SELECT 1 FROM agents_platform.human_assistance_requests h WHERE h.conversation_id=c.id AND h.status IN ('requested','human_owned')))) AND ($3::uuid IS NULL OR c.agent_id=$3)
        AND ($4::text IS NULL OR ($4='mine' AND c.assignee_account_id=$5) OR ($4='unassigned' AND c.assignee_account_id IS NULL))
        AND ($10::text IS NULL OR c.channel_kind=$10)
        AND ($11::uuid IS NULL OR cn.id=$11)
        AND ($12::text IS NULL OR strpos(lower(coalesce(identity.customer_name,'')),lower($12))>0 OR strpos(lower(a.name),lower($12))>0
          OR c.id IN (SELECT m.conversation_id FROM agents_platform.customer_messages m
            JOIN agents_platform.customer_conversations owned ON owned.id=m.conversation_id
            WHERE owned.organization_id=$1 AND m.author_kind IN ('visitor','human') AND strpos(lower(m.body),lower($12))>0))
        AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id=c.session_id)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=c.channel_deployment_id)
        AND c.updated_at<=$6::timestamptz AND ($7::timestamptz IS NULL OR (c.updated_at,c.id)${sort === "oldest" ? ">" : "<"}($7::timestamptz,$8::uuid))
        ORDER BY c.updated_at ${sort === "oldest" ? "ASC" : "DESC"},c.id ${sort === "oldest" ? "ASC" : "DESC"} LIMIT $9`, [scope.organizationId, filters.state ?? null, filters.agentId ?? null, filters.assigned ?? null, scope.accountId,
        anchor.snapshot, anchor.position || null, anchor.id || null, filters.limit + 1, filters.channel ?? null, filters.connectionId ?? null, search])).rows;
      const items = rows.slice(0, filters.limit), last = items.at(-1);
      for (const item of items) if (item.last_message_body != null) {
        if (item.last_message_author_kind === "assistant") {
          const candidate = { id: item.last_message_id, conversation_id: item.id, task_id: item.last_message_task_id, request_key: (item as unknown as {last_message_request_key:string}).last_message_request_key, body: item.last_message_body, ownership_generation: item.last_message_ownership_generation } as CustomerMessage;
          item.last_message_body = await this.readableMessage(db, candidate) ?? "[Response unavailable]";
        }
        item.last_message_body = item.last_message_body.slice(0,500);
      }
      for (const item of items) item.humanRequest = await currentHumanRequest(db,item.id);
      return { items, nextCursor: rows.length > filters.limit && last ? this.cursors.next({ snapshot: anchor.snapshot, position: last.cursor_position, id: last.id }, scopeKey) : null };
    });
  }
  async members(scope: InboxScope, filters: {search?: string; cursor?: string; limit?: number} = {}) {
    return transaction(this.pool, async db => {
      await this.membership(db, scope);
      const search=filters.search?.trim() || null, limit=filters.limit ?? 200;
      const key={kind:"inbox-members-v1",...scope,search}, anchor=this.cursors.read(filters.cursor,key);
      const rows=(await db.query<{id:string;display_name:string}>(`SELECT a.id,a.display_name FROM agents_platform.memberships m
        JOIN agents_platform.accounts a ON a.id=m.account_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL
        AND a.created_at<=$2::timestamptz AND ($3::uuid IS NULL OR a.id>$3)
        AND ($4::text IS NULL OR strpos(lower(a.display_name),lower($4))>0)
        ORDER BY a.id LIMIT $5`,[scope.organizationId,anchor.snapshot,anchor.id || null,search,limit+1])).rows;
      const items=rows.slice(0,limit), last=items.at(-1);
      return {items,nextCursor:rows.length>limit && last ? this.cursors.next({snapshot:anchor.snapshot,position:last.id,id:last.id},key):null};
    });
  }
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
      let firstResponseEpisode: { task_id: string; requested_at: Date } | undefined;
      switch (input.action) {
        case "claim": if (assignee && !assigned) denied(); assignee = scope.accountId; break;
        case "assign": { if (role !== "owner") denied(); const accountId = input.assigneeAccountId ?? denied(); await this.membership(db, { ...scope, accountId }); assignee = accountId; break; }
        case "unassign": if (role !== "owner" && !assigned) denied(); assignee = null; if (state === "human_owned") state = "handoff_pending"; fence = true; break;
        case "takeover": if (!assigned || state === "resolved") denied(); state = "human_owned"; fence = true; break;
        case "reply": if (!assigned || state !== "human_owned" || !input.body?.trim()) denied();
          { if(!await this.activeBinding(db,row))throw new PlatformError("CHANNEL_UNAVAILABLE",409,"Reconnect or resume this channel before replying");
            firstResponseEpisode=(await db.query<{task_id:string;requested_at:Date}>(`SELECT w.task_id,w.requested_at FROM agents_platform.support_waiting w
              WHERE w.conversation_id=$1 AND w.ownership_generation<=$2
                AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_messages prior WHERE prior.conversation_id=w.conversation_id
                  AND prior.author_kind='human' AND prior.ownership_generation>=w.ownership_generation)
              ORDER BY w.requested_at DESC LIMIT 1 FOR UPDATE OF w`,[id,row.ownership_generation])).rows[0];
            const body = input.body ?? denied(); const message = await this.append(db, row, { key: `human:${input.commandId}`, digest, kind: "human", body, accountId: scope.accountId });
            await db.query("INSERT INTO agents_platform.customer_deliveries(id,conversation_id,message_id,ownership_generation,state) VALUES($1,$2,$3,$4,'published')", [randomUUID(), id, message.id, row.ownership_generation]);
            await enqueueChannelMessage(db,row,message,preparedDelivery);
            if(row.channel_kind === "website") await this.ports.enqueueFollowup?.(db,id,message.id);
            if(firstResponseEpisode)await recordSupportLifecycle(db,{conversationId:id,sourceKey:`handoff:${firstResponseEpisode.task_id}:first-human-reply`,action:"first_human_reply",outcome:"published",
              occurredAt:message.created_at,durationMs:Math.max(0,message.created_at.getTime()-firstResponseEpisode.requested_at.getTime())}); } break;
        case "resolve": if (!assigned) denied(); state = "resolved"; fence = true; break;
        case "reopen": if (!assigned || state !== "resolved") denied(); state = "human_owned"; fence = true; break;
        case "return": if (!assigned || !["human_owned", "handoff_pending"].includes(state)) denied(); state = "automation_active"; fence = true; break;
      }
      const updated = (await db.query<CustomerConversation>(`UPDATE agents_platform.customer_conversations SET state=$2,assignee_account_id=$3,revision=revision+1,
        ownership_generation=ownership_generation+$4,return_watermark=CASE WHEN $5 THEN next_sequence-1 ELSE return_watermark END,updated_at=now() WHERE id=$1 RETURNING *`, [id, state, assignee, fence ? 1 : 0, input.action === "return" || input.action === "resolve"])).rows[0]!;
      if (input.action === "takeover" || input.action === "reopen") await db.query("UPDATE agents_platform.human_assistance_requests SET status='human_owned',updated_at=now() WHERE conversation_id=$1 AND status='requested'",[id]);
      if (input.action === "unassign") await db.query("UPDATE agents_platform.human_assistance_requests SET status='requested',updated_at=now() WHERE conversation_id=$1 AND status='human_owned'",[id]);
      if (input.action === "resolve") await db.query("UPDATE agents_platform.human_assistance_requests SET status='completed',updated_at=now() WHERE conversation_id=$1 AND status IN ('requested','human_owned')",[id]);
      if (input.action === "return") await db.query("UPDATE agents_platform.human_assistance_requests SET status='requested',human_only=false,updated_at=now() WHERE conversation_id=$1 AND status IN ('requested','human_owned')",[id]);
      if (fence) await this.queueCancellation(db, id, updated.ownership_generation);
      let transitionMessageId: string | null = null;
      if (row.channel_kind === "website" && row.state !== updated.state && (input.action === "return" || input.action === "resolve")) {
        const body = transitionMessages[input.action];
        const message = await this.append(db, updated, { key: `transition:${input.commandId}`, digest: requestDigest(body), kind: "assistant", body });
        transitionMessageId = message.id;
      }
      await db.query("INSERT INTO agents_platform.customer_commands(conversation_id,command_id,actor_account_id,action,request_digest,result) VALUES($1,$2,$3,$4,$5,$6)", [id, input.commandId, scope.accountId, input.action, digest, transitionMessageId ? {...updated,transitionMessageId} : updated]);
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
  private async queueCancellation(db: PoolClient, id: string, generation: string, exceptTaskId?: string) {
    await db.query(`INSERT INTO agents_platform.customer_cancellations(task_id) SELECT task_id FROM agents_platform.customer_task_links WHERE conversation_id=$1 AND ownership_generation<$2 AND ($3::uuid IS NULL OR task_id<>$3) ON CONFLICT DO NOTHING`, [id, generation, exceptTaskId ?? null]);
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
  async recoverUncertainConnectedHandoff(db: PoolClient, input: { operationId:string; taskId:string; organizationId:string; conversationId:string; inputMessageId:string; ownershipGeneration:string }): Promise<{outcome:'recorded'|'ownership_changed'|'authority_unavailable';commandId?:string}> {
    const row = await this.conversation(db,input.conversationId,true);
    if (row.organization_id !== input.organizationId) return {outcome:'authority_unavailable'};
    const binding:ChannelBinding = {customerConversationId:input.conversationId,inputMessageId:input.inputMessageId,ownershipGeneration:input.ownershipGeneration};
    const lineage = (await db.query(`SELECT 1 FROM agents_platform.customer_task_links l JOIN agents_platform.customer_messages m
      ON m.id=l.input_message_id AND m.conversation_id=l.conversation_id
      WHERE l.task_id=$1 AND l.conversation_id=$2 AND l.input_message_id=$3 AND l.ownership_generation=$4
        AND m.author_kind='visitor' AND m.sequence>$5::bigint`,[input.taskId,row.id,input.inputMessageId,input.ownershipGeneration,row.return_watermark])).rowCount;
    if (!lineage) return {outcome:'ownership_changed'};
    const existing = (await db.query(`SELECT 1 FROM agents_platform.customer_commands c JOIN agents_platform.support_waiting w
      ON w.task_id=c.command_id AND w.conversation_id=c.conversation_id
      WHERE c.conversation_id=$1 AND c.command_id=$2 AND c.action='request_handoff' AND w.ownership_generation=$3::bigint+1`,[row.id,input.taskId,input.ownershipGeneration])).rowCount;
    if (existing && ['handoff_pending','human_owned'].includes(row.state)) return {outcome:'recorded',commandId:input.taskId};
    if (row.state!=='automation_active' || row.ownership_generation!==input.ownershipGeneration) return {outcome:'ownership_changed'};
    if (!await this.activeBinding(db,row)) return {outcome:'authority_unavailable'};
    await this.requestHandoff(db,binding,input.taskId);
    return {outcome:'recorded',commandId:input.taskId};
  }
  async requestHumanAssistance(db:PoolClient,binding:ChannelBinding,taskId:string,input:unknown) {
    return requestHumanAssistance(db,await this.conversation(db,binding.customerConversationId,true),binding,taskId,input,{
      assertBinding:(...args)=>this.assertBinding(...args),append:(...args)=>this.append(...args),cancel:(...args)=>this.queueCancellation(...args)});
  }
  async updateHumanAssistance(db:PoolClient,binding:ChannelBinding,taskId:string,input:unknown) {
    return updateHumanAssistance(db,await this.conversation(db,binding.customerConversationId,true),binding,taskId,input,{
      assertBinding:(...args)=>this.assertBinding(...args),append:(...args)=>this.append(...args),cancel:(...args)=>this.queueCancellation(...args)});
  }
  async requestHandoff(db: PoolClient, binding: ChannelBinding, taskId: string, brief?: HandoffBrief, cause?: { bookingOperationId: string }): Promise<{ state: "handoff_pending" }> {
    if (brief) brief = handoffBriefSchema.parse(brief);
    const row = await this.conversation(db, binding.customerConversationId, true);
    if (!(await db.query("SELECT 1 FROM agents_platform.customer_task_links WHERE task_id=$1 AND conversation_id=$2 AND input_message_id=$3 AND ownership_generation=$4", [taskId, row.id, binding.inputMessageId, binding.ownershipGeneration])).rowCount) denied();
    const digest = requestDigest(cause ? {binding,brief,cause} : brief ? {binding,brief} : binding);
    const existing = (await db.query("SELECT action,request_digest FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2", [row.id, taskId])).rows[0];
    if (existing?.action === "request_handoff") { if (existing.request_digest !== digest) conflict(); return { state: "handoff_pending" }; }
    const booking = cause ? (await db.query(`SELECT id FROM agents_platform.booking_intents WHERE task_id=$1 AND operation_id=$2 AND state='uncertain' FOR SHARE`,[taskId,cause.bookingOperationId])).rows[0] : null;
    if (cause && !booking) throw new PlatformError("BOOKING_OUTCOME_UNAVAILABLE",403,"Appointment outcome is unavailable");
    if (row.ownership_generation !== binding.ownershipGeneration || row.state !== "automation_active" || !await this.activeBinding(db,row)) throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED", 403, "Conversation ownership changed");
    const updated = (await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET state='handoff_pending',revision=revision+1,ownership_generation=ownership_generation+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0]!;
    Object.assign(row,updated);
    await this.queueCancellation(db, row.id, updated.ownership_generation);
    const receiptBody = booking ? BOOKING_UNCERTAIN_RECEIPT : HANDOFF_RECEIPT;
    const receipt = await this.append(db,row,{key:`handoff:${taskId}`,digest:requestDigest(receiptBody),kind:"assistant",body:receiptBody,taskId});
    await db.query("INSERT INTO agents_platform.customer_commands(conversation_id,command_id,action,request_digest,result) VALUES($1,$2,'request_handoff',$3,$4)", [row.id, taskId, digest, {...updated,handoffReceiptId:receipt.id,...(brief ? {handoffBrief:brief} : {}),...(booking ? {bookingUncertainId:booking.id} : {})}]);
    const requestedAt=await recordHandoffWaiting(db,{taskId,conversationId:row.id,ownershipGeneration:row.ownership_generation});
    await enqueueChannelMessage(db,row,receipt);
    await recordSupportLifecycle(db,{conversationId:row.id,sourceKey:`handoff:${taskId}:acknowledgement`,action:"acknowledgement_committed",outcome:"fallback",
      occurredAt:receipt.created_at,durationMs:Math.max(0,receipt.created_at.getTime()-requestedAt.getTime())});
    await recordEvent(db,taskId,`channel:handoff:${taskId}`,"channel.request_handoff",{count:1});
    return { state: "handoff_pending" };
  }
  async requestHandoffV2(db: PoolClient, binding: ChannelBinding, taskId: string, brief: HandoffBrief, delayMs: number, feedback?: HandoffFeedbackRequest): Promise<{ state: "handoff_pending" }> {
    brief = handoffBriefSchema.parse(brief);
    const parsedFeedback = feedback ? parseHandoffFeedbackRequest(feedback) : undefined;
    const row = await this.conversation(db, binding.customerConversationId, true);
    const linked = (await db.query(`SELECT 1 FROM agents_platform.customer_task_links l
      JOIN agents_platform.tasks t ON t.id=l.task_id
      WHERE l.task_id=$1 AND l.conversation_id=$2 AND l.input_message_id=$3 AND l.ownership_generation=$4
        AND t.root_task_id=t.id AND t.organization_id=$5`,
      [taskId,row.id,binding.inputMessageId,binding.ownershipGeneration,row.organization_id])).rowCount;
    if (!linked) denied();
    const digest = requestDigest({version:2,binding,brief,delayMs,feedbackRequestDigest:parsedFeedback ? requestDigest(parsedFeedback) : null});
    const existing = (await db.query("SELECT action,request_digest,result FROM agents_platform.customer_commands WHERE conversation_id=$1 AND command_id=$2", [row.id,taskId])).rows[0];
    if (existing) {
      if (existing.action !== "request_handoff" || existing.request_digest !== digest || existing.result?.pendingReceiptTaskId !== taskId) conflict();
      return { state:"handoff_pending" };
    }
    if (row.ownership_generation !== binding.ownershipGeneration || row.state !== "automation_active" || !await this.activeBinding(db,row)) throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED",403,"Conversation ownership changed");
    const updated = (await db.query<CustomerConversation>("UPDATE agents_platform.customer_conversations SET state='handoff_pending',revision=revision+1,ownership_generation=ownership_generation+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0]!;
    await this.queueCancellation(db,row.id,updated.ownership_generation,taskId);
    await db.query("INSERT INTO agents_platform.customer_commands(conversation_id,command_id,action,request_digest,result) VALUES($1,$2,'request_handoff',$3,$4)",
      [row.id,taskId,digest,{...updated,pendingReceiptTaskId:taskId,handoffBrief:brief}]);
    await reserveReceipt(db,{taskId,conversationId:row.id,ownershipGeneration:updated.ownership_generation,delayMs,feedback:parsedFeedback});
    await recordHandoffWaiting(db,{taskId,conversationId:row.id,ownershipGeneration:updated.ownership_generation});
    await recordEvent(db,taskId,`channel:handoff:${taskId}`,"channel.request_handoff",{count:1});
    return {state:"handoff_pending"};
  }
  async publishWaitingNotice(db: PoolClient, input: { conversationId: string; taskId: string; ownershipGeneration: string; stage: number; body: string }): Promise<boolean> {
    const row = await this.conversation(db, input.conversationId, true);
    const notice = (await db.query(`SELECT n.*,w.source_message_id FROM agents_platform.support_waiting_notices n
      JOIN agents_platform.support_waiting w ON w.task_id=n.task_id
      WHERE n.task_id=$1 AND n.stage=$2 AND w.conversation_id=$3 AND w.completed_at IS NULL
        AND n.state='pending' AND n.ownership_generation=$4 AND n.body=$5
        AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_messages m WHERE m.conversation_id=w.conversation_id
          AND m.author_kind='human' AND m.ownership_generation>=w.ownership_generation)
      FOR UPDATE OF n,w`, [input.taskId,input.stage,row.id,input.ownershipGeneration,input.body])).rows[0];
    if (!notice || !["handoff_pending", "human_owned"].includes(row.state) || row.ownership_generation !== input.ownershipGeneration || !await this.activeBinding(db,row)) return false;
    const currentVersion = (await db.query(`SELECT v.configuration FROM agents_platform.agent_versions v
      JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id
      WHERE v.id = CASE WHEN $1='website' THEN (SELECT version_id FROM agents_platform.website_deployments WHERE id=$2)
        ELSE (SELECT version_id FROM agents_platform.channel_deployments WHERE id=$3) END
        AND v.organization_id=$4 AND a.id=$5 AND a.deleted_at IS NULL FOR SHARE OF a,v`,
      [row.channel_kind,row.deployment_id,row.channel_deployment_id,row.organization_id,row.agent_id])).rows[0];
    if (!currentVersion || (!notice.source_message_id && !currentVersion.configuration?.tools?.includes("channel.request_handoff"))) return false;
    const message = await this.append(db,row,{key:`waiting:${input.taskId}:${input.stage}`,digest:requestDigest(input.body),kind:"assistant",body:input.body});
    await db.query("UPDATE agents_platform.support_waiting_notices SET state='published',message_id=$3 WHERE task_id=$1 AND stage=$2 AND state='pending'",[input.taskId,input.stage,message.id]);
    await enqueueChannelMessage(db,row,message);
    await recordSupportLifecycle(db,{conversationId:row.id,sourceKey:`handoff:${input.taskId}:waiting:${input.stage}`,action:"waiting_update_committed",outcome:"published",occurredAt:message.created_at});
    return true;
  }
  // The caller locks the
  // conversation and receipt and commits the outcome with this message.
  async publishPendingHandoffReceipt(db: PoolClient, input: { receipt: Receipt; origin: "model" | "fallback"; text: string }): Promise<string | null> {
    const { receipt, origin, text } = input;
    const row = await this.conversation(db, receipt.conversation_id, true);
    if (receipt.outcome || row.state !== "handoff_pending" || row.ownership_generation !== receipt.ownership_generation
      || !await this.activeBinding(db, row) || !this.ports.verifyPendingHandoffReceipt
      || (origin === "fallback" && text !== HANDOFF_RECEIPT)
      || !text.trim() || Buffer.byteLength(text) > 32768) return null;
    const valid = (await db.query(`SELECT 1 FROM agents_platform.pending_handoff_receipts r
      JOIN agents_platform.customer_commands c ON c.conversation_id=r.conversation_id AND c.command_id=r.task_id
      JOIN agents_platform.customer_task_links l ON l.task_id=r.task_id AND l.conversation_id=r.conversation_id
      JOIN agents_platform.customer_messages m ON m.id=l.input_message_id AND m.conversation_id=l.conversation_id
      JOIN agents_platform.tasks t ON t.id=l.task_id AND t.organization_id=$3
      JOIN agents_platform.execution_grants g ON g.id=t.grant_id AND g.organization_id=t.organization_id
      WHERE r.task_id=$1 AND r.conversation_id=$2 AND r.ownership_generation=$4 AND r.outcome IS NULL
        AND c.action='request_handoff' AND c.result->>'pendingReceiptTaskId'=r.task_id::text
        AND c.result->>'ownership_generation'=r.ownership_generation::text
        AND m.author_kind='visitor' AND m.ownership_generation=l.ownership_generation
        AND l.ownership_generation+1=r.ownership_generation
        AND t.root_task_id=t.id AND t.product='agents'
        AND g.product=t.product AND g.version_id=t.version_id AND g.principal=t.principal
        AND g.resource_id=t.resource_id AND g.caller_client_id=t.caller_client_id
        AND t.channel_binding->>'customerConversationId'=r.conversation_id::text
        AND t.channel_binding->>'inputMessageId'=m.id::text
        AND t.channel_binding->>'ownershipGeneration'=l.ownership_generation::text
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
        AND ((t.principal->>'kind'='visitor' AND $5::text='website'
          AND t.resource_id=$6::text
          AND t.principal->>'deploymentId'=$6::text
          AND EXISTS(SELECT 1 FROM agents_platform.website_sessions s WHERE s.id::text=t.principal->>'sessionId' AND s.deployment_id=$6::uuid AND s.expires_at>clock_timestamp()))
          OR (t.principal->>'kind'='channel_customer' AND $5::text<>'website'
          AND t.resource_id=$7::text
          AND t.principal->>'deploymentId'=$7::text AND t.principal->>'participantId'=r.conversation_id::text))
      FOR SHARE OF t,g,m,c,l`, [receipt.task_id,row.id,row.organization_id,row.ownership_generation,row.channel_kind,row.deployment_id,row.channel_deployment_id])).rowCount;
    if (!valid || !await this.ports.verifyPendingHandoffReceipt(db,input)) return null;
    const message = await this.append(db,row,{ key:`handoff-receipt:${receipt.task_id}`, digest:requestDigest({origin,text}), kind:"assistant", body:text, taskId:receipt.task_id });
    await enqueueChannelMessage(db,row,message);
    const waiting=(await db.query<{requested_at:Date}>("SELECT requested_at FROM agents_platform.support_waiting WHERE task_id=$1 AND conversation_id=$2",[receipt.task_id,row.id])).rows[0];
    if(waiting)await recordSupportLifecycle(db,{conversationId:row.id,sourceKey:`handoff:${receipt.task_id}:acknowledgement`,action:"acknowledgement_committed",outcome:origin,
      occurredAt:message.created_at,durationMs:Math.max(0,message.created_at.getTime()-waiting.requested_at.getTime())});
    return message.id;
  }
  async publishEnquiryReview(db:PoolClient,input:{taskId:string;binding:ChannelBinding;reviewId:string;requestDigest:string;fields:Record<string,string|undefined>}):Promise<void>{
    const row=await this.conversation(db,input.binding.customerConversationId,true);
    if(row.channel_kind==="website")return;
    if(!(await db.query("SELECT 1 FROM agents_platform.customer_task_links WHERE task_id=$1 AND conversation_id=$2 AND input_message_id=$3 AND ownership_generation=$4",[input.taskId,row.id,input.binding.inputMessageId,input.binding.ownershipGeneration])).rowCount)denied();
    if(row.state!=="automation_active"||row.ownership_generation!==input.binding.ownershipGeneration||!await this.activeBinding(db,row))throw new PlatformError("CHANNEL_OWNERSHIP_CHANGED",403,"Conversation ownership changed");
    const key=`enquiry-review:${input.reviewId}`;
    if((await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[row.id,key])).rowCount)return;
    const review=(await db.query("SELECT amends_enquiry_id FROM agents_platform.enquiries WHERE id=$1",[input.reviewId])).rows[0];
    const body=enquiryReviewText(input.fields,Boolean(review?.amends_enquiry_id));
    const maximum=row.channel_kind==="whatsapp"?1024:row.channel_kind==="telegram"?4096:1000;
    if(Array.from(body).length>maximum)throw new PlatformError("ENQUIRY_CHANNEL_REVIEW_LIMIT",413,"Enquiry details exceed this channel’s confirmation message limit");
    const buttons=enquiryReviewButtons(input.reviewId),enquiryReview={id:input.reviewId,taskId:input.taskId,requestDigest:input.requestDigest};
    await assertEnquiryReviewPrompt(db,{assetId:"pending",recipientId:"pending",text:body,buttons,enquiryReview},row.id);
    const message=await this.append(db,row,{key,digest:requestDigest({body,enquiryReview}),kind:"assistant",body,taskId:input.taskId});
    await enqueueChannelMessage(db,row,message,{requestText:body,buttons,enquiryReview});
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
  async publishSupportStatus(taskId:string):Promise<boolean> {
    return transaction(this.pool,async db=>{
      const row=(await db.query(`SELECT s.*,op.output FROM agents_platform.support_status_executions s
        JOIN agents_platform.operations op ON op.task_id=s.task_id AND op.id='support-status:'||s.task_id::text
        WHERE s.task_id=$1 AND op.state='completed'`,[taskId])).rows[0];
      if(!row || !this.ports.verifySupportStatus || typeof row.output?.message?.content!=='string')return false;
      let value:unknown;try{value=JSON.parse(row.output.message.content);}catch{return false;}
      if(!value || typeof value!=='object' || typeof (value as {reply?:unknown}).reply!=='string')return false;
      const body=(value as {reply:string}).reply;
      const binding:StatusNoticeBinding={taskId,organizationId:row.organization_id,conversationId:row.conversation_id,
        inputMessageId:row.input_message_id,episodeCommandId:row.episode_command_id,ownershipGeneration:String(row.ownership_generation)};
      return Boolean(await publishSupportStatus(db,binding,body,this.ports.verifySupportStatus,async(client,target,text)=>{
        const conversation=await this.conversation(client,target.conversationId,true);
        const message=await this.append(client,conversation,{key:`support-status:${taskId}`,digest:requestDigest(text),kind:'assistant',body:text,taskId});
        await enqueueChannelMessage(client,conversation,message);return message.id;
      }));
    });
  }
  async assertSupportStatusDelivery(db:PoolClient,message:CustomerMessage):Promise<void> {
    const row=(await db.query('SELECT * FROM agents_platform.support_status_executions WHERE task_id=$1',[message.task_id])).rows[0];
    if(!row || !this.ports.verifySupportStatus)throw new PlatformError('CHANNEL_AUTHORITY_CHANGED',403,'Message authority changed');
    const binding:StatusNoticeBinding={taskId:row.task_id,organizationId:row.organization_id,conversationId:row.conversation_id,
      inputMessageId:row.input_message_id,episodeCommandId:row.episode_command_id,ownershipGeneration:String(row.ownership_generation)};
    if(!await assertSupportStatusNotice(db,binding,message.id,message.body,this.ports.verifySupportStatus))throw new PlatformError('CHANNEL_AUTHORITY_CHANGED',403,'Message authority changed');
  }
  private async readableMessage(db:Db,message:CustomerMessage):Promise<string|null>{
    if(message.request_key?.startsWith("human-assistance:"))return await humanAssistanceNoticeValid(db,message)?message.body:null;
    if (message.request_key?.startsWith('connected-uncertainty:')) {
      const receipt=(await db.query('SELECT operation_id FROM agents_platform.connected_uncertainty_notices WHERE message_id=$1 AND conversation_id=$2',[message.id,message.conversation_id])).rows[0];
      return receipt && await assertConnectedUncertaintyNotice(db as PoolClient,receipt.operation_id,message.id,'history') ? message.body : null;
    }
    if(message.task_id && message.request_key===`support-status:${message.task_id}`) {
      if(!this.ports.verifyHistoricalSupportStatus)return null;
      const row=(await db.query('SELECT * FROM agents_platform.support_status_executions WHERE task_id=$1',[message.task_id])).rows[0];
      if(!row)return null;
      const binding:StatusNoticeBinding={taskId:row.task_id,organizationId:row.organization_id,conversationId:row.conversation_id,
        inputMessageId:row.input_message_id,episodeCommandId:row.episode_command_id,ownershipGeneration:String(row.ownership_generation)};
      return await assertSupportStatusNoticeVisible(db as PoolClient,binding,message.id,message.body,this.ports.verifyHistoricalSupportStatus)?message.body:null;
    }
    if (!message.task_id && message.request_key?.startsWith("transition:")) {
      const receipt = (await db.query(`SELECT action FROM agents_platform.customer_commands
        WHERE conversation_id=$1 AND result->>'transitionMessageId'=$2 AND command_id::text=substring($3 from 12)
          AND result->>'ownership_generation'=$4 AND action IN ('return','resolve')`,
        [message.conversation_id,message.id,message.request_key,message.ownership_generation])).rows[0];
      const expected = receipt?.action === "return" ? transitionMessages.return : receipt?.action === "resolve" ? transitionMessages.resolve : null;
      return expected === message.body ? expected : null;
    }
    if(message.task_id && message.request_key===`handoff-receipt:${message.task_id}`) {
      const receipt=(await db.query(`SELECT * FROM agents_platform.pending_handoff_receipts
        WHERE task_id=$1 AND conversation_id=$2 AND ownership_generation=$3 AND message_id=$4
          AND outcome IN ('model','fallback')`,[message.task_id,message.conversation_id,message.ownership_generation,message.id])).rows[0];
      if(!receipt) return null;
      if(receipt.outcome==='fallback') return message.body===HANDOFF_RECEIPT?message.body:null;
      // The model receipt must continue to satisfy the same provenance and evidence checks on reads.
      return this.ports.verifyPendingHandoffReceipt && await this.ports.verifyPendingHandoffReceipt(db,{receipt,origin:'model',text:message.body}) ? message.body : null;
    }
    if (!message.task_id && message.body===HANDOFF_RECEIPT && (await db.query(`SELECT 1 FROM agents_platform.customer_commands c
      JOIN agents_platform.support_waiting w ON w.task_id=c.command_id AND w.conversation_id=c.conversation_id AND w.source_message_id=c.command_id
      JOIN agents_platform.customer_messages origin ON origin.id=w.source_message_id AND origin.conversation_id=w.conversation_id AND origin.author_kind='visitor'
      WHERE c.conversation_id=$1 AND c.action='message_handoff' AND c.result->>'handoffReceiptId'=$2 AND c.result->>'ownership_generation'=$3`,
    [message.conversation_id,message.id,message.ownership_generation])).rowCount) return HANDOFF_RECEIPT;
    if(!message.task_id && (await db.query(`SELECT 1 FROM agents_platform.support_waiting_notices n
      JOIN agents_platform.support_waiting w ON w.task_id=n.task_id WHERE n.message_id=$1 AND w.conversation_id=$2
      AND n.state='published' AND n.body=$3 AND n.ownership_generation=$4`,[message.id,message.conversation_id,message.body,message.ownership_generation])).rowCount) return message.body;
    if(!message.task_id)return null;
    if ((message.body===HANDOFF_RECEIPT || message.body===BOOKING_UNCERTAIN_RECEIPT) && (await db.query(`SELECT 1 FROM agents_platform.customer_commands c
      WHERE c.conversation_id=$1 AND c.command_id=$2 AND c.action='request_handoff' AND c.result->>'handoffReceiptId'=$3
        AND ($4=$5 OR ($4=$6 AND EXISTS(SELECT 1 FROM agents_platform.booking_intents b WHERE b.id::text=c.result->>'bookingUncertainId' AND b.task_id=c.command_id)))`,
    [message.conversation_id,message.task_id,message.id,message.body,HANDOFF_RECEIPT,BOOKING_UNCERTAIN_RECEIPT])).rowCount) return message.body;
    const enquiry=(await db.query(`SELECT e.fields,e.request_digest,o.request FROM agents_platform.channel_outbound o JOIN agents_platform.enquiries e ON e.id::text=o.request#>>'{enquiryReview,id}' WHERE o.message_id=$1 AND e.task_id=$2 LIMIT 1`,[message.id,message.task_id])).rows[0];
    if(enquiry){const text=enquiryReviewText(enquiry.fields);return message.body===text&&enquiry.request.enquiryReview?.requestDigest===enquiry.request_digest?text:null;}
    const prompt=(await db.query(`SELECT r.arguments,r.request_digest,r.binding_digest,o.request FROM agents_platform.channel_outbound o
      JOIN agents_platform.tool_invocation_reviews r ON r.id::text=o.request#>>'{toolReview,id}'
      WHERE o.message_id=$1 AND r.task_id=$2 LIMIT 1`,[message.id,message.task_id])).rows[0];
    if(prompt){const text=channelToolReviewText(prompt.arguments);return message.body===text&&prompt.request_digest===requestDigest({bindingDigest:prompt.binding_digest,arguments:prompt.arguments})&&prompt.request.toolReview?.requestDigest===prompt.request_digest?text:null;}
    return this.ports.readableOutput(db,message.task_id,message.body);
  }
  async assertConnectedUncertaintyDelivery(db:PoolClient,message:CustomerMessage):Promise<void> {
    const receipt=(await db.query('SELECT operation_id FROM agents_platform.connected_uncertainty_notices WHERE message_id=$1 AND conversation_id=$2',[message.id,message.conversation_id])).rows[0];
    if(!receipt || !await assertConnectedUncertaintyNotice(db,receipt.operation_id,message.id,'send')) throw new PlatformError('CHANNEL_AUTHORITY_CHANGED',403,'Message authority changed');
  }
  async assertPendingReceiptDelivery(db:PoolClient,message:CustomerMessage):Promise<void> {
    if(await this.readableMessage(db,message)!==message.body)
      throw new PlatformError("CHANNEL_AUTHORITY_CHANGED",403,"Message authority changed");
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
