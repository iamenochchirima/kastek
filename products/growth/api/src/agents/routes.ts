import type { FastifyInstance, FastifyRequest } from "fastify";
import { GROWTH_AGENT_FEATURE_IDS, GrowthAgentContractError, parseGrowthAgentContext as parseContextWire, parseGrowthDraftProposal as parseDraftWire, parseGrowthAgentCommand,
  type GrowthAgentBootstrap, type GrowthAgentCommandInputs, type GrowthAgentCommandOperation, type GrowthAgentFeatureId } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { extractUser, resolveActiveOrgId, requireOrigin } from "../identity/session.js";
import { GrowthAgentClient, type GrowthAgentTransport } from "./client.js";
import { growthAgentActor } from "./security.js";
import { authorizeGrowthAgentScope, readGrowthAgentContext, type GrowthAgentScope } from "./scope.js";
import { GrowthAgentReviewStore } from "./reviews.js";
function contract<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof GrowthAgentContractError) throw new ApiError(400, "agent_request_invalid", "Check the request fields");
    throw error;
  }
}
const parseGrowthAgentContext = (value: unknown) => contract(() => parseContextWire(value));
const parseGrowthDraftProposal = (value: unknown) => contract(() => parseDraftWire(value));
function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "agent_request_invalid", "Check the request fields");
  return value as Record<string, unknown>;
}
function string(value: unknown, label = "request field", max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(400, "agent_request_invalid", `Check the ${label}`);
  return value;
}
function strict(item: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(item).some(key => !fields.includes(key))) throw new ApiError(400, "agent_request_invalid", "Check the request fields");
}
function page(request: FastifyRequest, fields: string[]) {
  const query = request.query as Record<string, unknown> ?? {};
  strict(query, [...fields, "cursor", "limit"]);
  const value: Record<string, unknown> = {};
  for (const key of [...fields, "cursor"]) if (query[key] !== undefined) value[key] = string(query[key], key, key === "search" ? 200 : 256);
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "agent_request_invalid", "Check the page limit");
    value.limit = limit;
  }
  return value;
}
export interface GrowthAgentRouteOptions extends GrowthAgentTransport {
  resolveScope?: (request: FastifyRequest) => Promise<GrowthAgentScope>;
}
export function registerGrowthAgentRoutes(app: FastifyInstance, core: CoreContext, options: GrowthAgentRouteOptions = {}): void {
  const client = new GrowthAgentClient(core.config, options), reviews = new GrowthAgentReviewStore(core);
  async function scope(request: FastifyRequest): Promise<GrowthAgentScope> {
    if (!["GET", "HEAD"].includes(request.method)) requireOrigin(request, core);
    const resolved = options.resolveScope ? await options.resolveScope(request) : await (async () => {
      const user = await extractUser(request, core), tenantId = await resolveActiveOrgId(request, core, user.id);
      return { tenantId, actor: growthAgentActor(core.config, user.id) };
    })();
    await authorizeGrowthAgentScope(core, resolved); return resolved;
  }
  async function invoke<K extends GrowthAgentCommandOperation>(request: FastifyRequest, operation: K, input: GrowthAgentCommandInputs[K], requestId?: string) {
    const auth = await scope(request);
    try {
      parseGrowthAgentCommand(JSON.parse(JSON.stringify({ version: "1", requestId: requestId ?? "validation", ...auth, operation, input })));
      return await client.command(auth, operation, input, requestId);
    } catch (error) {
      if (error instanceof GrowthAgentContractError) throw new ApiError(400, "agent_request_invalid", "Check the request fields");
      throw error;
    }
  }
  const id = (request: FastifyRequest, name: string) => string((request.params as Record<string, unknown>)[name], name);
  app.get("/api/agents/bootstrap", async request => {
    const auth = await scope(request), business = await authorizeGrowthAgentScope(core, auth);
    let data;
    try { data = await client.command(auth, "features.list", {}); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status < 500) throw error;
      const names = { assistant: "Growth assistant", research: "Research", content: "Content", campaigns: "Campaigns" };
      data = { features: GROWTH_AGENT_FEATURE_IDS.map(featureId => ({ id: featureId, name: names[featureId], description: "", ready: false,
        reasons: [{ code: error.code, message: "Agents is temporarily unavailable" }] })), model: null };
    }
    data.features = await Promise.all(data.features.map(async feature => {
      try { await authorizeGrowthAgentScope(core, auth, feature.id); return feature; }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 403) throw error;
        return { ...feature, ready: false, reasons: [{ code: error.code, message: "Unavailable for this business", route: "/billing" }] };
      }
    }));
    const result: GrowthAgentBootstrap = { ...data, defaultFeatureId: "assistant", scope: { businessId: auth.tenantId, userId: auth.actor.subject, businessName: business.businessName } };
    return result;
  });
  app.get("/api/agents/conversations", request => invoke(request, "conversations.list", page(request, ["featureId", "search"])));
  app.post("/api/agents/conversations", async (request, reply) => {
    const input = body(request); strict(input, ["requestId", "featureId", "title", "context"]);
    const auth = await scope(request), featureId = string(input.featureId) as GrowthAgentFeatureId;
    if (!GROWTH_AGENT_FEATURE_IDS.includes(featureId)) throw new ApiError(400, "agent_request_invalid", "Choose an available agent");
    await authorizeGrowthAgentScope(core, auth, featureId);
    const context = input.context === undefined || input.context === null ? null : parseGrowthAgentContext(input.context);
    if (context) await readGrowthAgentContext(core, auth, context);
    const result = await invoke(request, "conversations.create", { featureId, ...(input.title === undefined ? {} : { title: string(input.title, "title", 240) }), context }, string(input.requestId));
    return reply.code(201).send(result);
  });
  app.get("/api/agents/conversations/:conversationId", request => invoke(request, "conversations.get", { ...page(request, []), conversationId: id(request, "conversationId") }));
  app.patch("/api/agents/conversations/:conversationId/context", async request => {
    const input = body(request); strict(input, ["requestId", "context"]);
    if (input.context === undefined) throw new ApiError(400, "agent_request_invalid", "Choose the conversation context");
    const context = input.context === null ? null : parseGrowthAgentContext(input.context), auth = await scope(request);
    if (context) await readGrowthAgentContext(core, auth, context);
    return invoke(request, "conversations.context", { conversationId: id(request, "conversationId"), context }, string(input.requestId));
  });
  app.post("/api/agents/conversations/:conversationId/messages", async (request, reply) => {
    const input = body(request); strict(input, ["requestId", "text", "context"]);
    const result = await invoke(request, "turns.submit", { conversationId: id(request, "conversationId"), text: string(input.text, "message", 131072),
      ...(input.context === undefined ? {} : { context: input.context === null ? null : parseGrowthAgentContext(input.context) }) }, string(input.requestId));
    return reply.code(result.replayed ? 200 : 202).send(result);
  });
  app.get("/api/agents/tasks", request => invoke(request, "tasks.list", page(request, ["conversationId", "state", "search"])));
  app.get("/api/agents/tasks/:taskId", request => invoke(request, "tasks.get", { taskId: id(request, "taskId") }));
  app.get("/api/agents/tasks/:taskId/events", request => invoke(request, "tasks.events", { ...page(request, []), taskId: id(request, "taskId") }));
  app.post("/api/agents/tasks/:taskId/cancel", request => {
    const input = body(request); strict(input, ["requestId"]);
    return invoke(request, "tasks.cancel", { taskId: id(request, "taskId") }, string(input.requestId));
  });
  app.get("/api/agents/draft-destinations", async request => ({ destinations: await reviews.destinations(await scope(request)) }));
  app.get("/api/agents/tasks/:taskId/reviews", async request => ({ reviews: await reviews.list(await scope(request), id(request, "taskId")) }));
  app.patch("/api/agents/tasks/:taskId/reviews/:reviewId", async request => {
    const input = body(request); strict(input, ["requestId", "payloadDigest", "draft"]);
    return reviews.revise(await scope(request), id(request, "taskId"), id(request, "reviewId"), {
      requestId: string(input.requestId), payloadDigest: string(input.payloadDigest), draft: parseGrowthDraftProposal(input.draft),
    });
  });
  async function decision(request: FastifyRequest) {
    const input = body(request); strict(input, ["requestId", "payloadDigest", "decision"]);
    if (input.decision !== "approve" && input.decision !== "reject") throw new ApiError(400, "agent_request_invalid", "Choose a review decision");
    const requestId = string(input.requestId), auth = await scope(request), payloadDigest = string(input.payloadDigest), reviewId = id(request, "reviewId");
    const taskId = (request.params as Record<string, unknown>).taskId;
    const result = await reviews.decide(auth, reviewId, { requestId, payloadDigest, decision: input.decision }, taskId === undefined ? undefined : string(taskId));
    let resumePending = false;
    try { await client.command(auth, "reviews.decide", { taskId: result.review.taskId, reviewId, payloadDigest, decision: input.decision }, requestId); }
    catch (error) { if (!(error instanceof ApiError) || error.status < 500) throw error; resumePending = true; }
    return { ...result, resumePending };
  }
  app.post("/api/agents/tasks/:taskId/reviews/:reviewId/decision", decision);
  app.post("/api/agents/reviews/:reviewId/decision", decision);
  app.get("/api/agents/tasks/:taskId/artifacts", request => invoke(request, "artifacts.list", { taskId: id(request, "taskId") }));
  app.get("/api/agents/tasks/:taskId/artifacts/:artifactId", request => invoke(request, "artifacts.get", { taskId: id(request, "taskId"), artifactId: id(request, "artifactId") }));
}
