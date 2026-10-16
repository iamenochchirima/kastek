import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  applyDeliveryOutcome,
  buildEvent,
  claimOutboxBatch,
  enqueueOutbox,
  releaseExpiredLeases,
  type EventInput,
} from "../src/analytics";

const databaseUrl = process.env.ANALYTICS_AGENT_TEST_DATABASE_URL;

function event(attributes: Record<string, unknown> = { count: 1 }): EventInput {
  return {
    recordId: "a08-test-event",
    sourceDomain: "agents",
    sourceStreamKey: "agent:a08-test-org",
    contractName: "agent.run.completed@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: "a08-test-org",
    subject: "run/a08-test-run",
    occurredAt: new Date(),
    attributes: {
      run_id: "a08-test-run",
      installation_id: "a08-installation",
      agent_definition_id: "a08-agent",
      status: "completed",
      occurred_at: new Date().toISOString(),
      ...attributes,
    },
  };
}

describe("Agent analytics outbox PostgreSQL integration", () => {
  it("supports transactional enqueue, duplicate/conflict detection, leasing, retry, and delivery", async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 1, applicationName: "kasitek-agent-analytics-test" });
    try {
      await pool.query(
        "CREATE TEMP TABLE analytics_outbox (LIKE public.analytics_outbox INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT PRESERVE ROWS",
      );
      await pool.query(
        "CREATE TRIGGER analytics_outbox_updated_at_trigger BEFORE UPDATE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_set_updated_at()",
      );
      await pool.query(
        "CREATE TRIGGER analytics_outbox_content_trigger BEFORE UPDATE OR DELETE ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION analytics_outbox_protect_content()",
      );
      const record = buildEvent(event());
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        expect((await enqueueOutbox(client, record)).kind).toBe("inserted");
        expect((await enqueueOutbox(client, record)).kind).toBe("duplicate");
        await client.query("COMMIT");

        const conflict = buildEvent(event({ count: 2 }));
        await client.query("BEGIN");
        expect((await enqueueOutbox(client, conflict)).kind).toBe("conflict");
        await client.query("ROLLBACK");
        await expect(
          client.query("UPDATE analytics_outbox SET envelope = '{}'::jsonb WHERE outbox_id = $1", [record.outboxId]),
        ).rejects.toThrow("Analytics outbox content is immutable");
      } finally {
        client.release();
      }

      const now = new Date();
      const claimed = await claimOutboxBatch(pool, "a08-test-publisher", 10, now, 30_000);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.attemptCount).toBe(1);
      await applyDeliveryOutcome(pool, claimed[0]!.outboxId, "a08-test-publisher", {
        kind: "retryable",
        errorCode: "analytics.unavailable",
        retryAt: new Date(now.getTime() - 1_000),
      });
      const reclaimed = await claimOutboxBatch(pool, "a08-test-publisher-2", 10, new Date(now.getTime() + 1_000), 30_000);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.attemptCount).toBe(2);
      await applyDeliveryOutcome(pool, reclaimed[0]!.outboxId, "a08-test-publisher-2", { kind: "accepted" });

      const leaseRecord = buildEvent({ ...event(), recordId: "a08-test-expired-lease" });
      const leaseClient = await pool.connect();
      try {
        await leaseClient.query("BEGIN");
        expect((await enqueueOutbox(leaseClient, leaseRecord)).kind).toBe("inserted");
        await leaseClient.query("COMMIT");
      } finally {
        leaseClient.release();
      }
      const leaseNow = new Date();
      const leased = await claimOutboxBatch(pool, "a08-expiring-publisher", 10, leaseNow, 1);
      expect(leased).toHaveLength(1);
      expect(await releaseExpiredLeases(pool, new Date(leaseNow.getTime() + 2_000), 10)).toBe(1);
      const recovered = await claimOutboxBatch(pool, "a08-recovery-publisher", 10, new Date(leaseNow.getTime() + 2_000), 30_000);
      expect(recovered).toHaveLength(1);
      await applyDeliveryOutcome(pool, recovered[0]!.outboxId, "a08-recovery-publisher", {
        kind: "quarantined",
        errorCode: "analytics.invalid_record",
      });
      expect(await claimOutboxBatch(pool, "a08-test-publisher-3", 10, now, 30_000)).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });
});
