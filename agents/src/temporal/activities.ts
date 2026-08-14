import type { Pool } from "pg";
import { RunRepository } from "../db/repositories/run-repository";
import { ModelCallRepository } from "../db/repositories/model-call-repository";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { MemoryRepository } from "../db/repositories/memory-repository";
import { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import type { AgentRunActivities } from "./contracts";
import { ModelGateway } from "../model/gateway";
import { EnvironmentCredentialResolver, VaultCredentialResolver, type CredentialResolver } from "../model/credentials";
import type { ModelPricing } from "../model/types";
import { runBoundedAgentLoop, type AgentLoopResult } from "../runtime/loop";
import { buildAgentContext } from "../runtime/context";
import { retrievalGate } from "../runtime/context";
import { hashToolArguments, ToolRegistry } from "../tools/registry";
import { KasitekCoreReadClient } from "../core/client";
import type { AppConfig } from "../config";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { RunStepRepository } from "../db/repositories/run-step-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { SummaryRepository } from "../db/repositories/summary-repository";
import { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { resolveModelTarget } from "../model/policy";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { authorizeInstallationCapability } from "../capabilities/authorization";
import { validateWorkflowGraph, type WorkflowGraph } from "../workflows/graph";
import { executeWorkflowGraph } from "../workflows/executor";
import { WorkflowStateRepository } from "../db/repositories/workflow-state-repository";
import { redactSensitiveValue } from "../tools/redaction";
import type { ModelCredentials, ModelResponse } from "../model/types";
import { buildGroundingProvenance } from "../runtime/provenance";
import type { ToolInvocationContext } from "../tools/types";
import type { CoreContentPost } from "../core/client";
import { buildDomainApprovalSnapshot, projectBookingApprovalResource, projectCampaignApprovalResource } from "../approval/domain-preview";

export interface ActivityOptions {
  gateway?: ModelGateway;
  credentials?: CredentialResolver;
  tools?: ToolRegistry;
  coreClient?: KasitekCoreReadClient;
  config?: AppConfig;
}

function pricingFromConfig(config?: AppConfig): Record<string, ModelPricing> {
  if (!config?.MODEL_PRICING_JSON) return {};
  try {
    const parsed = JSON.parse(config.MODEL_PRICING_JSON) as Record<string, ModelPricing>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isFinite(value.inputUsdPerMillion) && Number.isFinite(value.outputUsdPerMillion)));
  } catch {
    throw new Error("MODEL_PRICING_JSON must be valid JSON");
  }
}

