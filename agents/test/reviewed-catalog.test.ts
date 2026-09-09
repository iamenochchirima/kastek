import { describe, expect, it } from "vitest";
import { REVIEWED_MCP_CATALOG, REVIEWED_SKILL_CATALOG } from "../src/integrations/reviewed-catalog";
import { listConnectionDirectory, listPluginDirectory, listSkillDirectory } from "../src/integrations/directory";
import { getReviewedPluginAdapterCapabilityIds, REVIEWED_PLUGIN_CATALOG, REVIEWED_PLUGIN_CATALOG_REVISION } from "../src/extensions/reviewed-plugin-catalog";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe("reviewed catalogues", () => {
  it("imports the pinned MCP, skill, and plugin directories without duplicate ids", () => {
    expect(REVIEWED_MCP_CATALOG).toHaveLength(65);
    expect(REVIEWED_SKILL_CATALOG).toHaveLength(137);
    expect(REVIEWED_PLUGIN_CATALOG).toHaveLength(104);
    expect(unique(REVIEWED_MCP_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(unique(REVIEWED_SKILL_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(unique(REVIEWED_PLUGIN_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(REVIEWED_PLUGIN_CATALOG_REVISION).toBe("9a84bee265daad14340a80d7585928cd8ea1f9eb");
    expect(getReviewedPluginAdapterCapabilityIds(REVIEWED_PLUGIN_CATALOG.find((entry) => entry.slug === "web/tavily")!)).toEqual(["kasitek.web.search"]);
  });

  it("projects catalogue entries as selectable directory records", () => {
    const connections = listConnectionDirectory();
    expect(connections.slice(0, 3).map((entry) => entry.id)).toEqual(["google.calendar", "google.gmail", "google.drive"]);
    expect(connections.some((entry) => entry.id === "hermes.mcp.notion")).toBe(true);
    expect(listSkillDirectory()).toHaveLength(137);
    const plugins = listPluginDirectory();
    expect(plugins).toHaveLength(104);
    expect(plugins.find((entry) => entry.slug === "web/tavily")).toMatchObject({ adapterStatus: "supported", adapterCapabilityIds: ["kasitek.web.search"] });
    expect(plugins.find((entry) => entry.slug === "web/exa")).toMatchObject({ adapterStatus: "metadata_only", adapterCapabilityIds: [] });
  });
});
