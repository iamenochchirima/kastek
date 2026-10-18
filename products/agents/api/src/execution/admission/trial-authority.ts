import type { Pool, PoolClient } from "pg";
import { PlatformError, type AdmissionAuthority } from "../../contracts/contracts";

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
    : principal.kind==="visitor"&&Boolean((await db.query(`SELECT 1 FROM agents_platform.evaluation_trial_channels
        WHERE trial_id=$1 AND deployment_id=$2 AND session_id=$3`,[input.trialId,principal.deploymentId,principal.sessionId])).rowCount);
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
