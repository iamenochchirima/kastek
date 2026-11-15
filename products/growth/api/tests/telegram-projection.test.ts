import assert from "node:assert/strict";
import test from "node:test";
import { permissionSnapshots } from "../src/integrations/connection-permissions.js";
import { syncTelegramProjection } from "../src/agents/telegram-projection.js";

const orgId = "growth-org-1";
const connection = {
  id: "5a7a3f5c-9d0b-4f2e-8a6c-1b2c3d4e5f60",
  organizationId: "agents-org-1",
  name: "Growth bot",
  assetId: "123456",
  state: "active",
  revision: 3,
  metadata: { botUsername: "growth_bot", setupStatus: "verified" },
  createdAt: "2026-11-15T10:00:00.000Z",
  updatedAt: "2026-11-15T10:00:01.000Z",
};

test("Telegram permissions require a verified bot webhook", () => {
  const granted = permissionSnapshots("TELEGRAM", {
    permissions: ["telegram_bot"],
    permissionsInspected: true,
    capabilityChecks: { MESSAGING_INBOUND: true, MESSAGING_OUTBOUND: true },
  });
  assert.equal(granted.find((item) => item.definition.key === "MESSAGING_INBOUND")?.definition.state, "GRANTED");
  assert.equal(granted.find((item) => item.definition.key === "MESSAGING_OUTBOUND")?.definition.state, "GRANTED");
  assert.equal(granted.find((item) => item.definition.key === "SOCIAL_PUBLISH")?.definition.state, "UNSUPPORTED");

  const pending = permissionSnapshots("TELEGRAM", {
    permissions: ["telegram_bot"],
    permissionsInspected: true,
    capabilityChecks: { MESSAGING_INBOUND: false, MESSAGING_OUTBOUND: false },
  });
  assert.equal(pending.find((item) => item.definition.key === "MESSAGING_INBOUND")?.definition.state, "NOT_GRANTED");
});

test("projection copies display state without the bot token", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let permissionsSynced = 0;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      return { rows: [] };
    },
  };
  await syncTelegramProjection(pool as never, orgId, [connection], {
    prune: true,
    syncPermissions: async () => {
      permissionsSynced += 1;
    },
  });
  const upsert = queries.find((query) => query.sql.includes('INSERT INTO "ExternalConnection"'));
  assert.ok(upsert);
  assert.equal(upsert!.values[0], `ext_${connection.id}`);
  assert.equal(upsert!.values[2], connection.id);
  assert.equal(upsert!.values[3], "123456");
  assert.equal(upsert!.values[5], "CONNECTED");
  const metadata = JSON.parse(String(upsert!.values[9]));
  assert.deepEqual(metadata.capabilityChecks, {
    MESSAGING_INBOUND: true,
    MESSAGING_OUTBOUND: true,
  });
  assert.equal(metadata.botUsername, "growth_bot");
  assert.equal(JSON.stringify(queries).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  const prune = queries.find((query) => query.sql.includes('DELETE FROM "ExternalConnection"'));
  assert.ok(prune);
  assert.deepEqual(prune!.values, [orgId, [connection.id]]);
  assert.equal(permissionsSynced, 1);
});

test("single-connection sync does not prune other Telegram projections", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
  };
  await syncTelegramProjection(pool as never, orgId, [connection], {
    syncPermissions: async () => undefined,
  });
  assert.equal(queries.some((sql) => sql.includes('DELETE FROM "ExternalConnection"')), false);
});
