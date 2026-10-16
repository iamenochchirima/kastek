import { describe, expect, it } from "vitest";
import { buildRetrievalPlan, rankEvidencePack, type RetrievalCandidate } from "../src/memory/retrieval-planner";
import type { MemoryScope } from "../src/memory/contracts";

const scope = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  namespace: "agent_private" as const,
};

function candidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    revisionId: "revision-1",
    text: "The customer prefers concise replies.",
    kind: "semantic",
    scope,
    lifecycle: "active",
    readiness: "visible",
    sources: [],
    lexicalScore: 0.8,
    semanticScore: 0.8,
    confidence: 0.9,
    ...overrides,
  };
}

describe("typed memory retrieval planner", () => {
  it("produces typed plans instead of phrase-only retrieval decisions", () => {
    const plan = buildRetrievalPlan({ scope, query: "customer reply style", intent: "current_fact", decision: "required" });
    expect(plan).toMatchObject({ decision: "required", memoryKinds: ["semantic"], freshness: "current", plannerVersion: "typed-v1" });
  });

  it("filters lifecycle, readiness, and scope before ranking", () => {
    const plan = buildRetrievalPlan({ scope, query: "customer", intent: "semantic_context" });
    const pack = rankEvidencePack(plan, [
      candidate({ revisionId: "visible" }),
      candidate({ revisionId: "pending", readiness: "committed" }),
      candidate({ revisionId: "expired", lifecycle: "expired" }),
      candidate({ revisionId: "other-org", scope: { ...scope, organizationId: "org-2" } }),
    ]);
    expect(pack.items.map((item) => item.revisionId)).toEqual(["visible"]);
  });

  it("does not fabricate an evidence pack when no authorized candidate exists", () => {
    const plan = buildRetrievalPlan({ scope, query: "what do you know about this customer?", intent: "semantic_context" });
    const pack = rankEvidencePack(plan, [candidate({ lifecycle: "quarantined" }), candidate({ revisionId: "other", scope: { ...scope, installationId: "other-installation" } })]);
    expect(pack.items).toEqual([]);
    expect(pack.measuredTokens).toBe(0);
  });

  it("keeps historical retrieval separate from current validity filtering", () => {
    const historical = candidate({ revisionId: "old", validTo: "2025-01-01T00:00:00.000Z" });
    const currentPlan = buildRetrievalPlan({ scope, query: "old preference", intent: "current_fact" });
    const historicalPlan = buildRetrievalPlan({ scope, query: "old preference", intent: "historical_episode" });
    expect(rankEvidencePack(currentPlan, [historical], Date.parse("2026-09-07T00:00:00.000Z")).items).toHaveLength(0);
    expect(rankEvidencePack(historicalPlan, [candidate({ ...historical, kind: "episodic" })], Date.parse("2026-09-07T00:00:00.000Z")).items).toHaveLength(1);
  });

  it("excludes poisoned, superseded, and pending evidence before ranking", () => {
    const plan = buildRetrievalPlan({ scope, query: "reply style", intent: "current_fact" });
    const pack = rankEvidencePack(plan, [
      candidate({ revisionId: "poisoned", lifecycle: "quarantined" }),
      candidate({ revisionId: "superseded", lifecycle: "superseded" }),
      candidate({ revisionId: "pending", readiness: "accepted" }),
    ]);
    expect(pack.items).toEqual([]);
  });

  it("enforces the evidence token budget without truncating a revision", () => {
    const plan = buildRetrievalPlan({ scope, query: "customer", intent: "semantic_context", maxTokens: 256 });
    const pack = rankEvidencePack(plan, [candidate({ text: "x".repeat(1_200) })]);
    expect(pack.items).toHaveLength(0);
    expect(pack.measuredTokens).toBe(0);
  });

  it("deduplicates the same revision and keeps deterministic ranking", () => {
    const plan = buildRetrievalPlan({ scope, query: "customer", intent: "semantic_context" });
    const pack = rankEvidencePack(plan, [candidate(), candidate({ text: "same revision, lower score", lexicalScore: 0.1, semanticScore: 0.1 })]);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]?.text).toBe("The customer prefers concise replies.");
  });

  it("merges current revisions by stable fact identity but preserves history", () => {
    const currentPlan = buildRetrievalPlan({ scope, query: "reply style", intent: "current_fact" });
    const historicalPlan = buildRetrievalPlan({ scope, query: "reply style", intent: "historical_episode" });
    const revisions = [
      candidate({ revisionId: "old", factKey: "fact:reply-style", text: "Concise replies", lexicalScore: 0.6 }),
      candidate({ revisionId: "new", factKey: "fact:reply-style", text: "Detailed replies", lexicalScore: 0.9 }),
    ];
    expect(rankEvidencePack(currentPlan, revisions).items.map((item) => item.revisionId)).toEqual(["new"]);
    expect(rankEvidencePack(historicalPlan, revisions.map((item) => ({ ...item, kind: "episodic" as const }))).items.map((item) => item.revisionId)).toEqual(["new", "old"]);
  });

  it("prefers evidence from independent source events", () => {
    const plan = buildRetrievalPlan({ scope, query: "reply style", intent: "semantic_context", maxResults: 2 });
    const pack = rankEvidencePack(plan, [
      candidate({ revisionId: "same-source-strong", sources: [{ sourceEventId: "event-1", occurredAt: "2026-09-07T00:00:00.000Z", relation: "derived" }], lexicalScore: 1, semanticScore: 1 }),
      candidate({ revisionId: "same-source-weak", sources: [{ sourceEventId: "event-1", occurredAt: "2026-09-07T00:01:00.000Z", relation: "derived" }], lexicalScore: 0.99, semanticScore: 0.99 }),
      candidate({ revisionId: "independent", sources: [{ sourceEventId: "event-2", occurredAt: "2026-09-07T00:02:00.000Z", relation: "derived" }], lexicalScore: 0.7, semanticScore: 0.7 }),
    ]);
    expect(pack.items.map((item) => item.revisionId)).toEqual(["same-source-strong", "independent"]);
  });

  it("carries content-free contradiction lineage so operators can explain a selected claim", () => {
    const plan = buildRetrievalPlan({ scope, query: "reply style", intent: "historical_episode" });
    const pack = rankEvidencePack(plan, [candidate({
      revisionId: "revision-with-contradiction",
      kind: "episodic",
      relations: [{ relationType: "contradicts", relatedRevisionId: "revision-older" }],
    })]);
    expect(pack.items[0]?.relations).toEqual([{ relationType: "contradicts", relatedRevisionId: "revision-older" }]);
  });

  it("keeps private, conversation, agent, and workspace scopes isolated", () => {
    const plan = buildRetrievalPlan({
      scope: { ...scope, conversationId: "conversation-1", endUserId: "user-1" },
      query: "customer context",
      intent: "semantic_context",
      maxResults: 20,
    });
    const shared = (namespace: "conversation" | "end_user_private" | "agent_private" | "workspace_shared", extra: Partial<MemoryScope> = {}): RetrievalCandidate => candidate({
      revisionId: `revision-${namespace}-${extra.conversationId ?? extra.endUserId ?? "shared"}`,
      factKey: `fact-${namespace}-${extra.conversationId ?? extra.endUserId ?? "shared"}`,
      scope: { ...scope, conversationId: "conversation-1", endUserId: "user-1", namespace, ...extra },
    });
    const pack = rankEvidencePack(plan, [
      shared("conversation"),
      shared("end_user_private"),
      shared("agent_private"),
      shared("workspace_shared"),
      shared("conversation", { conversationId: "conversation-other" }),
      shared("end_user_private", { endUserId: "user-other" }),
      shared("agent_private", { installationId: "installation-other" }),
      shared("workspace_shared", { organizationId: "org-other" }),
    ]);
    expect(pack.items.map((item) => item.revisionId)).toEqual([
      "revision-conversation-shared",
      "revision-end_user_private-shared",
      "revision-agent_private-shared",
      "revision-workspace_shared-shared",
    ]);
  });

  it("enforces the installation namespace allow-list before ranking", () => {
    const plan = buildRetrievalPlan({
      scope: { ...scope, conversationId: "conversation-1", endUserId: "user-1" },
      query: "customer context",
      intent: "semantic_context",
      readableNamespaces: ["conversation", "workspace_shared"],
    });
    const allowedConversation = candidate({
      revisionId: "allowed-conversation",
      scope: { ...scope, conversationId: "conversation-1", namespace: "conversation" },
    });
    const allowedWorkspace = candidate({
      revisionId: "allowed-workspace",
      scope: { ...scope, conversationId: "conversation-1", namespace: "workspace_shared" },
    });
    const deniedPrivate = candidate({
      revisionId: "denied-private",
      scope: { ...scope, conversationId: "conversation-1", namespace: "agent_private" },
    });
    expect(rankEvidencePack(plan, [allowedConversation, allowedWorkspace, deniedPrivate]).items.map((item) => item.revisionId)).toEqual([
      "allowed-conversation",
      "allowed-workspace",
    ]);
  });
});
