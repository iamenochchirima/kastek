import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { registerIntegrationSources, registerMcpSources, registerPluginSources, registerSkillSources, registerUserToolSource } from "../src/capabilities/source-adapters";

describe("capability source adapters", () => {
  it("projects connectors while keeping activation separate from discovery", () => {
    const catalog = new CapabilityCatalog();
    catalog.register({
      id: "kasitek.calendar.list",
      version: "1.0.0",
      kind: "connector_tool",
      name: "Calendar list",
      description: "List calendar events.",
      category: "productivity",
      tags: [],
      source: { kind: "connector", id: "calendar", version: "1.0.0", trust: "platform" },
      toolsetIds: [],
      runtime: { execution: "native", requiredScopes: ["calendar.read"], credentialRequirements: [] },
    });

    registerIntegrationSources(catalog, [{
      id: "google.calendar",
      name: "Google Calendar",
      description: "Calendar events.",
      category: "productivity",
      logo: "google-calendar",
      capabilityNames: ["kasitek.calendar.list"],
      requiredScopes: ["calendar.events"],
      auth: "oauth2",
    }], new Set(["kasitek.calendar.list"]));

    expect(catalog.get("connector.google.calendar")).toMatchObject({ kind: "connector", logo: "google-calendar" });
    expect(catalog.resolveToolsets(["connector.google.calendar"])).toEqual(["kasitek.calendar.list"]);
  });

  it("projects skills, plugins, MCP revisions, and user tools through one catalog", () => {
    const catalog = new CapabilityCatalog();
    registerSkillSources(catalog, [{ id: "skill-1", version: 2, name: "Planning", checksum: "a".repeat(64), requiredCapabilities: ["platform.current_time"] }]);
    registerPluginSources(catalog, [{ id: "plugin-1", version: "1.0.0", checksum: "b".repeat(64), name: "Calendar plugin", permissions: ["calendar.read"] }]);
    registerMcpSources(catalog, [{ id: "mcp-version-1", providerId: "mcp-provider-1", providerName: "Notes", version: 3, checksum: "c".repeat(64), protocolVersion: "2026-07-28", tools: [{ name: "search", description: "Search notes" }] }]);
    const userTool = registerUserToolSource(catalog, { id: "weather", version: "1.0.0", name: "Weather", description: "A user-created weather tool.", checksum: "d".repeat(64) });

    expect(catalog.list({ kinds: ["skill", "plugin", "mcp_server", "mcp_tool", "user_tool"] })).toHaveLength(5);
    expect(catalog.get(userTool.id, userTool.version)?.source.trust).toBe("user");
    expect(catalog.resolveToolsets(["mcp.mcp-version-1"])).toEqual(["remote_mcp.mcp-version-1.search"]);
  });
});
