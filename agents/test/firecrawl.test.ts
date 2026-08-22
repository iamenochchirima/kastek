import { describe, expect, it } from "vitest";
import { FirecrawlClient } from "../src/knowledge/firecrawl";

describe("Firecrawl website adapter", () => {
  it("does not make requests without a server-side API key", async () => {
    const client = new FirecrawlClient({ fetcher: async () => new Response("should not run") });
    expect(client.isConfigured()).toBe(false);
    await expect(client.map({ url: "https://example.com" })).rejects.toThrow("not configured");
  });

  it("maps URLs and normalizes link metadata", async () => {
    const requests: Request[] = [];
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ success: true, links: ["https://example.com", { url: "https://example.com/about", title: "About" }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await expect(client.map({ url: "https://example.com", limit: 25 })).resolves.toEqual({ links: [{ url: "https://example.com" }, { url: "https://example.com/about", title: "About" }] });
    expect(requests[0]?.url).toBe("https://api.firecrawl.dev/v2/map");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer fc-test");
    expect(await requests[0]!.json()).toMatchObject({ url: "https://example.com", limit: 25, sitemap: "include" });
  });

  it("starts and reads a crawl with page links and metadata", async () => {
    const urls: string[] = [];
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetcher: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/v2/crawl")) return new Response(JSON.stringify({ success: true, id: "crawl-1", url: "https://example.com" }), { status: 200 });
        return new Response(JSON.stringify({ status: "completed", total: 1, completed: 1, data: [{ markdown: "# Home", links: ["https://example.com/about"], metadata: { title: "Home", sourceURL: "https://example.com" } }] }), { status: 200 });
      },
    });
    await expect(client.startCrawl({ url: "https://example.com" })).resolves.toEqual({ id: "crawl-1", url: "https://example.com" });
    await expect(client.getCrawlStatus("crawl-1")).resolves.toMatchObject({ status: "completed", total: 1, completed: 1, data: [{ markdown: "# Home", links: ["https://example.com/about"], metadata: { title: "Home", sourceURL: "https://example.com" } }] });
    expect(urls).toEqual(["https://api.firecrawl.dev/v2/crawl", "https://api.firecrawl.dev/v2/crawl/crawl-1"]);
  });
});
