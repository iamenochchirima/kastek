import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/model/anthropic";
import { GeminiAdapter } from "../src/model/gemini";
import { OpenAICompatibleAdapter } from "../src/model/openai-compatible";

const credentials = { apiKey: "secret", fundingSource: "kasitek" as const };

afterEach(() => vi.unstubAllGlobals());

describe("provider response identity", () => {
  it("preserves response IDs from non-streaming provider envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "openrouter-response-1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "msg_123", content: [{ type: "text", text: "ok" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ responseId: "gemini-response-1", candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }), { status: 200 })));

    const openRouter = await new OpenAICompatibleAdapter({ provider: "openrouter", baseUrl: "https://example.test/v1" }).complete({ provider: "openrouter", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);
    const anthropic = await new AnthropicAdapter().complete({ provider: "anthropic", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);
    const gemini = await new GeminiAdapter().complete({ provider: "gemini", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);

    expect(openRouter.providerResponseId).toBe("openrouter-response-1");
    expect(anthropic.providerResponseId).toBe("msg_123");
    expect(gemini.providerResponseId).toBe("gemini-response-1");
  });

  it("preserves the first provider response ID from an OpenAI-compatible stream", async () => {
    const body = [
      'data: {"id":"chatcmpl-stream-1","choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"id":"chatcmpl-stream-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const response = await new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://example.test/v1" }).stream!({ provider: "openai", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials, () => undefined);

    expect(response.providerResponseId).toBe("chatcmpl-stream-1");
  });

  it("omits the identity when a provider does not return one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 })));

    const response = await new OpenAICompatibleAdapter({ provider: "openai", baseUrl: "https://example.test/v1" }).complete({ provider: "openai", model: "test", messages: [{ role: "user", content: "hi" }] }, credentials);

    expect(response).not.toHaveProperty("providerResponseId");
  });
});
