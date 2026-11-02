import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { createId } from "@paralleldrive/cuid2";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import {
  resolvePublicCredentialContext,
  requireWebhookScope,
} from "../identity/request-context.js";
import type { RequestContext } from "../identity/request-context.js";
import {
  SUPPORTED_PUBLIC_API_PRINCIPALS,
  UNSUPPORTED_PUBLIC_API_PRINCIPALS,
} from "../identity/principal.js";
import * as api from "../services/public-api.js";
import * as webhooks from "../services/public-webhooks.js";
import { queryI64, queryU64, typedQuery } from "../typed-query.js";
import { executeGrowthOperation } from "../operations/reviews.js";
import { growthToolArguments, growthToolInputSchema, requireGrowthAgentAccess } from "../operations/transport.js";
import { growthOperations } from "../operations/catalog.js";
import { listGrowthOperations } from "../operations/policy.js";
import { requireOrigin } from "../identity/session.js";
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
    _continuation?: string;
  }>(request.query, ["cursor", "limit", "version", "_continuation"]);
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
    _continuation?: string;
  }>(request.query, ["status", "cursor", "limit", "version", "_continuation"]);
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
  _domains: api.PublicDomainAdapter,
): void {
  const states = new WeakMap<
      FastifyRequest,
      {
        correlation: string;
        context?: RequestContext;
        audit?: api.RequestAuditHandle;
      }
    >();
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
      async function webhookContext(request: FastifyRequest, write: boolean) {
        const value = await context(request);
        states.get(request)!.audit!.action = write
          ? "webhooks.manage"
          : "webhooks.list";
        await requireWebhookScope(value, write);
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
        actionCatalogSize: growthOperations.length,
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
        if (value.principal.kind !== "workspace_api_key" && value.principal.kind !== "oauth_user")
          throw new ApiError(401, "unauthorized", "Unauthorized");
        return {
          principal: value.principal.kind,
          ...(value.principal.kind === "workspace_api_key" ? {apiKeyId:value.principal.id} : {connectionId:value.principal.id}),
          organizationId: value.organizationId,
          scopes: [...(value.apiScopes ?? [])],
        };
      });
      routes.get("/metrics", async (request) =>
        api.requestMetrics(core.pool, await context(request)),
      );
      routes.get("/capabilities", async (request) => {
        requireGrowthAgentAccess(core);
        const query = page(request),
          limit = BigInt(query.limit ?? 100),
          cursor = BigInt(query.cursor ?? 0);
        if (limit < 1n || limit > 200n)
          bad("capabilities limit must be between 1 and 200");
        if (query.version !== undefined && query.version !== "v1")
          bad("unsupported capabilities version");
        const value = await context(request);
        states.get(request)!.audit!.action = "capabilities.list";
        const definitions = await listGrowthOperations(core,value);
        if (cursor > BigInt(definitions.length))
          bad("capabilities cursor is past the end of the result");
        const start = Number(cursor), size = Number(limit);
        const actions = definitions.slice(start,start+size).map(definition=>({
          ...definition,inputSchema:growthToolInputSchema(definition),
          risk:definition.effect,
        }));
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
              "permitted operation scope",
              "current workspace access",
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
      async function operationRead(request:FastifyRequest,name:string,input:Row):Promise<Row> {
        requireGrowthAgentAccess(core);
        const value=await context(request);
        states.get(request)!.audit!.action=name;
        const {continuation}=growthToolArguments({_continuation:(request.query as Row)._continuation});
        const output=await executeGrowthOperation(core,value,{operation:name,input,continuation,requestAudit:states.get(request)!.audit});
        return output.result as Row;
      }
      const contentPage=(request:FastifyRequest):Row=>{
        const query=page(request);
        if(query.version!==undefined&&query.version!=="v1")bad("unsupported public API version");
        return {...(query.limit===undefined?{}:{limit:Number(query.limit)}),...(query.cursor===undefined?{}:{cursor:Number(query.cursor)})};
      };
      routes.get("/content/accounts",async request=>operationRead(request,"content.accounts.list",contentPage(request)));
      routes.get("/content/posts", async request=>operationRead(request,"content.posts.list",contentPage(request)));
      routes.get("/content/posts/:id", async (request) => {
        return operationRead(request,"content.posts.get",{postId:id(request)});
      });
      routes.get("/content/posts/:id/activity", async (request) => {
        return operationRead(request,"content.posts.activity",{postId:id(request)});
      });
      routes.get("/content/media/:id",async request=>operationRead(request,"content.media.get",{assetId:id(request)}));
      routes.get("/content/media/:id/preview",async request=>operationRead(request,"content.media.preview",{assetId:id(request)}));
      async function contentWrite(
        request: FastifyRequest,
        create: boolean,
      ): Promise<Row> {
        requireGrowthAgentAccess(core);
        const value=await context(request);
        if(value.principal.kind==="direct_user")requireOrigin(request,core);
        const name=create?"content.posts.draft.create":"content.posts.draft.update";
        states.get(request)!.audit!.action=name;
        const args=growthToolArguments(body(request));
        const input = args.input,
          clean: Row = {};
        for (const key of [
          "title",
          "prompt",
          "content",
          "channels",
          "primaryChannelId",
          "channelSelections",
          "variants",
          "media",
          "metadata",
        ])
          if (key in input) clean[key] = input[key];
        if(input.status!==undefined&&input.status!=="DRAFT")bad("Draft routes cannot publish or schedule content");
        if(input.scheduledFor)bad("Use the schedule operation to schedule content");
        const output=await executeGrowthOperation(core,value,{operation:name,input:{draft:clean,...(create?{}:{postId:id(request)})},requestId:args.requestId,reviewId:args.reviewId,continuation:args.continuation,requestAudit:states.get(request)!.audit});
        if(output.state!=="succeeded")return output;
        const result=output.result as {post?:Row},post=result.post;
        if(!post)return output;
        return {...output,post};
      }
      routes.post("/content/posts",async(request,reply)=>{const output=await contentWrite(request,true);return reply.code(output.state==="succeeded"?201:202).send(output);});
      routes.patch("/content/posts/:id",async(request,reply)=>{const output=await contentWrite(request,false);return reply.code(output.state==="succeeded"?200:202).send(output);});
      routes.get("/contacts", async request => {
        const query=typedQuery<{q?:string;optIn?:string;excluded?:string;tag?:string;location?:string;listLabel?:string;limit?:string;cursor?:string;version?:string;_continuation?:string}>(request.query,["q","optIn","excluded","tag","location","listLabel","limit","cursor","version","_continuation"]);
        if(query.version!==undefined&&query.version!=="v1")bad("unsupported public API version");
        return operationRead(request,"contacts.list",{
          ...(query.q===undefined?{}:{search:query.q}),...(query.optIn===undefined?{}:{optIn:query.optIn}),...(query.tag===undefined?{}:{tag:query.tag}),...(query.excluded===undefined?{}:{excluded:query.excluded}),...(query.location===undefined?{}:{location:query.location}),...(query.listLabel===undefined?{}:{listLabel:query.listLabel}),
          ...(query.limit===undefined?{}:{limit:Number(queryI64(query.limit,"limit"))}),...(query.cursor===undefined?{}:{cursor:Number(queryU64(query.cursor,"cursor"))}),
        });
      });
      for(const [path,name] of [
        ["/inbox/conversations","inbox.conversations.list"],
        ["/inbox/conversations/:id/messages","inbox.messages.list"],
        ["/bookings","bookings.list"],
        ["/campaigns","campaigns.list"],
        ["/templates","templates.list"],
      ] as const) routes.get(path,async request=>{
        if(path==="/templates") {
          const query=typedQuery<{status?:string;limit?:string;cursor?:string;version?:string;_continuation?:string}>(request.query,["status","limit","cursor","version","_continuation"]);
          const paging=templatePage(request);
          if(paging.version!==undefined&&paging.version!=="v1")bad("unsupported public API version");
          return operationRead(request,name,{...(query.status===undefined?{}:{status:query.status}),...(paging.limit===undefined?{}:{limit:Number(paging.limit)}),...(paging.cursor===undefined?{}:{cursor:Number(paging.cursor)})});
        }
        return operationRead(request,name,{...contentPage(request),...(name==="inbox.messages.list"?{conversationId:id(request)}:{})});
      });
      routes.get("/campaigns/:id",async request=>operationRead(request,"campaigns.get",{campaignId:id(request)}));
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
