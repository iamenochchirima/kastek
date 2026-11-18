import { describe, expect, it } from "vitest";
import { handlerFor } from "../src/execution/capabilities/operation-handlers";
import { capability, capabilityForTool, capabilityOperations, capabilityPrerequisitesMet, capabilityRegistry, configurationCapabilityError } from "../src/platform/capabilities/registry";
import { bookingOperationHandler } from "../src/workflows/booking/handler";
import { reportDeliveryHandler } from "../src/workflows/report-delivery/handler";

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

describe("capability operations", () => {
  it("declares the operations each capability contributes", () => {
    expect(capabilityOperations.knowledge).toEqual(["knowledge.search", "knowledge.read"]);
    expect(capabilityOperations.memory).toEqual(["memory.search", "memory.read", "memory.propose"]);
    expect(capabilityOperations.workflows).toEqual(["workflow.run"]);
    expect(capabilityOperations.schedules).toEqual([]);
  });
  it("rejects a capability whose prerequisite is disabled", () => {
    const configuration = { tools: [], sourceRevisionIds: [], connectedToolBindingIds: [], skillIds: [],
      memory: { enabled: false }, capabilities: { delegation: { enabled: false }, workflows: { enabled: true } } };
    expect(configurationCapabilityError(configuration)).toBe("CAPABILITY_PREREQUISITE_MISSING:workflows");
  });
});

describe("capability operation handlers", () => {
  it("resolves booking and report operations without a central name branch", () => {
    const handlers = [bookingOperationHandler(), reportDeliveryHandler()];
    expect(handlerFor(handlers, "booking.availability")?.capability).toBe("tools");
    expect(handlerFor(handlers, "booking.reserve")?.capability).toBe("tools");
    expect(handlerFor(handlers, "report.deliver")?.afterTurn).toBeTypeOf("function");
    expect(handlerFor(handlers, "knowledge.search")).toBeUndefined();
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
