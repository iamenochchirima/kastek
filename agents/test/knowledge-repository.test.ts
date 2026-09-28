import { describe, expect, it, vi } from "vitest";
import { KnowledgeRepository } from "../src/db/repositories/knowledge-repository";
import { DEFAULT_EMBEDDING_DIMENSIONS } from "../src/memory/embeddings";

function vector(value: number): number[] {
  return Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? value : 0);
}

describe("knowledge repository", () => {
  it("uses content terms instead of requiring every natural-language question word", async () => {
    const pool = {
      query: vi.fn(async (text: string) => text.includes("embedding_vector") ? { rows: [] } : {
        rows: [{
          id: "chunk-1",
          source_id: "source-1",
          organization_id: "org-1",
          agent_definition_id: "agent-1",
          installation_id: null,
          revision: 1,
          chunk_index: 0,
          canonical_text: "We help customers with product information.",
          metadata: {},
          provenance: {},
          created_at: new Date(0),
          lexical_score: 0.8,
        }],
      }),
    };
    const repository = new KnowledgeRepository(pool as never, undefined);

    const result = await repository.search(
      { organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" },
      "What are the things you can help me with?",
    );

    expect(pool.query.mock.calls.find((call) => String(call[0]).includes("to_tsquery"))?.[1]?.[3]).toBe("things | help");
    expect(pool.query.mock.calls.find((call) => String(call[0]).includes("to_tsquery"))?.[0]).toContain("to_tsquery('simple', $4)");
    expect(result).toHaveLength(1);
  });

  it("backfills missing vectors for current scoped chunks", async () => {
    const client = {
      query: vi.fn(async (text: string) => text.includes("UPDATE knowledge_chunks") ? { rowCount: 1, rows: [{ id: "chunk-1" }] } : { rows: [] }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ id: "chunk-1", source_id: "source-1", revision: 1, canonical_text: "Product information" }] })),
      connect: vi.fn(async () => client),
    };
    const provider = {
      provider: "openrouter" as const,
      model: "openai/text-embedding-3-small",
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      embed: vi.fn().mockResolvedValue([vector(0.4)]),
    };
    const repository = new KnowledgeRepository(pool as never, provider);

    await expect(repository.ensureEmbeddings({ organizationId: "org-1", agentId: "agent-1", installationId: "installation-1" })).resolves.toEqual({ attempted: 1, embedded: 1 });
    expect(provider.embed).toHaveBeenCalledWith(["Product information"]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE knowledge_chunks"), expect.arrayContaining(["chunk-1", "openai/text-embedding-3-small"]));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE knowledge_sources"), expect.arrayContaining(["openai/text-embedding-3-small"]));
    expect(client.release).toHaveBeenCalled();
  });
});
