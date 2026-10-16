import {
  canonicalJsonBody,
  jsonValueAt,
  requireJsonIntegerToken,
} from "../identity/json-body.js";
import { wireInteger } from "@kasitek-labs/server-support/json";
import {
  createWhatsappInboxPorts,
  createInboxDeliveryOptions,
  updateConversation,
  markConversationRead,
} from "../services/whatsapp/inbox.js";
import {
  deliverAgentMessage,
  type AgentMediaAttachment,
} from "../services/whatsapp/inbox-agent.js";
import type { WhatsappReplyButton } from "../services/whatsapp/inbox-provider.js";
import { publishInboxEvent } from "../services/realtime.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { UtcTimestamp } from "../db.js";
import { ApiError, RequestExtractionError } from "../error.js";
import {
  resolveInternalAgentContext,
  requireInternalAgent,
  resolveCreditIdempotencyKey,
  type ReplayGuard,
} from "../identity/internal-delegation.js";
import type { RequestContext } from "../identity/request-context.js";
import type { InboxOptions } from "../services/inbox/types.js";
import {
  bad,
  guardRawPayload,
} from "../services/agent-platform/controller-support.js";
import * as credits from "../services/credits.js";
import * as connectionsService from "../services/connections.js";
import * as coreAdapter from "../capabilities/core-adapter.js";
import * as content from "../capabilities/content-adapter.js";
import * as batch from "../capabilities/content-batch.js";
import * as campaigns from "../services/whatsapp/campaigns.js";
import * as contacts from "../services/whatsapp/contacts.js";
import * as templates from "../services/whatsapp/templates.js";
import * as inbox from "../services/inbox/index.js";
import * as email from "../services/email/index.js";
import * as media from "../services/social/media.js";
import * as website from "../services/website/index.js";
import { parseInsightsFilters } from "../services/social/insights.js";
import { isValidPlatform } from "../services/social/common.js";
import { queryI64, queryU16, queryU64 } from "../typed-query.js";
import type { SocialPostUpsertRequest } from "../services/social/types.js";
import { getCustomerDetail } from "../services/customers.js";
import { requireMember } from "../services/orgs.js";
export interface AgentInternalOptions {
  fetch?: typeof fetch;
  replay?: ReplayGuard;
  inbox: InboxOptions;
  whatsapp: {
    updateConversation(
      userId: string,
      org: string,
      id: string,
      input: Record<string, unknown>,
    ): Promise<unknown>;
    markConversationRead(
      userId: string,
      org: string,
      id: string,
    ): Promise<unknown>;
    deliverAgentMessage(
      org: string,
      id: string,
      text: string,
      key: string,
      media: AgentMediaAttachment[],
      buttons: WhatsappReplyButton[],
    ): Promise<unknown>;
  };
}
/** Bind the private bridge to the same durable product services and event bus. */
export function createAgentInternalOptions(
  core: CoreContext,
  transport: { fetch?: typeof fetch; replay?: ReplayGuard } = {},
): AgentInternalOptions {
  const delivery = createInboxDeliveryOptions(
    core,
    transport.fetch ? { fetch: transport.fetch } : {},
  );
  return {
    ...transport,
    inbox: {
      config: core.config,
      fetch: transport.fetch,
      whatsapp: createWhatsappInboxPorts(core),
      publishEvent: (org, event) => publishInboxEvent(core, org, event),
    },
    whatsapp: {
      updateConversation: (user, org, id, input) =>
        updateConversation(core, user, org, id, input, delivery),
      markConversationRead: (user, org, id) =>
        markConversationRead(core, user, org, id, delivery),
      deliverAgentMessage: (org, id, text, key, media, buttons) =>
        deliverAgentMessage(core, org, id, text, key, media, buttons, delivery),
    },
  };
}
const param = (request: FastifyRequest, key: string) =>
  (request.params as Record<string, string>)[key]!;
