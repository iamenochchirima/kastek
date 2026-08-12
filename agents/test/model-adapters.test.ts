import { describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/model/anthropic";
import { GeminiAdapter } from "../src/model/gemini";
import { OpenAICompatibleAdapter } from "../src/model/openai-compatible";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter } from "../src/model/types";
import { resolveModelTarget } from "../src/model/policy";

const credentials = { apiKey: "secret", fundingSource: "kasitek" as const };

describe("provider adapters", () => {
  it("resolves a versioned primary, fast, and bounded fallback model policy", () => {
    const target = resolveModelTarget({}, { modelPolicy: { version: "v1", primary: { provider: "openrouter", model: "primary" }, fast: { provider: "openai", model: "fast" }, fallback: [{ provider: "gemini", model: "fallback" }], maxTokensPerRun: 1000 } });
    expect(target).toMatchObject({ provider: "openrouter", model: "primary", policyVersion: "v1", maxTokensPerRun: 1000, fallback: [{ provider: "gemini", model: "fallback" }] });
  });
  it("retries retryable provider failures and applies configured pricing", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        attempts += 1;
        if (attempts === 1) throw new ModelProviderError("busy", "PROVIDER_RATE_LIMITED", true, "openai", 429);
        return {
          provider: "openai",
          model: "test",
          message: { role: "assistant", content: "ok" },
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
          latencyMs: 1,
        };
      },
    };
    const result = await new ModelGateway([adapter], { retryBaseDelayMs: 0, pricing: { "openai:test": { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } } }).complete(
      { provider: "openai", model: "test", messages: [{ role: "user", content: "hi" }] },
      credentials,
    );
    expect(attempts).toBe(2);
    expect(result.usage.estimatedCostUsd).toBe(4);
  });

  it("opens a provider circuit after repeated terminal provider failures", async () => {
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => { throw new ModelProviderError("down", "PROVIDER_DOWN", false, "openai", 503); },
    };
    const gateway = new ModelGateway([adapter], { circuitFailureThreshold: 2, circuitCooldownMs: 60_000 });
    const request = { provider: "openai" as const, model: "test", messages: [{ role: "user" as const, content: "hi" }] };
    await expect(gateway.complete(request, credentials)).rejects.toMatchObject({ code: "PROVIDER_DOWN" });
    await expect(gateway.complete(request, credentials)).rejects.toMatchObject({ code: "PROVIDER_DOWN" });
    await expect(gateway.complete(request, credentials)).rejects.toMatchObject({ code: "MODEL_CIRCUIT_OPEN" });
  });
  it("normalizes an OpenAI-compatible tool response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call-1", function: { name: "echo", arguments: '{"value":"ok"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://example.test/v1" });
    const result = await adapter.complete({ provider: "openai", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);
    expect(result.toolCalls[0]).toMatchObject({ id: "call-1", name: "echo", arguments: { value: "ok" } });
    expect(result.message.toolCalls?.[0]?.name).toBe("echo");
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/v1/chat/completions", expect.any(Object));
    vi.unstubAllGlobals();
  });

  it("uses provider-safe aliases for dotted canonical tool names and restores them", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      requestBody = JSON.parse(String(options.body)) as Record<string, unknown>;
      const tool = (requestBody.tools as Array<{ function: { name: string } }>)[0]!;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-time", function: { name: tool.function.name, arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({ provider: "openrouter", baseUrl: "https://example.test/v1" });
    const result = await adapter.complete({
      provider: "openrouter",
      model: "test",
      messages: [{ role: "user", content: "What time is it?" }],
      tools: [{ name: "platform.current_time", description: "Get time", inputSchema: { type: "object" } }],
    }, credentials);
    const sentToolName = ((requestBody!.tools as Array<{ function: { name: string } }>)[0]!).function.name;
    expect(sentToolName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(sentToolName).not.toContain(".");
    expect(result.toolCalls[0]).toMatchObject({ name: "platform.current_time", arguments: {} });
    vi.unstubAllGlobals();
  });

  it("validates structured output against the requested JSON schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: '{"answer":"ok"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://example.test/v1" });
    const result = await new ModelGateway([adapter]).complete({
      provider: "openai",
      model: "test",
      messages: [{ role: "user", content: "return json" }],
      responseFormat: { type: "json_schema", name: "answer", schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } },
    }, credentials);
    expect(result.structuredOutput).toEqual({ answer: "ok" });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("json_schema");
    vi.unstubAllGlobals();
  });

  it("streams OpenAI-compatible text deltas and returns a normalized response", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const adapter = new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://example.test/v1" });
    const deltas: string[] = [];
    const result = await new ModelGateway([adapter]).stream({ provider: "openai", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials, (delta) => { if (delta.type === "text_delta") deltas.push(delta.text); });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(result).toMatchObject({ deltas: 2, response: { message: { content: "hello" }, finishReason: "stop", usage: { totalTokens: 4 } } });
    vi.unstubAllGlobals();
  });

  it("normalizes Anthropic text and tool blocks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tool-1", name: "echo", input: { value: "ok" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 4, output_tokens: 5 },
    }), { status: 200 })));
    const result = await new AnthropicAdapter().complete({ provider: "anthropic", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);
    expect(result.message.content).toBe("checking");
    expect(result.toolCalls[0]).toMatchObject({ name: "echo", arguments: { value: "ok" } });
    vi.unstubAllGlobals();
  });

  it("normalizes Gemini function calls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: { value: "ok" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200 })));
    const result = await new GeminiAdapter().complete({ provider: "gemini", model: "gemini-test", messages: [{ role: "user", content: "hi" }] }, credentials);
    expect(result.toolCalls[0]).toMatchObject({ name: "echo", arguments: { value: "ok" } });
    vi.unstubAllGlobals();
  });
});
