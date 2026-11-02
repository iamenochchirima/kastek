import type { PoolClient } from "pg";

/** Account-wide identity revocation ends delegated grants; ordinary browser-session logout does not. */
export async function revokeGrowthOAuthForUsers(db: PoolClient, users: readonly string[]): Promise<void> {
  if (!users.length) return;
  // A deployment that has not enabled the additive OAuth migration cannot have issued grants.
  if (!(await db.query(`SELECT to_regclass('"GrowthOAuthConnection"') IS NOT NULL AS present`)).rows[0]?.present) return;
  await db.query(`UPDATE "GrowthOAuthConnection" SET "revokedAt"=COALESCE("revokedAt",NOW()) WHERE "userId"=ANY($1::text[])`,[users]);
  await db.query(`UPDATE "GrowthOAuthCode" SET "usedAt"=COALESCE("usedAt",NOW()) WHERE "userId"=ANY($1::text[])`,[users]);
  await db.query(`UPDATE "GrowthOAuthRequest" SET "usedAt"=COALESCE("usedAt",NOW()) WHERE "userId"=ANY($1::text[])`,[users]);
}