const id = (request: FastifyRequest) => param(request, "id");
function missing(message: string): never {
  throw new ApiError(404, "not_found", message);
}
function requiredJson(request: FastifyRequest): unknown {
  if (request.body === undefined) bad("Invalid request");
  return request.body;
}
function objectBody(request: FastifyRequest): Record<string, unknown> {
  const value = requiredJson(request);
  if (!value || typeof value !== "object" || Array.isArray(value))
    bad("Invalid request");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function dateValue(value: unknown): Date | null {
  return typeof value === "string"
    ? new UtcTimestamp(
        value.replace(/[tz]/g, (c) => c.toUpperCase()),
        true,
      )
    : null;
}
type FieldType =
  | "string"
  | "i64"
  | "optionalString"
  | "optionalBoolean"
  | "optionalStrings"
  | "optionalDate"
  | "optionalI64"
  | "optionalNumber";
function typedBody(
  request: FastifyRequest,
  fields: Record<string, FieldType>,
): Record<string, unknown> {
  let body: Record<string, unknown>;
  try {
    body = objectBody(request);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400)
      throw new RequestExtractionError("json");
    throw error;
  }
  for (const [key, type] of Object.entries(fields)) {
    const value = body[key];
    if (type.startsWith("optional") && (value === undefined || value === null))
      continue;
    let valid = false;
    switch (type) {
      case "string":
      case "optionalString":
        valid = typeof value === "string";
        break;
      case "i64":
      case "optionalI64":
        requireJsonIntegerToken(request, [key]);
        valid =
          (typeof value === "bigint" ||
            (typeof value === "number" && Number.isSafeInteger(value))) &&
          BigInt(value) >= -9223372036854775808n &&
          BigInt(value) <= 9223372036854775807n;
        break;
      case "optionalNumber":
        if (typeof value === "bigint") body[key] = Number(value);
        valid =
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "bigint" && Number.isFinite(Number(value)));
        break;
      case "optionalBoolean":
        valid = typeof value === "boolean";
        break;
      case "optionalStrings":
        valid =
          Array.isArray(value) && value.every((v) => typeof v === "string");
        break;
      case "optionalDate":
        valid =
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}[Tt].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value) &&
          !Number.isNaN(Date.parse(value));
        break;
    }
    if (!valid) throw new RequestExtractionError("json");
  }
  if (Object.hasOwn(body, "metadata"))
    body.metadata = jsonValueAt(request, ["metadata"]);
  return body;
}
type InternalQueryNumber = "i64" | "u16" | "u64";
function internalQuery(
  request: FastifyRequest,
  fields: readonly string[],
  numeric: Record<string, InternalQueryNumber> = {},
  aliases: Record<string, string> = {},
): Record<string, unknown> {
  const query = Object.create(null) as Record<string, unknown>,
    accepted = new Set(fields),
    aliasMap = new Map(Object.entries(aliases));
  for (const [sourceKey, value] of new URLSearchParams(
    request.raw.url?.split("?").slice(1).join("?") ?? "",
  )) {
    const key = aliasMap.get(sourceKey) ?? sourceKey;
    if (!accepted.has(key)) continue;
    if (Object.hasOwn(query, key))
      throw new RequestExtractionError("query", `duplicate field \`${key}\``);
    query[key] = value;
    if (numeric[key] === "i64") query[key] = queryI64(value, key);
    else if (numeric[key] === "u16") query[key] = queryU16(value, key);
    else if (numeric[key] === "u64") query[key] = queryU64(value, key);
  }
  return query;
}
function bounded(value: unknown): number {
  if (value === undefined || value === null) return 100;
  const num = Number(value);
  if (num < 1 || num > 200) bad("limit must be between 1 and 200");
  return num;
}
function needKey(context: RequestContext, message: string): string {
  if (context.idempotencyKey === null) bad(message);
  return context.idempotencyKey;
}
function validDisconnect(status: string): void {
  if (!["DISCONNECTED", "REVOKED"].includes(status))
    bad("Agent connection status must be DISCONNECTED or REVOKED");
}
function connectionSummary(row: connectionsService.ExternalConnection) {
  return Object.fromEntries(
    [
      "provider",
      "displayName",
      "handle",
      "status",
      "credentialStatus",
      "healthStatus",
      "webhookStatus",
      "lastCheckedAt",
      "capabilities",
      "permissions",
      "consumers",
    ].map((key) => [key, (row as unknown as Record<string, unknown>)[key]]),
  );
}
function boundCollection(
  payload: Record<string, unknown>,
  key: string,
  limit: number,
) {
  const values = payload[key];
  if (!Array.isArray(values))
    throw new ApiError(
      500,
      "internal_error",
      "Core collection projection is invalid",
    );
  return {
    ...payload,
    [key]: values.slice(0, limit),
    total: values.length,
    hasMore: values.length > limit,
  };
}
function addMediaUrls(payload: Record<string, unknown>, core: CoreContext) {
  const posts = Array.isArray(payload.posts) ? payload.posts : [payload.post];
  for (const post of posts) {
    const items = (post as Record<string, unknown> | null)?.media;
    if (Array.isArray(items))
      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.assetId === "string"
        )
          item.previewUrl = media.publicMediaUrl(core.config, item.assetId);
      }
  }
}
function insightsFilters(query: Record<string, unknown>) {
  const filters = parseInsightsFilters(
    optionalString(query.platform),
    optionalString(query.metrics),
    optionalString(query.publishedFrom ?? query.published_from),
    optionalString(query.publishedTo ?? query.published_to),
  );
  if (filters.platform && !isValidPlatform(filters.platform))
    bad("Invalid social platform");
  return filters;
}
function socialBody(request: FastifyRequest): SocialPostUpsertRequest {
  const body = typedBody(request, {
    title: "optionalString",
    prompt: "optionalString",
    content: "optionalString",
    status: "optionalString",
    scheduledFor: "optionalString",
    primaryChannelId: "optionalString",
  });
  if (
    body.channels != null &&
    (!Array.isArray(body.channels) ||
      body.channels.some((v) => typeof v !== "string"))
  )
    bad("Invalid request");
  if (
    body.channelSelections != null &&
    (typeof body.channelSelections !== "object" ||
      Array.isArray(body.channelSelections) ||
      Object.values(body.channelSelections).some((v) => typeof v !== "string"))
  )
    bad("Invalid request");
  for (const [collection, required] of [
    ["variants", ["platform", "content"]],
    ["media", ["assetId"]],
  ] as const) {
    const values = body[collection];
    if (values != null) {
      if (!Array.isArray(values)) bad("Invalid request");
      for (const value of values) {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          required.some((key) => typeof value[key] !== "string")
        )
          bad("Invalid request");
        if (collection === "variants") {
          if (
            (value.status != null && typeof value.status !== "string") ||
            (value.aiGenerated != null &&
              typeof value.aiGenerated !== "boolean")
          )
            bad("Invalid request");
        } else {
          if (
            (value.altText != null && typeof value.altText !== "string") ||
            (value.sortOrder != null &&
              (!Number.isInteger(value.sortOrder) ||
                value.sortOrder < -2147483648 ||
                value.sortOrder > 2147483647))
          )
            bad("Invalid request");
        }
      }
    }
  }
  return body as SocialPostUpsertRequest;
}
export function registerAgentInternalRoutes(
  app: FastifyInstance,
  core: CoreContext,
  options: AgentInternalOptions = createAgentInternalOptions(core),
): void {
  app.get("/api/internal/agents/v1/customers/:id", async (request, reply) => {
    const { organizationId: org } = await requireInternalAgent(
      request,
      core,
      "kasitek.core.customer_get",
      options.replay,
    );
    const result = await getCustomerDetail(core.pool, org, id(request));
    if (!result) missing("Customer not found");
    return reply.send(result);
  });
  app.get(
    "/api/internal/agents/v1/workspace/status",
    async (request, reply) => {
      const { organizationId: org } = await requireInternalAgent(
        request,
        core,
        "kasitek.core.workspace_status",
        options.replay,
      );
      const rows = (
        await core.pool.query(
          `SELECT provider,status::text AS status,COUNT(*)::bigint AS count FROM "ExternalConnection" WHERE "orgId"=$1 GROUP BY provider,status ORDER BY provider,status`,
          [org],
        )
      ).rows;
      return reply.send({
        organizationId: org,
        connections: rows.map((row) => ({
          ...row,
          count: wireInteger(row.count),
        })),
      });
    },
  );
  app.get("/api/internal/agents/v1/connections", async (request, reply) => {
    const query = internalQuery(
      request,
      ["provider", "status", "limit"],
      { limit: "u16" },
    );
    const { organizationId: org } = await requireInternalAgent(
      request,
      core,
      "kasitek.core.connections_list",
      options.replay,
    );
    const limit = bounded(query.limit);
    const filter = (value: unknown) =>
      typeof value === "string" &&
      value.trim() &&
      value.trim().toLowerCase() !== "all"
        ? value.trim().toLowerCase()
        : null;
    const provider = filter(query.provider),
      status = filter(query.status);
    const connections = (
      await connectionsService.listConnections(core.pool, org)
    )
      .filter(
        (row) =>
          (!provider || row.provider.toLowerCase() === provider) &&
          (!status || row.status.toLowerCase() === status),
      )
      .slice(0, limit)
      .map(connectionSummary);
    return reply.send({ organizationId: org, connections });
  });
  app.patch(
    "/api/internal/agents/v1/connections/status",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.connection_status_update",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, {
        provider: "string",
        displayName: "string",
        status: "string",
        handle: "optionalString",
      });
      const status = String(body.status)
        .trim()
        .replace(/[a-z]/g, (c) => c.toUpperCase());
      validDisconnect(status);
      const connection = await connectionsService.updateStatusByIdentity(
        core.pool,
        org,
        String(body.provider),
        String(body.displayName),
        optionalString(body.handle),
        status,
      );
      return reply.send({ connection: connectionSummary(connection) });
    },
  );
  app.patch(
    "/api/internal/agents/v1/connections/:id/status",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.connection_status_update",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, { status: "string" }),
        status = String(body.status)
          .trim()
          .replace(/[a-z]/g, (c) => c.toUpperCase());
      validDisconnect(status);
      return reply.send({
        connection: connectionSummary(
          await connectionsService.updateStatus(
            core.pool,
            org,
            id(request),
            status,
          ),
        ),
      });
    },
  );
  app.post(
    "/api/internal/agents/v1/email/connections",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.email_connection_upsert",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, {
        userId: "string",
        provider: "string",
        externalAccountId: "string",
        emailAddress: "string",
        displayName: "string",
        accessToken: "string",
        refreshToken: "optionalString",
        expiresAt: "optionalDate",
        scopes: "optionalStrings",
      });
      if (body.scopes === null) bad("Invalid request");
      await requireMember(core.pool, org, String(body.userId));
      const connection = await email.upsertConnectionFromTokens(
        core.pool,
        core.config,
        org,
        String(body.userId),
        String(body.provider),
        String(body.externalAccountId),
        String(body.emailAddress),
        String(body.displayName),
        String(body.accessToken),
        optionalString(body.refreshToken),
        dateValue(body.expiresAt),
        (body.scopes as string[]) ?? [],
        "agent_platform_oauth",
      );
      return reply.send({
        connection: email.publicEmailConnection(connection),
      });
    },
  );
  app.get(
    "/api/internal/agents/v1/email/connections/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.email_connection_read",
          options.replay,
        ),
        org = context.organizationId;
      const connection = await email.getConnectionById(
        core.pool,
        org,
        id(request),
      );
      if (!connection) missing("Email connection not found");
      return reply.send({
        connection: email.publicEmailConnection(connection),
      });
    },
  );
  app.post(
    "/api/internal/agents/v1/email/:operation",
    async (request, reply) => {
      const operation = email.parseEmailOperation(param(request, "operation"));
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.email_" + operation,
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(
        await email.execute(
          core.pool,
          core.config,
          org,
          operation,
          canonicalJsonBody(request),
          options.fetch,
        ),
      );
    },
  );
  app.get(
    "/api/internal/agents/v1/bookings/services",
    async (request, reply) => {
      const query = internalQuery(request, ["limit"], { limit: "u16" });
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.booking_services_list",
          options.replay,
        ),
        org = context.organizationId;
      const values = await coreAdapter.listBookingServices(core.pool, context),
        limit = bounded(query.limit);
      return reply.send({
        services: values.slice(0, limit),
        total: values.length,
        hasMore: values.length > limit,
      });
    },
  );
  app.get("/api/internal/agents/v1/bookings/:id", async (request, reply) => {
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.booking_get",
        options.replay,
      ),
      org = context.organizationId;
    const booking = await coreAdapter.getBooking(
      core.pool,
      context,
      id(request),
    );
    if (!booking) missing("Booking not found");
    return reply.send({ booking });
  });
  app.get("/api/internal/agents/v1/bookings", async (request, reply) => {
    const query = internalQuery(request, ["limit"], { limit: "u16" });
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.bookings_list",
        options.replay,
      ),
      org = context.organizationId;
    const values = await coreAdapter.listBookings(core.pool, context),
      limit = bounded(query.limit);
    return reply.send({
      bookings: values.slice(0, limit),
      total: values.length,
      hasMore: values.length > limit,
    });
  });
  app.get("/api/internal/agents/v1/campaigns", async (request, reply) => {
    const query = internalQuery(request, ["limit"], { limit: "u16" });
    const { organizationId: org } = await requireInternalAgent(
      request,
      core,
      "kasitek.core.campaigns_list",
      options.replay,
    );
    const values = await campaigns.listCampaigns(core.pool, org);
    return reply.send(
      boundCollection(
        values,
        "campaigns",
        bounded(query.limit),
      ),
    );
  });
  app.get("/api/internal/agents/v1/campaigns/:id", async (request, reply) => {
    const { organizationId: org } = await requireInternalAgent(
      request,
      core,
      "kasitek.core.campaign_summary",
      options.replay,
    );
    return reply.send(
      await campaigns.getCampaignSummary(core.pool, org, id(request)),
    );
  });
  app.get("/api/internal/agents/v1/templates", async (request, reply) => {
    const query = internalQuery(
      request,
      ["status", "limit"],
      { limit: "i64" },
    );
    const { organizationId: org } = await requireInternalAgent(
      request,
      core,
      "kasitek.core.templates_list",
      options.replay,
    );
    return reply.send(
      boundCollection(
        await templates.listTemplates(
          core.pool,
          org,
          optionalString(query.status),
        ),
        "templates",
        bounded(query.limit),
      ),
    );
  });
  app.get("/api/internal/agents/v1/contacts", async (request, reply) => {
    const query = internalQuery(
      request,
      ["q", "optIn", "excluded", "tag", "location", "listLabel", "limit", "cursor"],
      { limit: "i64", cursor: "u64" },
    );
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.contacts_list",
        options.replay,
      ),
      org = context.organizationId;
    const limit = bounded(query.limit);
    const result = await contacts.listContacts(core.pool, org, {
      ...query,
      limit,
    });
    const total =
      (result.stats as Record<string, unknown> | null)?.filteredTotal ?? 0;
    result.total = total;
    result.hasMore = BigInt(total as number | bigint) > BigInt(limit);
    return reply.send(result);
  });
  app.patch("/api/internal/agents/v1/contacts/:id", async (request, reply) => {
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.contact_update",
        options.replay,
      ),
      org = context.organizationId;
    const body = typedBody(request, {
      full_name: "optionalString",
      phone: "optionalString",
      location: "optionalString",
      tags: "optionalStrings",
      notes: "optionalString",
      list_label: "optionalString",
      opt_in: "optionalBoolean",
      excluded: "optionalBoolean",
    });
    const key = needKey(
      context,
      "idempotency-key is required for agent contact updates",
    );
    return reply.send(
      await contacts.updateAgentContact(core.pool, org, id(request), body, key),
    );
  });
  app.get(
    "/api/internal/agents/v1/inbox/conversations",
    async (request, reply) => {
      const query = internalQuery(request, ["limit"], { limit: "u16" });
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.inbox_conversations_list",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(
        await inbox.listInboxConversationsBounded(
          core.pool,
          org,
          bounded(query.limit),
          options.inbox,
        ),
      );
    },
  );
  app.get(
    "/api/internal/agents/v1/inbox/conversations/:id/messages",
    async (request, reply) => {
      const query = internalQuery(request, ["limit"], { limit: "u16" });
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.inbox_messages_list",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(
        await inbox.listConversationMessagesBounded(
          core.pool,
          org,
          id(request),
          bounded(query.limit),
          options.inbox,
        ),
      );
    },
  );
  app.patch(
    "/api/internal/agents/v1/inbox/conversations/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.inbox_conversation_update",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, { starred: "optionalBoolean" });
      if (body.starred === undefined || body.starred === null)
        bad("Conversation update requires starred");
      return reply.send(
        await options.whatsapp.updateConversation(
          context.principal.id,
          org,
          id(request),
          body,
        ),
      );
    },
  );
  app.post(
    "/api/internal/agents/v1/inbox/conversations/:id/read",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.inbox_conversation_mark_read",
          options.replay,
        ),
        org = context.organizationId;
      needKey(
        context,
        "idempotency-key is required for marking a conversation read",
      );
      return reply.send(
        await options.whatsapp.markConversationRead(
          context.principal.id,
          org,
          id(request),
        ),
      );
    },
  );
  app.get("/api/internal/agents/v1/content/posts", async (request, reply) => {
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.content_posts_list",
        options.replay,
      ),
      org = context.organizationId;
    const response = { posts: await content.listPosts(core.pool, context) };
    addMediaUrls(response, core);
    return reply.send(response);
  });
  app.get(
    "/api/internal/agents/v1/content/posts/insights",
    async (request, reply) => {
      const query = internalQuery(
        request,
        ["platform", "metrics", "publishedFrom", "publishedTo", "limit"],
        { limit: "i64" },
        { published_from: "publishedFrom", published_to: "publishedTo" },
      );
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_posts_insights_report",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(
        await content.listInsights(
          core.pool,
          context,
          insightsFilters(query),
          Number(query.limit ?? 50),
        ),
      );
    },
  );
  app.post("/api/internal/agents/v1/content/posts", async (request, reply) => {
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.content_post_draft",
        options.replay,
      ),
      org = context.organizationId;
    needKey(context, "idempotency-key is required for content drafts");
    const body = socialBody(request);
    if (
      body.status !== undefined &&
      body.status !== null &&
      body.status !== "DRAFT"
    )
      bad("Agent content drafts must use DRAFT status");
    return reply
      .code(201)
      .send({ post: await content.createDraft(core.pool, context, body) });
  });
  app.get(
    "/api/internal/agents/v1/content/media/:id/metadata",
    async (request, reply) => {
      const { organizationId: org } = await requireInternalAgent(
        request,
        core,
        "kasitek.core.content_media_read",
        options.replay,
      );
      return reply.send({
        asset: await media.getContentMediaAsset(core.pool, org, id(request)),
      });
    },
  );
  app.get(
    "/api/internal/agents/v1/content/media/:id/preview",
    async (request, reply) => {
      const { organizationId: org } = await requireInternalAgent(
        request,
        core,
        "kasitek.core.content_media_read",
        options.replay,
      );
      const [asset, previewUrl] = await media.getContentMediaPreview(
        core.pool,
        core.config,
        org,
        id(request),
      );
      return reply.send({ asset, previewUrl });
    },
  );
  app.get(
    "/api/internal/agents/v1/content/media/:id",
    async (request, reply) => {
      const { organizationId: org } = await requireInternalAgent(
        request,
        core,
        "kasitek.core.content_media_read",
        options.replay,
      );
      const stored = await media.readContentMediaBytes(
        core.pool,
        core.config,
        org,
        id(request),
      );
      reply.type(stored.mime_type);
      if (stored.checksum) reply.header("x-media-checksum", stored.checksum);
      return reply.send(stored.bytes);
    },
  );
  app.delete(
    "/api/internal/agents/v1/content/media/:id",
    async (request, reply) => {
      const { organizationId: org } = await requireInternalAgent(
        request,
        core,
        "kasitek.core.content_media_delete",
        options.replay,
      );
      return reply.send({
        deleted: await media.deleteAudioContentMedia(
          core.pool,
          core.config,
          org,
          id(request),
        ),
      });
    },
  );
  app.get(
    "/api/internal/agents/v1/content/posts/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_get",
          options.replay,
        ),
        org = context.organizationId;
      const post = await content.getPost(core.pool, context, id(request));
      if (!post) missing("Content post not found");
      const response = { post };
      addMediaUrls(response, core);
      return reply.send(response);
    },
  );
  app.get(
    "/api/internal/agents/v1/content/posts/:id/insights",
    async (request, reply) => {
      const query = internalQuery(
        request,
        ["platform", "metrics", "publishedFrom", "publishedTo", "limit"],
        { limit: "i64" },
        { published_from: "publishedFrom", published_to: "publishedTo" },
      );
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_insights",
          options.replay,
        ),
        org = context.organizationId;
      const result = await content.getInsights(
        core.pool,
        context,
        id(request),
        insightsFilters(query),
      );
      if (!result) missing("Content post not found");
      return reply.send(result);
    },
  );
  app.patch(
    "/api/internal/agents/v1/content/posts/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_update",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send({
        post: await content.updateDraft(
          core.pool,
          context,
          id(request),
          socialBody(request),
        ),
      });
    },
  );
  app.post(
    "/api/internal/agents/v1/content/posts/:id/publish",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_publish",
          options.replay,
        ),
        org = context.organizationId;
      needKey(context, "idempotency-key is required for content publishing");
      const body = typedBody(request, { platform: "string" });
      return reply.code(202).send(
        await content.publish(
          core.pool,
          context,
          id(request),
          String(body.platform),
          content.liveContentExecutionPorts(core.config, {
            fetch: options.fetch,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/internal/agents/v1/content/posts/:id/publish-batch/preflight",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_publish_batch_preflight",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(await batch.preflight(core.pool, context, id(request)));
    },
  );
  app.post(
    "/api/internal/agents/v1/content/posts/:id/publish-batch",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_publish_batch",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, { snapshotHash: "optionalString" }),
        hash = optionalString(body.snapshotHash)?.trim() || null;
      if (context.principal.kind === "trusted_internal_service" && !hash)
        bad("snapshotHash is required for an approved batch publish");
      return reply
        .code(202)
        .send(await batch.publishBatch(core.pool, context, id(request), hash));
    },
  );
  app.get(
    "/api/internal/agents/v1/content/publish-batches/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_publish_batch_status",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(await batch.getBatch(core.pool, context, id(request)));
    },
  );
  app.post(
    "/api/internal/agents/v1/content/publish-batches/:id/retry",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_publish_batch_retry",
          options.replay,
        ),
        org = context.organizationId;
      return reply
        .code(202)
        .send(await batch.retryFailedBatch(core.pool, context, id(request)));
    },
  );
  app.post(
    "/api/internal/agents/v1/content/posts/:id/delete-published",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_delete_published",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, { platform: "string" });
      const result = (await content.deletePublishedPost(
        core.pool,
        core.config,
        context,
        id(request),
        String(body.platform),
        content.liveContentExecutionPorts(core.config, {
          fetch: options.fetch,
        }),
      )) as {
        success: boolean;
        providerResults: { status: string; message?: string | null }[];
      };
      if (!result.success) {
        const detail = result.providerResults
          .filter((value) => value.status !== "DELETED")
          .map((value) => value.message)
          .find(
            (message) =>
              message &&
              (message.includes("Meta/Facebook Login") ||
                message.includes("instagram_manage_contents")) &&
              message.trim(),
          );
        throw new ApiError(
          409,
          "conflict",
          "The published post was not deleted from the provider; local content was not changed." +
            (detail ? ` ${detail}` : ""),
        );
      }
      return reply.send(result);
    },
  );
  app.post(
    "/api/internal/agents/v1/content/posts/:id/schedule",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_schedule",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, { scheduledFor: "string" });
      return reply
        .code(202)
        .send(
          await content.schedule(
            core.pool,
            context,
            id(request),
            String(body.scheduledFor),
          ),
        );
    },
  );
  app.post(
    "/api/internal/agents/v1/content/posts/:id/unschedule",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_unschedule",
          options.replay,
        ),
        org = context.organizationId;
      return reply
        .code(202)
        .send(await content.unschedule(core.pool, context, id(request)));
    },
  );
  app.delete(
    "/api/internal/agents/v1/content/posts/:id",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_post_delete",
          options.replay,
        ),
        org = context.organizationId;
      return reply.send(
        await content.deletePost(core.pool, context, id(request)),
      );
    },
  );
  app.post(
    "/api/internal/agents/v1/credits/reservations",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.credits_reserve",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, {
        actionKey: "string",
        estimatedCredits: "i64",
        sourceType: "optionalString",
        sourceId: "optionalString",
        pricingVersion: "optionalString",
        expiresAt: "optionalDate",
        idempotencyKey: "optionalString",
      });
      const key = resolveCreditIdempotencyKey(
        context,
        optionalString(body.idempotencyKey) ?? undefined,
      );
      return reply.send(
        await credits.reserveCredits(
          core.pool,
          org,
          String(body.actionKey),
          body.estimatedCredits as bigint,
          optionalString(body.sourceType),
          optionalString(body.sourceId),
          optionalString(body.pricingVersion),
          dateValue(body.expiresAt),
          key,
        ),
      );
    },
  );
  app.post(
    "/api/internal/agents/v1/credits/reservations/:reservationId/capture",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.credits_settle",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, {
        actualCredits: "i64",
        provider: "optionalString",
        model: "optionalString",
        fundingSource: "optionalString",
        inputTokens: "optionalI64",
        outputTokens: "optionalI64",
        providerCostUsd: "optionalNumber",
        idempotencyKey: "optionalString",
      });
      const key = resolveCreditIdempotencyKey(
        context,
        optionalString(body.idempotencyKey) ?? undefined,
      );
      return reply.send(
        await credits.captureCredits(
          core.pool,
          org,
          param(request, "reservationId").trim(),
          body.actualCredits as bigint,
          {
            provider: optionalString(body.provider),
            model: optionalString(body.model),
            funding_source: optionalString(body.fundingSource),
            input_tokens: (body.inputTokens as bigint | null) ?? null,
            output_tokens: (body.outputTokens as bigint | null) ?? null,
            provider_cost_usd:
              body.providerCostUsd === null ||
              body.providerCostUsd === undefined
                ? null
                : String(body.providerCostUsd),
            metadata: body.metadata,
          },
          key,
        ),
      );
    },
  );
  app.post(
    "/api/internal/agents/v1/credits/reservations/:reservationId/release",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.credits_settle",
          options.replay,
        ),
        org = context.organizationId;
      const body = typedBody(request, {
        reason: "string",
        idempotencyKey: "optionalString",
      });
      const key = resolveCreditIdempotencyKey(
        context,
        optionalString(body.idempotencyKey) ?? undefined,
      );
      return reply.send(
        await credits.releaseCredits(
          core.pool,
          org,
          param(request, "reservationId").trim(),
          String(body.reason),
          key,
        ),
      );
    },
  );
  app.get("/api/internal/agents/v1/credits/usage", async (request, reply) => {
    const query = internalQuery(
      request,
      ["sourceType", "sourceId", "limit"],
      { limit: "i64" },
      { source_type: "sourceType", source_id: "sourceId" },
    );
    const context = await resolveInternalAgentContext(
        request,
        core,
        "kasitek.core.credits_usage_read",
        options.replay,
      ),
      org = context.organizationId;
    const sourceType = optionalString(query.sourceType),
      sourceId = optionalString(query.sourceId);
    if (sourceType === null) bad("sourceType is required");
    if (sourceId === null) bad("sourceId is required");
    const limit = Number(
      BigInt((query.limit as bigint) ?? 100) < 1n
        ? 1n
        : BigInt((query.limit as bigint) ?? 100) > 500n
          ? 500n
          : (query.limit ?? 100),
    );
    const reservations = await credits.getCreditReservationsForSource(
        core.pool,
        org,
        sourceType,
        sourceId,
        limit,
      ),
      usageEvents = await credits.getCreditUsageReconciliationForSource(
        core.pool,
        org,
        sourceType,
        sourceId,
        limit,
      );
    return reply.send({ sourceType, sourceId, reservations, usageEvents });
  });
  app.post(
    "/api/internal/agents/v1/channels/deliver",
    async (request, reply) => {
      const context = await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.channel_deliver",
          options.replay,
        ),
        org = context.organizationId,
        body = typedBody(request, {
          channelType: "string",
          externalConversationId: "string",
          text: "optionalString",
        }),
        key = needKey(
          context,
          "idempotency-key is required for agent channel delivery",
        );
      if (body.text === null) bad("Invalid request");
      const channel = String(body.channelType)
          .trim()
          .replace(/[A-Z]/g, (c) => c.toLowerCase()),
        text = String(body.text ?? "").trim(),
        attachments = body.media === undefined ? [] : body.media,
        buttons = body.buttons === undefined ? [] : body.buttons;
      if (!Array.isArray(attachments) || !Array.isArray(buttons))
        bad("Invalid request");
      for (const attachment of attachments) {
        if (
          !attachment ||
          typeof attachment !== "object" ||
          Array.isArray(attachment) ||
          typeof attachment.assetId !== "string" ||
          typeof attachment.kind !== "string"
        )
          bad("Invalid request");
        for (const key of [
          "mimeType",
          "fileName",
          "altText",
          "caption",
          "disposition",
        ])
          if (attachment[key] != null && typeof attachment[key] !== "string")
            bad("Invalid request");
      }
      for (const button of buttons) {
        if (
          !button ||
          typeof button !== "object" ||
          Array.isArray(button) ||
          typeof button.id !== "string" ||
          typeof button.title !== "string"
        )
          bad("Invalid request");
      }
      if ((!text && !attachments.length) || Buffer.byteLength(text) > 20000)
        bad("Agent reply must include text or media");
      const conversation = String(body.externalConversationId).trim();
      let result: unknown;
      switch (channel) {
        case "whatsapp":
          if (buttons.length && attachments.length)
            bad("WhatsApp replies cannot combine buttons and media");
          result = await options.whatsapp.deliverAgentMessage(
            org,
            conversation,
            text,
            key,
            attachments as AgentMediaAttachment[],
            buttons as WhatsappReplyButton[],
          );
          break;
        case "website": {
          const event = await website.recordAgentWebsiteDelivery(
            core.pool,
            org,
            conversation,
            key,
            text,
            attachments,
            body.ui,
          );
          if (!event) missing("Website Chat session not found");
          result = { providerMessageId: event.id, status: "sent" };
          break;
        }
        case "facebook":
        case "instagram":
          if (buttons.length || attachments.length)
            bad("Facebook and Instagram agent replies support text only");
          result = await inbox.deliverAgentMetaMessage(
            core.pool,
            org,
            conversation,
            text,
            key,
            options.inbox,
          );
          break;
        default:
          bad(`Agent delivery channel is not supported: ${channel}`);
      }
      request.log.info(
        {
          event: "http.request.completed",
          operation: "channel.delivery",
          channel,
          organization_id: org,
          actor_id: context.principal.id,
          media_count: attachments.length,
        },
        "agent channel delivery completed",
      );
      return reply.send(result);
    },
  );
  app.register(async (raw) => {
    const contexts = new WeakMap<FastifyRequest, RequestContext>();
    raw.addHook("onRequest", async (request) => {
      contexts.set(
        request,
        await resolveInternalAgentContext(
          request,
          core,
          "kasitek.core.content_media_upload",
          options.replay,
        ),
      );
    });
    raw.setErrorHandler((error, request, reply) => {
      if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
        return reply.code(400).send({
          error: "Channel media exceeds the allowed size",
          code: "bad_request",
        });
      return app.errorHandler(error, request, reply);
    });
    raw.addHook("preParsing", (request, _reply, payload, done) => {
      const mime = String(request.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim();
      if (
        !mime.startsWith("image/") &&
        !mime.startsWith("video/") &&
        !mime.startsWith("audio/") &&
        mime !== "application/ogg"
      )
        return done(
          new ApiError(
            400,
            "bad_request",
            "An image, video, or audio MIME type is required",
          ),
        );
      const max =
        mime.startsWith("audio/") || mime === "application/ogg"
          ? 25
          : mime.startsWith("image/")
            ? 20
            : 512;
      done(
        null,
        guardRawPayload(
          payload,
          max * 1024 * 1024,
          "Channel media exceeds the allowed size",
        ),
      );
    });
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 512 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    raw.post(
      "/api/internal/agents/v1/content/media",
      { bodyLimit: 512 * 1024 * 1024 },
      async (request, reply) => {
        const context = contexts.get(request)!,
          org = context.organizationId;
        const header = (key: string) =>
          typeof request.headers[key] === "string"
            ? (request.headers[key] as string)
            : null;
        const mime = (header("content-type") ?? "").split(";")[0]!.trim();
        if (
          !mime.startsWith("image/") &&
          !mime.startsWith("video/") &&
          !mime.startsWith("audio/") &&
          mime !== "application/ogg"
        )
          bad("An image, video, or audio MIME type is required");
        let fileName: string | null = null;
        try {
          const value = header("x-media-file-name");
          if (value !== null) fileName = decodeURIComponent(value);
        } catch {}
        const source = header("x-media-source")?.trim() || "agent_channel",
          sourceKey = header("x-media-source-key")?.trim() || null;
        const bytes = (request.body as Buffer | undefined) ?? Buffer.alloc(0),
          max =
            mime.startsWith("audio/") || mime === "application/ogg"
              ? 25 * 1024 * 1024
              : mime.startsWith("image/")
                ? 20 * 1024 * 1024
                : 512 * 1024 * 1024;
        if (bytes.length > max) bad("Channel media exceeds the allowed size");
        if (!bytes.length) bad("Media is required");
        const actor =
          context.userId ??
          context.principal.subjectUserId ??
          header("x-actor-id")?.trim() ??
          null;
        let userId: string | null = null;
        if (actor)
          userId =
            (
              await core.pool.query<{ id: string }>(
                `SELECT candidate.id FROM "User" candidate WHERE candidate.id=$1 AND (EXISTS(SELECT 1 FROM "Organization" org WHERE org.id=$2 AND org."ownerId"=candidate.id) OR EXISTS(SELECT 1 FROM "OrganizationMember" member WHERE member."orgId"=$2 AND member."userId"=candidate.id)) LIMIT 1`,
                [actor, org],
              )
            ).rows[0]?.id ?? null;
        const owner = (
          await core.pool.query<{ ownerId: string }>(
            'SELECT "ownerId" FROM "Organization" WHERE id=$1',
            [org],
          )
        ).rows[0]?.ownerId;
        if (!userId) userId = owner ?? null;
        if (!userId) missing("Organization not found");
        const asset = await media.uploadContentMediaBytes(
          core.pool,
          core.config,
          userId,
          org,
          { fileName, mimeType: mime, bytes, source, sourceKey },
        );
        return reply.code(201).send({ asset });
      },
    );
  });
}
