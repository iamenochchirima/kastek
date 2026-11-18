import { describe, expect, it } from "vitest";
import { capability, capabilityForTool, capabilityPrerequisitesMet, capabilityRegistry } from "../src/platform/capabilities/registry";

describe("agent capability registry", () => {
  it("lists available capabilities and keeps deferred ones unconfigurable", () => {
    const available = capabilityRegistry.filter(entry => entry.availability === "available").map(entry => entry.id);
    expect(available).toEqual(["tools", "knowledge", "memory", "handoff", "delegation", "workflows", "skills"]);
    expect(capabilityRegistry.filter(entry => entry.availability === "deferred").map(entry => entry.id)).toEqual(["schedules", "code", "browser"]);
  });
  it("exposes setup paths for capabilities that have configuration", () => {
    expect(capability("knowledge").setup).toContain("/knowledge");
    expect(capability("memory").setup).toContain("/memory");
    expect(capability("tools").setup).toBeUndefined();
  });
});

describe("capability dispatch", () => {
  it("maps operations to their owning capability", () => {
    expect(capabilityForTool("knowledge.search").id).toBe("knowledge");
    expect(capabilityForTool("memory.propose").id).toBe("memory");
    expect(capabilityForTool("agents.discover").id).toBe("delegation");
    expect(capabilityForTool("read_file").id).toBe("tools");
  });
});

describe("capability prerequisites", () => {
  it("requires tools before workflows and no prerequisites for skills or delegation", () => {
    expect(capabilityPrerequisitesMet("workflows", ["tools"])).toBe(true);
    expect(capabilityPrerequisitesMet("workflows", [])).toBe(false);
    expect(capabilityPrerequisitesMet("skills", [])).toBe(true);
    expect(capabilityPrerequisitesMet("delegation", [])).toBe(true);
  });
});
