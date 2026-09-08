import { describe, expect, it, vi } from "vitest";
import { RetrievalService, decideMemoryRetrieval } from "../src/memory/retrieval";
import { buildLexicalSearchQuery } from "../src/memory/search-query";

describe("structured retrieval", () => {
  it("turns broad natural-language questions into searchable lexical terms", () => {
    expect(buildLexicalSearchQuery("What are the things you can help me with?")).toBe("things | help");
    expect(buildLexicalSearchQuery("   ??? ")).toBeNull();
  });

  it("recognizes broad knowledge questions for retrieval", () => {
    expect(decideMemoryRetrieval("What are the things you can help me with?", { policy: { memory: { mode: "disabled" } } })).toMatchObject({
      requested: true,
      reason: "knowledge_reference",
      sourceTypes: ["knowledge"],
    });
  });

  it("uses the knowledge index repair hook before searching", async () => {
    const memory = { search: vi.fn().mockResolvedValue([]) };
    const knowledge = {
      ensureEmbeddings: vi.fn().mockResolvedValue({ attempted: 3, embedded: 3 }),
      search: vi.fn().mockResolvedValue([]),
    };
    await new RetrievalService(memory as never, knowledge as never).retrieve(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" },
      "What are the things you can help me with?",
      { memory: { mode: "disabled" } },
    );
    expect(knowledge.ensureEmbeddings).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", agentId: "agent-1" }), 50);
  });

  it("keeps the knowledge-only runtime seam off the legacy memory table", async () => {
    const memory = { search: vi.fn().mockRejectedValue(new Error("legacy memory_records path must not run")) };
    const knowledge = {
      ensureEmbeddings: vi.fn().mockResolvedValue({ attempted: 0, embedded: 0 }),
      search: vi.fn().mockResolvedValue([
        { id: "knowledge-runtime", source_id: "source-runtime", chunk_index: 0, canonical_text: "Runtime knowledge", relevance_score: 0.8, provenance: {} },
      ]),
    };

    const result = await new RetrievalService(memory as never, knowledge as never).retrieveKnowledge(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" },
      "What are your support hours?",
      { memory: { mode: "disabled" } },
    );

    expect(result.memoryMatches).toEqual([]);
    expect(result.knowledgeMatches).toHaveLength(1);
    expect(memory.search).not.toHaveBeenCalled();
    expect(knowledge.search).toHaveBeenCalled();
  });

  it("keeps retrieval available when embedding repair is temporarily unavailable", async () => {
    const memory = { search: vi.fn().mockResolvedValue([]) };
    const knowledge = {
      ensureEmbeddings: vi.fn().mockRejectedValue(new Error("temporary database failure")),
      search: vi.fn().mockResolvedValue([
        { id: "knowledge-1", source_id: "source-1", chunk_index: 0, canonical_text: "Support hours are Monday to Friday", relevance_score: 0.5, provenance: {} },
      ]),
    };
    const result = await new RetrievalService(memory as never, knowledge as never).retrieve(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" },
      "What are your support hours?",
      { memory: { mode: "disabled" } },
    );
    expect(result.evidence).toHaveLength(1);
    expect(knowledge.search).toHaveBeenCalled();
  });

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

    expect(memory.search).toHaveBeenCalledWith(expect.anything(), "What do you know about my reply style?", expect.anything(), 16, undefined);
    expect(knowledge.search).toHaveBeenCalledWith(expect.anything(), "What do you know about my reply style?", 16, undefined);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({ id: "memory-2", sourceType: "memory", score: 0.7, rank: 1, namespace: "agent_private" });
    expect(result.evidence[1]).toMatchObject({ id: "knowledge-2", sourceType: "knowledge", score: 0.5, rank: 2, sourceId: "source-1", chunkIndex: 3 });
    expect(result.evidence.every((entry) => entry.provenance && typeof entry.provenance === "object")).toBe(true);
  });

  it("does not treat zero-score vector rows as trusted evidence", async () => {
    const memory = { search: vi.fn().mockResolvedValue([]) };
    const knowledge = {
      search: vi.fn().mockResolvedValue([
        { id: "knowledge-zero", source_id: "source-1", chunk_index: 0, canonical_text: "Unrelated content", relevance_score: 0, provenance: {} },
      ]),
    };
    const result = await new RetrievalService(memory as never, knowledge as never).retrieve(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" },
      "What is your refund policy?",
      { memory: { mode: "disabled" } },
    );
    expect(result.evidence).toEqual([]);
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
