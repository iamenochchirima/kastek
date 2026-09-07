import { describe, expect, it } from "vitest";
import { ExtensionResolver, type ExtensionResolverInput } from "../src/extensions";

const checksum = "a".repeat(64);

function input(overrides: Partial<ExtensionResolverInput> = {}): ExtensionResolverInput {
  return {
    agentVersionId: "agent-version-1",
    connectors: [{ kind: "connector", id: "calendar", version: "1.0.0", checksum, available: true, installed: true, configured: true }],
    mcpCapabilities: [{ kind: "mcp_capability", id: "calendar.lookup", version: "1.0.0", checksum, providerId: "calendar-mcp", toolName: "lookup", available: true, installed: true, configured: true, requiredConnectorIds: ["calendar"] }],
    skills: [{ kind: "skill", id: "booking", version: "1.0.0", checksum, available: true, installed: true, configured: true, requiredConnectorIds: ["calendar"], requiredCapabilityIds: ["calendar.lookup"] }],
    plugins: [{ kind: "plugin", id: "booking-plugin", version: "1.0.0", checksum, available: true, installed: true, configured: true, skillIds: ["booking"], connectorIds: ["calendar"], mcpCapabilityIds: ["calendar.lookup"] }],
    grants: { connectorIds: ["calendar"], capabilityIds: ["calendar.lookup"], skillIds: ["booking"], pluginIds: ["booking-plugin"] },
    ...overrides,
  };
}

describe("ExtensionResolver", () => {
  it("compiles declarative extensions into one ready immutable snapshot", () => {
    const snapshot = new ExtensionResolver().resolve(input());

    expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.id).toBe(`extension-snapshot-${snapshot.checksum.slice(0, 24)}`);
    expect(snapshot.connectors[0]?.readiness).toMatchObject({ state: "ready", available: true, installed: true, configured: true, granted: true, ready: true });
    expect(snapshot.mcpCapabilities[0]?.readiness.state).toBe("ready");
    expect(snapshot.skills[0]?.readiness.state).toBe("ready");
    expect(snapshot.plugins[0]?.readiness.state).toBe("ready");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.plugins)).toBe(true);
    expect(Object.isFrozen(snapshot.plugins[0]?.declaration)).toBe(true);
  });

  it.each([
    ["kasiai", "kasiai-version"],
    ["core", "core-version"],
    ["tenant", "tenant-version"],
    ["customer", "customer-version"],
  ])("uses the same extension contract for %s agents", (_audience, agentVersionId) => {
    const snapshot = new ExtensionResolver().resolve(input({ agentVersionId }));

    expect(snapshot.agentVersionId).toBe(agentVersionId);
    expect(snapshot.plugins[0]?.readiness.ready).toBe(true);
    expect(snapshot.skills[0]?.readiness.ready).toBe(true);
    expect(snapshot.mcpCapabilities[0]?.readiness.ready).toBe(true);
    expect(snapshot.connectors[0]?.readiness.ready).toBe(true);
    expect(snapshot.plugins[0]?.declaration.kind).toBe("plugin");
  });

  it("reports the first unsatisfied gate with typed blockers", () => {
    const snapshot = new ExtensionResolver().resolve(input({
      grants: { connectorIds: ["calendar"], capabilityIds: [], skillIds: ["booking"], pluginIds: ["booking-plugin"] },
    }));

    expect(snapshot.mcpCapabilities[0]?.readiness).toMatchObject({ state: "granted", ready: false });
    expect(snapshot.mcpCapabilities[0]?.readiness.blockers).toEqual([{ code: "not_granted" }]);
    expect(snapshot.skills[0]?.readiness.blockers).toContainEqual({ code: "dependency_not_ready", dependency: { kind: "mcp_capability", id: "calendar.lookup" } });
    expect(snapshot.plugins[0]?.readiness.ready).toBe(false);
  });

  it("keeps the compiled checksum deterministic regardless of declaration or grant order", () => {
    const resolver = new ExtensionResolver();
    const first = resolver.resolve(input());
    const second = resolver.resolve(input({
      grants: { connectorIds: ["calendar", "calendar"], capabilityIds: ["calendar.lookup"], skillIds: ["booking"], pluginIds: ["booking-plugin"] },
      plugins: [{ ...input().plugins?.[0]!, connectorIds: ["calendar", "calendar"], mcpCapabilityIds: ["calendar.lookup"], skillIds: ["booking"] }],
    }));

    expect(second.checksum).toBe(first.checksum);
  });

  it("makes missing dependencies explicit instead of treating them as configured", () => {
    const snapshot = new ExtensionResolver().resolve(input({
      skills: [{ kind: "skill", id: "booking", version: "1.0.0", checksum, available: true, installed: true, configured: true, requiredConnectorIds: ["missing-connector"] }],
      plugins: [],
    }));

    expect(snapshot.skills[0]?.readiness).toMatchObject({ state: "granted", ready: false });
    expect(snapshot.skills[0]?.readiness.blockers).toEqual([{ code: "dependency_not_found", dependency: { kind: "connector", id: "missing-connector" } }]);
  });

  it("rejects duplicate declarations before compiling a snapshot", () => {
    expect(() => new ExtensionResolver().resolve(input({
      connectors: [
        { kind: "connector", id: "calendar", version: "1.0.0", checksum, available: true, installed: true, configured: true },
        { kind: "connector", id: "calendar", version: "2.0.0", checksum, available: true, installed: true, configured: true },
      ],
    }))).toThrow("EXTENSION_DUPLICATE_ID:connector:calendar");
  });
});
