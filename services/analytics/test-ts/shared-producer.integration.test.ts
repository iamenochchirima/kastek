import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
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
      const coreRows = [
        leased(coreScope, 1, timestamp),
        leased(coreEvent, 1, timestamp),
      ];
      const acceptedCore = await coreClient.sendBatch(
        "core-customer-analytics",
        coreRows,
      );
      assert.equal(acceptedCore.accepted_count, 2);
      assert.deepEqual(
        acceptedCore.acknowledgements.map((ack) => String(ack.source_sequence)),
        ["1", "1"],
      );
      assert.equal(
        (
          await coreClient.sendBatch("core-customer-analytics", coreRows)
        ).duplicate_count,
        2,
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
      assert.equal(projected, 2);

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
        1,
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
