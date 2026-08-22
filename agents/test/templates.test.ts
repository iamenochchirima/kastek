import { describe, expect, it } from "vitest";
import { listAgentTemplates, parseTemplateSettings, templateVersionInput } from "../src/system/templates";
import { CUSTOMER_SERVICE_HANDOFF_TOOL } from "../src/system/hosted-agent-defaults";

describe("agent templates", () => {
  it("publishes a bounded, versioned catalog", () => {
    const templates = listAgentTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const template of templates) {
      expect(template.key).toMatch(/^[a-z0-9-]+$/);
      expect(template.version).toBeGreaterThan(0);
      expect(template.profile).toBe("custom");
      expect(["personal", "customer_service"]).toContain(template.audience);
      expect(template.instructions.length).toBeGreaterThan(20);
      expect(template.requiredCapabilities.length).toBeGreaterThan(0);
      expect(template.setupSteps.length).toBeGreaterThan(0);
      expect(template.configuration.workflow).toMatchObject({
        version: 1,
        entryNodeId: "chat",
        nodes: [
          { id: "chat", type: "deterministic", config: { uiRole: "gateway", value: "chat" } },
          { id: "agent", type: "model", config: { uiRole: "agent" } },
        ],
        edges: [{ from: "chat", to: "agent" }],
      });
      expect(template.policy.allowedTools).toEqual(["platform.current_time"]);
      expect(template.channelCompatibility).toContain("platform");
    }
  });

  it("keeps personal and customer-service catalogs separate", () => {
    const personal = listAgentTemplates("personal");
    const customerService = listAgentTemplates("customer_service");
    expect(personal.length).toBeGreaterThanOrEqual(2);
    expect(customerService.length).toBeGreaterThanOrEqual(4);
    expect(personal.every((template) => template.audience === "personal")).toBe(true);
    expect(customerService.every((template) => template.audience === "customer_service")).toBe(true);
    expect(personal.some((template) => template.key === "private-research")).toBe(true);
    expect(customerService.every((template) => template.requiredCapabilities.includes(CUSTOMER_SERVICE_HANDOFF_TOOL))).toBe(true);
    expect(personal.every((template) => !template.requiredCapabilities.includes(CUSTOMER_SERVICE_HANDOFF_TOOL))).toBe(true);
  });

  it("normalizes the supported setting and rejects unknown settings", () => {
    expect(parseTemplateSettings({})).toEqual({ tone: "balanced" });
    expect(parseTemplateSettings({ tone: "concise" })).toEqual({ tone: "concise" });
    expect(() => parseTemplateSettings({ tone: "friendly" })).toThrow();
    expect(() => parseTemplateSettings({ tone: "balanced", systemPrompt: "override" })).toThrow();
  });

  it("keeps template policy and configuration server-owned", () => {
    const template = listAgentTemplates()[0]!;
    const version = templateVersionInput(template, { tone: "detailed" });
    expect(version.instructions).toContain("Preferred response tone: detailed.");
    expect(version.configuration).toEqual(template.configuration);
    expect(version.policy).toEqual(template.policy);
  });
});
