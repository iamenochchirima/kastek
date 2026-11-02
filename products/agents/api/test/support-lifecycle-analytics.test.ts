import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { recordSupportFollowupDelivery, recordSupportLifecycle } from "../src/product/reporting/support-lifecycle";

const organizationId = "10000000-0000-4000-8000-000000000010";
const agentId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const conversationId = "10000000-0000-4000-8000-000000000020";

function fixture(evaluationTrial = false) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM agents_platform.customer_conversations c WHERE c.id=$1")) return { rows: [{
        organization_id: organizationId, agent_id: agentId, version_id: versionId, channel_kind: "website", evaluation_trial: evaluationTrial,
      }], rowCount: 1 };
      if (sql.includes("FROM agents_platform.customer_followup_notifications n")) return { rows: [{ conversation_id: conversationId, episode_id: "10000000-0000-4000-8000-000000000030" }], rowCount: 1 };
      if (sql.includes("INSERT INTO analytics_outbox")) return { rows: [{ outbox_id: "agent-platform:event:support", source_sequence: "1" }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("support lifecycle analytics", () => {
  it("queues aggregate lifecycle facts without customer identity or content", async () => {
    const { client, calls } = fixture();
    const inserted = await recordSupportLifecycle(client, {
      conversationId, sourceKey: `private:${conversationId}:message:private-message-id`, action: "handoff_requested", outcome: "accepted",
      occurredAt: new Date("2026-10-29T10:00:00.000Z"),
    });

    expect(inserted).toBe(true);
    const [enqueue] = calls.filter(call => call.sql.includes("INSERT INTO analytics_outbox"));
    const values = enqueue?.values ?? [];
    expect(values[2]).toBe("agents");
    expect(values[3]).toBe(`organization:agents_organization:${organizationId}:agents`);
    expect(values[4]).toBe("event");
    expect(String(values[5])).not.toContain(conversationId);
    const envelope = JSON.parse(String(values[11]));
    expect(envelope.type).toBe("agent.support.lifecycle@1");
    expect(envelope.scope_kind).toBe("agents_organization");
    expect(envelope.subject).toBe(`agent_definition:${agentId}`);
    expect(envelope.data).toEqual({
      agent_definition_id: agentId, agent_version_id: versionId, channel_type: "website", action: "handoff_requested",
      outcome: "accepted", occurred_at: "2026-10-29T10:00:00.000Z",
    });
    expect(JSON.stringify(envelope)).not.toContain(conversationId);
    expect(JSON.stringify(envelope)).not.toContain("private-message-id");
  });

  it("does not include evaluation-trial conversations in product analytics", async () => {
    const { client, calls } = fixture(true);
    const inserted = await recordSupportLifecycle(client, {
      conversationId, sourceKey: `trial:${conversationId}`, action: "first_human_reply", outcome: "published",
      occurredAt: new Date("2026-10-29T10:01:00.000Z"), durationMs: 60_000,
    });

    expect(inserted).toBe(false);
    expect(calls.some(call => call.sql.includes("INSERT INTO analytics_outbox"))).toBe(false);
  });

  it("records only the provider outcome for an opted-in human-reply email", async () => {
    const { client, calls } = fixture();
    const inserted = await recordSupportFollowupDelivery(client, { notificationId: "private-notification-id", state: "accepted",
      occurredAt: new Date("2026-10-29T10:02:00.000Z") });
    expect(inserted).toBe(true);
    const enqueue = calls.find(call => call.sql.includes("INSERT INTO analytics_outbox"));
    const envelope = JSON.parse(String(enqueue?.values?.[11]));
    expect(envelope.data.action).toBe("customer_notification_delivery");
    expect(envelope.data.outcome).toBe("accepted_by_provider");
    expect(JSON.stringify(envelope)).not.toContain("private-notification-id");
  });
});
