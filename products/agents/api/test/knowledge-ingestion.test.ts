import { describe, expect, it } from "vitest";
import { chunkKnowledgeText, fetchBoundedKnowledgeDocument } from "../src/knowledge/ingestion";

describe("bounded knowledge ingestion", () => {
  it("rejects non-web URLs and credentials", async () => {
    await expect(fetchBoundedKnowledgeDocument("file:///etc/passwd")).rejects.toThrow("http or https");
    await expect(fetchBoundedKnowledgeDocument("https://user:pass@example.com/doc")).rejects.toThrow("credentials");
  });

  it("enforces response byte limits while reading the stream", async () => {
    const fetcher = async () => new Response("123456789", { headers: { "content-type": "text/plain" } });
    await expect(fetchBoundedKnowledgeDocument("https://example.com/doc", { maxBytes: 8 }, fetcher)).rejects.toThrow("byte limit");
  });

  it("returns text metadata and creates deterministic bounded chunks", async () => {
    const fetcher = async () => new Response("First paragraph.\n\nSecond paragraph.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    const document = await fetchBoundedKnowledgeDocument("https://example.com/doc", {}, fetcher);
    expect(document).toMatchObject({ url: "https://example.com/doc", contentType: "text/plain", text: "First paragraph.\n\nSecond paragraph." });
    const chunks = chunkKnowledgeText(`${"First paragraph. ".repeat(20)}\n\n${"Second paragraph. ".repeat(20)}`, 256);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("First paragraph.");
    expect(chunks.join(" ")).toContain("Second paragraph.");
  });
});
