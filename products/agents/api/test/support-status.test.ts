import { describe, expect, it } from "vitest";
import { supportStatus } from "../src/capabilities/support-status";
import { customerConfigurationForSetup } from "../src/product/offerings/customer-setup";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { publishedToolBindings, toolsFor } from "../src/capabilities/tool-definitions";
import { validateBuiltinResult } from "../src/capabilities/tool-contracts";

describe("support status", () => {
  const hours = { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "17:00" }] };
  it("reports unknown facts when no valid schedule exists", () => {
    expect(supportStatus(undefined)).toEqual({ hours: { state: "unknown" }, staffAvailability: "unknown", responseTime: "unknown" });
    expect(supportStatus({ ...hours, timeZone: "invalid" }).hours.state).toBe("unknown");
  });
  it("uses the configured timezone and exclusive closing time", () => {
    expect(supportStatus(hours, new Date("2026-10-26T06:59:00Z")).hours.state).toBe("closed");
    expect(supportStatus(hours, new Date("2026-10-26T07:00:00Z")).hours.state).toBe("open");
    expect(supportStatus(hours, new Date("2026-10-26T15:00:00Z")).hours.state).toBe("closed");
    expect(supportStatus(hours, new Date("2026-10-27T10:00:00Z")).hours.state).toBe("closed");
  });
  it("accounts for daylight saving transitions without claiming staff availability", () => {
    const london = { timeZone: "Europe/London", intervals: [{ day: 0, start: "09:00", end: "10:00" }] };
    expect(supportStatus(london, new Date("2026-03-29T08:30:00Z"))).toMatchObject({ hours: { state: "open" }, staffAvailability: "unknown", responseTime: "unknown" });
    expect(supportStatus(london, new Date("2026-10-25T08:30:00Z")).hours.state).toBe("closed");
  });
  it("pins configured hours and status tool in newly published configurations", () => {
    const configuration = customerConfigurationForSetup({ business: { name: "Example", website: "", description: "" }, responsibilities: ["customer-support"], channels: ["website"], behaviour: { agentName: "Assistant", language: "English", tone: "friendly", handoffInstructions: "" }, supportHours: hours });
    expect(configuration.supportHours).toEqual(hours);
    expect(toolsFor(configuration).map(tool => tool.function.name)).toContain("support_get_status_v2");
    expect(publishedToolBindings(configuration).map(binding => binding.name)).toContain("support.get_status_v2");
    expect(compilePublishedComposition(configuration, []).capabilities.map(item => item.id)).toContain("support.get_status_v2");
    expect(() => validateBuiltinResult("support.get_status", supportStatus(hours, new Date("2026-10-26T10:00:00Z")))).not.toThrow();
    const legacy = { ...configuration, tools: configuration.tools.filter(name => name !== "support.get_status_v2") };
    expect(() => compilePublishedComposition(legacy, [])).not.toThrow();
  });
});
