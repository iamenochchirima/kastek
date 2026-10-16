import type { Pool } from "pg";
import {
  buildReadinessSnapshotEvent,
  enqueueOutbox,
  type AgentReadinessAnalyticsInput,
} from "../../analytics";
import { withTransaction } from "../pool";

export interface ReadinessEvaluationCandidate {
  installationId: string;
  organizationId: string;
  actorId: string;
}

export class ReadinessRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Readiness is computed by the API projection, so this sidecar is best effort
   * and never participates in the response decision. Repeated reads of the
   * same state are coalesced; a changed state creates the next immutable fact.
   */
  public async recordSnapshot(input: AgentReadinessAnalyticsInput): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const streamKey = `organization:${input.organizationId}:readiness`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-readiness:${input.installationId}`]);
      const record = buildReadinessSnapshotEvent(input);
      const latest = await client.query<{ state_fingerprint: string | null }>(
        `SELECT envelope->'data'->>'state_fingerprint' AS state_fingerprint
         FROM analytics_outbox
         WHERE source_stream_key = $1
           AND contract_name = 'agent.readiness.snapshot@1'
           AND envelope->>'subject' = $2
         ORDER BY source_sequence DESC
         LIMIT 1`,
        [streamKey, `installation:${input.installationId}`],
      );
      if (latest.rows[0]?.state_fingerprint === record.envelope.data.state_fingerprint) return false;
      await enqueueOutbox(client, record);
      return true;
    });
  }

  public async claimDueEvaluations(input: {
    owner: string;
    limit: number;
    leaseDurationMs: number;
    organizationId?: string;
    now?: Date;
  }): Promise<ReadinessEvaluationCandidate[]> {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_readiness_evaluation_state (installation_id, organization_id)
         SELECT id, organization_id FROM agent_installations
         -- Keep the parent row stable through the insert. Without this lock a
         -- concurrent installation deletion can pass the SELECT and then
         -- violate the state table's foreign key before the statement commits.
         FOR KEY SHARE
         ON CONFLICT (installation_id) DO NOTHING`,
      );
      const result = await client.query<ReadinessEvaluationCandidate>(
        `WITH due AS (
           SELECT state.installation_id, state.organization_id
           FROM agent_readiness_evaluation_state state
           WHERE state.next_evaluation_at <= $1
             AND (state.lease_expires_at IS NULL OR state.lease_expires_at <= $1)
             AND ($5::text IS NULL OR state.organization_id = $5)
           ORDER BY state.next_evaluation_at ASC, state.installation_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE agent_readiness_evaluation_state state
         SET lease_owner = $3, lease_expires_at = $4, updated_at = now()
         FROM due
         JOIN agent_installations installation ON installation.id = due.installation_id
         WHERE state.installation_id = due.installation_id
         RETURNING state.installation_id AS "installationId",
                   state.organization_id AS "organizationId",
                   installation.created_by AS "actorId"`,
        [now, input.limit, input.owner, leaseExpiresAt, input.organizationId ?? null],
      );
      return result.rows;
    });
  }

  public async completeEvaluation(input: {
    installationId: string;
    owner: string;
    nextEvaluationAt: Date;
    evaluatedAt?: Date;
  }): Promise<boolean> {
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const result = await this.pool.query(
      `UPDATE agent_readiness_evaluation_state
       SET next_evaluation_at = $3,
           last_evaluated_at = $4,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE installation_id = $1 AND lease_owner = $2`,
      [input.installationId, input.owner, input.nextEvaluationAt, evaluatedAt],
    );
    return result.rowCount === 1;
  }

  public async releaseEvaluation(input: {
    installationId: string;
    owner: string;
    retryAt?: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_readiness_evaluation_state
       SET next_evaluation_at = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE installation_id = $1 AND lease_owner = $2`,
      [input.installationId, input.owner, input.retryAt ?? new Date()],
    );
    return result.rowCount === 1;
  }
}
