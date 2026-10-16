import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import {
  recordPaystackEvent,
  retryFailedPaystackEvents,
  type BillingProvider,
} from "../src/services/billing.js";
const database = process.env.CORE_BILLING_RECOVERY_TEST_DATABASE_URL;
const rewards = {
  referrer_credits: 1000,
  referee_credits: 500,
  reward_expiry_days: 365,
  attribution_window_days: 90,
};
const noProvider = async (): Promise<never> => {
  throw new Error("Unexpected provider effect");
};
const provider: BillingProvider = {
  name: "paystack",
  initializeCheckout: noProvider,
  verifyTransaction: noProvider,
  verifySubscription: noProvider,
  setSubscriptionEnabled: noProvider,
  verifyWebhook: () => false,
  parseWebhook: () => ({ kind: "ignored" }),
};
test(
  "Paystack competing callback claims and ten-minute stale retry recover one persisted event",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await isolatedDatabase(database!, "paystack_recovery", [
      "PaystackWebhookEvent",
    ]);
    try {
      const payload = { event: "fixture.ignored", data: { id: "fixture" } };
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          recordPaystackEvent(db.pool, "fixture-event", payload),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(
        await retryFailedPaystackEvents(db.pool, provider, 100, rewards),
        0,
        "fresh processing event is not reclaimed",
      );
      await db.pool.query(
        'UPDATE "PaystackWebhookEvent" SET "processedAt"=NOW()-INTERVAL \'9 minutes\'',
      );
      assert.equal(
        await retryFailedPaystackEvents(db.pool, provider, 100, rewards),
        0,
      );
      await db.pool.query(
        'UPDATE "PaystackWebhookEvent" SET "processedAt"=NOW()-INTERVAL \'11 minutes\'',
      );
      const recovered = await Promise.all(
        Array.from({ length: 8 }, () =>
          retryFailedPaystackEvents(db.pool, provider, 100, rewards),
        ),
      );
      assert.equal(
        recovered.reduce((sum, value) => sum + value, 0),
        1,
      );
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT status,"errorMessage","processedAt" IS NOT NULL AS finished FROM "PaystackWebhookEvent"',
          )
        ).rows,
        [{ status: "IGNORED", errorMessage: null, finished: true }],
      );
      assert.equal(
        await recordPaystackEvent(db.pool, "fixture-event", payload),
        false,
        "terminal event cannot be claimed again",
      );
      assert.equal(
        (await db.pool.query('SELECT COUNT(*) FROM "PaystackWebhookEvent"'))
          .rows[0].count,
        "1",
      );
    } finally {
      await db.close();
    }
  },
);
test(
  "Paystack failed retry persists its error and can recover on a later poll without provider effects",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await isolatedDatabase(database!, "paystack_failed_retry", [
      "PaystackWebhookEvent",
    ]);
    try {
      await recordPaystackEvent(db.pool, "failed-event", {
        event: "fixture.ignored",
      });
      await db.pool.query(
        "UPDATE \"PaystackWebhookEvent\" SET status='FAILED',\"errorMessage\"='old failure'",
      );
      assert.equal(
        await retryFailedPaystackEvents(
          db.pool,
          {
            ...provider,
            parseWebhook: () => {
              throw new Error("Fixture parse failure");
            },
          },
          100,
          rewards,
        ),
        1,
      );
      const failed = (
        await db.pool.query(
          'SELECT status,"errorMessage" FROM "PaystackWebhookEvent"',
        )
      ).rows[0];
      assert.equal(failed.status, "FAILED");
      assert.match(failed.errorMessage, /Fixture parse failure/);
      assert.equal(
        await retryFailedPaystackEvents(db.pool, provider, 100, rewards),
        1,
      );
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT status,"errorMessage" FROM "PaystackWebhookEvent"',
          )
        ).rows[0],
        { status: "IGNORED", errorMessage: null },
      );
    } finally {
      await db.close();
    }
  },
);
