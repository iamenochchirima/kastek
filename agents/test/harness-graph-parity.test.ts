import { describe, expect, it } from "vitest";
import { executeWorkflowGraph } from "../src/workflows/executor";
import { createAgentHarness } from "../src/runtime/harness";
import { createExecutionScope } from "../src/runtime/execution-scope";
import { toolInvocationContextFromScope } from "../src/tools/types";
import { HostCapabilityRouter } from "../src/hosts/router";
import { ToolRegistry } from "../src/tools/registry";
import { ModelGateway } from "../src/model/gateway";
import type { ModelAdapter, ModelCredentials, ModelRequest, ModelResponse } from "../src/model/types";
import type { AgentExecutionPlan } from "../src/runtime/execution-plan";

const scope = createExecutionScope({
  organizationId: "org-1",
  installationId: "installation-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  sessionId: "session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  correlationId: "correlation-1",
});

const credentials: ModelCredentials = { apiKey: "test-key", fundingSource: "kasitek" };

function response(input: Partial<ModelResponse>): ModelResponse {
  return {
    provider: "openai",
    model: "test-model",
    message: { role: "assistant", content: "done" },
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, estimatedCostUsd: 0 },
    latencyMs: 1,
    ...input,
  };
}

function createHarness() {
  const tools = new ToolRegistry();
  tools.register({
    name: "lookup",
    version: "1.0.0",
    description: "Look up a value",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    handler: async () => ({ value: "found" }),
  });
  let calls = 0;
  const adapter: ModelAdapter = {
    provider: "openai",
    capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
    complete: async (_request: ModelRequest) => {
      calls += 1;
      return calls === 1
        ? response({
          message: { role: "assistant", content: "", toolCalls: [{ id: "tool-1", name: "lookup", arguments: { query: "value" } }] },
          toolCalls: [{ id: "tool-1", name: "lookup", arguments: { query: "value" } }],
          finishReason: "tool_calls",
        })
        : response({ message: { role: "assistant", content: "The value is found." } });
    },
  };
  const harness = createAgentHarness({ tools, host: new HostCapabilityRouter() });
  return { harness, gateway: new ModelGateway([adapter]), calls: () => calls };
}

async function runTurn(harness: ReturnType<typeof createHarness>["harness"], gateway: ModelGateway, onEvent: (type: string) => void) {
  return harness.runTurn({
    plan: {
      model: { provider: "openai", model: "test-model", maxTokens: 200 },
      credentials,
      gateway,
      grantedTools: new Set(["lookup"]),
      toolContext: toolInvocationContextFromScope(scope),
    } satisfies AgentExecutionPlan,
    messages: [{ role: "user", content: "Find the value" }],
    limits: { maxIterations: 3, maxToolCalls: 2, maxTotalTokens: 2_000, maxWallTimeMs: 5_000 },
    onEvent: (event) => onEvent(event.type),
  });
}

describe("ordinary and graph harness parity", () => {
  it("uses the same model/tool turn contract for an ordinary turn and an agent-loop graph node", async () => {
    const ordinary = createHarness();
    const ordinaryEvents: string[] = [];
    const ordinaryResult = await runTurn(ordinary.harness, ordinary.gateway, (type) => ordinaryEvents.push(type));

    const graph = createHarness();
    const graphEvents: string[] = [];
    const graphResult = await executeWorkflowGraph({
      version: 1,
      entryNodeId: "agent",
      nodes: [{ id: "agent", type: "agent_loop", writes: ["answer"] }],
      edges: [],
      stateSchema: {},
    }, {}, {
      agentLoop: async () => {
        const result = await runTurn(graph.harness, graph.gateway, (type) => graphEvents.push(type));
        return {
          status: result.status,
          output: result.completionMessage ?? result.response?.message.content,
          response: result.response,
          usage: {
            modelCalls: 2,
            toolCalls: result.toolCalls,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            estimatedCostUsd: result.usage.estimatedCostUsd,
          },
        };
      },
    });

    expect(ordinaryResult.status).toBe("completed");
    expect(graphResult.status).toBe("completed");
    expect(ordinaryResult.toolCalls).toBe(1);
    expect(graphResult.usage.toolCalls).toBe(1);
    expect(graphResult.state.answer).toBe(ordinaryResult.completionMessage ?? ordinaryResult.response?.message.content);
    expect(ordinaryEvents).toEqual(graphEvents);
    expect(ordinary.calls()).toBe(2);
    expect(graph.calls()).toBe(2);
  });
});
