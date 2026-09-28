import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter, type ModelResponse } from "../src/model/types";
import { runBoundedAgentLoop } from "../src/runtime/loop";
import { hashToolArguments, ToolRegistry } from "../src/tools/registry";

const credentials = { apiKey: "test", fundingSource: "kasitek" as const };

function response(content: string): ModelResponse {
  return {
    provider: "openai",
    model: "test-model",
    message: { role: "assistant", content },
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    latencyMs: 1,
  };
}

describe("Temporal inner activity fault boundaries", () => {
  it("allows a retryable provider failure to use the configured fallback without duplicating durable settlement", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let prepared: string[] = [];
    let settled: string[] = [];
    const primary: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        primaryCalls += 1;
        throw new ModelProviderError("provider unavailable", "PROVIDER_UNAVAILABLE", true, "openai");
      },
    };
    const fallback: ModelAdapter = {
      provider: "gemini",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        fallbackCalls += 1;
        return response("fallback response");
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary" },
      fallbackModels: [{ model: { provider: "gemini", model: "fallback" }, credentials }],
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([primary, fallback], { retryBaseDelayMs: 0 }),
      tools: new ToolRegistry(),
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      prepareModelCall: async ({ operationKey }) => {
        prepared.push(operationKey);
        return { status: "new" };
      },
      persistModelResponse: async ({ operationKey }) => { settled.push(operationKey); },
      limits: { maxIterations: 1, maxToolCalls: 0, maxTotalTokens: 100, maxWallTimeMs: 10_000 },
    });

    expect(result).toMatchObject({ status: "completed", response: { message: { content: "fallback response" } } });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
    expect(prepared).toHaveLength(2);
    expect(settled).toEqual([prepared[1]]);
  });

  it("replays a provider response when the database fails after durable response persistence", async () => {
    let providerCalls = 0;
    let stored: ModelResponse | undefined;
    let persistenceAttempts = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return response("durable response");
      },
    };
    const run = () => runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      prepareModelCall: async () => stored ? { status: "completed", response: stored } : { status: "new" },
      persistModelResponse: async ({ response: persisted }) => {
        stored = persisted;
        persistenceAttempts += 1;
        if (persistenceAttempts === 1) throw new Error("database connection dropped after commit");
      },
      limits: { maxIterations: 1, maxToolCalls: 0, maxTotalTokens: 100, maxWallTimeMs: 10_000 },
    });

    await expect(run()).resolves.toMatchObject({ status: "failed", error: { code: "AGENT_LOOP_FAILED" } });
    await expect(run()).resolves.toMatchObject({ status: "completed", response: { message: { content: "durable response" } } });
    expect(providerCalls).toBe(1);
    expect(persistenceAttempts).toBe(1);
  });

  it("replays a completed tool when the database fails after the handler and durable outcome", async () => {
    const tools = new ToolRegistry();
    let handlerCalls = 0;
    let outcomeRecorded = false;
    tools.register({
      name: "records.lookup",
      version: "1.0.0",
      description: "Lookup a record",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => {
        handlerCalls += 1;
        return { id: "record-1" };
      },
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => ({ ...response(""), message: { role: "assistant", content: "" }, toolCalls: [{ id: "call-1", name: "records.lookup", arguments: {} }], finishReason: "tool_calls" }),
    };
    const run = () => runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "lookup" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.lookup"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      replayToolInvocation: async () => outcomeRecorded ? { name: "records.lookup", version: "1.0.0", argumentsHash: hashToolArguments({}), output: { id: "record-1" }, latencyMs: 1 } : undefined,
      onToolCompleted: async () => {
        outcomeRecorded = true;
        throw new Error("database connection dropped after tool outcome commit");
      },
      limits: { maxIterations: 1, maxToolCalls: 1, maxTotalTokens: 100, maxWallTimeMs: 10_000 },
    });

    await expect(run()).resolves.toMatchObject({ status: "failed", error: { code: "AGENT_LOOP_FAILED" } });
    await expect(run()).resolves.toMatchObject({ status: "limited", toolCalls: 1 });
    expect(handlerCalls).toBe(1);
  });
});
