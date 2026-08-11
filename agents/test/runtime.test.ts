import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import type { ModelAdapter, ModelCredentials, ModelRequest, ModelResponse } from "../src/model/types";
import { ToolRegistry, hashToolArguments } from "../src/tools/registry";
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
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "user", content: "publish" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: registry,
      grantedTools: new Set(["platform.publish"]),
      toolContext: { organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "install", runId: "run", correlationId: "corr" },
    });
    expect(result.status).toBe("awaiting_approval");
    expect(result.pendingToolCalls?.[0]?.name).toBe("platform.publish");
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
});
