import type { AppConfig } from "../config";
import type { ToolInvocationContext } from "../tools/types";
import { issueCoreDelegation } from "./delegation";
import { createHash } from "node:crypto";

export interface CoreCustomerDetail {
  customer: {
    id: string;
    displayName?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  };
  identities: unknown[];
  contacts: unknown[];
  conversations: unknown[];
  bookings: unknown[];
  agentEvents: unknown[];
}

export interface CoreWorkspaceStatus {
  organizationId: string;
  connections: Array<{ provider: string; status: string; count: number }>;
}

export interface CoreWorkspaceReport {
  organizationId: string;
  connections: { total: number; byStatus: Array<{ status: string; count: number }> };
  content: { postCount: number };
  contacts: { total: number; optedIn: number; excluded: number };
  inbox: { conversationCount: number; unreadConversationCount: number };
  bookings: { total: number; byStatus: Array<{ status: string; count: number }> };
  campaigns: { total: number; byStatus: Array<{ status: string; count: number }> };
  templates: { total: number; byStatus: Array<{ status: string; count: number }> };
}

export interface CoreBookingService {
  id: string;
  orgId?: string;
  name: string;
  description?: string | null;
  durationMinutes: number;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CoreBookingServices {
  services: CoreBookingService[];
}

export interface CoreBookings {
  bookings: CoreBooking[];
  total?: number;
  hasMore?: boolean;
}

export interface CoreBooking {
  id: string;
  serviceId?: string;
  serviceName?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  timezone?: string | null;
  status?: string | null;
}

export interface CoreCampaigns {
  campaigns: unknown[];
  total?: number;
  hasMore?: boolean;
}

export interface CoreCampaignSummary {
  campaign: Record<string, unknown>;
}

export interface CoreTemplates {
  templates: unknown[];
}

export interface CoreContacts {
  contacts: unknown[];
  total?: number;
  hasMore?: boolean;
  totalContacts?: number;
  optedInContacts?: number;
  excludedContacts?: number;
  lists?: unknown[];
  tags?: unknown[];
}

export interface CoreContactUpdateInput {
  fullName?: string;
  phone?: string;
  location?: string;
  tags?: string[];
  notes?: string;
  listLabel?: string;
  metadata?: Record<string, unknown>;
  optIn?: boolean;
  excluded?: boolean;
}

export interface CoreInboxConversations {
  conversations: unknown[];
  total?: number;
  hasMore?: boolean;
}

export interface CoreInboxMessages {
  messages: unknown[];
  capabilities?: Record<string, unknown>;
  total?: number;
  hasMore?: boolean;
}

export interface CoreInboxConversationUpdateInput {
  starred: boolean;
}

export interface CoreContentPost {
  id: string;
  title?: string | null;
  content: string;
  channels: string[];
  status: string;
  scheduled_for?: string | null;
  published_at?: string | null;
  metadata?: Record<string, unknown> | null;
  variants?: unknown[];
  publishJobs?: unknown[];
}

export interface CoreContentPosts {
  posts: CoreContentPost[];
}

export interface CoreContentDraftInput {
  title?: string;
  prompt?: string;
  content: string;
  channels: string[];
  primaryChannelId?: string;
  channelSelections?: Record<string, string>;
  variants?: Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

export interface CoreContentUpdateInput {
  title?: string;
  prompt?: string;
  content?: string;
  channels?: string[];
  primaryChannelId?: string;
  channelSelections?: Record<string, string>;
  variants?: Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

export interface CoreChannelDeliveryResult {
  providerMessageId?: string;
  status: "sent" | "unknown";
}

type CoreRequestContext = Pick<ToolInvocationContext, "organizationId" | "actorId" | "installationId" | "runId" | "correlationId">;

export class CoreToolError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CoreToolError";
  }
}

/**
 * Narrow, authenticated client for read-only kasitek-core operations.
 * The core service remains the authority for tenant data and enforces the
 * organization scope from the request headers; this service never connects
 * to the core database directly.
 */
export class KasitekCoreReadClient {
  public constructor(private readonly config: AppConfig) {}

