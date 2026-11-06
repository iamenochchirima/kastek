import { streamGrowthObservation, streamGrowthTask } from "./live.js";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { GROWTH_AGENT_FEATURE_IDS, GrowthAgentContractError, parseGrowthAgentContext as parseContextWire, parseGrowthDraftProposal as parseDraftWire, parseGrowthAgentCommand,
  GROWTH_RESOURCE_FIELDS, type GrowthAgentResourceOperation,
  type GrowthAgentBootstrap, type GrowthAgentCommandInputs, type GrowthAgentCommandOperation, type GrowthAgentFeatureId } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { extractUser, resolveActiveOrgId, requireOrigin } from "../identity/session.js";
import { growthAgentPublication } from "./manifest.js";
import { GrowthAgentClient, type GrowthAgentTransport } from "./client.js";
import { growthAgentActor } from "./security.js";
import { authorizeGrowthAgentScope, readGrowthAgentContext, type GrowthAgentScope } from "./scope.js";
import { GrowthAgentReviewStore } from "./reviews.js";
import { ensureGrowthAgentSetup } from "./setup.js";
import { enqueueGrowthAgentCommand } from "./analytics.js";
import { requireAdmin } from "../services/orgs.js";
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
function artifactChild(request:FastifyRequest):{childTaskId?:string}{
  const query=request.query as Record<string,unknown>??{};strict(query,["childTaskId"]);
  if(query.childTaskId===undefined)return {};
  const childTaskId=string(query.childTaskId,"child task");
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(childTaskId))throw new ApiError(400,"agent_request_invalid","Check the child task");
  return {childTaskId};
}
function page(request: FastifyRequest, fields: string[]) {
  const query = request.query as Record<string, unknown> ?? {};
  strict(query, [...fields, "cursor", "limit"]);
  const value: Record<string, unknown> = {};
  for (const key of [...fields, "cursor"]) if (query[key] !== undefined) value[key] = string(query[key], key, key === "search" ? 200 : key === "cursor" ? 2048 : 256);
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
    const auth = await scope(request), commandId = requestId ?? randomUUID();
    try { parseGrowthAgentCommand(JSON.parse(JSON.stringify({ version: "1", requestId: commandId, ...auth, operation, input }))); }
    catch (error) { if (error instanceof GrowthAgentContractError) throw new ApiError(400, "agent_request_invalid", "Check the request fields"); throw error; }
    let result;
    try { result = await client.command(auth, operation, input, commandId); }
    catch (error) {
      if (error instanceof ApiError) await enqueueGrowthAgentCommand(core.pool, auth, {
        operation, requestId: commandId, featureId: (input as { featureId?: GrowthAgentFeatureId }).featureId ?? null,
        conversationId: (input as { conversationId?: string }).conversationId ?? null,
        taskId: (input as { taskId?: string }).taskId ?? null,
        outcome: error.status >= 500 ? "unavailable" : "rejected", failureCode: /^[a-zA-Z0-9_]{1,80}$/.test(error.code) ? error.code : "agent_command_failed",
      });
      throw error;
    }
    const acknowledged = result as { conversation?: { id: string; featureId: GrowthAgentFeatureId }; task?: { id: string; conversationId: string; featureId: GrowthAgentFeatureId } };
    await enqueueGrowthAgentCommand(core.pool, auth, { operation, requestId: commandId,
      featureId: acknowledged.task?.featureId ?? acknowledged.conversation?.featureId ?? (input as { featureId?: GrowthAgentFeatureId }).featureId ?? null,
      conversationId: acknowledged.task?.conversationId ?? acknowledged.conversation?.id ?? (input as { conversationId?: string }).conversationId ?? null,
      taskId: acknowledged.task?.id ?? (input as { taskId?: string }).taskId ?? null, outcome: "accepted", failureCode: null });
    return result;
  }
  const id = (request: FastifyRequest, name: string) => string((request.params as Record<string, unknown>)[name], name);
  app.get("/api/agents/bootstrap", async request => {
    const auth = await scope(request), business = await authorizeGrowthAgentScope(core, auth);
    const setup = await ensureGrowthAgentSetup(core, auth.tenantId);
    let data;
    try {
      if (setup.state !== "ready") throw new ApiError(503, "agent_setup_pending", "Agent setup is pending");
      data = await client.command(auth, "features.list", {});
    }
    catch (error) {
      if (!(error instanceof ApiError) || error.status < 500) throw error;
      const names = { assistant: "Growth assistant", research: "Research", content: "Content", campaigns: "Campaigns" };
      data = { features: GROWTH_AGENT_FEATURE_IDS.map(featureId => ({ id: featureId, name: names[featureId], description: "", ready: false,
        reasons: [{ code: error.code, message: setup.state === "pending" || setup.state === "running" ? "Setting up" : setup.state === "blocked" || setup.state === "failed" ? "Setup needs attention" : "Agents is temporarily unavailable" }] })), model: null };
    }
    data.features = await Promise.all(data.features.map(async feature => {
      const visible=business.canConfigureAgents?feature:{...feature,specialists:undefined};
      try { await authorizeGrowthAgentScope(core, auth, feature.id); return visible; }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 403) throw error;
        return { ...visible, specialists: undefined, ready: false, reasons: [{ code: error.code, message: "Unavailable for this business", route: "/billing" }] };
      }
    }));
    const result: GrowthAgentBootstrap = { ...data, setup, defaultFeatureId: "assistant", scope: { businessId: auth.tenantId, userId: auth.actor.subject, businessName: business.businessName,canConfigureAgents:business.canConfigureAgents } };
    return result;
  });
  app.post("/api/agents/features/:featureId/upgrade/preview", async (request,reply) => {
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);strict(body(request),[]);reply.header("Cache-Control","no-store");
    return invoke(request,"features.upgrade.preview",{featureId:id(request,"featureId") as GrowthAgentFeatureId,publication:growthAgentPublication});
  });
  app.patch("/api/agents/features/:featureId/profile", async request => {
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);
    const input=body(request);strict(input,["name","avatar"]);
    const featureId=id(request,"featureId") as GrowthAgentFeatureId;
    await authorizeGrowthAgentScope(core,auth,featureId);
    return invoke(request,"features.profile",{featureId,name:string(input.name,"name",120),avatar:string(input.avatar,"avatar",32)});
  });
  app.post("/api/agents/features/:featureId/upgrade/apply", async request => {
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);const input=body(request);strict(input,["requestId","targetPublicationDigest","diffDigest","expectedRevisions","resolutions"]);
    return invoke(request,"features.upgrade.apply",{featureId:id(request,"featureId") as GrowthAgentFeatureId,publication:growthAgentPublication,
      targetPublicationDigest:input.targetPublicationDigest as string,diffDigest:input.diffDigest as string,expectedRevisions:input.expectedRevisions as GrowthAgentCommandInputs["features.upgrade.apply"]["expectedRevisions"],resolutions:input.resolutions as GrowthAgentCommandInputs["features.upgrade.apply"]["resolutions"]},string(input.requestId));
  });
  app.get("/api/agents/features/:featureId/models", async (request, reply) => {
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);
    strict(request.query as Record<string,unknown>??{},[]);reply.header("Cache-Control","no-store");
    return invoke(request,"models.list",{featureId:id(request,"featureId") as GrowthAgentFeatureId});
  });
  app.patch("/api/agents/features/:featureId/model", async request => {
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);
    const input=body(request);strict(input,["requestId","expectedRevision","selection"]);
    return invoke(request,"models.select",{featureId:id(request,"featureId") as GrowthAgentFeatureId,
      expectedRevision:Number(input.expectedRevision),selection:input.selection as GrowthAgentCommandInputs["models.select"]["selection"]},string(input.requestId));
  });
  app.get("/api/agents/features/:featureId/memory",request=>{
    const query=request.query as Record<string,unknown>??{};strict(query,["offset","limit"]);
    return invoke(request,"memory.list",{featureId:id(request,"featureId") as GrowthAgentFeatureId,
      ...(query.offset===undefined?{}:{offset:Number(query.offset)}),...(query.limit===undefined?{}:{limit:Number(query.limit)})});
  });
  app.post("/api/agents/features/:featureId/memory/:memoryId",request=>{
    const input=body(request);strict(input,["requestId","expectedRevision","action","content","assertion"]);
    return invoke(request,"memory.mutate",{featureId:id(request,"featureId") as GrowthAgentFeatureId,memoryId:id(request,"memoryId"),
      expectedRevision:Number(input.expectedRevision),action:input.action as "accept"|"correct"|"forget",...(input.content===undefined?{}:{content:string(input.content,"memory",8192)}),
      ...(input.assertion===undefined?{}:{assertion:input.assertion as GrowthAgentCommandInputs["memory.mutate"]["assertion"]})},string(input.requestId));
  });
  app.patch("/api/agents/features/:featureId/memory/settings",async request=>{
    const input=body(request);strict(input,["requestId","expectedRevision","enabled"]);
    const auth=await scope(request);await requireAdmin(core.pool,auth.tenantId,auth.actor.subject);
    return invoke(request,"memory.configure",{featureId:id(request,"featureId") as GrowthAgentFeatureId,
      expectedRevision:Number(input.expectedRevision),enabled:input.enabled as boolean},string(input.requestId));
  });
  async function resourceOwner(request: FastifyRequest) {
    const auth = await scope(request);
    await requireAdmin(core.pool, auth.tenantId, auth.actor.subject);
  }
  app.get("/api/agents/features/:featureId/resources", async (request, reply) => {
    await resourceOwner(request); strict(request.query as Record<string, unknown> ?? {}, []);
    reply.header("Cache-Control", "no-store");
    return invoke(request, "resources.list", { featureId: id(request, "featureId") as GrowthAgentFeatureId });
  });
  app.get("/api/agents/features/:featureId/resources/preview", async (request, reply) => {
    await resourceOwner(request);
    const query = request.query as Record<string, unknown> ?? {}; strict(query, ["kind", "sourceId", "revisionId", "skillId", "path"]);
    reply.header("Cache-Control", "no-store");
    return invoke(request, "resources.preview", { ...query, featureId: id(request, "featureId") } as GrowthAgentCommandInputs["resources.preview"]);
  });
  function resourceMutation<K extends GrowthAgentResourceOperation>(path: string, operation: K) {
    app.post(`/api/agents/features/:featureId/${path}`, { bodyLimit: 4194304 }, async request => {
      await resourceOwner(request);
      const input = body(request); strict(input, ["requestId", ...GROWTH_RESOURCE_FIELDS[operation].filter(key => key !== "featureId")]);
      const { requestId, ...fields } = input;
      return invoke(request, operation, { ...fields, featureId: id(request, "featureId") } as GrowthAgentCommandInputs[K], string(requestId));
    });
  }
  resourceMutation("sources", "sources.import");
  resourceMutation("sources/review", "sources.review");
  resourceMutation("sources/state", "sources.state");
  resourceMutation("skills", "skills.import");
  resourceMutation("skills/review", "skills.review");
  resourceMutation("skills/state", "skills.state");
  resourceMutation("resources/select", "resources.select");
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
  app.get("/api/agents/tasks/:taskId/activity", request => {
    const query=request.query as Record<string,unknown>??{}; strict(query,["childTaskId","cursor","operationCursor","limit"]);
    return invoke(request,"tasks.observe",{taskId:id(request,"taskId"),
      ...(query.childTaskId===undefined?{}:{childTaskId:string(query.childTaskId,"childTaskId")}),
      ...(query.cursor===undefined?{}:{cursor:string(query.cursor,"cursor",2048)}),
      ...(query.operationCursor===undefined?{}:{operationCursor:string(query.operationCursor,"operationCursor",2048)}),
      ...(query.limit===undefined?{}:{limit:Number(query.limit)})});
  });
  app.get("/api/agents/tasks/:taskId/activity/live", (request,reply) => {
    const query=request.query as Record<string,unknown>??{}; strict(query,["childTaskId","cursor"]);
    return streamGrowthObservation(request,reply,{taskId:id(request,"taskId"),
      ...(query.childTaskId===undefined?{}:{childTaskId:string(query.childTaskId,"childTaskId")}),
      ...(query.cursor===undefined?{}:{cursor:string(query.cursor,"cursor",2048)}),client,scope:()=>scope(request)});
  });
  app.get("/api/agents/tasks/:taskId/export", request => invoke(request, "tasks.export", { taskId: id(request, "taskId") }));
  app.get("/api/agents/tasks/:taskId/specialists/:childTaskId/result", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const query = request.query as Record<string, unknown> ?? {}; strict(query, ["offset"]);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2097152) throw new ApiError(400, "agent_request_invalid", "Check the result offset");
    const taskId = id(request, "taskId"), childTaskId = id(request, "childTaskId");
    const result = await invoke(request, "tasks.observe", { taskId, childTaskId });
    if (result.rootTaskId !== taskId || result.parentTaskId !== taskId || result.task?.id !== childTaskId)
      throw new ApiError(404, "agent_result_missing", "Specialist result is unavailable");
    const child = result.task;
    if (typeof child.state !== "string" || !["completed", "incomplete", "failed", "cancelled", "uncertain", "refused"].includes(child.state)) throw new ApiError(409, "agent_result_pending", "Specialist work is still running");
    if (child.output === null) return { taskId: childTaskId, state: child.state, available: false, output: null, nextOffset: null };
    if (typeof child.output !== "string") throw new ApiError(502, "agent_result_invalid", "Specialist result is unavailable");
    const points = Array.from(child.output), output = points.slice(offset, offset + 4096).join("");
    return { taskId: childTaskId, state: child.state, available: true, output, nextOffset: offset + 4096 < points.length ? offset + 4096 : null };
  });
  app.get("/api/agents/tasks/:taskId/live", async (request, reply) => {
    const query = page(request, []);
    if (query.limit !== undefined) throw new ApiError(400, "agent_request_invalid", "Check the request fields");
    return streamGrowthTask(request, reply, {taskId: id(request, "taskId"), cursor: query.cursor as string | undefined, scope: () => scope(request), client});
  });
  app.get("/api/agents/tasks/:taskId/events", request => invoke(request, "tasks.events", { ...page(request, []), taskId: id(request, "taskId") }));
  app.post("/api/agents/tasks/:taskId/cancel", request => {
    const input = body(request); strict(input, ["requestId"]);
    return invoke(request, "tasks.cancel", { taskId: id(request, "taskId") }, string(input.requestId));
  });
  app.post("/api/agents/tasks/:taskId/instructions", request => {
    const input = body(request); strict(input, ["requestId", "instruction"]);
    return invoke(request, "tasks.instructions", { taskId: id(request, "taskId"), instruction: string(input.instruction, "instructions", 4000) }, string(input.requestId));
  });
  app.post("/api/agents/tasks/:taskId/continue", request => {
    const input = body(request); strict(input, ["requestId"]);
    return invoke(request, "tasks.continue", { taskId: id(request, "taskId") }, string(input.requestId));
  });
  app.get("/api/agents/draft-destinations", async request => ({ destinations: await reviews.destinations(await scope(request)) }));
  app.get("/api/agents/tasks/:taskId/reviews", async request => {
    const taskId = id(request, "taskId"), result = await invoke(request, "reviews.list", { taskId });
    return { reviews: result.reviews.map(review => ({ ...review, taskId })) };
  });
  async function scopedReview(auth: GrowthAgentScope, taskId: string, reviewId: string) {
    const result = await client.command(auth, "reviews.list", { taskId });
    const review = result.reviews.find(review => review.id === reviewId);
    if (!review) throw new ApiError(404, "agent_review_missing", "Review is unavailable");
    return review;
  }
  app.patch("/api/agents/tasks/:taskId/reviews/:reviewId", async request => {
    const input = body(request); strict(input, ["requestId", "payloadDigest", "draft"]);
    const auth = await scope(request), taskId = id(request, "taskId"), reviewId = id(request, "reviewId"), allowed = await scopedReview(auth, taskId, reviewId);
    const result = await reviews.revise(auth, allowed.taskId, reviewId, {
      requestId: string(input.requestId), payloadDigest: string(input.payloadDigest), draft: parseGrowthDraftProposal(input.draft),
    });
    return { review: { ...result.review, taskId } };
  });
  async function decision(request: FastifyRequest) {
    const input = body(request); strict(input, ["requestId", "payloadDigest", "decision"]);
    if (input.decision !== "approve" && input.decision !== "reject") throw new ApiError(400, "agent_request_invalid", "Choose a review decision");
    const requestId = string(input.requestId), auth = await scope(request), payloadDigest = string(input.payloadDigest), reviewId = id(request, "reviewId");
    const taskId = (request.params as Record<string, unknown>).taskId;
    const publicTaskId = taskId === undefined ? undefined : string(taskId);
    const allowed = publicTaskId ? await scopedReview(auth, publicTaskId, reviewId) : undefined;
    const result = await reviews.decide(auth, reviewId, { requestId, payloadDigest, decision: input.decision }, allowed?.taskId);
    let resumePending = false;
    try { await client.command(auth, "reviews.decide", { taskId: publicTaskId ?? result.review.taskId, reviewId, payloadDigest, decision: input.decision }, requestId); }
    catch (error) { if (!(error instanceof ApiError) || error.status < 500) throw error; resumePending = true; }
    return { ...result, review: { ...result.review, taskId: publicTaskId ?? result.review.taskId }, resumePending };
  }
  app.post("/api/agents/tasks/:taskId/reviews/:reviewId/decision", decision);
  app.post("/api/agents/reviews/:reviewId/decision", async request => {
    await scope(request);
    throw new ApiError(400, "agent_review_task_required", "Open the task to review this draft");
  });
  app.get("/api/agents/tasks/:taskId/artifacts", request => invoke(request, "artifacts.list", { taskId: id(request, "taskId"), ...artifactChild(request) }));
  app.get("/api/agents/tasks/:taskId/artifacts/:artifactId/download", async (request, reply) => {
    const selected=artifactChild(request),artifactId=id(request,"artifactId");
    const chunks: Buffer[] = []; let offset = 0, digest: string | undefined, bytes: number | undefined, mediaType = "application/octet-stream", name:string|undefined;
    do {
      const result = await invoke(request, "artifacts.get", { taskId: id(request, "taskId"), artifactId, offset, ...selected });
      const part = result.artifact.chunk;
      if (!part || part.offset !== offset || !Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > 1048576 ||
        result.artifact.id!==artifactId || !/^[a-f0-9]{64}$/.test(part.digest) || (digest !== undefined && (digest !== part.digest || bytes !== part.bytes || mediaType!==result.artifact.mediaType || name!==result.artifact.title)))
        throw new ApiError(502, "agent_artifact_invalid", "Artifact is unavailable");
      digest = part.digest; bytes = part.bytes; mediaType = result.artifact.mediaType; name=result.artifact.title;
      const chunk = Buffer.from(part.base64, "base64"), end = offset + chunk.length;
      if (chunk.length > 65536 || end > bytes || part.nextOffset !== (end < bytes ? end : null) || end === offset && end !== bytes)
        throw new ApiError(502, "agent_artifact_invalid", "Artifact is unavailable");
      chunks.push(chunk); offset = end;
      if (part.nextOffset === null) break;
    } while (true);
    const content = Buffer.concat(chunks);
    if (content.length !== bytes || createHash("sha256").update(content).digest("hex") !== digest)
      throw new ApiError(502, "agent_artifact_invalid", "Artifact is unavailable");
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `attachment; filename="${name&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name)?name:"agent-result.bin"}"`);
    return reply.type(mediaType).send(content);
  });
  app.get("/api/agents/tasks/:taskId/artifacts/:artifactId", request => invoke(request, "artifacts.get", { taskId: id(request, "taskId"), artifactId: id(request, "artifactId"), ...artifactChild(request) }));
}
