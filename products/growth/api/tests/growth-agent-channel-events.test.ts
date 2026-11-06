import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { routeGrowthManagedMetaPayload, routeGrowthManagedWhatsAppValue } from "../src/agents/channel-events.js";
import { growthAgentChannelLinksEnabled } from "../src/agents/security.js";

test("Growth-managed Agent channel linking is enabled by default only in local environments", () => {
  assert.equal(growthAgentChannelLinksEnabled({ environment: "development", env: {} } as never), true);
  assert.equal(growthAgentChannelLinksEnabled({ environment: "test", env: {} } as never), true);
  assert.equal(growthAgentChannelLinksEnabled({ environment: "production", env: {} } as never), false);
  assert.equal(growthAgentChannelLinksEnabled({ environment: "production", env: { GROWTH_AGENT_CHANNEL_LINKS_ENABLED: "true" } } as never), true);
  assert.equal(growthAgentChannelLinksEnabled({ environment: "development", env: { GROWTH_AGENT_CHANNEL_LINKS_ENABLED: "false" } } as never), false);
});

function outboxPool(grant: Record<string, unknown> | null) {
  const records = new Map<string, string>();
  const payloads: Record<string, unknown>[] = [];
  let inserted = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "GrowthAgentChannelGrant"')) return { rows: grant ? [grant] : [], rowCount: grant ? 1 : 0 };
      if (sql.includes('INSERT INTO "GrowthAgentChannelEvent"')) {
        const key = `${values[1]}:${values[2]}`;
        if (records.has(key)) return { rows: [], rowCount: 0 };
        records.set(key, String(values[3]));
        payloads.push(JSON.parse(String(values[4])) as Record<string, unknown>);
        inserted++;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT digest FROM "GrowthAgentChannelEvent"')) {
        const key = `${values[0]}:${values[1]}`;
        return { rows: [{ digest: records.get(key) }], rowCount: 1 };
      }
      throw new Error(`Unexpected outbox query: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, records, payloads, get inserted() { return inserted; } };
}

const grant = {
  id: "grant-1", agentsWorkspaceId: "workspace-1", agentsAgentId: "agent-1", agentsConnectionId: "connection-1",
  actorId: "growth-user-1", provider: "facebook", providerAssetId: "page-1",
};

test("Meta events owned by an Agent enter the idempotent outbox and are removed from Growth Inbox delivery", async () => {
  const db = outboxPool(grant);
  const payload = { object: "page", entry: [{ id: "page-1", messaging: [{
    sender: { id: "customer-1" }, recipient: { id: "page-1" }, timestamp: 1_798_000_000_000,
    message: { mid: "mid-1", text: "Hello" },
  }] }] };

  const first = await routeGrowthManagedMetaPayload({ pool: db.pool, config: {} as never }, payload);
  const duplicate = await routeGrowthManagedMetaPayload({ pool: db.pool, config: {} as never }, payload);

  assert.deepEqual((first as typeof payload).entry[0]?.messaging, []);
  assert.deepEqual((duplicate as typeof payload).entry[0]?.messaging, []);
  assert.equal(db.records.size, 1);
  assert.equal(db.inserted, 1);
  assert.equal(db.payloads[0]?.kind, "message");
  assert.equal(db.payloads[0]?.senderId, "customer-1");
  assert.equal(db.payloads[0]?.text, "Hello");
});

test("Meta events without an Agent grant remain available to the Growth Inbox", async () => {
  const db = outboxPool(null);
  const payload = { object: "page", entry: [{ id: "page-1", messaging: [{
    sender: { id: "customer-1" }, recipient: { id: "page-1" }, timestamp: 1_798_000_000_000,
    message: { mid: "mid-2", text: "Hello" },
  }] }] };

  const result = await routeGrowthManagedMetaPayload({ pool: db.pool, config: {} as never }, payload);

  assert.deepEqual(result, payload);
  assert.equal(db.inserted, 0);
});

test("Instagram events owned by an Agent enter the idempotent outbox", async () => {
  const db = outboxPool({ ...grant, provider: "instagram", providerAssetId: "instagram-1" });
  const payload = { object: "instagram", entry: [{ id: "instagram-1", messaging: [{
    sender: { id: "customer-2" }, recipient: { id: "instagram-1" }, timestamp: 1_798_000_000_000,
    message: { mid: "ig-mid-1", text: "Hello Instagram" },
  }] }] };

  const result = await routeGrowthManagedMetaPayload({ pool: db.pool, config: {} as never }, payload);

  assert.deepEqual((result as typeof payload).entry[0]?.messaging, []);
  assert.equal(db.inserted, 1);
  assert.equal(db.payloads[0]?.assetId, "instagram-1");
  assert.equal(db.payloads[0]?.providerMessageId, "ig-mid-1");
  assert.equal(db.payloads[0]?.text, "Hello Instagram");
});

test("WhatsApp messages are normalized and enqueued for the selected Agent grant", async () => {
  const db = outboxPool({ ...grant, provider: "whatsapp", providerAssetId: "phone-1" });
  const routed = await routeGrowthManagedWhatsAppValue(db.pool, {
    metadata: { phone_number_id: "phone-1" },
    messages: [{ id: "wamid-1", from: "27123456789", timestamp: "1798000000", type: "text", text: { body: "Hello" } }],
  });

  assert.equal(routed, true);
  assert.equal(db.records.size, 1);
  assert.equal(db.payloads[0]?.providerMessageId, "wamid-1");
  assert.equal(db.payloads[0]?.externalConversationId, "27123456789");
});
