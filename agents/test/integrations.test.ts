import { describe, expect, it } from "vitest";
import { getIntegration, listIntegrations } from "../src/integrations/catalog";
import { registerIntegrationTools } from "../src/integrations/tools";
import { ToolRegistry } from "../src/tools/registry";

describe("integration catalog", () => {
  it("keeps provider configuration separate from capability names", () => {
    const catalog = listIntegrations();
    expect(catalog.map((entry) => entry.id)).toEqual([
      "whatsapp.messaging",
      "facebook.messaging",
      "instagram.messaging",
      "telegram.messaging",
      "discord.messaging",
      "internal.calendar",
      "google.calendar",
      "apple.tools",
      "tavily.search",
      "opentelemetry",
    ]);
    expect(getIntegration("google.calendar")?.capabilityNames).toContain("kasitek.calendar.create");
    expect(getIntegration("internal.calendar")?.auth).toBe("internal");
    expect(getIntegration("tavily.search")?.auth).toBe("api_key");
    expect(getIntegration("telegram.messaging")?.runtime).toBe("webhook");
    expect(getIntegration("discord.messaging")?.kind).toBe("channel");
  });
});

describe("integration tool registry", () => {
  it("registers every adapter through the shared tool surface", () => {
    const registry = new ToolRegistry();
    const service = {
      listCalendar: async () => ({ events: [], sources: [] }),
      createCalendarEvent: async () => ({ status: "created" }),
      updateCalendarEvent: async () => ({ status: "updated" }),
      deleteCalendarEvent: async () => ({ deleted: true }),
      searchWeb: async () => ({ answer: "", results: [] }),
      appleTool: async () => ({ results: [] }),
    };
    registerIntegrationTools(registry, service as never);
    const names = registry.manifests().map((manifest) => manifest.name);
    expect(names).toEqual(expect.arrayContaining([
      "kasitek.calendar.list",
      "kasitek.calendar.create",
      "kasitek.calendar.update",
      "kasitek.calendar.delete",
      "kasitek.web.search",
      "kasitek.apple.calendar.list",
      "kasitek.apple.mail.list",
      "kasitek.apple.reminder.create",
      "kasitek.apple.note.create",
    ]));
    expect(registry.get("kasitek.calendar.list")?.requiresApproval).toBe(false);
    expect(registry.get("kasitek.calendar.create")?.requiresApproval).toBe(true);
    expect(registry.get("kasitek.apple.note.create")?.manifest?.requiredScope).toBe("apple.notes.write");
  });
});
