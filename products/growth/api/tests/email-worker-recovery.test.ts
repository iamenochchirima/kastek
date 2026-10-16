import test from "node:test";
import assert from "node:assert/strict";
import { inboxFixture } from "./inbox-fixture.js";
import * as credentials from "../src/integrations/email.js";
import { syncConnection } from "../src/services/email/sync.js";

test(
  "email poll claim skips nine-minute active leases and recovers an eleven-minute claim once across competing workers",
  { skip: !process.env.CORE_INBOX_TEST_DATABASE_URL, timeout: 30000 },
  async () =>
    inboxFixture(async (pool, options) => {
      const mailbox = await credentials.upsertConnectionFromTokens(
        pool,
        options.config,
        "org",
        "user",
        "google",
        "fixture-user",
        "me@example.test",
        "Mailbox",
        "fixture-token",
        null,
        null,
        ["https://www.googleapis.com/auth/gmail.readonly"],
        "fixture",
      );
      let calls = 0;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const http: typeof fetch = async () => {
        calls++;
        entered.resolve();
        await release.promise;
        return new Response(JSON.stringify({ messages: [] }));
      };
      let syncing: Promise<number>[] = [];
      let completed = 0;
      const skipped = Promise.withResolvers<void>();
      try {
        await pool.query(
          'UPDATE "EmailInboxBinding" SET "inboundStatus"=\'SYNCING\',"updatedAt"=NOW()-INTERVAL \'9 minutes\'',
        );
        assert.equal(
          await syncConnection(pool, options.config, "org", mailbox.id, http),
          0,
        );
        assert.equal(calls, 0);
        await pool.query(
          'UPDATE "EmailInboxBinding" SET "updatedAt"=NOW()-INTERVAL \'11 minutes\'',
        );
        syncing = Array.from({ length: 6 }, () =>
          syncConnection(pool, options.config, "org", mailbox.id, http).then(
            (count) => {
              if (++completed === 5) skipped.resolve();
              return count;
            },
          ),
        );
        await entered.promise;
        await skipped.promise;
        assert.equal(
          await syncConnection(pool, options.config, "org", mailbox.id, http),
          0,
          "active reclaimed mailbox cannot be polled again",
        );
        assert.equal(calls, 1);
        release.resolve();
        await Promise.all(syncing);
        assert.equal(calls, 1);
        const state = (
          await pool.query(
            'SELECT "inboundStatus","lastError","lastSyncedAt" IS NOT NULL AS synced FROM "EmailInboxBinding"',
          )
        ).rows[0];
        assert.deepEqual(state, {
          inboundStatus: "READY",
          lastError: null,
          synced: true,
        });
        assert.equal(
          (await pool.query('SELECT COUNT(*) FROM "Message"')).rows[0].count,
          "0",
        );
      } finally {
        release.resolve();
        await Promise.allSettled(syncing);
      }
    }),
);
