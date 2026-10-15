import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ConversationHandoffService, type HandoffOfferRecord } from "../src/handoff/service";
import type { ConversationRecord } from "../src/db/repositories/conversation-repository";

const conversation = {
  id: "conversation-1",
  organization_id: "org-1",
  installation_id: "installation-1",
  channel_type: "messenger",
  conversation_kind: "customer",
  handoff_state: "agent_active",
} as ConversationRecord;

const installation = {
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  agent_audience: "customer_service" as const,
};

const offer = {
  id: "offer-1",
  organization_id: "org-1",
  installation_id: "installation-1",
  conversation_id: "conversation-1",
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  source_run_id: "run-1",
  source_message_id: null,
  channel_type: "messenger",
  reason: "agent_uncertain" as const,
  summary: "The agent cannot answer this safely.",
  status: "pending" as const,
  offered_by: "agent:agent-1",
  decision_message_id: null,
  classifier_version: "v1-en",
  idempotency_key: "offer-key",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  decided_at: null,
  metadata: { priority: "normal" },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} satisfies HandoffOfferRecord;

function clientForOffer(): PoolClient {
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM agent_handoff_offers") && normalized.includes("idempotency_key")) return { rows: [] };
    if (normalized.includes("FROM agent_installations")) return { rows: [installation] };
    if (normalized.includes("FROM conversations") && normalized.includes("FOR UPDATE")) return { rows: [conversation] };
    if (normalized.includes("INSERT INTO agent_handoff_offers")) return { rows: [offer] };
    if (normalized.includes("INSERT INTO agent_events")) return { rows: [] };
    throw new Error(`Unexpected query: ${normalized}`);
  });
  return { query } as unknown as PoolClient;
}

function clientForDecision(decision: "confirm" | "decline" | "duplicate"): PoolClient {
  const accepted = { ...offer, status: "accepted" as const, decision_message_id: "message-2" };
  const declined = { ...offer, status: "declined" as const, decision_message_id: "message-2" };
  const handoff = {
    id: "handoff-1",
    organization_id: "org-1",
    installation_id: "installation-1",
    conversation_id: "conversation-1",
    agent_definition_id: "agent-1",
    agent_version_id: "version-1",
    run_id: "run-1",
    channel_type: "messenger",
    reason: "agent_uncertain" as const,
    priority: "normal" as const,
    summary: offer.summary,
    customer_message: "Yes, please do that",
    request_source: "customer_confirmed" as const,
    source_message_id: "message-2",
    offer_id: "offer-1",
    consented_at: new Date().toISOString(),
    classifier_version: "v1-en",
    status: "pending" as const,
  };
  const updatedConversation = { ...conversation, handoff_state: "handoff_requested" as const };
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM agent_handoff_offers") && normalized.includes("status = 'pending'")) return { rows: [offer] };
    if (normalized.includes("FROM conversations") && normalized.includes("FOR UPDATE")) return { rows: [conversation] };
    if (normalized.includes("FROM agent_installations")) return { rows: [installation] };
    if (normalized.includes("FROM agent_handoff_requests")) return { rows: decision === "duplicate" ? [handoff] : [] };
    if (normalized.includes("INSERT INTO agent_handoff_requests")) return { rows: [handoff] };
    if (normalized.includes("UPDATE agent_handoff_offers")) return { rows: [decision === "confirm" ? accepted : declined] };
    if (normalized.includes("UPDATE conversations")) return { rows: [updatedConversation] };
    if (normalized.includes("SELECT * FROM conversations WHERE organization_id")) return { rows: [conversation] };
    if (normalized.includes("INSERT INTO agent_events")) return { rows: [] };
    throw new Error(`Unexpected query: ${normalized}`);
  });
  return { query } as unknown as PoolClient;
}

