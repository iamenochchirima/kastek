import type { Pool, PoolClient } from "pg";
import { acceptedModelRoutesSchema, type AcceptedModelRoutes } from "../../contracts/model-bindings";
import { PlatformError, requestDigest, type AdmissionAuthority, type ExecutionGrant } from "../../contracts/contracts";

/** The trial is another authority ceiling. It never replaces the normal execution grant. */
export async function assertEvaluationTrial(db: Pool | PoolClient, input: {
  trialId?: string | null; authority: AdmissionAuthority; agentId: string; versionId: string;
  rootTokenLimit?: number; conversationId?: string;
}): Promise<void> {
  const reserved = (await db.query("SELECT id FROM agents_platform.evaluation_trials WHERE agent_id=$1", [input.agentId])).rows[0];
  if (!input.trialId) {
    if (reserved) throw new PlatformError("EVALUATION_SCOPE_REQUIRED", 403, "The agent is reserved for an evaluation trial");
    return;
  }
  const trial = (await db.query(`SELECT e.*, a.issuer, a.subject FROM agents_platform.evaluation_trials e
    JOIN agents_platform.accounts a ON a.id=e.account_id
    JOIN agents_platform.memberships m ON m.account_id=e.account_id AND m.organization_id=e.organization_id AND m.revoked_at IS NULL
    WHERE e.id=$1 AND e.organization_id=$2 FOR SHARE OF e,m`, [input.trialId, input.authority.organizationId])).rows[0];
  const principal=input.authority.principal;
  const actorMatches=principal.kind==="human" ? principal.issuer===trial?.issuer&&principal.subject===trial?.subject
    : principal.kind==="visitor"?Boolean((await db.query(`SELECT 1 FROM agents_platform.evaluation_trial_channels
        WHERE trial_id=$1 AND deployment_id=$2 AND session_id=$3`,[input.trialId,principal.deploymentId,principal.sessionId])).rowCount)
    : principal.kind==="channel_customer"&&Boolean((await db.query(`SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e
        JOIN agents_platform.customer_conversations c ON c.channel_deployment_id=e.deployment_id AND c.organization_id=e.organization_id
        WHERE e.trial_id=$1 AND e.deployment_id=$2 AND c.id=$3`,[input.trialId,principal.deploymentId,principal.participantId])).rowCount);
  if (!trial || trial.state !== "active" || new Date(trial.expires_at).getTime() <= Date.now() ||
      trial.version_id !== input.versionId || trial.agent_id !== input.agentId ||
      input.authority.product !== "agents" || !actorMatches ||
      (input.rootTokenLimit !== undefined && input.rootTokenLimit > trial.max_tokens)) {
    throw new PlatformError("EVALUATION_TRIAL_INACTIVE", 403, "The evaluation trial does not authorize this operation");
  }
  if (input.conversationId && !(await db.query(`SELECT 1 FROM agents_platform.tasks
    WHERE evaluation_trial_id=$1 AND conversation_id=$2`, [input.trialId, input.conversationId])).rowCount) {
    throw new PlatformError("EVALUATION_SCOPE_DENIED", 403, "Evaluation history must belong to this trial");
  }
}

/** Trial preparation freezes model metadata and policy. Dispatch still checks current credentials. */
export async function trialModelRoutes(db: PoolClient, trialId: string, organizationId: string, grant: ExecutionGrant): Promise<AcceptedModelRoutes> {
  const row = (await db.query("SELECT model_routes,model_routes_digest,root_token_limit FROM agents_platform.evaluation_trials WHERE id=$1 AND organization_id=$2 FOR SHARE", [trialId, organizationId])).rows[0];
  const parsed = acceptedModelRoutesSchema.safeParse(row?.model_routes);
  if (!parsed.success || requestDigest(parsed.data) !== row.model_routes_digest || row.root_token_limit !== grant.rootTokenLimit) {
    throw new PlatformError("EVALUATION_MODEL_MISMATCH", 409, "The trial model scope does not match this request");
  }
  for (const route of Object.values(parsed.data)) {
    const binding = route.binding;
    if (binding.organizationId !== organizationId || requestDigest(route.definition) !== binding.providerDefinitionDigest ||
        route.policy.maxRootTokens > grant.rootTokenLimit || route.policy.maxInputBytes > grant.maxInputBytes ||
        route.policy.maxInputTokens > grant.maxContextTokens || route.policy.maxOutputTokens > grant.maxOutputTokens) {
      throw new PlatformError("EVALUATION_MODEL_MISMATCH", 403, "The execution grant does not authorize the pinned model policy");
    }
    const current = await db.query(`SELECT 1 FROM agents_platform.model_provider_connections c
      JOIN agents_platform.model_provider_use_grants g ON g.organization_id=c.organization_id AND g.connection_id=c.id
      WHERE c.id=$1 AND c.organization_id=$2 AND c.state='active' AND c.revision=$3 AND c.credential_revision=$4
        AND g.id=$5 AND g.revision=$6 AND g.state='active' AND g.consumer=$7::jsonb AND g.model_ids ? $8 AND g.roles ? $9 FOR SHARE OF c,g`,
    [binding.connectionId, organizationId, binding.connectionRevision, binding.credentialRevision, binding.useGrantId, binding.useGrantRevision,
      JSON.stringify(route.consumer), binding.modelId, binding.role]);
    if (!current.rowCount) throw new PlatformError("MODEL_CONNECTION_CHANGED", 409, "The trial model authorization changed; prepare a new scope");
  }
  return parsed.data;
}
