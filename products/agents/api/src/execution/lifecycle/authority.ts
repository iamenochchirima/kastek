import { deadlineMillis } from "./deadline";
import { memberAssistantEnabled } from "../../infrastructure/member-assistant-policy";
import type { Pool,PoolClient } from "pg";
import {
assertGrantAuthority,isCustomerPrincipal,requestDigest,
executionGrantSchema,
PlatformError,
terminalTaskStates
} from "../../contracts/contracts";

import { assertChannelCustomerAuthority } from "../admission/channel-authority";
import { assertPublicSkillPolicy } from "../../capabilities/skills/public-policy";
import { assertCurrentSkillPolicy } from "../../capabilities/skills/current-policy";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { assertAutomationAuthority } from "./automation-authority";
export { transaction } from "../../infrastructure/database";

import type { Execution } from "../../contracts/execution";
import { loadExecution } from "./state";
import { assertEvaluationTrial } from "../admission/trial-authority";
import { channelBindingSchema } from "../../contracts/channel";
import { channelPorts } from "../../infrastructure/channel-ports";
import { assertProductAuthority } from "../admission/product-authority";
import { assertApplicationAuthority } from "../admission/application-authority";
import { assertProductNativeTaskAccess } from "../../contracts/resource-scope";
import { assertCustomerNativeBindings } from "../../capabilities/connected-tools/customer-native-policy";
import { currentVisitorLineageAllowed } from "../context/visitor-lineage";
import { HANDOFF_HARNESS_RELEASE } from "../../contracts/execution";
import { assertParentEdge } from "../delegation/scope";
import { assertCustomerChannelRecipient } from "../context/recipient-boundary";
import { assertPublishedTools } from "../../capabilities/tool-definitions";
import { parseHandoffFeedbackRequest, type HandoffFeedbackRequest } from "./handoff-feedback-contract";
export async function assertBaseAuthority(db: Pool | PoolClient, execution: Execution, options: { allowSettled?: boolean } = {}): Promise<void> {
  return assertBaseAuthorityForPurpose(db, execution, false, options.allowSettled ?? false);
}

