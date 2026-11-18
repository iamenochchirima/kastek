import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { Applications } from "../../platform/access";
import type { TaskRecord } from "../../contracts/records";
import { requirePermission } from "../../platform/access";
import type { ApplicationRunSnapshot, ApplicationRunStartResponse } from "@kasitek-labs/contracts";

export function registerApplicationRoutes(app: FastifyInstance, options: {
  pool: Pool; resolveScope(request: FastifyRequest): Promise<{ accountId: string; organizationId: string }>;
  runs?: {
    start(input: { organizationId: string; applicationId: string; credentialId: string; agentId: string; message: string; requestId: string; conversationId?: string }): Promise<{ task: TaskRecord; replayed: boolean }>;
    read(task: TaskRecord): Promise<unknown>;
    steer(task: TaskRecord, input: { instruction: string; requestKey: string }): Promise<unknown>;
    cancel(task: TaskRecord): Promise<unknown>;
  };
}) {
  const applications = new Applications(options.pool, async (db, owner) => {
    const membership = await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [owner.organizationId, owner.accountId]);
    if (!membership.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    await requirePermission(db, owner, "credentials.manage");
  });
  const base = "/api/organizations/:organizationId/applications";
  app.get(base, async request => ({ applications: await applications.list(await options.resolveScope(request)) }));
  app.post(base, async (request, reply) => reply.code(201).header("cache-control", "no-store").send(await applications.create(await options.resolveScope(request), request.body)));
  app.post(`${base}/:applicationId/revoke`, async request => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return applications.revoke(await options.resolveScope(request), applicationId);
  });
  app.put(`${base}/:applicationId/agents`, async request => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return applications.assignAgents(await options.resolveScope(request), applicationId, request.body);
  });
  app.post(`${base}/:applicationId/credentials`, async (request, reply) => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return reply.code(201).header("cache-control", "no-store").send(await applications.issueCredential(await options.resolveScope(request), applicationId, request.body));
  });
  app.post(`${base}/:applicationId/credentials/:credentialId/revoke`, async request => {
    const { applicationId, credentialId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid(), credentialId: z.uuid() }).parse(request.params);
    return applications.revokeCredential(await options.resolveScope(request), applicationId, credentialId);
  });
  app.get("/v1/agents", async (request, reply) => {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return reply.header("cache-control", "private, no-store").send({ agents: await applications.listAgents(match[1]!) });
  });
  app.get("/v1/agents/:agentId", async (request, reply) => {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    const { agentId } = z.strictObject({ agentId: z.uuid() }).parse(request.params);
    return reply.header("cache-control", "private, no-store").send({ agent: await applications.inspectAgent(match[1]!, agentId) });
  });
  if (!options.runs) return;
  const runs = options.runs;
  function bearer(request: FastifyRequest): string {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return match[1]!;
  }
  async function accessRun(request: FastifyRequest, scope: "runs:read" | "runs:control") {
    const caller = await applications.authenticate(bearer(request), scope);
    const { taskId } = z.strictObject({ taskId: z.uuid() }).parse(request.params);
    const task = (await options.pool.query<TaskRecord>(`SELECT t.* FROM agents_platform.tasks t
      JOIN agents_platform.applications a ON a.id=$2 AND a.organization_id=t.organization_id AND a.revoked_at IS NULL
      JOIN agents_platform.application_credentials k ON k.id=$3 AND k.application_id=a.id AND k.organization_id=a.organization_id AND k.revoked_at IS NULL
      JOIN agents_platform.agents agent ON agent.id::text=t.resource_id AND agent.organization_id=t.organization_id AND agent.deleted_at IS NULL
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.id=$1 AND t.organization_id=$4 AND t.parent_task_id IS NULL AND t.principal->>'kind'='application'
        AND t.principal->>'applicationId'=a.id::text AND agent.id=ANY(a.agent_ids) AND $5=ANY(k.scopes)`,
    [taskId, caller.applicationId, caller.credentialId, caller.organizationId, scope])).rows[0];
    if (!task) throw new PlatformError("NOT_FOUND", 404, "Run not found");
    return task;
  }
  app.post("/v1/runs", async (request, reply) => {
    const caller = await applications.authenticate(bearer(request), "runs:start");
    const input = z.strictObject({ agentId: z.uuid(), message: z.string().trim().min(1).max(65536),
      requestId: z.uuid(), conversationId: z.uuid().optional() }).parse(request.body);
    const result = await runs.start({ ...caller, ...input });
    const payload: ApplicationRunStartResponse = {
      taskId: result.task.id, conversationId: result.task.conversation_id, state: result.task.state, replayed: result.replayed };
    return reply.code(result.replayed ? 200 : 202).header("cache-control", "no-store").send(payload);
  });
  app.get("/v1/runs/:taskId", async (request, reply) => {
    const snapshot = await runs.read(await accessRun(request, "runs:read")) as ApplicationRunSnapshot;
    return reply.header("cache-control", "private, no-store").send(snapshot);
  });
  app.get("/v1/runs/:taskId/events", async (request, reply) => {
    // Each event is a current, authorized snapshot. Reconnection starts with a new snapshot;
    // no client cursor is needed and no unpublished internal events enter the stream.
    const task = await accessRun(request, "runs:read");
    const snapshot = await runs.read(task);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
      "connection": "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined, last = "", lastWrite = Date.now();
    reply.raw.on("close", () => { closed = true; if (timer) clearTimeout(timer); });
    const emit = (data: unknown) => { const value = JSON.stringify(data); if (value !== last) {
      reply.raw.write(`event: snapshot\ndata: ${value}\n\n`); last = value; lastWrite = Date.now(); } };
    emit(snapshot);
    if (terminalTaskStates.has(task.state)) { reply.raw.end(); return; }
    const poll = async () => {
      if (closed) return;
      try {
        const current = await accessRun(request, "runs:read");
        const data = await runs.read(current);
        if (closed) return;
        emit(data);
        if (terminalTaskStates.has(current.state)) { reply.raw.end(); return; }
        if (Date.now() - lastWrite >= 15000) { reply.raw.write(": keep-alive\n\n"); lastWrite = Date.now(); }
        timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!closed) { reply.raw.write("event: unavailable\ndata: {}\n\n"); reply.raw.end(); }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
  });
  app.post("/v1/runs/:taskId/instructions", async request => {
    const task = await accessRun(request, "runs:control");
    const input = z.strictObject({ instruction: z.string().trim().min(1).max(4000), requestKey: z.uuid() }).parse(request.body);
    return runs.steer(task, input);
  });
  app.post("/v1/runs/:taskId/cancel", async request => {
    z.strictObject({}).parse(request.body ?? {});
    return runs.cancel(await accessRun(request, "runs:control"));
  });
}
