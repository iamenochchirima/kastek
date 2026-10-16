import { describe, expect, it, vi } from "vitest";
import { createAgentHarness } from "../src/runtime/harness";
import { ToolRegistry } from "../src/tools/registry";
import type { HostCapabilityRouter } from "../src/hosts/capabilities";
import type { BuiltAgentContext, ContextPolicy } from "../src/runtime/context";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const scope: ExecutionScope = {
  organizationId: "org",
  installationId: "installation",
  agentDefinitionId: "agent",
  agentVersionId: "version",
  runId: "run",
  correlationId: "correlation",
};

describe("AgentHarness", () => {
  it("uses the injected context policy as the model-context seam", () => {
    const expected = { marker: "context" } as unknown as BuiltAgentContext;
    const policy: ContextPolicy = { build: vi.fn(() => expected) };
    const harness = createAgentHarness({
      tools: new ToolRegistry(),
      host: {} as HostCapabilityRouter,
      contextPolicy: policy,
    });

    expect(harness.buildContext({
      instructions: "Policy",
      scope,
      currentMessage: "hello",
      recentMessages: [],
      authorizedTools: [],
    })).toBe(expected);
    expect(policy.build).toHaveBeenCalledOnce();
  });
});
