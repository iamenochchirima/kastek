import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { analyticsFixture } from "./database-fixture.js";
import { loadRegistry } from "../src-ts/registry.js";
import { apiJson } from "../src-ts/json.js";
import {
  claimReconciliationWork,
  claimQuarantineReleaseWork,
  claimSourceBackfillWork,
  scheduleWork,
  processBackfillOnce,
  registerMaintenanceRoutes,
} from "../src-ts/maintenance.js";
import { runWorker, workerOptions } from "../src-ts/worker.js";
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
test(
  "maintenance schedule/leases isolate producers, retain safe metadata, and execute empty rebuild/replay backfills",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture({
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        {
          source_service: "core",
          producer_id: "core-customer-analytics",
          token: "synthetic-bearer",
        },
      ]),
    });
    try {
      const registry = await loadRegistry(),
        auth = {
          source_service: "core",
          producer_id: "core-customer-analytics",
        };
      const id = BigInt(
        (
          await f.pool.query(
            `INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,status,reporting_timezone) VALUES('core_organization','core','maintenance-org','active','UTC') RETURNING scope_id`,
          )
        ).rows[0]!.scope_id,
      );
      await f.pool.query(
        `INSERT INTO analytics.analytics_source_cursor(producer_id,source_service,source_domain,source_stream_key,highest_received_sequence,highest_contiguous_sequence) VALUES('core-customer-analytics','core','campaigns','maintenance-stream',2,1)`,
      );
      const summary = await scheduleWork(f.pool);
      assert.equal(summary.reconciliation_work_created, 1n);
      assert.equal(
        (await scheduleWork(f.pool)).reconciliation_work_created,
        0n,
      );
      assert.equal(
        await claimReconciliationWork(
          f.pool,
          {
            source_service: "tenant-platform",
            producer_id: "tenant-platform-customer-analytics",
          },
          60,
        ),
        null,
      );
      const claims = await Promise.all([
        claimReconciliationWork(f.pool, auth, 60),
        claimReconciliationWork(f.pool, auth, 60),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claims.find(Boolean)!.reason, "sequence_gap");
      assert.equal(claims.find(Boolean)!.attempt_count, 1);
      await f.pool.query(
        `UPDATE analytics.analytics_reconciliation_work SET lease_expires_at=NOW()-INTERVAL '1 second'`,
      );
      assert.equal(
        (await claimReconciliationWork(f.pool, auth, 60))!.attempt_count,
        2,
      );
      const failure = BigInt(
        (
          await f.pool.query(
            `INSERT INTO analytics.analytics_ingestion_failure(producer_id,source_service,source_domain,source_stream_key,source_sequence,record_category,record_identity,schema_version,payload_hash,failure_class,safe_error_code,quarantine_status) VALUES('core-customer-analytics','core','campaigns','failed-stream',3,'event','failed-event',1,repeat('a',64),'permanent','invalid_event','quarantined') RETURNING failure_id`,
          )
        ).rows[0]!.failure_id,
      );
      assert.equal((await scheduleWork(f.pool)).quarantine_work_created, 1n);
      const quarantine = await claimQuarantineReleaseWork(f.pool, auth, 60);
      assert.equal(quarantine!.failure_id, failure);
      assert.equal(quarantine!.safe_error_code, "invalid_event");
      assert.equal(quarantine!.record_identity, "failed-event");
      assert.equal(Object.hasOwn(quarantine!, "payload"), false);
      assert.equal(await claimQuarantineReleaseWork(f.pool, auth, 60), null);
      for (const [job, method] of [
        ["rebuild", "projection_rebuild"],
        ["replay", "fact_replay"],
        ["source", "source_reconstruction"],
      ] as const)
        await f.pool.query(
          `INSERT INTO analytics.analytics_backfill_job(job_id,source_service,source_domain,reporting_scope_id,root_scope_id,requested_range_start,requested_range_end,contract_version,method,job_status,requesting_actor_type,requesting_actor_id,authorization_grant_id) VALUES($1,'core','campaigns',$2,$2,'2026-08-22T00:00:00Z','2026-08-23T00:00:00Z','1',$3,'queued','fixture','fixture','fixture-grant')`,
          [job, id, method],
        );
      assert.equal(
        await claimSourceBackfillWork(
          f.pool,
          {
            source_service: "tenant-platform",
            producer_id: "tenant-platform-customer-analytics",
          },
          60,
        ),
        null,
      );
      const source = await claimSourceBackfillWork(f.pool, auth, 60);
      assert.equal(source!.job_id, "source");
      assert.equal(source!.scope_external_id, "maintenance-org");
      assert.equal(
        await processBackfillOnce(f.pool, registry, "fixture-worker", 60),
        true,
      );
      assert.equal(
        await processBackfillOnce(f.pool, registry, "fixture-worker", 60),
        true,
      );
      const jobs = (
        await f.pool.query(
          `SELECT job_id,job_status,checkpoint FROM analytics.analytics_backfill_job ORDER BY job_id`,
        )
      ).rows;
      assert.deepEqual(
        jobs.map((r) => [r.job_id, r.job_status]),
        [
          ["rebuild", "completed"],
          ["replay", "completed"],
          ["source", "running"],
        ],
      );
      assert.equal(jobs[0]!.checkpoint.generation_status, "promoted");
      assert.equal(jobs[1]!.checkpoint.enqueued_projection_work, 0);
      const app = Fastify();
      app.setReplySerializer(apiJson);
      registerMaintenanceRoutes(app, {
        pool: f.pool,
        config: f.config,
        registry,
      } as Parameters<typeof registerMaintenanceRoutes>[1]);
      try {
        const denied = await app.inject({
          method: "GET",
          url: "/internal/reconciliation/v1/work",
        });
        assert.equal(denied.statusCode, 401);
        assert.equal(denied.headers["www-authenticate"], "Bearer");
        assert.equal(denied.body, "");
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: "/internal/backfill/v1/work",
              headers: { authorization: "Bearer synthetic-bearer" },
            })
          ).statusCode,
          204,
        );
      } finally {
        await app.close();
      }
      // Native worker exits on abort with no live providers or persistent loop left behind.
      const controller = new AbortController();
      const events: string[] = [],
        spans: string[] = [];
      const timer = setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      try {
        await runWorker(f.pool, registry, controller.signal, {
          recordQueueAge() {},
          async resultSpan(_component, operation, callback) {
            spans.push(operation);
            return callback();
          },
          log(_level, event) {
            events.push(event);
          },
        });
      } finally {
        clearTimeout(timer);
      }
      assert.ok(
        Date.now() - started < 1000,
        "abort should interrupt the native poll sleep",
      );
      assert.ok(spans.includes("analytics_projection.maintenance"));
      assert.deepEqual(
        [events[0], events.at(-1)],
        ["worker.started", "service.shutdown"],
      );
    } finally {
      await f.close();
    }
  },
);

test("worker settings preserve source defaults and positive Rust integer bounds", () => {
  const defaults = workerOptions({});
  assert.equal(defaults.pollIntervalMs, 1000);
  assert.equal(defaults.leaseSeconds, 60);
  assert.equal(defaults.batchSize, 25);
  const bounds = workerOptions({
    ANALYTICS_PROJECTION_POLL_INTERVAL_MS: "18446744073709551615",
    ANALYTICS_PROJECTION_LEASE_SECONDS: "9223372036854775807",
    ANALYTICS_PROJECTION_BATCH_SIZE: "18446744073709551615",
  });
  assert.equal(bounds.pollIntervalMs, 18446744073709551615n);
  assert.equal(bounds.leaseSeconds, 9223372036854775807n);
  assert.equal(bounds.batchSize, 18446744073709551615n);
  assert.equal(
    workerOptions({ ANALYTICS_PROJECTION_LEASE_SECONDS: "9223372036854775808" })
      .leaseSeconds,
    60,
  );
  assert.equal(
    workerOptions({ ANALYTICS_PROJECTION_POLL_INTERVAL_MS: "0" })
      .pollIntervalMs,
    1000,
  );
});
