import type { AppConfig } from "../config";
import type { AgentMediaReference } from "../media/contracts";
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

export interface CoreWorkspaceConnection {
  provider: string;
  displayName: string;
  handle?: string | null;
  status: string;
  credentialStatus: string;
  healthStatus: string;
  webhookStatus: string;
  lastCheckedAt?: string | null;
  capabilities?: unknown;
  consumers?: unknown;
}

export interface CoreWorkspaceConnections {
  organizationId: string;
  connections: CoreWorkspaceConnection[];
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
  total?: number;
  hasMore?: boolean;
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
  total?: number;
  hasMore?: boolean;
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
  media?: unknown[];
  publishJobs?: unknown[];
}

export interface CoreContentPosts {
  posts: CoreContentPost[];
}

export interface CoreContentPostInsightMetric {
  metricKey: string;
  value?: number | null;
  availability: string;
  providerMetricKey?: string | null;
  observedAt: string;
  fetchedAt: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  previousValue?: number | null;
  absoluteChange?: number | null;
  percentageChange?: number | null;
}

export interface CoreContentPostPlatformInsights {
  platform: string;
  publishedAt?: string | null;
  dataStatus: string;
  metrics: CoreContentPostInsightMetric[];
}

export interface CoreContentPostInsights {
  postId: string;
  title?: string | null;
  contentPreview: string;
  publishedAt?: string | null;
  platforms: CoreContentPostPlatformInsights[];
  generatedAt: string;
}

export interface CoreContentPostInsightsReport {
  posts: CoreContentPostInsights[];
  totalPosts: number;
  hasMore: boolean;
  aggregates: Array<{
    platform: string;
    metricKey: string;
    totalValue: number;
    postsWithValue: number;
  }>;
  coverage: Array<{
    platform: string;
    postCount: number;
    syncedPostCount: number;
    reportedMetricCount: number;
    availableMetricCount: number;
  }>;
  generatedAt: string;
}

export interface CorePublishedPostDeletionResult {
  success: boolean;
  localDeleted: boolean;
  providerResults: Array<{
    platform: string;
    externalPostId?: string | null;
    status: string;
    message?: string | null;
  }>;
}

export interface CoreContentMediaAsset {
  id: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO";
  mimeType: string;
  fileName?: string | null;
  byteSize: number;
  checksum?: string | null;
  durationMs?: number | null;
  processingStatus: string;
  scanStatus: string;
}

export interface CoreContentMediaBytes {
  bytes: Buffer;
  mimeType: string;
  checksum?: string | null;
}

export interface CoreContentMediaMetadata {
  asset: CoreContentMediaAsset;
}

export interface CoreContentMediaPreview {
  asset: CoreContentMediaAsset;
  previewUrl: string;
}

export interface CoreContentMediaInput {
  assetId: string;
  sortOrder?: number;
  altText?: string;
  metadata?: Record<string, unknown>;
}

export interface CoreContentDraftInput {
  title?: string;
  prompt?: string;
  content: string;
  channels: string[];
  primaryChannelId?: string;
  channelSelections?: Record<string, string>;
  variants?: Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }>;
  media?: CoreContentMediaInput[];
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
  media?: CoreContentMediaInput[];
  metadata?: Record<string, unknown>;
}

export interface CoreChannelDeliveryResult {
  providerMessageId?: string;
  status: "sent" | "unknown";
}

export interface CoreChannelReplyButton {
  id: string;
  title: string;
}

export interface CoreCreditReservation {
  id: string;
  orgId: string;
  actionKey: string;
  estimatedCredits: number;
  capturedCredits: number;
  releasedCredits: number;
  status: "RESERVED" | "CAPTURED" | "RELEASED" | "EXPIRED";
  expiresAt?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  pricingVersion?: string | null;
}