  public async getCustomer(
    context: CoreRequestContext,
    customerId: string,
  ): Promise<CoreCustomerDetail> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    const staticToken = this.config.KASITEK_CORE_INTERNAL_TOKEN?.trim();
    if (!baseUrl || (!staticToken && !this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY)) {
      throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core read boundary is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/internal/agents/v1/customers/${encodeURIComponent(customerId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token(context, "kasitek.core.customer_get", "1.0.0")}`,
          "x-organization-id": context.organizationId,
          "x-actor-id": context.actorId ?? "kasitek-agent-platform",
          "x-agent-run-id": context.runId,
          "x-correlation-id": context.correlationId,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 404) throw new CoreToolError("CORE_NOT_FOUND", "Customer not found");
        if (response.status === 401 || response.status === 403) throw new CoreToolError("CORE_UNAUTHORIZED", "kasitek-core rejected the agent credential");
        throw new CoreToolError("CORE_REQUEST_FAILED", `kasitek-core returned ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("customer" in payload)) {
        throw new CoreToolError("CORE_INVALID_RESPONSE", "kasitek-core returned an invalid customer response");
      }
      return payload as CoreCustomerDetail;
    } catch (error) {
      if (error instanceof CoreToolError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CoreToolError("CORE_TIMEOUT", "kasitek-core read timed out");
      }
      throw new CoreToolError("CORE_REQUEST_FAILED", error instanceof Error ? error.message : "kasitek-core request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async getWorkspaceStatus(context: ToolInvocationContext): Promise<CoreWorkspaceStatus> {
    return this.getJson<CoreWorkspaceStatus>(context, "/api/internal/agents/v1/workspace/status", "Workspace status");
  }

  public async getWorkspaceReport(context: ToolInvocationContext): Promise<CoreWorkspaceReport> {
    return this.getJson<CoreWorkspaceReport>(context, "/api/internal/agents/v1/workspace/report", "Workspace report");
  }

  public async listBookingServices(context: ToolInvocationContext): Promise<CoreBookingServices> {
    return this.getJson<CoreBookingServices>(context, "/api/internal/agents/v1/bookings/services", "Booking services");
  }

  public async listBookings(context: ToolInvocationContext, input: { limit?: number } = {}): Promise<CoreBookings> {
    const suffix = input.limit ? `?limit=${encodeURIComponent(String(input.limit))}` : "";
    return this.getJson<CoreBookings>(context, `/api/internal/agents/v1/bookings${suffix}`, "Bookings");
  }

  public async getBooking(context: ToolInvocationContext, bookingId: string): Promise<{ booking: CoreBooking }> {
    return this.getJson<{ booking: CoreBooking }>(context, `/api/internal/agents/v1/bookings/${encodeURIComponent(bookingId)}`, "Booking");
  }

  public async listCampaigns(context: ToolInvocationContext, input: { limit?: number } = {}): Promise<CoreCampaigns> {
    const suffix = input.limit ? `?limit=${encodeURIComponent(String(input.limit))}` : "";
    return this.getJson<CoreCampaigns>(context, `/api/internal/agents/v1/campaigns${suffix}`, "Campaigns");
  }

  public async getCampaignSummary(
    context: ToolInvocationContext,
    campaignId: string,
  ): Promise<CoreCampaignSummary> {
    return this.getJson<CoreCampaignSummary>(
      context,
      `/api/internal/agents/v1/campaigns/${encodeURIComponent(campaignId)}`,
      "Campaign summary",
    );
  }

  public async listTemplates(
    context: ToolInvocationContext,
    status?: "APPROVED" | "PENDING" | "REJECTED" | "DISABLED",
  ): Promise<CoreTemplates> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.getJson<CoreTemplates>(
      context,
      `/api/internal/agents/v1/templates${suffix}`,
      "Templates",
    );
  }

  public async listContacts(
    context: ToolInvocationContext,
    input: {
      q?: string;
      optIn?: "all" | "true" | "false";
      excluded?: "all" | "true" | "false";
      tag?: string;
      location?: string;
      listLabel?: string;
      limit?: number;
    } = {},
  ): Promise<CoreContacts> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.getJson<CoreContacts>(context, `/api/internal/agents/v1/contacts${suffix}`, "Contacts");
  }

