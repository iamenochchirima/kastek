import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateCapabilityDocumentation, generateCapabilitySurfaces } from "../src/capabilities/surfaces";
import { createDefaultTools } from "../src/temporal/activities";

describe("generated capability surfaces", () => {
  it("projects every registered manifest into MCP, permission, audit, and documentation surfaces", async () => {
    const manifests = createDefaultTools().manifests();
    const surfaces = generateCapabilitySurfaces(manifests);
    expect(surfaces).toHaveLength(manifests.length);
    expect(surfaces.map((surface) => surface.name)).toEqual(manifests.map((manifest) => manifest.name));
    for (const surface of surfaces) {
      expect(surface.mcp).toMatchObject({ name: surface.name, description: surface.description, inputSchema: surface.inputSchema });
      expect(surface.permission.scope).toBe(surface.manifest.requiredScope);
      expect(surface.audit.description).toContain(surface.name === "platform.current_time" ? "trusted platform runtime" : surface.description);
      expect(surface.documentation.summary).toBe(surface.description);
    }
    expect(surfaces.find((surface) => surface.name === "kasitek.core.connections_list")?.presentation).toMatchObject({
      projection: "workspace_connections",
      mode: "inline",
    });
    const generated = await readFile(new URL("../../docs/generated-capabilities.md", import.meta.url), "utf8");
    expect(generated).toBe(generateCapabilityDocumentation(manifests));
  });
});
