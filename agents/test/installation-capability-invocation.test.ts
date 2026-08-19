import { describe, expect, it, vi } from "vitest";
import { InstallationCapabilityError, InstallationCapabilityInvocationService } from "../src/invocation/installation-capability";
import { InstallationImmediateReadService } from "../src/invocation/immediate-read";
import { ToolRegistry } from "../src/tools/registry";

function registry() {
  const tools = new ToolRegistry();
  tools.registerManifest({
    name: "content.publish",
    version: "1.0.0",
    description: "publish",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 1_000,
    inputSchema: { type: "object", required: ["postId"], properties: { postId: { type: "string", minLength: 1 } }, additionalProperties: false },
    outputSchema: { type: "object" },
    handler: async () => ({}),
    manifest: { ownerService: "core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: [] },
  });
  return tools;
}

function readRegistry() {
  const tools = new ToolRegistry();
  tools.registerManifest({
    name: "platform.current_time",
    version: "1.0.0",
    description: "time",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", required: ["iso"] },
    handler: async () => ({ iso: "2026-08-13T00:00:00.000Z" }),
    manifest: { ownerService: "agents", requiredScope: "platform.time.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [] },
  });
  return tools;
}

function createService(overrides: Record<string, unknown> = {}) {
  const startWorkflow = vi.fn(async () => undefined);
  const runs = { createRun: vi.fn(async () => ({ id: "run-1", status: "received", created: true })) };
  const base = {
    agents: { getInstallation: vi.fn(async () => ({ id: "install-1", organization_id: "org-1", status: "active", agent_version_id: "version-1", agent_definition_id: "agent-1" })) },
    runs,
    toolGrants: { effectiveTools: vi.fn(async () => new Set(["content.publish"])) },
    installationGrants: { effective: vi.fn(async () => ({ resources: [{ resourceType: "content_post", resourceId: "post-1" }] })) },
    killSwitches: { isBlocked: vi.fn(async () => false) },
    tools: registry(),
    temporalEnabled: true,
    startWorkflow,
  };
  return { service: new InstallationCapabilityInvocationService({ ...base, ...overrides } as never), runs, startWorkflow };
}

const input = { organizationId: "org-1", actorId: "installation:install-1", installationId: "install-1", name: "content.publish", argumentsValue: { postId: "post-1" }, toolCallId: "call-1", idempotencyKey: "key-1" };

describe("InstallationCapabilityInvocationService", () => {
  it("accepts an approval-required proposal without executing the effect", async () => {
    const { service, runs, startWorkflow } = createService();
    const result = await service.accept(input);
    expect(result.manifest.requiresApproval).toBe(true);
    expect(runs.createRun).toHaveBeenCalledOnce();
    expect(startWorkflow).toHaveBeenCalledWith("run-1");
  });

  it("uses the same resource policy as hosted execution before creating a run", async () => {
    const { service, runs } = createService({ installationGrants: { effective: vi.fn(async () => ({ resources: [] })) } });
    await expect(service.accept(input)).rejects.toMatchObject<Partial<InstallationCapabilityError>>({ code: "RESOURCE_NOT_GRANTED" });
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  it("keeps protected KasiAi resource scope unconstrained by default", async () => {
    const { service, runs } = createService({
      installationGrants: {
        effective: vi.fn(async () => ({ resources: [] })),
        isResourceScopeUnconstrained: vi.fn(async () => true),
      },
    });
    const result = await service.accept(input);
    expect(result.accepted).toMatchObject({ id: "run-1", status: "received" });
    expect(runs.createRun).toHaveBeenCalledOnce();
  });

  it("stops a killed installation before durable acceptance", async () => {
    const { service, runs } = createService({ killSwitches: { isBlocked: vi.fn(async () => true) } });
    await expect(service.accept(input)).rejects.toMatchObject<Partial<InstallationCapabilityError>>({ code: "AGENT_KILL_SWITCH_ACTIVE" });
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  it("permits only an explicitly immediate read through the non-Temporal path", async () => {
    const immediateRead = vi.fn(async () => ({ accepted: { id: "read-run", status: "completed" }, output: { iso: "2026-08-13T00:00:00.000Z" } }));
    const { service, startWorkflow } = createService({
      tools: readRegistry(),
      toolGrants: { effectiveTools: vi.fn(async () => new Set(["platform.current_time"])) },
      temporalEnabled: false,
      startWorkflow: undefined,
      immediateRead,
    });
    const result = await service.accept({ ...input, name: "platform.current_time", argumentsValue: {} });
    expect(result.immediate).toBe(true);
    expect(result.output).toEqual({ iso: "2026-08-13T00:00:00.000Z" });
    expect(immediateRead).toHaveBeenCalledOnce();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("records an immediate read as a durable run and tool-evidence outcome", async () => {
    const createRun = vi.fn(async () => ({ id: "read-run", status: "received", created: true, correlation_id: "correlation-1" }));
    const transitionRun = vi.fn(async () => undefined);
    const completeRun = vi.fn(async () => ({ id: "read-run", status: "completed", output: { iso: "2026-08-13T00:00:00.000Z" } }));
    const recordProposal = vi.fn(async () => undefined);
    const recordCompleted = vi.fn(async () => undefined);
    const service = new InstallationImmediateReadService({
      runs: { createRun, transitionRun, completeRun } as never,
      toolInvocations: { recordProposal, recordCompleted, recordFailed: vi.fn() } as never,
      tools: readRegistry(),
    });
    const result = await service.execute({
      organizationId: "org-1",
      actorId: "installation:install-1",
      installationId: "install-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      name: "platform.current_time",
      argumentsValue: {},
      toolCallId: "call-1",
      idempotencyKey: "read-idempotency-1",
      grantedTools: new Set(["platform.current_time"]),
    });
    expect(result.output).toEqual({ iso: "2026-08-13T00:00:00.000Z" });
    expect(transitionRun).toHaveBeenNthCalledWith(1, "read-run", "received", "queued", expect.objectContaining({ execution: "immediate" }));
    expect(transitionRun).toHaveBeenNthCalledWith(2, "read-run", "queued", "running", expect.objectContaining({ execution: "immediate" }));
    expect(recordProposal).toHaveBeenCalledWith(expect.objectContaining({ riskClass: "read", requiresApproval: false }));
    expect(recordCompleted).toHaveBeenCalledWith(expect.objectContaining({ runId: "read-run", providerToolCallId: "call-1" }));
    expect(completeRun).toHaveBeenCalledOnce();
  });
});