function clientForDirectRequest(): PoolClient {
  const handoff = {
    id: "handoff-direct-1",
    organization_id: "org-1",
    installation_id: "installation-1",
    conversation_id: "conversation-1",
    agent_definition_id: "agent-1",
    agent_version_id: "version-1",
    run_id: null,
    channel_type: "messenger",
    reason: "customer_requested" as const,
    priority: "normal" as const,
    summary: "Customer explicitly requested a human conversation.",
    customer_message: "I need a real person, please.",
    request_source: "customer_direct" as const,
    source_message_id: "message-direct-1",
    offer_id: null,
    consented_at: new Date().toISOString(),
    classifier_version: "v1-en",
    status: "pending" as const,
  };
  const updatedConversation = { ...conversation, handoff_state: "handoff_requested" as const };
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM agent_handoff_offers")) return { rows: [] };
    if (normalized.includes("FROM conversations") && normalized.includes("FOR UPDATE")) return { rows: [conversation] };
    if (normalized.includes("FROM agent_installations")) return { rows: [installation] };
    if (normalized.includes("FROM agent_handoff_requests")) return { rows: [] };
    if (normalized.includes("INSERT INTO agent_handoff_requests")) return { rows: [handoff] };
    if (normalized.includes("UPDATE conversations")) return { rows: [updatedConversation] };
    if (normalized.includes("INSERT INTO agent_events")) return { rows: [] };
    throw new Error(`Unexpected query: ${normalized}`);
  });
  return { query } as unknown as PoolClient;
}

describe("conversation handoff state machine", () => {
  it("records an offer without changing conversation ownership", async () => {
    const result = await new ConversationHandoffService().offer(clientForOffer(), {
      organizationId: "org-1",
      installationId: "installation-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      runId: "run-1",
      conversationId: "conversation-1",
      reason: "agent_uncertain",
      summary: offer.summary,
      idempotencyKey: "offer-key",
    });
    expect(result.offer.status).toBe("pending");
    expect(result.conversation.handoff_state).toBe("agent_active");
  });

  it("creates a request only after an explicit confirmation", async () => {
    const result = await new ConversationHandoffService().decideInbound(clientForDecision("confirm"), {
      organizationId: "org-1",
      installationId: "installation-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      conversationId: "conversation-1",
      messageId: "message-2",
      channelType: "messenger",
      content: { text: "Yes, please do that" },
      customerMessage: "Yes, please do that",
    });
    expect(result.kind).toBe("requested");
    if (result.kind === "requested") {
      expect(result.handoff.request_source).toBe("customer_confirmed");
      expect(result.conversation.handoff_state).toBe("handoff_requested");
    }
  });

  it("creates a direct customer request without an offer", async () => {
    const result = await new ConversationHandoffService().decideInbound(clientForDirectRequest(), {
      organizationId: "org-1",
      installationId: "installation-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      conversationId: "conversation-1",
      messageId: "message-direct-1",
      channelType: "messenger",
      content: { text: "I need a real person, please." },
      customerMessage: "I need a real person, please.",
    });
    expect(result.kind).toBe("requested");
    if (result.kind === "requested") {
      expect(result.offer).toBeNull();
      expect(result.handoff.request_source).toBe("customer_direct");
      expect(result.handoff.offer_id).toBeNull();
    }
  });

  it("closes an offer without creating a request when the customer declines", async () => {
    const result = await new ConversationHandoffService().decideInbound(clientForDecision("decline"), {
      organizationId: "org-1",
      installationId: "installation-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      conversationId: "conversation-1",
      messageId: "message-2",
      channelType: "messenger",
      content: { text: "No thanks, keep helping me" },
      customerMessage: "No thanks, keep helping me",
    });
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") expect(result.offer.status).toBe("declined");
  });

  it("returns the existing request for a duplicate confirmation", async () => {
    const result = await new ConversationHandoffService().decideInbound(clientForDecision("duplicate"), {
      organizationId: "org-1",
      installationId: "installation-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      conversationId: "conversation-1",
      messageId: "message-2",
      channelType: "messenger",
      content: { text: "Yes, please do that" },
      customerMessage: "Yes, please do that",
    });
    expect(result.kind).toBe("requested");
    if (result.kind === "requested") expect(result.handoff.id).toBe("handoff-1");
  });

  it("expires stale offers without changing conversation ownership", async () => {
    const expiredOffer = { ...offer, expires_at: new Date(Date.now() - 1_000).toISOString(), status: "expired" as const };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("SELECT * FROM agent_handoff_offers")) return { rows: [offer] };
      if (normalized.includes("UPDATE agent_handoff_offers")) return { rows: [expiredOffer] };
      if (normalized.includes("INSERT INTO agent_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const count = await new ConversationHandoffService().expirePendingOffers({ query } as unknown as PoolClient, "org-1");
    expect(count).toBe(1);
  });
});
