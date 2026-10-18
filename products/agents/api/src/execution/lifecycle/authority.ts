import type { Pool,PoolClient } from "pg";
import {
assertGrantAuthority,
executionGrantSchema,
PlatformError,
terminalTaskStates
} from "../../contracts/contracts";

import { assertAutomationAuthority } from "./automation-authority";
export { transaction } from "../../infrastructure/database";

import type { Execution } from "../../contracts/execution";
import { loadExecution } from "./state";
import { assertEvaluationTrial } from "../admission/trial-authority";
import { channelBindingSchema } from "../../contracts/channel";
import { channelPorts } from "../../infrastructure/channel-ports";
export async function assertBaseAuthority(db: Pool | PoolClient, execution: Execution): Promise<void> {
  const { task, configuration, agentId } = execution;
  if (terminalTaskStates.has(task.state)) throw new PlatformError("TASK_SETTLED", 409, "Task has settled");
  if (task.state === "cancel_requested") throw new PlatformError("TASK_CANCELLED", 409, "Task is stopping");
  if (new Date(task.deadline_at).getTime() <= Date.now()) throw new PlatformError("TASK_DEADLINE", 409, "Task deadline reached");
  if (task.channel_binding) {
    const root = task.parent_task_id ? await loadExecution(db, task.root_task_id) : execution;
    await channelPorts(db).assertBinding(db, channelBindingSchema.parse(task.channel_binding), root.task);
  }
  if (task.parent_task_id) {
    const root = await loadExecution(db, task.root_task_id);
    if (root.task.parent_task_id || root.task.organization_id !== task.organization_id || !["human","automation"].includes(root.task.principal.kind) || task.depth !== 1) throw new PlatformError("DELEGATION_SCOPE_DENIED",403,"Delegation is unavailable");
    await assertBaseAuthority(db, root);
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
  if (task.principal.kind === "human") {
    const allowed = await db.query(`SELECT 1 FROM agents_platform.memberships m JOIN agents_platform.accounts a ON a.id=m.account_id
      WHERE m.organization_id=$1 AND a.issuer=$2 AND a.subject=$3 AND m.revoked_at IS NULL FOR SHARE OF m`,
    [task.organization_id, task.principal.issuer, task.principal.subject]);
    if (!allowed.rowCount) throw new PlatformError("MEMBERSHIP_INACTIVE", 403, "Workspace access is unavailable");
  } else if (task.principal.kind === "visitor") {
    const allowed = await db.query(`SELECT 1 FROM agents_platform.website_deployments d JOIN agents_platform.website_sessions s ON s.deployment_id=d.id
      WHERE d.organization_id=$1 AND d.id=$2 AND d.version_id=$3 AND d.agent_id=$4 AND d.revoked_at IS NULL
      AND s.id=$5 AND s.expires_at>now() FOR SHARE OF d`,
    [task.organization_id, task.principal.deploymentId, task.version_id, agentId, task.principal.sessionId]);
    if (!allowed.rowCount || configuration.memory.enabled || configuration.skillIds.length || configuration.connectedToolBindingIds.length || configuration.capabilities.delegation.enabled || configuration.capabilities.sandbox.enabled || configuration.capabilities.workflows.enabled || configuration.tools.some(t => t.startsWith("memory."))) {
      throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Website execution access is unavailable");
    }
  } else if(task.principal.kind==="automation")await assertAutomationAuthority(db,execution);
  else throw new PlatformError("AUTOMATION_UNAVAILABLE", 403, "Automation execution is unavailable");
}
