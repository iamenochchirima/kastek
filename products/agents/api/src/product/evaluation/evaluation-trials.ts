import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { effectiveCompositionSchema } from "../../contracts/programs";
import { transaction } from "../../infrastructure/database";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";

export const prepareTrialSchema = z.strictObject({
  trialId: z.string().min(1).max(128), agentId: z.uuid(), versionId: z.uuid(),
  expectedCompositionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  maxTokens: z.number().int().min(2048).max(32000), expiresAt: z.iso.datetime({ offset: true }),
});
interface TrialRow {
  id: string; trial_id: string; organization_id: string; account_id: string; agent_id: string; version_id: string;
  composition_digest: string; max_tokens: number; expires_at: Date; state: "active" | "revoked"; request_digest: string;
}
export function trialDto(row: TrialRow) {
  return { id: row.id, trialId: row.trial_id, organizationId: row.organization_id, agentId: row.agent_id,
    versionId: row.version_id, compositionDigest: row.composition_digest, maxTokens: row.max_tokens,
    expiresAt: row.expires_at.toISOString(), state: row.state };
}

export class EvaluationTrials {
  constructor(private readonly pool: Pool) {}
  private async membership(db: PoolClient, accountId: string, organizationId: string) {
    if (!(await db.query(`SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 AND organization_id=$2
      AND revoked_at IS NULL FOR SHARE`, [accountId, organizationId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
  }
  async prepare(accountId: string, organizationId: string, raw: unknown) {
    const input = prepareTrialSchema.parse(raw), digest = requestDigest(input);
    if (new Date(input.expiresAt).getTime() > Date.now() + 30 * 60_000 || new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new PlatformError("EVALUATION_DEADLINE_INVALID", 400, "Use a trial deadline within thirty minutes");
    }
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      await this.membership(db, accountId, organizationId);
      const agent = (await db.query(`SELECT id FROM agents_platform.agents WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.agentId, organizationId])).rows[0];
      if (!agent) throw new PlatformError("NOT_FOUND", 404, "Agent not found");
      const existing = (await db.query<TrialRow>(`SELECT * FROM agents_platform.evaluation_trials WHERE organization_id=$1 AND account_id=$2 AND trial_id=$3`, [organizationId, accountId, input.trialId])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The trial identifier was used for another scope");
        return trialDto(existing);
      }
      const version = (await db.query(`SELECT effective_composition FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 AND id=$3 FOR SHARE`, [organizationId, input.agentId, input.versionId])).rows[0];
      const composition = effectiveCompositionSchema.safeParse(version?.effective_composition);
      if (!composition.success || composition.data.digest !== input.expectedCompositionDigest) throw new PlatformError("EVALUATION_COMPOSITION_MISMATCH", 409, "The prepared version does not match the evaluation composition");
      const used = await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE v.agent_id=$1
        UNION ALL SELECT 1 FROM agents_platform.memory_scopes WHERE agent_id=$1
        UNION ALL SELECT 1 FROM agents_platform.evaluation_trials WHERE agent_id=$1 LIMIT 1`, [input.agentId]);
      if (used.rowCount) throw new PlatformError("EVALUATION_SCOPE_NOT_FRESH", 409, "Prepare a dedicated unused agent for this trial");
      const row = (await db.query<TrialRow>(`INSERT INTO agents_platform.evaluation_trials
        (id,trial_id,organization_id,account_id,agent_id,version_id,composition_digest,max_tokens,expires_at,request_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), input.trialId, organizationId, accountId,
        input.agentId, input.versionId, input.expectedCompositionDigest, input.maxTokens, input.expiresAt, digest])).rows[0]!;
      return trialDto(row);
    });
  }
  async get(accountId: string, organizationId: string, selector: { id: string } | { trialId: string }) {
    return transaction(this.pool, async db => {
      await this.membership(db, accountId, organizationId);
      const row = (await db.query<TrialRow>(`SELECT * FROM agents_platform.evaluation_trials
        WHERE organization_id=$1 AND account_id=$2 AND ${"id" in selector ? "id" : "trial_id"}=$3`,
      [organizationId, accountId, "id" in selector ? z.uuid().parse(selector.id) : z.string().min(1).max(128).parse(selector.trialId)])).rows[0];
      if (!row) return { trial: null, rootTaskIds: [] as string[] };
      const roots = (await db.query<{ id: string }>("SELECT id FROM agents_platform.tasks WHERE evaluation_trial_id=$1 AND parent_task_id IS NULL ORDER BY created_at,id", [row.id])).rows;
      return { trial: trialDto(row), rootTaskIds: roots.map(root => root.id) };
    });
  }
  async revoke(accountId: string, organizationId: string, id: string) {
    await transaction(this.pool, async db => {
      await this.membership(db, accountId, organizationId);
      const result = await db.query(`UPDATE agents_platform.evaluation_trials SET state='revoked',revoked_at=coalesce(revoked_at,now())
        WHERE id=$1 AND account_id=$2 AND organization_id=$3 RETURNING id`, [z.uuid().parse(id), accountId, organizationId]);
      if (!result.rowCount) throw new PlatformError("NOT_FOUND", 404, "Trial not found");
    });
    // The committed revocation fences new effects even if cancellation dispatch is interrupted.
    const result = await this.get(accountId, organizationId, { id });
    for (const root of result.rootTaskIds) await requestTreeCancellation(this.pool, root);
    return { ...result, cancellationRequested: true };
  }
}
