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

  public async listContentPosts(context: ToolInvocationContext): Promise<CoreContentPosts> {
    return this.getJson<CoreContentPosts>(context, "/api/internal/agents/v1/content/posts", "Content posts");
  }

  public async getContentPost(context: ToolInvocationContext, postId: string): Promise<{ post: CoreContentPost }> {
    return this.getJson<{ post: CoreContentPost }>(context, `/api/internal/agents/v1/content/posts/${encodeURIComponent(postId)}`, "Content post");
  }

  public async createContentDraft(context: ToolInvocationContext, input: CoreContentDraftInput): Promise<{ post: CoreContentPost }> {
    return this.requestJson<{ post: CoreContentPost }>(context, "/api/internal/agents/v1/content/posts", "Content draft", {
      method: "POST",
      body: JSON.stringify({ ...input, status: "DRAFT" }),
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
          ...(this.idempotencyKeyFor(path, context, init.body) ? { "idempotency-key": this.idempotencyKeyFor(path, context, init.body)! } : {}),
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
    if (path.includes("/customers/")) return "kasitek.core.customer_get";
    if (path.includes("workspace/status")) return "kasitek.core.workspace_status";
    if (method === "POST" && path.endsWith("/content/posts")) return "kasitek.core.content_post_draft";
    if (path.endsWith("/content/posts")) return "kasitek.core.content_posts_list";
    if (path.includes("/content/posts/")) return "kasitek.core.content_post_get";
    if (path.includes("channels/deliver")) return "kasitek.core.channel_deliver";
    throw new CoreToolError("CORE_INVALID_REQUEST", "Unknown kasitek-core capability route");
  }

  private idempotencyKeyFor(path: string, context: CoreRequestContext, body?: BodyInit | null): string | undefined {
    const capability = path.endsWith("/content/posts") && body ? "kasitek.core.content_post_draft" : path.includes("channels/deliver") ? "kasitek.core.channel_deliver" : undefined;
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
        idempotencyKey: capability === "kasitek.core.channel_deliver" || capability === "kasitek.core.content_post_draft" ? `${context.runId}:${capability}:${argumentsHash ?? "empty"}` : undefined,
        argumentsHash,
      });
    }
    return this.config.KASITEK_CORE_INTERNAL_TOKEN!.trim();
  }
}
