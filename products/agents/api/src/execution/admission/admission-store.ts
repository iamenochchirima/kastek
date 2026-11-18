import { recordOrchestrationLifecycle } from "../../observability/orchestration-lifecycle";
import {schedulingPolicyFromEnvironment} from "../scheduling/policy";
import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";
import {
agentConfigurationSchema,assertGrantAuthority,assertRuntimeAvailable,canonicalJson,
executionGrantSchema,
PlatformError,requestDigest,principalSchema,
type AdmissionAuthority,
type ExecutionGrant
} from "../../contracts/contracts";

import { finishPage,readPageCursor,type PageQuery } from "../../infrastructure/read-pages";
import { resolveAutomationOwner } from "../lifecycle/automation-authority";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { assertComposition } from "../programs/composition";
import { compilePublishedComposition } from "../programs/publication";
import { assertEvaluationTrial, trialModelRoutes } from "./trial-authority";
import { recordEvent } from "../../observability/event-store";
import { channelBindingSchema } from "../../contracts/channel";
import { channelPorts } from "../../infrastructure/channel-ports";
import { automationModelRoutes } from "../models/automation-routes";
import { resolveAcceptedModelRoutes } from "../models/resolution";
import { executionModelLayers } from "../models/settings";
import { continuationModelRoutes } from "../lifecycle/work-continuation";
import { loadTaskModelRoutes, saveTaskModelRoutes } from "../models/persistence";
import { initializeRootModelAccount } from "../models/accounting";
import { loadExecution } from "../lifecycle/state";
import { assertPendingSupportStatusAuthority } from "../lifecycle/authority";
import { assertPlatformRootAdmissionOpen } from "./platform-gate";
import { assertCustomerChannelRecipient } from "../context/recipient-boundary";
import { assertAgentsBillingAccess, assertManagedModelAllowance, billingPaidPlan } from "../../product/billing/billing";
import { hasKnownPrice, isFreeModel, reservationMicros } from "../models/admission-budget";

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
    maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens, rootTokenLimit: row.root_token_limit, applicationCredentialId: row.application_credential_id, expiresAt: (row.expires_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null });
}


