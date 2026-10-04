import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { createId } from "@paralleldrive/cuid2";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import {
  resolvePublicCredentialContext,
  requirePublicAction,
  requireWebhookScope,
} from "../identity/request-context.js";
import type { RequestContext } from "../identity/request-context.js";
import {
  publicApiPolicy,
  SUPPORTED_PUBLIC_API_PRINCIPALS,
  UNSUPPORTED_PUBLIC_API_PRINCIPALS,
} from "../identity/principal.js";
import * as api from "../services/public-api.js";
import * as webhooks from "../services/public-webhooks.js";
import { queryI64, queryU64, typedQuery } from "../typed-query.js";
type Row = Record<string, unknown>;
type Page = {
  cursor?: bigint | number;
  limit?: bigint | number;
  version?: string;
};
const bad = (message: string): never => {
  throw new ApiError(400, "bad_request", message);
};
export function pageWindow(
  query: Page,
  total: number,
): { cursor: number; limit: number; nextCursor: number | null } {
  if (query.version !== undefined && query.version !== "v1")
    bad("unsupported public API version");
  const cursor = BigInt(query.cursor ?? 0),
    limit = BigInt(query.limit ?? 50);
  if (cursor < 0n || cursor > BigInt(total))
    bad("pagination cursor is past the end of the result");
  if (limit < 1n || limit > 100n)
    bad("pagination limit must be between 1 and 100");
  const start = Number(cursor), size = Number(limit), next = cursor + limit;
  return {
    cursor: start,
    limit: size,
    nextCursor: next < BigInt(total) ? Number(next) : null,
  };
}
export function paginateCollection(
  payload: Row,
  key: string,
  query: Page,
): Row {
  const values = payload[key];
  if (!Array.isArray(values))
    throw new ApiError(
      500,
      "internal_error",
      `Public API response is missing the ${key} collection`,
    );
  const window = pageWindow(query, values.length);
  return {
    ...payload,
    [key]: values.slice(window.cursor, window.cursor + window.limit),
    pagination: { ...window, total: values.length, version: "v1" },
  };
}
export function redactKeys(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redactKeys(item, keys));
  if (
    value &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !(value instanceof SerdeFloat)
  )
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !keys.includes(key))
        .map(([key, child]) => [key, redactKeys(child, keys)]),
    );
  return value;
}
function page(request: FastifyRequest): Page {
  const query = typedQuery<{
    cursor?: string;
    limit?: string;
    version?: string;
  }>(request.query, ["cursor", "limit", "version"]);
  return {
    cursor: queryU64(query.cursor, "cursor"),
    limit: queryU64(query.limit, "limit"),
    version: query.version,
  };
}
function templatePage(request: FastifyRequest): Page {
  const query = typedQuery<{
    status?: string;
    cursor?: string;
    limit?: string;
    version?: string;
  }>(request.query, ["status", "cursor", "limit", "version"]);
  return {
    cursor: queryU64(query.cursor, "cursor"),
    limit: queryU64(query.limit, "limit"),
    version: query.version,
  };
}
function body(request: FastifyRequest): Row {
  if (
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body)
  )
    bad("Invalid request");
  return request.body as Row;
}
const id = (request: FastifyRequest): string =>
  (request.params as { id: string }).id;
