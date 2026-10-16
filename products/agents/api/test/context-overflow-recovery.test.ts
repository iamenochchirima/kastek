import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import { ModelProviderError, type ModelAdapter, type ModelCredentials, type ModelRequest } from "../src/model/types";
import { ToolRegistry } from "../src/tools/registry";
import { runBoundedAgentLoop } from "../src/runtime/loop";

const credentials: ModelCredentials = { apiKey: "test", fundingSource: "kasitek" };

describe("provider context overflow recovery", () => {
  it("limits once and never retries or falls back with the same doomed context", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request: ModelRequest) => {
        calls += 1;
        throw new ModelProviderError("context length exceeded", "CONTEXT_LENGTH_EXCEEDED", false, "openai", 400);
      },
    };
    const events: string[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary" },
      fallbackModels: [{ model: { provider: "openai", model: "fallback" }, credentials }],
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org-1", installationId: "installation-1", runId: "run-1" },
      grantedTools: new Set(),
      onEvent: (event) => { events.push(event.type); },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "limited", error: { code: "PROVIDER_CONTEXT_OVERFLOW" } });
    expect(events).toContain("loop.limited");
  });

  it("replans once with stricter pressure before returning a terminal overflow", async () => {
    const requests: ModelRequest[] = [];
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async (request: ModelRequest) => {
        requests.push(request);
        calls += 1;
        if (calls === 1) throw new ModelProviderError("context length exceeded", "CONTEXT_LENGTH_EXCEEDED", false, "openai", 400);
        return {
          provider: "openai",
          model: request.model,
          message: { role: "assistant", content: "recovered" },
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
          latencyMs: 1,
        };
      },
    };
    const events: string[] = [];
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary", maxTokens: 80 },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org-1", installationId: "installation-1", runId: "run-1" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "primary", contextWindowTokens: 1_000, maxOutputTokens: 80, safetyMarginTokens: 10, capabilitySource: "configured_override" },
      onEvent: (event) => { events.push(event.type); },
    });
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(requests[1]?.maxTokens).toBeLessThan(requests[0]?.maxTokens ?? Number.MAX_SAFE_INTEGER);
    expect(events).toContain("context.recovery");
  });

  it("keeps payload byte rejection separate from token context overflow", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "openai",
      capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
      complete: async () => {
        calls += 1;
        throw new ModelProviderError("request entity too large", "PAYLOAD_TOO_LARGE", false, "openai", 413);
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "primary" },
      messages: [{ role: "user", content: "hello" }],
      credentials,
      gateway: new ModelGateway([adapter]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org-1", installationId: "installation-1", runId: "run-1" },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "primary", contextWindowTokens: 1_000, maxOutputTokens: 80, capabilitySource: "configured_override" },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "limited", error: { code: "PROVIDER_PAYLOAD_TOO_LARGE" } });
  });
});
