import { describe, expect, it, vi } from "vitest";
import { RetrievalService, decideMemoryRetrieval } from "../src/memory/retrieval";

describe("structured retrieval", () => {
  it("recognizes paraphrased references without relying on the old trigger phrases", () => {
    expect(decideMemoryRetrieval("What was the launch date we agreed on?", { policy: { memory: { mode: "explicit" } } })).toMatchObject({
      requested: true,
      reason: "semantic_reference",
      reasonCode: "semantic_reference",
      sourceTypes: ["memory", "knowledge"],
    });
    expect(decideMemoryRetrieval("Can you draft a new welcome email?", { policy: { memory: { mode: "explicit" } } })).toMatchObject({
      requested: false,
      reason: "not_requested",
      sourceTypes: ["memory", "knowledge"],
    });
  });

  it("keeps disabled memory out of the source plan while preserving knowledge retrieval", () => {
    expect(decideMemoryRetrieval("Please check the product documentation", { always: true, policy: { memory: { mode: "disabled" } } })).toMatchObject({
      requested: true,
      reason: "always",
      sourceTypes: ["knowledge"],
    });
  });

  it("returns bounded, ranked, deduplicated evidence with provenance", async () => {
    const memory = {
      search: vi.fn().mockResolvedValue([
        { id: "memory-1", canonical_text: "The customer prefers concise replies", relevance_score: 0.4, namespace: "user_private", provenance: { sourceRunId: "run-1" } },
        { id: "memory-2", canonical_text: "The customer prefers concise replies", relevance_score: 0.7, namespace: "agent_private", provenance: { sourceRunId: "run-2" } },
      ]),
    };
    const knowledge = {
      search: vi.fn().mockResolvedValue([
        { id: "knowledge-1", source_id: "source-1", chunk_index: 2, canonical_text: "The customer prefers concise replies", relevance_score: 0.6, provenance: { source: "handbook" } },
        { id: "knowledge-2", source_id: "source-1", chunk_index: 3, canonical_text: "Support hours are Monday to Friday", relevance_score: 0.5, provenance: { source: "handbook" } },
      ]),
    };
    const result = await new RetrievalService(memory as never, knowledge as never).retrieve(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1", actorId: "user-1" },
      "What do you know about my reply style?",
      { memory: { mode: "explicit", maxRetrieved: 4 } },
    );

    expect(memory.search).toHaveBeenCalledWith(expect.anything(), "What do you know about my reply style?", expect.anything(), 16);
    expect(knowledge.search).toHaveBeenCalledWith(expect.anything(), "What do you know about my reply style?", 16);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({ id: "memory-2", sourceType: "memory", score: 0.7, rank: 1, namespace: "agent_private" });
    expect(result.evidence[1]).toMatchObject({ id: "knowledge-2", sourceType: "knowledge", score: 0.5, rank: 2, sourceId: "source-1", chunkIndex: 3 });
    expect(result.evidence.every((entry) => entry.provenance && typeof entry.provenance === "object")).toBe(true);
  });

  it("never exceeds the policy token budget when candidates are large", async () => {
    const memory = {
      search: vi.fn().mockResolvedValue([
        { id: "memory-large", canonical_text: "memory ".repeat(400), relevance_score: 1, namespace: "agent_private", provenance: {} },
      ]),
    };
    const knowledge = {
      search: vi.fn().mockResolvedValue([
        { id: "knowledge-large", source_id: "source-1", chunk_index: 0, canonical_text: "knowledge ".repeat(400), relevance_score: 0.9, provenance: {} },
      ]),
    };
    const result = await new RetrievalService(memory as never, knowledge as never).retrieve(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1", actorId: "user-1" },
      "What did we discuss?",
      { memory: { mode: "explicit", maxRetrieved: 8, maxRetrievedTokens: 1000 } },
    );

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.reduce((total, entry) => total + Math.ceil(entry.text.length / 4), 0)).toBeLessThanOrEqual(1000);
  });
});
