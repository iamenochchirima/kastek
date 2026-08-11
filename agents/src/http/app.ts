import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import {
  createAgentInputSchema,
  createInstallationInputSchema,
  createVersionInputSchema,
  startRunInputSchema,
} from "../domain/types";
import { AgentRepository } from "../db/repositories/agent-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { RunStepRepository } from "../db/repositories/run-step-repository";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { authenticateRequest, type AuthContext } from "./auth";
import type { ApprovalSignal, CancellationSignal } from "../temporal/contracts";
import { formatSseComment, formatSseEvent } from "./sse";

export interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  agents?: AgentRepository;
  runs?: RunRepository;
  conversations?: ConversationRepository;
  runSteps?: RunStepRepository;
  toolInvocations?: ToolInvocationRepository;
  startWorkflow?: (runId: string) => Promise<void>;
  signalApproval?: (runId: string, signal: ApprovalSignal) => Promise<void>;
  signalCancellation?: (runId: string, signal: CancellationSignal) => Promise<void>;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireAuth(request: FastifyRequest, config: AppConfig): AuthContext {
  return authenticateRequest(
    {
      authorization: headerValue(request, "authorization"),
      organizationId: headerValue(request, "x-organization-id"),
      actorId: headerValue(request, "x-actor-id"),
    },
    config,
  );
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: { level: dependencies.config.LOG_LEVEL } });
  const agents = dependencies.agents ?? new AgentRepository(dependencies.pool);
  const runs = dependencies.runs ?? new RunRepository(dependencies.pool);
  const conversations = dependencies.conversations ?? new ConversationRepository(dependencies.pool);
  const runSteps = dependencies.runSteps ?? new RunStepRepository(dependencies.pool);
  const toolInvocations = dependencies.toolInvocations ?? new ToolInvocationRepository(dependencies.pool);

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof ZodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 500);
    if (statusCode >= 500) app.log.error(error);
    const message = error instanceof ZodError ? "Invalid request" : error instanceof Error ? error.message : "Request failed";
    reply.code(statusCode).send({ error: statusCode >= 500 ? "internal_error" : message });
  });

  app.get("/health/live", async () => ({ status: "ok", service: "kasitek-agents" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await dependencies.pool.query("SELECT 1");
      return { status: "ready", temporalEnabled: dependencies.config.TEMPORAL_ENABLED };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/v1/agents", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = createAgentInputSchema.parse(request.body);
    const agent = await agents.createAgent(auth.organizationId, auth.actorId, input);
    return reply.code(201).send(agent);
  });

  app.get("/v1/agents", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return { agents: await agents.listAgents(auth.organizationId) };
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/versions", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const agent = await agents.getAgent(auth.organizationId, request.params.agentId);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return { versions: await agents.listVersions(auth.organizationId, request.params.agentId) };
  });

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/versions", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = createVersionInputSchema.parse(request.body);
    const version = await agents.createVersion(auth.organizationId, auth.actorId, request.params.agentId, input);
    return reply.code(201).send(version);
  });

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/publish",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      const version = await agents.publishVersion(
        auth.organizationId,
        auth.actorId,
        request.params.agentId,
        request.params.versionId,
      );
      return reply.send(version);
    },
  );

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/rollback",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      return agents.rollbackVersion(auth.organizationId, auth.actorId, request.params.agentId, request.params.versionId);
    },
  );

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/retire",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      return agents.retireVersion(auth.organizationId, auth.actorId, request.params.agentId, request.params.versionId);
    },
  );

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/archive", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return agents.archiveAgent(auth.organizationId, auth.actorId, request.params.agentId);
  });

  app.post("/v1/installations", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = createInstallationInputSchema.parse(request.body);
    const installation = await agents.createInstallation(auth.organizationId, auth.actorId, input);
    return reply.code(201).send(installation);
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/conversations",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      const input = z
        .object({
          channelType: z.string().trim().min(1).max(80).default("platform"),
          channelKey: z.string().trim().min(1).max(160).default("platform"),
          externalConversationId: z.string().trim().max(240).optional(),
          title: z.string().trim().max(240).optional(),
        })
        .parse(request.body);
      const conversation = await conversations.createConversation({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        ...input,
      });
      return reply.code(201).send(conversation);
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      const input = z
        .object({
          participantId: z.string().uuid().optional(),
          direction: z.enum(["inbound", "outbound", "system"]),
          messageType: z.string().trim().min(1).max(80).default("text"),
          content: z.record(z.string(), z.unknown()),
          provider: z.string().trim().max(80).optional(),
          providerMessageId: z.string().trim().max(240).optional(),
        })
        .parse(request.body);
      const message = await conversations.appendMessage({
        organizationId: auth.organizationId,
        conversationId: request.params.conversationId,
        ...input,
      });
      return reply.code(201).send(message);
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      const conversation = await conversations.getConversation(auth.organizationId, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      const messages = await conversations.listMessages(auth.organizationId, conversation.id);
      return { conversation, messages };
    },
  );

  app.post<{ Params: { installationId: string; status: "active" | "paused" | "disabled" } }>(
    "/v1/installations/:installationId/status/:status",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      const status = z.enum(["active", "paused", "disabled"]).parse(request.params.status);
      return agents.setInstallationStatus(auth.organizationId, request.params.installationId, status, auth.actorId);
    },
  );

  app.post("/v1/runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = startRunInputSchema.parse(request.body);
    const run = await runs.createRun(auth.organizationId, auth.actorId, input);
    if (run.created !== false && dependencies.config.TEMPORAL_ENABLED && dependencies.startWorkflow) {
      try {
        await dependencies.startWorkflow(run.id);
      } catch (error) {
        await runs.failRun(run.id, {
          code: "WORKFLOW_START_FAILED",
          message: error instanceof Error ? error.message : "Unable to start workflow",
        });
        throw error;
      }
    }
    return reply.code(202).send({ runId: run.id, status: run.status, durable: Boolean(dependencies.startWorkflow) });
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const events = await runs.listEvents(auth.organizationId, run.id);
    return { run, events };
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/timeline", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const [events, steps, toolCalls] = await Promise.all([
      runs.listEvents(auth.organizationId, run.id),
      runSteps.listSteps(auth.organizationId, run.id),
      toolInvocations.list(auth.organizationId, run.id),
    ]);
    return { run, events, steps, toolCalls };
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/runs/:runId/events/stream", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const parsedAfter = request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0) return reply.code(400).send({ error: "invalid_after_cursor" });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let cursor = parsedAfter;
    let closed = false;
    let polling = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      response.end();
    };
    const poll = async (): Promise<void> => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = await runs.listEventsAfter(auth.organizationId, run.id, cursor);
        for (const event of events) {
          response.write(formatSseEvent(event));
          const sequence = Number(event.sequence_number);
          if (Number.isSafeInteger(sequence)) cursor = sequence;
        }
        if (!events.length) response.write(formatSseComment("keep-alive"));
        const latest = await runs.getRun(auth.organizationId, run.id);
        if (latest && ["completed", "failed", "cancelled", "expired"].includes(latest.status) && !events.length) close();
      } catch {
        if (!closed) {
          response.write(`event: agent.stream_error\ndata: ${JSON.stringify({ error: "stream_poll_failed" })}\n\n`);
          close();
        }
      } finally {
        polling = false;
      }
    };
    request.raw.on("close", close);
    const timer = setInterval(() => void poll(), 1000);
    await poll();
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/approval", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.status !== "awaiting_approval") return reply.code(409).send({ error: "run_not_awaiting_approval" });
    if (!dependencies.signalApproval) return reply.code(503).send({ error: "temporal_not_configured" });
    const input = z.object({ decision: z.enum(["approved", "rejected"]), argumentsHash: z.string().length(64) }).parse(request.body);
    await dependencies.signalApproval(request.params.runId, { ...input, approvedBy: auth.actorId });
    return reply.code(202).send({ runId: request.params.runId, status: "approval_signalled" });
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/cancel", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) {
      return reply.code(409).send({ error: "run_terminal" });
    }
    if (!dependencies.signalCancellation) return reply.code(503).send({ error: "temporal_not_configured" });
    const input = z.object({ reason: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    await dependencies.signalCancellation(request.params.runId, { reason: `${auth.actorId}: ${input.reason ?? "cancelled"}` });
    return reply.code(202).send({ runId: request.params.runId, status: "cancellation_signalled" });
  });

  return app;
}
