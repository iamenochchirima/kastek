import test from "node:test";
import assert from "node:assert/strict";
import { forwardAgencyUsageRow } from "../src/capabilities/billing.js";

const row = {
  id: "outbox-1",
  tenant_id: "workspace-1",
  meter_key: "agency_agent_commands",
  quantity: "1",
  source_type: "agency_agent_command",
  source_id: "request-1",
  idempotency_key: "agency:command:request-1",
  attempts: 0,
};

test("agency usage outbox marks a successful delivery once", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const calls: unknown[] = [];
  const client = {
    usage: async (input: unknown) => {
      calls.push(input);
      return { accepted: true };
    },
  };
  const delivered = await forwardAgencyUsageRow(
    pool as never,
    client as never,
    row,
  );
  assert.equal(delivered, true);
  assert.deepEqual(calls, [
    {
      tenantId: "workspace-1",
      meterKey: "agency_agent_commands",
      quantity: "1",
      sourceType: "agency_agent_command",
      sourceId: "request-1",
      idempotencyKey: "agency:command:request-1",
    },
  ]);
  assert.match(queries[0]!.sql, /delivered_at=now\(\)/);
});

test("agency usage outbox schedules a retry after a failure", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const client = {
    usage: async () => {
      throw new Error("billing unavailable");
    },
  };
  const delivered = await forwardAgencyUsageRow(
    pool as never,
    client as never,
    row,
  );
  assert.equal(delivered, false);
  assert.match(queries[0]!.sql, /next_attempt_at=now\(\)\+/);
  assert.equal(queries[0]!.params[0], "outbox-1");
  assert.ok(Number(queries[0]!.params[1]) >= 5);
  assert.equal(queries[0]!.params[2], "billing unavailable");
});
