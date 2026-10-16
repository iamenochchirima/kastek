import type { Pool } from "pg";
import { AgentRepository } from "../db/repositories/agent-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { operationalLogger } from "../telemetry/logger";

interface ReadyAgentDeletion {
  organization_id: string;
  requested_by: string;
  agent_id: string;
  deletion_job_id: string;
}

/**
 * Finalizes agent resource deletion only after the parent memory job is
 * complete and every provider child is acknowledged. The memory worker calls
 * this opportunistically; selecting by the durable parent job keeps the
 * operation recoverable across process restarts.
 */
export async function finalizeReadyAgentDeletions(pool: Pool, limit = 20): Promise<number> {
  const candidates = await runWithRequiredDatabaseContext(
    "agent-deletion-finalizer-scan",
    { organizationId: "platform", actorId: "system:agent-deletion", operator: true },
    async () => {
      const result = await pool.query<ReadyAgentDeletion>(
        `SELECT DISTINCT ON (job.organization_id, job.target_id)
           job.organization_id,
           job.requested_by,
           job.target_id AS agent_id,
           job.id::text AS deletion_job_id
         FROM memory_deletion_jobs job
         JOIN agent_definitions agent
           ON agent.organization_id = job.organization_id
          AND agent.id::text = job.target_id
         WHERE job.target_type = 'agent'
           AND job.status = 'completed'
           AND agent.status = 'archived'
           AND NOT EXISTS (
             SELECT 1
             FROM agent_memory_provider_deletion_jobs provider_job
             JOIN agent_installations installation ON installation.id = provider_job.installation_id
             WHERE provider_job.organization_id = job.organization_id
               AND installation.agent_definition_id::text = job.target_id
               AND provider_job.status <> 'completed'
           )
         ORDER BY job.organization_id, job.target_id, job.completed_at DESC NULLS LAST
         LIMIT $1`,
        [Math.max(1, Math.min(Math.trunc(limit), 100))],
      );
      return result.rows;
    },
  );

  let finalized = 0;
  for (const candidate of candidates) {
    try {
      const result = await runWithRequiredDatabaseContext(
        "agent-deletion-finalizer",
        { organizationId: candidate.organization_id, actorId: candidate.requested_by },
        () => new AgentRepository(pool).finalizeAgentDeletion(candidate.organization_id, candidate.requested_by, candidate.agent_id),
      );
      if (result.deleted) {
        finalized += 1;
        operationalLogger.info({
          event: "agent.deletion.completed",
          organization_id: candidate.organization_id,
          agent_id: candidate.agent_id,
          deletion_job_id: candidate.deletion_job_id,
        }, "Agent deletion completed after memory provider confirmation");
      }
    } catch (error) {
      const errorCode = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code.slice(0, 120)
        : "AGENT_DELETION_FINALIZATION_FAILED";
      // A concurrent finalizer may have completed the same durable request
      // after the scan. Treat the already-removed definition as idempotent
      // success instead of emitting a false operational failure.
      if (errorCode === "AGENT_NOT_FOUND") continue;
      operationalLogger.warn({
        event: "agent.deletion.finalization.failed",
        organization_id: candidate.organization_id,
        agent_id: candidate.agent_id,
        deletion_job_id: candidate.deletion_job_id,
        error_code: errorCode,
      }, "Agent deletion finalization will retry from the durable memory job");
    }
  }
  return finalized;
}
