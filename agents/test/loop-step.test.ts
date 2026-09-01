import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import type { ModelAdapter, ModelResponse } from "../src/model/types";
import { runBoundedAgentLoop } from "../src/runtime/loop";
import { hashToolArguments, ToolRegistry } from "../src/tools/registry";

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

  it("keeps all tool calls from one model response in the same slice", async () => {
    const tools = new ToolRegistry();
    const invoked: string[] = [];
    for (const name of ["records.search", "records.lookup"]) {
      tools.register({
        name,
        version: "1.0.0",
        description: name,
        riskClass: "read",
        requiresApproval: false,
        timeoutMs: 1_000,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        handler: async () => {
          invoked.push(name);
          return { name };
        },
      });
    }
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([
        { id: "call-1", name: "records.search", arguments: {} },
        { id: "call-2", name: "records.lookup", arguments: {} },
      ]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search", "records.lookup"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      operationKeyPrefix: "activity:loop:run:0",
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(result.toolCalls).toBe(2);
    expect(invoked).toEqual(["records.search", "records.lookup"]);
    expect(result.messages.slice(-3)).toMatchObject([
      { role: "assistant" },
      { role: "tool", toolCallId: "call-1" },
      { role: "tool", toolCallId: "call-2" },
    ]);
  });

  it("does not execute a partial multi-tool response when the remaining budget is too small", async () => {
    const tools = new ToolRegistry();
    let invoked = 0;
    tools.register({
      name: "records.search",
      version: "1.0.0",
      description: "Search records",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => {
        invoked += 1;
        return { ok: true };
      },
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([
        { id: "call-1", name: "records.search", arguments: {} },
        { id: "call-2", name: "records.search", arguments: {} },
      ]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      operationKeyPrefix: "activity:loop:run:0",
      limits: { maxIterations: 1, maxToolCalls: 1, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(result.toolCalls).toBe(2);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(invoked).toBe(0);
  });

  it("replays a completed tool outcome without consuming budget or invoking the handler", async () => {
    const tools = new ToolRegistry();
    let invoked = 0;
    let consumed = 0;
    let completed = 0;
    tools.register({
      name: "records.search",
      version: "1.0.0",
      description: "Search records",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object" },
      handler: async () => {
        invoked += 1;
        return { id: "fresh" };
      },
    });
    const argumentsValue = { query: "record" };
    const argumentsHash = hashToolArguments(argumentsValue);
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([{ id: "call-1", name: "records.search", arguments: argumentsValue }]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      operationKeyPrefix: "activity:loop:run:retry",
      limits: { maxIterations: 1, maxToolCalls: 1, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
      consumeRunToolCall: async () => {
        consumed += 1;
      },
      replayToolInvocation: async () => ({ name: "records.search", version: "1.0.0", argumentsHash, output: { id: "record-1" }, latencyMs: 7 }),
      onToolCompleted: async () => {
        completed += 1;
      },
    });

    expect(result.status).toBe("limited");
    expect(result.toolCalls).toBe(1);
    expect(invoked).toBe(0);
    expect(consumed).toBe(0);
    expect(completed).toBe(0);
    expect(result.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1", content: JSON.stringify({ id: "record-1" }) });
  });

  it("fails closed when a replayed outcome is outside the provider call scope", async () => {
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
      handler: async () => ({ id: "fresh" }),
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([{ id: "call-1", name: "records.search", arguments: {} }]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      replayToolInvocation: async () => ({ name: "records.search", version: "1.0.0", argumentsHash: "wrong", output: { id: "record-1" }, latencyMs: 7 }),
      limits: { maxIterations: 1, maxToolCalls: 1, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "TOOL_REPLAY_SCOPE_CONFLICT" });
  });
});
