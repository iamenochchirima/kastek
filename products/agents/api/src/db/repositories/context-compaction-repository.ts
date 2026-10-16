import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import type {
  DurableContextAdapter,
  DurableContextCompactionRevision,
  DurableContextDecisionRevision,
  DurableContextPersistenceInput,
  DurableContextPersistenceResult,
  DurableContextRecord,
} from "../../runtime/context-compaction";

interface ContextRevisionRow {
  organization_id: string;
  operation_id: string;
  context_id?: string;
  revision?: number;
  decision: DurableContextDecisionRevision;
  compaction: DurableContextCompactionRevision;
}

/** PostgreSQL adapter for immutable context decisions and compaction revisions. */
export class ContextCompactionRepository implements DurableContextAdapter {
  public constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {
    if (!organizationId.trim()) throw new Error("CONTEXT_ORGANIZATION_ID_REQUIRED");
  }

  async read(operationId: string): Promise<DurableContextRecord | undefined> {
    const result = await query<ContextRevisionRow>(
      this.pool,
      `SELECT organization_id, operation_id, decision, compaction
       FROM agent_context_compaction_revisions
       WHERE organization_id = $1 AND operation_id = $2`,
      [this.organizationId, operationId],
    );
    const row = result.rows[0];
    return row ? { decision: row.decision, compaction: row.compaction } : undefined;
  }

  async readLatest(contextId: string): Promise<number> {
    const result = await query<{ generation: string | number | null }>(
      this.pool,
      `SELECT COALESCE(MAX(COALESCE((decision->>'generation')::integer, revision)), 0) AS generation
       FROM agent_context_compaction_revisions
       WHERE organization_id = $1 AND context_id = $2`,
      [this.organizationId, contextId],
    );
    return Number(result.rows[0]?.generation ?? 0);
  }

  async persist(input: DurableContextPersistenceInput): Promise<DurableContextPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      // Serialize competing compactions for one organization/context pair so
      // the generation check below is a real compare-and-swap, not a racy
      // read followed by two successful inserts.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${this.organizationId}:${input.decision.contextId}`,
      ]);
      const existing = await client.query<ContextRevisionRow>(
        `SELECT organization_id, operation_id, decision, compaction
         FROM agent_context_compaction_revisions
         WHERE organization_id = $1 AND operation_id = $2
         FOR UPDATE`,
        [this.organizationId, input.decision.operationId],
      );
      if (existing.rows[0]) {
        const record = { decision: existing.rows[0].decision, compaction: existing.rows[0].compaction };
        if (record.decision.operationFingerprint !== input.decision.operationFingerprint
          || record.compaction.operationFingerprint !== input.compaction.operationFingerprint) {
          throw new Error("CONTEXT_COMPACTION_REVISION_CONFLICT");
        }
        return { status: "replayed", record };
      }
      const latest = await client.query<{ generation: string }>(
        `SELECT COALESCE(MAX(COALESCE((decision->>'generation')::integer, revision)), 0)::text AS generation
         FROM agent_context_compaction_revisions
         WHERE organization_id = $1 AND context_id = $2`,
        [this.organizationId, input.decision.contextId],
      );
      if (Number(latest.rows[0]?.generation ?? 0) !== input.decision.expectedGeneration) {
        throw new Error("CONTEXT_COMPACTION_FENCE_CONFLICT");
      }
      const inserted = await client.query<ContextRevisionRow>(
        `INSERT INTO agent_context_compaction_revisions
           (organization_id, operation_id, context_id, revision, source_digest, operation_fingerprint, decision, compaction)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (organization_id, operation_id) DO NOTHING
         RETURNING organization_id, operation_id, decision, compaction`,
        [
          this.organizationId,
          input.decision.operationId,
          input.decision.contextId,
          input.decision.revision,
          input.decision.sourceDigest,
          input.decision.operationFingerprint,
          JSON.stringify(input.decision),
          JSON.stringify(input.compaction),
        ],
      );
      const row = inserted.rows[0] ?? (await client.query<ContextRevisionRow>(
        `SELECT organization_id, operation_id, decision, compaction
         FROM agent_context_compaction_revisions
         WHERE organization_id = $1 AND operation_id = $2
         FOR UPDATE`,
        [this.organizationId, input.decision.operationId],
      )).rows[0];
      if (!row) throw new Error("CONTEXT_COMPACTION_REVISION_NOT_FOUND");
      const record = { decision: row.decision, compaction: row.compaction };
      if (record.decision.operationFingerprint !== input.decision.operationFingerprint
        || record.compaction.operationFingerprint !== input.compaction.operationFingerprint
        || record.decision.sourceDigest !== input.decision.sourceDigest
        || record.compaction.sourceDigest !== input.compaction.sourceDigest) {
        throw new Error("CONTEXT_COMPACTION_REVISION_CONFLICT");
      }
      return { status: inserted.rows[0] ? "created" : "replayed", record };
    });
  }
}
