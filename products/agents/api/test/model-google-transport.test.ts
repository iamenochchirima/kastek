import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGoogleProviderModel, googleModelRequestUrl } from "../src/adapters/models/google-transport";
import type { ProviderTransportRequest } from "../src/adapters/models/pi-transport";
import { createModelFetch } from "../src/infrastructure/model-network";

const request: ProviderTransportRequest = { provider: "google", protocol: "google_generate_content", model: "models/gemini-fixture",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta", credentialRevision: "credential-1", contextWindowTokens: 32000,
  maxOutputTokens: 16, maxRequestBytes: 32000, maxResponseBytes: 32000,
  messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hello" }] };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const close of closes.splice(0)) await close(); });
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (parts: object[], finishReason?: string, usageMetadata?: object) => ({ candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) });
const usage = { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 2, totalTokenCount: 10 };
async function fixture(handler: (body: any, req: IncomingMessage, res: ServerResponse) => void) {
  let calls = 0, authorizations = 0;
  const server = createServer((req, res) => { calls++; let body = ""; req.on("data", value => { body += value; }); req.on("end", () => handler(JSON.parse(body), req, res)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const input = { ...request, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta` };
  const options = () => ({ apiKey: "private-test-key", fetch: createModelFetch({ authorizeUrl: url => url.href === googleModelRequestUrl(input.baseUrl, input.model).href,
    headers: { "x-goog-api-key": "private-test-key" }, maxRequestBytes: input.maxRequestBytes!, maxResponseBytes: input.maxResponseBytes!,
    deadlineAt: Date.now() + 2000, beforeDispatch: () => { authorizations++; }, testLoopback: true }) });
  return { input, options, calls: () => calls, authorizations: () => authorizations };
}
const respond = (res: ServerResponse, value: unknown) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse(value)); };

describe("controlled Gemini REST transport", () => {
  it("streams exact caps and protected header auth with no ambient backend or key lookup", async () => {
    let payload: any, receivedUrl = "", receivedKey: unknown;
    const f = await fixture((body, req, res) => { payload = body; receivedUrl = req.url!; receivedKey = req.headers["x-goog-api-key"]; respond(res, chunk([{ text: "OK" }], "STOP", usage)); });
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true"); vi.stubEnv("GEMINI_API_KEY", "wrong-key");
    const onText = vi.fn(), onProgress = vi.fn();
    const result = await callGoogleProviderModel({ ...f.input, maxOutputTokens: 8 }, { ...f.options(), onText, onProgress,
      beforePayloadDispatch: async body => { expect(body.generationConfig).toMatchObject({ maxOutputTokens: 8 }); (body.generationConfig as any).maxOutputTokens = 999; } });
    expect(f.calls()).toBe(1); expect(f.authorizations()).toBe(1);
    expect(receivedUrl).toBe("/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse"); expect(receivedUrl).not.toContain("key"); expect(receivedKey).toBe("private-test-key");
    expect(payload).toMatchObject({ systemInstruction: { parts: [{ text: "Be concise" }] }, contents: [{ role: "user", parts: [{ text: "Hello" }] }], generationConfig: { maxOutputTokens: 8, candidateCount: 1 } });
    expect(onText).toHaveBeenCalledWith("OK"); expect(onProgress).toHaveBeenCalled();
    expect(result.message).toEqual({ role: "assistant", content: "OK" });
    expect(result.usage).toEqual({ observed: true, inputTokens: 5, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 3 });
    expect(JSON.stringify(result)).not.toContain("private-test-key");
  });

  it("delivers visible text before stream completion and never exposes thoughts", async () => {
    let end: (() => void) | undefined;
    const f = await fixture((_body, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse(chunk([{ thought: true, text: "private reasoning", thoughtSignature: "private-signature" }, { text: "first" }])));
      end = () => res.end(sse(chunk([{ text: " last" }, { text: "", thoughtSignature: "final-signature" }], "STOP")));
    });
    let seen: (() => void) | undefined;
    const first = new Promise<void>(resolve => { seen = resolve; });
    const deltas: string[] = [];
    const running = callGoogleProviderModel(f.input, { ...f.options(), onText: text => { deltas.push(text); seen!(); } });
    await first; expect(deltas).toEqual(["first"]); end!();
    const result = await running;
    expect(result.message.content).toBe("first last"); expect(JSON.stringify(result.message)).not.toMatch(/reasoning|signature/);
    expect(JSON.stringify(result.nativeState)).toContain("final-signature"); expect(result.usage).toEqual({ observed: false });
  });

  it("parses split UTF-8 and SSE line boundaries without buffering visible output to completion", async () => {
    const f = await fixture((_body, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const encoded = Buffer.from(sse(chunk([{ text: "café" }], "STOP")));
      const split = encoded.indexOf(Buffer.from("é")) + 1;
      res.write(encoded.subarray(0, split));
      res.write(encoded.subarray(split, encoded.length - 1)); res.end(encoded.subarray(encoded.length - 1));
    });
    expect((await callGoogleProviderModel(f.input, f.options())).message.content).toBe("café");
  });

  it("retains incomplete usage as unobserved and counts a separate tool-use prompt once", async () => {
    const f = await fixture((_body, _req, res) => respond(res, chunk([{ text: "OK" }], "STOP", { promptTokenCount: 5 })));
    expect((await callGoogleProviderModel(f.input, f.options())).usage).toEqual({ observed: false });
    const tools = await fixture((_body, _req, res) => respond(res, chunk([{ text: "OK" }], "STOP", { ...usage, toolUsePromptTokenCount: 4, totalTokenCount: 14 })));
    expect((await callGoogleProviderModel(tools.input, tools.options())).usage).toMatchObject({ observed: true, inputTokens: 9, outputTokens: 5 });
  });

  it("keeps parallel native function calls, signatures and grouped results across a second call", async () => {
    const bodies: any[] = [];
    const f = await fixture((body, _req, res) => {
      bodies.push(body);
      if (bodies.length === 1) respond(res, chunk([{ functionCall: { id: "call-a", name: "echo", args: { token: "one" } }, thoughtSignature: "opaque-signature" },
        { functionCall: { name: "echo", args: { token: "two" } } }], "STOP", usage));
      else respond(res, chunk([{ text: "done" }], "STOP", usage));
    });
    const tools = [{ type: "function" as const, function: { name: "echo", description: "Local echo", parameters: { type: "object", properties: { token: { type: "string", const: "one" } }, additionalProperties: false } } }];
    const first = await callGoogleProviderModel({ ...f.input, tools }, f.options());
    expect(first.finishReason).toBe("tool_calls"); expect(first.message.tool_calls).toHaveLength(2);
    const calls = first.message.tool_calls!;
    const next = { ...f.input, tools, messages: [...f.input.messages, first.message,
      { role: "tool" as const, tool_call_id: calls[0]!.id, content: "first result" }, { role: "tool" as const, tool_call_id: calls[1]!.id, content: "second result" }],
      nativeHistory: { 2: first.nativeState } };
    await callGoogleProviderModel(next, f.options());
    expect(bodies[0].tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(tools[0]!.function.parameters);
    expect(bodies[1].contents.at(-2).parts).toEqual((first.nativeState.assistant as any).parts);
    expect(bodies[1].contents.at(-1)).toEqual({ role: "user", parts: [
      { functionResponse: { name: "echo", id: "call-a", response: { output: "first result" } } },
      { functionResponse: { name: "echo", response: { output: "second result" } } }] });
    await expect(callGoogleProviderModel({ ...next, credentialRevision: "changed" }, f.options())).rejects.toMatchObject({ code: "MODEL_NATIVE_STATE_MISMATCH", outcome: "rejected" });
    expect(f.calls()).toBe(2);
  });

  it("gives missing provider call IDs fresh identities across rounds", async () => {
    const f = await fixture((_body, _req, res) => respond(res, chunk([{ functionCall: { name: "echo", args: {} } }], "STOP")));
    const one = await callGoogleProviderModel(f.input, f.options()), two = await callGoogleProviderModel(f.input, f.options());
    expect(one.message.tool_calls![0]!.id).not.toBe(two.message.tool_calls![0]!.id);
  });

  it.each([401, 402, 403, 404, 429, 503])("preserves HTTP %s without retries or provider error leakage", async status => {
    const f = await fixture((_body, _req, res) => { res.writeHead(status); res.end('{"error":{"message":"private-test-key"}}'); });
    let error: any;
    try { await callGoogleProviderModel(f.input, f.options()); } catch (value) { error = value; }
    expect(error.status).toBe(status); expect(error.outcome).toBe(status < 500 || status === 503 ? "rejected" : "uncertain");
    if (status === 503) expect(error.code).toBe("MODEL_PROVIDER_UNAVAILABLE");
    expect(error.message).not.toContain("private-test-key"); expect(f.calls()).toBe(1);
  });

  it.each(["SAFETY", "RECITATION", "BLOCKLIST"])("normalizes %s as refusal", async reason => {
    const f = await fixture((_body, _req, res) => respond(res, chunk([], reason)));
    expect(await callGoogleProviderModel(f.input, f.options())).toMatchObject({ finishReason: "refusal", message: { content: null }, usage: { observed: false } });
  });

  it("normalizes prompt blocking and token truncation", async () => {
    const blocked = await fixture((_body, _req, res) => respond(res, { promptFeedback: { blockReason: "SAFETY" } }));
    expect((await callGoogleProviderModel(blocked.input, blocked.options())).finishReason).toBe("refusal");
    const length = await fixture((_body, _req, res) => respond(res, chunk([{ text: "partial" }], "MAX_TOKENS")));
    expect((await callGoogleProviderModel(length.input, length.options())).finishReason).toBe("length");
  });

  it.each([
    "data: {invalid}\n\n", sse(chunk([{ text: "unfinished" }])), 'data: {"candidates":[]}\n',
    sse(chunk([{ functionCall: { name: "echo", args: "partial" } }], "STOP")),
    sse(chunk([{ functionCall: { name: "echo", args: {} } }], "MAX_TOKENS")),
    sse(chunk([], "MALFORMED_FUNCTION_CALL")), sse(chunk([], "UNEXPECTED_TOOL_CALL")),
    sse(chunk([{ text: "" }], "STOP")), sse(chunk([{ inlineData: { mimeType: "image/png", data: "abc" } }], "STOP")),
    sse(chunk([{ text: "done" }], "STOP")) + sse(chunk([{ text: "extra" }])),
  ])("rejects malformed, unsupported or incomplete SSE before reporting completion", async body => {
    const f = await fixture((_body, _req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body); });
    await expect(callGoogleProviderModel(f.input, f.options())).rejects.toMatchObject({ outcome: "uncertain" }); expect(f.calls()).toBe(1);
  });

  it.each([
    { ...usage, thoughtsTokenCount: -1 }, { ...usage, totalTokenCount: 11 }, { ...usage, candidatesTokenCount: 20, totalTokenCount: 28 },
    { ...usage, cachedContentTokenCount: 6 }, { ...usage, promptTokenCount: Number.MAX_SAFE_INTEGER },
  ])("rejects unsafe or inconsistent usage counters", async metadata => {
    const f = await fixture((_body, _req, res) => respond(res, chunk([{ text: "OK" }], "STOP", metadata)));
    await expect(callGoogleProviderModel(f.input, f.options())).rejects.toMatchObject({ code: "MODEL_USAGE_INVALID" });
  });

  it("bounds request and raw response bytes before parsing", async () => {
    const f = await fixture((_body, _req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: " + "x".repeat(1000)); });
    await expect(callGoogleProviderModel({ ...f.input, maxRequestBytes: 1 }, f.options())).rejects.toMatchObject({ code: "MODEL_REQUEST_BYTES_EXCEEDED", outcome: "rejected" });
    expect(f.calls()).toBe(0);
    await expect(callGoogleProviderModel({ ...f.input, maxResponseBytes: 100 }, f.options())).rejects.toMatchObject({ code: "MODEL_RESPONSE_BYTES_EXCEEDED", outcome: "uncertain" });
  });

  it("cancels open streams and makes no pre-cancelled request", async () => {
    const f = await fixture((_body, _req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(chunk([{ text: "start" }]))); });
    const abort = new AbortController();
    const running = callGoogleProviderModel(f.input, { ...f.options(), signal: abort.signal, onText: () => abort.abort() });
    await expect(running).rejects.toMatchObject({ code: "MODEL_CANCELLED", outcome: "uncertain" });
    await expect(callGoogleProviderModel(f.input, { ...f.options(), signal: abort.signal })).rejects.toMatchObject({ code: "MODEL_CANCELLED_BEFORE_DISPATCH", outcome: "rejected" });
    expect(f.calls()).toBe(1);
  });

  it("rejects missing native tool history and revoked dispatch authority before sending", async () => {
    const f = await fixture((_body, _req, res) => respond(res, chunk([{ text: "OK" }], "STOP")));
    await expect(callGoogleProviderModel({ ...f.input, messages: [...f.input.messages,
      { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "call" }] }, f.options())).rejects.toMatchObject({ code: "MODEL_NATIVE_STATE_REQUIRED", outcome: "rejected" });
    const network = createModelFetch({ authorizeUrl: url => url.href === googleModelRequestUrl(f.input.baseUrl, f.input.model).href,
      headers: { "x-goog-api-key": "private-test-key" }, maxRequestBytes: 32000, maxResponseBytes: 32000, deadlineAt: Date.now() + 2000,
      beforeDispatch: () => { throw new Error("private-test-key revoked"); }, testLoopback: true });
    await expect(callGoogleProviderModel(f.input, { apiKey: "private-test-key", fetch: network })).rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    expect(f.calls()).toBe(0);
  });

  it("requires controlled fetch and exact safe model URLs", async () => {
    await expect(callGoogleProviderModel(request, { apiKey: "private-test-key" })).rejects.toMatchObject({ code: "MODEL_NETWORK_POLICY_REQUIRED" });
    expect(googleModelRequestUrl(request.baseUrl, "models/org/custom").pathname).toBe("/v1beta/models/org%2Fcustom:streamGenerateContent");
    for (const id of ["../escape", "models/../escape", "a//b", "a/./b", "a/../b", "bad\\name", "bad\nname", ""]) {
      expect(() => googleModelRequestUrl(request.baseUrl, id)).toThrow("MODEL_ENDPOINT_INVALID");
    }
    expect(() => googleModelRequestUrl("https://example.test/v1beta?key=secret", "model")).toThrow("MODEL_ENDPOINT_INVALID");
  });
});
