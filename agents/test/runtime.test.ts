import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter, type ModelCredentials, type ModelRequest, type ModelResponse } from "../src/model/types";
import { ToolRegistry, effectIdForInvocation, hashToolArguments } from "../src/tools/registry";
import { runBoundedAgentLoop } from "../src/runtime/loop";
import { redactSensitiveValue } from "../src/tools/redaction";
import { agentResponseSchema, agentResponseToolInputSchema } from "../src/media/contracts";

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
  it("completes a hosted response through the typed media control", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "kasitek.agent.respond",
      version: "1.0.0",
      description: "Respond with media",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: agentResponseToolInputSchema,
      outputSchema: {
        type: "object",
        properties: { control: { type: "string", const: "final_response" }, response: agentResponseToolInputSchema },
        required: ["control", "response"],
        additionalProperties: false,
      },
      handler: async (_context, args) => ({ control: "final_response", response: agentResponseSchema.parse(args) }),
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => response([{ id: "reply-1", name: "kasitek.agent.respond", arguments: { text: "Here it is", media: [{ assetId: "asset-1", kind: "image" }] } }]),
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "show image" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["kasitek.agent.respond"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result).toMatchObject({ status: "completed", completionMessage: "Here it is", completionResponse: { version: "1", media: [{ assetId: "asset-1", kind: "image" }] } });
  });

  it("replays a durable model response without calling the provider twice", async () => {
    const registry = new ToolRegistry();
    let providerCalls = 0;
    let stored: ModelResponse | undefined;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return response([], "durable reply");
      },
    };
    const run = () => runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      prepareModelCall: async () => stored ? { status: "completed", response: stored } : { status: "new" },
      persistModelResponse: async ({ response: modelResponse }) => { stored = modelResponse; },
    });

    await expect(run()).resolves.toMatchObject({ status: "completed", response: { message: { content: "durable reply" } } });
    await expect(run()).resolves.toMatchObject({ status: "completed", response: { message: { content: "durable reply" } } });
    expect(providerCalls).toBe(1);
  });

  it("replays after run-budget settlement without treating the settled reservation as a failure", async () => {
    const registry = new ToolRegistry();
    let providerCalls = 0;
    let stored: ModelResponse | undefined;
    let budgetCaptured = false;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        providerCalls += 1;
        return response([], "settled reply");
      },
    };
    const run = () => runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      prepareModelCall: async () => stored ? { status: "completed", response: stored } : { status: "new" },
      persistModelResponse: async ({ response: modelResponse }) => { stored = modelResponse; },
      reserveRunBudget: async () => {
        if (budgetCaptured) throw new Error("MODEL_CALL_ALREADY_SETTLED");
        return {
          capture: async () => { budgetCaptured = true; },
          release: async () => undefined,
        };
      },
    });

    await expect(run()).resolves.toMatchObject({ status: "completed", response: { message: { content: "settled reply" } } });
    await expect(run()).resolves.toMatchObject({ status: "completed", response: { message: { content: "settled reply" } } });
    expect(providerCalls).toBe(1);
  });

  it("marks a model operation unknown instead of replaying an unproven provider call", async () => {
    const registry = new ToolRegistry();
    let markedUnknown = 0;
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([]),
      tools: registry,
      grantedTools: new Set(),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      prepareModelCall: async () => ({ status: "unknown" }),
      reserveRunBudget: async () => ({
        capture: async () => undefined,
        release: async () => undefined,
        markUnknown: async () => { markedUnknown += 1; },
      }),
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "AGENT_LOOP_FAILED", message: "MODEL_CALL_OUTCOME_UNKNOWN" } });
    expect(markedUnknown).toBe(1);
  });

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

  it("completes an approved publish with a trusted reply without another model call", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "kasitek.core.content_post_publish",
      version: "1.0.0",
      description: "Publish content",
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => ({
        post: { title: "KasiTek Agents Teaser", channels: ["THREADS"], status: "PUBLISHED" },
        result: { platform: "THREADS", status: "PUBLISHED" },
      }),
    });
    let modelCalls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        modelCalls += 1;
        return response([], "model reply");
      },
    };
    const argumentsValue = { postId: "post-1", platform: "THREADS" };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "publish" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["kasitek.core.content_post_publish"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      resumeApprovedToolCall: {
        id: "call-1",
        name: "kasitek.core.content_post_publish",
        arguments: argumentsValue,
        approval: {
          approvedBy: "user",
          argumentsHash: hashToolArguments(argumentsValue),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.completionMessage).toBe("Published “KasiTek Agents Teaser” to Threads.");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: result.completionMessage });
    expect(modelCalls).toBe(0);
  });

  it("returns a useful channel-safe error when an approved Bluesky publish fails", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "kasitek.core.content_post_publish",
      version: "1.0.0",
      description: "Publish content",
      riskClass: "external-effect",
      requiresApproval: true,
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => { throw new Error('Bluesky token refresh failed: {"error":"invalid_grant","error_description":"Invalid refresh token"}'); },
    });
    const argumentsValue = { postId: "post-1", platform: "BLUESKY" };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "publish" }],
      credentials,
      gateway: new ModelGateway([]),
      tools: registry,
      grantedTools: new Set(["kasitek.core.content_post_publish"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
      resumeApprovedToolCall: {
        id: "call-1",
        name: "kasitek.core.content_post_publish",
        arguments: argumentsValue,
        approval: { approvedBy: "user", argumentsHash: hashToolArguments(argumentsValue), expiresAt: new Date(Date.now() + 60_000).toISOString() },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.userMessage).toBe("I couldn’t publish the post because the Bluesky connection has expired. Reconnect Bluesky, then try again.");
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

  it("stops the model loop when a conversation action requests human ownership", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "conversation.request_human",
      version: "1.0.0",
      description: "Request a human",
      riskClass: "controlled-write",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => ({
        status: "handoff_requested",
        handoffRequestId: "handoff-1",
        conversationId: "conversation-1",
        agentPaused: true,
        created: true,
        control: "awaiting_human",
      }),
    });
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => response([{ id: "call-handoff", name: "conversation.request_human", arguments: {} }]),
    };
    const events: string[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "I need a person" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["conversation.request_human"]),
      toolContext: {
        organizationId: "org",
        agentId: "agent",
        agentVersionId: "version",
        installationId: "install",
        runId: "run",
        correlationId: "corr",
        conversationId: "conversation-1",
      },
      onEvent: (event) => { if (event.type === "loop.paused") events.push(String(event.payload.reason)); },
    });
    expect(result.status).toBe("awaiting_human");
    expect(result.waitingFor).toBe("handoff-1");
    expect(events).toEqual(["handoff"]);
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

  it("settles each hosted model attempt and releases failed fallback reservations", async () => {
    const events: string[] = [];
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
      reserveModelCall: async ({ request }) => {
        events.push(`reserve:${request.model}`);
        return {
          capture: async () => { events.push(`capture:${request.model}`); },
          release: async () => { events.push(`release:${request.model}`); },
        };
      },
    });
    expect(result.status).toBe("completed");
    expect(events).toEqual(["reserve:primary", "release:primary", "reserve:fallback", "capture:fallback"]);
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
