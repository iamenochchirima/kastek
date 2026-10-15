import { describe, expect, it } from "vitest";
import { CapabilityCatalog, type CapabilityDescriptor, type CapabilityToolsetDescriptor } from "../src/capabilities/catalog";

const source = {
  kind: "builtin" as const,
  id: "agents",
  version: "1.0.0",
  trust: "platform" as const,
};

function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: "platform.current_time",
    version: "1.0.0",
    kind: "builtin_tool",
    name: "Current time",
    description: "Read the current UTC time.",
    category: "platform",
    tags: ["time"],
    source,
    toolsetIds: ["platform"],
    runtime: {
      execution: "native",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 1_000,
      requiredScopes: ["platform.time.read"],
      credentialRequirements: [],
    },
    ...overrides,
  };
}

function toolset(overrides: Partial<CapabilityToolsetDescriptor> = {}): CapabilityToolsetDescriptor {
  return {
    id: "platform",
    version: "1.0.0",
    name: "Platform",
    description: "Built-in platform tools.",
    source,
    capabilityIds: ["platform.current_time"],
    includes: [],
    ...overrides,
  };
}

describe("CapabilityCatalog", () => {
  it("normalizes and filters a mixed capability directory", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(descriptor({ tags: ["time", " platform ", "time"] }));
    catalog.register(descriptor({
      id: "google.calendar.list",
      kind: "connector_tool",
      name: "List Google Calendar events",
      category: "productivity",
      source: { kind: "connector", id: "google.calendar", version: "1.0.0", trust: "verified" },
      provider: { id: "google.calendar", name: "Google Calendar" },
    }));

    expect(catalog.list({ sourceKinds: ["connector"] })).toHaveLength(1);
    expect(catalog.list({ query: "GOOGLE calendar" })[0]).toMatchObject({ id: "google.calendar.list" });
    expect(catalog.get("platform.current_time")?.tags).toEqual(["platform", "time"]);
  });

  it("registers built-in tool metadata without moving its handler", () => {
    const catalog = new CapabilityCatalog();
    const registered = catalog.registerTool({
      name: "kasitek.core.customer_get",
      version: "1.0.0",
      description: "Read one customer.",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 12_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    }, {
      category: "customers",
      toolsetIds: ["workspace", "workspace", " platform "],
    });

    expect(registered).toMatchObject({
      id: "kasitek.core.customer_get",
      kind: "builtin_tool",
      category: "customers",
      runtime: { execution: "native", riskClass: "read" },
      source: { kind: "builtin", id: "agents", trust: "platform" },
    });
    expect(catalog.get("kasitek.core.customer_get")?.toolsetIds).toEqual(["platform", "workspace"]);
  });

  it("resolves nested toolsets deterministically and rejects cycles", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(descriptor());
    catalog.register(descriptor({ id: "kasitek.core.customer_get", name: "Customer", toolsetIds: ["workspace"] }));
    catalog.registerToolset(toolset({ id: "workspace", name: "Workspace", capabilityIds: ["kasitek.core.customer_get"], includes: ["platform"] }));
    catalog.registerToolset(toolset({ id: "platform", capabilityIds: ["platform.current_time"] }));

    expect(catalog.resolveToolsets(["workspace"])).toEqual(["kasitek.core.customer_get", "platform.current_time"]);

    const cyclic = new CapabilityCatalog();
    cyclic.registerToolset(toolset({ id: "a", includes: ["b"], capabilityIds: [] }));
    cyclic.registerToolset(toolset({ id: "b", includes: ["a"], capabilityIds: [] }));
    expect(() => cyclic.resolveToolsets(["a"])).toThrow("CAPABILITY_TOOLSET_CYCLE:a");
  });

  it("creates a stable immutable snapshot from capabilities and toolsets", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(descriptor());
    catalog.registerToolset(toolset());

    const first = catalog.snapshot({ agentVersionId: "agent-version-1", toolsetIds: ["platform"] });
    const second = catalog.snapshot({ agentVersionId: "agent-version-1", toolsetIds: ["platform"] });

    expect(first).toEqual(second);
    expect(first.descriptorIds).toEqual(["platform.current_time"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => catalog.snapshot({ agentVersionId: "agent-version-1", capabilityIds: ["missing"] })).toThrow("CAPABILITY_NOT_FOUND:missing");
  });
});
