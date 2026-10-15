import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { OpenCodeAdapter } from "../src/model/opencode";
import { openCodeModelProtocol } from "../src/model/opencode-route";
import type { ModelProvider } from "../src/model/types";

const credentials = { apiKey: "opencode-secret", fundingSource: "user" as const, credentialReference: "credential-1" };
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("OpenCode model routing", () => {
  it.each([
    ["opencode_zen", "deepseek-v4-pro", "openai-chat-completions"],
    ["opencode_zen", "gpt-6-sol", "openai-responses"],
    ["opencode_zen", "claude-sonnet-5", "anthropic-messages"],
    ["opencode_zen", "gemini-3.8-flash", "gemini-generate-content"],
    ["opencode_go", "minimax-m3", "anthropic-messages"],
    ["opencode_go", "longcat-2.0", "openai-chat-completions"],
  ] as const)("routes %s model %s through %s", (provider, model, protocol) => {
    expect(openCodeModelProtocol(provider, model)).toBe(protocol);
  });

  it("uses the Responses API for OpenCode GPT models and restores tool names", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const functionName = ((requestBody.tools as Array<{ name: string }>)[0]!).name;
      return Response.json({
        id: "resp-1",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Looking that up." }] },
          { type: "function_call", call_id: "call-1", name: functionName, arguments: "{\"id\":\"42\"}" },
        ],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new OpenCodeAdapter("opencode_zen", "https://opencode.ai/zen/v1");
    const result = await adapter.complete({
      provider: "opencode_zen",
      model: "gpt-6-sol",
      messages: [{ role: "user", content: "Find record 42" }],
      tools: [{ name: "platform.records.read", description: "Read a record", inputSchema: { type: "object" } }],
      maxTokens: 100,
    }, credentials);

    expect(fetchMock).toHaveBeenCalledWith("https://opencode.ai/zen/v1/responses", expect.objectContaining({ method: "POST" }));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer opencode-secret");
    expect(requestBody?.max_output_tokens).toBe(100);
    expect(result).toMatchObject({
      provider: "opencode_zen",
      model: "gpt-6-sol",
      providerResponseId: "resp-1",
      message: { content: "Looking that up." },
      toolCalls: [{ id: "call-1", name: "platform.records.read", arguments: { id: "42" } }],
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    expect(JSON.stringify(requestBody)).not.toContain("runtimeOperationId");
  });

  it.each([
    ["opencode_zen", "claude-sonnet-5", "https://opencode.ai/zen/v1/messages"],
    ["opencode_go", "minimax-m3", "https://opencode.ai/zen/go/v1/messages"],
  ] as const)("uses the Anthropic Messages route and its key header for %s/%s", async (provider, model, url) => {
    const fetchMock = vi.fn(async () => Response.json({ content: [{ type: "text", text: "Message route works." }], usage: { input_tokens: 2, output_tokens: 3 } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new OpenCodeAdapter(provider, provider === "opencode_go" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1");
    const result = await adapter.complete({ provider, model, messages: [{ role: "user", content: "Hello" }] }, credentials);

    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("opencode-secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(result.message.content).toBe("Message route works.");
  });

  it("uses the Gemini generation route for OpenCode Zen Gemini models", async () => {
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "Gemini route works." }] }, finishReason: "STOP" }] }));
    globalThis.fetch = fetchMock as typeof fetch;
    const adapter = new OpenCodeAdapter("opencode_zen", "https://opencode.ai/zen/v1");

    const result = await adapter.complete({ provider: "opencode_zen", model: "gemini-3.8-flash", messages: [{ role: "user", content: "Hello" }] }, credentials);

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe("/zen/v1/models/gemini-3.8-flash:generateContent");
    expect(new URL(String(input)).searchParams.get("key")).toBe("opencode-secret");
    expect(init?.method).toBe("POST");
    expect(result.message.content).toBe("Gemini route works.");
  });

  it("uses model-specific capabilities and rejects unclassified model routes", async () => {
    const gateway = new ModelGateway();
    expect(gateway.capabilities("opencode_zen", "deepseek-v4-pro")?.streaming).toBe(true);
    expect(gateway.capabilities("opencode_zen", "gpt-6-sol")?.streaming).toBe(false);
    expect(gateway.capabilities("opencode_zen", "gemini-3.8-flash")?.toolCalling).toBe(true);
    await expect(gateway.complete({ provider: "opencode_go", model: "omen-alpha", messages: [{ role: "user", content: "Hello" }] }, credentials))
      .rejects.toMatchObject({ code: "MODEL_PROTOCOL_UNSUPPORTED" });
  });
});
