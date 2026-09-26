import { describe, expect, it, vi } from "vitest";
import {
  createPluginToolDefinition,
  DeterministicPluginSubprocessFactory,
  IsolatedPluginAdapter,
  type ExtensionPackageManifest,
  type ExtensionPackageRuntime,
  type PluginWorkerResponse,
} from "../src/extensions";
import { createCapabilityRuntime } from "../src/capabilities/runtime";
import { createEffectiveCapabilitySnapshot } from "../src/runtime/effective-capabilities";
import { hashToolArguments, ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const packageChecksum = "a".repeat(64);

const scope: ExecutionScope = {
  organizationId: "org-staging-smoke",
  installationId: "installation-playground",
  agentDefinitionId: "agent-demo",
  agentVersionId: "agent-version-1",
  runId: "run-staging-smoke",
  correlationId: "correlation-staging-smoke",
  capabilityGrants: ["calendar.read", "calendar.write", "booking.read"],
};

function manifest(overrides: Partial<ToolDefinition["manifest"]> = {}): ToolDefinition["manifest"] {
  return {
    ownerService: "staging-smoke",
    requiredScope: "staging:read",
    execution: "immediate",
    idempotency: "not_applicable",
    approval: "none",
    auditClassification: "access",
    redaction: [],
    ...overrides,
  };
}

function baseTool(input: Pick<ToolDefinition, "name" | "description"> & Partial<Pick<ToolDefinition, "riskClass" | "requiresApproval" | "manifest" | "catalog">>): ToolDefinition {
  return {
    name: input.name,
    version: "1.0.0",
    description: input.description,
    riskClass: input.riskClass ?? "read",
    requiresApproval: input.requiresApproval ?? false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
    manifest: input.manifest ?? manifest(),
    catalog: input.catalog,
    handler: async () => ({ ok: true }),
  };
}

function pluginManifest(): ExtensionPackageManifest {
  return {
    manifestVersion: 1,
    id: "booking-plugin",
    version: "1.0.0",
    checksum: packageChecksum,
    kind: "plugin",
    runtime: { id: "kasitek-agent-runtime", versionRange: "^2.0.0", requiredFeatures: ["plugin-subprocess-v1"] },
    execution: { mode: "plugin", entrypoint: "plugin.register" },
    dependencies: [],
    permissions: ["booking.read"],
  };
}

function pluginRuntime(): ExtensionPackageRuntime {
  return {
    runtimeId: "kasitek-agent-runtime",
    runtimeVersion: "2.4.0",
    supportedFeatures: ["plugin-subprocess-v1"],
    supportedExecutionModes: ["plugin"],
    trustedChecksums: [{ kind: "plugin", id: "booking-plugin", version: "1.0.0", checksum: packageChecksum }],
    grantedPermissions: ["booking.read"],
    configuration: {},
  };
}

function registryWithStagingCapabilities(): { registry: ToolRegistry; effect: ReturnType<typeof vi.fn>; plugin: ToolDefinition } {
  const registry = new ToolRegistry();
  registry.register(baseTool({
    name: "workspace.read",
    description: "Read workspace data",
    catalog: { kind: "builtin_tool", source: { kind: "builtin", id: "workspace", version: "1.0.0" } },
  }));
  registry.register(baseTool({
    name: "calendar.list",
    description: "List calendar events",
    manifest: manifest({ ownerService: "calendar-adapter", requiredScope: "calendar:read" }),
    catalog: { kind: "connector_tool", source: { kind: "connector", id: "calendar", version: "1.0.0" }, provider: { id: "calendar", name: "Calendar" } },
  }));
  registry.register(baseTool({
    name: "mcp.calendar.search",
    description: "Search calendar through MCP",
    manifest: manifest({ ownerService: "mcp-calendar", requiredScope: "calendar:read" }),
    catalog: { kind: "mcp_tool", source: { kind: "mcp", id: "calendar-mcp", version: "1.0.0" }, provider: { id: "calendar-mcp", name: "Calendar MCP" } },
  }));
  const effect = vi.fn(async () => ({ ok: true }));
  registry.register({
    ...baseTool({
      name: "calendar.create",
      description: "Create a calendar event",
      riskClass: "external-effect",
      requiresApproval: true,
      manifest: manifest({ ownerService: "calendar-adapter", requiredScope: "calendar:write", execution: "durable", idempotency: "required", approval: "always", auditClassification: "full" }),
      catalog: { kind: "connector_tool", source: { kind: "connector", id: "calendar", version: "1.0.0" }, provider: { id: "calendar", name: "Calendar" } },
    }),
    inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false },
    handler: effect,
  });

  const pluginFactory = new DeterministicPluginSubprocessFactory({
    execute: async (request): Promise<PluginWorkerResponse> => ({
      type: "kasitek.plugin.result",
      protocolVersion: 1,
      operationId: request.operationId,
      ok: true,
      output: { ok: true },
    }),
  });
  const plugin = createPluginToolDefinition({
    name: "plugin.booking.lookup",
    description: "Look up bookings through an isolated plugin",
    version: "1.0.0",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
    package: { organizationId: scope.organizationId, packageVersionId: "booking-plugin-v1", manifest: pluginManifest() },
    runtime: pluginRuntime(),
    adapter: new IsolatedPluginAdapter({ factory: pluginFactory }),
    requiresApproval: false,
    riskClass: "read",
  });
  registry.register({
    ...plugin,
    catalog: { kind: "plugin_tool", source: { kind: "plugin", id: "booking-plugin", version: "1.0.0" }, provider: { id: "booking-plugin", name: "Booking plugin" } },
  });
  return { registry, effect, plugin };
}

