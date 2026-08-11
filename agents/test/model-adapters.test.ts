import { describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/model/anthropic";
import { GeminiAdapter } from "../src/model/gemini";
import { OpenAICompatibleAdapter } from "../src/model/openai-compatible";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter } from "../src/model/types";

const credentials = { apiKey: "secret", fundingSource: "kasitek" as const };

describe("provider adapters", () => {
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
