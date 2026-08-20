import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter, type ModelCredentials, type ModelRequest, type ModelResponse } from "../src/model/types";
import { ToolRegistry, effectIdForInvocation, hashToolArguments } from "../src/tools/registry";
import { runBoundedAgentLoop } from "../src/runtime/loop";
import { redactSensitiveValue } from "../src/tools/redaction";

const credentials: ModelCredentials = { apiKey: "test", fundingSource: "kasitek" };

function response(toolCalls: ModelResponse["toolCalls"], content = ""): ModelResponse {
  return {
    provider: "openai",
    model: "test-model",
    message: { role: "assistant", content },
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    latencyMs: 1,
  };
}

describe("Tool Gateway and bounded runtime", () => {
  it("redacts secret-like tool fields recursively before model-visible output", () => {
    expect(redactSensitiveValue({ profile: { name: "Ada" }, apiKey: "secret", nested: [{ token: "value" }] })).toEqual({ profile: { name: "Ada" }, apiKey: "[REDACTED]", nested: [{ token: "[REDACTED]" }] });
  });
  it("validates, grants, and executes a read-only tool", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "platform.echo",
      version: "1.0.0",
      description: "Echo a value",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1000,
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      handler: async (_context, input) => ({ value: input.value }),
    });
    const result = await registry.invoke({
      name: "platform.echo",
      arguments: { value: "hello" },
      grantedTools: new Set(["platform.echo"]),
      context: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result.output).toEqual({ value: "hello" });
    expect(result.effectId).toBeUndefined();
    expect(hashToolArguments({ b: 2, a: 1 })).toBe(hashToolArguments({ a: 1, b: 2 }));
  });

  it("pauses a loop when a consequential tool needs approval", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "platform.publish",
      version: "1.0.0",
      description: "Publish content",
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 1000,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (_request: ModelRequest) => response([{ id: "call-1", name: "platform.publish", arguments: { id: "post-1" } }]),
    };
    const effectStarts: string[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "publish" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["platform.publish"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      onToolExecuting: ({ name }) => effectStarts.push(name),
    });
    expect(result.status).toBe("awaiting_approval");
    expect(result.pendingToolCalls?.[0]?.name).toBe("platform.publish");
    expect(effectStarts).toEqual([]);
    expect(effectIdForInvocation({ runId: "run" }, "platform.publish", hashToolArguments({ id: "post-1" }))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("runs the durable pre-effect boundary immediately before the provider handler", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    registry.register({
      name: "platform.effect",
      version: "1.0.0",
      description: "effect",
      riskClass: "external-effect",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => { order.push("provider"); return { ok: true }; },
    });
    await registry.invoke({
      name: "platform.effect",
      arguments: {},
      grantedTools: new Set(["platform.effect"]),
      context: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      beforeEffect: async () => { order.push("receipt-executing"); },
    });
    expect(order).toEqual(["receipt-executing", "provider"]);
  });

  it("continues after a tool result and completes without a tool call", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "platform.echo",
      version: "1.0.0",
      description: "Echo",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        calls += 1;
        return calls === 1 ? response([{ id: "call-1", name: "platform.echo", arguments: {} }]) : response([], "done");
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "echo" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["platform.echo"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "done" });
  });

  it("fails cleanly when a provider returns an empty final assistant response", async () => {
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => response([]),
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "EMPTY_ASSISTANT_RESPONSE" });
  });

  it("uses an explicitly configured fallback model after a provider failure", async () => {
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request) => {
        if (request.model === "primary") throw new ModelProviderError("primary unavailable", "PROVIDER_DOWN", false, "openai", 503);
        return response([], "fallback response");
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary" },
      fallbackModels: [{ model: { provider: "openai", model: "fallback" }, credentials }],
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter], { circuitFailureThreshold: 10 }),
      tools: new ToolRegistry(),
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result.status).toBe("completed");
    expect(result.response?.message.content).toBe("fallback response");
  });

  it("stops before invoking a tool when the run tool-call budget is exhausted", async () => {
    const registry = new ToolRegistry();
    let invoked = 0;
    registry.register({
      name: "platform.echo",
      version: "1.0.0",
      description: "Echo",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => { invoked += 1; return { ok: true }; },
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => response([{ id: "call-budget", name: "platform.echo", arguments: {} }]),
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "echo" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["platform.echo"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      limits: { maxToolCalls: 0 },
    });
    expect(result.status).toBe("limited");
    expect(result.toolCalls).toBe(1);
    expect(result.error).toBeUndefined();
    expect(invoked).toBe(0);
  });

  it("returns a bounded result when the iteration budget is reached", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "platform.echo",
      version: "1.0.0",
      description: "Echo",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => response([{ id: "call-iteration", name: "platform.echo", arguments: {} }]),
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "keep going" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["platform.echo"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      limits: { maxIterations: 1, maxToolCalls: 10 },
    });
    expect(result.status).toBe("limited");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(1);
  });
});