describe("capability staging smoke", () => {
  it("projects base, connector, MCP, plugin, skill, and unavailable state from one snapshot", () => {
    const { registry } = registryWithStagingCapabilities();
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: registry.list(),
      descriptors: registry.descriptors(),
      grantedTools: new Set(["workspace.read", "calendar.list", "mcp.calendar.search", "calendar.create", "plugin.booking.lookup"]),
      connections: [
        { id: "calendar", providerId: "calendar", displayName: "Calendar", status: "connected", capabilityIds: ["calendar.list", "calendar.create"] },
        { id: "slack", providerId: "slack", displayName: "Slack", status: "not_configured", capabilityIds: ["slack.send"] },
      ],
      skills: [
        {
          id: "booking-workflow",
          version: "1.0.0",
          name: "Booking workflow",
          description: "Booking instructions",
          published: true,
          pinned: true,
          requiredCapabilityIds: ["calendar.list"],
          requiredConnectorIds: ["calendar"],
          instructions: "Use the calendar capability to prepare booking options.",
          matching: { keywords: ["booking"] },
        },
        {
          id: "missing-workflow",
          version: "1.0.0",
          name: "Missing workflow",
          published: true,
          pinned: true,
          requiredCapabilityIds: ["missing.capability"],
          instructions: "This must not load.",
          matching: { keywords: ["booking"] },
        },
      ],
      message: "Help with a booking",
    });

    expect(snapshot.execution.callableToolNames).toEqual([
      "calendar.create",
      "calendar.list",
      "mcp.calendar.search",
      "plugin.booking.lookup",
      "workspace.read",
    ]);
    expect(snapshot.model.callableTools.find((tool) => tool.name === "mcp.calendar.search")).toMatchObject({
      catalog: { kind: "mcp_tool" },
    });
    expect(snapshot.model.summary).toContain("Calendar -> calendar.create, calendar.list");
    expect(snapshot.model.loadedSkills.map((skill) => skill.id)).toEqual(["booking-workflow"]);
    expect(snapshot.studio.unavailable).toEqual(expect.arrayContaining([
      { id: "missing-workflow", kind: "skill", reason: "dependency_not_found" },
      { id: "slack", kind: "connection", reason: "not_configured" },
    ]));
    expect(snapshot.studio.tools.find((tool) => tool.name === "calendar.create")).toMatchObject({ readiness: "callable", requiresApproval: true, source: { kind: "connector" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("keeps approval and plugin execution on the same granted capability runtime", async () => {
    const { registry, effect } = registryWithStagingCapabilities();
    const runtime = createCapabilityRuntime({ registry });
    const context = {
      scope,
      organizationId: scope.organizationId,
      agentId: scope.agentDefinitionId,
      agentVersionId: scope.agentVersionId,
      installationId: scope.installationId,
      runId: scope.runId,
      correlationId: scope.correlationId,
    };
    const createRequest = { name: "calendar.create", arguments: { title: "Demo" }, grantedTools: new Set(["calendar.create"]), context };

    await expect(runtime.invoke(createRequest)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(effect).not.toHaveBeenCalled();
    await expect(runtime.invoke({
      ...createRequest,
      approval: { approvedBy: "operator", argumentsHash: hashToolArguments(createRequest.arguments), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })).resolves.toMatchObject({ name: "calendar.create", output: { ok: true } });
    expect(effect).toHaveBeenCalledTimes(1);

    await expect(runtime.invoke({
      name: "plugin.booking.lookup",
      arguments: {},
      grantedTools: new Set(["plugin.booking.lookup"]),
      operationId: "plugin-operation-1",
      context: { ...context, scope: { ...scope, capabilityGrants: ["booking.read"] } },
    })).resolves.toMatchObject({ name: "plugin.booking.lookup", output: { ok: true } });
  });

  it("routes connector, MCP, plugin, skill-backed, and native calls through one lifecycle", async () => {
    const registry = new ToolRegistry();
    const families = [
      { name: "platform.current_time", kind: "builtin_tool" as const, source: { kind: "builtin" as const, id: "platform" } },
      { name: "google.calendar.list", kind: "connector_tool" as const, source: { kind: "connector" as const, id: "google.calendar" } },
      { name: "google.gmail.search", kind: "connector_tool" as const, source: { kind: "connector" as const, id: "google.gmail" } },
      { name: "google.drive.search", kind: "connector_tool" as const, source: { kind: "connector" as const, id: "google.drive" } },
      { name: "remote_mcp.notes.search", kind: "mcp_tool" as const, source: { kind: "mcp" as const, id: "notes" } },
      { name: "plugin.web.search", kind: "plugin_tool" as const, source: { kind: "plugin" as const, id: "web" } },
      { name: "skill.booking.lookup", kind: "builtin_tool" as const, source: { kind: "skill" as const, id: "booking" } },
    ];
    const handlerCalls: string[] = [];
    for (const family of families) {
      registry.register({
        ...baseTool({
          name: family.name,
          description: `${family.name} dispatch fixture`,
          catalog: { kind: family.kind, source: { ...family.source, version: "1.0.0" } },
        }),
        handler: async () => {
          handlerCalls.push(family.name);
          return { ok: true };
        },
      });
    }
    const lifecycle = {
      propose: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({ status: "new" as const })),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const runtime = createCapabilityRuntime({ registry, requireLifecycle: true });
    const context = {
      scope,
      organizationId: scope.organizationId,
      agentId: scope.agentDefinitionId,
      agentVersionId: scope.agentVersionId,
      installationId: scope.installationId,
      runId: scope.runId,
      correlationId: scope.correlationId,
    };

    for (const family of families) {
      await expect(runtime.invoke({
        name: family.name,
        arguments: {},
        grantedTools: new Set([family.name]),
        context,
        lifecycle,
        operationId: `operation:${family.name}`,
      })).resolves.toMatchObject({ name: family.name, output: { ok: true } });
    }

    expect(handlerCalls).toEqual(families.map((family) => family.name));
    expect(lifecycle.propose).toHaveBeenCalledTimes(families.length);
    expect(lifecycle.prepare).toHaveBeenCalledTimes(families.length);
    expect(lifecycle.complete).toHaveBeenCalledTimes(families.length);
    expect(lifecycle.fail).not.toHaveBeenCalled();
    expect(registry.descriptors().map((descriptor) => descriptor.source.kind).sort()).toEqual([
      "builtin", "connector", "connector", "connector", "mcp", "plugin", "skill",
    ]);
  });
});
