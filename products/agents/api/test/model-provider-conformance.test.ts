import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinProviderRegistry } from "../src/adapters/models/registry";
import { callProviderModel, type ProviderTransportRequest } from "../src/adapters/models/pi-transport";

const ids = ["xai", "deepseek", "mistral", "groq", "together", "fireworks", "moonshot", "zai"];
const profiles = builtinProviderRegistry.filter(profile => ids.includes(profile.id));
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
  prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } };
const tool = { type: "function" as const, function: { name: "lookup", description: "Read one approved record",
  parameters: { type: "object", properties: { id: { type: "string" }, nested: { type: "object", properties: { approved: { type: "boolean" } } } },
    required: ["id"], additionalProperties: false } } };
type Seen = { body: any; headers: IncomingHttpHeaders };
let origin: string;
const seen: Seen[] = [];
let arrived: (() => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  seen.push({ body, headers: request.headers });
  const scenario = request.url!.slice(1);
  if (scenario === "rejected") { response.writeHead(429); response.end(JSON.stringify({ error: { message: "rate limit" } })); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (scenario === "cancel") {
    response.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "Started" }, finish_reason: null }] }));
    arrived?.(); return;
  }
  if (scenario === "mistral-phases") {
    response.end(sse({ id: "response-3", choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "private " }] }] }, finish_reason: null }] }) +
      sse({ id: "response-3", choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "reasoning" }] }, { type: "text", text: "Verified " }] }, finish_reason: null }] }) +
      sse({ id: "response-3", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n"); return;
  }
  if (scenario === "tools" && !body.messages.some((message: any) => message.role === "tool")) {
    response.end(sse({ id: "response-1", model: body.model, choices: [{ index: 0,
      delta: { role: "assistant", ...(request.headers["x-fixture-profile"] === "mistral"
        ? { content: [{ type: "thinking", thinking: [{ type: "text", text: "private reasoning" }] }] }
        : { reasoning_content: "private reasoning" }), tool_calls: [{ index: 0, id: "callabc12", type: "function",
        function: { name: "lookup", arguments: '{"id":"record-1"}' } }] }, finish_reason: "tool_calls" }], usage }) + "data: [DONE]\n\n"); return;
  }
  const delta = scenario === "refusal" ? { role: "assistant", refusal: "Cannot comply" } : { role: "assistant", content: "Verified answer" };
  response.end(sse({ id: "response-2", model: body.model, choices: [{ index: 0, delta,
    finish_reason: scenario === "length" ? "length" : "stop" }], ...(scenario === "unknown-usage" ? {} : { usage }) }) + "data: [DONE]\n\n");
});
beforeAll(async () => { server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

// This is a controlled real-HTTP protocol gate. It establishes adapter fidelity, not live provider/model availability.
describe.each(profiles)("reviewed $id Chat Completions profile", profile => {
  const request = (): ProviderTransportRequest => ({ provider: profile.id, protocol: profile.protocol, model: "fixture-model",
    baseUrl: profile.baseUrl, credentialRevision: "fixture-credential-1", contextWindowTokens: 32000, maxOutputTokens: 32,
    messages: [{ role: "system", content: "Follow the approved instructions." }, { role: "user", content: "Read the record" }] });
  const network = (scenario: string) => (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${profile.baseUrl}/chat/completions`);
    const headers = new Headers(init?.headers); headers.set("x-fixture-profile", profile.id);
    return fetch(`${origin}/${scenario}`, { ...init, headers });
  }) as typeof fetch;
  it("sends its exact endpoint, bearer authorization, instructions and unchanged tool schema", async () => {
    const offset = seen.length;
    const first = await callProviderModel({ ...request(), tools: [tool] }, { apiKey: "fixture-provider-key", fetch: network("tools") });
    const body = seen[offset]!.body;
    expect(seen[offset]!.headers.authorization).toBe("Bearer fixture-provider-key");
    expect(body.messages[0]).toMatchObject({ role: "system", content: "Follow the approved instructions." });
    expect(body.tools[0].function.parameters).toEqual(tool.function.parameters);
    expect(body.tools[0].function).not.toHaveProperty("strict");
    expect(body).toMatchObject({ model: "fixture-model", stream: true, max_tokens: 32 });
    for (const field of ["store", "max_completion_tokens", "thinking", "reasoning_effort", "temperature", "provider"]) expect(body).not.toHaveProperty(field);
    if (profile.id === "fireworks") expect(body.context_length_exceeded_behavior).toBe("error");
    if (["mistral", "fireworks", "zai"].includes(profile.id)) expect(body).not.toHaveProperty("stream_options");
    else expect(body.stream_options).toEqual({ include_usage: true });
    expect(first.message.tool_calls?.[0]?.function.arguments).toBe('{"id":"record-1"}');
    expect(JSON.stringify(first.message)).not.toContain("private reasoning");
    expect(JSON.stringify(first.nativeState)).toContain("private reasoning");
    const second = await callProviderModel({ ...request(), tools: [tool],
      messages: [...request().messages, first.message, { role: "tool", tool_call_id: "callabc12", content: "Approved record" }],
      nativeHistory: { 2: first.nativeState } }, { apiKey: "fixture-provider-key", fetch: network("tools") });
    const sent = seen[offset + 1]!.body.messages;
    expect(sent.find((message: any) => message.role === "assistant")).toMatchObject({
      ...(profile.id === "mistral" ? { content: [{ type: "thinking", thinking: [{ type: "text", text: "private reasoning" }] }] }
        : { reasoning_content: "private reasoning" }),
      tool_calls: [{ id: "callabc12", function: { name: "lookup", arguments: '{"id":"record-1"}' } }] });
    const result = sent.find((message: any) => message.role === "tool");
    expect(result).toMatchObject({ tool_call_id: "callabc12", content: profile.id === "mistral" ? [{ type: "text", text: "Approved record" }] : "Approved record" });
    if (profile.id === "mistral") expect(result.name).toBe("lookup");
    else expect(result).not.toHaveProperty("name");
    expect(second.message.content).toBe("Verified answer");
    expect(second.usage).toMatchObject({ observed: true, inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2 });
    expect(seen.length - offset).toBe(2);
  });
  it("keeps refusal, truncation and missing usage distinct", async () => {
    expect((await callProviderModel(request(), { apiKey: "fixture", fetch: network("refusal") })).finishReason).toBe("refusal");
    expect((await callProviderModel(request(), { apiKey: "fixture", fetch: network("length") })).finishReason).toBe("length");
    expect((await callProviderModel(request(), { apiKey: "fixture", fetch: network("unknown-usage") })).usage).toEqual({ observed: false });
  });
  it("rejects unsupported reasoning options before any physical request", async () => {
    const offset = seen.length;
    await expect(callProviderModel({ ...request(), reasoning: { reasoningEffort: "high" } }, { apiKey: "fixture", fetch: network("tools") }))
      .rejects.toMatchObject({ code: "MODEL_REASONING_OPTIONS_UNSUPPORTED", outcome: "rejected" });
    expect(seen).toHaveLength(offset);
  });
  it("classifies a rejected request without retries or account fallback", async () => {
    const offset = seen.length;
    await expect(callProviderModel(request(), { apiKey: "fixture", fetch: network("rejected") }))
      .rejects.toMatchObject({ code: "MODEL_RATE_LIMITED", outcome: "rejected" });
    expect(seen.length - offset).toBe(1);
  });
  it("cancels a running HTTP stream without reissuing it", async () => {
    const offset = seen.length, abort = new AbortController();
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const running = callProviderModel(request(), { apiKey: "fixture", fetch: network("cancel"), signal: abort.signal });
    await received; abort.abort();
    await expect(running).rejects.toMatchObject({ code: "MODEL_CANCELLED", outcome: "uncertain" });
    expect(seen.length - offset).toBe(1); arrived = undefined;
  });
});


describe("native Mistral chunk fidelity", () => {
  const base: ProviderTransportRequest = { provider: "mistral", protocol: "openai_chat_completions", model: "mistral-small-latest",
    baseUrl: "https://api.mistral.ai/v1", credentialRevision: "fixture-key-1", contextWindowTokens: 32000, maxOutputTokens: 32,
    messages: [{ role: "system", content: "Approved policy" }, { role: "user", content: "Compute" }] };
  it("handles thinking, mixed transition and string answer phases; hooks inspect the exact native wire payload", async () => {
    const offset = seen.length, deltas: string[] = []; let inspected: unknown;
    const result = await callProviderModel(base, { apiKey: "fixture", onText: delta => deltas.push(delta),
      preparePayload: payload => { payload.random_seed = 17; },
      beforePayloadDispatch: async payload => { inspected = payload; expect(payload.max_tokens).toBe(32); expect(payload).not.toHaveProperty("maxTokens"); },
      fetch: (async (url, init) => { expect(String(url)).toBe("https://api.mistral.ai/v1/chat/completions"); return fetch(`${origin}/mistral-phases`, init); }) as typeof fetch });
    expect(inspected).toEqual(seen[offset]!.body); expect(seen[offset]!.body.random_seed).toBe(17);
    expect(deltas.join("")).toBe("Verified answer"); expect(result.message.content).toBe("Verified answer");
    expect(JSON.stringify(result.message)).not.toContain("private");
    expect(result.nativeState.assistant).toMatchObject({ api: "mistral-conversations", content: [
      { type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Verified answer" }] });
    let replay: any;
    await callProviderModel({ ...base, messages: [...base.messages, result.message, { role: "user", content: "Continue" }], nativeHistory: { 2: result.nativeState } },
      { apiKey: "fixture", fetch: (async (_url, init) => { replay = JSON.parse(String(init?.body)); return fetch(`${origin}/mistral-phases`, init); }) as typeof fetch });
    expect(replay.messages[2].content).toEqual([{ type: "thinking", thinking: [{ type: "text", text: "private reasoning" }] }, { type: "text", text: "Verified answer" }]);
  });
  it("rejects native prepared-payload failures before physical I/O", async () => {
    let calls = 0;
    await expect(callProviderModel(base, { apiKey: "fixture", beforePayloadDispatch: async () => {
      const { ProviderTransportError } = await import("../src/adapters/models/pi-transport");
      throw new ProviderTransportError("MODEL_NATIVE_COUNT_REJECTED", "rejected", 409);
    }, fetch: (async () => { calls++; throw new Error("Unexpected network"); }) as typeof fetch }))
      .rejects.toMatchObject({ code: "MODEL_NATIVE_COUNT_REJECTED", outcome: "rejected" });
    expect(calls).toBe(0);
  });
});
