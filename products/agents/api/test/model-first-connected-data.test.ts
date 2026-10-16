import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import type { ModelAdapter, ModelCredentials, ModelRequest, ModelResponse } from "../src/model/types";
import { HostCapabilityRouter } from "../src/hosts/router";
import { createAgentHarness } from "../src/runtime/harness";
import { createEffectiveCapabilitySnapshot } from "../src/runtime/effective-capabilities";
import { createExecutionScope } from "../src/runtime/execution-scope";
import { toolInvocationContextFromScope, type ToolDefinition } from "../src/tools/types";
import { ToolRegistry } from "../src/tools/registry";

const scope = createExecutionScope({
  organizationId: "org-1",
  installationId: "installation-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  sessionId: "session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  correlationId: "correlation-1",
  capabilityGrants: ["kasitek.calendar.list"],
});

const credentials: ModelCredentials = { apiKey: "test-key", fundingSource: "kasitek" };
const lifecycle = {
  propose: async () => undefined,
  prepare: async () => ({ status: "new" as const }),
  complete: async () => undefined,
  fail: async () => undefined,
};

function calendarDefinition(): Omit<ToolDefinition, "handler"> {
  return {
    name: "kasitek.calendar.list",
    version: "1.0.0",
    description: "List events from the connected Google Calendar.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", properties: { date: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object" },
    catalog: {
      kind: "connector_tool",
      source: { kind: "connector", id: "google.calendar" },
      provider: { id: "google", name: "Google Calendar" },
    },
  };
}

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

describe("model-first connected data", () => {
  it("gives the model the connected Calendar schema and feeds its result back", async () => {
    const definition = calendarDefinition();
    const registry = new ToolRegistry();
    registry.register({
      ...definition,
      handler: async () => ({ events: [{ title: "Planning", start: "2026-09-10T09:00:00Z" }] }),
    });
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [definition],
      grantedTools: [definition.name],
      connections: [{
        id: "google.calendar",
        displayName: "Google Calendar",
        providerId: "google",
        status: "connected",
        capabilityIds: [definition.name],
      }],
      message: "What do I have on my calendar?",
    });
    const requests: ModelRequest[] = [];
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request) => {
        requests.push(request);
        calls += 1;
        return calls === 1
          ? response({
            message: { role: "assistant", content: "", toolCalls: [{ id: "calendar-1", name: definition.name, arguments: { date: "2026-09-10" } }] },
            toolCalls: [{ id: "calendar-1", name: definition.name, arguments: { date: "2026-09-10" } }],
            finishReason: "tool_calls",
          })
          : response({ message: { role: "assistant", content: "You have Planning at 09:00 UTC." } });
      },
    };
    const harness = createAgentHarness({ tools: registry, host: new HostCapabilityRouter() });
    const result = await harness.runTurn({
      plan: {
        model: { provider: "openai", model: "test-model", maxTokens: 200 },
        credentials,
        gateway: new ModelGateway([adapter]),
        grantedTools: new Set([definition.name]),
        modelTools: [...snapshot.model.callableTools],
        capabilitySnapshot: snapshot,
        toolContext: toolInvocationContextFromScope(scope),
      },
      messages: [{ role: "user", content: "What do I have on my calendar?" }],
      toolLifecycle: lifecycle,
      limits: { maxIterations: 3, maxToolCalls: 2, maxTotalTokens: 2_000, maxWallTimeMs: 5_000 },
    });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    expect(calls).toBe(2);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toContain(definition.name);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("Planning"))).toBe(true);
    expect(result.response?.message.content).toContain("Planning");
  });
});
