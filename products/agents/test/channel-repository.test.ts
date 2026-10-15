import { describe, expect, it, vi } from "vitest";
import { ChannelRepository } from "../src/db/repositories/channel-repository";

describe("ChannelRepository delivery outcomes", () => {
  it("records an uncertain send as unknown on both the attempt and message", async () => {
    const attempt = {
      id: "attempt-unknown",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-1",
      channel_type: "telegram",
      provider_message_id: null,
      status: "unknown",
      attempt_number: 1,
      error: { code: "CHANNEL_DELIVERY_UNKNOWN", message: "provider result was not confirmed" },
      created_at: "2026-09-07T00:00:00.000Z",
      sent_at: null,
    };
    const message = {
      id: "message-1",
      conversation_id: "conversation-1",
      participant_id: null,
      direction: "outbound",
      message_type: "text",
      provider: "kasitek-agent",
      run_id: "run-1",
      source_channel: "telegram",
      occurred_at: "2026-09-07T00:00:00.000Z",
      delivery_status: "unknown",
    };
    const clientQuery = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE delivery_attempts")) return { rows: [attempt], rowCount: 1 };
      if (sql.includes("UPDATE messages")) return { rows: [message], rowCount: 1 };
      if (sql.includes("SELECT c.id AS conversation_id")) return {
        rows: [{
          conversation_id: "conversation-1",
          organization_id: "org-1",
          installation_id: "installation-1",
          agent_definition_id: "agent-1",
          agent_version_id: "version-1",
          agent_audience: "customer_service",
          conversation_kind: "workspace",
          channel_type: "telegram",
          status: "active",
          handoff_state: "agent_active",
        }],
      };
      if (sql.includes("INSERT INTO analytics_outbox")) return { rows: [{ outbox_id: "outbox-1", source_sequence: "1" }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = {
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    };
    const repository = new ChannelRepository(pool as never);

    const result = await repository.markDeliveryUnknown({
      organizationId: "org-1",
      attemptId: "attempt-unknown",
      error: { code: "CHANNEL_DELIVERY_UNKNOWN", message: "provider result was not confirmed" },
    });

    expect(result).toMatchObject({ id: "attempt-unknown", status: "unknown" });
    expect(clientQuery.mock.calls.find(([sql]) => sql.includes("UPDATE delivery_attempts"))?.[0]).toContain("status = 'unknown'");
    expect(clientQuery.mock.calls.find(([sql]) => sql.includes("UPDATE messages"))?.[0]).toContain("delivery_status = 'unknown'");
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
  });
});

describe("customer reply ownership at delivery", () => {
  it.each(["claim", "publish"])("blocks %s of an agent reply after human takeover", async action => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("FOR UPDATE OF c")) return { rows: [{ conversation_kind: "customer", handoff_state: "human_owned", provider: "kasitek-agent", assigned_actor_id: "teammate-1", participant_actor: null }] };
      return { rows: [{ id: "attempt-1", message_id: "message-1" }] };
    });
    const repository = new ChannelRepository({ connect: async () => ({ query: clientQuery, release() {} }) } as never);
    await expect(action === "claim" ? repository.claimDelivery("org-1", "attempt-1") : repository.markDelivered({ organizationId: "org-1", attemptId: "attempt-1" }))
      .rejects.toMatchObject({ code: "CONVERSATION_REPLY_OWNER_CHANGED" });
    expect(clientQuery.mock.calls.some(([sql]) => sql.startsWith("UPDATE delivery_attempts"))).toBe(false);
  });
  it("blocks publication of a reply from a teammate who no longer owns the conversation", async () => {
    const clientQuery = vi.fn(async (sql: string) => ({ rows: sql.includes("FOR UPDATE OF c")
      ? [{ conversation_kind: "customer", handoff_state: "human_owned", provider: "kasitek-human", assigned_actor_id: "new-owner", participant_actor: "old-owner" }] : [] }));
    const repository = new ChannelRepository({ connect: async () => ({ query: clientQuery, release() {} }) } as never);
    await expect(repository.markDelivered({ organizationId: "org-1", attemptId: "attempt-1" })).rejects.toMatchObject({ code: "CONVERSATION_REPLY_OWNER_CHANGED" });
  });
});
