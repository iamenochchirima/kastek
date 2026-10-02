import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { analyticsFixture } from "./analytics-fixture.js";
import { UtcTimestamp, transaction } from "../src-ts/db.js";
import { apiJson, parseSerdeValueJson } from "../src-ts/json.js";
import { enqueueLeadCreated } from "../src-ts/analytics.js";
import { runAnalyticsPublisher } from "../src-ts/analytics-publisher.js";
import { runAnalyticsBackfill } from "../src-ts/analytics-backfill.js";
import { backfillSourceSequence } from "@kasitek/server-support/analytics-producer";
const enabled = !!process.env.TENANT_TEST_DATABASE_URL;
test(
  "Tenant native publisher and backfill loops send exact source records, reconcile and stop on abort",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const db = await analyticsFixture();
    const publication = new AbortController(),
      backfill = new AbortController();
    const logs: Record<string, unknown>[] = [],
      batches: Record<string, unknown>[] = [];
    let claims = 0;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        claims++;
        if (claims === 1) {
          res.end(apiJson({ source_service: "core" }));
          return;
        }
        res.end(
          apiJson({
            job_id: "tenant-job",
            source_service: "tenant-platform",
            source_domain: "tenants",
            reporting_scope_id: 1,
            root_scope_id: 1,
            scope_external_id: "w",
            requested_range_start: "2030-01-01T00:00:00Z",
            requested_range_end: "2030-01-02T00:00:00Z",
            contract_version: "1",
            method: "source_reconstruction",
            job_status: "running",
            checkpoint: {},
            remaining_count: 1,
            lease_expires_at: "2030-01-02T00:00:00Z",
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = parseSerdeValueJson(
        Buffer.concat(chunks).toString(),
      ) as Record<string, unknown>;
      if (req.url?.includes("reconciliation")) {
        assert.equal(body.producer_id, "tenant-platform-customer-analytics");
        res.end('{"reconciliation_status":"complete"}');
        return;
      }
      batches.push(body);
      const records = body.records as Record<string, unknown>[];
      res.end(
        apiJson({
          accepted_count: records.length,
          duplicate_count: 0,
          rejected_count: 0,
          retryable_count: 0,
          acknowledgements: records.map((r) => ({
            source_sequence: r.source_sequence,
            record_id: r.record_id,
            status: "accepted",
          })),
        }),
      );
    });
    const timeout = setTimeout(() => {
      publication.abort();
      backfill.abort();
    }, 5000);
    try {
      await transaction(db.pool, (tx) =>
        enqueueLeadCreated(
          tx,
          "w",
          "client",
          "lead",
          "manual",
          "high",
          new UtcTimestamp("2030-01-01T00:00:00.123456Z", true),
        ),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const env = {
        ANALYTICS_TENANT_INGESTION_TOKEN: "fixture-token",
        ANALYTICS_INGESTION_URL: `http://127.0.0.1:${address.port}`,
        ANALYTICS_PUBLISHER_POLL_INTERVAL_MS: "1",
        ANALYTICS_BACKFILL_POLL_INTERVAL_MS: "1",
      };
      const log = {
        info: (row: Record<string, unknown>) => {
          logs.push(row);
          if (row.phase === "publication" && row.delivered === 1)
            publication.abort();
          if (
            row.worker === "tenant_analytics_backfill" &&
            row.event === "queue.item.completed"
          )
            backfill.abort();
        },
        warn: (row: Record<string, unknown>) => logs.push(row),
        error: (row: Record<string, unknown>) => {
          logs.push(row);
          publication.abort();
          backfill.abort();
        },
      };
      await runAnalyticsPublisher(db.pool, env, log, publication.signal);
      assert.equal(
        (await db.pool.query("SELECT delivery_status FROM analytics_outbox"))
          .rows[0].delivery_status,
        "delivered",
      );
      assert(
        logs.some(
          (row) => row.phase === "reconciliation" && row.complete === 1,
        ),
      );
      await runAnalyticsBackfill(db.pool, env, log, backfill.signal);
      assert(
        logs.some(
          (row) =>
            row.event === "queue.item.ignored" && row.source_service === "core",
        ),
      );
      assert(
        logs.some(
          (row) =>
            row.worker === "tenant_analytics_backfill" && row.records === 1,
        ),
      );
      assert.equal(batches.length, 2);
      const sent = (batches[1]!.records as Record<string, unknown>[])[0]!;
      assert.equal(
        sent.source_sequence,
        backfillSourceSequence("tenant-lead:lead:created"),
      );
      assert.equal(sent.producer_id, "tenant-platform-customer-analytics");
      assert.equal(batches[1]!.backfill_job_id, "tenant-job");
    } finally {
      clearTimeout(timeout);
      publication.abort();
      backfill.abort();
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
