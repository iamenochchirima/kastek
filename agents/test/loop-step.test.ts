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

  it("preserves the durable tool checkpoint when a provider returns an empty final response", async () => {
    let providerCalls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return modelResponse([], providerCalls === 1 ? "" : "The result is ready.");
      },
    };
    const toolMessages = [
      { role: "user" as const, content: "find it" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "records.search", arguments: {} }] },
      { role: "tool" as const, name: "records.search", toolCallId: "call-1", content: JSON.stringify({ id: "record-1" }) },
    ];
    const common = {
      model: { provider: "openai" as const, model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      grantedTools: new Set<string>(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      deferToolExecution: true,
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    };

    const first = await runBoundedAgentLoop({ ...common, messages: toolMessages, operationKeyPrefix: "activity:loop:run:1" });
    expect(first.status).toBe("limited");
    expect(first.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(first.messages.some((message) => message.role === "user" && message.content.includes("previous response was empty"))).toBe(false);

    const second = await runBoundedAgentLoop({ ...common, messages: first.messages, operationKeyPrefix: "activity:loop:run:2" });
    expect(second.status).toBe("completed");
    expect(second.messages.at(-1)).toMatchObject({ role: "assistant", content: "The result is ready." });
    expect(providerCalls).toBe(2);
  });

  it("retries an empty first-turn response at the next durable model slice", async () => {
    let providerCalls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return modelResponse([], providerCalls === 1 ? "" : "The answer is ready.");
      },
    };
    const resultInput = {
      model: { provider: "openai" as const, model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      grantedTools: new Set<string>(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user" as const, content: "answer me" }],
      operationKeyPrefix: "activity:loop:first-turn-empty",
      deferToolExecution: true,
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    };

    const first = await runBoundedAgentLoop(resultInput);
    expect(first.status).toBe("limited");
    expect(first.error).toMatchObject({ code: "EMPTY_ASSISTANT_RESPONSE", failureClass: "retryable" });
    expect(first.messages.at(-1)).toMatchObject({ role: "user", content: "answer me" });

    const second = await runBoundedAgentLoop({ ...resultInput, messages: first.messages, operationKeyPrefix: "activity:loop:first-turn-empty:retry" });
    expect(second.status).toBe("completed");
    expect(second.messages.at(-1)).toMatchObject({ role: "assistant", content: "The answer is ready." });
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

  it("persists a complete tool batch for the durable host before invoking any tool", async () => {
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
    const proposed: string[] = [];
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([
        { id: "call-1", name: "records.search", arguments: {} },
        { id: "call-2", name: "records.search", arguments: { page: 2 } },
      ]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find both" }],
      operationKeyPrefix: "activity:loop:deferred",
      deferToolExecution: true,
      onToolProposed: async ({ runtimeOperationId }) => { proposed.push(runtimeOperationId); },
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(result.toolBatchPending).toBe(true);
    expect(result.authorizedToolNames).toEqual(["records.search"]);
    expect(result.pendingToolCalls?.map((call) => call.providerToolCallId)).toEqual(["call-1", "call-2"]);
    expect(proposed).toHaveLength(2);
    expect(invoked).toBe(0);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", toolCalls: expect.any(Array) });
  });

  it("runs independent read calls concurrently and keeps model result order", async () => {
    const tools = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    for (const name of ["records.first", "records.second"]) {
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
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, name.endsWith("first") ? 30 : 5));
          active -= 1;
          return { name };
        },
      });
    }
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([
        { id: "call-1", name: "records.first", arguments: {} },
        { id: "call-2", name: "records.second", arguments: {} },
      ]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.first", "records.second"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find both" }],
      operationKeyPrefix: "activity:loop:parallel",
      maxParallelToolCalls: 2,
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(maxActive).toBe(2);
    expect(result.messages.slice(-2).map((message) => message.toolCallId)).toEqual(["call-1", "call-2"]);
  });

  it("keeps external effects sequential even when adjacent in one model batch", async () => {
    const tools = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    for (const name of ["records.write-first", "records.write-second"]) {
      tools.register({
        name,
        version: "1.0.0",
        description: name,
        riskClass: "external-effect",
        requiresApproval: false,
        timeoutMs: 1_000,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        handler: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { name };
        },
      });
    }
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse([
        { id: "call-1", name: "records.write-first", arguments: {} },
        { id: "call-2", name: "records.write-second", arguments: {} },
      ]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.write-first", "records.write-second"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "write both" }],
      operationKeyPrefix: "activity:loop:sequential",
      limits: { maxIterations: 1, maxToolCalls: 16, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(maxActive).toBe(1);
    expect(result.messages.slice(-2).map((message) => message.toolCallId)).toEqual(["call-1", "call-2"]);
  });

  it("executes the admitted calls and returns typed budget results for the remainder", async () => {
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
    expect(result.messages).toContainEqual(expect.objectContaining({ role: "assistant", toolCalls: expect.any(Array) }));
    expect(invoked).toBe(1);
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "call-2",
      content: JSON.stringify({ ok: false, error: { code: "TOOL_CALL_BUDGET_EXCEEDED", message: "The run tool-operation budget was exhausted before this call could start" } }),
    }));
  });

  it("accepts an 18-call effect batch without rejecting the whole response", async () => {
    const tools = new ToolRegistry();
    let invoked = 0;
    let active = 0;
    let maxActive = 0;
    tools.register({
      name: "calendar.delete",
      version: "1.0.0",
      description: "Delete one calendar event",
      riskClass: "external-effect",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async (_context, args) => {
        invoked += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { deleted: args.eventId };
      },
    });
    const calls = Array.from({ length: 18 }, (_, index) => ({ id: `delete-${index + 1}`, name: "calendar.delete", arguments: { eventId: `event-${index + 1}` } }));
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => modelResponse(calls),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["calendar.delete"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "delete the events" }],
      operationKeyPrefix: "activity:loop:18-effects",
      limits: { maxIterations: 1, maxToolCalls: 4, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("limited");
    expect(result.toolCalls).toBe(18);
    expect(invoked).toBe(4);
    expect(maxActive).toBe(1);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(18);
    expect(result.messages.filter((message) => message.role === "tool" && message.content.includes("TOOL_CALL_BUDGET_EXCEEDED"))).toHaveLength(14);
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

  it("returns tool failures to the model as typed results instead of losing the turn", async () => {
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
      handler: async () => {
        throw new Error("calendar backend unavailable");
      },
    });
    let providerCalls = 0;
    const failures: Array<{ runtimeOperationId: string; code: string }> = [];
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request) => {
        providerCalls += 1;
        const toolFailure = request.messages.find((message) => message.role === "tool");
        return toolFailure
          ? modelResponse([], "I could not reach the records service.")
          : modelResponse([{ id: "call-1", name: "records.search", arguments: {} }]);
      },
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      operationKeyPrefix: "activity:loop:run:failure",
      limits: { maxIterations: 2, maxToolCalls: 2, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
      onToolFailed: async ({ runtimeOperationId, error }) => failures.push({ runtimeOperationId, code: error.code }),
    });

    expect(result.status).toBe("completed");
    expect(providerCalls).toBe(2);
    expect(failures).toEqual([{ runtimeOperationId: "activity:loop:run:failure:1:0:tool:1", code: "TOOL_FAILED" }]);
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "call-1",
      runtimeOperationId: "activity:loop:run:failure:1:0:tool:1",
      content: JSON.stringify({ ok: false, error: { code: "TOOL_FAILED", message: "calendar backend unavailable" } }),
    }));
  });

  it("stops an identical no-progress tool loop with a typed guard", async () => {
    const tools = new ToolRegistry();
    let invoked = 0;
    const operationIds: string[] = [];
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
      complete: async () => modelResponse([{ id: "reused-provider-id", name: "records.search", arguments: {} }]),
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      grantedTools: new Set(["records.search"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run" },
      messages: [{ role: "user", content: "find it" }],
      operationKeyPrefix: "activity:loop:run:guard",
      limits: { maxIterations: 4, maxToolCalls: 8, maxTotalTokens: 32_000, maxWallTimeMs: 10_000 },
      onToolProposed: async ({ runtimeOperationId }) => operationIds.push(runtimeOperationId),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "TOOL_REPETITION_GUARD" });
    expect(invoked).toBe(2);
    expect(operationIds).toEqual([
      "activity:loop:run:guard:1:0:tool:1",
      "activity:loop:run:guard:2:0:tool:1",
    ]);
  });
});
