import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import {
  grantSystemCredits,
  revokeUnspentSystemGrant,
  reserveCredits,
  captureCredits,
} from "../src-ts/services/credits.js";
import {
  ensureReferralCode,
  attributeReferral,
  qualifyReferral,
  reverseReferral,
} from "../src-ts/services/referrals.js";

const database = process.env.CORE_CREDITS_REFERRALS_TEST_DATABASE_URL;
const rewards = {
  referrer_credits: 1000n,
  referee_credits: 500n,
  reward_expiry_days: 365,
  attribution_window_days: 90,
};
async function fixture() {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "credit_referral_race", [
    "User",
    "Organization",
    "CreditAccount",
    "CreditGrant",
    "CreditLedgerEntry",
    "CreditReservation",
    "CreditUsageEvent",
    "CreditAdminOperation",
    "ReferralCode",
    "ReferralAttribution",
  ]);
  try {
    await db.pool
      .query(`INSERT INTO "User"(id,name,email,"createdAt","updatedAt")
      VALUES('owner','Owner','owner@example.test',NOW(),NOW()),
      ('friend','Friend','friend@example.test',NOW(),NOW());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt")
      VALUES('referee','Referee','referee','owner',NOW(),NOW()),
      ('referrer','Referrer','referrer','friend',NOW(),NOW())`);
    const path = (await db.pool.query("SHOW search_path")).rows[0].search_path;
    assert.match(path, /^credit_referral_race_[a-f0-9]+$/);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function balance(pool: Pool, org: string) {
  const row = (
    await pool.query(
      'SELECT balance,"reservedBalance" FROM "CreditAccount" WHERE "orgId"=$1',
      [org],
    )
  ).rows[0];
  return [BigInt(row.balance), BigInt(row.reservedBalance)];
}
async function startReferral(pool: Pool) {
  const code = await ensureReferralCode(pool, "referrer");
  await attributeReferral(pool, "referee", code, rewards);
  return (await pool.query('SELECT id FROM "ReferralAttribution"')).rows[0]
    .id as string;
}

/** Real SQL continues on the original pool; only its award boundary is held to make the race deterministic. */
function awardGate(pool: Pool, expected: number) {
  const ready = Promise.withResolvers<void>();
  const waiting: (() => void)[] = [];
  const held = new Proxy(pool, {
    get(target, key) {
      if (key === "query")
        return async (text: string, values?: unknown[]) => {
          if (text.includes("SET status = 'AWARDED'")) {
            const released = Promise.withResolvers<void>();
            waiting.push(() => released.resolve());
            if (waiting.length === expected) ready.resolve();
            await released.promise;
          }
          return target.query(text, values);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    pool: held,
    ready: ready.promise,
    release: (index: number) => waiting[index]?.(),
    releaseAll: () => waiting.forEach((release) => release()),
  };
}

test(
  "concurrent system grants and revocations have one durable exact-i64 ledger effect",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await fixture(),
      amount = 9007199254740993n;
    try {
      const grants = await Promise.all(
        Array.from({ length: 6 }, () =>
          grantSystemCredits(
            db.pool,
            "referrer",
            amount,
            "TRIAL",
            null,
            "Fixture credit",
            null,
            null,
            "same-grant",
          ),
        ),
      );
      assert.equal(grants.filter((grant) => !grant.idempotent).length, 1);
      assert.equal(new Set(grants.map((grant) => grant.grantId)).size, 1);
      assert.deepEqual(await balance(db.pool, "referrer"), [amount, 0n]);
      await assert.rejects(
        grantSystemCredits(
          db.pool,
          "referee",
          amount,
          "TRIAL",
          null,
          "Fixture",
          null,
          null,
          "same-grant",
        ),
        /another organization/,
      );
      const revocations = await Promise.all(
        Array.from({ length: 6 }, () =>
          revokeUnspentSystemGrant(
            db.pool,
            "referrer",
            String(grants[0]!.grantId),
            "Fixture reversal",
            "same-revoke",
          ),
        ),
      );
      assert.equal(
        revocations.filter((revocation) => !revocation.idempotent).length,
        1,
      );
      assert(
        revocations.every(
          (revocation) =>
            BigInt(revocation.revokedAmount as number | bigint) === amount,
        ),
      );
      assert.deepEqual(await balance(db.pool, "referrer"), [0n, 0n]);
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT type,amount::text FROM "CreditLedgerEntry" ORDER BY type',
          )
        ).rows,
        [
          { type: "GRANT", amount: String(amount) },
          { type: "REVOKE", amount: String(-amount) },
        ],
      );
      assert.equal(
        (await db.pool.query('SELECT COUNT(*) FROM "CreditGrant"')).rows[0]
          .count,
        "1",
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "competing qualifiers award once; concurrent reversal preserves consumed and reserved credits",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await fixture(),
      gate = awardGate(db.pool, 2);
    let contenders: Promise<boolean>[] = [];
    try {
      const attributionId = await startReferral(db.pool);
      contenders = [
        qualifyReferral(gate.pool, "referee", "fixture-payment", rewards),
        qualifyReferral(gate.pool, "referee", "fixture-payment", rewards),
      ];
      await gate.ready;
      gate.release(0);
      assert.equal(await contenders[0], true);
      // The loser sees AWARDED, and must not compensate/revoke the winner's shared idempotent grants.
      gate.release(1);
      assert.equal(await contenders[1], true);
      assert.deepEqual(await balance(db.pool, "referrer"), [1000n, 0n]);
      assert.deepEqual(await balance(db.pool, "referee"), [500n, 0n]);
      assert.equal(
        (await db.pool.query('SELECT "redemptionCount" FROM "ReferralCode"'))
          .rows[0].redemptionCount,
        1,
      );
      assert.equal(
        (await db.pool.query('SELECT COUNT(*) FROM "CreditGrant"')).rows[0]
          .count,
        "2",
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT COUNT(*) FROM \"CreditLedgerEntry\" WHERE type='REVOKE'",
          )
        ).rows[0].count,
        "0",
      );
      const used = await reserveCredits(
        db.pool,
        "referrer",
        "fixture.action",
        300n,
        "fixture",
        "used",
        null,
        null,
        "reserve-used",
      );
      await captureCredits(
        db.pool,
        "referrer",
        String((used.reservation as { id: string }).id),
        300n,
        {},
        "capture-used",
      );
      const held = await reserveCredits(
        db.pool,
        "referrer",
        "fixture.action",
        100n,
        "fixture",
        "held",
        null,
        null,
        "reserve-held",
      );
      assert(
        (
          await Promise.all(
            Array.from({ length: 4 }, () =>
              reverseReferral(
                db.pool,
                "referee",
                "Fixture refund",
                "fixture-refund",
              ),
            ),
          )
        ).every(Boolean),
      );
      const attribution = (
        await db.pool.query(
          'SELECT status,metadata FROM "ReferralAttribution" WHERE id=$1',
          [attributionId],
        )
      ).rows[0];
      assert.equal(attribution.status, "REVERSED");
      assert.deepEqual(
        attribution.metadata.rewards.map(
          (reward: {
            side: string;
            revokedAmount: number;
            remainingAmount: number;
          }) => [reward.side, reward.revokedAmount, reward.remainingAmount],
        ),
        [
          ["referrer", 600, 100],
          ["referee", 500, 0],
        ],
      );
      assert.deepEqual(await balance(db.pool, "referrer"), [100n, 100n]);
      assert.deepEqual(await balance(db.pool, "referee"), [0n, 0n]);
      assert.equal(
        (
          await db.pool.query(
            "SELECT COUNT(*) FROM \"CreditLedgerEntry\" WHERE type='REVOKE'",
          )
        ).rows[0].count,
        "2",
      );
      assert.equal(
        await qualifyReferral(db.pool, "referee", "fixture-payment", rewards),
        false,
      );
      await captureCredits(
        db.pool,
        "referrer",
        String((held.reservation as { id: string }).id),
        100n,
        {},
        "capture-held",
      );
      assert.deepEqual(await balance(db.pool, "referrer"), [0n, 0n]);
      assert.equal(
        (
          await db.pool.query(
            'SELECT SUM(amount)::text AS sum FROM "CreditLedgerEntry" WHERE "orgId"=\'referrer\'',
          )
        ).rows[0].sum,
        "0",
      );
    } finally {
      gate.releaseAll();
      await Promise.allSettled(contenders);
      await db.close();
    }
  },
);

