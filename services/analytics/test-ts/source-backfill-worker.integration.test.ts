import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import pg from "pg";
import type { AnalyticsOutboxRecord, OutboxRow } from "@kasitek-labs/contracts";
import {
  AnalyticsIngestionClient,
  buildEvent,
  buildScopeDefinition,
  coreProducerConfig,
} from "@kasitek-labs/server-support/analytics-producer";
import { buildApp } from "../src-ts/app.js";
import { ProcessMetrics } from "../src-ts/metrics.js";
import { loadRegistry } from "../src-ts/registry.js";
import { analyticsFixture } from "./database-fixture.js";

const enabled =
  !!process.env.ANALYTICS_TEST_DATABASE_URL && !!process.env.GROWTH_CORE_DIST;
const coreToken = "synthetic-core-backfill-token";
const jobId = "growth-worker-restart-backfill";

function leased(record: AnalyticsOutboxRecord, sourceSequence: number): OutboxRow {
  const now = new Date();
  return {
    ...record,
    source_sequence: sourceSequence,
    delivery_status: "leased",
    attempt_count: 0,
    next_attempt_at: now,
    created_at: now,
  };
}

test(
  "Growth backfill retries a committed batch after the Analytics API restarts",
  { skip: !enabled },
  async () => {
    const fixture = await analyticsFixture({
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        {
          source_service: "core",
          producer_id: "core-customer-analytics",
          token: coreToken,
        },
      ]),
    });
    const sourceSchema = `growth_backfill_${randomUUID().replaceAll("-", "")}`;
    const sourceUrl = new URL(fixture.databaseUrl);
    let sourcePool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof serveApi>> | undefined;
    let controller: AbortController | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const originalFetch = globalThis.fetch;
    let restartCount = 0;
    const backfillResponses: { accepted_count: number; duplicate_count: number }[] = [];
    const logs: { event?: string; [key: string]: unknown }[] = [];

    try {
      await fixture.pool.query(`CREATE SCHEMA "${sourceSchema}"`);
      sourceUrl.searchParams.set(
        "options",
        `-c search_path=${sourceSchema},public -c timezone=UTC`,
      );
      sourcePool = new pg.Pool({ connectionString: sourceUrl.toString() });
      await sourcePool.query(`
        CREATE TABLE analytics_outbox (
          outbox_id TEXT PRIMARY KEY,
          source_service TEXT NOT NULL,
          source_domain TEXT NOT NULL,
          source_stream_key TEXT NOT NULL,
          record_category TEXT NOT NULL,
          record_id TEXT NOT NULL,
          contract_name TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          scope_kind TEXT NOT NULL,
          scope_external_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          envelope JSONB NOT NULL,
          payload_hash TEXT NOT NULL,
          source_sequence BIGINT NOT NULL,
          UNIQUE (source_service, record_category, record_id)
        )
      `);

      app = await serveApi(fixture);
      const address = app.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      const client = new AnalyticsIngestionClient(endpoint, coreToken, 5000);
      const occurredAt = new Date().toISOString();
      const organizationId = "growth-backfill-restart-org";
      const producer = coreProducerConfig();
      const scope = buildScopeDefinition(producer, {
        record_id: `core-scope:${organizationId}:1`,
        source_domain: "scopes",
        source_stream_key: `organization:${organizationId}:scopes`,
        contract_name: "core.scope.definition@1",
        schema_version: 1,
        scope_kind: "core_organization",
        scope_external_id: organizationId,
        reporting_timezone: "UTC",
        status: "active",
        source_version: 1,
      });
      assert.equal(
        (
          await client.sendBatch("core-customer-analytics", [leased(scope, 1)])
        ).accepted_count,
        1,
      );
      const scopeId = (
        await fixture.pool.query<{ scope_id: string }>(
          "SELECT scope_id::text FROM analytics.reporting_scope WHERE external_source_id=$1",
          [organizationId],
        )
      ).rows[0]!.scope_id;
      const rangeStart = new Date(Date.now() - 60_000).toISOString();
      const rangeEnd = new Date(Date.now() + 60_000).toISOString();
      await fixture.pool.query(
        `INSERT INTO analytics.analytics_backfill_job(
           job_id,source_service,source_domain,reporting_scope_id,root_scope_id,
           requested_range_start,requested_range_end,contract_version,method,
           job_status,remaining_count,requesting_actor_type,requesting_actor_id,
           authorization_grant_id
         ) VALUES($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',
                  'source_reconstruction','queued',2,'fixture','growth-worker',
                  'migration-fixture')`,
        [jobId, scopeId, rangeStart, rangeEnd],
      );

      for (const index of [1, 2]) {
        const recordId = `core-event:restart-recipient-${index}`;
        const record = buildEvent(producer, {
          record_id: recordId,
          source_domain: "campaigns",
          source_stream_key: `organization:${organizationId}:campaigns`,
          contract_name: "campaign.recipient.sent@1",
          schema_version: 1,
          scope_kind: "core_organization",
          scope_external_id: organizationId,
          subject_type: "recipient",
          subject_id: `restart-recipient-${index}`,
          occurred_at: occurredAt,
          attributes: {
            campaign_id: "restart-campaign",
            recipient_id: `restart-recipient-${index}`,
            channel: "whatsapp",
            status: "sent",
            occurred_at: occurredAt,
          },
        });
        await insertSourceRecord(sourcePool, record, index);
      }

      const firstFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const response = await firstFetch(input, init);
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (
          init?.method === "POST" &&
          url.pathname === "/internal/ingest/v1/batch" &&
          body?.backfill_job_id === jobId
        ) {
          const result = (await response.clone().json()) as {
            accepted_count: number;
            duplicate_count: number;
          };
          backfillResponses.push(result);
          if (restartCount === 0) {
            assert.equal(response.status, 200);
            assert.equal(result.accepted_count, 1);
            await app!.close();
            app = await serveApi(fixture, address.port);
            await fixture.pool.query(
              `UPDATE analytics.analytics_backfill_job
               SET lease_expires_at=NOW()-INTERVAL '1 second'
               WHERE job_id=$1 AND job_status='running'`,
              [jobId],
            );
            restartCount += 1;
            throw new TypeError("simulated lost response after committed batch");
          }
        }
        return response;
      };

      const workerModule = await import(
        pathToFileURL(
          resolve(process.env.GROWTH_CORE_DIST!, "workers/analytics-backfill.js"),
        ).href
      );
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 15_000);
      await workerModule.runAnalyticsBackfill(
        sourcePool,
        {
          ANALYTICS_CORE_INGESTION_TOKEN: coreToken,
          ANALYTICS_INGESTION_URL: endpoint,
          ANALYTICS_BACKFILL_BATCH_SIZE: "1",
          ANALYTICS_BACKFILL_POLL_INTERVAL_MS: "1",
        },
        {
          info(fields: Record<string, unknown>) {
            logs.push(fields);
            if (fields.event === "queue.item.completed") controller?.abort();
          },
          warn(fields: Record<string, unknown>) {
            logs.push(fields);
          },
          error(fields: Record<string, unknown>) {
            logs.push(fields);
          },
        },
        controller.signal,
      );

      assert.equal(restartCount, 1);
      assert.deepEqual(
        backfillResponses.map(({ accepted_count, duplicate_count }) => [
          accepted_count,
          duplicate_count,
        ]),
        [
          [1, 0],
          [0, 1],
          [1, 0],
        ],
      );
      assert.ok(logs.some((fields) => fields.event === "queue.item.failed"));
      assert.ok(logs.some((fields) => fields.event === "queue.item.completed"));
      const job = (
        await fixture.pool.query<{
          accepted_count: string;
          remaining_count: string;
          attempt_count: number;
          job_status: string;
        }>(
          `SELECT accepted_count::text,remaining_count::text,attempt_count,job_status
           FROM analytics.analytics_backfill_job WHERE job_id=$1`,
          [jobId],
        )
      ).rows[0]!;
      assert.deepEqual(job, {
        accepted_count: "2",
        remaining_count: "0",
        attempt_count: 2,
        job_status: "completed",
      });
      assert.equal(
        (
          await fixture.pool.query(
            `SELECT count(*) FROM analytics.analytics_event
             WHERE source_service='core' AND source_record_id LIKE 'core-event:restart-recipient-%'`,
          )
        ).rows[0]!.count,
        "2",
      );
    } finally {
      globalThis.fetch = originalFetch;
      controller?.abort();
      if (timeout) clearTimeout(timeout);
      await app?.close().catch(() => {});
      await sourcePool?.end();
      await fixture.pool.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
      await fixture.close();
    }
  },
);

async function serveApi(
  fixture: Awaited<ReturnType<typeof analyticsFixture>>,
  port = 0,
) {
  const app = await buildApp(
    {
      pool: fixture.pool,
      config: fixture.config,
      registry: await loadRegistry(),
      metrics: new ProcessMetrics(),
    },
    "analytics-api",
    { logger: false },
  );
  await app.listen({ host: "127.0.0.1", port });
  return app;
}

async function insertSourceRecord(
  pool: pg.Pool,
  record: AnalyticsOutboxRecord,
  sourceSequence: number,
) {
  await pool.query(
    `INSERT INTO analytics_outbox(
       outbox_id,source_service,source_domain,source_stream_key,record_category,
       record_id,contract_name,schema_version,scope_kind,scope_external_id,
       idempotency_key,envelope,payload_hash,source_sequence
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      record.outbox_id,
      record.source_service,
      record.source_domain,
      record.source_stream_key,
      record.record_category,
      record.record_id,
      record.contract_name,
      record.schema_version,
      record.scope_kind,
      record.scope_external_id,
      record.idempotency_key,
      record.envelope,
      record.payload_hash,
      sourceSequence,
    ],
  );
}