export interface CoreCreditReservationResult {
  orgId: string;
  reservation: CoreCreditReservation;
  balance: number;
  reservedBalance: number;
  availableBalance: number;
  amount: number;
  idempotent: boolean;
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
      throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core capability boundary is not configured");
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

  public async listWorkspaceConnections(
    context: ToolInvocationContext,
    input: { provider?: string; status?: string; limit?: number } = {},
  ): Promise<CoreWorkspaceConnections> {
    const params = new URLSearchParams();
    if (input.provider) params.set("provider", input.provider);
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.getJson<CoreWorkspaceConnections>(
      context,
      `/api/internal/agents/v1/connections${suffix}`,
      "Workspace connections",
    );
  }

  public async updateWorkspaceConnectionStatus(
    context: ToolInvocationContext,
    selector: { provider: string; displayName: string; handle?: string },
    status: "DISCONNECTED" | "REVOKED",
  ): Promise<{ connection: CoreWorkspaceConnection }> {
    return this.requestJson<{ connection: CoreWorkspaceConnection }>(
      context,
      "/api/internal/agents/v1/connections/status",
      "Workspace connection status",
      {
        method: "PATCH",
        body: JSON.stringify({ ...selector, status }),
      },
    );
  }

  public async getWorkspaceReport(context: ToolInvocationContext): Promise<CoreWorkspaceReport> {
    return this.getJson<CoreWorkspaceReport>(context, "/api/internal/agents/v1/workspace/report", "Workspace report");
  }

