import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { apiJson, canonicalJson } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";

const changed = () => new ApiError(409, "publishing_account_changed", "The publishing account changed. Review this post again.");
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(apiJson(value)))).digest("hex");

export async function lockReviewedSocialAccounts(tx: PoolClient, org: string, expected: Record<string, string> = {}): Promise<void> {
  for (const id of Object.keys(expected).sort()) {
    const row = (await tx.query('SELECT id,status::text,"updatedAt","agentReviewRevision"::text AS "agentReviewRevision" FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 FOR SHARE', [id, org])).rows[0];
    if (!row || digest(row) !== expected[id]) throw changed();
  }
}

/** Hold account identities stable through admission, without holding locks over provider I/O. */
export async function lockSocialPublicationAccounts(tx: PoolClient, org: string, postId: string): Promise<void> {
  await tx.query('SELECT c.id FROM "SocialChannelConnection" c WHERE c."orgId"=$1 AND c.id IN(SELECT "channelConnectionId" FROM "SocialPublishJob" WHERE "postId"=$2) ORDER BY c.id FOR SHARE', [org, postId]);
}

export async function stampSocialPublicationAccounts(tx: PoolClient, org: string, postId: string, jobIds?: string[]): Promise<void> {
  await lockSocialPublicationAccounts(tx, org, postId);
  await tx.query(`UPDATE "SocialPublishJob" j SET metadata=COALESCE(j.metadata,'{}'::jsonb)||jsonb_build_object('_kasitek_account',jsonb_build_object('connectionId',c.id,'externalAccountId',c."externalAccountId",'orgId',c."orgId",'userId',c."userId",'platform',c.platform::text,'status',c.status::text,'revision',to_char(c."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
    FROM "SocialChannelConnection" c WHERE j."postId"=$1 AND j."orgId"=$2 AND j.status='QUEUED' AND c.id=j."channelConnectionId" AND c."orgId"=$2 AND ($3::text[] IS NULL OR j.id=ANY($3::text[]))`, [postId, org, jobIds ?? null]);
}

/** Token maintenance may change updatedAt; execution remains bound to the reviewed account identity. */
export async function assertSocialPublicationAccount(pool: Pool, org: string, connectionId: string | null, platform: string, metadata: Record<string, unknown> | null): Promise<{ connectionId: string; externalAccountId: string | null; orgId: string; userId: string; platform: string } | null> {
  const raw = metadata?._kasitek_account;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw changed();
  const fence = raw as Record<string, unknown>;
  if (typeof fence.connectionId !== 'string' || fence.connectionId !== connectionId || fence.orgId !== org || typeof fence.userId !== 'string' || fence.platform !== platform || fence.status !== 'CONNECTED') throw changed();
  const row = (await pool.query(`SELECT "externalAccountId","userId",platform::text FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 AND status='CONNECTED'`, [connectionId, org])).rows[0];
  if (!row || row.externalAccountId !== fence.externalAccountId || row.userId !== fence.userId || row.platform !== fence.platform) throw changed();
  return { connectionId: fence.connectionId, externalAccountId: row.externalAccountId, orgId: org, userId: row.userId, platform: row.platform };
}