async function assertBaseAuthorityForPurpose(db: Pool | PoolClient, execution: Execution, handoffFeedback: boolean, allowSettled = false): Promise<void> {
  const { task, configuration, agentId } = execution;
  assertCustomerChannelRecipient(task.product, task.principal, task.channel_binding);
  if (!allowSettled && terminalTaskStates.has(task.state)) throw new PlatformError("TASK_SETTLED", 409, "Task has settled");
  if (task.state === "cancel_requested") throw new PlatformError("TASK_CANCELLED", 409, "Task is stopping");
  if (!allowSettled && deadlineMillis(task.deadline_at) <= Date.now()) throw new PlatformError("TASK_DEADLINE", 409, "Task deadline reached");
  if (task.channel_binding && !handoffFeedback) {
    const root = task.parent_task_id ? await loadExecution(db, task.root_task_id) : execution;
    await channelPorts(db).assertBinding(db, channelBindingSchema.parse(task.channel_binding), root.task);
  }
  if (task.parent_task_id) {
    const parent = await loadExecution(db, task.parent_task_id);
    assertParentEdge(parent,execution);
    const role=(await db.query("SELECT binding_id FROM agents_platform.delegations WHERE child_task_id=$1 AND parent_task_id=$2",[task.id,parent.task.id])).rows[0];
    if(!parent.configuration.capabilities.delegation.enabled || !parent.configuration.capabilities.delegation.bindings.some(binding=>binding.id===role?.binding_id&&binding.versionId===task.version_id)) throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Delegation is unavailable");
    await assertBaseAuthority(db, parent);
  } else {
    await assertEvaluationTrial(db, { trialId: task.evaluation_trial_id, authority: { product: task.product, organizationId: task.organization_id,
      resourceId: task.resource_id, callerClientId: task.caller_client_id, principal: task.principal }, agentId, versionId: task.version_id });
    const sources=(await db.query(`SELECT v.deleted_at FROM agents_platform.tasks c JOIN agents_platform.conversations v ON v.id=c.conversation_id
      WHERE c.parent_task_id=$1 ORDER BY v.id FOR SHARE OF v`,[task.id])).rows;
    if(sources.some(source=>source.deleted_at)) throw new PlatformError("CHILD_RESULT_UNAVAILABLE",403,"Specialist source history was deleted");
  }
  const conversation = (await db.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1 FOR SHARE", [task.conversation_id])).rows[0];
  if (!conversation || conversation.deleted_at) throw new PlatformError("CONVERSATION_DELETED", 403, "Conversation is unavailable");
  const row = (await db.query("SELECT * FROM agents_platform.execution_grants WHERE id=$1 AND organization_id=$2 FOR SHARE",
    [task.grant_id, task.organization_id])).rows[0];
  if (!row || row.revoked_at) throw new PlatformError("GRANT_REVOKED", 403, "Execution access was revoked");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new PlatformError("AUTHORITY_EXPIRED", 403, "Continue with current access");
  const grant = executionGrantSchema.parse({ id: row.id, product: row.product, principal: row.principal, operations: row.operations,
    organizationId: row.organization_id, resourceId: row.resource_id,
    callerClientId: row.caller_client_id, versionId: row.version_id, sourceRevisionIds: row.source_revision_ids, connectedToolBindingIds: row.connected_tool_binding_ids,
    maxInputBytes: row.max_input_bytes, maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens,
    rootTokenLimit: row.root_token_limit, expiresAt: row.expires_at.toISOString(), revokedAt: null });
  assertGrantAuthority(grant, { product: task.product, organizationId: task.organization_id,
    resourceId: task.resource_id, callerClientId: task.caller_client_id, principal: task.principal }, task.version_id, configuration);
  if(task.product!=="agents") {
    await assertProductNativeTaskAccess(db, execution);
    await assertProductAuthority(db,{product:task.product,organizationId:task.organization_id,resourceId:task.resource_id,
      callerClientId:task.caller_client_id,principal:task.principal},task.version_id,task.grant_id);
  } else if (task.principal.kind === "human") {
    const allowed = await db.query(`SELECT 1 FROM agents_platform.memberships m JOIN agents_platform.accounts a ON a.id=m.account_id
      WHERE m.organization_id=$1 AND a.issuer=$2 AND a.subject=$3 AND m.revoked_at IS NULL FOR SHARE OF m`,
    [task.organization_id, task.principal.issuer, task.principal.subject]);
    if (!allowed.rowCount) throw new PlatformError("MEMBERSHIP_INACTIVE", 403, "Workspace access is unavailable");
    const privateRoot=(await db.query(`SELECT l.state,l.generation,m.link_generation,c.state connection_state,c.revision,c.credential_revision,
      l.connection_revision,l.credential_revision link_credential_revision FROM agents_platform.member_channel_tasks m
      JOIN agents_platform.member_channel_links l ON l.id=m.link_id JOIN agents_platform.channel_connections c ON c.id=l.connection_id
      WHERE m.task_id=$1 FOR SHARE OF l,c`,[task.root_task_id])).rows[0];
    if(privateRoot) {
      if(!memberAssistantEnabled(task.organization_id)||privateRoot.state!=='active'||privateRoot.generation!==privateRoot.link_generation||privateRoot.connection_state!=='active'||privateRoot.revision!==privateRoot.connection_revision||privateRoot.credential_revision!==privateRoot.link_credential_revision)
        throw new PlatformError("MEMBER_CHANNEL_REVOKED",403,"Private messaging access was revoked");
    }

  } else if (task.principal.kind === "application") {
    // Delegated runs inherit their parent's authority, checked recursively above.
    if (!task.parent_task_id) await assertApplicationAuthority(db, { product: task.product, organizationId: task.organization_id,
      resourceId: task.resource_id, callerClientId: task.caller_client_id, principal: task.principal }, agentId, row.application_credential_id);
  } else if (task.principal.kind === "visitor" && !task.parent_task_id) {
    if (!await currentVisitorLineageAllowed(db,execution)) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED",403,"Website return access is unavailable");
    const allowed = await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.organization_id=$1 AND d.id=$2 AND EXISTS(SELECT 1 FROM agents_platform.agent_versions v WHERE v.id=$3 AND v.agent_id=d.agent_id AND v.organization_id=d.organization_id) AND d.agent_id=$4 AND d.revoked_at IS NULL AND d.paused=false
      AND s.id=$5 AND s.expires_at>now() FOR SHARE OF d`,
    [task.organization_id, task.principal.deploymentId, task.version_id, agentId, task.principal.sessionId]);
    if (!allowed.rowCount) {
      throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Website execution access is unavailable");
    }
  } else if (task.principal.kind === "channel_customer" && !task.parent_task_id) {
    if (task.caller_client_id !== "agents-channel" || task.resource_id !== task.principal.deploymentId || !task.channel_binding) {
      throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel execution access is unavailable");
    }
    if (channelBindingSchema.parse(task.channel_binding).customerConversationId !== task.principal.participantId) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer participant changed");
    await assertChannelCustomerAuthority(db, { organizationId: task.organization_id, principal: task.principal, agentId, versionId: task.version_id });
  } else if(task.principal.kind==="automation")await assertAutomationAuthority(db,execution);
  else if(task.parent_task_id && isCustomerPrincipal(task.principal)) { /* The ancestor validates the deployment, session and ownership generation. */ }
  else throw new PlatformError("AUTOMATION_UNAVAILABLE", 403, "Automation execution is unavailable");
  if (isCustomerPrincipal(task.principal)) {
    if (configuration.memory.enabled || configuration.capabilities.sandbox.enabled || configuration.capabilities.workflows.enabled || configuration.tools.some(t => t.startsWith("memory."))) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED",403,"Customer agents require public capabilities");
    await assertPublicSkillPolicy(db,task.organization_id,agentId,configuration.skillIds);
    await assertCustomerNativeBindings(db as PoolClient,task.organization_id,configuration.connectedToolBindingIds);
  }
  await assertCurrentSkillPolicy(db,execution,grant.operations);
  if(configuration.capabilities.businessActions.enabled)await loadBookingPolicy(db,task.organization_id,agentId,configuration.capabilities.businessActions);
}

/** A status-only root is bound to one visitor message in one pending episode. */
export async function assertPendingSupportStatusAuthority(db: Pool | PoolClient, execution: Execution): Promise<void> {
  const task=execution.task, binding=task.channel_binding && channelBindingSchema.parse(task.channel_binding);
  if(task.execution_purpose!=="support_status_v1" || task.product!=="agents" || task.parent_task_id || task.root_task_id!==task.id ||
     !binding || !isCustomerPrincipal(task.principal)) throw new PlatformError("SUPPORT_STATUS_DENIED",403,"Support status is unavailable");
  const row=(await db.query(`SELECT c.session_id FROM agents_platform.support_status_executions s
    JOIN agents_platform.tasks current_task ON current_task.id=s.task_id AND current_task.organization_id=s.organization_id
    JOIN agents_platform.customer_conversations c ON c.id=s.conversation_id AND c.organization_id=s.organization_id
    JOIN agents_platform.agents a ON a.id=c.agent_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL
    JOIN agents_platform.customer_messages m ON m.id=s.input_message_id AND m.conversation_id=c.id
    JOIN agents_platform.support_waiting w ON w.task_id=s.episode_command_id AND w.conversation_id=c.id
    JOIN agents_platform.customer_commands command ON command.conversation_id=c.id AND command.command_id=w.task_id
    WHERE s.task_id=$1 AND s.organization_id=$2 AND s.conversation_id=$3 AND s.input_message_id=$4
      AND current_task.execution_purpose='support_status_v1' AND current_task.state NOT IN ('cancel_requested','completed','incomplete','refused','failed','cancelled','uncertain')
      AND (current_task.deadline_at IS NULL OR current_task.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_cancellations cancel WHERE cancel.task_id=s.task_id AND cancel.completed_at IS NULL)
      AND s.ownership_generation=$5::bigint AND c.ownership_generation=s.ownership_generation AND c.state='handoff_pending'
      AND c.agent_id=$6 AND c.execution_conversation_id=current_task.conversation_id AND m.author_kind='visitor' AND m.ownership_generation=s.ownership_generation AND m.body=$7
      AND m.sequence>c.return_watermark AND w.ownership_generation<=s.ownership_generation
      AND command.result->>'ownership_generation'=w.ownership_generation::text
      AND ((w.source_task_id=w.task_id AND w.source_message_id IS NULL AND command.action='request_handoff' AND $12::boolean)
        OR (w.source_message_id=w.task_id AND w.source_task_id IS NULL AND command.action='message_handoff'
          AND EXISTS(SELECT 1 FROM agents_platform.customer_messages origin WHERE origin.id=w.source_message_id
            AND origin.conversation_id=c.id AND origin.author_kind='visitor' AND origin.ownership_generation+1=w.ownership_generation)))
      AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_messages newer WHERE newer.conversation_id=c.id
        AND ((newer.author_kind='visitor' AND newer.sequence>m.sequence) OR (newer.author_kind='human' AND newer.ownership_generation>=w.ownership_generation)))
      AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_commands next WHERE next.conversation_id=c.id
        AND next.action IN ('request_handoff','message_handoff','return','resolve') AND next.command_id<>w.task_id
        AND (next.result->>'ownership_generation')::bigint>w.ownership_generation)
      AND (($8::text='visitor' AND c.channel_kind='website' AND c.deployment_id=$9::uuid)
        OR ($8::text='channel_customer' AND c.channel_kind<>'website' AND c.channel_deployment_id=$9::uuid AND c.id=$10::uuid))
      AND ((c.channel_kind='website' AND EXISTS(SELECT 1 FROM agents_platform.website_deployments d
        WHERE d.id=c.deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id AND d.version_id=$11
          AND d.revoked_at IS NULL AND NOT d.paused)) OR (c.channel_kind<>'website' AND EXISTS(SELECT 1
        FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections x ON x.id=d.connection_id AND x.organization_id=d.organization_id
        WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id AND d.version_id=$11
          AND d.state='active' AND x.state='active'))) FOR SHARE OF s,c,m,w,command,current_task,a`,
    [task.id,task.organization_id,binding.customerConversationId,binding.inputMessageId,binding.ownershipGeneration,execution.agentId,task.input,
      task.principal.kind,task.principal.deploymentId,task.principal.kind==='visitor'?task.principal.sessionId:task.principal.participantId,task.version_id,
      execution.configuration.tools.includes("channel.request_handoff")])).rows[0];
  if(!row)throw new PlatformError("SUPPORT_STATUS_DENIED",403,"Support status is unavailable");
  if(task.principal.kind==='visitor' && row.session_id!==task.principal.sessionId &&
    !(await channelPorts(db).visitorLineage?.(db,{organizationId:task.organization_id,agentId:execution.agentId,
      executionConversationId:task.conversation_id,customerConversationId:binding.customerConversationId,current:task.principal,
      origin:{deploymentId:task.principal.deploymentId,sessionId:row.session_id}})))throw new PlatformError("SUPPORT_STATUS_DENIED",403,"Support status is unavailable");
  await assertBaseAuthorityForPurpose(db,execution,true);
}

/** The caller must hold the root, task, conversation and receipt locks until model dispatch.
 * This checks only a pre-reserved acknowledgement operation; it does not admit a new operation. */
export async function assertHandoffFeedbackAuthority(db: PoolClient, execution: Execution, operationId: string, expectedRequest: unknown): Promise<void> {
  await assertHandoffFeedbackEpisode(db, execution, operationId, expectedRequest, true);
}

/** Must run under the root/task transaction before reserving this operation. */
export async function assertHandoffFeedbackAdmissionAuthority(db: PoolClient, execution: Execution, operationId: string, expectedRequest: unknown): Promise<HandoffFeedbackRequest> {
  return assertHandoffFeedbackEpisode(db, execution, operationId, expectedRequest, false);
}

async function assertHandoffFeedbackEpisode(db: PoolClient, execution: Execution, operationId: string, expectedRequest: unknown, reserved: boolean): Promise<HandoffFeedbackRequest> {
  const task = execution.task;
  const binding = task.channel_binding && channelBindingSchema.parse(task.channel_binding);
  if (!binding || task.parent_task_id || task.root_task_id !== task.id || task.product !== "agents" ||
      operationId !== `handoff-feedback:${task.id}` || !isCustomerPrincipal(task.principal) ||
      task.harness_release !== HANDOFF_HARNESS_RELEASE || !execution.configuration.tools.includes("support.request_handoff_v2")) {
    throw new PlatformError("HANDOFF_FEEDBACK_DENIED", 403, "Handoff feedback is unavailable");
  }
  assertPublishedTools(execution.configuration,execution.toolBindings);
  const request = parseHandoffFeedbackRequest(expectedRequest);
  const allowed = await db.query(`SELECT r.feedback_request_digest,r.evidence_manifest,c.session_id
    ${reserved ? ",op.request,op.request_digest" : ""} FROM agents_platform.pending_handoff_receipts r
    JOIN agents_platform.customer_conversations c ON c.id=r.conversation_id AND c.organization_id=$2
    JOIN agents_platform.customer_commands cmd ON cmd.conversation_id=c.id AND cmd.command_id=$1
    JOIN agents_platform.customer_task_links l ON l.task_id=$1 AND l.conversation_id=c.id
    JOIN agents_platform.customer_messages m ON m.id=l.input_message_id AND m.conversation_id=c.id
    JOIN agents_platform.execution_roots root ON root.root_task_id=$1 AND root.settled_at IS NULL
    ${reserved ? `JOIN agents_platform.operations op ON op.task_id=$1 AND op.id=$3
    JOIN agents_platform.model_cost_reservations cost ON cost.operation_id=op.id AND cost.task_id=$1
      AND cost.organization_id=$2 AND cost.root_task_id=$1 AND cost.state='reserved'
    JOIN agents_platform.capacity_requests cap ON cap.id=op.id AND cap.task_id=$1 AND cap.state='active'` : ""}
    WHERE r.task_id=$1 AND $3::text=$3::text AND r.conversation_id=$4 AND r.outcome IS NULL AND r.deadline>clock_timestamp()
      AND c.state='handoff_pending' AND c.ownership_generation=r.ownership_generation
      AND c.agent_id=$5 AND l.input_message_id=$6 AND l.ownership_generation=$7::bigint
      AND (($8::text='visitor' AND c.channel_kind='website' AND c.deployment_id=$9::uuid)
        OR ($8::text='channel_customer' AND c.channel_kind<>'website' AND c.channel_deployment_id=$9::uuid AND c.id=$10::uuid))
      AND l.ownership_generation+1=r.ownership_generation AND m.author_kind='visitor'
      AND m.ownership_generation=l.ownership_generation AND m.sequence>c.return_watermark
      AND cmd.action='request_handoff' AND cmd.result->>'pendingReceiptTaskId'=$1::text
      AND cmd.result->>'ownership_generation'=r.ownership_generation::text
      ${reserved ? "AND op.kind='model' AND op.name='model.handoff_feedback' AND op.state='started' AND op.reserved_tokens>0 AND op.reserved_ms>0" : ""}
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_cancellations x WHERE x.task_id=$1 AND x.completed_at IS NULL)
      AND ((c.channel_kind='website' AND EXISTS (SELECT 1 FROM agents_platform.website_deployments d
        WHERE d.id=c.deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id AND d.revoked_at IS NULL AND NOT d.paused))
        OR (c.channel_kind<>'website' AND EXISTS (SELECT 1 FROM agents_platform.channel_deployments d
          JOIN agents_platform.channel_connections conn ON conn.id=d.connection_id AND conn.organization_id=d.organization_id
          WHERE d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.agent_id=c.agent_id
            AND d.state='active' AND conn.state='active'))) FOR UPDATE OF c,r`,
  [task.id,task.organization_id,operationId,binding.customerConversationId,execution.agentId,binding.inputMessageId,binding.ownershipGeneration,
    task.principal.kind,task.principal.deploymentId,task.principal.kind === "visitor" ? task.principal.sessionId : task.principal.participantId]);
  if (!allowed.rowCount || allowed.rows[0].feedback_request_digest !== requestDigest(request) ||
      requestDigest(allowed.rows[0].evidence_manifest) !== requestDigest(request.evidenceManifest) ||
      reserved && (allowed.rows[0].request_digest !== requestDigest(allowed.rows[0].request) ||
        allowed.rows[0].request_digest !== requestDigest(request))) {
    throw new PlatformError("HANDOFF_FEEDBACK_DENIED", 403, "Handoff feedback is unavailable");
  }
  if (task.principal.kind === "visitor" && allowed.rows[0].session_id !== task.principal.sessionId &&
      !(await channelPorts(db).visitorLineage?.(db,{ organizationId:task.organization_id,agentId:execution.agentId,
        executionConversationId:task.conversation_id,customerConversationId:binding.customerConversationId,current:task.principal,
        origin:{deploymentId:task.principal.deploymentId,sessionId:allowed.rows[0].session_id} }))) {
    throw new PlatformError("HANDOFF_FEEDBACK_DENIED", 403, "Handoff feedback is unavailable");
  }
  await assertBaseAuthorityForPurpose(db, execution, true);
  return request;
}
