import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { parseAllowedOrigin, PlatformError, type AdmissionAuthority } from "../../contracts/contracts";
import type { TaskRecord, WebsiteDeployment } from "../../contracts/records";

type VisitorScope = { deploymentId: string; sessionId: string };

/** Published website deployments and their visitor-visible records. */
export interface WebsiteStorePort {
  getWebsiteDeployment(deploymentId: string): Promise<WebsiteDeployment>;
  getTask(authority: AdmissionAuthority, taskId: string): Promise<TaskRecord>;
  getConversation(authority: AdmissionAuthority, conversationId: string): Promise<TaskRecord[]>;
  listTaskEvents(authority: AdmissionAuthority, taskId: string): Promise<object[]>;
}

export interface WebsiteInboxPort {
  firstMessage(scope: VisitorScope, input: { requestKey: string; body: string }, conversationId?: string):
    Promise<{ message: { task_id: string | null }; conversation: { id: string; state: string }; replayed: boolean }>;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Visitor-facing website routes. Paths, CORS behavior and session checks stay unchanged while the
 * handlers move out of composition. Adapter and product details arrive as ports.
 */
export function registerWebsiteRoutes(app: FastifyInstance, options: {
  pool: Pool;
  store: WebsiteStorePort;
  inbox: WebsiteInboxPort;
  origin: string;
  followup: { enabled: boolean; ready(): Promise<boolean> };
  parseAppearance(value: unknown): object;
  widgetScript(deploymentId: string, appearance: unknown): string;
  presentTask(task: TaskRecord): Promise<object>;
  present(record: object): object;
  passages(task: TaskRecord): Promise<object>;
}) {
  const uuid = z.uuid();
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;

  async function websiteContext(request: FastifyRequest, reply?: FastifyReply) {
    const deployment = await options.store.getWebsiteDeployment(uuid.parse(parameters(request).deploymentId));
    const suppliedOrigin = request.headers.origin;
    // The first-party chat view is a preview of this explicit publication, never a draft.
    const websiteOrigin = suppliedOrigin || (request.method === "GET" ? options.origin : "");
    const allowed = deployment.allowed_origins.includes(websiteOrigin) || websiteOrigin === options.origin;
    if (!allowed || (websiteOrigin && parseAllowedOrigin(websiteOrigin) !== websiteOrigin)) throw new PlatformError("ORIGIN_DENIED", 403, "Website origin is not allowed");
    if (suppliedOrigin) {
      reply?.header("access-control-allow-origin", suppliedOrigin);
      reply?.header("vary", "Origin");
      reply?.header("access-control-allow-headers", "Content-Type, Authorization");
      reply?.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    return { deployment, websiteOrigin, grantOrigin: websiteOrigin === options.origin ? deployment.allowed_origins[0]! : websiteOrigin };
  }

  async function publicRate(deploymentId: string): Promise<void> {
    await options.pool.query("DELETE FROM agents_platform.website_rate_limits WHERE deployment_id=$1 AND minute<now()-interval '1 day'", [deploymentId]);
    const row = (await options.pool.query<{ requests: number }>(`INSERT INTO agents_platform.website_rate_limits(deployment_id,minute,requests)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(deployment_id,minute) DO UPDATE SET requests=agents_platform.website_rate_limits.requests+1 RETURNING requests`, [deploymentId])).rows[0]!;
    if (row.requests > 20) throw new PlatformError("RATE_LIMIT", 429, "Too many requests. Try again shortly");
  }

  async function websiteAuthority(request: FastifyRequest, deployment: WebsiteDeployment, websiteOrigin: string): Promise<AdmissionAuthority> {
    if (deployment.paused) throw new PlatformError("WEBSITE_PAUSED", 409, "This chat is paused");
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new PlatformError("WEBSITE_SESSION_REQUIRED", 401, "Website session required");
    const row = (await options.pool.query<{ id: string }>(`SELECT id FROM agents_platform.website_sessions
      WHERE deployment_id=$1 AND token_hash=$2 AND origin=$3 AND expires_at>now()`, [deployment.id, hash(token), websiteOrigin])).rows[0];
    if (!row) throw new PlatformError("WEBSITE_SESSION_EXPIRED", 401, "Website session expired");
    return { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id,
      callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: row.id } };
  }

  const resolveVisitor = async (request: FastifyRequest, reply: FastifyReply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    const authority = await websiteAuthority(request, deployment, websiteOrigin);
    if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Customer session required");
    return { deploymentId: deployment.id, sessionId: authority.principal.sessionId };
  };

  // Saved visitors also preflight the metadata GET because it carries Authorization.
  for (const path of ["/api/website/:deploymentId", "/api/website/:deploymentId/*"]) {
    app.options(path, async (request, reply) => { await websiteContext(request, reply); return reply.code(204).send(); });
  }

  app.get("/api/website/:deploymentId", async (request, reply) => {
    const { deployment } = await websiteContext(request, reply);
    const row = (await options.pool.query<{ name: string }>("SELECT name FROM agents_platform.agents WHERE id=$1 AND organization_id=$2",
      [deployment.agent_id, deployment.organization_id])).rows[0];
    const version = (await options.pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$2",
      [deployment.version_id, deployment.organization_id])).rows[0];
    return { name: row?.name ?? "Assistant", appearance: options.parseAppearance(deployment.appearance), paused: deployment.paused,
      followupPreferencesAvailable: true, followupEnabled: options.followup.enabled ? await options.followup.ready() : false,
      nativeEnquiryEnabled: Boolean(version?.configuration.capabilities?.enquiries?.enabled),
      intakeEnabled: Boolean(version?.configuration.connectedToolBindingIds.length || version?.configuration.capabilities?.enquiries?.enabled),
      bookingEnabled: Boolean(version?.configuration.capabilities?.businessActions?.enabled) };
  });

