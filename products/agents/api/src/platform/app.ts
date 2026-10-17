import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformIdentity } from "./auth";
import type { PlatformConfig } from "./config";
import { agentConfigurationSchema, assertRuntimeAvailable, executionGrantSchema, parseAllowedOrigin,
  PlatformError, terminalTaskStates, type AdmissionAuthority } from "./contracts";
import { PlatformStore, type Account, type TaskRecord } from "./store";
import { websiteWidgetScript } from "./widget";
import { registerMemoryRoutes } from "./memory-routes";
import { privateStoreFromEnvironment } from "./artifacts";
import { MemoryStore } from "./memory";

const uuid = z.uuid();
const taskInput = z.strictObject({ versionId: uuid, input: z.string().min(1).max(16_384),
  requestKey: z.string().min(1).max(128), conversationId: uuid.optional() });
const websiteTaskInput = taskInput.omit({ versionId: true });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const dto = (row: object) => ({ ...Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
])), ...(Object.hasOwn(row,"conversation_id") && Object.hasOwn(row,"grant_id") ? {
  rootTaskId: (row as TaskRecord).id, parentTaskId: null,
  phase: terminalTaskStates.has((row as TaskRecord).state) ? "terminal" : (row as TaskRecord).state === "accepted" ? "queued" :
    (row as TaskRecord).state === "cancel_requested" ? "stopping" : (row as TaskRecord).state,
  outcome: terminalTaskStates.has((row as TaskRecord).state) ? (row as TaskRecord).state : null,
} : {}) });

