import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { type ModelAdapter, type ModelCredentials, type ModelRequest } from "../src/model/types";
import { ToolRegistry } from "../src/tools/registry";
import { runBoundedAgentLoop } from "../src/runtime/loop";

const credentials: ModelCredentials = { apiKey: "test", fundingSource: "kasitek" };

describe("bounded empty-response recovery", () => {
  it("retries a blank final response once and continues with visible output", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (_request: ModelRequest) => {
        calls += 1;
        return {
          provider: "openai",
          model: "test-model",
          message: { role: "assistant", content: calls === 1 ? "" : "Recovered answer" },
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: calls === 1 ? 0 : 3, totalTokens: calls === 1 ? 5 : 8 },
          latencyMs: 1,
        };
      },
    };
    const events: Array<Record<string, unknown>> = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      grantedTools: new Set(),
      toolContext: { organizationId: "org", installationId: "install", runId: "run" },
      onEvent: (event) => { if (event.type === "loop.started") events.push(event.payload); },
      limits: { maxEmptyResponseRetries: 1 },
    });

    expect(result.status).toBe("completed");
    expect(result.response?.message.content).toBe("Recovered answer");
    expect(calls).toBe(2);
    expect(events).toContainEqual({ reason: "empty_response_retry", retry: 1, maxRetries: 1 });
  });
});
