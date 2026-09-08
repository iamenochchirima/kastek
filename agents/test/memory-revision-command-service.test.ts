import { describe, expect, it, vi } from "vitest";
import { MemoryRevisionCommandService } from "../src/memory/revision-command-service";
import { MemoryRevisionRetrievalRepository } from "../src/db/repositories/memory-revision-retrieval-repository";
import type { ToolInvocationContext } from "../src/tools/types";

function context(runId: string): ToolInvocationContext {
  return {
    scope: {
      organizationId: "org-1",
      installationId: "installation-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      runId,
      actorId: "user-1",
      correlationId: `correlation-${runId}`,
    },
    organizationId: "org-1",
    agentId: "agent-1",
    agentVersionId: "version-1",
    installationId: "installation-1",
    runId,
    actorId: "user-1",
    correlationId: `correlation-${runId}`,
  };
}

describe("memory correction command", () => {
  it("does not route procedural instructions through factual revisions", async () => {
    const service = new MemoryRevisionCommandService({ query: vi.fn() } as never, {} as never);
    await expect(service.rememberExplicit({
      context: context("run-procedural"),
      namespace: "agent_private",
      memoryType: "procedural",
      text: "Always ask for approval before publishing.",
    })).rejects.toThrow("MEMORY_TYPE_NOT_SUPPORTED_BY_REVISION_DOMAIN");
  });

  it("keeps one winner active and turns the losing stable-fact correction into review", async () => {
    const initial = { id: "revision-1", memoryType: "semantic" as const, lifecycleState: "active" as const };
    const winner = { id: "revision-2", memoryType: "semantic" as const, lifecycleState: "active" as const };
    let resolveCalls = 0;
    let winnerCommitted = false;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const revisions = {
      createFact: vi.fn().mockResolvedValue({ id: "fact-1" }),
      findFact: vi.fn().mockResolvedValue({ id: "fact-1" }),
      resolveCurrent: vi.fn().mockImplementation(async () => {
        resolveCalls += 1;
        if (resolveCalls <= 2) {
          if (resolveCalls === 2) release();
          await bothRead;
          return initial;
        }
        return winner;
      }),
      appendRevision: vi.fn().mockImplementation(async (_factId: string, input: { lifecycleState: string }, expected?: string) => {
        if (expected === "revision-1" && input.lifecycleState === "active") {
          if (!winnerCommitted) {
            winnerCommitted = true;
            return { status: "created", revision: winner };
          }
          throw Object.assign(new Error("MEMORY_STALE_EXPECTED_REVISION"), { code: "MEMORY_STALE_EXPECTED_REVISION" });
        }
        expect(expected).toBe("revision-2");
        expect(input.lifecycleState).toBe("review_pending");
        return { status: "created", revision: { id: "revision-3" } };
      }),
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ scope_id: "workspace-1" }] }) };
    const service = new MemoryRevisionCommandService(pool as never, revisions as never);

    const results = await Promise.all([
      service.correct({ context: context("run-1"), namespace: "agent_private", memoryType: "semantic", text: "Concise replies", expectedRevisionId: initial.id }),
      service.correct({ context: context("run-2"), namespace: "agent_private", memoryType: "semantic", text: "Detailed replies", expectedRevisionId: initial.id }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "review_pending"]);
    const review = results.find((result) => result.status === "review_pending");
    expect(review).toMatchObject({
      conflict: {
        reason: "concurrent_correction",
        expectedRevisionId: "revision-1",
        observedRevisionId: "revision-2",
      },
    });
    expect(revisions.appendRevision).toHaveBeenCalledWith("fact-1", expect.objectContaining({
      lifecycleState: "review_pending",
      transitionType: "correction",
      predecessorRevisionId: "revision-2",
      provenance: expect.objectContaining({ conflictType: "concurrent_correction" }),
    }), "revision-2");
  });

  it("routes the v2 memory tool through the typed planner and preserves sensitivity", async () => {
    const retrieval = vi.spyOn(MemoryRevisionRetrievalRepository.prototype, "search").mockResolvedValue([{
      revisionId: "revision-sensitive",
      text: "The customer has a restricted account note.",
      kind: "semantic",
      factKey: "fact:account-note",
      scope: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        installationId: "installation-1",
        namespace: "agent_private",
      },
      lifecycle: "active",
      readiness: "visible",
      sources: [],
      sensitivity: "restricted",
      lexicalScore: 1,
    }]);
    try {
      const result = await new MemoryRevisionCommandService(
        { query: vi.fn().mockResolvedValue({ rows: [{ scope_id: "workspace-1" }] }) } as never,
        {} as never,
      ).search({
        context: {
          ...context("run-search"),
          memoryPolicy: {
            mode: "explicit",
            readableNamespaces: ["agent_private"],
            maxRetrieved: 1,
            maxRetrievedTokens: 512,
            allowSensitive: true,
          },
        },
        query: "account note",
        limit: 20,
        allowSensitive: true,
      });
      expect(retrieval).toHaveBeenCalledWith(expect.objectContaining({
        memoryKinds: ["semantic", "episodic"],
        freshness: "any",
        limit: 4,
        readableNamespaces: ["agent_private"],
        allowSensitive: true,
      }));
      expect(result).toEqual([expect.objectContaining({
        id: "revision-sensitive",
        sensitivity: "restricted",
      })]);
    } finally {
      retrieval.mockRestore();
    }
  });

  it("does not query the v2 index when memory is disabled", async () => {
    const retrieval = vi.spyOn(MemoryRevisionRetrievalRepository.prototype, "search");
    try {
      const result = await new MemoryRevisionCommandService(
        { query: vi.fn().mockResolvedValue({ rows: [{ scope_id: "workspace-1" }] }) } as never,
        {} as never,
      ).search({
        context: {
          ...context("run-disabled"),
          memoryPolicy: { mode: "disabled", maxRetrieved: 10 },
        },
        query: "should not be read",
      });
      expect(result).toEqual([]);
      expect(retrieval).not.toHaveBeenCalled();
    } finally {
      retrieval.mockRestore();
    }
  });
});