test(
  "reversal during qualification compensates both created grants without an award or redemption",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await fixture(),
      gate = awardGate(db.pool, 1);
    let qualifier: Promise<boolean> | undefined;
    try {
      await startReferral(db.pool);
      qualifier = qualifyReferral(
        gate.pool,
        "referee",
        "fixture-payment",
        rewards,
      );
      await gate.ready;
      assert.equal(
        (await db.pool.query('SELECT status FROM "ReferralAttribution"'))
          .rows[0].status,
        "QUALIFIED",
      );
      assert.deepEqual(await balance(db.pool, "referrer"), [1000n, 0n]);
      assert.deepEqual(await balance(db.pool, "referee"), [500n, 0n]);
      assert.equal(
        await reverseReferral(
          db.pool,
          "referee",
          "Fixture qualification cancelled",
          "fixture-refund",
        ),
        true,
      );
      gate.release(0);
      assert.equal(await qualifier, false);
      assert.deepEqual(await balance(db.pool, "referrer"), [0n, 0n]);
      assert.deepEqual(await balance(db.pool, "referee"), [0n, 0n]);
      const attribution = (
        await db.pool.query(
          'SELECT status,"awardedAt","referrerGrantId","refereeGrantId" FROM "ReferralAttribution"',
        )
      ).rows[0];
      assert.deepEqual(attribution, {
        status: "REVERSED",
        awardedAt: null,
        referrerGrantId: null,
        refereeGrantId: null,
      });
      assert.equal(
        (await db.pool.query('SELECT "redemptionCount" FROM "ReferralCode"'))
          .rows[0].redemptionCount,
        0,
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT COUNT(*) FROM \"CreditLedgerEntry\" WHERE type='REVOKE' AND \"idempotencyKey\" LIKE 'referral-reversal-race:%'",
          )
        ).rows[0].count,
        "2",
      );
      assert.equal(
        await reverseReferral(
          db.pool,
          "referee",
          "Repeat fixture refund",
          "repeat-refund",
        ),
        true,
      );
      assert.equal(
        (await db.pool.query('SELECT COUNT(*) FROM "CreditLedgerEntry"'))
          .rows[0].count,
        "4",
      );
    } finally {
      gate.releaseAll();
      if (qualifier) await Promise.allSettled([qualifier]);
      await db.close();
    }
  },
);
