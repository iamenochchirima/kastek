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
        expect(request.maxAttempts).toBe(1);
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
});
