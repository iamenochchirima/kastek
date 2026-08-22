import type { Pool } from "pg";
import {
  buildReadinessSnapshotEvent,
  enqueueOutbox,
  type AgentReadinessAnalyticsInput,
} from "../../analytics";
import { withTransaction } from "../pool";

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
}
