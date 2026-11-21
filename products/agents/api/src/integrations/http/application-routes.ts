import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import type { ApplicationAccess } from "../../platform/access";
import type { TaskRecord } from "../../contracts/records";
import type { ApplicationAgentBinding, ApplicationAgentPreviewResponse, ApplicationAgentVersionSummary, ApplicationRunSnapshot, ApplicationRunStartResponse } from "@kasitek-labs/contracts";
import { agentConfigurationSchema } from "../../contracts/contracts";

export function registerApplicationRoutes(app: FastifyInstance, options: {
  applications: ApplicationAccess; resolveScope(request: FastifyRequest): Promise<{ accountId: string; organizationId: string }>;
  agentManagement?: {
    create(caller: { organizationId: string; applicationId: string; credentialId: string }, input: { name: string; purpose?: string; instructions?: string; operationId: string }): Promise<{ id: string; name: string; draftRevision: number }>;
    update(caller: { organizationId: string; applicationId: string; credentialId: string }, agentId: string, input: { name?: string; configuration: unknown; expectedRevision: number }): Promise<{ id: string; name: string; draftRevision: number }>;
    preview(caller: { organizationId: string; applicationId: string; credentialId: string }, agentId: string, input: { configuration: unknown }): Promise<ApplicationAgentPreviewResponse>;
    publish(caller: { organizationId: string; applicationId: string; credentialId: string }, agentId: string, input: { expectedRevision: number }): Promise<ApplicationAgentVersionSummary>;
    bind(caller: { organizationId: string; applicationId: string; credentialId: string }, agentId: string, input: { versionId?: string; allowedOrigins: string[] }): Promise<ApplicationAgentBinding>;
  };
  runs?: {
    start(input: { organizationId: string; applicationId: string; credentialId: string; agentId: string; message: string; requestId: string; conversationId?: string; delegated?: { subject: string; assertionDigest: string; issuedAt: string; expiresAt: string } }): Promise<{ task: TaskRecord; replayed: boolean }>;
    read(task: TaskRecord): Promise<unknown>;
    steer(task: TaskRecord, input: { instruction: string; requestKey: string }): Promise<unknown>;
    cancel(task: TaskRecord): Promise<unknown>;
  };
}) {
  const { applications } = options;
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
  app.post(`${base}/:applicationId/keys`, async (request, reply) => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return reply.code(201).header("cache-control", "no-store").send(await applications.registerKey(await options.resolveScope(request), applicationId, request.body));
  });
  app.post(`${base}/:applicationId/keys/:keyId/revoke`, async request => {
    const { applicationId, keyId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid(), keyId: z.uuid() }).parse(request.params);
    return applications.revokeKey(await options.resolveScope(request), applicationId, keyId);
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
  const runs = options.runs;
  function bearer(request: FastifyRequest): string {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return match[1]!;
  }
  app.post("/v1/conversations", async (request, reply) => {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
  if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
  return reply.code(201).send(await applications.createConversation(match[1]!, request.body));
  });
  app.get("/v1/conversations/:conversationId", async (request, reply) => {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
  if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
  const { conversationId } = z.strictObject({ conversationId: z.uuid() }).parse(request.params);
  return reply.header("cache-control", "private, no-store").send(await applications.readConversation(match[1]!, conversationId));
  });
  const management = options.agentManagement;
  if (management) {
    const agentId = (request: FastifyRequest) => z.strictObject({ agentId: z.uuid() }).parse(request.params).agentId;
  app.post("/v1/agents", async (request, reply) => {
      const caller = await applications.authenticate(bearer(request), "agents:manage");
      const input = z.strictObject({ name: z.string().trim().min(1).max(120), purpose: z.string().trim().min(1).max(600).optional(),
        instructions: z.string().trim().min(1).max(8000).optional(), operationId: z.uuid() }).parse(request.body);
      return reply.code(201).send({ agent: await management.create(caller, input) });
    });
    app.patch("/v1/agents/:agentId", async (request, reply) => {
      const caller = await applications.authenticate(bearer(request), "agents:manage");
      const input = z.strictObject({ name: z.string().trim().min(1).max(120).optional(),
        configuration: agentConfigurationSchema, expectedRevision: z.number().int().positive() }).parse(request.body);
      return reply.send({ agent: await management.update(caller, agentId(request), input) });
    });
    app.post("/v1/agents/:agentId/preview", async (request, reply) => {
      const caller = await applications.authenticate(bearer(request), "agents:manage");
      const input = z.strictObject({ configuration: agentConfigurationSchema }).parse(request.body);
      return reply.send(await management.preview(caller, agentId(request), input));
    });
    app.post("/v1/agents/:agentId/versions", async (request, reply) => {
      const caller = await applications.authenticate(bearer(request), "agents:publish");
      const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(request.body);
      return reply.code(201).send({ version: await management.publish(caller, agentId(request), input) });
    });
    app.post("/v1/agents/:agentId/deployments", async (request, reply) => {
      const caller = await applications.authenticate(bearer(request), "agents:publish");
      const input = z.strictObject({ versionId: z.uuid().optional(), allowedOrigins: z.array(z.string()).min(1).max(10) }).parse(request.body);
      return reply.code(201).send({ deployment: await management.bind(caller, agentId(request), input) });
    });
  }
  if (!runs) return;
  async function accessRun(request: FastifyRequest, scope: "runs:read" | "runs:control") {
    const { taskId } = z.strictObject({ taskId: z.uuid() }).parse(request.params);
    return applications.authorizedRun(bearer(request), taskId, scope);
  }
  app.post("/v1/runs", async (request, reply) => {
    const caller = await applications.authenticate(bearer(request), "runs:start");
    const input = z.strictObject({ agentId: z.uuid(), message: z.string().trim().min(1).max(65536),
      requestId: z.uuid(), conversationId: z.uuid().optional(), assertion: z.string().min(1).max(8192).optional() }).parse(request.body);
    const delegated = input.assertion ? await applications.verifyAssertion(bearer(request), input.assertion) : undefined;
    const result = await runs.start({ ...caller, ...input, ...(delegated ? { delegated: { subject: delegated.subject,
      assertionDigest: delegated.assertionDigest, issuedAt: delegated.issuedAt, expiresAt: delegated.expiresAt } } : {}) });
    const payload: ApplicationRunStartResponse = {
      taskId: result.task.id, conversationId: result.task.conversation_id, state: result.task.state, replayed: result.replayed };
    return reply.code(result.replayed ? 200 : 202).header("cache-control", "no-store").send(payload);
  });
  app.get("/v1/runs/:taskId/pending", async (request, reply) => {
    const task = await accessRun(request, "runs:read");
    return reply.header("cache-control", "private, no-store").send({ taskId: task.id, state: task.state,
      pending: await applications.pendingReviews(task.organization_id, task.id) });
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
