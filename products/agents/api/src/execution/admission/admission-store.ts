import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
agentConfigurationSchema,assertGrantAuthority,assertRuntimeAvailable,canonicalJson,
executionGrantSchema,initialLimits,
PlatformError,requestDigest,
type AdmissionAuthority,
type ExecutionGrant
} from "../../contracts/contracts";

import { finishPage,readPageCursor,type PageQuery } from "../../infrastructure/read-pages";
import { resolveAutomationOwner } from "../lifecycle/automation-authority";

import type { AdmitTaskInput,TaskEvent,TaskRecord } from "../../contracts/records";
import { AuthorityStore } from "./authority-store";

type Db=Pool|PoolClient;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function denied(): never { throw new PlatformError("ACCESS_DENIED", 403, "Access denied"); }
function absent(): never { throw new PlatformError("NOT_FOUND", 404, "Record not found"); }
function text(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new PlatformError("INVALID_INPUT", 400, "Invalid input");
  return normalized;
}
function tokenHash(token: string): string | null { return /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : null; }
function grantFromRow(row: Record<string, unknown>): ExecutionGrant {
  return executionGrantSchema.parse({ id: row.id, product: row.product, organizationId: row.organization_id,
    resourceId: row.resource_id, callerClientId: row.caller_client_id, principal: row.principal, versionId: row.version_id,
    operations: row.operations, sourceRevisionIds: row.source_revision_ids, connectedToolBindingIds: row.connected_tool_binding_ids, maxInputBytes: row.max_input_bytes,
    maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens, rootTokenLimit: row.root_token_limit, expiresAt: (row.expires_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null });
}


export class AdmissionStore extends AuthorityStore {
  async admitTask(input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    return this.transaction(db=>this.admitTaskInTransaction(db,input));
  }
  async admitTaskInTransaction(db:PoolClient,input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    const requestKey = text(input.requestKey, 128);
    if (!input.input.trim()) throw new PlatformError("INVALID_INPUT", 400, "Enter a message");

    // Serialize all admissions for this organization, including those across UTC day boundaries.
    if (!(await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.authority.organizationId])).rows[0]) denied();
    const row = (await db.query("SELECT * FROM agents_platform.execution_grants WHERE organization_id=$1 AND id=$2 FOR SHARE", [input.authority.organizationId, input.grantId])).rows[0];
    if (!row) denied();
    const grant = grantFromRow(row);
    const version = await this.version(db, input.authority.organizationId, input.versionId);
    const config = agentConfigurationSchema.parse(version.configuration);
    assertGrantAuthority(grant, input.authority, input.versionId, config);
    assertRuntimeAvailable(config);
    await this.assertPrincipal(db, input.authority, version);
    if (Buffer.byteLength(input.input) > config.model.maxInputBytes) throw new PlatformError("INPUT_LIMIT", 413, "The message exceeds the input limit");
    const digest = requestDigest({ authority: input.authority, versionId: input.versionId, input: input.input, conversationId: input.conversationId ?? null });
    const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product=$1 AND organization_id=$2
      AND caller_client_id=$3 AND resource_id=$4 AND request_key=$5`, [input.authority.product, input.authority.organizationId, input.authority.callerClientId, input.authority.resourceId, requestKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The request key was used for different input");
      return { task: existing, replayed: true };
    }
    const active = (await db.query<{ count: string }>("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1 AND parent_task_id IS NULL AND state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')", [input.authority.organizationId])).rows[0]!;
    if (Number(active.count) >= initialLimits.maxConcurrentTasks) throw new PlatformError("CONCURRENCY_LIMIT", 429, "Too many tasks are running");
    const reservation = grant.rootTokenLimit;
    await db.query("INSERT INTO agents_platform.usage_accounts(organization_id,day) VALUES($1,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING", [input.authority.organizationId]);
    const quota = (await db.query<{ day: string }>(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens+$2
      WHERE organization_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND reserved_tokens+consumed_tokens+$2<=token_allowance RETURNING day`, [input.authority.organizationId, reservation])).rows[0];
    if (!quota) throw new PlatformError("QUOTA_EXCEEDED", 429, "The daily usage limit was reached");
    const conversationId = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      const conversation = (await db.query<{ agent_id: string; principal: unknown; deployment_id: string | null }>("SELECT agent_id,principal,deployment_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [input.authority.organizationId, conversationId])).rows[0];
      if (!conversation || conversation.agent_id !== version.agent_id || canonicalJson(conversation.principal) !== canonicalJson(input.authority.principal) ||
        conversation.deployment_id !== (input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null)) denied();
    } else await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,deployment_id) VALUES($1,$2,$3,$4,$5)",
      [conversationId, input.authority.organizationId, version.agent_id, input.authority.principal, input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null]);
    const priorVersion = (await db.query("SELECT version_id FROM agents_platform.tasks WHERE conversation_id=$1 ORDER BY turn_sequence DESC LIMIT 1", [conversationId])).rows[0];
    if (priorVersion && priorVersion.version_id !== input.versionId) throw new PlatformError("CONVERSATION_VERSION_CONFLICT",409,"Start a new conversation for this version");
    const sequence = (await db.query("UPDATE agents_platform.conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence", [conversationId])).rows[0].sequence;
    const task = (await db.query<TaskRecord>(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,
      principal,version_id,grant_id,conversation_id,request_key,request_digest,input,turn_sequence,root_token_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(), input.authority.product, input.authority.organizationId, input.authority.resourceId, input.authority.callerClientId, input.authority.principal,
      input.versionId, grant.id, conversationId, requestKey, digest, input.input, sequence, reservation])).rows[0]!;
    await db.query("INSERT INTO agents_platform.execution_roots(root_task_id) VALUES($1)", [task.id]);
    await db.query("INSERT INTO agents_platform.task_outbox(task_id) VALUES($1)", [task.id]);
    await db.query("INSERT INTO agents_platform.usage_reservations(task_id,organization_id,day,tokens) VALUES($1,$2,$3,$4)", [task.id, input.authority.organizationId, quota.day, reservation]);
    await db.query("INSERT INTO agents_platform.task_events(task_id,event_key,kind) VALUES($1,'accepted','accepted')", [task.id]);
    return { task, replayed: false };
  }
  async getTask(authority: AdmissionAuthority, taskId: string): Promise<TaskRecord> {
    return this.transaction(async (db) => {
      const task = (await db.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2", [taskId, authority.organizationId])).rows[0] ?? absent();
      if (task.product !== authority.product || task.resource_id !== authority.resourceId || task.caller_client_id !== authority.callerClientId || canonicalJson(task.principal) !== canonicalJson(authority.principal)) denied();
      if(authority.principal.kind==="automation")await resolveAutomationOwner(db,authority.organizationId,authority.principal);
      else await this.assertPrincipal(db, authority, await this.version(db, authority.organizationId, task.version_id));
      return task;
    });
  }
  async getConversation(authority: AdmissionAuthority, conversationId: string): Promise<TaskRecord[]> {
    return (await this.getConversationPage(authority,conversationId,{limit:100})).items;
  }
  async getConversationPage(authority: AdmissionAuthority, conversationId:string, query:PageQuery) {
    const scope={kind:"turns",authority,conversationId},cursor=readPageCursor(query.cursor,scope);
    return this.transaction(async db=>{
      const conversation=(await db.query<{agent_id:string;principal:unknown;deployment_id:string|null;deleted_at:Date|null}>(
        "SELECT agent_id,principal,deployment_id,deleted_at FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 FOR SHARE",[authority.organizationId,conversationId])).rows[0]??absent();
      if(authority.product!=="agents"||canonicalJson(conversation.principal)!==canonicalJson(authority.principal)||
        (authority.principal.kind==="human"&&conversation.agent_id!==authority.resourceId)||
        (authority.principal.kind==="visitor"&&conversation.deployment_id!==authority.resourceId))denied();
      const first=(await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND conversation_id=$2
        AND product=$3 AND caller_client_id=$4 AND resource_id=$5 AND parent_task_id IS NULL ORDER BY turn_sequence LIMIT 1`,
        [authority.organizationId,conversationId,authority.product,authority.callerClientId,authority.resourceId])).rows[0]??absent();
      if(authority.principal.kind==="automation")await resolveAutomationOwner(db,authority.organizationId,authority.principal);
      else await this.assertPrincipal(db,authority,await this.version(db,authority.organizationId,first.version_id));
      if(cursor.position&&!/^\d{1,19}$/.test(cursor.position))throw new PlatformError("INVALID_CURSOR",400,"Invalid turn cursor");
      const latest=(await db.query<{id:string;version_id:string;turn_sequence:string;number:number}>(`SELECT t.id,t.version_id,t.turn_sequence,v.number FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.conversation_id=$1 AND t.parent_task_id IS NULL ORDER BY t.turn_sequence DESC LIMIT 1`,[conversationId])).rows[0]!;
      const tasks=(await db.query<TaskRecord&{turn_sequence:string}>(`SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND conversation_id=$2
        AND product=$3 AND caller_client_id=$4 AND resource_id=$5 AND principal=$6::jsonb AND parent_task_id IS NULL
        AND ($7::bigint IS NULL OR turn_sequence<$7::bigint) AND created_at<=$8 ORDER BY turn_sequence DESC LIMIT $9`,
        [authority.organizationId,conversationId,authority.product,authority.callerClientId,authority.resourceId,JSON.stringify(authority.principal),cursor.position||null,cursor.snapshot,query.limit+1])).rows;
      const page=finishPage(tasks,query.limit,scope,cursor.snapshot,row=>({position:row.turn_sequence,id:row.id}));
      const items=page.items.reverse().map(task=>conversation.deleted_at?{...task,input:"[Deleted conversation]",output:null}:task);
      return {...page,items,conversation:{id:conversationId,agentId:conversation.agent_id,versionId:latest.version_id,versionNumber:latest.number,latestTaskId:latest.id,latestTurnSequence:latest.turn_sequence}};
    });
  }
  async getEventPage(authority:AdmissionAuthority,taskId:string,query:PageQuery) {
    const candidate=(await this.pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2",[authority.organizationId,taskId])).rows[0]??absent();
    const root=await this.getTask(authority,candidate.parent_task_id?candidate.root_task_id:taskId);
    if(canonicalJson(candidate.principal)!==canonicalJson(root.principal))denied();
    const scope={kind:"events",authority,taskId},cursor=readPageCursor(query.cursor,scope);
    if(cursor.position&&!/^\d{1,19}$/.test(cursor.position))throw new PlatformError("INVALID_CURSOR",400,"Invalid event cursor");
    const events=(await this.pool.query<TaskEvent>(`SELECT * FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2::bigint
      AND created_at<=$3 ORDER BY sequence LIMIT $4`,[taskId,cursor.position||"0",cursor.snapshot,query.limit+1])).rows;
    return finishPage(events,query.limit,scope,cursor.snapshot,row=>({position:row.sequence,id:""}));
  }
  async listTaskEvents(authority: AdmissionAuthority, taskId: string, afterSequence = "0"): Promise<TaskEvent[]> {
    if (!/^\d{1,19}$/.test(afterSequence) || BigInt(afterSequence) > 9223372036854775807n) throw new PlatformError("INVALID_CURSOR", 400, "Invalid event cursor");
    await this.getTask(authority, taskId);
    return (await this.pool.query<TaskEvent>("SELECT * FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100", [taskId, afterSequence])).rows;
  }
}
