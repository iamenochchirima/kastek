import type { GrowthAgentSetupDto } from "@kasitek-labs/contracts";
export type { GrowthAgentSetupDto } from "@kasitek-labs/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CoreContext } from "../context.js";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";

export type GrowthAgentSetupState = "pending" | "running" | "ready" | "blocked" | "failed" | "cancelled";
export interface GrowthAgentSetupJob {
  orgId: string; requestId: string; defaultsRevision: string; modelProfileId: string; modelProfileRevision: string;
  status: GrowthAgentSetupState; attempts: number; generation: number; leaseOwner: string | null;
  failureCode: string | null; createdAt: Date; updatedAt: Date;
}
const profile = (config: CoreConfig) => ({
  id: config.env.GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID ?? "growth-default",
  revision: config.env.GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION ?? "1",
});
export async function enqueueGrowthAgentSetup(tx: Pool | PoolClient, tenantId: string, config: CoreConfig): Promise<void> {
  const target = profile(config);
  await tx.query(`INSERT INTO "GrowthAgentSetup" ("orgId","requestId","modelProfileId","modelProfileRevision","defaultsRevision")
    SELECT id,$2,$3,$4,'4' FROM "Organization" WHERE id=$1 ON CONFLICT ("orgId") DO NOTHING`,
  [tenantId, randomUUID(), target.id, target.revision]);
}
export async function readGrowthAgentSetup(pool: Pool, tenantId: string): Promise<GrowthAgentSetupDto | null> {
  const row = (await pool.query<GrowthAgentSetupJob>('SELECT status,"failureCode","updatedAt" FROM "GrowthAgentSetup" WHERE "orgId"=$1', [tenantId])).rows[0];
  return row ? { state: row.status, code: row.failureCode, updatedAt: row.updatedAt.toISOString() } : null;
}
export async function ensureGrowthAgentSetup(core: CoreContext, tenantId: string): Promise<GrowthAgentSetupDto> {
  await enqueueGrowthAgentSetup(core.pool, tenantId, core.config);
  const result = await readGrowthAgentSetup(core.pool, tenantId);
  if (!result) throw new ApiError(404, "not_found", "Organisation not found");
  return result;
}
/** Operator retry retains the exact target and stable operation identity. Cancellation requires a separate lifecycle decision. */
export async function retryGrowthAgentSetup(core: CoreContext, tenantId: string): Promise<boolean> {
  return Boolean((await core.pool.query(`UPDATE "GrowthAgentSetup" SET status='pending', attempts=0,"nextAttemptAt"=NOW(),
    "failureCode"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,generation=generation+1,"updatedAt"=NOW()
    WHERE "orgId"=$1 AND status IN ('blocked','failed')`, [tenantId])).rowCount);
}
export async function backfillGrowthAgentSetup(core: CoreContext, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Backfill limit must be between 1 and 1000");
  const target = profile(core.config);
  return (await core.pool.query(`INSERT INTO "GrowthAgentSetup" ("orgId","requestId","modelProfileId","modelProfileRevision","defaultsRevision")
    SELECT o.id,gen_random_uuid()::text,$1,$2,'4' FROM "Organization" o
    WHERE NOT EXISTS (SELECT 1 FROM "GrowthAgentSetup" s WHERE s."orgId"=o.id)
    ORDER BY o.id LIMIT $3 ON CONFLICT ("orgId") DO NOTHING`, [target.id,target.revision,limit])).rowCount ?? 0;
}
export async function currentGrowthAgentSetup(core: CoreContext, target: {
  tenantId: string; requestId: string; defaultsRevision: string; modelProfileId: string; modelProfileRevision: string;
}): Promise<boolean> {
  return Boolean((await core.pool.query(`SELECT 1 FROM "GrowthAgentSetup" s JOIN "Organization" o ON o.id=s."orgId"
    WHERE s."orgId"=$1 AND s."requestId"=$2 AND s."defaultsRevision"=$3
      AND s."modelProfileId"=$4 AND s."modelProfileRevision"=$5 AND s.status IN ('pending','running','ready')`,
  [target.tenantId,target.requestId,target.defaultsRevision,target.modelProfileId,target.modelProfileRevision])).rowCount);
}
export interface GrowthAgentSetupMetrics {
  state: GrowthAgentSetupState; count: number; maximumAttempts: number;
  oldestPendingAgeSeconds: number | null; averageSetupDurationSeconds: number | null;
}
export async function readGrowthAgentSetupMetrics(pool: Pool): Promise<GrowthAgentSetupMetrics[]> {
  const result=await pool.query<{state:GrowthAgentSetupState;count:number;maximumAttempts:number;oldestPendingAgeSeconds:number|null;averageSetupDurationSeconds:number|null}>(`
    SELECT status AS state,count(*)::int AS count,max(attempts)::int AS "maximumAttempts",
      CASE WHEN status IN ('pending','running') THEN greatest(0,EXTRACT(EPOCH FROM NOW()-min("createdAt")))::double precision ELSE NULL END AS "oldestPendingAgeSeconds",
      avg(EXTRACT(EPOCH FROM "completedAt"-"createdAt"))::double precision AS "averageSetupDurationSeconds"
    FROM "GrowthAgentSetup" GROUP BY status ORDER BY status`);
  return result.rows;
}

/** An explicit operator action updates future defaults without changing the managed model target. */
export async function upgradeGrowthAgentDefaults(core:CoreContext,tenantId:string):Promise<boolean> {
  return Boolean((await core.pool.query(`UPDATE "GrowthAgentSetup" SET "defaultsRevision"='4',"requestId"=$2,
    status='pending',attempts=0,"nextAttemptAt"=NOW(),"failureCode"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,
    generation=generation+1,"updatedAt"=NOW() WHERE "orgId"=$1 AND status<>'cancelled'`,[tenantId,randomUUID()])).rowCount);
}