  app.get("/api/website/:deploymentId/widget.js", async (request, reply) => {
    const deploymentId = uuid.parse(parameters(request).deploymentId);
    const deployment = await options.store.getWebsiteDeployment(deploymentId);
    return reply.type("application/javascript; charset=utf-8").send(options.widgetScript(deploymentId, deployment.appearance));
  });

  app.post("/api/website/:deploymentId/session", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    await publicRate(deployment.id);
    await options.pool.query(`DELETE FROM agents_platform.website_sessions s WHERE deployment_id=$1 AND expires_at<=now()
      AND NOT EXISTS(SELECT 1 FROM agents_platform.customer_conversations c WHERE c.session_id=s.id)`, [deployment.id]);
    const token = randomBytes(32).toString("base64url");
    await options.pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",
      [randomUUID(), deployment.id, hash(token), websiteOrigin]);
    return reply.code(201).send({ token });
  });

  app.post("/api/website/:deploymentId/tasks", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply);
    const authority = await websiteAuthority(request, deployment, websiteOrigin);
    const input = z.strictObject({ input: z.string().min(1), requestKey: z.string().trim().min(1).max(128), conversationId: z.uuid().optional() }).parse(request.body);
    await publicRate(deployment.id);
    if (authority.principal.kind !== "visitor") throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const scope = { deploymentId: deployment.id, sessionId: authority.principal.sessionId };
    const result = await options.inbox.firstMessage(scope, { requestKey: input.requestKey, body: input.input }, input.conversationId);
    const task = result.message.task_id ? await options.store.getTask(authority, result.message.task_id) : null;
    return reply.code(result.replayed ? 200 : 202).send({ task: task ? await options.presentTask(task) : null,
      customerConversationId: result.conversation.id, state: result.conversation.state });
  });

  app.get("/api/website/:deploymentId/tasks/:taskId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    const task = await options.store.getTask(authority, uuid.parse(parameters(request).taskId));
    return { task: await options.presentTask(task), events: (await options.store.listTaskEvents(authority, task.id)).map(options.present) };
  });

  app.get("/api/website/:deploymentId/tasks/:taskId/evidence", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    return options.passages(await options.store.getTask(authority, uuid.parse(parameters(request).taskId)));
  });

  app.get("/api/website/:deploymentId/conversations/:conversationId", async (request, reply) => {
    const { deployment, websiteOrigin } = await websiteContext(request, reply), authority = await websiteAuthority(request, deployment, websiteOrigin);
    return { tasks: await Promise.all((await options.store.getConversation(authority, uuid.parse(parameters(request).conversationId))).map(options.presentTask)) };
  });

  return { resolveVisitor, publicRate };
}
