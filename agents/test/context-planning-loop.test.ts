import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { type ModelAdapter, type ModelCredentials, type ModelRequest } from "../src/model/types";
import { ToolRegistry } from "../src/tools/registry";
import { runBoundedAgentLoop } from "../src/runtime/loop";

const credentials: ModelCredentials = { apiKey: "test", fundingSource: "kasitek" };

function adapterWithText(calls: ModelRequest[]): ModelAdapter {
  return {
    provider: "openai",
    capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
    complete: async (request) => {
      calls.push(request);
      return {
        provider: "openai",
        model: request.model,
        message: { role: "assistant", content: "bounded response" },
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        latencyMs: 1,
      };
    },
  };
}

describe("context planner at the model boundary", () => {
  it("compacts history before dispatch and leaves the current request intact", async () => {
    const requests: ModelRequest[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "old context ".repeat(80) },
        { role: "user", content: "current question" },
      ],
      credentials,
      gateway: new ModelGateway([adapterWithText(requests)]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 220, maxOutputTokens: 32, safetyMarginTokens: 10 },
    });

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: "policy" },
      { role: "user", content: "current question" },
    ]);
  });

  it("does not call a provider when the current message cannot fit", async () => {
    const requests: ModelRequest[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "x".repeat(2_000) }],
      credentials,
      gateway: new ModelGateway([adapterWithText(requests)]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 100, maxOutputTokens: 32, safetyMarginTokens: 10 },
    });

    expect(result).toMatchObject({ status: "limited", error: { code: "CONTEXT_PLAN_REJECTED" } });
    expect(requests).toHaveLength(0);
  });
});
