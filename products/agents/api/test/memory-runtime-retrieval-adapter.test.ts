import { describe, expect, it, vi } from "vitest";
import { createRuntimeMemoryRetrievalPort } from "../src/memory/runtime-retrieval-adapter";

const scope = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  namespace: "conversation" as const,
  conversationId: "conversation-1",
};

describe("runtime memory retrieval adapter", () => {
  it("plans and maps scoped visible revisions into runtime evidence", async () => {
    const repository = {
      search: async () => [{
        revisionId: "revision-1",
        text: "The customer prefers concise replies.",
        kind: "semantic" as const,
        scope,
        lifecycle: "active" as const,
        readiness: "visible" as const,
        sources: [{ sourceEventId: "event-1", occurredAt: "2026-09-07T00:00:00.000Z", relation: "derived" as const }],
        validFrom: "2026-09-07T00:00:00.000Z",
        confidence: 0.9,
        lexicalScore: 1,
      }],
    };
    const port = createRuntimeMemoryRetrievalPort(repository as never);
    const result = await port.retrieve({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: ["event-1"], digest: "boundary-1" },
      scope,
      reason: "current_fact",
      query: "reply style",
    });
    expect(result).toMatchObject({ status: "completed", packId: expect.stringMatching(/^memory-pack:/) });
    expect(result.evidence[0]).toMatchObject({ evidenceId: "revision-1", redactedContent: "The customer prefers concise replies.", lifecycleState: "active" });
  });

  it("blocks untyped retrieval reasons instead of guessing a storage query", async () => {
    const port = createRuntimeMemoryRetrievalPort({ search: async () => [] } as never);
    const result = await port.retrieve({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: [], digest: "boundary-1" },
      scope,
      reason: "context_runtime",
      query: "anything",
    });
    expect(result).toMatchObject({ status: "blocked", evidence: [], blockedReason: "MEMORY_RETRIEVAL_INTENT_REQUIRED" });
  });

  it("admits end-user-private scope without widening it to a workspace read", async () => {
    const userScope = { ...scope, conversationId: undefined, namespace: "end_user_private" as const, endUserId: "user-1" };
    const search = vi.fn().mockResolvedValue([]);
    const port = createRuntimeMemoryRetrievalPort({ search } as never);
    await expect(port.retrieve({
      runId: "run-private",
      turnId: "turn-private",
      attemptId: "attempt-private",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: [], digest: "boundary-private" },
      scope: userScope,
      reason: "current_fact",
      query: "private preference",
    })).resolves.toMatchObject({ status: "completed", evidence: [] });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      endUserId: "user-1",
      conversationId: undefined,
    }));
  });

  it("passes the policy namespace allow-list into the typed plan and repository query", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const port = createRuntimeMemoryRetrievalPort({ search } as never);
    await port.retrieve({
      runId: "run-policy",
      turnId: "turn-policy",
      attemptId: "attempt-policy",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: [], digest: "boundary-policy" },
      scope: { ...scope, readableNamespaces: ["conversation", "workspace_shared"] },
      reason: "semantic_context",
      query: "customer context",
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      readableNamespaces: ["conversation", "workspace_shared"],
    }));
  });

  it("fails closed to the requested namespace when no allow-list is supplied", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const port = createRuntimeMemoryRetrievalPort({ search } as never);
    await port.retrieve({
      runId: "run-default-policy",
      turnId: "turn-default-policy",
      attemptId: "attempt-default-policy",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: [], digest: "boundary-default-policy" },
      scope,
      reason: "semantic_context",
      query: "customer context",
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      readableNamespaces: ["conversation"],
    }));
  });

  it("records bounded usage events for selected revisions when the quality sink is available", async () => {
    const quality = { recordQualityEvent: vi.fn().mockResolvedValue({ status: "created", id: "quality-1" }) };
    const repository = {
      search: async () => [{
        revisionId: "revision-usage",
        text: "The customer prefers concise replies.",
        kind: "semantic" as const,
        scope,
        lifecycle: "active" as const,
        readiness: "visible" as const,
        sources: [{ sourceEventId: "event-usage", occurredAt: "2026-09-07T00:00:00.000Z", relation: "derived" as const }],
        validFrom: "2026-09-07T00:00:00.000Z",
        lexicalScore: 1,
      }],
    };
    const port = createRuntimeMemoryRetrievalPort(repository as never, quality as never);
    const result = await port.retrieve({
      runId: "run-usage",
      turnId: "turn-usage",
      attemptId: "attempt-usage",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: ["event-usage"], digest: "boundary-usage" },
      scope,
      reason: "current_fact",
      query: "reply style",
    });
    expect(result.status).toBe("completed");
    expect(quality.recordQualityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "usage",
      revisionId: "revision-usage",
      sourceRunId: "run-usage",
      idempotencyKey: "memory-usage:run-usage:turn-usage:revision-usage",
    }));
  });

  it("persists a content-free retrieval decision with gate metadata and diagnostics", async () => {
    const decisions = { record: vi.fn().mockResolvedValue("created") };
    const repository = {
      search: async () => [{
        revisionId: "revision-diagnostic",
        text: "The customer prefers concise replies.",
        kind: "semantic" as const,
        factKey: "fact:stable",
        scope,
        lifecycle: "active" as const,
        readiness: "visible" as const,
        sources: [{ sourceEventId: "event-diagnostic", occurredAt: "2026-09-07T00:00:00.000Z", relation: "derived" as const }],
        validFrom: "2026-09-07T00:00:00.000Z",
        lexicalScore: 1,
      }],
    };
    const port = createRuntimeMemoryRetrievalPort(repository as never, undefined, undefined, decisions as never);
    const result = await port.retrieve({
      runId: "run-diagnostic",
      turnId: "turn-diagnostic",
      attemptId: "attempt-diagnostic",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: ["event-diagnostic"], digest: "boundary-diagnostic" },
      scope,
      reason: "current_fact",
      query: "reply style",
      gate: { source: "small_model", model: "memory-gate", confidence: 0.91, latencyMs: 12 },
    });
    expect(result.diagnostics).toMatchObject({ candidateCount: 1, selectedRevisionIds: ["revision-diagnostic"] });
    expect(decisions.record).toHaveBeenCalledWith(expect.objectContaining({
      query: "reply style",
      gate: expect.objectContaining({ source: "small_model" }),
      selectedRevisionIds: ["revision-diagnostic"],
      measuredTokens: expect.any(Number),
    }));
  });
});
