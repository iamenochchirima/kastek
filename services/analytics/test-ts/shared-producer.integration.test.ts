import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { AnalyticsOutboxRecord, OutboxRow } from "@kasitek-labs/contracts";
import {
  AnalyticsReportingClient,
  ReportingGrantIssuer,
  withScope,
} from "@kasitek-labs/server-support/analytics-reporting";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import {
  AnalyticsIngestionClient,
  buildEvent,
  buildScopeDefinition,
  canonicalJsonSha256,
  coreProducerConfig,
  tenantProducerConfig,
} from "@kasitek-labs/server-support/analytics-producer";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { buildApp } from "../src-ts/app.js";
import { ProcessMetrics } from "../src-ts/metrics.js";
import { processOnce } from "../src-ts/projections.js";
import { loadRegistry } from "../src-ts/registry.js";
import { analyticsFixture } from "./database-fixture.js";

const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
const coreToken = "synthetic-core-publisher-token";
const tenantToken = "synthetic-tenant-publisher-token";
const agentToken = "synthetic-agent-publisher-token";
const metricsToken = "synthetic-analytics-metrics-token";

async function publishGrowthOutbox(
  fixture: Awaited<ReturnType<typeof analyticsFixture>>,
  endpoint: string,
  occurredAt: string,
) {
  const growthDist = process.env.GROWTH_CORE_DIST;
  if (!growthDist) return undefined;

  const eventRecordId = "core-event:growth-outbox-recipient";
  const schema = `growth_source_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^growth_source_[a-f0-9]{32}$/);
  await fixture.pool.query(`CREATE SCHEMA "${schema}"`);
  const sourcePool = new pg.Pool({
    connectionString: fixture.databaseUrl,
    options: `-c search_path=${schema},public -c timezone=UTC`,
  });

  try {
    await sourcePool.query(`
      CREATE TABLE "Organization" (
        id text PRIMARY KEY,
        "createdAt" timestamp NOT NULL,
        "reportingTimezone" text NOT NULL
      );
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
        source_sequence bigserial NOT NULL,
        delivery_status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
        lease_owner text,
        lease_expires_at timestamptz,
        last_error_code text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        delivered_at timestamptz,
        quarantined_at timestamptz,
        UNIQUE (source_service, record_category, record_id)
      );
    `);
    await sourcePool.query(
      `INSERT INTO "Organization"(id,"createdAt","reportingTimezone") VALUES ($1,$2,'UTC')`,
      ["shared-contract-org", new Date(occurredAt)],
    );

    const coreRoot = resolve(growthDist);
    const [
      { enqueueEvent },
      { enqueueMissingScopeDefinitions },
      { runAnalyticsPublisher },
    ] = await Promise.all([
      import(pathToFileURL(resolve(coreRoot, "analytics/index.js")).href),
      import(
        pathToFileURL(resolve(coreRoot, "analytics/scope-bootstrap.js")).href,
      ),
      import(pathToFileURL(resolve(coreRoot, "analytics/publisher.js")).href),
    ]);
    assert.equal(await enqueueMissingScopeDefinitions(sourcePool), 1);

    const sourceClient = await sourcePool.connect();
    try {
      await sourceClient.query("BEGIN");
      await enqueueEvent(sourceClient, {
        record_id: eventRecordId,
        source_domain: "campaigns",
        source_stream_key: "campaign:growth-outbox-campaign:recipients",
        contract_name: "campaign.recipient.sent@1",
        schema_version: 1,
        scope_kind: "core_organization",
        scope_external_id: "shared-contract-org",
        subject_type: "recipient",
        subject_id: "growth-outbox-recipient",
        occurred_at: occurredAt,
        attributes: {
          campaign_id: "growth-outbox-campaign",
          recipient_id: "growth-outbox-recipient",
          channel: "whatsapp",
          status: "sent",
          occurred_at: occurredAt,
        },
      });
      await sourceClient.query("COMMIT");
    } catch (error) {
      await sourceClient.query("ROLLBACK");
      throw error;
    } finally {
      sourceClient.release();
    }

    const logs: Record<string, unknown>[] = [];
    let totalDelivered = 0;
    const controller = new AbortController();
    const log = {
      info(fields: Record<string, unknown>) {
        logs.push(fields);
        if (fields.phase === "publication") {
          totalDelivered += Number(fields.delivered ?? 0);
          if (totalDelivered >= 2) controller.abort();
        }
      },
      warn(fields: Record<string, unknown>) {
        logs.push(fields);
      },
      error(fields: Record<string, unknown>) {
        logs.push(fields);
        controller.abort();
      },
    };
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await runAnalyticsPublisher(
        sourcePool,
        {
          ANALYTICS_CORE_INGESTION_TOKEN: coreToken,
          ANALYTICS_INGESTION_URL: endpoint,
          ANALYTICS_PUBLISHER_POLL_INTERVAL_MS: "1",
          ANALYTICS_RECONCILIATION_INTERVAL_MS: "60000",
        },
        log,
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }

    const outbox = await sourcePool.query<{
      record_id: string;
      delivery_status: string;
      attempt_count: number;
    }>(
      "SELECT record_id,delivery_status,attempt_count FROM analytics_outbox ORDER BY source_sequence",
    );
    assert.ok(
      logs.some(
        (fields) => fields.phase === "publication" && Number(fields.delivered) > 0,
      ),
      `Growth publisher did not deliver to Analytics: ${JSON.stringify({ logs, outbox: outbox.rows })}`,
    );
    assert.deepEqual(
      outbox.rows.map((row) => [row.record_id, row.delivery_status]),
      [
        [
          `core-scope:organization:shared-contract-org:${new Date(occurredAt).getTime()}`,
          "delivered",
        ],
        [eventRecordId, "delivered"],
      ],
    );
    assert.equal(
      (
        await fixture.pool.query(
          "SELECT 1 FROM analytics.analytics_event WHERE source_service='core' AND source_record_id=$1",
          [eventRecordId],
        )
      ).rowCount,
      1,
    );
    return { eventRecordId };
  } finally {
    await sourcePool.end();
    await fixture.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

function leased(
  record: AnalyticsOutboxRecord,
  sourceSequence: number,
  timestamp: string,
): OutboxRow {
  return {
    ...record,
    source_sequence: sourceSequence,
    delivery_status: "leased",
    attempt_count: 0,
    next_attempt_at: new Date(timestamp),
    created_at: new Date(timestamp),
  };
}

function agentRun(
  scopeExternalId: string,
  occurredAt: string,
): AnalyticsOutboxRecord {
  const recordId = "agent-run:shared-contract-run";
  const attributes = {
    run_id: "shared-contract-run",
    installation_id: "shared-contract-installation",
    agent_definition_id: "shared-contract-definition",
    status: "completed",
    outcome: "success",
    trigger_type: "manual",
    occurred_at: occurredAt,
  };
  const envelope = {
    specversion: "1.0" as const,
    id: randomUUID(),
    source: "kasitek://agent-platform",
    type: "agent.run.completed@1",
    subject: "agent_run:shared-contract-run",
    time: occurredAt,
    datacontenttype: "application/json",
    dataschema:
      "https://kasitek.co.za/analytics/contracts/events/agent/run_completed/v1.schema.json",
    source_service: "agent-platform",
    source_domain: "runs",
    record_category: "event" as const,
    scope_kind: "core_organization",
    scope_external_id: scopeExternalId,
    idempotency_key: recordId,
    data: attributes,
  };
  return {
    outbox_id: `agent-platform:event:${recordId}`,
    source_service: "agent-platform",
    source_domain: "runs",
    source_stream_key: "installation:shared-contract-installation:runs",
    record_category: "event",
    record_id: recordId,
    contract_name: "agent.run.completed@1",
    schema_version: 1,
    scope_kind: "core_organization",
    scope_external_id: scopeExternalId,
    idempotency_key: recordId,
    envelope,
    payload_hash: canonicalJsonSha256(attributes),
  };
}

async function reportMetric(
  client: AnalyticsReportingClient,
  privateKey: string,
  issuer: string,
  scopeId: bigint,
  metric: string,
  rangeStart: Date,
  rangeEnd: Date,
  timezone = "UTC",
) {
  const grants = await ReportingGrantIssuer.fromPem(privateKey, issuer);
  const token = await grants.issue({
    principal_id: "migration-fixture-user",
    scope_id: scopeId,
    root_scope_id: scopeId,
    descendant_mode: "none",
    permissions: ["analytics:read"],
    metric_keys: [metric],
    dimension_keys: [],
  });
  const report = await client.report(
    token,
    withScope(
      {
        range_start: rangeStart,
        range_end: rangeEnd,
        timezone,
        interval: "hour",
        metrics: [metric],
        breakdowns: [],
        filters: {},
        include_descendants: false,
      },
      scopeId,
    ),
  );
  const [key, version] = metric.split("@");
  const metrics = (
    report as {
      metrics: {
        key: string;
        version: number;
        series: { value: number | SerdeFloat }[];
      }[];
    }
  ).metrics;
  const value = metrics.find(
    (item) => item.key === key && item.version === Number(version),
  )?.series[0]?.value;
  return value instanceof SerdeFloat ? value.value : value;
}

test(
  "Growth, Agency and Agents records ingest, project and return through authorized Analytics reports",
  { skip: !enabled },
  async () => {
    const timestamp = new Date(Date.now() - 30_000).toISOString();
    const rangeStart = new Date(
        Math.floor(Date.parse(timestamp) / 3_600_000) * 3_600_000,
      ),
      rangeEnd = new Date(rangeStart.getTime() + 3_600_000);
    const signingKeys = await generateKeyPair("ES256", { extractable: true });
    const reportingPublicKey = await exportSPKI(signingKeys.publicKey);
    const reportingPrivateKey = await exportPKCS8(signingKeys.privateKey);
    const fixture = await analyticsFixture({
      ANALYTICS_METRICS_TOKEN: metricsToken,
      ANALYTICS_REPORTING_PUBLIC_KEY: reportingPublicKey,
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        {
          source_service: "core",
          producer_id: "core-customer-analytics",
          token: coreToken,
        },
        {
          source_service: "tenant-platform",
          producer_id: "tenant-platform-customer-analytics",
          token: tenantToken,
        },
        {
          source_service: "agent-platform",
          producer_id: "agent-platform-customer-analytics",
          token: agentToken,
        },
      ]),
    });
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

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(`${endpoint}/health/live`)).status, 200);
      assert.equal((await fetch(`${endpoint}/health/ready`)).status, 200);
      assert.equal((await fetch(`${endpoint}/internal/metrics`)).status, 401);
      assert.equal(
        (
          await fetch(`${endpoint}/internal/metrics`, {
            headers: { authorization: `Bearer ${metricsToken}` },
          })
        ).status,
        200,
      );
      const coreClient = new AnalyticsIngestionClient(endpoint, coreToken, 5000);
      const tenantClient = new AnalyticsIngestionClient(
        endpoint,
        tenantToken,
        5000,
      );
      const agentClient = new AnalyticsIngestionClient(endpoint, agentToken, 5000);
      const reportingClient = new AnalyticsReportingClient(endpoint, "unused");
      const growthOutbox = await publishGrowthOutbox(
        fixture,
        endpoint,
        timestamp,
      );

      const coreScope = buildScopeDefinition(coreProducerConfig(), {
        record_id: "core-scope:shared-contract-org:1",
        source_domain: "scopes",
        source_stream_key: "organization:shared-contract-org:scopes",
        contract_name: "core.scope.definition@1",
        schema_version: 1,
        scope_kind: "core_organization",
        scope_external_id: "shared-contract-org",
        reporting_timezone: "UTC",
        status: "active",
        source_version: 1,
      });
      const coreEvent = buildEvent(coreProducerConfig(), {
        record_id: "core-event:shared-contract-recipient",
        source_domain: "campaigns",
        source_stream_key: "campaign:shared-contract-campaign:recipients",
        contract_name: "campaign.recipient.sent@1",
        schema_version: 1,
        scope_kind: "core_organization",
        scope_external_id: "shared-contract-org",
        subject_type: "recipient",
        subject_id: "shared-contract-recipient",
        occurred_at: timestamp,
        attributes: {
          campaign_id: "shared-contract-campaign",
          recipient_id: "shared-contract-recipient",
          channel: "whatsapp",
          status: "sent",
          occurred_at: timestamp,
        },
      });
      const coreRows = growthOutbox
        ? [leased(coreEvent, 1, timestamp)]
        : [
            leased(coreScope, 1, timestamp),
            leased(coreEvent, 1, timestamp),
          ];
      const acceptedCore = await coreClient.sendBatch(
        "core-customer-analytics",
        coreRows,
      );
      assert.equal(acceptedCore.accepted_count, coreRows.length);
      assert.deepEqual(
        acceptedCore.acknowledgements.map((ack) => String(ack.source_sequence)),
        coreRows.map(() => "1"),
      );
      assert.equal(
        (
          await coreClient.sendBatch("core-customer-analytics", coreRows)
        ).duplicate_count,
        coreRows.length,
      );

      const workspaceScope = buildScopeDefinition(tenantProducerConfig(), {
        record_id: "tenant-scope:shared-contract-agency:1",
        source_domain: "scopes",
        source_stream_key: "workspace:shared-contract-agency:scopes",
        contract_name: "tenant.scope.definition@1",
        schema_version: 1,
        scope_kind: "tenant_workspace",
        scope_external_id: "shared-contract-agency",
        reporting_timezone: "Africa/Johannesburg",
        status: "active",
        source_version: 1,
      });
      const tenantEvent = buildEvent(tenantProducerConfig(), {
        record_id: "tenant-client:shared-contract-client:lifecycle:created",
        source_domain: "clients",
        source_stream_key: "workspace:shared-contract-agency:clients",
        contract_name: "tenant.client.lifecycle@1",
        schema_version: 1,
        scope_kind: "tenant_workspace",
        scope_external_id: "shared-contract-agency",
        subject_type: "tenant_client",
        subject_id: "shared-contract-client",
        occurred_at: timestamp,
        attributes: {
          tenant_client_id: "shared-contract-client",
          action: "created",
          status: "active",
          occurred_at: timestamp,
        },
      });
      const acceptedTenant = await tenantClient.sendBatch(
        "tenant-platform-customer-analytics",
        [
          leased(workspaceScope, 1, timestamp),
          leased(tenantEvent, 1, timestamp),
        ],
      );
      assert.equal(acceptedTenant.accepted_count, 2);
      assert.equal(
        (
          await tenantClient.sendBatch("tenant-platform-customer-analytics", [
            leased(workspaceScope, 1, timestamp),
            leased(tenantEvent, 1, timestamp),
          ])
        ).duplicate_count,
        2,
      );

      const agentEvent = agentRun("shared-contract-org", timestamp);
      const acceptedAgent = await agentClient.sendBatch(
        "agent-platform-customer-analytics",
        [leased(agentEvent, 1, timestamp)],
      );
      assert.equal(acceptedAgent.accepted_count, 1);
      assert.equal(
        (
          await agentClient.sendBatch("agent-platform-customer-analytics", [
            leased(agentEvent, 1, timestamp),
          ])
        ).duplicate_count,
        1,
      );

      const persisted = (
        await fixture.pool.query<{
          source_service: string;
          source_record_id: string;
        }>(
          `SELECT source_service,source_record_id
           FROM analytics.analytics_event
           WHERE source_record_id = ANY($1::text[])
           ORDER BY source_service`,
          [[
            "core-event:shared-contract-recipient",
          "tenant-client:shared-contract-client:lifecycle:created",
          "agent-run:shared-contract-run",
        ]],
        )
      ).rows;
      assert.deepEqual(
        persisted.map((row) => [row.source_service, row.source_record_id]),
        [
          ["agent-platform", "agent-run:shared-contract-run"],
          ["core", "core-event:shared-contract-recipient"],
          [
            "tenant-platform",
            "tenant-client:shared-contract-client:lifecycle:created",
          ],
        ],
      );

      const registry = await loadRegistry();
      let projected = 0;
      while (await processOnce(fixture.pool, registry, "a13-fixture", 60))
        projected++;
      assert.ok(projected > 0);

      const coreScopeId = BigInt(
        (
          await fixture.pool.query<{ scope_id: string }>(
            `SELECT scope_id FROM analytics.reporting_scope
             WHERE owning_source_service='core' AND external_source_id='shared-contract-org'`,
          )
        ).rows[0]!.scope_id,
      );
      const tenantScopeId = BigInt(
        (
          await fixture.pool.query<{ scope_id: string }>(
            `SELECT scope_id FROM analytics.reporting_scope
             WHERE owning_source_service='tenant-platform' AND external_source_id='shared-contract-agency'`,
          )
        ).rows[0]!.scope_id,
      );
      assert.equal(
        await reportMetric(
          reportingClient,
          reportingPrivateKey,
          "kasitek-core",
          coreScopeId,
          "campaign.recipients.sent@1",
          rangeStart,
          rangeEnd,
        ),
        growthOutbox ? 2 : 1,
      );
      assert.equal(
        await reportMetric(
          reportingClient,
          reportingPrivateKey,
          "kasitek-tenant-platform",
          tenantScopeId,
          "tenant.clients.lifecycle_events@1",
          rangeStart,
          rangeEnd,
          "Africa/Johannesburg",
        ),
        1,
      );
      assert.equal(
        await reportMetric(
          reportingClient,
          reportingPrivateKey,
          "kasitek-core",
          coreScopeId,
          "agent.runs.completed@1",
          rangeStart,
          rangeEnd,
        ),
        1,
      );
      const coreGrant = await ReportingGrantIssuer.fromPem(
        reportingPrivateKey,
        "kasitek-core",
      );
      const coreTokenForDenial = await coreGrant.issue({
        principal_id: "migration-fixture-user",
        scope_id: coreScopeId,
        root_scope_id: coreScopeId,
        descendant_mode: "none",
        permissions: ["analytics:read"],
        metric_keys: ["tenant.clients.lifecycle_events@1"],
        dimension_keys: [],
      });
      await assert.rejects(
        reportingClient.report(
          coreTokenForDenial,
          withScope(
            {
              range_start: rangeStart,
              range_end: rangeEnd,
              timezone: "UTC",
              interval: "hour",
              metrics: ["tenant.clients.lifecycle_events@1"],
              breakdowns: [],
              filters: {},
              include_descendants: false,
            },
            tenantScopeId,
          ),
        ),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          error.status === 403,
      );
    } finally {
      await app.close();
      await fixture.close();
    }
  },
);
