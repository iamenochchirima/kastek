import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { acquirePublicSource } from "../src/capabilities/knowledge/source-acquisition";
const servers: Server[] = [];
async function fixture(handler: Parameters<typeof createServer>[0]) { const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error(); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
it("acquires exact authorized text/Markdown/PDF/HTML bytes with immutable acquisition metadata", async () => {
  const body = "<article>Approved public source.</article>";
  const url = await fixture((request, response) => { expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined(); response.writeHead(200, { "content-type": request.url!.slice(1), etag: '"revision-one"', "last-modified": "Sat, 17 Oct 2026 00:00:00 GMT" }).end(body); });
  for (const type of ["text/plain", "text/markdown", "text/html", "application/pdf"]) {
    const source = await acquirePublicSource({ url: `${url}/${type}`, deadlineAt: Date.now()+3000, testLoopback: true });
    expect(source.bytes.toString()).toBe(body); expect(source.rawDigest).toBe(createHash("sha256").update(body).digest("hex")); expect(source.etag).toBe('"revision-one"'); expect(source.finalUrl).toBe(`${url}/${type}`); expect(source.attempts).toHaveLength(1); expect(Date.parse(source.acquiredAt)).toBeGreaterThan(0);
  }
});
it("follows only an exact owner-authorized redirect without constructing extra paths or query", async () => {
  const url = await fixture((request, response) => { if (request.url === "/start") response.writeHead(302, { location: "/approved?edition=one" }).end(); else response.writeHead(200, { "content-type": "text/plain" }).end("Authorized edition."); });
  await expect(acquirePublicSource({ url: `${url}/start`, redirectUrls: [`${url}/approved`], deadlineAt: Date.now()+3000, testLoopback: true })).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
  const source = await acquirePublicSource({ url: `${url}/start`, redirectUrls: [`${url}/approved?edition=one`], deadlineAt: Date.now()+3000, testLoopback: true });
  expect(source.finalUrl).toBe(`${url}/approved?edition=one`); expect(source.attempts).toHaveLength(2);
});
it("allows the explicit 10MiB import profile and rejects oversized raw bodies", async () => {
  const url = await fixture((request, response) => response.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(request.url === "/allowed" ? 3 * 1024 * 1024 : 10 * 1024 * 1024 + 1)));
  expect((await acquirePublicSource({ url: `${url}/allowed`, deadlineAt: Date.now()+3000, testLoopback: true })).bytes.length).toBe(3 * 1024 * 1024);
  await expect(acquirePublicSource({ url: `${url}/large`, deadlineAt: Date.now()+3000, testLoopback: true })).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
});
it("rejects auth crawling, scripts, archives, invalid encodings and empty sources", async () => {
  const url = await fixture((request, response) => {
    const path = request.url!;
    if (path === "/auth") { response.writeHead(401).end(); return; }
    response.writeHead(200, { "content-type": path === "/script" ? "application/javascript" : path === "/archive" ? "application/zip" : path === "/encoding" ? "text/plain; charset=utf-16" : "text/plain" }).end(path === "/invalid" ? Buffer.from([255,254]) : path === "/empty" ? "" : "body");
  });
  for (const [path, code] of [["auth", "SOURCE_AUTHENTICATION_UNSUPPORTED"], ["script", "SOURCE_FORMAT_UNSUPPORTED"], ["archive", "SOURCE_FORMAT_UNSUPPORTED"], ["encoding", "SOURCE_ENCODING_UNSUPPORTED"], ["invalid", "SOURCE_ENCODING_UNSUPPORTED"], ["empty", "SOURCE_EMPTY"]]) await expect(acquirePublicSource({ url: `${url}/${path}`, deadlineAt: Date.now()+3000, testLoopback: true })).rejects.toMatchObject({ code });
});
it("denies credential-bearing URLs, fragments, private destinations and additional attempts", async () => {
  for (const url of ["https://user:secret@example.com/page", "https://example.com/page#private", "https://127.0.0.1/page", "https://169.254.169.254/latest/meta-data"]) await expect(acquirePublicSource({ url, deadlineAt: Date.now()+1000 })).rejects.toMatchObject({ code: expect.stringMatching(/DENIED/) });
  let calls = 0;
  const url = await fixture((_request, response) => { calls++; response.writeHead(429, { "retry-after": "0" }).end(); });
  await expect(acquirePublicSource({ url, deadlineAt: Date.now()+3000, testLoopback: true })).rejects.toMatchObject({ code: "RATE_LIMIT" }); expect(calls).toBe(3);
});
it("cancels an actual blocked source acquisition and preserves observed attempt metadata", async () => {
  const url = await fixture(() => undefined), abort = new AbortController();
  const pending = acquirePublicSource({ url, deadlineAt: Date.now()+3000, testLoopback: true }, abort.signal); setTimeout(() => abort.abort(), 20);
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED", attempts: expect.arrayContaining([expect.objectContaining({ status: null, outcome: "CANCELLED" })]) });
});