export class AdmissionStore extends AuthorityStore {
  async createApplicationGrantInTransaction(db: PoolClient, input: { grant: ExecutionGrant }): Promise<ExecutionGrant> {
    const grant = executionGrantSchema.parse(input.grant);
    if (grant.principal.kind !== "application" || new Date(grant.expiresAt).getTime() > Date.now() + 30 * 60_000) denied();
    const version = await this.version(db, grant.organizationId, grant.versionId);
    await this.assertPrincipal(db, grant, version, { applicationCredentialId: grant.applicationCredentialId });
    assertGrantAuthority(grant, grant, version.id, version.configuration);
    return this.insertGrant(db, grant);
  }
  async admitTask(input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    return this.transaction(db=>this.admitTaskInTransaction(db,input));
  }
  async admitTaskInTransaction(db:PoolClient,input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    return this.admitForPurpose(db,input);
  }
  async admitPrivatePreviewInTransaction(db:PoolClient,input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    if (input.authority.product!=="agents" || input.authority.principal.kind!=="human" || input.channelBinding || input.evaluationTrialId || input.conversationId || input.continuationOf) denied();
    return this.admitForPurpose(db,input,undefined,true);
  }
  async admitPendingSupportStatusInTransaction(db:PoolClient,input:AdmitTaskInput & {episodeCommandId:string}):Promise<{task:TaskRecord;replayed:boolean}> {
    if (!input.channelBinding || (!input.conversationId && input.authority.principal.kind!=="channel_customer") || input.evaluationTrialId || input.authority.product!=="agents" ||
        !["visitor","channel_customer"].includes(input.authority.principal.kind)) denied();
    return this.admitForPurpose(db,input,input.episodeCommandId);
  }
  private async admitForPurpose(db:PoolClient,input:AdmitTaskInput,episodeCommandId?:string,privatePreview=false):Promise<{task:TaskRecord;replayed:boolean}> {
    assertCustomerChannelRecipient(input.authority.product, input.authority.principal, input.channelBinding);
    if (input.authority.principal.kind === "application" &&
        (input.configurationMode !== "current" || input.channelBinding || input.evaluationTrialId || input.continuationOf || episodeCommandId || privatePreview)) denied();
    let billing: BillingEntitlementSnapshot | null = null;
    if (input.authority.product === "agents") billing = await assertAgentsBillingAccess(this.pool, input.authority.organizationId);
    const policy=schedulingPolicyFromEnvironment();
    const requestKey = text(input.requestKey, 128);
    if (!input.input.trim()) throw new PlatformError("INVALID_INPUT", 400, "Enter a message");

    // Serialize all admissions for this organization, including those across UTC day boundaries.
    if (!(await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.authority.organizationId])).rows[0]) denied();
    const row = (await db.query("SELECT * FROM agents_platform.execution_grants WHERE organization_id=$1 AND id=$2 FOR SHARE", [input.authority.organizationId, input.grantId])).rows[0];
    if (!row) denied();
    const grant = grantFromRow(row);
    const version = await this.version(db, input.authority.organizationId, input.versionId);
    const config = agentConfigurationSchema.parse(version.configuration);
    const bindings = (await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",
      [input.authority.organizationId, config.connectedToolBindingIds])).rows.map(row => capabilityBindingSchema.parse(row.binding));
    const composition = compilePublishedComposition(config, bindings,undefined,version.tool_bindings);
    assertComposition(version.effective_composition, composition);
    assertGrantAuthority(grant, input.authority, input.versionId, config);
    assertRuntimeAvailable(config);
    await this.assertPrincipal(db, input.authority, version, { currentDeployment: true, applicationCredentialId: grant.applicationCredentialId });
    if (input.authority.principal.kind === "channel_customer" && (!input.channelBinding ||
      channelBindingSchema.parse(input.channelBinding).customerConversationId !== input.authority.principal.participantId)) denied();
    if (input.configurationMode === "current") {
      if (input.evaluationTrialId || !["human", "application", "visitor", "channel_customer"].includes(input.authority.principal.kind) || input.authority.product !== "agents" && input.authority.principal.kind !== "human") denied();
      if (input.authority.principal.kind === "human" || input.authority.principal.kind === "application") {
        const latest = (await db.query("SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [input.authority.organizationId, version.agent_id])).rows[0];
        if (latest?.id !== version.id) throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Try again.");
      }
    }
    if (Buffer.byteLength(input.input) > config.model.maxInputBytes) throw new PlatformError("INPUT_LIMIT", 413, "The message exceeds the input limit");
    const digest = requestDigest({ authority: input.authority, versionId: input.versionId, input: input.input, conversationId: input.conversationId ?? null,
      evaluationTrialId: input.evaluationTrialId ?? null, channelBinding: input.channelBinding ?? null,
      ...(input.continuationOf?{continuationOf:input.continuationOf}:{}),
      ...(episodeCommandId?{purpose:"support_status_v1",episodeCommandId}:privatePreview?{purpose:"private_preview_v1"}:{}) });
    const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product=$1 AND organization_id=$2
      AND caller_client_id=$3 AND resource_id=$4 AND request_key=$5`, [input.authority.product, input.authority.organizationId, input.authority.callerClientId, input.authority.resourceId, requestKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The request key was used for different input");
      return { task: existing, replayed: true };
    }
    await assertPlatformRootAdmissionOpen(db);
    await assertEvaluationTrial(db, { trialId: input.evaluationTrialId, authority: input.authority, agentId: version.agent_id,
      versionId: version.id, rootTokenLimit: grant.rootTokenLimit, conversationId: input.conversationId });
    let models = input.evaluationTrialId ? await trialModelRoutes(db, input.evaluationTrialId, input.authority.organizationId, grant) : input.authority.principal.kind === "automation" ? await automationModelRoutes(db, input.authority, version.id, grant) : await resolveAcceptedModelRoutes(db, { organizationId: input.authority.organizationId,
      agentId: version.agent_id, product: input.authority.product, selection: config.model.selection, generation: config.model.generation,
      layers: [...executionModelLayers(config, grant),...(episodeCommandId?[{kind:"product" as const,reference:"support-status-v1",limits:{maxModelCalls:1,maxToolCalls:0,maxDurationMs:10000,maxCallDurationMs:10000,maxInputTokens:8192,maxOutputTokens:512,maxRootTokens:8704,compactAtTokens:1}}]:[])], requiresTools: !episodeCommandId && (config.tools.length > 0 || config.connectedToolBindingIds.length > 0 || config.productBindings.length > 0 || config.skillIds.length > 0),
      allowManagedPaidModels: billing ? billingPaidPlan(billing) : undefined });
    if(input.continuationOf) models=continuationModelRoutes(models,await loadTaskModelRoutes(db,input.continuationOf,input.authority.organizationId));
    // Customer keys keep working at zero allowance; only managed models stop.
    const primaryCustody=billing?(await db.query<{custody:string}>(`SELECT custody FROM agents_platform.model_provider_connections
      WHERE organization_id=$1 AND id=$2`,[input.authority.organizationId,models.primary.binding.connectionId])).rows[0]?.custody:undefined;
    assertManagedModelAllowance(billing,primaryCustody);
    // Free models cost nothing, so a token counter must not block them. Priced models are
    // checked against the plan's dollar credit balance instead of a flat token allowance.
    const freeModel = isFreeModel(models.primary);
    let enforceTokenAllowance = false;
    if (!freeModel) {
      if (hasKnownPrice(models.primary) && billing) {
        const required = reservationMicros(models.primary);
        if (required === 0n) enforceTokenAllowance = true;
        else if (BigInt(billing.credits.available) < required) {
          throw new PlatformError("BILLING_AI_ALLOWANCE_EXHAUSTED", 403, "The AI credit balance cannot cover this request");
        }
      } else {
        // Without a billing snapshot or a price, the token allowance remains the only guard.
        enforceTokenAllowance = true;
      }
    }
    if (Buffer.byteLength(input.input) > models.primary.policy.maxInputBytes) throw new PlatformError("INPUT_LIMIT", 413, "The message exceeds the effective input allowance");
    const active=(await db.query<{active_roots:number}>("SELECT active_roots FROM agents_platform.tenant_admission WHERE organization_id=$1 FOR UPDATE",[input.authority.organizationId])).rows[0];
    if(!active)throw new PlatformError("ADMISSION_STATE_UNAVAILABLE",503,"Admission capacity is unavailable");
    if(active.active_roots>=policy.maxConcurrentRoots)throw new PlatformError("CONCURRENCY_LIMIT",429,"Too many tasks are running");
    const reservation = models.primary.policy.maxRootTokens ?? 0;
    if(input.channelBinding && !episodeCommandId) await channelPorts(db).assertBinding(db,channelBindingSchema.parse(input.channelBinding),
      {organization_id:input.authority.organizationId,version_id:version.id,root_task_id:"admitting"});
    if (input.evaluationTrialId && !(await db.query(`UPDATE agents_platform.evaluation_trials SET allocated_tokens=allocated_tokens+$2
      WHERE id=$1 AND state='active' AND expires_at>now() AND allocated_tokens+$2<=max_tokens RETURNING id`, [input.evaluationTrialId, reservation])).rowCount) {
      throw new PlatformError("EVALUATION_BUDGET_EXCEEDED", 429, "The trial allocation limit was reached");
    }
    const day = (await db.query<{ day: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0]!.day;
    await db.query("INSERT INTO agents_platform.usage_accounts(organization_id,day,token_allowance) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING", [input.authority.organizationId,policy.dailyTokenAllowance]);
    if (enforceTokenAllowance) {
      const quota = (await db.query<{ day: string }>(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens+$2
        WHERE organization_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND reserved_tokens+consumed_tokens+$2<=token_allowance RETURNING day`, [input.authority.organizationId, reservation])).rows[0];
      if (!quota) throw new PlatformError("QUOTA_EXCEEDED", 429, "The daily usage limit was reached");
    } else {
      // The allowance is not the guard here (free model or a dollar-checked plan), so lift it
      // to keep the accounting rows valid instead of failing the table constraint.
      await db.query(`UPDATE agents_platform.usage_accounts
        SET token_allowance=GREATEST(token_allowance,reserved_tokens+consumed_tokens+$2),
            reserved_tokens=reserved_tokens+$2
        WHERE organization_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date`, [input.authority.organizationId, reservation]);
    }
    const conversationId = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      const conversation = (await db.query<{ agent_id: string; principal: unknown; deployment_id: string | null }>("SELECT agent_id,principal,deployment_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [input.authority.organizationId, conversationId])).rows[0];
      if (!conversation || conversation.agent_id !== version.agent_id ||
        conversation.deployment_id !== (input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null)) denied();
      if (canonicalJson(conversation.principal) !== canonicalJson(input.authority.principal)) {
        const origin = principalSchema.parse(conversation.principal), current = input.authority.principal;
        if (input.authority.product !== "agents" || origin.kind !== "visitor" || current.kind !== "visitor" || !input.channelBinding ||
          !await channelPorts(db).visitorLineage?.(db, { organizationId: input.authority.organizationId, agentId: version.agent_id,
            executionConversationId: conversationId, customerConversationId: input.channelBinding.customerConversationId, current, origin })) denied();
      }
    } else await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,deployment_id) VALUES($1,$2,$3,$4,$5)",
      [conversationId, input.authority.organizationId, version.agent_id, input.authority.principal, input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null]);
    const priorVersion = (await db.query("SELECT version_id FROM agents_platform.tasks WHERE conversation_id=$1 ORDER BY turn_sequence DESC LIMIT 1", [conversationId])).rows[0];
    if (priorVersion && priorVersion.version_id !== input.versionId && input.configurationMode !== "current") throw new PlatformError("CONVERSATION_VERSION_CONFLICT",409,"Start a new conversation for this version");
    const sequence = (await db.query("UPDATE agents_platform.conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence", [conversationId])).rows[0].sequence;
    const task = (await db.query<TaskRecord>(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,
      principal,version_id,grant_id,conversation_id,request_key,request_digest,input,turn_sequence,root_token_limit,effective_composition,evaluation_trial_id,channel_binding,harness_release,prior_task_id${episodeCommandId||privatePreview?",execution_purpose":""}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19${episodeCommandId||privatePreview?",$20":""}) RETURNING *`,
    [input.taskId ?? randomUUID(), input.authority.product, input.authority.organizationId, input.authority.resourceId, input.authority.callerClientId, input.authority.principal,
      input.versionId, grant.id, conversationId, requestKey, digest, input.input, sequence, models.primary.policy.maxRootTokens, composition, input.evaluationTrialId ?? null,input.channelBinding??null,composition.runtime.release,input.continuationOf??null,...(episodeCommandId?["support_status_v1"]:privatePreview?["private_preview_v1"]:[])])).rows[0]!;
    const policyVersion=models.primary.policy.revision==="model-execution-policy-v1"?1:2;
    const customerDeadline = input.authority.principal.kind === "visitor" || input.authority.principal.kind === "channel_customer" ? grant.expiresAt : null;
    const admitted=(await db.query(`UPDATE agents_platform.tasks SET execution_policy_version=$2,
      deadline_at=LEAST($4::timestamptz, CASE WHEN $2=1 THEN deadline_at WHEN $3::double precision IS NULL THEN NULL
        ELSE created_at+($3::double precision * interval '1 millisecond') END)
      WHERE id=$1 RETURNING deadline_at,execution_policy_version`,[task.id,policyVersion,models.primary.policy.maxWallDurationMs,customerDeadline])).rows[0];
    Object.assign(task,admitted);
    await db.query("INSERT INTO agents_platform.execution_roots(root_task_id) VALUES($1)", [task.id]);
    if(config.program.id==="tool-directed"&&config.program.version==="4") await recordOrchestrationLifecycle(db,{organizationId:task.organization_id,key:task.id,action:"started",outcome:"pending",occurredAt:new Date(task.created_at).toISOString()});
    await saveTaskModelRoutes(db, task.id, task.organization_id, models);
    let maxCostMicros = models.primary.policy.maxCostMicros === null ? null : BigInt(models.primary.policy.maxCostMicros);
    let creditCapped = false;
    if (billing && primaryCustody === "platform_managed") {
      const available = BigInt(billing.credits.available);
      maxCostMicros = maxCostMicros === null || available < maxCostMicros ? available : maxCostMicros;
      creditCapped = true;
    }
    await initializeRootModelAccount(db, { organizationId: task.organization_id, rootTaskId: task.id, maxCostMicros, creditCapped });
    if(episodeCommandId) {
      const binding=channelBindingSchema.parse(input.channelBinding);
      if (!input.conversationId) {
        // Only an attachment-origin episode may create a conversation during a status turn.
        const linked=await db.query(`UPDATE agents_platform.customer_conversations c SET execution_conversation_id=$1
          FROM agents_platform.support_waiting w, agents_platform.customer_commands cmd, agents_platform.customer_messages origin
          WHERE c.id=$2 AND c.organization_id=$3 AND c.execution_conversation_id IS NULL AND c.state='handoff_pending'
            AND c.ownership_generation=$4 AND c.channel_deployment_id=$5
            AND w.conversation_id=c.id AND w.task_id=$6 AND w.source_message_id=w.task_id
            AND cmd.conversation_id=c.id AND cmd.command_id=w.task_id AND cmd.action='message_handoff'
            AND origin.id=w.source_message_id AND origin.conversation_id=c.id AND origin.author_kind='visitor'
          RETURNING c.id`,[conversationId,binding.customerConversationId,task.organization_id,binding.ownershipGeneration,input.authority.resourceId,episodeCommandId]);
        if(!linked.rowCount)denied();
      }
      await db.query(`INSERT INTO agents_platform.support_status_executions(task_id,organization_id,conversation_id,input_message_id,episode_command_id,ownership_generation)
        VALUES($1,$2,$3,$4,$5,$6)`,[task.id,task.organization_id,binding.customerConversationId,binding.inputMessageId,episodeCommandId,binding.ownershipGeneration]);
      await db.query("INSERT INTO agents_platform.customer_task_links(task_id,conversation_id,input_message_id,ownership_generation) VALUES($1,$2,$3,$4)",[task.id,binding.customerConversationId,binding.inputMessageId,binding.ownershipGeneration]);
      await assertPendingSupportStatusAuthority(db,await loadExecution(db,task.id));
    }
    await db.query("INSERT INTO agents_platform.task_outbox(task_id) VALUES($1)", [task.id]);
    await db.query("INSERT INTO agents_platform.usage_reservations(task_id,organization_id,day,tokens) VALUES($1,$2,$3,$4)", [task.id, input.authority.organizationId, day, reservation]);
    await recordEvent(db, task.id, "accepted", "accepted");
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
      if(canonicalJson(conversation.principal)!==canonicalJson(authority.principal)||
        (authority.product==="agents"&&authority.principal.kind==="human"&&conversation.agent_id!==authority.resourceId)||
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