  public async listBookingServices(context: ToolInvocationContext, input: { limit?: number } = {}): Promise<CoreBookingServices> {
    const suffix = input.limit ? `?limit=${encodeURIComponent(String(input.limit))}` : "";
    return this.getJson<CoreBookingServices>(context, `/api/internal/agents/v1/bookings/services${suffix}`, "Booking services");
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
    limit?: number,
  ): Promise<CoreTemplates> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (limit !== undefined) params.set("limit", String(limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
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

  public async listContentPostInsights(
    context: ToolInvocationContext,
    options?: {
      platform?: string;
      metrics?: string[];
      publishedFrom?: string;
      publishedTo?: string;
      limit?: number;
    },
  ): Promise<CoreContentPostInsightsReport> {
    const params = new URLSearchParams();
    if (options?.platform?.trim()) params.set("platform", options.platform.trim());
    if (options?.metrics?.length) params.set("metrics", options.metrics.join(","));
    if (options?.publishedFrom?.trim()) params.set("publishedFrom", options.publishedFrom.trim());
    if (options?.publishedTo?.trim()) params.set("publishedTo", options.publishedTo.trim());
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.getJson<CoreContentPostInsightsReport>(
      context,
      `/api/internal/agents/v1/content/posts/insights${suffix}`,
      "Content post insights",
    );
  }

  public async getContentPostInsights(
    context: ToolInvocationContext,
    postId: string,
    options?: { platform?: string; metrics?: string[] },
  ): Promise<CoreContentPostInsights> {
    const params = new URLSearchParams();
    if (options?.platform?.trim()) params.set("platform", options.platform.trim());
    if (options?.metrics?.length) params.set("metrics", options.metrics.join(","));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.getJson<CoreContentPostInsights>(
      context,
      `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}/insights${suffix}`,
      "Content post insights",
    );
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

  public async uploadContentMedia(
    context: CoreRequestContext,
    input: { bytes: Uint8Array; mimeType: string; fileName?: string; source: string; sourceKey: string },
  ): Promise<{ asset: CoreContentMediaAsset }> {
    return this.requestJson<{ asset: CoreContentMediaAsset }>(
      context,
      "/api/internal/agents/v1/content/media",
      "Content media",
      {
        method: "POST",
        body: Buffer.from(input.bytes),
        headers: {
          "content-type": input.mimeType,
          "x-media-source": input.source,
          "x-media-source-key": input.sourceKey,
          ...(input.fileName ? { "x-media-file-name": encodeURIComponent(input.fileName) } : {}),
        },
      },
    );
  }

  public async downloadContentMedia(
    context: CoreRequestContext,
    assetId: string,
  ): Promise<CoreContentMediaBytes> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    const staticToken = this.config.KASITEK_CORE_INTERNAL_TOKEN?.trim();
    if (!baseUrl || (!staticToken && !this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY)) {
      throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core capability boundary is not configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/internal/agents/v1/content/media/${encodeURIComponent(assetId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token(context, "kasitek.core.content_media_read", "1.0.0")}`,
          "x-organization-id": context.organizationId,
          "x-actor-id": context.actorId ?? "kasitek-agent-platform",
          "x-agent-run-id": context.runId,
          "x-correlation-id": context.correlationId,
          accept: "application/octet-stream",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 404) throw new CoreToolError("CORE_NOT_FOUND", "Media asset not found");
        if (response.status === 409) throw new CoreToolError("CORE_NOT_READY", "Media asset is not ready");
        if (response.status === 401 || response.status === 403) throw new CoreToolError("CORE_UNAUTHORIZED", "kasitek-core rejected the agent credential");
        throw new CoreToolError("CORE_REQUEST_FAILED", `kasitek-core returned ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new CoreToolError("CORE_INVALID_RESPONSE", "kasitek-core returned an empty media object");
      const checksumHeader = response.headers.get("x-media-checksum")?.trim().toLowerCase() || null;
      if (checksumHeader && !/^[a-f0-9]{64}$/.test(checksumHeader)) {
        throw new CoreToolError("CORE_INVALID_RESPONSE", "kasitek-core returned an invalid media checksum");
      }
      if (checksumHeader && createHash("sha256").update(bytes).digest("hex") !== checksumHeader) {
        throw new CoreToolError("CORE_INVALID_RESPONSE", "kasitek-core returned media with a mismatched checksum");
      }
      return {
        bytes,
        mimeType: (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase(),
        checksum: checksumHeader,
      };
    } catch (error) {
      if (error instanceof CoreToolError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new CoreToolError("CORE_TIMEOUT", "kasitek-core media read timed out");
      throw new CoreToolError("CORE_REQUEST_FAILED", error instanceof Error ? error.message : "kasitek-core media read failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async getContentMediaMetadata(
    context: CoreRequestContext,
    assetId: string,
  ): Promise<CoreContentMediaMetadata> {
    return this.requestJson<CoreContentMediaMetadata>(
      context,
      `/api/internal/agents/v1/content/media/${encodeURIComponent(assetId)}/metadata`,
      "Content media metadata",
      { method: "GET" },
    );
  }

  public async getContentMediaPreview(
    context: CoreRequestContext,
    assetId: string,
  ): Promise<CoreContentMediaPreview> {
    return this.requestJson<CoreContentMediaPreview>(
      context,
      `/api/internal/agents/v1/content/media/${encodeURIComponent(assetId)}/preview`,
      "Content media preview",
      { method: "GET" },
    );
  }

  public async deleteContentMedia(
    context: CoreRequestContext,
    assetId: string,
  ): Promise<{ deleted: boolean }> {
    return this.requestJson<{ deleted: boolean }>(
      context,
      `/api/internal/agents/v1/content/media/${encodeURIComponent(assetId)}`,
      "Content media deletion",
      { method: "DELETE" },
    );
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

  public async deletePublishedContentPost(
    context: ToolInvocationContext,
    postId: string,
    platform: string,
  ): Promise<CorePublishedPostDeletionResult> {
    return this.requestJson<CorePublishedPostDeletionResult>(
      context,
      `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}/delete-published`,
      "Published content delete",
      { method: "POST", body: JSON.stringify({ platform }) },
    );
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
    media?: AgentMediaReference[];
    buttons?: CoreChannelReplyButton[];
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
          ...(input.media?.length ? { media: input.media } : {}),
          ...(input.buttons?.length ? { buttons: input.buttons } : {}),
        }),
      },
    );
  }

  public async reserveCredits(
    context: ToolInvocationContext,
    input: {
      actionKey: string;
      estimatedCredits: number;
      sourceType?: string;
      sourceId?: string;
      pricingVersion?: string;
      expiresAt?: string;
      idempotencyKey?: string;
    },
  ): Promise<CoreCreditReservationResult> {
    return this.requestJson<CoreCreditReservationResult>(
      context,
      "/api/internal/agents/v1/credits/reservations",
      "Credit reservation",
      { method: "POST", body: JSON.stringify(input) },
      input.idempotencyKey,
    );
  }

  public async captureCredits(
    context: ToolInvocationContext,
    reservationId: string,
    actualCredits: number,
    usage: {
      provider?: string;
      model?: string;
      fundingSource?: "kasitek" | "user";
      inputTokens?: number;
      outputTokens?: number;
      providerCostUsd?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<CoreCreditReservationResult> {
    return this.requestJson<CoreCreditReservationResult>(
      context,
      `/api/internal/agents/v1/credits/reservations/${encodeURIComponent(reservationId)}/capture`,
      "Credit capture",
      { method: "POST", body: JSON.stringify({ actualCredits, ...usage }) },
    );
  }

  public async releaseCredits(
    context: ToolInvocationContext,
    reservationId: string,
    reason: string,
  ): Promise<CoreCreditReservationResult> {
    return this.requestJson<CoreCreditReservationResult>(
      context,
      `/api/internal/agents/v1/credits/reservations/${encodeURIComponent(reservationId)}/release`,
      "Credit release",
      { method: "POST", body: JSON.stringify({ reason }) },
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
    explicitIdempotencyKey?: string,
  ): Promise<T> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    const staticToken = this.config.KASITEK_CORE_INTERNAL_TOKEN?.trim();
    if (!baseUrl || (!staticToken && !this.config.KASITEK_CORE_DELEGATION_PRIVATE_KEY)) throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core capability boundary is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const idempotencyKey = explicitIdempotencyKey ?? this.idempotencyKeyFor(path, init.method, context, init.body);
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token(context, this.capabilityFor(path, init.method), "1.0.0", init.body, idempotencyKey)}`,
          "x-organization-id": context.organizationId,
          "x-actor-id": context.actorId ?? "kasitek-agent-platform",
          "x-agent-run-id": context.runId,
          "x-correlation-id": context.correlationId,
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          accept: "application/json",
          ...(init.body && !new Headers(init.headers).has("content-type") ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new CoreToolError("CORE_UNAUTHORIZED", "kasitek-core rejected the agent credential");
        const body = await response.text().catch(() => "");
        let detail = body.trim();
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
            detail = parsed.error;
          }
        } catch {
          // Keep a bounded plain-text response when Core did not return JSON.
        }
        throw new CoreToolError("CORE_REQUEST_FAILED", `kasitek-core returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
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
    if (method === "PATCH" && routePath.includes("/connections/") && routePath.endsWith("/status")) return "kasitek.core.connection_status_update";
    if (routePath.endsWith("/connections")) return "kasitek.core.connections_list";
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
    if (method === "POST" && routePath.endsWith("/content/media")) return "kasitek.core.content_media_upload";
    if (method === "DELETE" && routePath.includes("/content/media/")) return "kasitek.core.content_media_delete";
    if (routePath.includes("/content/media/")) return "kasitek.core.content_media_read";
    if (routePath.endsWith("/content/posts")) return "kasitek.core.content_posts_list";
    if (routePath.endsWith("/content/posts/insights")) return "kasitek.core.content_posts_insights_report";
    if (routePath.endsWith("/insights") && routePath.includes("/content/posts/")) return "kasitek.core.content_post_insights";
    if (method === "PATCH" && routePath.includes("/content/posts/")) return "kasitek.core.content_post_update";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/publish")) return "kasitek.core.content_post_publish";
    if (method === "POST" && routePath.includes("/content/posts/") && routePath.endsWith("/delete-published")) return "kasitek.core.content_post_delete_published";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/schedule")) return "kasitek.core.content_post_schedule";
    if (routePath.includes("/content/posts/") && routePath.endsWith("/unschedule")) return "kasitek.core.content_post_unschedule";
    if (method === "DELETE" && routePath.includes("/content/posts/")) return "kasitek.core.content_post_delete";
    if (routePath.includes("/content/posts/")) return "kasitek.core.content_post_get";
    if (routePath.includes("channels/deliver")) return "kasitek.core.channel_deliver";
    if (routePath.endsWith("/credits/reservations")) return "kasitek.core.credits_reserve";
    if (routePath.includes("/credits/reservations/") && (routePath.endsWith("/capture") || routePath.endsWith("/release"))) return "kasitek.core.credits_settle";
    throw new CoreToolError("CORE_INVALID_REQUEST", "Unknown kasitek-core capability route");
  }

  private idempotencyKeyFor(path: string, method: string | undefined, context: CoreRequestContext, body?: BodyInit | null): string | undefined {
    const capability = path.endsWith("/content/posts") && body ? "kasitek.core.content_post_draft" : path.includes("/content/posts/") && path.endsWith("/publish") ? "kasitek.core.content_post_publish" : method === "POST" && path.includes("/content/posts/") && path.endsWith("/delete-published") ? "kasitek.core.content_post_delete_published" : path.includes("/content/posts/") && path.endsWith("/schedule") ? "kasitek.core.content_post_schedule" : path.includes("/content/posts/") && path.endsWith("/unschedule") ? "kasitek.core.content_post_unschedule" : method === "DELETE" && path.includes("/content/posts/") ? "kasitek.core.content_post_delete" : method === "DELETE" && path.includes("/content/media/") ? "kasitek.core.content_media_delete" : method === "PATCH" && path.includes("/connections/") && path.endsWith("/status") ? "kasitek.core.connection_status_update" : method === "PATCH" && path.includes("/contacts/") ? "kasitek.core.contact_update" : method === "POST" && path.includes("/inbox/conversations/") && path.endsWith("/read") ? "kasitek.core.inbox_conversation_mark_read" : method === "PATCH" && path.includes("/inbox/conversations/") ? "kasitek.core.inbox_conversation_update" : path.includes("channels/deliver") ? "kasitek.core.channel_deliver" : path.endsWith("/credits/reservations") ? "kasitek.core.credits_reserve" : path.includes("/credits/reservations/") && (path.endsWith("/capture") || path.endsWith("/release")) ? "kasitek.core.credits_settle" : undefined;
    if (!capability) return undefined;
    const bodyText = typeof body === "string" ? body : "";
    return `${context.runId}:${capability}:${createHash("sha256").update(bodyText).digest("hex")}`;
  }

  private token(context: CoreRequestContext, capability: string, version: string, body?: BodyInit | null, explicitIdempotencyKey?: string): string {
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
        idempotencyKey: explicitIdempotencyKey ?? (capability === "kasitek.core.channel_deliver" || capability === "kasitek.core.credits_reserve" || capability === "kasitek.core.credits_settle" || capability === "kasitek.core.content_post_draft" || capability === "kasitek.core.content_post_publish" || capability === "kasitek.core.content_post_delete_published" || capability === "kasitek.core.content_post_schedule" || capability === "kasitek.core.content_post_unschedule" || capability === "kasitek.core.content_post_delete" || capability === "kasitek.core.content_media_delete" || capability === "kasitek.core.connection_status_update" ? `${context.runId}:${capability}:${argumentsHash ?? "empty"}` : undefined),
        argumentsHash,
      });
    }
    return this.config.KASITEK_CORE_INTERNAL_TOKEN!.trim();
  }
}
