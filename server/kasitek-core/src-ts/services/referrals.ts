import { createId } from "@paralleldrive/cuid2";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import {
  canonicalJson,
  integer,
  wireInteger,
} from "@kasitek/server-support/json";
import type { CoreConfig } from "../config.js";
import { grantSystemCredits, revokeUnspentSystemGrant } from "./credits.js";
import type { Units } from "./credits.js";
type Row = Record<string, unknown>;
const SQL = {
  ensure_referral_code: [
    'SELECT code FROM "ReferralCode" WHERE "orgId" = $1',
    '\n            INSERT INTO "ReferralCode" (id, "orgId", code, status, "createdAt", "updatedAt")\n            VALUES ($1, $2, $3, \'ACTIVE\', NOW(), NOW())\n            ON CONFLICT ("orgId") DO NOTHING\n            ',
    'SELECT code FROM "ReferralCode" WHERE "orgId" = $1',
  ],
  get_referral_code: [
    '\n        SELECT code, status,\n               "disabledAt" AT TIME ZONE \'UTC\' AS disabled_at,\n               "disabledReason" AS disabled_reason,\n               "redemptionCount" AS redemption_count,\n               "attributionCount" AS attributed_count,\n               "maxRedemptions" AS max_redemptions\n        FROM "ReferralCode" WHERE "orgId" = $1\n        ',
  ],
  expire_attributions: [
    '\n        WITH expired AS (\n            SELECT id\n            FROM "ReferralAttribution"\n            WHERE status = \'ATTRIBUTED\'\n              AND "attributionExpiresAt" IS NOT NULL\n              AND "attributionExpiresAt" <= NOW()\n            ORDER BY "attributionExpiresAt", id\n            FOR UPDATE SKIP LOCKED\n            LIMIT $1\n        )\n        UPDATE "ReferralAttribution" AS attribution\n        SET status = \'EXPIRED\',\n            metadata = COALESCE(attribution.metadata, \'{}\'::jsonb) ||\n                jsonb_build_object(\'expiredReason\', \'attribution_window_elapsed\'),\n            "updatedAt" = NOW()\n        FROM expired\n        WHERE attribution.id = expired.id\n        ',
  ],
  get_referral_summary: [
    "\n        SELECT\n          COUNT(*) FILTER (WHERE status = 'ATTRIBUTED'),\n          COUNT(*) FILTER (WHERE status = 'QUALIFIED'),\n          COUNT(*) FILTER (WHERE status = 'AWARDED'),\n          COUNT(*) FILTER (WHERE status = 'EXPIRED'),\n          COUNT(*) FILTER (WHERE status = 'REJECTED'),\n          COUNT(*) FILTER (WHERE status = 'REVERSED')\n        FROM \"ReferralAttribution\"\n        WHERE \"referrerOrgId\" = $1\n        ",
    '\n        SELECT attribution.id, attribution.status,\n               CONCAT(\'Workspace \', RIGHT(referee.id, 6)) AS referee_org_name,\n               attribution."attributedAt" AT TIME ZONE \'UTC\' AS attributed_at,\n               attribution."attributionExpiresAt" AT TIME ZONE \'UTC\' AS attribution_expires_at,\n               attribution."qualifiedAt" AT TIME ZONE \'UTC\' AS qualified_at,\n               attribution."awardedAt" AT TIME ZONE \'UTC\' AS awarded_at,\n               attribution."reversedAt" AT TIME ZONE \'UTC\' AS reversed_at\n        FROM "ReferralAttribution" attribution\n        JOIN "Organization" referee ON referee.id = attribution."refereeOrgId"\n        WHERE attribution."referrerOrgId" = $1\n        ORDER BY attribution."attributedAt" DESC\n        LIMIT 25\n        ',
  ],
  list_referral_attributions: [
    '\n        SELECT attribution.id, code.code, code.status AS code_status, attribution.status,\n               attribution."referrerOrgId" AS referrer_org_id,\n               referrer.name AS referrer_org_name,\n               attribution."refereeOrgId" AS referee_org_id,\n               referee.name AS referee_org_name,\n               attribution."attributedAt" AT TIME ZONE \'UTC\' AS attributed_at,\n               attribution."attributionExpiresAt" AT TIME ZONE \'UTC\' AS attribution_expires_at,\n               attribution."qualifiedAt" AT TIME ZONE \'UTC\' AS qualified_at,\n               attribution."awardedAt" AT TIME ZONE \'UTC\' AS awarded_at,\n               attribution."reversedAt" AT TIME ZONE \'UTC\' AS reversed_at,\n               attribution."qualificationReference" AS qualification_reference,\n               attribution."reversalReason" AS reversal_reason,\n               attribution."referrerGrantId" AS referrer_grant_id,\n               attribution."refereeGrantId" AS referee_grant_id,\n               attribution.metadata\n        FROM "ReferralAttribution" attribution\n        JOIN "ReferralCode" code ON code.id = attribution."codeId"\n        JOIN "Organization" referrer ON referrer.id = attribution."referrerOrgId"\n        JOIN "Organization" referee ON referee.id = attribution."refereeOrgId"\n        WHERE ($1::text IS NULL OR attribution."referrerOrgId" = $1 OR attribution."refereeOrgId" = $1)\n          AND ($2::text IS NULL OR attribution.status = $2)\n        ORDER BY attribution."attributedAt" DESC\n        LIMIT $3\n        ',
  ],
  set_referral_code_status: [
    '\n        UPDATE "ReferralCode"\n        SET status = $2,\n            "disabledAt" = CASE WHEN $2 = \'DISABLED\' THEN NOW() ELSE NULL END,\n            "disabledReason" = CASE WHEN $2 = \'DISABLED\' THEN $3 ELSE NULL END,\n            "updatedAt" = NOW()\n        WHERE "orgId" = $1\n        ',
  ],
  reject_referral_attribution: [
    "\n        UPDATE \"ReferralAttribution\"\n        SET status = 'REJECTED',\n            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(\n                'rejectedReason', $2::text,\n                'supportReference', $3::text\n            ),\n            \"updatedAt\" = NOW()\n        WHERE id = $1 AND status IN ('ATTRIBUTED', 'QUALIFIED')\n        ",
    'SELECT status FROM "ReferralAttribution" WHERE id = $1',
  ],
  reverse_referral_attribution: [
    'SELECT "refereeOrgId" FROM "ReferralAttribution" WHERE id = $1',
  ],
  attribute_referral: [
    '\n        SELECT code.id, code."orgId", code.status, code."maxRedemptions",\n               code."redemptionCount", owner."ownerId"\n        FROM "ReferralCode" code\n        JOIN "Organization" owner ON owner.id = code."orgId"\n        WHERE code.code = $1\n        FOR UPDATE\n        ',
    'SELECT "ownerId" FROM "Organization" WHERE id = $1',
    'SELECT "codeId", status FROM "ReferralAttribution" WHERE "refereeOrgId" = $1 FOR UPDATE',
    '\n        INSERT INTO "ReferralAttribution" (\n            id, "codeId", "referrerOrgId", "refereeOrgId", status,\n            "attributedAt", "attributionExpiresAt", "referrerRewardCredits",\n            "refereeRewardCredits", "rewardExpiryDays", "programVersion",\n            "createdAt", "updatedAt"\n        ) VALUES ($1, $2, $3, $4, \'ATTRIBUTED\', NOW(), $5, $6, $7, $8, $9, NOW(), NOW())\n        ',
    'UPDATE "ReferralCode" SET "attributionCount" = "attributionCount" + 1, "updatedAt" = NOW() WHERE id = $1',
  ],
  qualify_referral: [
    '\n        SELECT id, "codeId", "referrerOrgId", status,\n               COALESCE("qualificationReference", \'\'),\n               "attributionExpiresAt" AT TIME ZONE \'UTC\',\n               "referrerRewardCredits", "refereeRewardCredits", "rewardExpiryDays"\n        FROM "ReferralAttribution"\n        WHERE "refereeOrgId" = $1\n        FOR UPDATE\n        ',
    "UPDATE \"ReferralAttribution\" SET status = 'EXPIRED', metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('expiredReason', 'attribution_window_elapsed'), \"updatedAt\" = NOW() WHERE id = $1 AND status = 'ATTRIBUTED'",
    '\n        SELECT id\n        FROM "ReferralAttribution"\n        WHERE "qualificationReference" = $1 AND id <> $2\n        LIMIT 1\n        ',
    'SELECT "maxRedemptions", "redemptionCount" FROM "ReferralCode" WHERE id = $1 FOR UPDATE',
    "UPDATE \"ReferralAttribution\" SET status = 'REJECTED', metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('rejectedReason', 'qualified_referral_limit_reached'), \"updatedAt\" = NOW() WHERE id = $1 AND status = 'ATTRIBUTED'",
    '\n            UPDATE "ReferralAttribution"\n            SET status = \'QUALIFIED\', "qualifiedAt" = COALESCE("qualifiedAt", NOW()),\n                "qualificationReference" = $2, "updatedAt" = NOW()\n            WHERE id = $1 AND status = \'ATTRIBUTED\'\n            ',
    '\n        UPDATE "ReferralAttribution"\n        SET status = \'AWARDED\', "awardedAt" = COALESCE("awardedAt", NOW()),\n            "referrerGrantId" = $2, "refereeGrantId" = $3, "updatedAt" = NOW()\n        WHERE id = $1 AND status = \'QUALIFIED\'\n        ',
    'UPDATE "ReferralCode" SET "redemptionCount" = "redemptionCount" + 1, "updatedAt" = NOW() WHERE id = $1',
  ],
  reverse_referral: [
    '\n        SELECT id, status, "referrerOrgId", "referrerGrantId", "refereeGrantId"\n        FROM "ReferralAttribution"\n        WHERE "refereeOrgId" = $1\n        FOR UPDATE\n        ',
    '\n        UPDATE "ReferralAttribution"\n        SET status = \'REVERSED\', "reversedAt" = COALESCE("reversedAt", NOW()),\n            "reversalReason" = $2,\n            metadata = COALESCE(metadata, \'{}\'::jsonb) || jsonb_build_object(\n                \'reversalReference\', $3::text,\n                \'rewards\', $4::jsonb\n            ),\n            "updatedAt" = NOW()\n        WHERE id = $1 AND status = $5\n        ',
  ],
} as const;
const PROGRAM_VERSION = "credits-referral-v1";
export interface ReferralRewardConfig {
  referrer_credits: Units;
  referee_credits: Units;
  reward_expiry_days: number;
  attribution_window_days: number;
}
export function referralRewardConfig(config: CoreConfig): ReferralRewardConfig {
  const unsigned = (key: string, fallback: number): number => {
    const value = config.env[key]?.trim();
    if (!value || !/^\+?\d+$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed <= 4294967295 ? parsed : fallback;
  };
  return {
    referrer_credits: unsigned("KASITEK_REFERRAL_REFERRER_CREDITS", 1000),
    referee_credits: unsigned("KASITEK_REFERRAL_REFEREE_CREDITS", 500),
    reward_expiry_days: Math.max(
      1,
      Math.min(3650, unsigned("KASITEK_REFERRAL_REWARD_EXPIRY_DAYS", 365)),
    ),
    attribution_window_days: Math.max(
      1,
      Math.min(3650, unsigned("KASITEK_REFERRAL_ATTRIBUTION_WINDOW_DAYS", 90)),
    ),
  };
}
function fail(code: string, message: string, status: number): never {
  throw new ApiError(status, code, message);
}
export function requiredCode(raw: string): string {
  const code = raw.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
  if (!code || Buffer.byteLength(code) > 80)
    fail(
      "referral_code_invalid",
      "Referral code is required and must be at most 80 characters",
      400,
    );
  return code;
}
function validate(config: ReferralRewardConfig): void {
  if (
    integer(config.referrer_credits) < 0n ||
    integer(config.referee_credits) < 0n ||
    config.reward_expiry_days < 1 ||
    config.attribution_window_days < 1
  )
    fail(
      "referral_unavailable",
      "Referral reward configuration is invalid",
      500,
    );
}
export const shareUrl = (frontendUrl: string, code: string): string =>
  `${frontendUrl.replace(/\/+$/, "")}/signup?referralCode=${code}`;
async function row(
  db: Pool | PoolClient,
  statement: string,
  args: unknown[],
): Promise<Row | undefined> {
  return (await db.query(statement, args)).rows[0];
}
const camel = (r: Row): Row =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      v,
    ]),
  );
