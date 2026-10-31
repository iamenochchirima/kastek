import { describe, expect, it, vi } from "vitest";
import { ModelNetworkError } from "../src/infrastructure/model-network";
import { callProviderModel, getBundledProviderModels, type ProviderTransportRequest } from "../src/adapters/models/pi-transport";

const request: ProviderTransportRequest = {
  provider: "fixture", protocol: "openai_chat_completions", model: "fixture-model",
  baseUrl: "https://fixture.invalid/v1", credentialRevision: "key-1", contextWindowTokens: 32000,
  maxOutputTokens: 32, messages: [{ role: "user", content: "Hello" }],
};
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (usage?: object) => new Response(sse({ id: "response-1", model: "fixture-model",
  choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }) + "data: [DONE]\n\n",
  { headers: { "Content-Type": "text/event-stream" } });
const fetcher = (fn: (body: any) => Response) => (async (_url: unknown, init: RequestInit) => fn(JSON.parse(String(init.body)))) as typeof fetch;

describe("native model transport", () => {
  it("sends system instructions and tool declarations through the pinned SDK context contract", async () => {
    let body: any;
    await callProviderModel({ ...request, messages: [{ role: "system", content: "Follow the approved policy." }, ...request.messages],
      tools: [{ type: "function", function: { name: "lookup", description: "Read a record", parameters: { type: "object", properties: {} } } }] },
    { apiKey: "fixture-key", fetch: fetcher(value => { body = value; return chat(); }) });
    expect(body.messages.some((message: any) => message.content === "Follow the approved policy.")).toBe(true);
    expect(body.tools[0].function.name).toBe("lookup");
  });
  it("requires a configured network policy and retains confirmed pre-dispatch rejection", async () => {
    await expect(callProviderModel(request, { apiKey: "fixture-key" })).rejects.toMatchObject({ code: "MODEL_NETWORK_POLICY_REQUIRED", outcome: "rejected" });
    let calls = 0;
    await expect(callProviderModel(request, { apiKey: "fixture-key", fetch: (async () => {
      calls++; throw new ModelNetworkError("AUTHORIZATION_DENIED", false);
    }) as typeof fetch })).rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    expect(calls).toBe(1);
  });
  it("verifies a capped payload before dispatch without allowing the hook to rewrite it", async () => {
    let prepared = false, body: any;
    const progress = vi.fn();
    await callProviderModel(request, { apiKey: "fixture-key", onProgress: progress,
      beforePayloadDispatch: async payload => { expect(payload.max_tokens).toBe(32); (payload as any).max_tokens = 999; prepared = true; },
      fetch: fetcher(value => { expect(prepared).toBe(true); body = value; return chat({ prompt_tokens: 9, completion_tokens: 2 }); }) });
    expect(body.max_tokens).toBe(32); expect(progress).toHaveBeenCalled();
  });
  it("streams an exact capped request, reports actual usage, and retains private native state", async () => {
    const bodies: any[] = [], deltas: string[] = [];
    const result = await callProviderModel(request, { apiKey: "fixture-key", onText: value => deltas.push(value),
      fetch: fetcher(body => { bodies.push(body); return chat({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }); }) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBe(32);
    expect(deltas.join("")).toBe("Hello");
    expect(result.message.content).toBe("Hello");
    expect(result.usage).toMatchObject({ observed: true, inputTokens: 9, outputTokens: 2 });
    expect(result.nativeState.credentialRevision).toBe("key-1");
    expect(JSON.stringify(result)).not.toContain("fixture-key");
  });

  it("does not invent zero usage when the provider omits it", async () => {
    const result = await callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => chat()) });
    expect(result.usage).toEqual({ observed: false });
  });

  it.each([[400, "MODEL_REQUEST_INVALID"], [422, "MODEL_REQUEST_INVALID"], [401, "MODEL_AUTHENTICATION_FAILED"], [402, "MODEL_BILLING_REQUIRED"], [403, "MODEL_ACCESS_DENIED"],
    [404, "MODEL_UNAVAILABLE"], [429, "MODEL_RATE_LIMITED"]])("classifies HTTP %s as rejection without SDK retries", async (status, code) => {
    let calls = 0;
    await expect(callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => {
      calls++; return new Response(JSON.stringify({ error: { message: "fixture-key refused", type: "rate_limit" } }), { status: Number(status) });
    }) })).rejects.toMatchObject({ code, status, outcome: "rejected" });
    expect(calls).toBe(1);
  });

  it.each(["provider_error", "incomplete"])("classifies HTTP 200 %s after partial output as uncertain stream failure without exposing provider details", async kind => {
    let calls = 0;
    const deltas: string[] = [];
    const partial = sse({ id: "response-1", model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] });
    const tail = kind === "provider_error" ? sse({ error: { code: 503, message: "PRIVATE_PROVIDER_SECRET", metadata: { raw: "PRIVATE_PROMPT" } } }) : "data: [DONE]\n\n";
    const error = await callProviderModel(request, { apiKey: "fixture-key", onText: text => deltas.push(text), fetch: fetcher(() => {
      calls++; return new Response(partial + tail, { headers: { "Content-Type": "text/event-stream" } });
    }) }).catch(error => error);
    expect(deltas.join("")).toBe("Partial");
    expect(error).toMatchObject({ code: "MODEL_STREAM_FAILED", status: 502, outcome: "uncertain" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_SECRET|PRIVATE_PROMPT|fixture-key/);
    expect(calls).toBe(1);
  });

  it("rejects repaired partial tool arguments instead of executing them", async () => {
    const body = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
      function: { name: "lookup", arguments: '{"x":' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => new Response(body,
      { headers: { "Content-Type": "text/event-stream" } })) })).rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("uses exact Responses cap even below the library's minimum", async () => {
    let body: any;
    await callProviderModel({ ...request, protocol: "openai_responses", maxOutputTokens: 8 }, { apiKey: "fixture", fetch: fetcher(value => {
      body = value;
      return new Response(sse({ type: "response.created", response: { id: "response-1", model: "fixture-model" } }) +
        sse({ type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }) +
        sse({ type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
        sse({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "OK" }) +
        sse({ type: "response.completed", response: { id: "response-1", status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, output: [] } }),
      { headers: { "Content-Type": "text/event-stream" } });
    }) });
    expect(body.max_output_tokens).toBe(8);
  });

  it("preserves Anthropic native thinking and tool continuation", async () => {
    const bodies: any[] = [];
    const event = (type: string, value: object) => `event: ${type}\n${sse({ type, ...value })}`;
    const fetch = fetcher(body => {
      bodies.push(body);
      return new Response(event("message_start", { message: { id: "anthropic-1", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 4 } } }) +
        event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "private", signature: "opaque-signature" } }) +
        event("content_block_stop", { index: 0 }) +
        event("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } }) +
        event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"id":"a"}' } }) +
        event("content_block_stop", { index: 1 }) +
        event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) + event("message_stop", {}),
      { headers: { "Content-Type": "text/event-stream" } });
    });
    const first = await callProviderModel({ ...request, protocol: "anthropic_messages" }, { apiKey: "fixture", fetch });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(first.usage).toMatchObject({ observed: true, inputTokens: 7, cachedInputTokens: 4 });
    expect(first.message.content).toBeNull();
    const next = { ...request, protocol: "anthropic_messages" as const,
      messages: [...request.messages, first.message, { role: "tool" as const, content: "found", tool_call_id: "call-1" }],
      nativeHistory: { 1: first.nativeState } };
    await callProviderModel(next, { apiKey: "fixture", fetch });
    expect(JSON.stringify(bodies[1])).toContain("opaque-signature");
    expect(JSON.stringify(bodies[1])).toContain("tool_result");
    await expect(callProviderModel({ ...next, credentialRevision: "key-2" }, { apiKey: "fixture", fetch }))
      .rejects.toMatchObject({ code: "MODEL_NATIVE_STATE_MISMATCH" });
    expect(bodies).toHaveLength(2);
  });

  it("cancels an open stream and rejects pre-cancelled calls without dispatch", async () => {
    const abort = new AbortController();
    let calls = 0;
    const fetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        init.signal?.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const running = callProviderModel(request, { apiKey: "fixture", fetch, signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(running).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    await expect(callProviderModel(request, { apiKey: "fixture", fetch, signal: abort.signal }))
      .rejects.toMatchObject({ code: "MODEL_CANCELLED_BEFORE_DISPATCH" });
    expect(calls).toBe(1);
  });

  it("rejects missing keys and missing protected Google transport before dispatch", async () => {
    await expect(callProviderModel(request, { apiKey: "" })).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });
    await expect(callProviderModel({ ...request, protocol: "google_generate_content" }, { apiKey: "fixture" }))
      .rejects.toMatchObject({ code: "MODEL_NETWORK_POLICY_REQUIRED" });
  });

  it("uses Google's native function calls and retains opaque thought signatures", async () => {
    const bodies: any[] = [];
    const googleFetch = fetcher(body => {
      bodies.push(body);
      return new Response(sse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { id: "a" } }, thoughtSignature: "b3BhcXVlLWdvb2dsZQ==" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } }),
      { headers: { "Content-Type": "text/event-stream" } });
    });
    {
      const google = { ...request, protocol: "google_generate_content" as const, baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
      const first = await callProviderModel(google, { apiKey: "fixture-key", fetch: googleFetch });
      expect(first.message.tool_calls?.[0]?.function.name).toBe("lookup");
      expect(first.usage).toMatchObject({ observed: true, inputTokens: 5, outputTokens: 3 });
      expect(bodies[0].generationConfig.maxOutputTokens).toBe(32);
      await callProviderModel({ ...google, messages: [...google.messages, first.message,
        { role: "tool", content: "found", tool_call_id: first.message.tool_calls![0]!.id }], nativeHistory: { 1: first.nativeState } }, { apiKey: "fixture-key", fetch: googleFetch });
      expect(JSON.stringify(bodies[1])).toContain("b3BhcXVlLWdvb2dsZQ==");
      expect(JSON.stringify(bodies[1])).toContain("functionResponse");
    }
  });

  it("rejects a completed empty response", async () => {
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => new Response(sse({
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    }) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })) }))
      .rejects.toMatchObject({ code: "MODEL_EMPTY_RESPONSE" });
  });

  it.each([
    { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 9, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: -1 } },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2 },
  ])("rejects unsafe usage details and arithmetic", async usage => {
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => chat(usage)) }))
      .rejects.toMatchObject({ code: "MODEL_USAGE_INVALID" });
  });

  it("reads only exact-provider bundled metadata without network or credentials", async () => {
    const network = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", network);
    try {
      const models = await getBundledProviderModels("anthropic");
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toMatchObject({ id: expect.any(String), contextWindow: expect.any(Number), maxTokens: expect.any(Number) });
      expect(models[0]).not.toHaveProperty("tools");
      expect(await getBundledProviderModels("unknown-provider-fixture")).toEqual([]);
      models[0]!.input.push("fixture-only");
      expect((await getBundledProviderModels("anthropic"))[0]!.input).not.toContain("fixture-only");
      expect(network).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps explicit Google REST routing independent of ambient SDK backend flags", async () => {
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    try {
      const response = await callProviderModel({ ...request, protocol: "google_generate_content",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, { apiKey: "fixture", fetch: fetcher(() => new Response(sse({
          candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
        }), { headers: { "content-type": "text/event-stream" } })) });
      expect(response.message.content).toBe("OK");
    } finally { vi.unstubAllEnvs(); }
  });
});
