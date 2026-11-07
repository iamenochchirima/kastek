import { describe, expect, it, vi } from "vitest";
import type { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { importKnowledgeOperation, MCP_KNOWLEDGE_IMPORT_BYTES } from "../src/product/mcp/knowledge-import";

const scope = { accountId: "00000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-000000000002", connectionId: "connection" };
const job = { id: "00000000-0000-4000-8000-000000000010", sourceId: "00000000-0000-4000-8000-000000000011",
  revisionId: "00000000-0000-4000-8000-000000000012", revision: 1, acceptedGeneration: 3, state: "ready" as const,
  parserRelease: "inline-text-v1", deadline: "2026-11-07T00:10:00.000Z", contentType: "text/markdown", errorCode: null,
  createdAt: "2026-11-07T00:00:00.000Z" };
const input = { title: "Menu", contentType: "application/json" as const, content: '{"name":"Chicken Mayo"}', operationId: "import-1" };

describe("MCP knowledge import", () => {
  it("uses inline text normalization when document processing is unavailable", async () => {
    const admitText = vi.fn(async () => job), admitUpload = vi.fn();
    const operation = importKnowledgeOperation({ admitText, admitUpload } as unknown as KnowledgeStore);
    await expect(operation.run(scope, input)).resolves.toEqual(expect.objectContaining({ sourceId: job.sourceId, revisionId: job.revisionId,
      acceptedGeneration: 3, retrieval: "lexical-v1", state: "ready" }));
    expect(admitText).toHaveBeenCalledWith(scope, expect.objectContaining({ text: input.content, contentType: "application/json", operationId: "import-1" }));
    expect(admitUpload).not.toHaveBeenCalled();
  });

  it("uses the document profile and embeddings when available", async () => {
    const profile = "document-processing-v1@" + "a".repeat(64);
    const admitText = vi.fn(), admitUpload = vi.fn(async () => job);
    const operation = importKnowledgeOperation({ admitText, admitUpload } as unknown as KnowledgeStore, { profile: async () => ({ profileRelease: profile }) });
    await expect(operation.run(scope, input)).resolves.toEqual(expect.objectContaining({ retrieval: "hybrid-v1", acceptedGeneration: 3 }));
    expect(admitUpload).toHaveBeenCalledWith(scope, expect.objectContaining({ contentType: "application/json", parserRelease: profile, embeddingRelease: profile }));
    expect(admitText).not.toHaveBeenCalled();
  });

  it("falls back to lexical import when the profile cannot be verified", async () => {
    const admitText = vi.fn(async () => job);
    const operation = importKnowledgeOperation({ admitText, admitUpload: vi.fn() } as unknown as KnowledgeStore, { profile: async () => { throw new Error("unavailable"); } });
    await expect(operation.run(scope, input)).resolves.toEqual(expect.objectContaining({ retrieval: "lexical-v1" }));
    expect(admitText).toHaveBeenCalled();
  });

  it("rejects oversized content and unsupported formats", async () => {
    const operation = importKnowledgeOperation({ admitText: vi.fn(), admitUpload: vi.fn() } as unknown as KnowledgeStore);
    await expect(operation.run(scope, { ...input, content: "x".repeat(MCP_KNOWLEDGE_IMPORT_BYTES + 1) })).rejects.toMatchObject({ code: "SOURCE_SIZE_INVALID" });
    await expect(operation.run(scope, { ...input, contentType: "application/pdf" })).rejects.toBeInstanceOf(Error);
  });
});
