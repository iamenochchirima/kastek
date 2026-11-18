import { describe, expect, it } from "vitest";
import { capability, capabilityRegistry } from "../src/platform/capabilities/registry";

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