export function registerPublicV1Routes(
  app: FastifyInstance,
  core: CoreContext,
  domains: api.PublicDomainAdapter,
): void {
  const states = new WeakMap<
      FastifyRequest,
      {
        correlation: string;
        context?: RequestContext;
        audit?: api.RequestAuditHandle;
      }
    >(),
    load = (context: RequestContext) =>
      api.loadInstallationCapabilities(core.config, context);
  app.register(
    async (routes) => {
      routes.addHook("onRequest", async (request) => {
        const header = request.headers["x-correlation-id"],
          correlation =
            typeof header === "string" &&
            header.trim() &&
            Buffer.byteLength(header.trim()) <= 256
              ? header.trim()
              : createId();
        states.set(request, { correlation });
      });
      routes.addHook("onSend", async (request, reply, payload) => {
        const state = states.get(request)!,
          path = request.url.split("?")[0]!;
        if (state.audit) {
          try {
            await api.finishRequest(core.pool, state.audit, reply.statusCode);
          } catch (error) {
            request.log.warn({
              event: "operation.failed",
              operation: "public_api.audit.finalize",
              error_type: error instanceof Error ? error.name : "unknown",
            });
          }
          if (!path.startsWith("/v1/webhooks"))
            try {
              await webhooks.enqueueRequestEvent(
                core.pool,
                state.audit.id,
                reply.statusCode,
              );
            } catch (error) {
              request.log.warn({
                event: "queue.item.failed",
                operation: "public_api.audit_event.enqueue",
                error_type: error instanceof Error ? error.name : "unknown",
              });
            }
        }
        reply
          .header("x-api-version", "v1")
          .header("x-correlation-id", state.correlation);
        if (state.audit)
          reply
            .header("x-ratelimit-limit", state.audit.rateLimit)
            .header("x-ratelimit-remaining", state.audit.rateRemaining)
            .header("x-ratelimit-reset", 60);
        else if (reply.statusCode === 429)
          reply
            .header("x-ratelimit-limit", api.publicRateLimit(core.config))
            .header("x-ratelimit-remaining", 0)
            .header("x-ratelimit-reset", 60);
        if (
          core.config.env.PUBLIC_API_DEPRECATED_ROUTES?.split(",").some(
            (item) => item.trim() === path,
          )
        ) {
          reply.header("deprecation", "true");
          for (const [name, env] of [
            ["sunset", "PUBLIC_API_SUNSET"],
            ["link", "PUBLIC_API_DEPRECATION_LINK"],
          ]) {
            const value = core.config.env[env!]?.trim();
            if (value && !/[\r\n]/.test(value)) reply.header(name!, value);
          }
        }
        return payload;
      });
      async function context(request: FastifyRequest): Promise<RequestContext> {
        const state = states.get(request)!;
        if (state.context) return state.context;
        const value = await resolvePublicCredentialContext(request, core);
        value.correlationId = state.correlation;
        state.audit = await api.beginRequest(
          core.pool,
          api.publicRateLimit(core.config),
          value,
          request.method,
          request.url.split("?")[0]!,
        );
        state.context = value;
        return value;
      }
      async function action(
        request: FastifyRequest,
        name: string,
      ): Promise<RequestContext> {
        const value = await context(request),
          definition = [...domains.definitions()].find(
            (item) => item.name === name,
          );
        if (
          definition &&
          definition.lifecycle === "public" &&
          definition.supportedRuntimes.includes("direct") &&
          definition.supportedActors.includes(
            publicApiPolicy(value.principal).actorKind,
          )
        )
          states.get(request)!.audit!.action = name;
        await requirePublicAction(value, definition, name, load);
        return value;
      }
      async function webhookContext(request: FastifyRequest, write: boolean) {
        const value = await context(request);
        states.get(request)!.audit!.action = write
          ? "webhooks.manage"
          : "webhooks.list";
        await requireWebhookScope(value, write, load);
        return value;
      }
      const requireIdempotency = (
        value: RequestContext,
        action: string,
      ): void => {
        if (!value.idempotencyKey?.trim())
          bad(`idempotency-key is required for ${action}`);
      };
      routes.get("/health", async () => ({
        status: "ok",
        service: "kasitek-core",
        apiVersion: "v1",
        actionCatalogSize: [...domains.definitions()].length,
      }));
      routes.get("/openapi.json", async (_request, reply) =>
        reply
          .type("application/json")
          .send(
            await readFile(
              new URL("../../openapi/v1.json", import.meta.url),
              "utf8",
            ),
          ),
      );
      routes.get("/whoami", async (request) => {
        const value = await context(request);
        if (value.principal.kind !== "workspace_api_key")
          throw new ApiError(401, "unauthorized", "Unauthorized");
        return {
          principal: "workspace_api_key",
          apiKeyId: value.principal.id,
          organizationId: value.organizationId,
          scopes: [...(value.apiScopes ?? [])],
        };
      });
      routes.get("/metrics", async (request) =>
        api.requestMetrics(core.pool, await context(request)),
      );
      routes.get("/capabilities", async (request) => {
        const query = page(request),
          limit = BigInt(query.limit ?? 100),
          cursor = BigInt(query.cursor ?? 0);
        if (limit < 1n || limit > 200n)
          bad("capabilities limit must be between 1 and 200");
        if (query.version !== undefined && query.version !== "v1")
          bad("unsupported capabilities version");
        const value = await context(request);
        states.get(request)!.audit!.action = "capabilities.list";
        const policy = publicApiPolicy(value.principal),
          entitlements = await api.activeEntitlements(
            core.pool,
            value.organizationId,
          );
        let grants: Set<string> | null = null,
          scopes = value.apiScopes;
        if (policy.requiresInstallationCapabilities) {
          const result = await load(value);
          grants = new Set();
          if (Array.isArray(result.capabilities))
            for (const item of result.capabilities) {
              if (
                item &&
                typeof item === "object" &&
                !["not_granted", "not_configured", "unhealthy"].includes(
                  item.availability ?? "available",
                ) &&
                typeof item.manifest?.requiredScope === "string"
              )
                grants.add(item.manifest.requiredScope);
            }
          scopes = Array.isArray(result.apiScopes)
            ? new Set(
                result.apiScopes.filter(
                  (item): item is string => typeof item === "string",
                ),
              )
            : null;
        }
        const definitions = [...domains.definitions()].filter(
          (d) =>
            d.lifecycle === "public" &&
            d.supportedRuntimes.includes("direct") &&
            d.supportedActors.includes(policy.actorKind) &&
            (grants === null || d.requiredGrants.every((g) => grants.has(g))) &&
            (scopes === null ||
              scopes.has(d.risk === "read" ? "api:read" : "api:write")) &&
            d.requiredEntitlements.every((e) => entitlements.has(e)),
        );
        if (cursor > BigInt(definitions.length))
          bad("capabilities cursor is past the end of the result");
        const start = Number(cursor), size = Number(limit);
        const actions = definitions
          .slice(start, start + size)
          .map(
            ({
              lifecycle: _,
              supportedActors: __,
              supportedRuntimes: ___,
              ...definition
            }) => definition,
          );
        return {
          version: "v1",
          principal: {
            kind: value.principal.kind,
            id: value.principal.id,
            organizationId: value.organizationId,
          },
          principalPolicy: {
            supported: SUPPORTED_PUBLIC_API_PRINCIPALS,
            agentInstallationRequirements: [
              "api:read or api:write",
              "capability grant",
            ],
            notYetSupported: UNSUPPORTED_PUBLIC_API_PRINCIPALS,
          },
          transportPolicy: {
            featureFlag: "PUBLIC_API_DISABLED_ROUTES",
            deprecationRoutes: "PUBLIC_API_DEPRECATED_ROUTES",
            deprecationHeaders: ["Deprecation", "Sunset", "Link"],
          },
          actions,
          pagination: {
            limit: size,
            cursor: start,
            nextCursor:
              cursor + limit < BigInt(definitions.length)
                ? Number(cursor + limit)
                : null,
            total: definitions.length,
            version: "v1",
          },
        };
      });
      routes.get("/content/posts", async (request) => {
        const query = page(request),
          value = await action(request, "content.posts.list");
        return paginateCollection(
          { posts: await domains.listContentPosts(value) },
          "posts",
          query,
        );
      });
      routes.get("/content/posts/:id", async (request) => {
        const post = await domains.getContentPost(
          await action(request, "content.posts.list"),
          id(request),
        );
        if (!post)
          throw new ApiError(404, "not_found", "Content post not found");
        return { post };
      });
      routes.get("/content/posts/:id/activity", async (request) => {
        const activity = await domains.getContentActivity(
          await action(request, "content.posts.list"),
          id(request),
        );
        if (!activity)
          throw new ApiError(404, "not_found", "Content post not found");
        return activity;
      });
      async function contentWrite(
        request: FastifyRequest,
        create: boolean,
      ): Promise<Row> {
        const value = await action(
          request,
          create ? "content.posts.draft.create" : "content.posts.draft.update",
        );
        if (create) requireIdempotency(value, "content draft creation");
        const input = body(request),
          clean: Row = {};
        for (const key of [
          "title",
          "prompt",
          "content",
          "channels",
          "status",
          "scheduledFor",
          "primaryChannelId",
          "channelSelections",
          "variants",
          "media",
          "metadata",
        ])
          if (key in input) clean[key] = input[key];
        const post = create
            ? await domains.createContentDraft(value, clean)
            : await domains.updateContentDraft(value, id(request), clean),
          row = (post.row ?? post) as Row;
        try {
          await webhooks.enqueueDomainEvent(
            core.pool,
            value.organizationId,
            create
              ? webhooks.CONTENT_POST_CREATED_EVENT
              : webhooks.CONTENT_POST_UPDATED_EVENT,
            {
              postId: row.id,
              status: row.status,
              title: row.title ?? null,
              updatedAt: row.updatedAt ?? row.updated_at,
            },
          );
        } catch (error) {
          request.log.warn({
            event: "queue.item.failed",
            operation: create
              ? "content.created.enqueue"
              : "content.updated.enqueue",
            error_type: error instanceof Error ? error.name : "unknown",
          });
        }
        return { post };
      }
      routes.post("/content/posts", async (request, reply) =>
        reply.code(201).send(await contentWrite(request, true)),
      );
      routes.patch("/content/posts/:id", async (request) =>
        contentWrite(request, false),
      );
      routes.get("/contacts", async (request) => {
        const query = typedQuery<{
          q?: string;
          optIn?: string;
          excluded?: string;
          tag?: string;
          location?: string;
          listLabel?: string;
          limit?: string;
          cursor?: string;
          version?: string;
        }>(request.query, [
          "q",
          "optIn",
          "excluded",
          "tag",
          "location",
          "listLabel",
          "limit",
          "cursor",
          "version",
        ]),
          requestedLimit = queryI64(query.limit, "limit") ?? 50n,
          cursor = queryU64(query.cursor, "cursor") ?? 0n,
          value = await action(request, "contacts.list");
        if (query.version !== undefined && query.version !== "v1")
          bad("unsupported public API version");
        if (requestedLimit < 1n || requestedLimit > 100n)
          bad("pagination limit must be between 1 and 100");
        const limit = Number(requestedLimit),
          filters: Row = {
            q: query.q,
            optIn: query.optIn,
            excluded: query.excluded,
            tag: query.tag,
            location: query.location,
            listLabel: query.listLabel,
            limit,
            cursor:
              cursor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cursor) : 0,
          };
        const contacts = await domains.listContacts(value, filters),
          total = Number(
            (contacts.stats as Row | undefined)?.filteredTotal ?? 0,
          ),
          pagination = {
            ...pageWindow({ cursor, limit, version: query.version }, total),
            total,
            version: "v1",
          };
        return redactKeys({ ...contacts, pagination }, [
          "phone",
          "metadata",
          "lastMarketingSent",
        ]);
      });
      for (const [path, name, key, hidden, run] of [
        [
          "/inbox/conversations",
          "inbox.conversations.list",
          "conversations",
          ["phone", "lastMessage", "customerIdentifier"],
          (ctx: RequestContext) => domains.listInboxConversations(ctx),
        ],
        [
          "/inbox/conversations/:id/messages",
          "inbox.messages.list",
          "messages",
          ["content", "attachments", "customerIdentifier"],
          (ctx: RequestContext, request: FastifyRequest) =>
            domains.listInboxMessages(ctx, id(request)),
        ],
        [
          "/bookings",
          "bookings.list",
          "bookings",
          ["contactPhone", "notes"],
          (ctx: RequestContext) => domains.listBookings(ctx),
        ],
        [
          "/campaigns",
          "campaigns.list",
          "campaigns",
          [
            "templateBody",
            "templateButtons",
            "recipientPhone",
            "contactMetadata",
          ],
          (ctx: RequestContext) => domains.listCampaigns(ctx),
        ],
        [
          "/templates",
          "templates.list",
          "templates",
          ["body", "buttons", "header", "footer"],
          (ctx: RequestContext, request: FastifyRequest) =>
            domains.listTemplates(
              ctx,
              ((request.query as Row).status as string) ?? null,
            ),
        ],
      ] as const)
        routes.get(path, async (request) => {
          const query =
              path === "/templates" ? templatePage(request) : page(request),
            value = await action(request, name);
          return redactKeys(
            paginateCollection(await run(value, request), key, query),
            [...hidden],
          );
        });
      routes.get("/campaigns/:id", async (request) =>
        redactKeys(
          await domains.getCampaignSummary(
            await action(request, "campaigns.get"),
            id(request),
          ),
          [
            "templateBody",
            "templateButtons",
            "recipientPhone",
            "contactMetadata",
          ],
        ),
      );
      routes.get("/webhooks/subscriptions", async (request) => {
        const query = page(request),
          value = await webhookContext(request, false);
        return paginateCollection(
          {
            subscriptions: await webhooks.listSubscriptions(
              core.pool,
              value.organizationId,
            ),
          },
          "subscriptions",
          query,
        );
      });
      routes.post("/webhooks/subscriptions", async (request, reply) => {
        const value = await webhookContext(request, true);
        requireIdempotency(value, "webhook subscription creation");
        const input = body(request);
        if (typeof input.url !== "string") bad("webhook url is required");
        const result = await webhooks.createSubscription(
          core.pool,
          value.organizationId,
          input as unknown as webhooks.CreateSubscriptionInput,
          core.config,
          value.idempotencyKey,
        );
        return reply.code(201).send({
          subscription: result.subscription,
          secret: result.secret,
          secretDelivery: result.replayed
            ? "idempotency_replay"
            : "returned_once",
        });
      });
      routes.patch("/webhooks/subscriptions/:id", async (request) => ({
        subscription: await webhooks.updateSubscription(
          core.pool,
          (await webhookContext(request, true)).organizationId,
          id(request),
          body(request) as webhooks.UpdateSubscriptionInput,
          core.config,
        ),
      }));
      routes.delete("/webhooks/subscriptions/:id", async (request) => {
        await webhooks.deleteSubscription(
          core.pool,
          (await webhookContext(request, true)).organizationId,
          id(request),
        );
        return { status: "disabled" };
      });
      routes.get("/webhooks/subscriptions/:id/deliveries", async (request) => {
        const query = page(request),
          value = await webhookContext(request, false);
        return paginateCollection(
          {
            deliveries: await webhooks.listDeliveries(
              core.pool,
              value.organizationId,
              id(request),
            ),
          },
          "deliveries",
          query,
        );
      });
    },
    { prefix: "/v1" },
  );
}
