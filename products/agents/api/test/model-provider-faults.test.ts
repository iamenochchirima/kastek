import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callProviderModel } from "../src/adapters/models/pi-transport";
import type { ProviderProtocol, ProviderTransportRequest } from "../src/contracts/model-transport";
import { createModelFetch } from "../src/infrastructure/model-network";

const protocols = ["openai_chat_completions", "openai_responses", "anthropic_messages"] as const;
const secret = "private-fault-fixture-key";
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const anthropic = (type: string, value: object) => `event: ${type}\n${sse({ type, ...value })}`;
function partial(protocol: ProviderProtocol): string {
  if (protocol === "anthropic_messages") return anthropic("message_start", { message: { id: "partial", type: "message", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }) +
    anthropic("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    anthropic("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Partial answer" } });
  if (protocol === "openai_responses") return sse({ type: "response.created", response: { id: "partial", model: "fixture-model" } }) +
    sse({ type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }) +
    sse({ type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
    sse({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "Partial answer" });
  return sse({ id: "partial", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "Partial answer" }, finish_reason: null }] });
}
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture(protocol: typeof protocols[number], handler: (request: IncomingMessage, response: ServerResponse) => void,
  beforeDispatch?: () => void | Promise<void>) {
  let physicalCalls = 0, attempts = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    physicalCalls++; let raw = ""; for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw));
    expect(request.headers[protocol === "anthropic_messages" ? "x-api-key" : "authorization"]).toBe(protocol === "anthropic_messages" ? secret : `Bearer ${secret}`);
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = protocol === "anthropic_messages" ? "/v1/messages" : protocol === "openai_responses" ? "/v1/responses" : "/v1/chat/completions";
  const request: ProviderTransportRequest = { provider: "fixture", protocol, model: "fixture-model", baseUrl: `${origin}/v1`, credentialRevision: "credential-1",
    contextWindowTokens: 32000, maxOutputTokens: 32, maxRequestBytes: 32000, maxResponseBytes: 32000, messages: [{ role: "user", content: "Hello" }] };
  const protectedFetch = createModelFetch({ authorizeUrl: url => url.origin === origin && url.pathname === path && (!url.search || protocol === "anthropic_messages" && url.search === "?beta=true"),
    headers: protocol === "anthropic_messages" ? { "x-api-key": secret } : { authorization: `Bearer ${secret}` },
    maxRequestBytes: 32000, maxResponseBytes: 32000, deadlineAt: Date.now() + 2000, beforeDispatch, testLoopback: true });
  const network = (async (url, init) => { attempts++; return protectedFetch(url, init); }) as typeof fetch;
  return { request, options: { apiKey: secret, fetch: network }, bodies, physicalCalls: () => physicalCalls, attempts: () => attempts };
}

// Controlled real HTTP, protected transport and actual installed SDKs. No live model or billing request.
describe.each(protocols)("native %s fault boundary", protocol => {
  it.each([[401, "MODEL_AUTHENTICATION_FAILED"], [402, "MODEL_BILLING_REQUIRED"], [403, "MODEL_ACCESS_DENIED"],
    [404, "MODEL_UNAVAILABLE"], [429, "MODEL_RATE_LIMITED"]] as const)("rejects HTTP %s once without retry, route fallback or secret leakage", async (status, code) => {
    const f = await fixture(protocol, (_request, response) => { response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "provider_error", message: `${secret}: denied` } })); });
    const result = await callProviderModel(f.request, f.options).catch(error => error);
    expect(result).toMatchObject({ code, status, outcome: "rejected" });
    expect(String(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.attempts()).toBe(1); expect(f.physicalCalls()).toBe(1); expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]!.model).toBe("fixture-model");
  });
  it("rejects malformed JSON after physical dispatch without replaying it", async () => {
    const f = await fixture(protocol, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("data: {invalid-json}\n\n"); });
    await expect(callProviderModel(f.request, f.options)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(f.attempts()).toBe(1); expect(f.physicalCalls()).toBe(1);
  });
  it("does not report a semantically truncated text stream as a completed reply", async () => {
    const f = await fixture(protocol, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(partial(protocol)); });
    const visible: string[] = [];
    await expect(callProviderModel(f.request, { ...f.options, onText: text => visible.push(text) })).rejects.toMatchObject({ outcome: "uncertain" });
    expect(visible.join("")).toBe("Partial answer");
    expect(f.attempts()).toBe(1); expect(f.physicalCalls()).toBe(1);
  });
  it("cancels before dispatch with no physical request or credential substitution", async () => {
    const f = await fixture(protocol, (_request, response) => response.end());
    await expect(callProviderModel(f.request, { ...f.options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "MODEL_CANCELLED_BEFORE_DISPATCH", outcome: "rejected" });
    expect(f.attempts()).toBe(0); expect(f.physicalCalls()).toBe(0);
  });
  it("cancels after visible output as uncertain and makes no second request", async () => {
    const f = await fixture(protocol, (_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(partial(protocol)); });
    const abort = new AbortController();
    await expect(callProviderModel(f.request, { ...f.options, signal: abort.signal, onText: () => abort.abort() })).rejects.toMatchObject({ outcome: "uncertain" });
    expect(abort.signal.aborted).toBe(true); expect(f.attempts()).toBe(1); expect(f.physicalCalls()).toBe(1);
  });
  it("rechecks queued authority immediately before physical dispatch", async () => {
    let enter!: () => void, release!: () => void, revoked = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(protocol, (_request, response) => response.end(), async () => { enter(); await released; if (revoked) throw Error(secret); });
    const running = expect(callProviderModel(f.request, f.options)).rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    await entered; revoked = true; release(); await running;
    expect(f.attempts()).toBe(1); expect(f.physicalCalls()).toBe(0);
  });
});