export function createDefaultTools(coreClient?: KasitekCoreReadClient): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "platform.current_time",
    version: "1.0.0",
    description: "Get the current UTC time from the trusted platform runtime.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { iso: { type: "string" } },
      required: ["iso"],
      additionalProperties: false,
    },
    manifest: { ownerService: "agents", requiredScope: "platform.time.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [] },
    handler: async () => ({ iso: new Date().toISOString() }),
  });
  tools.register({
    name: "kasitek.core.customer_get",
    version: "1.0.0",
    description: "Read a customer profile and scoped history from kasitek-core.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["customerId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["customer"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "customers.read", resourceSelector: { type: "customer", argument: "customerId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["customer.email", "customer.phone"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCustomer(context, String(args.customerId));
    },
  });
  tools.register({
    name: "kasitek.core.workspace_status",
    version: "1.0.0",
    description: "Read connection providers and health statuses for the current KasiTek workspace.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { organizationId: { type: "string" }, connections: { type: "array" } },
      required: ["organizationId", "connections"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "connections.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: ["connections.credentials"] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getWorkspaceStatus(context);
    },
  });
  tools.register({
    name: "kasitek.core.workspace_report",
    version: "1.0.0",
    description: "Read organization-scoped workspace reporting aggregates without contact values, message bodies, or provider credentials.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        organizationId: { type: "string" },
        connections: { type: "object" },
        content: { type: "object" },
        contacts: { type: "object" },
        inbox: { type: "object" },
        bookings: { type: "object" },
        campaigns: { type: "object" },
        templates: { type: "object" },
      },
      required: ["organizationId", "connections", "content", "contacts", "inbox", "bookings", "campaigns", "templates"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "workspace.reporting.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["contacts.phone", "inbox.messageBody", "connections.credentials"] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getWorkspaceReport(context);
    },
  });
  tools.register({
    name: "kasitek.core.booking_services_list",
    version: "1.0.0",
    description: "List the booking services configured for the current KasiTek workspace.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { services: { type: "array" } }, required: ["services"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "bookings.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: [] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listBookingServices(context);
    },
  });
  tools.register({
    name: "kasitek.core.bookings_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's upcoming and historical bookings.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["bookings"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "bookings.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["bookings.contactPhone", "bookings.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listBookings(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.booking_get",
    version: "1.0.0",
    description: "Read one organization-scoped booking with safe customer and scheduling details.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { bookingId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["bookingId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["booking"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "bookings.read",
      resourceSelector: { type: "booking", argument: "bookingId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["booking.contactPhone", "booking.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getBooking(context, String(args.bookingId));
    },
  });
  tools.register({
    name: "kasitek.core.campaigns_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's WhatsApp campaign status and delivery metrics.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["campaigns"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "campaigns.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["campaigns.templateBody", "campaigns.recipientPhone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listCampaigns(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.campaign_summary",
    version: "1.0.0",
    description: "Read one organization-scoped WhatsApp campaign summary without recipient details.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["campaignId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["campaign"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "campaigns.read",
      resourceSelector: { type: "campaign", argument: "campaignId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["campaign.templateBody", "campaign.recipientPhone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCampaignSummary(context, String(args.campaignId));
    },
  });
  tools.register({
    name: "kasitek.core.templates_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's WhatsApp templates and approval status.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["APPROVED", "PENDING", "REJECTED", "DISABLED"] } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["templates"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "templates.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["templates.body", "templates.buttons"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listTemplates(
        context,
        typeof args.status === "string" ? args.status as "APPROVED" | "PENDING" | "REJECTED" | "DISABLED" : undefined,
      );
    },
  });
  tools.register({
    name: "kasitek.core.contacts_list",
    version: "1.0.0",
    description: "Search the current KasiTek workspace's WhatsApp contacts and consent state.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 200 },
        optIn: { type: "string", enum: ["all", "true", "false"] },
        excluded: { type: "string", enum: ["all", "true", "false"] },
        tag: { type: "string", maxLength: 120 },
        location: { type: "string", maxLength: 160 },
        listLabel: { type: "string", maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["contacts"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "contacts.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["contacts.phone", "contacts.metadata"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listContacts(context, {
        q: typeof args.q === "string" ? args.q : undefined,
        optIn: typeof args.optIn === "string" ? args.optIn as "all" | "true" | "false" : undefined,
        excluded: typeof args.excluded === "string" ? args.excluded as "all" | "true" | "false" : undefined,
        tag: typeof args.tag === "string" ? args.tag : undefined,
        location: typeof args.location === "string" ? args.location : undefined,
        listLabel: typeof args.listLabel === "string" ? args.listLabel : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.contact_update",
    version: "1.0.0",
    description: "Update one workspace contact's profile, consent, exclusion, or list membership after approval.",
    riskClass: "controlled-write",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", minLength: 1, maxLength: 160 },
        fullName: { type: "string", maxLength: 240 },
        phone: { type: "string", maxLength: 80 },
        location: { type: "string", maxLength: 160 },
        tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 50 },
        notes: { type: "string", maxLength: 4_000 },
        listLabel: { type: "string", maxLength: 160 },
        metadata: { type: "object", additionalProperties: true },
        optIn: { type: "boolean" },
        excluded: { type: "boolean" },
      },
      required: ["contactId"],
      minProperties: 2,
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["contact"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "contacts.write",
      resourceSelector: { type: "contact", argument: "contactId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["contact.phone", "contact.metadata", "contact.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateContact(context, String(args.contactId), {
        fullName: typeof args.fullName === "string" ? args.fullName : undefined,
        phone: typeof args.phone === "string" ? args.phone : undefined,
        location: typeof args.location === "string" ? args.location : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        notes: typeof args.notes === "string" ? args.notes : undefined,
        listLabel: typeof args.listLabel === "string" ? args.listLabel : undefined,
        metadata: args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata) ? args.metadata as Record<string, unknown> : undefined,
        optIn: typeof args.optIn === "boolean" ? args.optIn : undefined,
        excluded: typeof args.excluded === "boolean" ? args.excluded : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversations_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's inbox conversations and unread counts.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["conversations"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["conversations.phone", "conversations.lastMessage"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listInboxConversations(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_messages_list",
    version: "1.0.0",
    description: "Read the organization-scoped message timeline for one inbox conversation.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", minLength: 1, maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["messages"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.read",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["messages.content", "messages.attachments"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listInboxMessages(context, String(args.conversationId), { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversation_update",
    version: "1.0.0",
    description: "Star or unstar one organization-scoped inbox conversation.",
    riskClass: "controlled-write",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", minLength: 1, maxLength: 160 },
        starred: { type: "boolean" },
      },
      required: ["conversationId", "starred"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["success", "conversationId", "starred"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "full",
      redaction: ["conversation.phone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateInboxConversation(context, String(args.conversationId), { starred: Boolean(args.starred) });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversation_mark_read",
    version: "1.0.0",
    description: "Mark one organization-scoped WhatsApp inbox conversation read after approval.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 30_000,
    inputSchema: {
      type: "object",
      properties: { conversationId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["conversationId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { success: { type: "boolean" } }, required: ["success"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["conversation.phone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.markInboxConversationRead(context, String(args.conversationId));
    },
  });
  tools.register({
    name: "kasitek.core.channel_deliver",
    version: "1.0.0",
    description: "Send an approved reply to an organization-scoped WhatsApp conversation.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        channelType: { type: "string", enum: ["whatsapp"] },
        externalConversationId: { type: "string", minLength: 1, maxLength: 240 },
        text: { type: "string", minLength: 1, maxLength: 20_000 },
      },
      required: ["channelType", "externalConversationId", "text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        providerMessageId: { type: "string" },
        status: { type: "string", enum: ["sent", "unknown"] },
      },
      required: ["status"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "channels.write",
      resourceSelector: { type: "conversation", argument: "externalConversationId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["text", "externalConversationId", "providerMessageId"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.deliverChannelMessage({
        organizationId: context.organizationId,
        installationId: context.installationId,
        actorId: context.actorId ?? "kasitek-agent-platform",
        runId: context.runId,
        correlationId: context.correlationId,
        channelType: String(args.channelType),
        externalConversationId: String(args.externalConversationId),
        text: String(args.text),
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_posts_list",
    version: "1.0.0",
    description: "List the current workspace's content drafts, schedules, and publication records.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { posts: { type: "array" } }, required: ["posts"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["posts.publishJobs.providerReceipt"] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listContentPosts(context);
    },
  });
  tools.register({
    name: "kasitek.core.content_post_get",
    version: "1.0.0",
    description: "Read one workspace-owned content post and its safe publication status.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", properties: { postId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["postId"], additionalProperties: false },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getContentPost(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_update",
    version: "1.0.0",
    description: "Update a workspace content draft without publishing it.",
    riskClass: "draft",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", maxLength: 240 },
        prompt: { type: "string", maxLength: 4_000 },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
        channels: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 },
        primaryChannelId: { type: "string", minLength: 1, maxLength: 160 },
        channelSelections: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 160 } },
        variants: { type: "array", items: { type: "object" }, maxItems: 20 },
        metadata: { type: "object" },
      },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateContentDraft(context, String(args.postId), {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        content: typeof args.content === "string" ? args.content : undefined,
        channels: Array.isArray(args.channels) ? args.channels.map(String) : undefined,
        primaryChannelId: typeof args.primaryChannelId === "string" ? args.primaryChannelId : undefined,
        channelSelections: args.channelSelections && typeof args.channelSelections === "object" ? args.channelSelections as Record<string, string> : undefined,
        variants: Array.isArray(args.variants) ? args.variants as Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }> : undefined,
        metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_post_draft",
    version: "1.0.0",
    description: "Create a workspace content draft without publishing it to any provider.",
    riskClass: "draft",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 240 },
        prompt: { type: "string", maxLength: 4_000 },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
        channels: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 },
        primaryChannelId: { type: "string", minLength: 1, maxLength: 160 },
        channelSelections: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 160 } },
        variants: { type: "array", items: { type: "object" }, maxItems: 20 },
        metadata: { type: "object" },
      },
      required: ["content", "channels"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", execution: "immediate", idempotency: "required", approval: "none", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.createContentDraft(context, {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        content: String(args.content),
        channels: Array.isArray(args.channels) ? args.channels.map(String) : [],
        primaryChannelId: typeof args.primaryChannelId === "string" ? args.primaryChannelId : undefined,
        channelSelections: args.channelSelections && typeof args.channelSelections === "object" ? args.channelSelections as Record<string, string> : undefined,
        variants: Array.isArray(args.variants) ? args.variants as Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }> : undefined,
        metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish",
    version: "1.0.0",
    description: "Publish an approved content post to one configured social channel.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        platform: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["postId", "platform"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "result"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.publishContentPost(context, String(args.postId), String(args.platform));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_schedule",
    version: "1.0.0",
    description: "Schedule a draft for provider publishing at a future time.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        scheduledFor: { type: "string", minLength: 20, maxLength: 64 },
      },
      required: ["postId", "scheduledFor"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "status"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.scheduleContentPost(context, String(args.postId), String(args.scheduledFor));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_unschedule",
    version: "1.0.0",
    description: "Move a scheduled content post back to a draft without publishing it.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "status"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.unscheduleContentPost(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_delete",
    version: "1.0.0",
    description: "Delete an unpublished content draft or schedule.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["postId", "deleted"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.deleteContentPost(context, String(args.postId));
    },
  });
  return tools;
}

const approvalPreviewKeys = new Set([
  "postId",
  "platform",
  "scheduledFor",
  "conversationId",
  "contactId",
  "bookingId",
  "campaignId",
  "channelType",
  "externalConversationId",
  "templateName",
  "action",
]);

const contentPreviewCapabilities = new Set([
  "kasitek.core.content_post_publish",
  "kasitek.core.content_post_schedule",
  "kasitek.core.content_post_unschedule",
  "kasitek.core.content_post_delete",
]);

const campaignPreviewCapabilities = new Set([
  "kasitek.core.campaign_launch",
  "kasitek.core.campaign_pause",
  "kasitek.core.campaign_resume",
  "kasitek.core.campaign_cancel",
  "kasitek.core.campaign_delete",
]);

const bookingPreviewCapabilities = new Set([
  "kasitek.core.booking_create",
  "kasitek.core.booking_update",
  "kasitek.core.booking_cancel",
]);

const channelPreviewCapabilities = new Set(["kasitek.core.channel_deliver"]);

function boundedPreviewString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function projectContentVariant(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const variant = value as Record<string, unknown>;
  const platform = boundedPreviewString(variant.platform, 80);
  const content = boundedPreviewString(variant.content, 2_000);
  if (!platform && !content) return null;
  return {
    ...(platform ? { platform } : {}),
    ...(content ? { contentPreview: content } : {}),
    ...(boundedPreviewString(variant.status, 40) ? { status: boundedPreviewString(variant.status, 40) } : {}),
  };
}

/** Project only the fields an authenticated approver needs to understand a content effect. */
export function projectContentApprovalResource(post: CoreContentPost): Record<string, unknown> {
  const variants = Array.isArray(post.variants)
    ? post.variants.map(projectContentVariant).filter((value): value is Record<string, unknown> => Boolean(value)).slice(0, 20)
    : [];
  return {
    postId: boundedPreviewString(post.id, 160) ?? "",
    ...(boundedPreviewString(post.title, 240) ? { title: boundedPreviewString(post.title, 240) } : {}),
    status: boundedPreviewString(post.status, 40) ?? "UNKNOWN",
    ...(boundedPreviewString(post.content, 2_000) ? { contentPreview: boundedPreviewString(post.content, 2_000) } : {}),
    channels: Array.isArray(post.channels) ? post.channels.filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 80)).slice(0, 20) : [],
    ...(boundedPreviewString(post.scheduled_for, 64) ? { scheduledFor: boundedPreviewString(post.scheduled_for, 64) } : {}),
    ...(boundedPreviewString(post.published_at, 64) ? { publishedAt: boundedPreviewString(post.published_at, 64) } : {}),
    ...(variants.length ? { variants } : {}),
  };
}

/**
 * Describe the requested state transition separately from the read projection.
 * Keeping the operation in the immutable preview makes an approval legible
 * without exposing provider payloads or relying on the model to infer the
 * effect from a capability name.
 */
export function projectContentApprovalOperation(
  capability: string,
  argumentsValue: Record<string, unknown>,
  post: CoreContentPost,
): Record<string, unknown> {
  const postId = boundedPreviewString(post.id, 160) ?? "";
  const fromStatus = boundedPreviewString(post.status, 40) ?? "UNKNOWN";
  switch (capability) {
    case "kasitek.core.content_post_publish":
      return {
        type: "publish",
        postId,
        fromStatus,
        ...(boundedPreviewString(argumentsValue.platform, 80) ? { platform: boundedPreviewString(argumentsValue.platform, 80) } : {}),
        targetStatus: "PUBLISHED",
      };
    case "kasitek.core.content_post_schedule":
      return {
        type: "schedule",
        postId,
        fromStatus,
        ...(boundedPreviewString(argumentsValue.scheduledFor, 64) ? { scheduledFor: boundedPreviewString(argumentsValue.scheduledFor, 64) } : {}),
        targetStatus: "SCHEDULED",
      };
    case "kasitek.core.content_post_unschedule":
      return {
        type: "unschedule",
        postId,
        fromStatus,
        ...(boundedPreviewString(post.scheduled_for, 64) ? { currentScheduledFor: boundedPreviewString(post.scheduled_for, 64) } : {}),
        targetStatus: "DRAFT",
      };
    case "kasitek.core.content_post_delete":
      return {
        type: "delete",
        postId,
        fromStatus,
        targetStatus: "DELETED",
      };
    default:
      return { type: "unknown", postId, fromStatus };
  }
}

/**
 * Build the immutable, safe portion of an approval preview. Provider payloads,
 * credentials, and arbitrary metadata never enter the approval record; the
 * exact arguments hash still binds the eventual effect. A domain adapter may
 * provide a read projection captured at proposal time.
 */
export function buildApprovalResourceSnapshot(capability: string, argumentsValue: Record<string, unknown>, resource?: Record<string, unknown>): Record<string, unknown> {
  const request = Object.fromEntries(
    Object.entries(argumentsValue)
      .filter(([key, value]) => approvalPreviewKeys.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 256) : value]),
  );
  return {
    capability,
    request,
    ...(resource ? { resource } : {}),
  };
}

