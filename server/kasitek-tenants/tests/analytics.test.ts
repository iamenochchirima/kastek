import test from "node:test";
import assert from "node:assert/strict";
import { analyticsFixture } from "./analytics-fixture.js";
import { UtcTimestamp, transaction } from "../src/db.js";
import {
  canonicalJson,
  canonicalJsonSha256,
} from "@kasitek-labs/server-support/json";
import { backfillSourceSequence } from "@kasitek-labs/server-support/analytics-producer";
import {
  enqueueWorkspaceScopeDefinition,
  enqueueClientScopeDefinition,
  enqueueClientLifecycle,
  enqueueClientAssignmentLifecycle,
  enqueueLeadCreated,
  enqueueLeadStatusChanged,
  enqueueLeadManifest,
  workspaceEventCount,
  chronoDisplay,
} from "../src/analytics.js";
import {
  backfillSettings,
  processSourceReconstruction,
  sourceDomains,
  type BackfillTransport,
} from "../src/analytics-backfill.js";
import { publisherSettings } from "../src/analytics-publisher.js";
import type { SourceBackfillWork, BackfillRecord } from "@kasitek-labs/contracts";
const enabled = !!process.env.TENANT_TEST_DATABASE_URL;
const time = new UtcTimestamp("2030-01-01T00:00:00.123456Z", true);
function work(scope = "w"): SourceBackfillWork {
  return {
    job_id: "fixture-job",
    source_service: "tenant-platform",
    source_domain: "tenants",
    reporting_scope_id: 1,
    root_scope_id: 1,
    scope_external_id: scope,
    requested_range_start: "2030-01-01T00:00:00.123450Z",
    requested_range_end: "2030-01-01T00:00:01Z",
    contract_version: "1",
    method: "source_reconstruction",
    job_status: "running",
    checkpoint: {},
    remaining_count: 100,
    lease_expires_at: "2030-01-01T00:01:00Z",
  };
}
test("Tenant producer and worker defaults retain blank-token precedence, i64 clamping and Chrono microsecond identities", () => {
  assert.equal(chronoDisplay(time), "2030-01-01 00:00:00.123456 UTC");
  assert.equal(
    chronoDisplay(new UtcTimestamp("2030-01-01T00:00:00Z", true)),
    "2030-01-01 00:00:00 UTC",
  );
  assert.equal(
    publisherSettings({
      ANALYTICS_TENANT_INGESTION_TOKEN: " ",
      ANALYTICS_INGESTION_TOKEN: "fallback",
    }),
    undefined,
  );
  assert.equal(
    backfillSettings({
      ANALYTICS_TENANT_INGESTION_TOKEN: " ",
      ANALYTICS_INGESTION_TOKEN: "fallback",
    }),
    undefined,
  );
  const s = publisherSettings({
    ANALYTICS_INGESTION_TOKEN: "fixture",
    ANALYTICS_PUBLISHER_BATCH_SIZE: "9223372036854775807",
    ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS: "9750",
  })!;
  assert.equal(s.batch_size, 500);
  assert.equal(s.producer_id, "tenant-platform-customer-analytics");
  assert.equal(s.retry_policy.base_delay_ms, 9750);
  assert.deepEqual(sourceDomains("tenants"), [
    "scopes",
    "clients",
    "leads",
    "assignments",
  ]);
});
test(
  "Tenant facts retain caller transaction, source identity, privacy, manifest counts and precise timestamps",
  { skip: !enabled },
  async () => {
    const db = await analyticsFixture();
    try {
      await assert.rejects(
        transaction(db.pool, async (tx) => {
          await enqueueLeadCreated(
            tx,
            "w",
            "client",
            "rollback",
            "manual",
            "high",
            time,
          );
          throw Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(
        (await db.pool.query("SELECT COUNT(*) FROM analytics_outbox")).rows[0]
          .count,
        "0",
      );
      await transaction(db.pool, async (tx) => {
        await enqueueWorkspaceScopeDefinition(
          tx,
          "w",
          9007199254740993n,
          "UTC",
        );
        await enqueueClientScopeDefinition(
          tx,
          "w",
          "client",
          9007199254740993n,
          "UTC",
          "active",
        );
        assert.equal(
          (
            await enqueueClientLifecycle(
              tx,
              "w",
              "client",
              "created",
              "active",
              time,
            )
          ).kind,
          "inserted",
        );
        assert.equal(
          (
            await enqueueClientLifecycle(
              tx,
              "w",
              "client",
              "created",
              "active",
              time,
            )
          ).kind,
          "duplicate",
        );
        await enqueueClientAssignmentLifecycle(
          tx,
          "w",
          "client",
          "user",
          "assignment",
          "assigned",
          "active",
          "viewer",
          "history",
          time,
        );
        await enqueueLeadCreated(
          tx,
          "w",
          "client",
          "lead",
          "manual",
          "high",
          time,
        );
        await enqueueLeadStatusChanged(
          tx,
          "w",
          "client",
          "lead",
          "new",
          "qualified",
          "manual_review",
          "tenant_user",
          "manual",
          "high",
          "history",
          time,
        );
        assert.equal(await workspaceEventCount(tx, "workspace:w:leads"), 2n);
        await enqueueLeadManifest(tx, "w", 2n, time);
        assert.equal(
          (await enqueueLeadManifest(tx, "w", 99n, time)).kind,
          "conflict",
        );
      });
      const rows = (
        await db.pool.query(
          "SELECT record_id,envelope,payload_hash,record_category FROM analytics_outbox",
        )
      ).rows;
      assert.equal(rows.length, 7);
      const client = rows.find((row) =>
        row.record_id.startsWith("tenant-client:"),
      )!;
      assert.equal(
        client.record_id,
        "tenant-client:client:lifecycle:created:2030-01-01 00:00:00.123456 UTC",
      );
      assert.equal(client.envelope.time, "2030-01-01T00:00:00.123456Z");
      assert.equal(client.envelope.data.occurred_at, client.envelope.time);
      for (const row of rows)
        assert.equal(row.payload_hash, canonicalJsonSha256(row.envelope.data));
      const manifest = rows.find((row) => row.record_category === "manifest")!;
      const json = canonicalJson(manifest.envelope);
      assert.ok(json.includes("2030-01-01T01:00:00.123456Z"));
      assert.ok(json.includes('"approved_checkpoint_count":2'));
      assert(!canonicalJson(rows).includes("@example.test"));
    } finally {
      await db.close();
    }
  },
);
test(
  "Tenant source backfill pages immutable history and isolates workspace/client/range while retaining original hashes",
  { skip: !enabled },
  async () => {
    const db = await analyticsFixture();
    try {
      await transaction(db.pool, async (tx) => {
        await enqueueClientLifecycle(
          tx,
          "w",
          "client",
          "created",
          "active",
          time,
        );
        await enqueueLeadCreated(
          tx,
          "w",
          "client",
          "lead",
          "manual",
          "high",
          time,
        );
        await enqueueLeadCreated(
          tx,
          "w",
          "client-other",
          "other",
          "manual",
          "high",
          time,
        );
        await enqueueLeadCreated(
          tx,
          "foreign",
          "foreign-client",
          "foreign",
          "manual",
          "high",
          time,
        );
        await enqueueLeadCreated(
          tx,
          "w",
          "client",
          "end",
          "manual",
          "high",
          new UtcTimestamp("2030-01-01T00:00:01Z", true),
        );
        await enqueueLeadManifest(tx, "w", 2n, time);
      });
      await db.pool.query(
        `UPDATE tenant_clients SET name='Changed operational name',metadata='{"email":"private@example.test"}' WHERE id='client'`,
      );
      const batches: BackfillRecord[][] = [];
      const transport: BackfillTransport = {
        claimSourceBackfillWork: async () => undefined,
        sendBackfillBatch: async (producer, job, records) => {
          assert.equal(producer, "tenant-platform-customer-analytics");
          assert.equal(job, "fixture-job");
          batches.push(records);
          return {
            accepted_count: records.length,
            duplicate_count: 0,
            rejected_count: 0,
            retryable_count: 0,
            acknowledgements: records.map((row) => ({
              source_sequence: row.source_sequence,
              record_id: row.record.record_id,
              status: "accepted",
            })),
          };
        },
      };
      const settings = backfillSettings({
        ANALYTICS_INGESTION_TOKEN: "fixture",
        ANALYTICS_BACKFILL_BATCH_SIZE: "1",
      })!;
      const stats = await processSourceReconstruction(
        db.pool,
        transport,
        settings,
        work("client"),
      );
      assert.deepEqual(stats, { records: 2, rejected_records: 0 });
      assert.equal(batches.length, 2);
      for (const row of batches.flat()) {
        assert.equal(
          row.source_sequence,
          backfillSourceSequence(row.record.record_id),
        );
        assert.equal(
          row.record.payload_hash,
          canonicalJsonSha256((row.record.envelope as { data: unknown }).data),
        );
        assert(!canonicalJson(row).includes("private@example.test"));
      }
      batches.length = 0;
      assert.equal(
        (
          await processSourceReconstruction(
            db.pool,
            transport,
            settings,
            work(),
          )
        ).records,
        3,
      );
      await assert.rejects(
        processSourceReconstruction(
          db.pool,
          {
            ...transport,
            sendBackfillBatch: async () => ({
              accepted_count: 0,
              duplicate_count: 0,
              rejected_count: 0,
              retryable_count: 1,
              acknowledgements: [],
            }),
          },
          settings,
          work(),
        ),
        /tenant_batch_has_retryable_records/,
      );
      await assert.rejects(
        processSourceReconstruction(db.pool, transport, settings, {
          ...work(),
          remaining_count: null,
        }),
        /invalid_tenant_source_backfill_work/,
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT COUNT(*) FROM analytics_outbox WHERE delivery_status<>'pending'",
          )
        ).rows[0].count,
        "0",
      );
    } finally {
      await db.close();
    }
  },
);
