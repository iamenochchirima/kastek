import { describe, expect, it, vi } from "vitest";
import { HandoffRepository } from "../src/db/repositories/handoff-repository";

describe("handoff repository lifecycle", () => {
  it("limits event-stream ownership to customer conversations on customer-service installations", async () => {
    const query = vi.fn(async () => ({ rows: [{ exists: false }] }));
    const pool = { query } as never;
    const repository = new HandoffRepository(pool);

    await expect(repository.conversationExists("org-1", "conversation-1")).resolves.toBe(false);
    const existsSql = String(query.mock.calls[0]?.[0]);
    expect(existsSql).toContain("ad.agent_audience = 'customer_service'");
    expect(existsSql).toContain("c.conversation_kind = 'customer'");

    query.mockResolvedValueOnce({ rows: [] });
    await repository.listConversationEventsAfter("org-1", "conversation-1", 4);
    const eventsSql = String(query.mock.calls[1]?.[0]);
    expect(eventsSql).toContain("c.conversation_kind = 'customer'");
    expect(eventsSql).toContain("ad.agent_audience = 'customer_service'");
    expect(query.mock.calls[1]?.[1]).toEqual(["org-1", "conversation:conversation-1", 4, "conversation-1"]);
  });

  it("lists active customer conversations across the supported channel types", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "conversation-1", channel_type: "facebook" }] }));
    const repository = new HandoffRepository({ query } as never);

    const result = await repository.listCustomer("org-1", {
      channelType: "messenger",
      search: "Jane",
      limit: 25,
    });

    expect(result.items).toEqual([{ id: "conversation-1", channel_type: "facebook" }]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("c.conversation_kind = 'customer'");
    expect(sql).toContain("ad.agent_audience = 'customer_service'");
    expect(sql).toContain("c.channel_type = ANY($2::text[])");
    expect(query.mock.calls[0]?.[1]).toEqual(["org-1", ["facebook", "messenger"], "%Jane%", 25]);
  });

  it("defines Live from recent conversation activity and ownership, not active runs", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "conversation-1", channel_type: "instagram" }] }));
    const repository = new HandoffRepository({ query } as never);

    const result = await repository.listLive("org-1", { limit: 10 });

    expect(result.items).toEqual([{ conversation: { id: "conversation-1", channel_type: "instagram" } }]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("c.handoff_state = 'agent_active'");
    expect(sql).toContain("c.last_message_at >= NOW() - INTERVAL '30 minutes'");
    expect(sql).not.toContain("JOIN agent_runs");
    expect(query.mock.calls[0]?.[1]).toEqual(["org-1", 10]);
  });

  it("returns queue counts from the same customer-service conversation scope", async () => {
    const query = vi.fn(async () => ({ rows: [{ all: 4, live: 2, inbox: 1, mine: 1, team: 1 }] }));
    const repository = new HandoffRepository({ query } as never);

    await expect(repository.getSummary("org-1", "operator-1", { channelType: "messenger", search: "Jane" })).resolves.toEqual({
      all: 4,
      live: 2,
      inbox: 1,
      mine: 1,
      team: 1,
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("COUNT(*) FILTER");
    expect(sql).toContain("c.handoff_state = 'agent_active'");
    expect(sql).toContain("c.assigned_actor_id = $2");
    expect(sql).toContain("c.assigned_actor_id <> $2");
    expect(query.mock.calls[0]?.[1]).toEqual(["org-1", "operator-1", ["facebook", "messenger"], "%Jane%"]);
  });

  it("separates the current operator's assignments from the team queue", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new HandoffRepository({ query } as never);
    vi.spyOn(repository, "expirePending").mockResolvedValue(0);

    await repository.listQueue("org-1", { status: "claimed", assignment: "mine", actorId: "operator-1" });
    expect(String(query.mock.calls[0]?.[0])).toContain("h.claimed_by = $3");
    expect(query.mock.calls[0]?.[1]).toEqual(["org-1", ["claimed"], "operator-1", 51]);

    query.mockClear();
    await repository.listQueue("org-1", { status: "claimed", assignment: "team", actorId: "operator-1" });
    expect(String(query.mock.calls[0]?.[0])).toContain("h.claimed_by <> $3");
    expect(query.mock.calls[0]?.[1]).toEqual(["org-1", ["claimed"], "operator-1", 51]);
  });

  it("emits first-human-response before the per-message event", async () => {
    const eventTypes: string[] = [];
    const auditRecords: Array<{ action: string; metadata: Record<string, unknown> }> = [];
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
        if (sql.includes("FROM conversations c") && sql.includes("JOIN agent_definitions ad")) {
          return {
            rows: [{
              conversation_id: conversation.id,
              organization_id: conversation.organization_id,
              installation_id: conversation.installation_id,
              conversation_kind: conversation.conversation_kind,
              channel_type: conversation.channel_type,
              status: conversation.status,
              handoff_state: conversation.handoff_state,
              agent_definition_id: handoff.agent_definition_id,
              agent_version_id: handoff.agent_version_id,
              agent_audience: "customer_service",
            }],
          };
        }
        if (sql.includes("FROM conversations WHERE organization_id")) return { rows: [conversation] };
        if (sql.includes("SELECT participant_type FROM participants")) return { rows: [{ participant_type: "staff" }] };
        if (sql.includes("GREATEST(0") && sql.includes("FROM messages m")) return { rows: [{ response_time_ms: null }] };
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
        if (sql.includes("INSERT INTO audit_records")) {
          auditRecords.push({ action: String(values?.[3]), metadata: JSON.parse(String(values?.[7])) as Record<string, unknown> });
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
    expect(auditRecords.map((record) => record.action)).toEqual([
      "agent_handoff.first_human_response",
      "agent_handoff.human_message",
    ]);
    expect(JSON.stringify(auditRecords)).not.toContain("I can help.");
  });

  it("creates an idempotent transcript-backed run when the source run is terminal", async () => {
    const handoffId = "11111111-1111-4111-8111-111111111111";
    const sourceRunId = "66666666-6666-4666-8666-666666666666";
    const eventTypes: string[] = [];
    const handoff = {
      id: handoffId,
      organization_id: "org-1",
      installation_id: "22222222-2222-4222-8222-222222222222",
      conversation_id: "33333333-3333-4333-8333-333333333333",
      agent_definition_id: "44444444-4444-4444-8444-444444444444",
      agent_version_id: "55555555-5555-4555-8555-555555555555",
      run_id: sourceRunId,
      channel_type: "whatsapp",
      reason: "customer_requested" as const,
      priority: "normal" as const,
      summary: "Customer requested a person.",
      customer_message: "Please connect me to support.",
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
      channel_type: "whatsapp",
      handoff_state: "human_owned" as const,
      model_provider: "openrouter",
      model: "test-model",
    };
    const resumedConversation = { ...conversation, handoff_state: "agent_active" as const };
    const resolvedHandoff = { ...handoff, status: "resolved" as const, resolution: "continued_with_agent" };
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM agent_handoff_requests") && sql.includes("FOR UPDATE")) return { rows: [{ ...handoff, conversation }] };
        if (sql.includes("FROM conversations WHERE organization_id")) return { rows: [conversation] };
        if (sql.includes("UPDATE agent_handoff_requests")) return { rows: [resolvedHandoff] };
        if (sql.includes("UPDATE conversations")) return { rows: [resumedConversation] };
        if (sql.includes("FROM agent_runs") && sql.includes("status = ANY")) return { rows: [] };
        if (sql.includes("FROM agent_runs") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: sourceRunId, status: "cancelled", reply_channel_type: "whatsapp", reply_binding_id: "binding-1", resolved_model_provider: "openrouter", resolved_model: "test-model" }] };
        }
        if (sql.includes("FROM messages") && sql.includes("direction = 'inbound'")) {
          return { rows: [{ content: { text: "Latest customer message" }, source_channel: "whatsapp", source_binding_id: "binding-1" }] };
        }
        if (sql.includes("INSERT INTO agent_runs")) return { rows: [{ id: "fresh-run-1", correlation_id: "fresh-correlation" }] };
        if (sql.includes("INSERT INTO agent_events")) {
          eventTypes.push(sql.includes("'run.received'") ? "run.received" : String(values?.[3]));
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO audit_records")) return { rows: [] };
        if (sql.includes("INSERT INTO analytics_outbox")) return { rows: [{ outbox_id: "outbox-1", source_sequence: "1" }] };
        if (sql.includes("INSERT INTO run_attempts") || sql.includes("INSERT INTO run_workflow_state")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    const result = await new HandoffRepository(pool).continueWithAgent({
      organizationId: "org-1",
      handoffId,
      actorId: "operator-1",
      resolution: "resume automation",
    });

    expect(result.changed).toBe(true);
    expect(result.continuationRunId).toBe("fresh-run-1");
    expect(result.continuationRunCreated).toBe(true);
    expect(eventTypes).toContain("run.received");
    expect(eventTypes).toContain("conversation.handoff.continued");
  });
});