/** Read the current resource once, at proposal time, so approval is bound to what was reviewed. */
export async function buildApprovalResourceSnapshotFromCore(
  coreClient: KasitekCoreReadClient | undefined,
  context: ToolInvocationContext,
  capability: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (contentPreviewCapabilities.has(capability) && (!coreClient || typeof argumentsValue.postId !== "string")) {
    throw new Error("CONTENT_PREVIEW_UNAVAILABLE");
  }
  if (campaignPreviewCapabilities.has(capability) && (!coreClient || typeof argumentsValue.campaignId !== "string")) {
    throw new Error("CAMPAIGN_PREVIEW_UNAVAILABLE");
  }
  if (bookingPreviewCapabilities.has(capability) && capability !== "kasitek.core.booking_create" && (!coreClient || typeof argumentsValue.bookingId !== "string")) {
    throw new Error("BOOKING_PREVIEW_UNAVAILABLE");
  }
  if (channelPreviewCapabilities.has(capability)) {
    return buildDomainApprovalSnapshot(capability, argumentsValue);
  }
  if (!contentPreviewCapabilities.has(capability) && !campaignPreviewCapabilities.has(capability) && !bookingPreviewCapabilities.has(capability)) {
    return capability.startsWith("kasitek.core.") ? buildDomainApprovalSnapshot(capability, argumentsValue) : buildApprovalResourceSnapshot(capability, argumentsValue);
  }
  try {
    if (contentPreviewCapabilities.has(capability)) {
      const response = await coreClient!.getContentPost(context, argumentsValue.postId as string);
      const resource = projectContentApprovalResource(response.post);
      return buildApprovalResourceSnapshot(capability, argumentsValue, { kind: "content_post", revision: "content-post.v1", ...resource, operation: projectContentApprovalOperation(capability, argumentsValue, response.post) });
    }
    if (campaignPreviewCapabilities.has(capability)) {
      const response = await coreClient!.getCampaignSummary(context, argumentsValue.campaignId as string);
      const resource = projectCampaignApprovalResource(response.campaign);
      return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "campaign", revision: "campaign.v1", ...resource });
    }
    if (capability !== "kasitek.core.booking_create") {
      const response = await coreClient!.getBooking(context, argumentsValue.bookingId as string);
      const resource = projectBookingApprovalResource(response.booking);
      return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "booking", revision: "booking.v1", ...resource });
    }
    return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "booking", revision: "booking.v1", status: "NEW" });
  } catch {
    // A missing/unavailable preview must never turn into an unreviewed effect.
    throw new Error(contentPreviewCapabilities.has(capability) ? "CONTENT_PREVIEW_UNAVAILABLE" : campaignPreviewCapabilities.has(capability) ? "CAMPAIGN_PREVIEW_UNAVAILABLE" : "BOOKING_PREVIEW_UNAVAILABLE");
  }
}

function restrictiveLimit(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : undefined;
}

async function assertCurrentCapabilityPolicy(input: {
  organizationId: string;
  installationId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  grantedTools: ReadonlySet<string>;
  tools: ToolRegistry;
  installationGrants: InstallationGrantRepository;
  approved: boolean;
}): Promise<void> {
  await authorizeInstallationCapability(input);
}

