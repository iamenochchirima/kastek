import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AnalyticsOutboxRecord, OutboxRow } from "@kasitek/contracts";
import {
  AnalyticsIngestionClient,
  buildEvent,
  buildScopeDefinition,
  coreProducerConfig,
  tenantProducerConfig,
} from "@kasitek/server-support/analytics-producer";
import { buildApp } from "../src-ts/app.js";
import { ProcessMetrics } from "../src-ts/metrics.js";
import { loadRegistry } from "../src-ts/registry.js";
import { analyticsFixture } from "./database-fixture.js";

const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
const timestamp = "2026-08-22T12:00:00.123456Z";
const coreToken = "synthetic-core-publisher-token";
const tenantToken = "synthetic-tenant-publisher-token";
const metricsToken = "synthetic-analytics-metrics-token";

function leased(record: AnalyticsOutboxRecord, sourceSequence: number): OutboxRow {
  return {
    ...record,
    source_sequence: sourceSequence,
    delivery_status: "leased",
    attempt_count: 0,
    next_attempt_at: new Date(timestamp),
    created_at: new Date(timestamp),
  };
}

test(
  "Growth and Agency shared publisher transport sends source records to Analytics",
  { skip: !enabled },
  async () => {
    const fixture = await analyticsFixture({
      ANALYTICS_METRICS_TOKEN: metricsToken,
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
      const tenantClient = new AnalyticsIngestionClient(endpoint, tenantToken, 5000);

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
      const coreRows = [leased(coreScope, 1), leased(coreEvent, 1)];
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
        [leased(workspaceScope, 1), leased(tenantEvent, 1)],
      );
      assert.equal(acceptedTenant.accepted_count, 2);

      const persisted = (
        await fixture.pool.query<{ source_service: string; source_record_id: string }>(
          `SELECT source_service,source_record_id
           FROM analytics.analytics_event
           WHERE source_record_id = ANY($1::text[])
           ORDER BY source_service`,
          [[
            "core-event:shared-contract-recipient",
            "tenant-client:shared-contract-client:lifecycle:created",
          ]],
        )
      ).rows;
      assert.deepEqual(
        persisted.map((row) => [row.source_service, row.source_record_id]),
        [
          ["core", "core-event:shared-contract-recipient"],
          [
            "tenant-platform",
            "tenant-client:shared-contract-client:lifecycle:created",
          ],
        ],
      );
    } finally {
      await app.close();
      await fixture.close();
    }
  },
);
