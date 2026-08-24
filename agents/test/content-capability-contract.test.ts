import { describe, expect, it } from "vitest";
import { createDefaultTools } from "../src/temporal/activities";
import { KASIAI_ALLOWED_TOOLS } from "../src/system/kasiai";

const context = {
  organizationId: "org-test",
  agentId: "agent-test",
  agentVersionId: "version-test",
  installationId: "installation-test",
  runId: "run-test",
  correlationId: "correlation-test",
};

describe("content capability contract", () => {
  const registry = createDefaultTools();

  it("exposes booking detail and channel delivery with explicit read/effect contracts", () => {
    expect(registry.get("kasitek.core.workspace_report")?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "workspace.reporting.read",
      execution: "immediate",
      approval: "none",
      idempotency: "not_applicable",
      auditClassification: "restricted",
    });
    expect(registry.validateArguments("kasitek.core.workspace_report", {})).toBe(true);
    expect(registry.validateArguments("kasitek.core.workspace_report", { limit: 10 })).toBe(false);

    expect(registry.validateArguments("kasitek.core.booking_services_list", { limit: 200 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.booking_services_list", { limit: 201 })).toBe(false);

    expect(registry.validateArguments("kasitek.core.templates_list", { limit: 200 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.templates_list", { limit: 201 })).toBe(false);

    const contactUpdate = registry.get("kasitek.core.contact_update");
    expect(contactUpdate?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "contacts.write",
      resourceSelector: { type: "contact", argument: "contactId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
    });
    expect(contactUpdate?.riskClass).toBe("controlled-write");
    expect(registry.validateArguments("kasitek.core.contact_update", { contactId: "contact-1", optIn: true })).toBe(true);
    expect(registry.validateArguments("kasitek.core.contact_update", { contactId: "contact-1" })).toBe(false);

    expect(registry.get("kasitek.core.inbox_conversation_update")?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      execution: "immediate",
      approval: "none",
      resourceSelector: { type: "conversation", argument: "conversationId" },
    });
    expect(registry.validateArguments("kasitek.core.inbox_conversation_update", { conversationId: "conversation-1", starred: true })).toBe(true);
    expect(registry.get("kasitek.core.inbox_conversation_mark_read")?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      execution: "durable",
      idempotency: "required",
      approval: "always",
    });
    expect(registry.get("kasitek.core.inbox_conversation_mark_read")?.riskClass).toBe("external-effect");

    const booking = registry.get("kasitek.core.booking_get");
    expect(booking?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "bookings.read",
      resourceSelector: { type: "booking", argument: "bookingId" },
      execution: "immediate",
      approval: "none",
    });
    expect(registry.validateArguments("kasitek.core.booking_get", { bookingId: "booking-1" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.booking_get", {})).toBe(false);

    const channel = registry.get("kasitek.core.channel_deliver");
    expect(channel?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "channels.write",
      resourceSelector: { type: "conversation", argument: "externalConversationId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
    });
    expect(channel?.riskClass).toBe("external-effect");
    expect(channel?.requiresApproval).toBe(true);
    expect(registry.validateArguments("kasitek.core.channel_deliver", { channelType: "whatsapp", externalConversationId: "conversation-1", text: "Hello" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.channel_deliver", { channelType: "telegram", externalConversationId: "conversation-1", text: "Hello" })).toBe(false);
    expect(registry.validateArguments("kasitek.core.channel_deliver", { channelType: "whatsapp", externalConversationId: "conversation-1", text: "" })).toBe(false);
    expect(registry.validateArguments("kasitek.core.inbox_conversations_list", { limit: 100 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.inbox_conversations_list", { limit: 201 })).toBe(false);
    expect(registry.validateArguments("kasitek.core.inbox_messages_list", { conversationId: "conversation-1", limit: 100 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.inbox_messages_list", { conversationId: "conversation-1", limit: 0 })).toBe(false);
    expect(registry.validateArguments("kasitek.core.bookings_list", { limit: 200 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.campaigns_list", { limit: 201 })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_delete_published", { postId: "post-1", platform: "THREADS" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_delete_published", { postId: "post-1" })).toBe(false);

    expect(registry.get("kasitek.core.connections_list")?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "connections.read",
      execution: "immediate",
      approval: "none",
    });
    expect(registry.validateArguments("kasitek.core.connections_list", { provider: "FACEBOOK", limit: 200 })).toBe(true);
    expect(registry.validateArguments("kasitek.core.connections_list", { limit: 201 })).toBe(false);

    const connectionStatus = registry.get("kasitek.core.connection_status_update");
    expect(connectionStatus?.manifest).toMatchObject({
      ownerService: "kasitek-core",
      requiredScope: "connections.write",
      resourceSelector: { type: "connection", argument: "displayName" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
    });
    expect(connectionStatus?.requiresApproval).toBe(true);
    expect(registry.validateArguments("kasitek.core.connection_status_update", { provider: "FACEBOOK", displayName: "KasiTek", status: "DISCONNECTED" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.connection_status_update", { provider: "FACEBOOK", displayName: "KasiTek", status: "CONNECTED" })).toBe(false);
  });

  it("keeps every content capability owned, scoped, redacted, and classified", () => {
    const manifests = registry.manifests().filter((manifest) => manifest.name.startsWith("kasitek.core.content_"));
    expect(manifests.map((manifest) => manifest.name)).toEqual([
      "kasitek.core.content_posts_list",
      "kasitek.core.content_post_get",
      "kasitek.core.content_posts_insights_report",
      "kasitek.core.content_post_insights",
      "kasitek.core.content_post_update",
      "kasitek.core.content_post_draft",
      "kasitek.core.content_post_publish",
      "kasitek.core.content_post_schedule",
      "kasitek.core.content_post_unschedule",
      "kasitek.core.content_post_delete",
      "kasitek.core.content_post_delete_published",
    ]);

    for (const manifest of manifests) {
      expect(manifest.manifest.ownerService).toBe("kasitek-core");
      expect(manifest.manifest.requiredScope).toMatch(/^content\.(read|write|publish)$/);
      expect(manifest.manifest.auditClassification).toMatch(/^(restricted|full)$/);
      expect(manifest.manifest.redaction.every((entry) => entry.length > 0)).toBe(true);
      if (manifest.name !== "kasitek.core.content_post_delete") expect(manifest.manifest.redaction.length).toBeGreaterThan(0);
      if (manifest.name.endsWith("_publish") || manifest.name.endsWith("_schedule") || manifest.name.endsWith("_unschedule") || manifest.name.includes("_delete")) {
        expect(manifest.manifest).toMatchObject({ execution: "durable", idempotency: "required", approval: "always" });
        expect(manifest.requiresApproval).toBe(true);
      } else {
        expect(manifest.manifest.execution).toBe("immediate");
        expect(manifest.manifest.approval).toBe("none");
        expect(manifest.requiresApproval).toBe(false);
      }
    }
  });

  it("uses the shared registry for the protected KasiAi content grants", () => {
    const registered = new Set(registry.manifests().map((manifest) => manifest.name));
    const kasiaiContentTools = KASIAI_ALLOWED_TOOLS.filter((name) => name.startsWith("kasitek.core.content_"));

    expect(kasiaiContentTools).toEqual([
      "kasitek.core.content_posts_list",
      "kasitek.core.content_post_get",
      "kasitek.core.content_posts_insights_report",
      "kasitek.core.content_post_insights",
      "kasitek.core.content_post_draft",
      "kasitek.core.content_post_update",
      "kasitek.core.content_post_publish",
      "kasitek.core.content_post_schedule",
      "kasitek.core.content_post_delete",
      "kasitek.core.content_post_delete_published",
    ]);
    for (const name of kasiaiContentTools) expect(registered.has(name)).toBe(true);
  });

  it("validates the public content argument contract before handlers run", () => {
    expect(registry.validateArguments("kasitek.core.content_posts_list", {})).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_posts_list", { unexpected: true })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_get", { postId: "post-1" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_get", {})).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "Draft", channels: ["threads"] })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "Draft", channels: ["threads"], media: [{ assetId: "asset-1", altText: "Launch artwork" }] })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "Draft", channels: ["threads"], media: [{ altText: "Missing asset" }] })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_draft", { content: "", channels: [] })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_publish", { postId: "post-1", platform: "threads" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_publish", { postId: "post-1" })).toBe(false);
    expect(registry.validateArguments("kasitek.core.content_post_schedule", { postId: "post-1", scheduledFor: "2026-08-15T12:00:00.000Z" })).toBe(true);
    expect(registry.validateArguments("kasitek.core.content_post_schedule", { postId: "post-1", scheduledFor: "tomorrow" })).toBe(false);
  });

  it("enforces grants and approval before any content handler is invoked", async () => {
    await expect(registry.invoke({
      name: "kasitek.core.content_post_publish",
      arguments: { postId: "post-1", platform: "threads" },
      context,
      grantedTools: new Set(),
    })).rejects.toMatchObject({ code: "TOOL_NOT_GRANTED" });

    await expect(registry.invoke({
      name: "kasitek.core.content_post_publish",
      arguments: { postId: "post-1", platform: "threads" },
      context,
      grantedTools: new Set(["kasitek.core.content_post_publish"]),
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });
});