export function createActivities(pool: Pool, options: ActivityOptions = {}): AgentRunActivities {
  const runs = new RunRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const conversations = new ConversationRepository(pool);
  const memory = new MemoryRepository(pool);
  const knowledge = new KnowledgeRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const runSteps = new RunStepRepository(pool);
  const toolGrants = new ToolGrantRepository(pool);
  const summaries = new SummaryRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const controls = new OperatorControlRepository(pool);
  const channels = new ChannelRepository(pool);
  const kasiaiPreferences = new KasiAiPreferenceRepository(pool);
  const effectReceipts = new EffectReceiptRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const installationGrants = new InstallationGrantRepository(pool);
  const workflowState = new WorkflowStateRepository(pool);
  const gateway = options.gateway ?? new ModelGateway(undefined, { pricing: pricingFromConfig(options.config) });
  const credentials = options.credentials ?? (options.config
    ? new VaultCredentialResolver(new CredentialVaultRepository(pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY))
    : new EnvironmentCredentialResolver());
  const coreClient = options.coreClient ?? (options.config ? new KasitekCoreReadClient(options.config) : undefined);
  const tools = options.tools ?? createDefaultTools(coreClient);
  return {
    async transitionRun(input) {
      await runs.transitionRun(input.runId, input.expectedStatus, input.nextStatus);
    },
    async executeLoop(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      if (isMcpToolRun(run.input)) {
        return executeMcpToolRun(
          run,
          input.resumeApprovedToolCall,
          runs,
          toolInvocations,
          approvals,
          effectReceipts,
          runSteps,
          toolGrants,
          installationGrants,
          killSwitches,
          controls,
          tools,
          coreClient,
        );
      }
      return executeLoopForRun(run, input.resumeApprovedToolCall, input.resumeExternalEvent, runs, modelCalls, conversations, memory, knowledge, toolInvocations, approvals, effectReceipts, runSteps, toolGrants, installationGrants, summaries, killSwitches, controls, kasiaiPreferences, gateway, credentials, tools, workflowState, coreClient);
    },
    async pauseRun(input) {
      await runs.pauseRun(input.runId, input.status, input.output);
    },
    async cancelPendingApproval(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      await approvals.cancel(run.organization_id, run.id, input.providerToolCallId);
      await effectReceipts.markNotExecuted(run.organization_id, run.id, input.providerToolCallId, {
        code: "RUN_CANCELLED",
        message: input.reason ?? "The run was cancelled before the approved effect began",
      });
      await runs.appendEvent({
        organizationId: run.organization_id,
        runId: run.id,
        installationId: run.installation_id,
        eventType: input.outcome === "expired" ? "agent.approval.expired" : "agent.approval.cancelled",
        payload: { providerToolCallId: input.providerToolCallId },
      });
    },
    async completeRun(input) {
      const completed = await runs.completeRun(input.runId, input.output);
      if (completed.conversation_id) {
        try {
          const messages = await conversations.listMessages(completed.organization_id, completed.conversation_id);
          await summaries.rebuildFromMessages({
            organizationId: completed.organization_id,
            conversationId: completed.conversation_id,
            messages,
          });
        } catch (error) {
          await runs.appendEvent({
            organizationId: completed.organization_id,
            runId: completed.id,
            installationId: completed.installation_id,
            eventType: "agent.summary.failed",
            payload: { message: error instanceof Error ? error.message : "Conversation summary failed" },
          });
        }
      }
    },
    async generateConversationTitle(input) {
      try {
        const run = await runs.getRuntimeRunById(input.runId);
        if (!run?.conversation_id) return;
        const candidate = await conversations.getTitleCandidate(run.organization_id, run.conversation_id);
        if (!candidate || candidate.title_locked || candidate.title_source !== "fallback" || !candidate.first_message) return;
        const configuration = run.configuration;
        const target = resolveModelTarget(configuration, run.policy);
        const provider = (run.resolved_model_provider ?? target.provider) as typeof target.provider;
        const model = run.resolved_model ?? target.model;
        const credentialReference = typeof configuration.credentialReference === "string" ? configuration.credentialReference : undefined;
        const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
        const response = await gateway.complete({
          provider,
          model,
          temperature: 0,
          maxTokens: 24,
          timeoutMs: 12_000,
          maxAttempts: 1,
          messages: [
            { role: "system", content: "Create a concise 3 to 7 word chat title. Return only the title, no quotes, punctuation, Markdown, or explanation." },
            { role: "user", content: candidate.first_message.slice(0, 1_000) },
          ],
        }, modelCredentials);
        const title = response.message.content
          .replace(/[\r\n]+/g, " ")
          .replace(/^[-#*\s\"']+|[-#*\s\"']+$/g, "")
          .trim()
          .slice(0, 120);
        if (!title || /^(?:hi|hello|hey|yo|new chat)(?:[!,.?\s]+)?$/i.test(title)) return;
        const updated = await conversations.setGeneratedTitle({
          organizationId: run.organization_id,
          conversationId: run.conversation_id,
          title,
        });
        if (updated) {
          await runs.appendEvent({
            organizationId: run.organization_id,
            runId: run.id,
            installationId: run.installation_id,
            eventType: "conversation.title.generated",
            payload: { conversationId: run.conversation_id },
          });
        }
      } catch (error) {
        // A conversation title is decorative metadata. Never fail or retry the
        // completed user run because a provider cannot generate one.
        void error;
      }
    },
    async deliverRunReply(input) {
      const pending = await channels.getRunReplyDelivery(input.runId);
      if (!pending) return;
      if (await controls.isHeld({ organizationId: pending.organization_id, installationId: pending.installation_id, runId: pending.run_id, holdType: "delivery" })) {
        throw new Error("AGENT_DELIVERY_HOLD_ACTIVE");
      }
      const text = typeof pending.content.text === "string" ? pending.content.text.trim() : "";
      if (!text) throw new Error("External channel reply has no text content");
      const deliveryStep = await runSteps.startStep({
        runId: pending.run_id,
        organizationId: pending.organization_id,
        stepType: "delivery",
        input: { preview: buildDomainApprovalSnapshot("kasitek.core.channel_deliver", { channelType: pending.channel_type, externalConversationId: pending.external_conversation_id, text }) },
      });
      let claimed = false;
      try {
        await channels.claimDelivery(pending.organization_id, pending.attempt_id);
        claimed = true;
        if (!coreClient) throw new Error("kasitek-core channel delivery boundary is not configured");
        const result = await coreClient.deliverChannelMessage({
          organizationId: pending.organization_id,
          installationId: pending.installation_id,
          actorId: pending.actor_id,
          runId: pending.run_id,
          correlationId: pending.correlation_id,
          channelType: pending.channel_type,
          externalConversationId: pending.external_conversation_id,
          text,
        });
        await channels.markDelivered({
          organizationId: pending.organization_id,
          attemptId: pending.attempt_id,
          providerMessageId: result.providerMessageId,
        });
        await runSteps.finishStep({ stepId: deliveryStep.id, status: "completed", output: { status: result.status } });
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivered",
          payload: { channelType: pending.channel_type, status: result.status },
        });
      } catch (error) {
        if (claimed) {
          await channels.markDeliveryFailed({
            organizationId: pending.organization_id,
            attemptId: pending.attempt_id,
            error: { code: "CHANNEL_DELIVERY_FAILED", message: error instanceof Error ? error.message : "Channel delivery failed" },
          });
        }
        await runSteps.finishStep({ stepId: deliveryStep.id, status: "failed", error: { code: "CHANNEL_DELIVERY_FAILED", message: error instanceof Error ? error.message : "Channel delivery failed" } });
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivery_failed",
          payload: { channelType: pending.channel_type, message: error instanceof Error ? error.message : "Channel delivery failed" },
        });
      }
    },
    async failRun(input) {
      await runs.failRun(input.runId, input.error);
    },
  };
}

function isMcpToolRun(input: Record<string, unknown>): input is Record<string, unknown> & { mcpTool: { name: string; arguments: Record<string, unknown>; toolCallId: string } } {
  const tool = input.mcpTool;
  return Boolean(
    tool
      && typeof tool === "object"
      && typeof (tool as Record<string, unknown>).name === "string"
      && typeof (tool as Record<string, unknown>).toolCallId === "string"
      && (tool as Record<string, unknown>).arguments
      && typeof (tool as Record<string, unknown>).arguments === "object"
      && !Array.isArray((tool as Record<string, unknown>).arguments),
  );
}