  public async updateContact(
    context: ToolInvocationContext,
    contactId: string,
    input: CoreContactUpdateInput,
  ): Promise<{ contact: unknown }> {
    return this.requestJson<{ contact: unknown }>(
      context,
      `/api/internal/agents/v1/contacts/${encodeURIComponent(contactId)}`,
      "Contact update",
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.listLabel !== undefined ? { listLabel: input.listLabel } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.optIn !== undefined ? { optIn: input.optIn } : {}),
          ...(input.excluded !== undefined ? { excluded: input.excluded } : {}),
        }),
      },
    );
  }

  public async listInboxConversations(context: ToolInvocationContext, input: { limit?: number } = {}): Promise<CoreInboxConversations> {
    const suffix = input.limit ? `?limit=${encodeURIComponent(String(input.limit))}` : "";
    return this.getJson<CoreInboxConversations>(
      context,
      `/api/internal/agents/v1/inbox/conversations${suffix}`,
      "Inbox conversations",
    );
  }

  public async listInboxMessages(
    context: ToolInvocationContext,
    conversationId: string,
    input: { limit?: number } = {},
  ): Promise<CoreInboxMessages> {
    const suffix = input.limit ? `?limit=${encodeURIComponent(String(input.limit))}` : "";
    return this.getJson<CoreInboxMessages>(
      context,
      `/api/internal/agents/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
      "Inbox messages",
    );
  }

  public async updateInboxConversation(
    context: ToolInvocationContext,
    conversationId: string,
    input: CoreInboxConversationUpdateInput,
  ): Promise<{ success: boolean; conversationId: string; starred: boolean }> {
    return this.requestJson<{ success: boolean; conversationId: string; starred: boolean }>(
      context,
      `/api/internal/agents/v1/inbox/conversations/${encodeURIComponent(conversationId)}`,
      "Inbox conversation update",
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  public async markInboxConversationRead(
    context: ToolInvocationContext,
    conversationId: string,
  ): Promise<{ success: boolean }> {
    return this.requestJson<{ success: boolean }>(
      context,
      `/api/internal/agents/v1/inbox/conversations/${encodeURIComponent(conversationId)}/read`,
      "Mark inbox conversation read",
      { method: "POST" },
    );
  }

  public async listContentPosts(context: ToolInvocationContext): Promise<CoreContentPosts> {
    return this.getJson<CoreContentPosts>(context, "/api/internal/agents/v1/content/posts", "Content posts");
  }

  public async getContentPost(context: ToolInvocationContext, postId: string): Promise<{ post: CoreContentPost }> {
    return this.getJson<{ post: CoreContentPost }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}`, "Content post");
  }

  public async updateContentDraft(context: ToolInvocationContext, postId: string, input: CoreContentUpdateInput): Promise<{ post: CoreContentPost }> {
    return this.requestJson<{ post: CoreContentPost }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}`, "Content draft update", {
      method: "PATCH",
      body: JSON.stringify({ ...input, status: "DRAFT" }),
    });
  }

  public async createContentDraft(context: ToolInvocationContext, input: CoreContentDraftInput): Promise<{ post: CoreContentPost }> {
    return this.requestJson<{ post: CoreContentPost }>(context, "/api/internal/agents/v1/content/posts", "Content draft", {
      method: "POST",
      body: JSON.stringify({ ...input, status: "DRAFT" }),
    });
  }

  public async publishContentPost(context: ToolInvocationContext, postId: string, platform: string): Promise<{ post: CoreContentPost; result: unknown }> {
    return this.requestJson<{ post: CoreContentPost; result: unknown }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}/publish`, "Content publish", {
      method: "POST",
      body: JSON.stringify({ platform }),
    });
  }

  public async scheduleContentPost(context: ToolInvocationContext, postId: string, scheduledFor: string): Promise<{ post: CoreContentPost; status: string }> {
    return this.requestJson<{ post: CoreContentPost; status: string }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}/schedule`, "Content schedule", {
      method: "POST",
      body: JSON.stringify({ scheduledFor }),
    });
  }

  public async unscheduleContentPost(context: ToolInvocationContext, postId: string): Promise<{ post: CoreContentPost; status: string }> {
    return this.requestJson<{ post: CoreContentPost; status: string }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}/unschedule`, "Content unschedule", {
      method: "POST",
    });
  }

  public async deleteContentPost(context: ToolInvocationContext, postId: string): Promise<{ postId: string; deleted: boolean }> {
    return this.requestJson<{ postId: string; deleted: boolean }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}`, "Content delete", {
      method: "DELETE",
    });
  }

  public async deliverChannelMessage(input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    runId: string;
    correlationId: string;
    channelType: string;
    externalConversationId: string;
    text: string;
  }): Promise<CoreChannelDeliveryResult> {
    return this.requestJson<CoreChannelDeliveryResult>(
      {
        organizationId: input.organizationId,
        installationId: input.installationId,
        actorId: input.actorId,
        runId: input.runId,
        correlationId: input.correlationId,
      },
      "/api/internal/agents/v1/channels/deliver",
      "Channel delivery",
      {
        method: "POST",
        body: JSON.stringify({
          channelType: input.channelType,
          externalConversationId: input.externalConversationId,
          text: input.text,
        }),
      },
    );
  }

  private async getJson<T>(context: ToolInvocationContext, path: string, label: string): Promise<T> {
    return this.requestJson<T>(context, path, label, { method: "GET" });
  }

  private async requestJson<T>(
    context: CoreRequestContext,
    path: string,
    label: string,
    init: RequestInit,
  ): Promise<T> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    const staticToken = this.config.KASITEK_CORE_INTERNAL_TOKEN?.trim();
    if (!baseUrl || (!staticToken && !this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY)) throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core read boundary is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token(context, this.capabilityFor(path, init.method), "1.0.0", init.body)}`,
          "x-organization-id": context.organizationId,
          "x-actor-id": context.actorId ?? "kasitek-agent-platform",
          "x-agent-run-id": context.runId,
          "x-correlation-id": context.correlationId,
          ...(this.idempotencyKeyFor(path, init.method, context, init.body) ? { "idempotency-key": this.idempotencyKeyFor(path, init.method, context, init.body)! } : {}),
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new CoreToolError("CORE_UNAUTHORIZED", "kasitek-core rejected the agent credential");
        throw new CoreToolError("CORE_REQUEST_FAILED", `kasitek-core returned ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") throw new CoreToolError("CORE_INVALID_RESPONSE", `kasitek-core returned invalid ${label.toLowerCase()} data`);
      return payload as T;
    } catch (error) {
      if (error instanceof CoreToolError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new CoreToolError("CORE_TIMEOUT", "kasitek-core read timed out");
      throw new CoreToolError("CORE_REQUEST_FAILED", error instanceof Error ? error.message : "kasitek-core request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private capabilityFor(path: string, method?: string): string {
    const routePath = path.split("?", 1)[0] ?? path;
    if (routePath.includes("/customers/")) return "kasitek.core.customer_get";
    if (routePath.includes("workspace/report")) return "kasitek.core.workspace_report";
    if (routePath.includes("workspace/status")) return "kasitek.core.workspace_status";
    if (routePath.includes("bookings/services")) return "kasitek.core.booking_services_list";
    if (routePath.includes("/bookings/") && !routePath.endsWith("/bookings/services")) return "kasitek.core.booking_get";
    if (routePath.endsWith("/bookings")) return "kasitek.core.bookings_list";
    if (routePath.includes("/campaigns/")) return "kasitek.core.campaign_summary";
    if (routePath.endsWith("/campaigns")) return "kasitek.core.campaigns_list";
    if (routePath.startsWith("/api/internal/agents/v1/templates")) return "kasitek.core.templates_list";
    if (method === "PATCH" && routePath.includes("/contacts/")) return "kasitek.core.contact_update";
    if (method === "POST" && routePath.includes("/inbox/conversations/") && routePath.endsWith("/read")) return "kasitek.core.inbox_conversation_mark_read";
    if (method === "PATCH" && routePath.includes("/inbox/conversations/")) return "kasitek.core.inbox_conversation_update";
    if (routePath.includes("/inbox/conversations/") && routePath.endsWith("/messages")) return "kasitek.core.inbox_messages_list";
    if (routePath.includes("/inbox/conversations")) return "kasitek.core.inbox_conversations_list";
    if (routePath.includes("/contacts")) return "kasitek.core.contacts_list";
    if (method === "POST" && routePath.endsWith("/content/posts")) return "kasitek.core.content_post_draft";
    if (routePath.endsWith("/content/posts")) return "kasitek.core.content_posts_list";
    if (method === "PATCH" && routePath.includes("/content/posts/")) return "kasitek.core.content_post_update";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/publish")) return "kasitek.core.content_post_publish";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/schedule")) return "kasitek.core.content_post_schedule";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/unschedule")) return "kasitek.core.content_post_unschedule";
    if (method === "DELETE" && routePath.includes("/content/posts/")) return "kasitek.core.content_post_delete";
    if (routePath.includes("/content/posts/")) return "kasitek.core.content_post_get";
    if (routePath.includes("channels/deliver")) return "kasitek.core.channel_deliver";
    throw new CoreToolError("CORE_INVALID_REQUEST", "Unknown kasitek-core capability route");
  }

  private idempotencyKeyFor(path: string, method: string | undefined, context: CoreRequestContext, body?: BodyInit | null): string | undefined {
    const capability = path.endsWith("/content/posts") && body ? "kasitek.core.content_post_draft" : path.includes("/content/posts/") && path.endsWith("/publish") ? "kasitek.core.content_post_publish" : path.includes("/content/posts/") && path.endsWith("/schedule") ? "kasitek.core.content_post_schedule" : path.includes("/content/posts/") && path.endsWith("/unschedule") ? "kasitek.core.content_post_unschedule" : method === "DELETE" && path.includes("/content/posts/") ? "kasitek.core.content_post_delete" : method === "PATCH" && path.includes("/contacts/") ? "kasitek.core.contact_update" : method === "POST" && path.includes("/inbox/conversations/") && path.endsWith("/read") ? "kasitek.core.inbox_conversation_mark_read" : method === "PATCH" && path.includes("/inbox/conversations/") ? "kasitek.core.inbox_conversation_update" : path.includes("channels/deliver") ? "kasitek.core.channel_deliver" : undefined;
    if (!capability) return undefined;
    const bodyText = typeof body === "string" ? body : "";
    return `${context.runId}:${capability}:${createHash("sha256").update(bodyText).digest("hex")}`;
  }

  private token(context: CoreRequestContext, capability: string, version: string, body?: BodyInit | null): string {
    if (this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY) {
      const bodyText = typeof body === "string" ? body : "";
      const argumentsHash = bodyText
        ? createHash("sha256").update(bodyText).digest("hex")
        : undefined;
      return issueCoreDelegation({
        privateKeyPem: this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY,
        keyId: this.config.KASITEK_CORE_DELEGATION_KEY_ID,
        issuer: this.config.KASITEK_CORE_DELEGATION_ISSUER,
        subject: context.installationId,
        organizationId: context.organizationId,
        installationId: context.installationId,
        actorId: context.actorId,
        capability,
        capabilityVersion: version,
        runId: context.runId,
        invocationId: `${context.runId}:${capability}`,
        correlationId: context.correlationId,
        audience: this.config.KASITEK_CORE_DELEGATION_AUDIENCE,
      idempotencyKey: capability === "kasitek.core.channel_deliver" || capability === "kasitek.core.content_post_draft" || capability === "kasitek.core.content_post_publish" || capability === "kasitek.core.content_post_schedule" || capability === "kasitek.core.content_post_unschedule" || capability === "kasitek.core.content_post_delete" ? `${context.runId}:${capability}:${argumentsHash ?? "empty"}` : undefined,
        argumentsHash,
      });
    }
    return this.config.KASITEK_CORE_INTERNAL_TOKEN!.trim();
  }
}
