import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import type { ModelAdapter, ModelResponse } from "../src/model/types";
import { runBoundedAgentLoop } from "../src/runtime/loop";
import { ToolRegistry } from "../src/tools/registry";

const credentials = { apiKey: "test", fundingSource: "kasitek" as const };

function modelResponse(toolCalls: ModelResponse["toolCalls"], content = ""): ModelResponse {
  return {
    provider: "openai",
    model: "test-model",
    message: { role: "assistant", content },
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    latencyMs: 1,
  };
}

describe("bounded loop activity slices", () => {
  it("continues from persisted messages after one model/tool slice", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "records.search",
      version: "1.0.0",
      description: "Search records",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => ({ id: "record-1" }),
    });
    let providerCalls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? modelResponse([{ id: "call-1", name: "records.search", arguments: {} }])
          : modelResponse([], "The record is ready.");
      },
    };
    const common = {
      model: { provider: "openai" as const, model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    };

    const first = await runBoundedAgentLoop({ ...common, messages: [{ role: "user", content: "find it" }], operationKeyPrefix: "activity:loop:run:0" });
    expect(first.status).toBe("limited");
    expect(first.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });

    const second = await runBoundedAgentLoop({ ...common, messages: first.messages, operationKeyPrefix: "activity:loop:run:1" });
    expect(second.status).toBe("completed");
    expect(second.messages.at(-1)).toMatchObject({ role: "assistant", content: "The record is ready." });
    expect(providerCalls).toBe(2);
  });
});