async function executeMcpToolRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  runs: RunRepository,
  toolInvocations: ToolInvocationRepository,
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  killSwitches: KillSwitchRepository,
  controls: OperatorControlRepository,
  tools: ToolRegistry,
  coreClient: KasitekCoreReadClient | undefined,
) {
  if (!isMcpToolRun(run.input)) throw new Error("Invalid MCP run input");
  const invocation = resumeApprovedToolCall ?? {
    id: run.input.mcpTool.toolCallId,
    name: run.input.mcpTool.name,
    arguments: run.input.mcpTool.arguments,
  };
  const manifest = tools.get(invocation.name);
  if (!manifest) throw new Error(`Tool is not registered: ${invocation.name}`);
  const argumentsHash = hashToolArguments(invocation.arguments);
  const approvalRecord = resumeApprovedToolCall ? await approvals.getForRun(run.organization_id, run.id) : null;
  const resourceSnapshot = resumeApprovedToolCall?.approval.resourceSnapshot
    ?? approvalRecord?.resource_snapshot
    ?? await buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: run.organization_id,
      agentId: run.agent_definition_id,
      agentVersionId: run.agent_version_id,
      installationId: run.installation_id,
      runId: run.id,
      actorId: run.created_by,
      correlationId: run.correlation_id,
    }, invocation.name, invocation.arguments);
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  // New direct calls must be granted before a proposal is created. Resumed
  // approvals are re-authorized in the guarded path below so revocation closes
  // the reserved effect as unexecuted without reaching the provider.
  if (!resumeApprovedToolCall && !grantedTools.has(invocation.name)) throw new Error(`Tool is not granted: ${invocation.name}`);
  if (!resumeApprovedToolCall && run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");

  let stepId: string | undefined;
  if (!resumeApprovedToolCall) {
    await toolInvocations.recordProposal({
      organizationId: run.organization_id,
      runId: run.id,
      providerToolCallId: invocation.id,
      sequenceNumber: 1,
      toolName: invocation.name,
      toolVersion: manifest.version,
      riskClass: manifest.riskClass,
      argumentsHash,
      arguments: invocation.arguments,
      requiresApproval: manifest.requiresApproval,
    });
    if (manifest.riskClass === "external-effect") {
      await effectReceipts.reserve({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        idempotencyKey: `${run.id}:${invocation.name}:${argumentsHash}`,
      });
    }
    const step = await runSteps.startStep({
      runId: run.id,
      organizationId: run.organization_id,
      stepType: "tool",
      input: { toolCallId: invocation.id, name: invocation.name, argumentsHash },
    });
    stepId = step.id;
    if (manifest.requiresApproval) {
      await approvals.createPending({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        resourceSnapshot,
        previewRevision: argumentsHash,
        policyRevision: "v1",
        permittedEffectKey: `${run.id}:${invocation.id}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      return {
        status: "awaiting_approval" as const,
        messages: [],
        pendingToolCalls: [{ id: invocation.id, name: invocation.name, arguments: invocation.arguments, argumentsHash }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        iterations: 0,
        toolCalls: 1,
        provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
      };
    }
  }

  let policyApplied = false;
  let effectTransitioned = false;
  try {
    if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
    if (await killSwitches.isBlocked({
      organizationId: run.organization_id,
      agentId: run.agent_definition_id,
      installationId: run.installation_id,
      toolNames: [invocation.name],
    })) throw new Error("AGENT_KILL_SWITCH_ACTIVE");
    if (manifest.riskClass === "external-effect") {
      if (!(await controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
      if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
    }
    await assertCurrentCapabilityPolicy({
      organizationId: run.organization_id,
      installationId: run.installation_id,
      name: invocation.name,
      argumentsValue: invocation.arguments,
      grantedTools,
      tools,
      installationGrants,
      approved: !manifest.requiresApproval || Boolean(resumeApprovedToolCall?.approval),
    });
    policyApplied = true;
    const effectIdempotencyKey = `${run.id}:${invocation.name}:${argumentsHash}`;
    if (manifest.requiresApproval && manifest.riskClass !== "external-effect") {
      await approvals.consume({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        resourceSnapshot,
        previewRevision: argumentsHash,
        policyRevision: "v1",
        permittedEffectKey: `${run.id}:${invocation.id}`,
      });
    }
    const result = await tools.invoke({
      name: invocation.name,
      arguments: invocation.arguments,
      grantedTools,
      approval: resumeApprovedToolCall?.approval,
      beforeEffect: manifest.riskClass === "external-effect" ? async () => {
        if (manifest.requiresApproval) {
          await approvals.consumeAndStartEffect({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: invocation.id,
            capability: invocation.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            resourceSnapshot,
            previewRevision: argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${run.id}:${invocation.id}`,
            effectIdempotencyKey,
          });
        } else {
          await effectReceipts.markExecutingByKey(run.organization_id, effectIdempotencyKey);
        }
        effectTransitioned = true;
      } : undefined,
      context: {
        organizationId: run.organization_id,
        agentId: run.agent_definition_id,
        agentVersionId: run.agent_version_id,
        installationId: run.installation_id,
        runId: run.id,
        actorId: run.created_by,
        correlationId: run.correlation_id,
      },
    });
    await toolInvocations.recordCompleted({
      runId: run.id,
      providerToolCallId: invocation.id,
      output: result.output,
      latencyMs: result.latencyMs,
      effectId: result.effectId,
    });
    if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${invocation.name}:${argumentsHash}`, result.output);
    if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    await runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: "mcp.tool.completed",
      payload: { toolCallId: invocation.id, name: invocation.name },
    });
    return {
      status: "completed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
      provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
    };
  } catch (error) {
    const normalized = { code: "MCP_TOOL_FAILED", message: error instanceof Error ? error.message : "MCP tool failed" };
    await toolInvocations.recordFailed({ runId: run.id, providerToolCallId: invocation.id, error: normalized });
    if (manifest.riskClass === "external-effect") {
      const effectKey = `${run.id}:${invocation.name}:${argumentsHash}`;
      if (effectTransitioned) {
        await effectReceipts.markUnknownByKey(run.organization_id, effectKey, normalized);
      } else if (!policyApplied) {
        await effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, normalized);
      }
    }
    if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: normalized });
    return {
      status: "failed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
      error: normalized,
      provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
    };
  }
}

async function executeLoopForRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  resumeExternalEvent: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeExternalEvent"],
  runs: RunRepository,
  modelCalls: ModelCallRepository,
  conversations: ConversationRepository,
  memory: MemoryRepository,
  knowledge: KnowledgeRepository,
  toolInvocations: ToolInvocationRepository,
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  summaries: SummaryRepository,
  killSwitches: KillSwitchRepository,
  controls: OperatorControlRepository,
  kasiaiPreferences: KasiAiPreferenceRepository,
  gateway: ModelGateway,
  credentials: CredentialResolver,
  tools: ToolRegistry,
  workflowState: WorkflowStateRepository,
  coreClient: KasitekCoreReadClient | undefined,
) {
  if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
  const configuration = run.configuration;
  const installationSettings = run.installation_settings ?? {};
  const modelTarget = resolveModelTarget(configuration, run.policy);
  const provider = (run.resolved_model_provider ?? modelTarget.provider) as typeof modelTarget.provider;
  const model = run.resolved_model ?? modelTarget.model;
  const policyTools = new Set(
    Array.isArray(run.policy.allowedTools) ? run.policy.allowedTools.filter((value): value is string => typeof value === "string") : [],
  );
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  const allowedTools = new Set([...policyTools].filter((toolName) => grantedTools.has(toolName)));
  if (await killSwitches.isBlocked({ organizationId: run.organization_id, agentId: run.agent_definition_id, installationId: run.installation_id, toolNames: [...allowedTools] })) {
    throw new Error("AGENT_KILL_SWITCH_ACTIVE");
  }
  if (!(await controls.isFeatureEnabled(run.organization_id, "agent_execution_enabled", run.installation_id))) throw new Error("AGENT_EXECUTION_FLAG_DISABLED");
  if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "execution" })) throw new Error("AGENT_EXECUTION_HOLD_ACTIVE");
  const credentialReference = typeof configuration.credentialReference === "string" ? configuration.credentialReference : undefined;
  const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
  const currentMessage = typeof run.input.message === "string" ? run.input.message : JSON.stringify(run.input);
  const rawDynamicContext = run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context)
    ? run.input.context as Record<string, unknown>
    : undefined;
  const dynamicContext = rawDynamicContext
    ? {
      route: typeof rawDynamicContext.route === "string" ? rawDynamicContext.route.slice(0, 500) : undefined,
      entity: typeof rawDynamicContext.entity === "string" ? rawDynamicContext.entity.slice(0, 240) : undefined,
      pageTitle: typeof rawDynamicContext.pageTitle === "string" ? rawDynamicContext.pageTitle.slice(0, 240) : undefined,
      enabledModules: Array.from(new Set([
        ...[...allowedTools].map((toolName) => toolName.split(".")[0] ?? toolName),
        ...(Array.isArray(rawDynamicContext.enabledModules)
          ? rawDynamicContext.enabledModules.filter((value): value is string => typeof value === "string")
          : []),
      ])).slice(0, 50),
    }
    : undefined;
  const conversation = run.conversation_id ? await conversations.getConversation(run.organization_id, run.conversation_id) : null;
  const preference = await kasiaiPreferences.get(run.organization_id, run.installation_id, run.created_by);
  const preferenceInstruction = preference?.use_saved_preferences
    ? [
      preference.language ? `Reply in ${preference.language} unless the user asks for another language.` : null,
      preference.tone ? `Use a ${preference.tone} communication style.` : null,
      preference.response_detail ? `Aim for ${preference.response_detail} response detail.` : null,
    ].filter((value): value is string => Boolean(value)).join(" ")
    : "";
  const durableMessages = run.conversation_id
    ? (await conversations.listMessages(run.organization_id, run.conversation_id)).filter((message) => message.run_id !== run.id)
    : [];
  const conversationSummary = run.conversation_id ? await summaries.getSummary(run.organization_id, run.conversation_id) : null;
  const retrievalRequested = retrievalGate(currentMessage);
  const retrievalScope = {
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    installationId: run.installation_id,
    conversationId: run.conversation_id ?? undefined,
    actorId: run.created_by,
  };
  const memoryMatches = retrievalRequested ? await memory.searchMemory(retrievalScope, currentMessage) : [];
  const knowledgeMatches = retrievalRequested ? await knowledge.search(retrievalScope, currentMessage) : [];
  const retrievalStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "retrieval",
    input: { requested: retrievalRequested, query: retrievalRequested ? currentMessage : undefined },
  });
  await runSteps.finishStep({
    stepId: retrievalStep.id,
    status: "completed",
    output: { memoryMatchCount: memoryMatches.length, knowledgeMatchCount: knowledgeMatches.length },
  });
  const longTermMemory = [
    ...memoryMatches.map((entry) => `[memory:${entry.memory_type}] ${entry.canonical_text}`),
    ...knowledgeMatches.map((entry) => `[knowledge:${entry.source_id}:${entry.chunk_index}] ${entry.canonical_text}`),
  ].join("\n");
  const context = buildAgentContext({
    instructions: [run.instructions, preferenceInstruction].filter(Boolean).join("\n\n"),
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    agentVersionId: run.agent_version_id,
    installationId: run.installation_id,
    runId: run.id,
    actorId: run.created_by,
    channelType: conversation?.channel_type,
    currentMessage,
    summary: conversationSummary?.summary,
    longTermMemory: longTermMemory || undefined,
    recentMessages: durableMessages.map((message) => ({
      direction: message.direction as "inbound" | "outbound" | "system",
      messageType: message.message_type,
      content: message.content,
      createdAt: message.created_at,
    })),
    authorizedTools: tools.list(allowedTools),
    dynamicContext,
    temporaryContext: run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context)
      ? JSON.stringify(run.input.context)
      : undefined,
    budget: {
      maxMessages: restrictiveLimit(configuration.maxContextMessages, installationSettings.maxContextMessages),
      maxContextTokens: restrictiveLimit(configuration.maxContextTokens, installationSettings.maxContextTokens),
    },
  });
  const contextStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "context",
    input: { messageCount: durableMessages.length },
  });
  await runSteps.finishStep({
    stepId: contextStep.id,
    status: "completed",
    output: { estimatedTokens: context.estimatedTokens, messageCount: context.messages.length },
  });
  await runs.appendEvent({
    organizationId: run.organization_id,
    runId: run.id,
    installationId: run.installation_id,
    eventType: "agent.context.built",
    payload: {
      estimatedTokens: context.estimatedTokens,
      omittedMessageCount: context.omittedMessageCount,
      retrievalRequested: context.retrievalRequested,
      messageCount: context.messages.length,
      memoryMatchCount: memoryMatches.length,
      knowledgeMatchCount: knowledgeMatches.length,
    },
  });
  if (configuration.workflow && typeof configuration.workflow === "object" && !Array.isArray(configuration.workflow)) {
    return executeConfiguredWorkflow({
      run,
      graphInput: configuration.workflow,
      inputState: { input: currentMessage, context: dynamicContext ?? {}, output: {} },
      context,
      modelProvider: provider,
      model,
      modelCredentials,
      gateway,
      tools,
      allowedTools,
      runRepository: runs,
      modelCalls,
      toolInvocations,
      approvals,
      effectReceipts,
      runSteps,
      installationGrants,
      killSwitches,
      controls,
      workflowState,
      resumeApprovedToolCall,
      resumeExternalEvent,
      coreClient,
    });
  }
  const approvedResourceSnapshot = resumeApprovedToolCall?.approval.resourceSnapshot
    ?? (resumeApprovedToolCall ? (await approvals.getForRun(run.organization_id, run.id))?.resource_snapshot : undefined);
  const toolSteps = new Map<string, string>();
  const startedExternalEffects = new Set<string>();
  const usedTools = new Set<string>();
  const unavailableTools = new Set<string>();
  const loopResult = await runBoundedAgentLoop({
    model: { provider, model, temperature: typeof configuration.temperature === "number" ? configuration.temperature : undefined },
    messages: context.messages,
    credentials: modelCredentials,
    gateway,
    tools,
    grantedTools: allowedTools,
    toolContext: {
      organizationId: run.organization_id,
      agentId: run.agent_definition_id,
      agentVersionId: run.agent_version_id,
      installationId: run.installation_id,
      runId: run.id,
      actorId: run.created_by,
      correlationId: run.correlation_id,
    },
    limits: {
      maxIterations: typeof configuration.maxIterations === "number" ? configuration.maxIterations : undefined,
      maxToolCalls: typeof configuration.maxToolCalls === "number" ? configuration.maxToolCalls : undefined,
      maxTotalTokens: restrictiveLimit(modelTarget.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens),
      maxEstimatedCostUsd: restrictiveLimit(modelTarget.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
      maxWallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : undefined,
    },
    beforeModelCall: () => modelCalls.assertRunBudget({
      organizationId: run.organization_id,
      runId: run.id,
      maxTotalTokens: restrictiveLimit(modelTarget.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens),
      maxEstimatedCostUsd: restrictiveLimit(modelTarget.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
      maxRequests: restrictiveLimit(configuration.maxModelCalls, installationSettings.maxModelCalls),
    }),
    beforeToolInvoke: async (invocation) => {
      const manifest = tools.get(invocation.name);
      if (manifest?.requiresApproval && !invocation.approved) return;
      await assertCurrentCapabilityPolicy({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        name: invocation.name,
        argumentsValue: invocation.arguments,
        grantedTools,
        tools,
        installationGrants,
        approved: invocation.approved,
      });
    },
    resumeApprovedToolCall,
    onEvent: (event) => runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: `agent.${event.type}`,
      payload: event.payload,
    }),
    onToolProposed: async (proposal) => {
      usedTools.add(proposal.name);
      const resourceSnapshot = proposal.requiresApproval && approvedResourceSnapshot
        ? approvedResourceSnapshot
        : await buildApprovalResourceSnapshotFromCore(coreClient, {
          organizationId: run.organization_id,
          agentId: run.agent_definition_id,
          agentVersionId: run.agent_version_id,
          installationId: run.installation_id,
          runId: run.id,
          actorId: run.created_by,
          correlationId: run.correlation_id,
        }, proposal.name, proposal.arguments);
      await toolInvocations.recordProposal({
        organizationId: run.organization_id,
        runId: run.id,
        providerToolCallId: proposal.toolCallId,
        sequenceNumber: proposal.sequenceNumber,
        toolName: proposal.name,
        toolVersion: proposal.version,
        riskClass: proposal.riskClass,
        argumentsHash: proposal.argumentsHash,
        arguments: proposal.arguments,
        requiresApproval: proposal.requiresApproval,
      });
      if (proposal.requiresApproval) {
        await approvals.createPending({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          resourceSnapshot,
          previewRevision: proposal.argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${run.id}:${proposal.toolCallId}`,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
      }
      if (proposal.riskClass === "external-effect") {
        await effectReceipts.reserve({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          idempotencyKey: `${run.id}:${proposal.name}:${proposal.argumentsHash}`,
        });
      }
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: proposal.toolCallId, name: proposal.name, argumentsHash: proposal.argumentsHash } });
      toolSteps.set(proposal.toolCallId, step.id);
    },
    onToolExecuting: async (execution) => {
      if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
      const manifest = tools.get(execution.name);
      const resourceSnapshot = execution.requiresApproval && approvedResourceSnapshot
        ? approvedResourceSnapshot
        : await buildApprovalResourceSnapshotFromCore(coreClient, {
          organizationId: run.organization_id,
          agentId: run.agent_definition_id,
          agentVersionId: run.agent_version_id,
          installationId: run.installation_id,
          runId: run.id,
          actorId: run.created_by,
          correlationId: run.correlation_id,
        }, execution.name, execution.arguments);
      await assertCurrentCapabilityPolicy({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        name: execution.name,
        argumentsValue: execution.arguments,
        grantedTools,
        tools,
        installationGrants,
        approved: execution.requiresApproval,
      });
      if (manifest?.riskClass === "external-effect") {
        if (!(await controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
        if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
      }
      if (execution.requiresApproval) {
        await approvals.consumeAndStartEffect({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: execution.toolCallId,
          capability: execution.name,
          capabilityVersion: execution.version,
          argumentsHash: execution.argumentsHash,
          resourceSnapshot,
          previewRevision: execution.argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${run.id}:${execution.toolCallId}`,
          effectIdempotencyKey: `${run.id}:${execution.name}:${execution.argumentsHash}`,
        });
      } else {
        await effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${execution.name}:${execution.argumentsHash}`);
      }
      startedExternalEffects.add(execution.toolCallId);
    },
    onToolCompleted: async (result) => {
      await toolInvocations.recordCompleted({
        runId: run.id,
        providerToolCallId: result.toolCallId,
        output: result.output,
        latencyMs: result.latencyMs,
        effectId: result.effectId,
      });
      if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${result.name}:${result.argumentsHash}`, result.output);
      const stepId = toolSteps.get(result.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    },
    onToolFailed: async (failure) => {
      if (["TOOL_NOT_FOUND", "TOOL_NOT_GRANTED", "CAPABILITY_NOT_GRANTED", "UNAVAILABLE", "NOT_CONFIGURED"].some((code) => failure.error.code.includes(code))) unavailableTools.add(failure.name);
      await toolInvocations.recordFailed({
        runId: run.id,
        providerToolCallId: failure.toolCallId,
        error: failure.error,
      });
      const failedTool = tools.get(failure.name);
      if (failedTool?.riskClass === "external-effect" && failure.argumentsHash) {
        const effectKey = `${run.id}:${failure.name}:${failure.argumentsHash}`;
        if (startedExternalEffects.has(failure.toolCallId)) {
          await effectReceipts.markUnknownByKey(run.organization_id, effectKey, failure.error);
        } else {
          await effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, failure.error);
        }
      }
      const stepId = toolSteps.get(failure.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: failure.error });
    },
    onModelResponse: async (response) => {
      await modelCalls.recordCompleted({
        organizationId: run.organization_id,
        runId: run.id,
        provider: response.provider,
        model: response.model,
        fundingSource: modelCredentials.fundingSource,
        credentialReference: modelCredentials.credentialReference,
        response,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model } });
      await runSteps.finishStep({ stepId: step.id, status: "completed", output: { totalTokens: response.usage.totalTokens, finishReason: response.finishReason, latencyMs: response.latencyMs } });
    },
    onModelError: async (error) => {
      await modelCalls.recordFailed({
        organizationId: run.organization_id,
        runId: run.id,
        provider,
        model,
        fundingSource: modelCredentials.fundingSource,
        error,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider, model } });
      await runSteps.finishStep({ stepId: step.id, status: "failed", error });
    },
  });
  loopResult.provenance = buildGroundingProvenance({
    authorizedTools: allowedTools,
    usedTools,
    unavailableTools,
    retrievalRequested,
    knowledgeMatchCount: knowledgeMatches.length,
  });
  return loopResult;
}

type ConfiguredWorkflowRun = Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object;

async function executeConfiguredWorkflow(input: {
  run: ConfiguredWorkflowRun;
  graphInput: unknown;
  inputState: Record<string, unknown>;
  context: ReturnType<typeof buildAgentContext>;
  modelProvider: "openrouter" | "openai" | "anthropic" | "gemini";
  model: string;
  modelCredentials: ModelCredentials;
  gateway: ModelGateway;
  tools: ToolRegistry;
  allowedTools: ReadonlySet<string>;
  runRepository: RunRepository;
  modelCalls: ModelCallRepository;
  toolInvocations: ToolInvocationRepository;
  approvals: ApprovalRepository;
  effectReceipts: EffectReceiptRepository;
  runSteps: RunStepRepository;
  installationGrants: InstallationGrantRepository;
  killSwitches: KillSwitchRepository;
  controls: OperatorControlRepository;
  workflowState: WorkflowStateRepository;
  coreClient?: KasitekCoreReadClient;
  resumeApprovedToolCall?: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"];
  resumeExternalEvent?: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeExternalEvent"];
}): Promise<AgentLoopResult> {
  let graph: WorkflowGraph;
  try {
    graph = validateWorkflowGraph(input.graphInput).graph;
  } catch (error) {
    return { status: "failed", messages: [], usage: emptyWorkflowUsage(), iterations: 0, toolCalls: 0, error: { code: "WORKFLOW_INVALID", message: error instanceof Error ? error.message : "Workflow graph is invalid" } };
  }
  const persisted = await input.workflowState.get(input.run.organization_id, input.run.id);
  const persistedState = persisted?.state;
  const workflowStateValue = persistedState?.__workflowState && typeof persistedState.__workflowState === "object" && !Array.isArray(persistedState.__workflowState)
    ? persistedState.__workflowState as Record<string, unknown>
    : input.inputState;
  const pausedNodeId = typeof persistedState?.__workflowNodeId === "string" ? persistedState.__workflowNodeId : undefined;
  const executionGraph = pausedNodeId && graph.nodes.some((node) => node.id === pausedNodeId) ? { ...graph, entryNodeId: pausedNodeId } : graph;
  const toolSequence = { value: 0 };
  const usedTools = new Set<string>();
  let lastModelResponse: ModelResponse | undefined;

  const executeTool = async (request: { name: string; arguments: Record<string, unknown>; nodeId: string; approved?: unknown }): Promise<unknown> => {
    usedTools.add(request.name);
    const manifest = input.tools.get(request.name);
    if (!manifest) throw new Error(`WORKFLOW_TOOL_NOT_FOUND:${request.name}`);
    if (manifest.requiresApproval && !request.approved) throw new Error(`WORKFLOW_APPROVAL_REQUIRED:${request.name}`);
    if (manifest.riskClass === "external-effect" && !request.approved) throw new Error(`WORKFLOW_APPROVAL_REQUIRED:${request.name}`);
    await assertCurrentCapabilityPolicy({
      organizationId: input.run.organization_id,
      installationId: input.run.installation_id,
      name: request.name,
      argumentsValue: request.arguments,
      grantedTools: input.allowedTools,
      tools: input.tools,
      installationGrants: input.installationGrants,
      approved: Boolean(request.approved),
    });
    const argumentsHash = hashToolArguments(request.arguments);
    const providerToolCallId = `workflow:${request.nodeId}`;
    const persistedApproval = manifest.requiresApproval ? await input.approvals.getForRun(input.run.organization_id, input.run.id) : null;
    const resourceSnapshot = request.approved && persistedApproval?.provider_tool_call_id === providerToolCallId
      ? persistedApproval.resource_snapshot
      : await buildApprovalResourceSnapshotFromCore(input.coreClient, {
        organizationId: input.run.organization_id,
        agentId: input.run.agent_definition_id,
        agentVersionId: input.run.agent_version_id,
        installationId: input.run.installation_id,
        runId: input.run.id,
        actorId: input.run.created_by,
        correlationId: input.run.correlation_id,
      }, request.name, request.arguments);
    const step = await input.runSteps.startStep({ runId: input.run.id, organizationId: input.run.organization_id, stepType: "tool", input: { toolCallId: providerToolCallId, name: request.name, argumentsHash } });
    await input.toolInvocations.recordProposal({
      organizationId: input.run.organization_id,
      runId: input.run.id,
      providerToolCallId,
      sequenceNumber: toolSequence.value += 1,
      toolName: request.name,
      toolVersion: manifest.version,
      riskClass: manifest.riskClass,
      argumentsHash,
      arguments: request.arguments,
      requiresApproval: manifest.requiresApproval,
    });
    try {
      if (manifest.requiresApproval && manifest.riskClass !== "external-effect") {
        await input.approvals.consume({
          organizationId: input.run.organization_id,
          installationId: input.run.installation_id,
          runId: input.run.id,
          providerToolCallId,
          capability: request.name,
          capabilityVersion: manifest.version,
          argumentsHash,
          resourceSnapshot,
          previewRevision: argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${input.run.id}:${providerToolCallId}`,
        });
      }
      const result = await input.tools.invoke({
        name: request.name,
        arguments: request.arguments,
        context: {
          organizationId: input.run.organization_id,
          agentId: input.run.agent_definition_id,
          agentVersionId: input.run.agent_version_id,
          installationId: input.run.installation_id,
          runId: input.run.id,
          actorId: input.run.created_by,
          correlationId: input.run.correlation_id,
        },
        grantedTools: input.allowedTools,
        approval: request.approved as Parameters<ToolRegistry["invoke"]>[0]["approval"],
        beforeEffect: manifest.riskClass === "external-effect" ? async () => {
          if (!(await input.controls.isFeatureEnabled(input.run.organization_id, "effect_execution_enabled", input.run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
          if (await input.controls.isHeld({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
          await input.approvals.consumeAndStartEffect({
            organizationId: input.run.organization_id,
            installationId: input.run.installation_id,
            runId: input.run.id,
            providerToolCallId,
            capability: request.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            resourceSnapshot,
            previewRevision: argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${input.run.id}:${providerToolCallId}`,
            effectIdempotencyKey: `${input.run.id}:${request.name}:${argumentsHash}`,
          });
        } : undefined,
      });
      const safeOutput = redactSensitiveValue(result.output);
      await input.toolInvocations.recordCompleted({ runId: input.run.id, providerToolCallId, output: safeOutput, latencyMs: result.latencyMs, effectId: result.effectId });
      await input.runSteps.finishStep({ stepId: step.id, status: "completed", output: { latencyMs: result.latencyMs } });
      if (result.effectId) await input.effectReceipts.markSucceededByKey(input.run.organization_id, `${input.run.id}:${request.name}:${argumentsHash}`, safeOutput);
      return safeOutput;
    } catch (error) {
      const normalized = { code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "WORKFLOW_TOOL_FAILED", message: error instanceof Error ? error.message : "Workflow tool failed" };
      await input.toolInvocations.recordFailed({ runId: input.run.id, providerToolCallId, error: normalized });
      await input.runSteps.finishStep({ stepId: step.id, status: "failed", error: normalized });
      throw error;
    }
  };

  const result = await executeWorkflowGraph(executionGraph, workflowStateValue, {
    model: async ({ nodeId, config, state }) => {
      const instruction = typeof config.instruction === "string" ? config.instruction : "Continue the workflow.";
      const response = await input.gateway.complete({
        provider: input.modelProvider,
        model: input.model,
        messages: [...input.context.messages, { role: "user", content: JSON.stringify({ nodeId, instruction, state }) }],
        maxTokens: typeof config.maxTokens === "number" ? Math.max(1, Math.min(8_000, config.maxTokens)) : 2_000,
        temperature: typeof config.temperature === "number" ? config.temperature : undefined,
      }, input.modelCredentials);
      lastModelResponse = response;
      await input.modelCalls.recordCompleted({ organizationId: input.run.organization_id, runId: input.run.id, provider: response.provider, model: response.model, fundingSource: input.modelCredentials.fundingSource, credentialReference: input.modelCredentials.credentialReference, response });
      const step = await input.runSteps.startStep({ runId: input.run.id, organizationId: input.run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model, nodeId } });
      await input.runSteps.finishStep({ stepId: step.id, status: "completed", output: { totalTokens: response.usage.totalTokens, latencyMs: response.latencyMs } });
      return { output: response.message.content, text: response.message.content };
    },
    tool: executeTool,
    resumeApprovedToolCall: input.resumeApprovedToolCall,
    resumeExternalEvent: input.resumeExternalEvent,
  });

  if (result.status === "awaiting_approval") {
    const pending = result.pendingToolCalls?.[0];
    if (!pending) return { status: "failed", messages: [], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: 0, error: { code: "WORKFLOW_APPROVAL_UNCONFIGURED", message: "Approval node must identify a capability and arguments" } };
    const manifest = input.tools.get(pending.name);
    if (!manifest) return { status: "failed", messages: [], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: 0, error: { code: "WORKFLOW_TOOL_NOT_FOUND", message: `Workflow tool is not registered: ${pending.name}` } };
    await input.toolInvocations.recordProposal({ organizationId: input.run.organization_id, runId: input.run.id, providerToolCallId: pending.id, sequenceNumber: toolSequence.value + 1, toolName: pending.name, toolVersion: manifest.version, riskClass: manifest.riskClass, argumentsHash: pending.argumentsHash, arguments: pending.arguments, requiresApproval: true });
    await input.approvals.createPending({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, providerToolCallId: pending.id, capability: pending.name, capabilityVersion: manifest.version, argumentsHash: pending.argumentsHash, resourceSnapshot: await buildApprovalResourceSnapshotFromCore(input.coreClient, {
      organizationId: input.run.organization_id,
      agentId: input.run.agent_definition_id,
      agentVersionId: input.run.agent_version_id,
      installationId: input.run.installation_id,
      runId: input.run.id,
      actorId: input.run.created_by,
      correlationId: input.run.correlation_id,
    }, pending.name, pending.arguments), previewRevision: pending.argumentsHash, policyRevision: "v1", permittedEffectKey: `${input.run.id}:${pending.id}`, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    if (manifest.riskClass === "external-effect") await input.effectReceipts.reserve({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, providerToolCallId: pending.id, capability: pending.name, capabilityVersion: manifest.version, argumentsHash: pending.argumentsHash, idempotencyKey: `${input.run.id}:${pending.name}:${pending.argumentsHash}` });
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: result.pausedAt, __workflowState: result.state } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.approval.pending", payload: { nodeId: result.pausedAt, capability: pending.name, providerToolCallId: pending.id } });
    return { status: "awaiting_approval", messages: [], pendingToolCalls: [pending], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: toolSequence.value, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "awaiting_external_event") {
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: result.pausedAt, __workflowState: result.state } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.external_event.pending", payload: { nodeId: result.pausedAt, waitingFor: result.waitingFor } });
    return { status: "awaiting_external_event", messages: [], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: toolSequence.value, waitingFor: result.waitingFor, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "awaiting_human") {
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: result.pausedAt, __workflowState: result.state } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.handoff.pending", payload: { nodeId: result.pausedAt, waitingFor: result.waitingFor } });
    return { status: "awaiting_human", messages: [], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: toolSequence.value, waitingFor: result.waitingFor, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "failed") return { status: "failed", messages: [], usage: emptyWorkflowUsage(), iterations: result.trace.length, toolCalls: toolSequence.value, error: { code: "WORKFLOW_FAILED", message: result.error ?? "Workflow execution failed" }, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: null, __workflowState: result.state } });
  const output = typeof result.state.output === "string" ? result.state.output : typeof result.state.answer === "string" ? result.state.answer : lastModelResponse?.message.content ?? "Workflow completed";
  const response = lastModelResponse ?? { provider: input.modelProvider, model: input.model, message: { role: "assistant" as const, content: output }, toolCalls: [], finishReason: "workflow", usage: emptyWorkflowUsage(), latencyMs: 0 };
  return { status: "completed", messages: [response.message], response, usage: { ...response.usage, estimatedCostUsd: response.usage.estimatedCostUsd ?? 0 }, iterations: result.trace.length, toolCalls: toolSequence.value, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
}

function emptyWorkflowUsage(): { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number } {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}
