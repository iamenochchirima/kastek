import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter, type ModelCredentials, type ModelRequest } from "../src/model/types";
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
  it("keeps the active assistant tool round in the next model request", async () => {
    const requests: ModelRequest[] = [];
    let invocations = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "kasitek.calendar.list",
      version: "1.0.0",
      description: "List calendar events",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => {
        invocations += 1;
        return { events: [{ title: "Planning" }] };
      },
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request) => {
        requests.push(request);
        const hasCalendarResult = request.messages.some((message) => message.role === "tool" && message.toolCallId === "calendar-call-1");
        const toolCalls = hasCalendarResult ? [] : [{ id: "calendar-call-1", name: "kasitek.calendar.list", arguments: {} }];
        return {
          provider: "openai",
          model: request.model,
          message: { role: "assistant", content: hasCalendarResult ? "You have one planning event." : "", ...(toolCalls.length ? { toolCalls } : {}) },
          toolCalls,
          finishReason: toolCalls.length ? "tool_calls" : "stop",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          latencyMs: 1,
        };
      },
    };

    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "What is on my calendar?" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools,
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(["kasitek.calendar.list"]),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 2_000, maxOutputTokens: 128, safetyMarginTokens: 10, capabilitySource: "configured_override" },
      limits: { maxIterations: 4, maxToolCalls: 4, maxTotalTokens: 10_000, maxWallTimeMs: 10_000 },
    });

    expect(result.status).toBe("completed");
    expect(invocations).toBe(1);
    expect(requests).toHaveLength(2);
    const runtimeOperationId = requests[1]?.messages.find((message) => message.role === "assistant")?.toolCalls?.[0]?.runtimeOperationId;
    expect(runtimeOperationId).toBe("model:1:0:tool:1");
    expect(requests[1]?.messages.slice(-3)).toEqual([
      { role: "user", content: "What is on my calendar?" },
      { role: "assistant", content: "", toolCalls: [{ id: "calendar-call-1", name: "kasitek.calendar.list", arguments: {}, runtimeOperationId }] },
      { role: "tool", name: "kasitek.calendar.list", toolCallId: "calendar-call-1", runtimeOperationId, content: JSON.stringify({ events: [{ title: "Planning" }] }) },
    ]);
  });

  it("compacts history before dispatch and leaves the current request intact", async () => {
    const requests: ModelRequest[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const manifests: Array<{ provider: string; model: string; status: string; manifest: { identity: Record<string, unknown>; reservedOutputTokens: number } }> = [];
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
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 220, maxOutputTokens: 32, safetyMarginTokens: 10, capabilitySource: "configured_override" },
      persistContextManifest: (input) => { manifests.push(input as typeof manifests[number]); },
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: "policy" },
      { role: "user", content: "current question" },
    ]);
    expect(requests[0]?.maxTokens).toBe(32);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.manifest.reservedOutputTokens).toBe(requests[0]?.maxTokens);
    expect(manifests[0]).toMatchObject({ provider: "openai", model: "test-model", status: "compacted", manifest: { identity: { turnId: "run", modelAttemptId: "model:1:0" } } });
    expect(events.find((event) => event.type === "context.planned")?.payload).toMatchObject({
      decision: "compact",
      accounting: { basis: "full_estimate", capabilitySource: "configured_override" },
      manifest: { identity: { modelAttemptId: "model:1:0", turnId: "run" } },
    });
    expect(events.find((event) => event.type === "context.capability_resolved")?.payload).toMatchObject({ capabilitySource: "configured_override", contextWindowTokens: 220 });
    expect(events.find((event) => event.type === "model.started")?.payload).toMatchObject({
      provider: "openai",
      model: "test-model",
    });
    expect(events.find((event) => event.type === "model.completed")?.payload).toMatchObject({
      contextMeasurementBasis: "provider_reported",
      contextUsageAnchor: {
        schemaVersion: "v1",
        operationKey: "model:1:0",
        manifestDigest: expect.any(String),
        sourceDigest: expect.any(String),
        compactionGeneration: 1,
      },
    });
  });

  it("uses one output reservation for the manifest and dispatch when the run budget clamps output", async () => {
    const requests: ModelRequest[] = [];
    const manifests: Array<{ manifest: { reservedOutputTokens: number } }> = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapterWithText(requests)]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 1_000, maxOutputTokens: 128, safetyMarginTokens: 10, capabilitySource: "configured_override" },
      limits: { maxTotalTokens: 24 },
      persistContextManifest: (input) => { manifests.push(input as typeof manifests[number]); },
    });

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(manifests).toHaveLength(1);
    expect(requests[0]?.maxTokens).toBeLessThan(24);
    expect(manifests[0]?.manifest.reservedOutputTokens).toBe(requests[0]?.maxTokens);
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
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 100, maxOutputTokens: 32, safetyMarginTokens: 10, capabilitySource: "configured_override" },
    });

    expect(result).toMatchObject({
      status: "limited",
      error: {
        code: "CONTEXT_PLAN_REJECTED",
        userMessage: expect.stringContaining("fit"),
        remediation: expect.stringContaining("Shorten"),
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("returns typed remediation when the durable run budget cannot admit the planned context", async () => {
    const requests: ModelRequest[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapterWithText(requests)]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 1_000, maxOutputTokens: 64, capabilitySource: "configured_override" },
      limits: { maxTotalTokens: 1 },
    });

    expect(result).toMatchObject({
      status: "limited",
      error: {
        code: "CONTEXT_RUN_BUDGET_EXCEEDED",
        userMessage: expect.stringContaining("run token budget"),
        remediation: expect.stringContaining("Shorten"),
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("fails closed before dispatch when an autonomous turn has no capacity evidence", async () => {
    const requests: ModelRequest[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "unknown-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapterWithText(requests)]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      requireContextCapability: true,
    });
    expect(result).toMatchObject({
      status: "limited",
      error: {
        code: "CONTEXT_CAPABILITY_UNKNOWN",
        userMessage: expect.stringContaining("verified context capacity"),
        remediation: expect.stringContaining("verified context metadata"),
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("records first-token timing when the selected adapter streams", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: true, vision: false },
      complete: async () => { throw new Error("complete should not be called"); },
      stream: async (request, _credentials, onDelta) => {
        await onDelta({ type: "text_delta", text: "streamed" });
        return {
          provider: "openai",
          model: request.model,
          message: { role: "assistant", content: "streamed" },
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, inputTokensReported: true, outputTokensReported: true },
          latencyMs: 4,
        };
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "stream-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "stream-model", contextWindowTokens: 1_000, maxOutputTokens: 64, capabilitySource: "configured_override" },
      streamModel: true,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toContain("model.first_token");
    expect(events.find((event) => event.type === "model.completed")?.payload).toMatchObject({ firstTokenAt: expect.any(String), timeToFirstTokenMs: expect.any(Number) });
  });

  it("resolves a distinct capability before a fallback model is dispatched", async () => {
    const planned: Array<{ model: unknown; window: unknown }> = [];
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request) => {
        requests.push(request);
        if (request.model === "primary") throw new ModelProviderError("primary unavailable", "PROVIDER_DOWN", false, "openai", 503);
        return { provider: "openai", model: request.model, message: { role: "assistant", content: "fallback response" }, toolCalls: [], finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, latencyMs: 1 };
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary" },
      fallbackModels: [{ model: { provider: "openai", model: "fallback" }, credentials }],
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org", installationId: "installation", runId: "run" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "primary", contextWindowTokens: 1_000, maxOutputTokens: 64, safetyMarginTokens: 10, capabilitySource: "configured_override" },
      contextCapabilityResolver: ({ model, profile }) => ({ ...profile, model, contextWindowTokens: model === "primary" ? 220 : 900, capabilitySource: "catalog" }),
      onEvent: (event) => {
        if (event.type === "context.planned") planned.push({ model: event.payload.model, window: (event.payload.accounting as Record<string, unknown> | undefined)?.contextWindowTokens });
      },
    });
    expect(result.status).toBe("completed");
    expect(requests.map((request) => request.model)).toEqual(["primary", "fallback"]);
    expect(planned).toEqual([{ model: "primary", window: 220 }, { model: "fallback", window: 900 }]);
  });
});
