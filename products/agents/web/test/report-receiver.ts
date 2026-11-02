/** Separate durable receiver for local delivery acceptance; never targets a real person. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, open, readFile } from "node:fs/promises";

const file = process.env.AGENTS_RECEIVER_LEDGER!;
const key = process.env.AGENTS_RECEIVER_KEY!;
const resource = "browser-report";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function records(): Promise<Record<string, unknown>[]> { return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line)); }
async function persist(record: unknown) { await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 }); const handle = await open(file, "r+"); try { await handle.sync(); } finally { await handle.close(); } }
let sequence = Promise.resolve();
const server = createServer((request, response) => {
  sequence = sequence.then(async () => {
    if (request.headers.authorization !== `Bearer ${key}` || request.headers["x-report-resource"] !== resource) { response.writeHead(403).end(); return; }
    if (request.method === "POST" && request.url === "/deliveries") {
      let body = ""; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) { response.writeHead(413).end(); return; } }
      const payload = JSON.parse(body), id = request.headers["idempotency-key"];
      const digest = createHash("sha256").update(canonical(payload)).digest("hex");
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || request.headers["x-payload-digest"] !== digest || payload.resource !== resource) { response.writeHead(400).end(); return; }
      await persist({ type: "post", id, digest });
      const previous = (await records()).find(record => record.type === "accepted" && record.id === id);
      if (previous) { response.writeHead(previous.digest === digest ? 200 : 409, { "content-type": "application/json" }).end(JSON.stringify(previous.receipt)); return; }
      const receipt = { id, payloadDigest: digest, acceptedAt: new Date().toISOString() };
      await persist({ type: "accepted", id, digest, receipt, payload });
      // Hold the first response so the fixture can kill the sender after durable acceptance.
      request.on("close", () => { if (!response.writableEnded) response.destroy(); });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/deliveries/")) {
      const id = decodeURIComponent(request.url.slice("/deliveries/".length));
      await persist({ type: "status", id });
      const previous = (await records()).find(record => record.type === "accepted" && record.id === id);
      response.writeHead(previous ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(previous?.receipt ?? {})); return;
    }
    response.writeHead(404).end();
  }).catch(() => { response.writeHead(500).end(); });
});
server.listen(Number(process.env.AGENTS_RECEIVER_PORT ?? 4399), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.closeAllConnections(); server.close(); });
