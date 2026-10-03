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
  tenantProducerConfig,
} from "@kasitek-labs/server-support/analytics-producer";
import { buildApp } from "../src-ts/app.js";
import { ProcessMetrics } from "../src-ts/metrics.js";
import { loadRegistry } from "../src-ts/registry.js";
import { analyticsFixture } from "./database-fixture.js";

const enabled =
  !!process.env.ANALYTICS_TEST_DATABASE_URL &&
  !!process.env.AGENCY_TENANT_DIST;
const tenantToken = "synthetic-tenant-backfill-token";
const jobId = "agency-worker-restart-backfill";

function leased(
  record: AnalyticsOutboxRecord,
  sourceSequence: number,
): OutboxRow {
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
  "Agency backfill worker resumes an expired job after a committed batch loses its response",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const fixture = await analyticsFixture({
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        {
          source_service: "tenant-platform",
          producer_id: "tenant-platform-customer-analytics",
          token: tenantToken,
        },
      ]),
    });
    const sourceSchema = `agency_backfill_${randomUUID().replaceAll("-", "")}`;
    const sourceUrl = new URL(fixture.databaseUrl);
    sourceUrl.searchParams.set(
      "options",
      `-c search_path=${sourceSchema},public -c timezone=UTC`,
    );
    let sourcePool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof serveApi>> | undefined;
    let controller: AbortController | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const originalFetch = globalThis.fetch;
    let restartCount = 0;
    const responses: { accepted_count: number; duplicate_count: number }[] = [];
    const logs: { event?: string; [key: string]: unknown }[] = [];

    try {
      await fixture.pool.query(`CREATE SCHEMA "${sourceSchema}"`);
      sourcePool = new pg.Pool({ connectionString: sourceUrl.toString() });
      await sourcePool.query(`
        CREATE TABLE workspaces (id text PRIMARY KEY);
        CREATE TABLE analytics_outbox (
          outbox_id text PRIMARY KEY,
          source_service text NOT NULL,
          source_domain text NOT NULL,
          source_stream_key text NOT NULL,
          record_category text NOT NULL,
          record_id text NOT NULL,
          contract_name text NOT NULL,
          schema_version integer NOT NULL,
          scope_kind text NOT NULL,
          scope_external_id text NOT NULL,
          idempotency_key text NOT NULL,
          envelope jsonb NOT NULL,
          payload_hash text NOT NULL,
          source_sequence bigserial NOT NULL
        )
      `);

      app = await serveApi(fixture);
      const address = app.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      const client = new AnalyticsIngestionClient(endpoint, tenantToken, 5000);
      const producer = tenantProducerConfig();
      const occurredAt = new Date().toISOString();
      const workspaceId = "agency-backfill-restart-workspace";
      const clientId = "agency-backfill-restart-client";
      await sourcePool.query("INSERT INTO workspaces(id) VALUES($1)", [
        workspaceId,
      ]);

      const workspaceScope = buildScopeDefinition(producer, {
        record_id: `tenant-scope:workspace:${workspaceId}:1`,
        source_domain: "scopes",
        source_stream_key: `workspace:${workspaceId}:scopes`,
        contract_name: "tenant.scope.definition@1",
        schema_version: 1,
        scope_kind: "tenant_workspace",
        scope_external_id: workspaceId,
        reporting_timezone: "UTC",
        status: "active",
        source_version: 1,
      });
      const clientScope = buildScopeDefinition(producer, {
        record_id: `tenant-scope:client:${clientId}:1`,
        source_domain: "scopes",
        source_stream_key: `workspace:${workspaceId}:scopes`,
        contract_name: "tenant.scope.definition@1",
        schema_version: 1,
        scope_kind: "tenant_client",
        scope_external_id: clientId,
        parent_scope_external_id: workspaceId,
        reporting_timezone: "UTC",
        status: "active",
        source_version: 1,
      });
      assert.equal(
        (
          await client.sendBatch("tenant-platform-customer-analytics", [
            leased(workspaceScope, 1),
            leased(clientScope, 2),
          ])
        ).accepted_count,
        2,
      );
      const scopeId = (
        await fixture.pool.query<{ scope_id: string }>(
          "SELECT scope_id::text FROM analytics.reporting_scope WHERE external_source_id=$1",
          [workspaceId],
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
         ) VALUES($1,'tenant-platform','leads',$2,$2,$3,$4,'tenant.lead.lifecycle@1',
                  'source_reconstruction','queued',2,'fixture','agency-worker',
                  'migration-fixture')`,
        [jobId, scopeId, rangeStart, rangeEnd],
      );

      for (const index of [1, 2]) {
        const leadId = `agency-restart-lead-${index}`;
        const record = buildEvent(producer, {
          record_id: `tenant-lead:${leadId}:created`,
          source_domain: "leads",
          source_stream_key: `workspace:${workspaceId}:leads`,
          contract_name: "tenant.lead.lifecycle@1",
          schema_version: 1,
          scope_kind: "tenant_client",
          scope_external_id: clientId,
          subject_type: "tenant_lead",
          subject_id: leadId,
          occurred_at: occurredAt,
          attributes: {
            lead_id: leadId,
            tenant_client_id: clientId,
            action: "created",
            status: "new",
            source: "manual",
            score_band: "high",
            occurred_at: occurredAt,
          },
        });
        await insertSourceRecord(sourcePool, record);
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
          responses.push(result);
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
            controller?.abort();
            throw new TypeError("simulated lost response after committed batch");
          }
        }
        return response;
      };

      const tenantRoot = resolve(process.env.AGENCY_TENANT_DIST!);
      const workerModule = await import(
        pathToFileURL(resolve(tenantRoot, "analytics-backfill.js")).href
      );
      const env = {
        ANALYTICS_TENANT_INGESTION_TOKEN: tenantToken,
        ANALYTICS_INGESTION_URL: endpoint,
        ANALYTICS_BACKFILL_BATCH_SIZE: "1",
        ANALYTICS_BACKFILL_POLL_INTERVAL_MS: "1",
      };
      const log = {
        info(fields: Record<string, unknown>) {
          logs.push(fields);
          if (
            fields.worker === "tenant_analytics_backfill" &&
            fields.event === "queue.item.completed"
          )
            controller?.abort();
        },
        warn(fields: Record<string, unknown>) {
          logs.push(fields);
        },
        error(fields: Record<string, unknown>) {
          logs.push(fields);
        },
      };

      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 15000);
      await workerModule.runAnalyticsBackfill(
        sourcePool,
        env,
        log,
        controller.signal,
      );
      assert.equal(restartCount, 1);
      await sourcePool.end();
      sourcePool = new pg.Pool({ connectionString: sourceUrl.toString() });

      controller = new AbortController();
      await workerModule.runAnalyticsBackfill(
        sourcePool,
        env,
        log,
        controller.signal,
      );

      assert.deepEqual(
        responses.map(({ accepted_count, duplicate_count }) => [
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
             WHERE source_service='tenant-platform'
               AND source_record_id LIKE 'tenant-lead:agency-restart-lead-%:created'`,
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

async function insertSourceRecord(pool: pg.Pool, record: AnalyticsOutboxRecord) {
  await pool.query(
    `INSERT INTO analytics_outbox(
       outbox_id,source_service,source_domain,source_stream_key,record_category,
       record_id,contract_name,schema_version,scope_kind,scope_external_id,
       idempotency_key,envelope,payload_hash
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
    ],
  );
}
