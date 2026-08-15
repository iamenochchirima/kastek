import { describe, expect, it, vi } from "vitest";
import { createDefaultTools } from "../src/temporal/activities";
import { hashToolArguments } from "../src/tools/registry";
import type { KasitekCoreReadClient } from "../src/core/client";
import type { ToolInvocationContext } from "../src/tools/types";

const context: ToolInvocationContext = {
  organizationId: "org-contract",
  agentId: "agent-contract",
  agentVersionId: "version-contract",
  installationId: "installation-contract",
  runId: "run-contract",
  actorId: "actor-contract",
  correlationId: "correlation-contract",
};

const post = { id: "post-1", content: "Contract test", channels: ["threads"], status: "DRAFT" };

/**
 * This matrix deliberately exercises the real capability handlers, not only
 * their JSON schemas. It catches drift between a capability name and the
 * core-client method/path that owns its business operation. Provider delivery
 * is excluded because its live effect remains an external verification gate.
 */
const cases = [
  { name: "kasitek.core.customer_get", method: "getCustomer", args: { customerId: "customer-1" }, output: { customer: { id: "customer-1" } } },
  { name: "kasitek.core.workspace_status", method: "getWorkspaceStatus", args: {}, output: { organizationId: context.organizationId, connections: [] } },
  {
    name: "kasitek.core.workspace_report",
    method: "getWorkspaceReport",
    args: {},
    output: {
      organizationId: context.organizationId,
      connections: {},
      content: {},
      contacts: {},
      inbox: {},
      bookings: {},
      campaigns: {},
      templates: {},
    },
  },
  { name: "kasitek.core.booking_services_list", method: "listBookingServices", args: { limit: 25 }, output: { services: [], total: 0, hasMore: false } },
  { name: "kasitek.core.bookings_list", method: "listBookings", args: { limit: 25 }, output: { bookings: [] } },
  { name: "kasitek.core.booking_get", method: "getBooking", args: { bookingId: "booking-1" }, output: { booking: { id: "booking-1" } } },
  { name: "kasitek.core.campaigns_list", method: "listCampaigns", args: { limit: 25 }, output: { campaigns: [] } },
  { name: "kasitek.core.campaign_summary", method: "getCampaignSummary", args: { campaignId: "campaign-1" }, output: { campaign: { id: "campaign-1" } } },
  { name: "kasitek.core.templates_list", method: "listTemplates", args: { status: "APPROVED", limit: 25 }, output: { templates: [] } },
  { name: "kasitek.core.contacts_list", method: "listContacts", args: { q: "Ada", optIn: "true", excluded: "false", tag: "vip", location: "Cape Town", listLabel: "leads", limit: 25 }, output: { contacts: [], totalContacts: 0 } },
  { name: "kasitek.core.contact_update", method: "updateContact", args: { contactId: "contact-1", optIn: true }, output: { contact: { id: "contact-1", optIn: true } }, requiresApproval: true },
  { name: "kasitek.core.inbox_conversations_list", method: "listInboxConversations", args: { limit: 25 }, output: { conversations: [], total: 0, hasMore: false } },
  { name: "kasitek.core.inbox_messages_list", method: "listInboxMessages", args: { conversationId: "conversation-1", limit: 25 }, output: { messages: [], total: 0, hasMore: false } },
  { name: "kasitek.core.inbox_conversation_update", method: "updateInboxConversation", args: { conversationId: "conversation-1", starred: true }, output: { success: true, conversationId: "conversation-1", starred: true } },
  { name: "kasitek.core.inbox_conversation_mark_read", method: "markInboxConversationRead", args: { conversationId: "conversation-1" }, output: { success: true }, requiresApproval: true },
  { name: "kasitek.core.content_posts_list", method: "listContentPosts", args: {}, output: { posts: [] } },
  { name: "kasitek.core.content_post_get", method: "getContentPost", args: { postId: "post-1" }, output: { post } },
  { name: "kasitek.core.content_post_update", method: "updateContentDraft", args: { postId: "post-1", content: "Updated" }, output: { post: { ...post, content: "Updated" } } },
  { name: "kasitek.core.content_post_draft", method: "createContentDraft", args: { content: "Draft", channels: ["threads"] }, output: { post: { ...post, id: "post-2" } } },
  { name: "kasitek.core.content_post_publish", method: "publishContentPost", args: { postId: "post-1", platform: "threads" }, output: { post: { ...post, status: "PUBLISHED" }, result: { status: "accepted" } }, requiresApproval: true },
  { name: "kasitek.core.content_post_schedule", method: "scheduleContentPost", args: { postId: "post-1", scheduledFor: "2030-01-01T12:00:00.000Z" }, output: { post: { ...post, status: "SCHEDULED" }, status: "SCHEDULED" }, requiresApproval: true },
  { name: "kasitek.core.content_post_unschedule", method: "unscheduleContentPost", args: { postId: "post-1" }, output: { post, status: "DRAFT" }, requiresApproval: true },
  { name: "kasitek.core.content_post_delete", method: "deleteContentPost", args: { postId: "post-1" }, output: { postId: "post-1", deleted: true }, requiresApproval: true },
] as const;

describe("core-owned capability adapter contract", () => {
  it("routes every bounded domain capability through its typed core client method", async () => {
    const coreMethods: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const testCase of cases) {
      coreMethods[testCase.method] = vi.fn().mockResolvedValue(testCase.output);
    }
    const tools = createDefaultTools(coreMethods as unknown as KasitekCoreReadClient);
    const grantedTools = new Set(cases.map((testCase) => testCase.name));

    for (const testCase of cases) {
      const approval = testCase.requiresApproval
        ? {
          approvedBy: "approver-1",
          argumentsHash: hashToolArguments(testCase.args),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : undefined;
      const result = await tools.invoke({
        name: testCase.name,
        arguments: testCase.args,
        context,
        grantedTools,
        approval,
      });

      expect(result.output, testCase.name).toEqual(testCase.output);
      expect(coreMethods[testCase.method], testCase.method).toHaveBeenCalledTimes(1);
      expect(coreMethods[testCase.method]!.mock.calls[0]?.[0]).toMatchObject(context);
    }

    expect(Object.keys(coreMethods)).toHaveLength(cases.length);
  });

  it("does not silently omit a bounded core capability from the matrix", () => {
    const tools = createDefaultTools({} as KasitekCoreReadClient);
    const coreNames = tools
      .manifests()
      .filter((manifest) => manifest.manifest.ownerService === "kasitek-core")
      .map((manifest) => manifest.name)
      .filter((name) => name !== "kasitek.core.channel_deliver")
      .sort();
    expect(coreNames).toEqual(cases.map((testCase) => testCase.name).sort());
  });
});
