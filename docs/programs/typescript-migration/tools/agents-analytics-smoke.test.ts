import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildEvent } from "../../../kasitek-agents/src/analytics/producer.ts";
import {
  AnalyticsIngestionClient,
  type AgentOutboxRow,
} from "../../../kasitek-agents/src/analytics/publisher.ts";
import { buildApp } from "../../../kasitek-labs/services/analytics/src/app.js";
import { ProcessMetrics } from "../../../kasitek-labs/services/analytics/src/metrics.js";
import { loadRegistry } from "../../../kasitek-labs/services/analytics/src/registry.js";
import { analyticsFixture } from "../../../kasitek-labs/services/analytics/tests/database-fixture.js";

const producerId = "agent-platform-customer-analytics";
const token = "synthetic-agent-publisher-token";
const timestamp = "2026-08-22T12:00:00.123456Z";
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;

test(
  "Agents publisher sends and replays an Agent record through the TypeScript Analytics API",
  { skip: !enabled },
  async () => {
    const fixture = await analyticsFixture({
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        { source_service: "agent-platform", producer_id: producerId, token },
      ]),
    });
    await fixture.pool.query(
      `INSERT INTO analytics.reporting_scope
        (scope_kind,owning_source_service,external_source_id,status,reporting_timezone)
       VALUES ('core_organization','core','agents-smoke-org','active','UTC')`,
    );
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
      const client = new AnalyticsIngestionClient({
        endpoint: `http://127.0.0.1:${address.port}`,
        token,
        requestTimeoutMs: 5000,
      });
      const recordId = "agents-smoke-definition-1";
      const record = buildEvent({
        recordId,
        sourceDomain: "agents",
        sourceStreamKey: "agents-smoke-definitions",
        contractName: "agent.definition.lifecycle@1",
        schemaVersion: 1,
        scopeKind: "core_organization",
        scopeExternalId: "agents-smoke-org",
        subject: `agent_definition:${recordId}`,
        occurredAt: timestamp,
        attributes: {
          agent_definition_id: recordId,
          owner_type: "organization",
          creation_profile: "general",
          agent_audience: "personal",
          action: "created",
          status: "active",
          changed_fields: ["status"],
          actor_type: "system",
          occurred_at: timestamp,
        },
      });
      const now = new Date(timestamp);
      const row: AgentOutboxRow = {
        ...record,
        sourceSequence: "1",
        createdAt: now,
        deliveryStatus: "leased",
        attemptCount: 0,
        nextAttemptAt: now,
        leaseOwner: "agents-smoke-publisher",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      };

      const first = await client.sendBatch(producerId, [row]);
      assert.equal(first.acknowledgements[0]?.status, "accepted");
      const replay = await client.sendBatch(producerId, [row]);
      assert.equal(replay.acknowledgements[0]?.status, "duplicate");
      assert.equal(replay.acknowledgements[0]?.record_id, recordId);

      const persisted = await fixture.pool.query<{ source_service: string }>(
        `SELECT source_service FROM analytics.analytics_event
         WHERE source_record_id = $1`,
        [recordId],
      );
      assert.deepEqual(persisted.rows.map((row) => row.source_service), [
        "agent-platform",
      ]);
    } finally {
      await app.close();
      await fixture.close();
    }
  },
);
