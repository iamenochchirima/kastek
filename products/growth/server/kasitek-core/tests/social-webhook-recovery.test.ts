import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { processTiktokWebhookEvents } from "../src/services/social/publishing.js";
const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test(
  "TikTok callback lease excludes fresh PROCESSING and reclaims a six-minute abandoned claim once",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await isolatedDatabase(database!, "tiktok_callback_recovery", [
      "SocialWebhookEvent",
    ]);
    try {
      await db.pool.query(
        `INSERT INTO "SocialWebhookEvent"(id,provider,"eventKey","eventType",payload,status,attempts,"nextAttemptAt","receivedAt","createdAt","updatedAt") VALUES('fixture','TIKTOK','fixture','fixture.ignored','{}','PROCESSING',1,NOW(),NOW(),NOW(),NOW()-INTERVAL '4 minutes')`,
      );
      assert.equal(await processTiktokWebhookEvents(db.pool, 1), 0);
      await db.pool.query(
        'UPDATE "SocialWebhookEvent" SET "updatedAt"=NOW()-INTERVAL \'6 minutes\'',
      );
      const recovered = await Promise.all(
        Array.from({ length: 6 }, () => processTiktokWebhookEvents(db.pool, 1)),
      );
      assert.equal(
        recovered.reduce((sum, n) => sum + n, 0),
        1,
      );
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT status,attempts,"processedAt" IS NOT NULL AS finished FROM "SocialWebhookEvent"',
          )
        ).rows[0],
        { status: "IGNORED", attempts: 2, finished: true },
      );
      assert.equal(await processTiktokWebhookEvents(db.pool, 1), 0);
    } finally {
      await db.close();
    }
  },
);
test(
  "TikTok source retry budget stops adding delay at eight but FAILED remains claimable beyond the intended budget",
  { skip: !database, timeout: 30000 },
  async () => {
    const db = await isolatedDatabase(database!, "tiktok_callback_budget", [
      "SocialWebhookEvent",
    ]);
    try {
      await db.pool.query(
        `INSERT INTO "SocialWebhookEvent"(id,provider,"eventKey","eventType",payload,status,attempts,"nextAttemptAt","receivedAt","createdAt","updatedAt") VALUES('bad','TIKTOK','bad','post.publish.complete','{}','RECEIVED',0,NOW(),NOW(),NOW(),NOW())`,
      );
      for (let attempt = 1; attempt <= 8; attempt++) {
        await db.pool.query(
          'UPDATE "SocialWebhookEvent" SET "nextAttemptAt"=NOW()-INTERVAL \'1 second\'',
        );
        assert.equal(await processTiktokWebhookEvents(db.pool, 1), 1);
        const row = (
          await db.pool.query(
            'SELECT status,attempts,"errorMessage","nextAttemptAt">NOW() AS delayed FROM "SocialWebhookEvent"',
          )
        ).rows[0];
        assert.equal(row.status, "FAILED");
        assert.equal(row.attempts, attempt);
        assert.match(row.errorMessage, /missing publish_id/);
        assert.equal(row.delayed, attempt < 8);
        if (attempt < 8)
          assert.equal(await processTiktokWebhookEvents(db.pool, 1), 0);
      }
      // This is an existing Rust/TS defect, not evidence of exhausted retry protection.
      assert.equal(await processTiktokWebhookEvents(db.pool, 1), 1);
      assert.equal(
        (await db.pool.query('SELECT attempts FROM "SocialWebhookEvent"'))
          .rows[0].attempts,
        9,
      );
    } finally {
      await db.close();
    }
  },
);
