import { describe, expect, it, vi } from "vitest";
import { MemoryLifecycle, missingMemoryScopeRequirements } from "../src/memory/lifecycle";
import { normalizeMemoryPolicy } from "../src/memory/policy";
import { decideMemoryRetrieval, retrievalGate } from "../src/memory/retrieval";

describe("memory policy", () => {
  it("identifies missing namespace scope without broadening retrieval", () => {
    expect(missingMemoryScopeRequirements({ organizationId: "org", agentId: "agent" }, ["organization_shared", "agent_private", "conversation", "user_private"])).toEqual(["missing_installation", "missing_conversation", "missing_actor"]);
    expect(missingMemoryScopeRequirements({ organizationId: "org", agentId: "agent", installationId: "install", conversationId: "conversation", actorId: "actor" }, ["agent_private", "conversation", "user_private"])).toEqual([]);
  });
  it("normalizes unknown and excessive user policy values to bounded defaults", () => {
    expect(normalizeMemoryPolicy({ mode: "not-a-mode", maxRetrieved: 999, maxWritesPerRun: -4, readableNamespaces: ["agent_private", "bad"], allowSensitive: true })).toMatchObject({
      mode: "explicit",
      maxRetrieved: 50,
      maxRetrievedTokens: 1600,
      maxWritesPerRun: 0,
      readableNamespaces: ["agent_private"],
      allowSensitive: true,
    });
  });

  it("bounds the retrieval token budget independently from result count", () => {
    expect(normalizeMemoryPolicy({ maxRetrievedTokens: 99_999 })).toMatchObject({ maxRetrievedTokens: 8_000 });
    expect(normalizeMemoryPolicy({ maxRetrievedTokens: 12 })).toMatchObject({ maxRetrievedTokens: 256 });
  });

  it("allows a policy to disable retrieval and writes", async () => {
    const repository = { searchMemory: vi.fn(), createMemory: vi.fn(), countWritesForRun: vi.fn() };
    const lifecycle = new MemoryLifecycle(repository as never);
    expect(decideMemoryRetrieval("What did we discuss before?", { policy: { memory: { mode: "disabled" } } })).toMatchObject({ requested: false, reason: "policy_disabled" });
    await expect(lifecycle.rememberExplicit({ organizationId: "org", agentId: "agent", installationId: "install", actorId: "user" }, { namespace: "agent_private", memoryType: "semantic", canonicalText: "fact" }, { memory: { mode: "disabled" } })).rejects.toThrow("MEMORY_DISABLED");
    expect(repository.searchMemory).not.toHaveBeenCalled();
  });

  it("recognizes direct references and contextual paraphrases with an explainable reason", () => {
    expect(decideMemoryRetrieval("What did we discuss about the launch?", { policy: { memory: { mode: "explicit" } } })).toMatchObject({ requested: true, reason: "contextual_question" });
    expect(decideMemoryRetrieval("Please use my usual reply style.", { policy: { memory: { mode: "explicit" } } })).toMatchObject({ requested: true, reason: "preference_reference" });
    expect(decideMemoryRetrieval("Draft a new welcome email.", { policy: { memory: { mode: "explicit" } } })).toMatchObject({ requested: false, reason: "not_requested" });
    expect(retrievalGate("Where were we before?")).toBe(true);
  });

  it("bounds retrieval to policy namespaces and does not return sensitive evidence by default", async () => {
    const records = [
      { id: "normal", namespace: "agent_private", sensitivity: "normal" },
      { id: "sensitive", namespace: "agent_private", sensitivity: "sensitive" },
    ];
    const repository = { searchMemory: vi.fn().mockResolvedValue(records) };
    const lifecycle = new MemoryLifecycle(repository as never);
    const result = await lifecycle.search({ organizationId: "org", agentId: "agent", installationId: "install", actorId: "user" }, "reply style", { memory: { readableNamespaces: ["agent_private"], maxRetrieved: 4 } });
    expect(result).toEqual([records[0]]);
    expect(repository.searchMemory).toHaveBeenCalledWith(expect.anything(), "reply style", 4, ["agent_private"]);
  });

  it("does not broaden an explicitly empty namespace allowlist", async () => {
    const repository = { searchMemory: vi.fn() };
    const lifecycle = new MemoryLifecycle(repository as never);
    await expect(lifecycle.search({ organizationId: "org", agentId: "agent" }, "reply style", { memory: { readableNamespaces: [] } })).resolves.toEqual([]);
    expect(repository.searchMemory).not.toHaveBeenCalled();
  });

  it("only writes explicit, allowed memory and applies retention", async () => {
    const repository = { createMemory: vi.fn().mockResolvedValue({ id: "memory-1" }), countWritesForRun: vi.fn().mockResolvedValue(0) };
    const lifecycle = new MemoryLifecycle(repository as never);
    await lifecycle.rememberExplicit({ organizationId: "org", agentId: "agent", installationId: "install", actorId: "user", runId: "run" }, { namespace: "agent_private", memoryType: "semantic", canonicalText: "  User prefers concise replies  " }, { memory: { mode: "explicit", retentionDays: 30 } });
    expect(repository.createMemory).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "explicit", canonicalText: "User prefers concise replies", expiresAt: expect.any(String), allowInferred: false, provenance: { sourceRunId: "run" } }));
    repository.countWritesForRun.mockResolvedValue(3);
    await expect(lifecycle.rememberExplicit({ organizationId: "org", agentId: "agent", installationId: "install", actorId: "user", runId: "run" }, { namespace: "agent_private", memoryType: "semantic", canonicalText: "another" }, { memory: { mode: "explicit", maxWritesPerRun: 3 } })).rejects.toThrow("MEMORY_WRITE_LIMIT_EXCEEDED");
    await expect(lifecycle.rememberExplicit({ organizationId: "org", agentId: "agent", installationId: "install", actorId: "user" }, { namespace: "organization_shared", memoryType: "semantic", canonicalText: "shared" }, { memory: { mode: "explicit" } })).rejects.toThrow("MEMORY_NAMESPACE_NOT_ALLOWED");
  });

  it("routes inferred candidates through reviewed or automatic policy only", async () => {
    const repository = { createMemory: vi.fn().mockResolvedValue({ id: "memory-inferred" }), countWritesForRun: vi.fn().mockResolvedValue(0) };
    const lifecycle = new MemoryLifecycle(repository as never);
    await lifecycle.rememberInferred(
      { organizationId: "org", agentId: "agent", installationId: "install", conversationId: "conversation", actorId: "user", runId: "run" },
      {
        namespace: "agent_private",
        memoryType: "semantic",
        canonicalText: "User preference: concise updates",
        confidence: 0.72,
        factKey: "preference:concise updates",
        provenance: { sourceMessageIds: ["message-1"], extractionVersion: "deterministic-v1" },
      },
      { memory: { mode: "reviewed" } },
    );
    expect(repository.createMemory).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "inferred", sourceTrust: "model_inferred", reviewRequired: true, allowInferred: true, provenance: expect.objectContaining({ sourceRunId: "run" }) }));
    await expect(lifecycle.rememberInferred(
      { organizationId: "org", agentId: "agent", installationId: "install" },
      { namespace: "agent_private", memoryType: "semantic", canonicalText: "fact", provenance: {} },
      { memory: { mode: "explicit" } },
    )).rejects.toThrow("MEMORY_INFERENCE_DISABLED");
  });
});
