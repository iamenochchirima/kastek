import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  coreProducerConfig,
  buildEvent,
  enqueueOutbox,
  claimOutboxBatch,
  applyDeliveryOutcome,
  releaseExpiredLeases,
  listOutboxReconciliationSummaries,
} from "../dist/analytics-producer.js";
test(
  "transactional outbox retains deduplication, conflict, lease ownership and retry state",
  { skip: !process.env.SHARED_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.SHARED_TEST_DATABASE_URL,
    });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "CREATE TEMP TABLE analytics_outbox (LIKE public.analytics_outbox INCLUDING ALL) ON COMMIT DROP",
      );
      const input = {
        record_id: "shared-fixture-1",
        source_domain: "campaigns",
        source_stream_key: "core:shared-fixture",
        contract_name: "campaign.recipient_sent@1",
        schema_version: 1,
        scope_kind: "core_organization",
        scope_external_id: "shared-fixture",
        subject_type: "recipient",
        subject_id: "fixture",
        occurred_at: "2026-10-02T00:00:00Z",
        attributes: { count: 1 },
      };
      await db.query("SAVEPOINT discarded");
      await enqueueOutbox(db, buildEvent(coreProducerConfig(), input));
      await db.query("ROLLBACK TO SAVEPOINT discarded");
      assert.equal(
        (await db.query("SELECT count(*) AS count FROM analytics_outbox"))
          .rows[0].count,
        "0",
      );
      const record = buildEvent(coreProducerConfig(), input);
      assert.equal((await enqueueOutbox(db, record)).kind, "inserted");
      assert.equal((await enqueueOutbox(db, record)).kind, "duplicate");
      assert.equal(
        (
          await enqueueOutbox(
            db,
            buildEvent(coreProducerConfig(), {
              ...input,
              attributes: { count: 2 },
            }),
          )
        ).kind,
        "conflict",
      );
      const now = new Date(Date.now() + 1000),
        claimed = await claimOutboxBatch(db, "publisher-a", 20, now, 1000);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].attempt_count, 1);
      assert.equal(
        (await claimOutboxBatch(db, "publisher-b", 20, now, 1000)).length,
        0,
      );
      await assert.rejects(
        () =>
          applyDeliveryOutcome(db, record.outbox_id, "publisher-b", {
            kind: "accepted",
          }),
        /not leased/,
      );
      assert.equal(
        await releaseExpiredLeases(db, new Date(now.getTime() + 2000), 20),
        1,
      );
      await claimOutboxBatch(
        db,
        "publisher-b",
        20,
        new Date(now.getTime() + 2000),
        1000,
      );
      await applyDeliveryOutcome(db, record.outbox_id, "publisher-b", {
        kind: "accepted",
      });
      const row = (await db.query("SELECT * FROM analytics_outbox")).rows[0];
      assert.equal(row.delivery_status, "delivered");
      assert.equal(row.lease_owner, null);
      assert.equal(row.attempt_count, 2);
      const summaries = await listOutboxReconciliationSummaries(
        db,
        "core",
        undefined,
        20,
      );
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].authoritative_count, "1");
      assert.equal(
        summaries[0].source_highest_outbox_sequence,
        summaries[0].source_highest_delivered_sequence,
      );
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool.end();
    }
  },
);