export async function ensureReferralCode(
  pool: Pool,
  orgId: string,
): Promise<string> {
  const current = await row(pool, SQL.ensure_referral_code[0], [orgId]);
  if (current) return String(current.code);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `KASI-${createId().slice(0, 10).toUpperCase()}`;
    const result = await pool.query(SQL.ensure_referral_code[1], [
      createId(),
      orgId,
      code,
    ]);
    if (result.rowCount === 1) return code;
    const existing = await row(pool, SQL.ensure_referral_code[2], [orgId]);
    if (existing) return String(existing.code);
  }
  return fail(
    "referral_code_unavailable",
    "Could not create a unique referral code",
    409,
  );
}
export async function getReferralCode(pool: Pool, orgId: string): Promise<Row> {
  await ensureReferralCode(pool, orgId);
  const result = await row(pool, SQL.get_referral_code[0], [orgId]);
  if (!result)
    fail("referral_code_unavailable", "Referral code not found", 404);
  return camel(result!);
}
export async function expireAttributions(
  pool: Pool,
  limit: number,
): Promise<number> {
  return (
    (
      await pool.query(SQL.expire_attributions[0], [
        Math.max(1, Math.min(1000, limit)),
      ])
    ).rowCount ?? 0
  );
}
export async function getReferralSummary(
  pool: Pool,
  orgId: string,
  config: ReferralRewardConfig,
  frontendUrl: string,
): Promise<Row> {
  validate(config);
  await expireAttributions(pool, 200);
  const code = await getReferralCode(pool, orgId);
  const fields = [
    "pendingCount",
    "qualifiedCount",
    "awardedCount",
    "expiredCount",
    "rejectedCount",
    "reversedCount",
  ];
  let index = 0;
  const query = SQL.get_referral_summary[0].replace(
    /COUNT\(\*\) FILTER \(WHERE status = '[A-Z]+'\)/g,
    (value) => `${value} AS "${fields[index++]}"`,
  );
  const counts = await row(pool, query, [orgId]);
  return {
    ...code,
    shareUrl: shareUrl(frontendUrl, String(code.code)),
    referrerRewardCredits: wireInteger(config.referrer_credits),
    refereeRewardCredits: wireInteger(config.referee_credits),
    rewardExpiryDays: config.reward_expiry_days,
    attributionWindowDays: config.attribution_window_days,
    ...Object.fromEntries(
      fields.map((field) => [field, wireInteger(counts![field] as Units)]),
    ),
    recent: (await pool.query(SQL.get_referral_summary[1], [orgId])).rows.map(
      camel,
    ),
  };
}
export async function listReferralAttributions(
  pool: Pool,
  orgId: string | null,
  status: string | null,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(SQL.list_referral_attributions[0], [
      orgId,
      status,
      Math.max(1, Math.min(200, limit)),
    ])
  ).rows.map(camel);
}
export async function setReferralCodeStatus(
  pool: Pool,
  orgId: string,
  status: string,
  reason: string,
): Promise<boolean> {
  status = status.trim().toUpperCase();
  reason = reason.trim();
  if (!["ACTIVE", "DISABLED"].includes(status) || !reason)
    fail(
      "referral_support_invalid",
      "A valid code status and support reason are required",
      400,
    );
  if (Buffer.byteLength(reason) > 2000)
    fail("referral_support_invalid", "Support reason is too long", 400);
  return (
    (await pool.query(SQL.set_referral_code_status[0], [orgId, status, reason]))
      .rowCount === 1
  );
}
export async function rejectReferralAttribution(
  pool: Pool,
  id: string,
  reason: string,
  reference: string,
): Promise<boolean> {
  reason = reason.trim();
  reference = reference.trim();
  if (!reason || !reference)
    fail(
      "referral_support_invalid",
      "A support reason and reference are required",
      400,
    );
  if (
    (
      await pool.query(SQL.reject_referral_attribution[0], [
        id,
        reason,
        reference,
      ])
    ).rowCount === 1
  )
    return true;
  const found = await row(pool, SQL.reject_referral_attribution[1], [id]);
  if (!found)
    fail("referral_unavailable", "Referral attribution not found", 404);
  if (found!.status === "REJECTED") return true;
  if (found!.status === "AWARDED")
    fail(
      "referral_support_requires_reversal",
      "Awarded referrals must use the reversal action",
      409,
    );
  return false;
}
export async function reverseReferralAttribution(
  pool: Pool,
  id: string,
  reason: string,
  reference: string,
): Promise<boolean> {
  const found = await row(pool, SQL.reverse_referral_attribution[0], [id]);
  if (!found)
    fail("referral_unavailable", "Referral attribution not found", 404);
  return reverseReferral(pool, String(found!.refereeOrgId), reason, reference);
}
export async function attributeReferral(
  pool: Pool,
  orgId: string,
  rawCode: string,
  config: ReferralRewardConfig,
): Promise<boolean> {
  validate(config);
  const code = requiredCode(rawCode);
  return transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `referral-attribution:${orgId}`,
    ]);
    const source = await row(tx, SQL.attribute_referral[0], [code]);
    if (!source)
      fail("referral_code_unavailable", "Referral code not found", 404);
    const referrer = String(source!.orgId);
    if (referrer === orgId)
      fail(
        "referral_self_referral",
        "An organisation cannot use its own referral code",
        400,
      );
    const owner = await row(tx, SQL.attribute_referral[1], [orgId]);
    if (!owner)
      fail("referral_unavailable", "Referee organisation not found", 404);
    if (source!.ownerId === owner!.ownerId)
      fail("referral_self_referral", "An account cannot refer itself", 400);
    if (source!.status !== "ACTIVE")
      fail("referral_code_disabled", "Referral code is not active", 409);
    const old = await row(tx, SQL.attribute_referral[2], [orgId]);
    if (old) {
      if (old.codeId === source!.id) return false;
      fail(
        "referral_attribution_duplicate",
        "This organisation already has a referral attribution",
        409,
      );
    }
    if (
      source!.maxRedemptions != null &&
      Number(source!.redemptionCount) >= Number(source!.maxRedemptions)
    )
      fail(
        "referral_limit_reached",
        "Referral code has reached its qualified referral limit",
        409,
      );
    await tx.query(SQL.attribute_referral[3], [
      createId(),
      source!.id,
      referrer,
      orgId,
      new Date(Date.now() + config.attribution_window_days * 86400000),
      config.referrer_credits,
      config.referee_credits,
      config.reward_expiry_days,
      PROGRAM_VERSION,
    ]);
    await tx.query(SQL.attribute_referral[4], [source!.id]);
    return true;
  });
}
export async function qualifyReferral(
  pool: Pool,
  orgId: string,
  qualificationReference: string,
  config: ReferralRewardConfig,
): Promise<boolean> {
  validate(config);
  qualificationReference = qualificationReference.trim();
  if (
    !qualificationReference ||
    Buffer.byteLength(qualificationReference) > 240
  )
    fail(
      "referral_qualification_invalid",
      "Referral qualification reference is required",
      400,
    );
  const prepared = await transaction(pool, async (tx) => {
    const attribution = await row(tx, SQL.qualify_referral[0], [orgId]);
    if (!attribution) return false;
    if (attribution.status === "AWARDED") return true;
    if (
      ["REJECTED", "EXPIRED", "REVERSED"].includes(String(attribution.status))
    )
      return false;
    if (
      attribution.status === "ATTRIBUTED" &&
      attribution.timezone != null &&
      new Date(attribution.timezone as Date).getTime() <= Date.now()
    ) {
      await tx.query(SQL.qualify_referral[1], [attribution.id]);
      return false;
    }
    const duplicate = await row(tx, SQL.qualify_referral[2], [
      qualificationReference,
      attribution.id,
    ]);
    if (duplicate)
      fail(
        "referral_qualification_duplicate",
        `Qualification reference already belongs to referral ${duplicate.id}`,
        409,
      );
    const limits = await row(tx, SQL.qualify_referral[3], [attribution.codeId]);
    if (!limits) fail("referral_unavailable", "Referral code not found", 404);
    if (
      attribution.status === "ATTRIBUTED" &&
      limits!.maxRedemptions != null &&
      Number(limits!.redemptionCount) >= Number(limits!.maxRedemptions)
    ) {
      await tx.query(SQL.qualify_referral[4], [attribution.id]);
      return false;
    }
    const reference = String(attribution.coalesce || qualificationReference);
    if (attribution.status === "ATTRIBUTED")
      await tx.query(SQL.qualify_referral[5], [attribution.id, reference]);
    return { attribution, reference };
  });
  if (typeof prepared === "boolean") return prepared;
  const { attribution, reference } = prepared;
  const id = String(attribution.id),
    referrerOrgId = String(attribution.referrerOrgId),
    referrer = integer(
      (attribution.referrerRewardCredits ?? config.referrer_credits) as Units,
    ),
    referee = integer(
      (attribution.refereeRewardCredits ?? config.referee_credits) as Units,
    ),
    days = Number(attribution.rewardExpiryDays ?? config.reward_expiry_days),
    endsAt = new Date(Date.now() + days * 86400000),
    metadata = {
      attributionId: id,
      qualificationReference: reference,
      programVersion: PROGRAM_VERSION,
      referrerCredits: referrer,
      refereeCredits: referee,
    };
  let referrerGrant: string | null = null,
    refereeGrant: string | null = null;
  if (referrer > 0n) {
    const result = await grantSystemCredits(
      pool,
      referrerOrgId,
      referrer,
      "REFERRAL",
      endsAt,
      "Successful referral reward",
      `referral:${id}:referrer`,
      metadata,
      `referral-referrer:${id}`,
    );
    if (!result.grantId)
      throw new ApiError(
        500,
        "internal_error",
        "Referral grant id was not recorded",
      );
    referrerGrant = String(result.grantId);
  }
  if (referee > 0n) {
    const result = await grantSystemCredits(
      pool,
      orgId,
      referee,
      "REFERRAL",
      endsAt,
      "Referral welcome reward",
      `referral:${id}:referee`,
      metadata,
      `referral-referee:${id}`,
    );
    if (!result.grantId)
      throw new ApiError(
        500,
        "internal_error",
        "Referral grant id was not recorded",
      );
    refereeGrant = String(result.grantId);
  }
  if (
    (
      await pool.query(SQL.qualify_referral[6], [
        id,
        referrerGrant,
        refereeGrant,
      ])
    ).rowCount === 1
  ) {
    await pool.query(SQL.qualify_referral[7], [attribution.codeId]);
    return true;
  }
  // A concurrent successful qualifier must not revoke the grant it just awarded.
  const current = await row(
    pool,
    'SELECT status FROM "ReferralAttribution" WHERE id=$1',
    [id],
  );
  if (current?.status === "AWARDED") return true;
  for (const [owner, grant, side] of [
    [referrerOrgId, referrerGrant, "referrer"],
    [orgId, refereeGrant, "referee"],
  ] as const)
    if (grant)
      await revokeUnspentSystemGrant(
        pool,
        owner,
        grant,
        "Referral qualification was invalidated before award completion",
        `referral-reversal-race:${id}:${side}`,
      );
  return false;
}
export async function reverseReferral(
  pool: Pool,
  orgId: string,
  reason: string,
  reference: string,
): Promise<boolean> {
  reason = reason.trim();
  reference = reference.trim();
  if (!reason || Buffer.byteLength(reason) > 2000)
    fail(
      "referral_reversal_invalid",
      "Referral reversal reason is required",
      400,
    );
  if (!reference || Buffer.byteLength(reference) > 240)
    fail(
      "referral_reversal_invalid",
      "Referral reversal reference is required",
      400,
    );
  return transaction(pool, async (tx) => {
    const attribution = await row(tx, SQL.reverse_referral[0], [orgId]);
    if (!attribution) return false;
    if (attribution.status === "REVERSED") return true;
    if (
      !["ATTRIBUTED", "QUALIFIED", "AWARDED"].includes(
        String(attribution.status),
      )
    )
      return false;
    const revoked: Row[] = [];
    if (attribution.status === "AWARDED")
      for (const [owner, grant, side] of [
        [
          String(attribution.referrerOrgId),
          attribution.referrerGrantId,
          "referrer",
        ],
        [orgId, attribution.refereeGrantId, "referee"],
      ] as const) {
        if (grant != null) {
          const result = await revokeUnspentSystemGrant(
            pool,
            owner,
            String(grant),
            reason,
            `referral-reversal:${attribution.id}:${side}`,
          );
          revoked.push({
            side,
            grantId: grant,
            revokedAmount: result.revokedAmount,
            remainingAmount: result.remainingAmount,
          });
        }
      }
    return (
      (
        await tx.query(SQL.reverse_referral[1], [
          attribution.id,
          reason,
          reference,
          canonicalJson(revoked),
          attribution.status,
        ])
      ).rowCount === 1
    );
  });
}
