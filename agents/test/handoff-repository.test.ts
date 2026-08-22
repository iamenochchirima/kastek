import { describe, expect, it, vi } from "vitest";
import { HandoffRepository } from "../src/db/repositories/handoff-repository";

describe("handoff repository lifecycle", () => {
  it("emits first-human-response before the per-message event", async () => {
    const eventTypes: string[] = [];
    const handoff = {
      id: "11111111-1111-4111-8111-111111111111",
      organization_id: "org-1",
      installation_id: "22222222-2222-4222-8222-222222222222",
      conversation_id: "33333333-3333-4333-8333-333333333333",
      agent_definition_id: "44444444-4444-4444-8444-444444444444",
      agent_version_id: "55555555-5555-4555-8555-555555555555",
      run_id: "66666666-6666-4666-8666-666666666666",
      channel_type: "platform",
      reason: "customer_requested" as const,
      priority: "normal" as const,
      summary: "Customer requested a person.",
      customer_message: null,
      status: "claimed" as const,
      requested_by: "agent:agent-1",
      claimed_by: "operator-1",
      claimed_at: new Date().toISOString(),
      resolved_by: null,
      resolved_at: null,
      resolution: null,
      metadata: {},
      idempotency_key: "handoff-1",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const conversation = {
      id: handoff.conversation_id,
      organization_id: handoff.organization_id,
      installation_id: handoff.installation_id,
      channel_type: "platform",
      channel_key: "platform",
      external_conversation_id: null,
      title: null,
      title_source: "fallback" as const,
      title_generated_at: null,
      title_locked: false,
      pinned: false,
      last_opened_at: null,
      last_read_at: null,
      model_provider: null,
      model: null,
      conversation_kind: "customer" as const,
      handoff_state: "human_owned" as const,
      handoff_revision: "1",
      handoff_requested_at: new Date().toISOString(),
      handoff_resolved_at: null,
      assigned_actor_id: "operator-1",
      last_message_at: null,
      last_message_direction: null,
      last_message_preview: null,
      message_count: 0,
      status: "active",
      owner_actor_id: null,
      is_primary: false,
      archived_at: null,
      rotated_from_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const message = {
      id: "77777777-7777-4777-8777-777777777777",
      conversation_id: conversation.id,
      organization_id: conversation.organization_id,
      participant_id: "88888888-8888-4888-8888-888888888888",
      direction: "outbound",
      message_type: "text",
      content: { text: "I can help." },
      provider: "kasitek-human",
      provider_message_id: "message-1",
      run_id: null,
      source_channel: "platform",
      source_connection_id: null,
      source_binding_id: null,
      external_conversation_id: null,
      occurred_at: new Date().toISOString(),
      delivery_status: "local",
      sequence_number: "1",
      created_at: new Date().toISOString(),
    };
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM agent_handoff_requests") && sql.includes("FOR UPDATE")) return { rows: [handoff] };
        if (sql.includes("FROM conversations WHERE organization_id")) return { rows: [conversation] };
        if (sql.includes("SELECT EXISTS (")) return { rows: [{ exists: false }] };
        if (sql.includes("FROM messages") && sql.includes("provider_message_id")) return { rows: [] };
        if (sql.includes("INSERT INTO participants")) return { rows: [{ id: message.participant_id }] };
        if (sql.includes("COALESCE(MAX(sequence_number)")) return { rows: [{ sequence_number: "1" }] };
        if (sql.includes("INSERT INTO messages")) return { rows: [message] };
        if (sql.includes("UPDATE conversations")) return { rows: [conversation] };
        if (sql.includes("INSERT INTO agent_events")) {
          eventTypes.push(String(values?.[3]));
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO analytics_outbox")) return { rows: [{ outbox_id: "outbox-1", source_sequence: "1" }] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    const result = await new HandoffRepository(pool).appendHumanMessage({
      organizationId: "org-1",
      handoffId: handoff.id,
      actorId: "operator-1",
      text: "I can help.",
      idempotencyKey: "message-1",
    });

    expect(result.created).toBe(true);
    expect(eventTypes).toEqual([
      "conversation.handoff.first_human_response",
      "conversation.human_message.sent",
    ]);
  });
});
