import { describe, expect, it, vi } from "vitest";
import { createCapabilityRuntime } from "../src/capabilities/runtime";
import { ToolRegistry } from "../src/tools/registry";
import { ToolPolicyError } from "../src/tools/types";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const scope: ExecutionScope = {
  organizationId: "org",
  installationId: "installation",
  agentDefinitionId: "agent",
  agentVersionId: "version",
  runId: "run",
  correlationId: "correlation",
};

function registry(availability?: "not_configured" | "unhealthy"): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "example.read",
    version: "1.0.0",
    description: "Read an example",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
    manifest: {
      ownerService: "test",
      requiredScope: "example:read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "access",
      redaction: [],
      ...(availability ? { availability } : {}),
    },
    handler: async () => ({ ok: true }),
  });
  return tools;
}

describe("CapabilityRuntime", () => {
  it("makes readiness and grants part of the invocation seam", async () => {
    const runtime = createCapabilityRuntime({ registry: registry() });
    const request = {
      name: "example.read",
      arguments: {},
      grantedTools: new Set(["example.read"]),
      context: { scope, organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "installation", runId: "run", correlationId: "correlation" },
    };
    await expect(runtime.invoke(request)).resolves.toMatchObject({ name: "example.read", output: { ok: true } });
    await expect(runtime.invoke({ ...request, grantedTools: new Set() })).rejects.toMatchObject<ToolPolicyError>({ code: "TOOL_NOT_GRANTED" });
  });

  it("does not invoke capabilities whose declared readiness is unhealthy", async () => {
    const runtime = createCapabilityRuntime({ registry: registry("unhealthy") });
    await expect(runtime.invoke({
      name: "example.read",
      arguments: {},
      grantedTools: new Set(["example.read"]),
      context: { scope, organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "installation", runId: "run", correlationId: "correlation" },
    })).rejects.toMatchObject<ToolPolicyError>({ code: "CAPABILITY_UNHEALTHY" });
  });

  it("keeps durable prepare, redacted completion, and failure evidence on the capability seam", async () => {
    const runtime = createCapabilityRuntime({ registry: registry() });
    const lifecycle = {
      prepare: async () => ({ status: "new" as const }),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const request = {
      name: "example.read",
      arguments: {},
      grantedTools: new Set(["example.read"]),
      context: { scope, organizationId: "org", agentId: "agent", agentVersionId: "version", installationId: "installation", runId: "run", correlationId: "correlation" },
      lifecycle,
    };

    await expect(runtime.invoke(request)).resolves.toMatchObject({ output: { ok: true } });
    expect(lifecycle.complete).toHaveBeenCalledWith(expect.objectContaining({ redactedOutput: { ok: true } }));
    expect(lifecycle.fail).not.toHaveBeenCalled();

    const replay = { name: "example.read", version: "1.0.0", argumentsHash: "hash", output: { ok: true }, latencyMs: 0 };
    await expect(runtime.invoke({ ...request, lifecycle: {
      prepare: async () => ({ status: "completed" as const, result: replay }),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    } })).resolves.toEqual(replay);
  });
});
