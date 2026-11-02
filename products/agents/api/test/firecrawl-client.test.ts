import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { FirecrawlClient, loadFirecrawlConfig } from "../src/adapters/providers/firecrawl/client";

const servers: Server[] = [];
async function fixture(handler: Parameters<typeof createServer>[0], apiKey?: string) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  return new FirecrawlClient({ url: `http://127.0.0.1:${address.port}`, timeoutMs: 2000, apiKey });
}
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
it("switches local and Cloud with URL and key configuration only", () => {
  expect(loadFirecrawlConfig({})).toBeUndefined();
  expect(loadFirecrawlConfig({ AGENTS_FIRECRAWL_URL: "http://127.0.0.1:3002" })).toEqual({ url: "http://127.0.0.1:3002", apiKey: undefined, timeoutMs: 60000 });
  expect(loadFirecrawlConfig({ AGENTS_FIRECRAWL_URL: "https://api.firecrawl.dev", AGENTS_FIRECRAWL_API_KEY: " example-secret " })?.apiKey).toBe("example-secret");
  for (const env of [{ AGENTS_FIRECRAWL_API_KEY: "secret" }, { AGENTS_FIRECRAWL_URL: "https://api.firecrawl.dev" }, { AGENTS_FIRECRAWL_URL: "http://example.com", AGENTS_FIRECRAWL_API_KEY: "secret" }, { AGENTS_FIRECRAWL_URL: "https://user:pass@example.com" }, { AGENTS_FIRECRAWL_URL: "https://example.com/v2" }]) expect(() => loadFirecrawlConfig(env)).toThrow();
});
it("uses the same v2 scrape contract with optional auth and no AI extraction", async () => {
  for (const key of [undefined, "fixture-only"]) {
    const client = await fixture(async (request, response) => {
      expect(request.url).toBe("/v2/scrape"); expect(request.headers.authorization).toBe(key ? `Bearer ${key}` : undefined);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      expect(input).toMatchObject({ url: "https://example.com/", formats: ["markdown"], onlyMainContent: true });
      expect(input).not.toHaveProperty("jsonOptions");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, data: { markdown: "# Example", metadata: { sourceURL: "https://example.com/" } } }));
    }, key);
    expect((await client.scrape("https://example.com")).markdown).toBe("# Example");
  }
});
it("starts, inspects and cancels jobs without following provider URLs", async () => {
  const calls: string[] = [];
  const client = await fixture(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    const result = request.method === "POST" ? { id: "job_1" } : request.method === "DELETE" ? {} : { status: "completed", total: 1, completed: 1, data: [{ markdown: "Evidence" }], next: "https://untrusted.example/token" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, ...result }));
  });
  expect(await client.startCrawl("https://example.com", { limit: 20, maxDiscoveryDepth: 2 })).toEqual({ id: "job_1" });
  expect((await client.status("job_1")).next).toBe("https://untrusted.example/token");
  await client.cancel("job_1");
  await expect(client.status("../escape")).rejects.toThrow();
  expect(calls).toEqual(["POST /v2/crawl", "GET /v2/crawl/job_1", "DELETE /v2/crawl/job_1"]);
});
it("rejects private literal targets before sending and never retries ambiguous requests", async () => {
  let calls = 0;
  const client = await fixture((_request, response) => { calls++; response.writeHead(503).end("secret provider error"); });
  for (const url of ["http://example.com", "https://127.0.0.1", "https://169.254.169.254/latest", "https://user:secret@example.com", "https://example.com/#fragment"]) await expect(client.scrape(url)).rejects.toMatchObject({ code: "FIRECRAWL_TARGET_DENIED" });
  expect(calls).toBe(0);
  await expect(client.scrape("https://example.com")).rejects.toMatchObject({ code: "FIRECRAWL_HTTP_FAILED", status: 503 });
  expect(calls).toBe(1);
});
it("classifies authentication, rate limits, redirects and malformed results without provider error bodies", async () => {
  for (const [status, body, code] of [[401, "private provider body", "FIRECRAWL_AUTHENTICATION"], [429, "private provider body", "FIRECRAWL_RATE_LIMIT"], [302, "", "FIRECRAWL_UNAVAILABLE"], [200, JSON.stringify({ success: true, data: {} }), "FIRECRAWL_CONTENT_EMPTY"], [200, JSON.stringify({ success: false, error: "private" }), "FIRECRAWL_RESPONSE_INVALID"]] as const) {
    const client = await fixture((_request, response) => response.writeHead(status, { "content-type": "application/json", location: "https://example.com" }).end(body));
    await expect(client.scrape("https://example.com")).rejects.toMatchObject({ code, message: code });
  }
});
it("bounds streamed responses and cancels blocked requests", async () => {
  const large = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(' '.repeat(10 * 1024 * 1024 + 1)));
  await expect(large.scrape("https://example.com")).rejects.toMatchObject({ code: "FIRECRAWL_RESPONSE_LIMIT" });
  const blocked = await fixture(() => undefined), abort = new AbortController();
  const pending = blocked.scrape("https://example.com", abort.signal); abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "FIRECRAWL_CANCELLED" });
});
