import { describe, expect, it } from "vitest";
import { HERMES_MCP_CATALOG, HERMES_SKILL_CATALOG } from "../src/integrations/hermes-directory";
import { listConnectionDirectory, listPluginDirectory, listSkillDirectory } from "../src/integrations/directory";
import { getHermesPluginAdapterCapabilityIds, HERMES_PLUGIN_CATALOG, HERMES_PLUGIN_CATALOG_REVISION } from "../src/extensions/hermes-plugin-directory";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

describe("reviewed Hermes catalogues", () => {
  it("imports the pinned MCP, skill, and plugin directories without duplicate ids", () => {
    expect(HERMES_MCP_CATALOG).toHaveLength(65);
    expect(HERMES_SKILL_CATALOG).toHaveLength(137);
    expect(HERMES_PLUGIN_CATALOG).toHaveLength(104);
    expect(unique(HERMES_MCP_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(unique(HERMES_SKILL_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(unique(HERMES_PLUGIN_CATALOG.map((entry) => entry.id))).toBe(true);
    expect(HERMES_PLUGIN_CATALOG_REVISION).toBe("9a84bee265daad14340a80d7585928cd8ea1f9eb");
    expect(getHermesPluginAdapterCapabilityIds(HERMES_PLUGIN_CATALOG.find((entry) => entry.slug === "web/tavily")!)).toEqual(["kasitek.web.search"]);
  });

  it("projects catalogue entries as selectable directory records", () => {
    const connections = listConnectionDirectory();
    expect(connections.some((entry) => entry.id === "hermes.mcp.notion")).toBe(true);
    expect(listSkillDirectory()).toHaveLength(137);
    expect(listPluginDirectory()).toHaveLength(104);
  });
});