export async function buildPlatformApp(options: { config: PlatformConfig; pool: Pool; identity?: PlatformIdentity; logging?: boolean }) {
  const { config, pool } = options;
  const store = new PlatformStore(pool);
  const identity = options.identity ?? new PlatformIdentity(config, pool);
  const origin = new URL(config.AGENTS_PUBLIC_URL).origin;
  const secure = origin.startsWith("https:");
  const sessionCookie = secure ? "__Host-agents_session" : "agents_session";
  const loginCookie = secure ? "__Host-agents_login" : "agents_login";
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const app = Fastify({ bodyLimit: 128_000, logger: options.logging === false ? false : {
    base: { service: "agents-platform", environment: config.NODE_ENV, release: (process.env.KASITEK_RELEASE_ID || "development").slice(0, 128) },
    redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: { req: (request: { method: string; url: string }) => ({ method: request.method, path: request.url.split("?")[0] }) },
  } });
  await app.register(cookie);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Check the request fields" } });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });
    request.log.error({ event: "platform.request.failed", code: "INTERNAL_ERROR" }, "Request failed");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        !request.url.startsWith("/api/website/") && request.url.split("?")[0] !== "/api/auth/backchannel-logout" && request.headers.origin !== origin) {
      throw new PlatformError("ORIGIN_DENIED", 403, "Request origin is not allowed");
    }
  });
  async function account(request: FastifyRequest): Promise<Account> {
    const session = await store.getSession(request.cookies[sessionCookie] ?? "");
    if (!session || session.account.issuer !== config.AGENTS_OIDC_ISSUER_URL) throw new PlatformError("SIGN_IN_REQUIRED", 401, "Sign in to continue");
    return session.account;
  }
  function parameters(request: FastifyRequest) { return request.params as Record<string, string>; }
  function organizationId(request: FastifyRequest) { return uuid.parse(parameters(request).organizationId); }
  function humanAuthority(user: Account, org: string, resourceId: string): AdmissionAuthority {
    return { product: "agents", organizationId: org, resourceId, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: user.issuer, subject: user.subject } };
  }
  async function humanTask(request: FastifyRequest) {
    const user = await account(request), org = organizationId(request), taskId = uuid.parse(parameters(request).taskId);
    await store.requireMembership(user.id, org);
    const task = (await pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2", [org, taskId])).rows[0];
    if (!task) throw new PlatformError("NOT_FOUND", 404, "Task not found");
    const authority = humanAuthority(user, org, task.resource_id);
    return { task: await store.getTask(authority, taskId), authority };
  }
  app.get("/health", async () => ({ status: "ok", service: "agents-platform", schema: "001_platform" }));
  app.get("/ready", async (_request, reply) => {
    const result = await pool.query("SELECT version FROM agents_platform.schema_version");
    const ready = result.rows[0]?.version === "001_platform" && Boolean(config.OPENROUTER_API_KEY);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable", business: ready, workspace: false });
  });
  app.get("/api/auth/login", async (_request, reply) => {
    const login = await identity.begin();
    return reply.setCookie(loginCookie, login.token, { ...cookieOptions, maxAge: 600 }).redirect(login.redirectTo);
  });
  app.get("/api/auth/callback", async (request, reply) => {
    const claims = await identity.complete(request.cookies[loginCookie], request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "");
    const user = await store.ensureAccount(claims);
    const session = await store.createSession({ accountId: user.id, providerSessionId: claims.providerSessionId, expiresAt: claims.expiresAt });
    return reply.clearCookie(loginCookie, cookieOptions).setCookie(sessionCookie, session.token, { ...cookieOptions, expires: session.expiresAt }).redirect("/app");
  });
  app.post("/api/auth/logout", async (request, reply) => {
    await store.revokeSession(request.cookies[sessionCookie] ?? "");
    reply.clearCookie(sessionCookie, cookieOptions);
    return { redirectTo: await identity.logoutUrl() };
  });
  app.post("/api/auth/backchannel-logout", async (request, reply) => {
    const input = z.strictObject({ logout_token: z.string().min(1).max(16_000) }).parse(request.body);
    await identity.backchannelLogout(input.logout_token);
    return reply.code(204).send();
  });
  app.get("/api/session", async (request) => {
    const user = await account(request);
    return { account: { id: user.id, email: user.email, displayName: user.display_name }, organizations: await store.listOrganizations(user.id) };
  });
  app.post("/api/organizations", async (request, reply) => {
    const user = await account(request), input = z.strictObject({ name: z.string().min(1).max(120) }).parse(request.body);
    return reply.code(201).send({ organization: await store.createOrganization(user.id, input.name) });
  });
  const base = "/api/organizations/:organizationId";
  registerMemoryRoutes(app, { pool, objects: privateStoreFromEnvironment(), resolveScope: async request => {
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    await store.getAgent(user.id, org, agentId);
    return { accountId: user.id, organizationId: org, agentId };
  } });
  app.get(`${base}/agents`, async (request) => ({ agents: (await store.listAgents((await account(request)).id, organizationId(request))).map(dto) }));
  app.post(`${base}/agents`, async (request, reply) => {
    const user = await account(request), input = z.strictObject({ name: z.string().min(1).max(120) }).parse(request.body);
    return reply.code(201).send({ agent: dto(await store.createAgent({ accountId: user.id, organizationId: organizationId(request), name: input.name })) });
  });
  app.get(`${base}/agents/:agentId`, async (request) => {
    const user = await account(request), org = organizationId(request), agentId = uuid.parse(parameters(request).agentId);
    const agent = await store.getAgent(user.id, org, agentId);
    const [versions, deployments] = await Promise.all([store.listVersions(user.id, org, agentId), store.listDeployments(user.id, org, agentId)]);
    return { agent: dto(agent), versions: versions.map(dto), deployments: deployments.map(dto) };
  });
  app.put(`${base}/agents/:agentId`, async (request) => {
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), configuration: agentConfigurationSchema,
      expectedRevision: z.number().int().positive() }).parse(request.body);
    return { agent: dto(await store.updateDraft({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) };
  });
  app.get(`${base}/knowledge`, async (request) => ({ knowledge: (await store.listKnowledge((await account(request)).id, organizationId(request))).map(dto) }));
  app.post(`${base}/knowledge`, async (request, reply) => {
    const input = z.strictObject({ title: z.string().min(1).max(200), content: z.string().min(1).max(100_000),
      visibility: z.enum(["private", "public"]) }).parse(request.body);
    return reply.code(201).send({ knowledge: dto(await store.approveKnowledge({ ...input,
      accountId: (await account(request)).id, organizationId: organizationId(request) })) });
  });
  app.post(`${base}/agents/:agentId/versions`, async (request, reply) => {
    const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(request.body);
    return reply.code(201).send({ version: dto(await store.createVersion({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) });
  });
  app.post(`${base}/agents/:agentId/deployments`, async (request, reply) => {
    const input = z.strictObject({ versionId: uuid, allowedOrigins: z.array(z.string()).min(1).max(10) }).parse(request.body);
    return reply.code(201).send({ deployment: dto(await store.publishWebsite({ ...input, accountId: (await account(request)).id,
      organizationId: organizationId(request), agentId: uuid.parse(parameters(request).agentId) })) });
  });
  app.post(`${base}/tasks`, async (request, reply) => {
    const input = taskInput.parse(request.body), user = await account(request), org = organizationId(request);
    const version = await store.getVersion(user.id, org, input.versionId);
    assertRuntimeAvailable(version.configuration);
    if (!config.OPENROUTER_API_KEY) throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE", 503, "Model connection is unavailable");
    const authority = humanAuthority(user, org, version.agent_id);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: ["model.reply", "knowledge.read", ...(version.configuration.memory.enabled ? ["memory.read", "memory.propose"] : [])], knowledgeIds: version.configuration.knowledgeIds,
      maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: user.id, grant });
    const result = await store.admitTask({ ...input, authority, grantId: grant.id });
    request.log.info({ event: "task.admitted", taskId: result.task.id, organizationId: org, replayed: result.replayed }, "Task admitted");
    return reply.code(result.replayed ? 200 : 202).send({ task: dto(result.task) });
  });
  app.get(`${base}/tasks/:taskId`, async (request) => {
    const { task, authority } = await humanTask(request);
    const operations = (await pool.query(`SELECT id AS operation_id,kind,name,state,error_code,accounted_tokens,started_at,completed_at
      FROM agents_platform.operations WHERE task_id=$1 ORDER BY started_at,id`, [task.id])).rows;
    return { task: dto(task), events: (await store.listTaskEvents(authority, task.id)).map(dto), operations: operations.map(dto) };
  });
  app.post(`${base}/tasks/:taskId/continue`, async request => {
    const { task, authority } = await humanTask(request);
    const user = await account(request);
    if (task.state !== "waiting_authority") return { task: dto(task) };
    const previous = (await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1",[task.grant_id])).rows[0];
    if(!previous || previous.revoked_at) throw new PlatformError("GRANT_REVOKED",403,"Execution access was revoked");
    const version = await store.getVersion(user.id, task.organization_id, task.version_id);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: ["model.reply", "knowledge.read", ...(version.configuration.memory.enabled ? ["memory.read", "memory.propose"] : [])],
      knowledgeIds: version.configuration.knowledgeIds, maxInputBytes: version.configuration.model.maxInputBytes,
      maxOutputTokens: version.configuration.model.maxOutputTokens, maxContextTokens: version.configuration.context.maxInputTokens,
      rootTokenLimit: (task as TaskRecord & {root_token_limit:number}).root_token_limit,
      expiresAt: new Date(Math.min(Date.now()+30*60_000, new Date((task as TaskRecord & {deadline_at:Date}).deadline_at).getTime())).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: user.id, grant });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const updated = (await db.query(`UPDATE agents_platform.tasks SET grant_id=$2,control_generation=control_generation+1,updated_at=now()
        WHERE id=$1 AND state='waiting_authority' RETURNING control_generation-1 AS generation`, [task.id, grant.id])).rows[0];
      if (updated) await db.query("INSERT INTO agents_platform.task_controls(task_id,generation) VALUES($1,$2) ON CONFLICT DO NOTHING", [task.id, updated.generation]);
      await db.query("COMMIT");
    } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    return { task: dto(await store.getTask(authority, task.id)) };
  });
  app.get(`${base}/conversations/:conversationId`, async (request) => {
    const user = await account(request), org = organizationId(request), conversationId = uuid.parse(parameters(request).conversationId);
    await store.requireMembership(user.id, org);
    const conversation = (await pool.query<{ agent_id: string }>("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [org, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    return { tasks: (await store.getConversation(humanAuthority(user, org, conversation.agent_id), conversationId)).map(dto) };
  });
  app.delete(`${base}/conversations/:conversationId`, async request => {
    const user = await account(request), org = organizationId(request), conversationId = uuid.parse(parameters(request).conversationId);
    const conversation = (await pool.query("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [org,conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND",404,"Conversation not found");
    return new MemoryStore(pool).deleteConversationSources({accountId:user.id,organizationId:org,agentId:conversation.agent_id},conversationId);
  });
  app.post(`${base}/tasks/:taskId/cancel`, async (request) => {
    const { task, authority } = await humanTask(request);
    if (!terminalTaskStates.has(task.state)) {
      await pool.query(`WITH changed AS (UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now()
        WHERE id=$1 AND state IN ('accepted','running','waiting_authority') RETURNING id)
        INSERT INTO agents_platform.task_events(task_id,event_key,kind) SELECT id,'cancel-request','cancel_requested' FROM changed ON CONFLICT DO NOTHING`, [task.id]);
    }
    return { task: dto(await store.getTask(authority, task.id)) };
  });

  async function websiteContext(request: FastifyRequest, reply?: { header: (key: string, value: string) => unknown }) {
    const deployment = await store.getWebsiteDeployment(uuid.parse(parameters(request).deploymentId));
    const suppliedOrigin = request.headers.origin;
    // The first-party chat view is a preview of this explicit publication, never a draft.
    const websiteOrigin = suppliedOrigin || (request.method === "GET" ? origin : "");
    const allowed = deployment.allowed_origins.includes(websiteOrigin) || websiteOrigin === origin;
    if (!allowed || (websiteOrigin && parseAllowedOrigin(websiteOrigin) !== websiteOrigin)) throw new PlatformError("ORIGIN_DENIED", 403, "Website origin is not allowed");
    if (suppliedOrigin) {
      reply?.header("access-control-allow-origin", suppliedOrigin);
      reply?.header("vary", "Origin");
      reply?.header("access-control-allow-headers", "Content-Type, Authorization");
      reply?.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    return { deployment, websiteOrigin, grantOrigin: websiteOrigin === origin ? deployment.allowed_origins[0]! : websiteOrigin };
  }
  app.options("/api/website/:deploymentId/*", async (request, reply) => {
    await websiteContext(request, reply); return reply.code(204).send();
  });
  async function publicRate(deploymentId: string): Promise<void> {
    await pool.query("DELETE FROM agents_platform.website_rate_limits WHERE deployment_id=$1 AND minute<now()-interval '1 day'", [deploymentId]);
    const row = (await pool.query<{ requests: number }>(`INSERT INTO agents_platform.website_rate_limits(deployment_id,minute,requests)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(deployment_id,minute) DO UPDATE SET requests=agents_platform.website_rate_limits.requests+1 RETURNING requests`, [deploymentId])).rows[0]!;
    if (row.requests > 20) throw new PlatformError("RATE_LIMIT", 429, "Too many requests. Try again shortly");
  }
  async function websiteAuthority(request: FastifyRequest, deployment: Awaited<ReturnType<PlatformStore["getWebsiteDeployment"]>>, websiteOrigin: string): Promise<AdmissionAuthority> {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new PlatformError("WEBSITE_SESSION_REQUIRED", 401, "Website session required");
    const row = (await pool.query<{ id: string }>(`SELECT id FROM agents_platform.website_sessions
      WHERE deployment_id=$1 AND token_hash=$2 AND origin=$3 AND expires_at>now()`, [deployment.id, hash(token), websiteOrigin])).rows[0];
    if (!row) throw new PlatformError("WEBSITE_SESSION_EXPIRED", 401, "Website session expired");
    return { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id,
      callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: row.id } };
  }
  app.get("/api/website/:deploymentId", async (request, reply) => {
    const { deployment } = await websiteContext(request, reply);
    const row = (await pool.query<{ name: string }>("SELECT name FROM agents_platform.agents WHERE id=$1 AND organization_id=$2", [deployment.agent_id, deployment.organization_id])).rows[0];
    return { name: row?.name ?? "Assistant" };
  });
  app.get("/api/website/:deploymentId/widget.js", async (request, reply) => {
    const deploymentId = uuid.parse(parameters(request).deploymentId);
    await store.getWebsiteDeployment(deploymentId);
    return reply.type("application/javascript; charset=utf-8").send(websiteWidgetScript(deploymentId));
  });
  app.post("/api/website/:deploymentId/session", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    await publicRate(deployment.id);
    await pool.query("DELETE FROM agents_platform.website_sessions WHERE deployment_id=$1 AND expires_at<=now()", [deployment.id]);
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [randomUUID(), deployment.id, hash(token), websiteOrigin]);
    return reply.code(201).send({ token });
  });
  app.post("/api/website/:deploymentId/tasks", async (request, reply) => {
    const { deployment, websiteOrigin, grantOrigin } = await websiteContext(request, reply);
    const authority = await websiteAuthority(request, deployment, websiteOrigin), input = websiteTaskInput.parse(request.body);
    await publicRate(deployment.id);
    if (!config.OPENROUTER_API_KEY) throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE", 503, "Model connection is unavailable");
    if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const grant = await store.createWebsiteGrant({ deploymentId: deployment.id, origin: grantOrigin, sessionId: authority.principal.sessionId });
    const result = await store.admitTask({ ...input, authority, versionId: deployment.version_id, grantId: grant.id });
    return reply.code(result.replayed ? 200 : 202).send({ task: dto(result.task) });
  });
  app.get("/api/website/:deploymentId/tasks/:taskId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    const task = await store.getTask(authority, uuid.parse(parameters(request).taskId));
    return { task: dto(task), events: (await store.listTaskEvents(authority, task.id)).map(dto) };
  });
  app.get("/api/website/:deploymentId/conversations/:conversationId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    return { tasks: (await store.getConversation(authority, uuid.parse(parameters(request).conversationId))).map(dto) };
  });
  return app;
}
