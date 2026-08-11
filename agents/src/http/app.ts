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
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { ModelCallRepository } from "../db/repositories/model-call-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import { MemoryRepository } from "../db/repositories/memory-repository";
import { chunkKnowledgeText, fetchBoundedKnowledgeDocument } from "../knowledge/ingestion";
import { EvaluationRepository } from "../db/repositories/evaluation-repository";
import { evaluateDeterministicAssertions, evaluationAssertionSchema } from "../evaluations/deterministic";
import { AuditRepository } from "../db/repositories/audit-repository";
import { ScheduleRepository } from "../db/repositories/schedule-repository";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { parseCanonicalMessageContent } from "../channels/messages";
import { authenticateRequest, type AuthContext } from "./auth";
import type { ApprovalSignal, CancellationSignal } from "../temporal/contracts";
import { formatSseComment, formatSseEvent } from "./sse";
import { KASIAI_SLUG } from "../system/kasiai";
import { PlatformChatRepository } from "../db/repositories/platform-chat-repository";
import { listAgentTemplates, parseTemplateSettings } from "../system/templates";

export interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  agents?: AgentRepository;
  runs?: RunRepository;
  conversations?: ConversationRepository;
  platformChat?: PlatformChatRepository;
  runSteps?: RunStepRepository;
  toolInvocations?: ToolInvocationRepository;
  toolGrants?: ToolGrantRepository;
  modelCalls?: ModelCallRepository;
  channels?: ChannelRepository;
  credentials?: CredentialVaultRepository;
  knowledge?: KnowledgeRepository;
  memory?: MemoryRepository;
  evaluations?: EvaluationRepository;
  audits?: AuditRepository;
  schedules?: ScheduleRepository;
  killSwitches?: KillSwitchRepository;
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

function requireScope(auth: AuthContext, config: AppConfig, scope: string): void {
  if (config.AUTH_MODE === "headers") return;
  if (!auth.scopes.includes(scope)) {
    throw Object.assign(new Error(`Missing internal scope: ${scope}`), { statusCode: 403 });
  }
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: { level: dependencies.config.LOG_LEVEL } });
  const agents = dependencies.agents ?? new AgentRepository(dependencies.pool);
  const runs = dependencies.runs ?? new RunRepository(dependencies.pool);
  const conversations = dependencies.conversations ?? new ConversationRepository(dependencies.pool);
  const platformChat = dependencies.platformChat ?? new PlatformChatRepository(dependencies.pool);
  const runSteps = dependencies.runSteps ?? new RunStepRepository(dependencies.pool);
  const toolInvocations = dependencies.toolInvocations ?? new ToolInvocationRepository(dependencies.pool);
  const toolGrants = dependencies.toolGrants ?? new ToolGrantRepository(dependencies.pool);
  const modelCalls = dependencies.modelCalls ?? new ModelCallRepository(dependencies.pool);
  const channels = dependencies.channels ?? new ChannelRepository(dependencies.pool);
  const credentials = dependencies.credentials ?? new CredentialVaultRepository(dependencies.pool, dependencies.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
  const knowledge = dependencies.knowledge ?? new KnowledgeRepository(dependencies.pool);
  const memory = dependencies.memory ?? new MemoryRepository(dependencies.pool);
  const evaluations = dependencies.evaluations ?? new EvaluationRepository(dependencies.pool);
  const audits = dependencies.audits ?? new AuditRepository(dependencies.pool);
  const schedules = dependencies.schedules ?? new ScheduleRepository(dependencies.pool);
  const killSwitches = dependencies.killSwitches ?? new KillSwitchRepository(dependencies.pool);

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
    requireScope(auth, dependencies.config, "agents:read");
    return { agents: await agents.listAgents(auth.organizationId) };
  });

  app.get("/v1/templates", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { templates: listAgentTemplates() };
  });

  app.post<{ Params: { templateKey: string } }>("/v1/templates/:templateKey/install", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      settings: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body ?? {});
    const installed = await agents.installTemplate({ organizationId: auth.organizationId, actorId: auth.actorId, templateKey: request.params.templateKey, ...input, settings: parseTemplateSettings(input.settings) });
    return reply.code(installed.created ? 201 : 200).send(installed);
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
    "/v1/agents/:agentId/versions/:versionId/tools",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      const input = z.object({ toolName: z.string().trim().min(1).max(160) }).parse(request.body);
      const grant = await toolGrants.grantVersionTool({
        organizationId: auth.organizationId,
        agentId: request.params.agentId,
        versionId: request.params.versionId,
        toolName: input.toolName,
        actorId: auth.actorId,
      });
      return reply.code(201).send(grant);
    },
  );

  app.get<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/tools",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      return { grants: await toolGrants.listForVersion(auth.organizationId, request.params.versionId) };
    },
  );

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/tools", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ toolName: z.string().trim().min(1).max(160) }).parse(request.body);
    const grant = await toolGrants.grantInstallationTool({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      toolName: input.toolName,
      actorId: auth.actorId,
    });
    return reply.code(201).send(grant);
  });

  app.delete<{ Params: { grantId: string } }>("/v1/tool-grants/:grantId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    await toolGrants.revoke({ organizationId: auth.organizationId, grantId: request.params.grantId, actorId: auth.actorId });
    return reply.code(204).send();
  });

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

  app.get("/v1/system-agents/kasiai/installation", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "kasiai:read");
    const installation = await agents.getSystemInstallation({
      organizationId: auth.organizationId,
      systemSlug: KASIAI_SLUG,
    });
    if (!installation) return reply.code(404).send({ error: "kasiai_installation_not_found" });
    return reply.send(installation);
  });

  app.post("/v1/system-agents/kasiai/installation", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "kasiai:write");
    const settings = z
      .object({
        language: z.string().trim().min(2).max(35).optional(),
        tone: z.enum(["concise", "balanced", "detailed"]).optional(),
        responseDetail: z.enum(["short", "standard", "expanded"]).optional(),
      })
      .parse(request.body ?? {});
    const installation = await agents.ensureSystemInstallation({
      organizationId: auth.organizationId,
      actorId: auth.actorId,
      systemSlug: KASIAI_SLUG,
      settings,
    });
    return reply.code(installation.created ? 201 : 200).send(installation);
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/conversation",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:read");
      const resolved = await platformChat.resolveConversation({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
      });
      const messages = await conversations.listMessages(auth.organizationId, resolved.conversation.id);
      return reply.send({ ...resolved, messages });
    },
  );

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/messages",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const input = z.object({
        message: z.string().trim().min(1).max(20_000),
        idempotencyKey: z.string().trim().min(8).max(240),
        context: z.object({
          route: z.string().trim().max(500).optional(),
          pageTitle: z.string().trim().max(240).optional(),
          resourceType: z.string().trim().max(80).optional(),
          resourceId: z.string().trim().max(240).optional(),
        }).strict().optional(),
      }).parse(request.body);
      const accepted = await platformChat.acceptMessage({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
        ...input,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.run.status === "received") {
        try {
          await dependencies.startWorkflow(accepted.run.id);
        } catch (error) {
          await runs.appendEvent({
            organizationId: auth.organizationId,
            runId: accepted.run.id,
            installationId: request.params.installationId,
            eventType: "run.dispatch_failed",
            payload: {
              message: error instanceof Error ? error.message : "Unable to dispatch workflow",
              retryable: true,
            },
          });
          throw error;
        }
      }
      return reply.code(202).send({
        conversation: accepted.conversation,
        message: accepted.message,
        runId: accepted.run.id,
        status: accepted.run.status,
        created: accepted.created,
        durable: workflowEnabled,
      });
    },
  );

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/schedules", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ expression: z.string().trim().min(1).max(240), timezone: z.string().trim().min(1).max(80).default("UTC"), input: z.record(z.string(), z.unknown()).default({}), nextRunAt: z.string().datetime().optional() }).parse(request.body);
    const schedule = await schedules.create({ organizationId: auth.organizationId, installationId: request.params.installationId, expression: input.expression, timezone: input.timezone, scheduleInput: input.input, nextRunAt: input.nextRunAt, actorId: auth.actorId });
    return reply.code(201).send(schedule);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/schedules", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return { schedules: await schedules.list(auth.organizationId, request.params.installationId) };
  });

  app.post<{ Params: { scheduleId: string; status: "active" | "paused" | "disabled" } }>("/v1/schedules/:scheduleId/status/:status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const status = z.enum(["active", "paused", "disabled"]).parse(request.params.status);
    return schedules.setStatus(auth.organizationId, request.params.scheduleId, status, auth.actorId);
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/channels", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({
      channelType: z.string().trim().min(1).max(80),
      channelKey: z.string().trim().min(1).max(160),
      credentialReference: z.string().trim().max(240).optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    const connection = await channels.createConnection({ organizationId: auth.organizationId, installationId: request.params.installationId, ...input, actorId: auth.actorId });
    return reply.code(201).send(connection);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/channels", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const [connections, bindings] = await Promise.all([
      channels.listConnections(auth.organizationId, request.params.installationId),
      channels.listBindings(auth.organizationId, request.params.installationId),
    ]);
    return { connections, bindings };
  });

  app.post<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId/bindings", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ externalIdentity: z.string().trim().min(1).max(240), routingKey: z.string().trim().max(160).default("default") }).parse(request.body);
    const binding = await channels.bind({ organizationId: auth.organizationId, installationId: request.params.installationId, connectionId: request.params.connectionId, ...input });
    return reply.code(201).send(binding);
  });

  app.post<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId/pairing", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ externalIdentity: z.string().trim().min(1).max(240), ttlSeconds: z.number().int().positive().max(86_400).optional() }).parse(request.body);
    const pairing = await channels.issuePairingToken({ organizationId: auth.organizationId, installationId: request.params.installationId, connectionId: request.params.connectionId, externalIdentity: input.externalIdentity, ttlSeconds: input.ttlSeconds, actorId: auth.actorId });
    return reply.code(201).send(pairing);
  });

  app.post("/v1/channel-pairing/consume", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ token: z.string().trim().min(20).max(200) }).parse(request.body);
    const binding = await channels.consumePairingToken({ organizationId: auth.organizationId, token: input.token });
    return reply.code(201).send(binding);
  });

  app.delete<{ Params: { bindingId: string } }>("/v1/channel-bindings/:bindingId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    await channels.revokeBinding(auth.organizationId, request.params.bindingId);
    return reply.code(204).send();
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
      input.content = parseCanonicalMessageContent(input.messageType, input.content);
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
      requireScope(auth, dependencies.config, "chat:read");
      const conversation = await conversations.getConversation(auth.organizationId, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      const messages = await conversations.listMessages(auth.organizationId, conversation.id);
      const participants = await conversations.listParticipants(auth.organizationId, conversation.id);
      return { conversation, messages, participants };
    },
  );

  app.post<{ Params: { conversationId: string; status: "active" | "archived" | "deleted" } }>("/v1/conversations/:conversationId/status/:status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const status = z.enum(["active", "archived", "deleted"]).parse(request.params.status);
    return conversations.setStatus(auth.organizationId, request.params.conversationId, status);
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/participants", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ participantType: z.enum(["user", "customer", "staff", "agent", "system"]), externalId: z.string().trim().max(240).optional(), displayName: z.string().trim().max(240).optional() }).parse(request.body);
    const participant = await conversations.createParticipant({ organizationId: auth.organizationId, conversationId: request.params.conversationId, ...input });
    return reply.code(201).send(participant);
  });

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
    requireScope(auth, dependencies.config, "runs:read");
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

  app.get("/v1/operations/summary", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const [runsSummary, modelSummary, toolSummary] = await Promise.all([
      runs.operationalSummary(auth.organizationId),
      modelCalls.usageSummary(auth.organizationId),
      toolInvocations.outcomeSummary(auth.organizationId),
    ]);
    return {
      organizationId: auth.organizationId,
      generatedAt: new Date().toISOString(),
      runs: runsSummary,
      models: modelSummary,
      tools: toolSummary,
    };
  });

  app.get<{ Querystring: { action?: string; resourceType?: string; limit?: string } }>("/v1/audit", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid audit limit");
    return { records: await audits.list({ organizationId: auth.organizationId, action: request.query.action, resourceType: request.query.resourceType, limit }) };
  });

  app.get("/v1/operations/kill-switches", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return { killSwitches: await killSwitches.list(auth.organizationId) };
  });

  app.post("/v1/operations/kill-switches", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ scopeType: z.enum(["global", "organization", "agent", "installation", "tool"]), scopeId: z.string().trim().min(1).max(240), reason: z.string().trim().min(1).max(500) }).parse(request.body);
    if (input.scopeType === "global") throw new Error("Global kill switches require platform operator scope");
    const record = await killSwitches.set({ organizationId: auth.organizationId, ...input, actorId: auth.actorId });
    return reply.code(201).send(record);
  });

  app.delete<{ Params: { switchId: string } }>("/v1/operations/kill-switches/:switchId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    await killSwitches.disable(auth.organizationId, request.params.switchId);
    return reply.code(204).send();
  });

  app.post("/v1/credentials", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ provider: z.enum(["openrouter", "openai", "anthropic", "gemini"]), apiKey: z.string().min(1).max(10_000), label: z.string().trim().max(160).optional() }).parse(request.body);
    const credential = await credentials.store({ organizationId: auth.organizationId, actorId: auth.actorId, ...input });
    return reply.code(201).send(credential);
  });

  app.get("/v1/credentials", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return { credentials: await credentials.list(auth.organizationId) };
  });

  app.delete<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    await credentials.revoke(auth.organizationId, request.params.credentialId);
    return reply.code(204).send();
  });

  app.post<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId/rotate", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ apiKey: z.string().min(1).max(10_000), label: z.string().trim().max(160).optional() }).parse(request.body);
    const credential = await credentials.rotate({ organizationId: auth.organizationId, credentialId: request.params.credentialId, actorId: auth.actorId, ...input });
    return reply.code(201).send(credential);
  });

  app.post("/v1/knowledge/sources", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({
      name: z.string().trim().min(1).max(240),
      sourceType: z.enum(["upload", "url", "platform", "manual"]),
      sourceUri: z.string().url().max(2_000).optional(),
      agentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      provenance: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    const source = await knowledge.createSource({ ...input, organizationId: auth.organizationId, actorId: auth.actorId });
    return reply.code(201).send(source);
  });

  app.post<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId/ingest-url", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ url: z.string().url().max(2_000), maxBytes: z.number().int().positive().max(10_000_000).optional(), timeoutMs: z.number().int().positive().max(60_000).optional() }).parse(request.body);
    const source = await knowledge.getSource({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "knowledge_source_not_found" });
    if (!source.agent_definition_id) return reply.code(422).send({ error: "knowledge_source_agent_scope_required" });
    const document = await fetchBoundedKnowledgeDocument(input.url, { maxBytes: input.maxBytes, timeoutMs: input.timeoutMs });
    const chunks = chunkKnowledgeText(document.text);
    if (!chunks.length) return reply.code(422).send({ error: "knowledge_document_empty" });
    const stored = await knowledge.addChunks({
      sourceId: source.id,
      scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
      revision: source.revision + 1,
      chunks: chunks.map((text, index) => ({ text, metadata: { contentType: document.contentType, bytes: document.bytes }, provenance: { url: document.url, fetchedAt: new Date().toISOString(), chunkIndex: index } })),
    });
    return reply.code(201).send({ sourceId: source.id, revision: source.revision + 1, chunks: stored });
  });

  app.get<{ Querystring: { agentId?: string; installationId?: string; limit?: string } }>("/v1/memory", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const agentId = z.string().uuid().parse(request.query.agentId);
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid memory limit");
    return { memories: await memory.listMemory({ organizationId: auth.organizationId, agentId, installationId, actorId: auth.actorId }, limit) };
  });

  app.delete<{ Params: { memoryId: string } }>("/v1/memory/:memoryId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional() }).parse(request.body);
    await memory.deleteMemory({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId, actorId: auth.actorId }, request.params.memoryId, auth.actorId);
    return reply.code(204).send();
  });

  app.post<{ Params: { memoryId: string } }>("/v1/memory/:memoryId/revalidate", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional(), expiresAt: z.string().datetime().nullable() }).parse(request.body);
    return memory.revalidateMemory({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId, actorId: auth.actorId }, request.params.memoryId, input.expiresAt);
  });

  app.get<{ Querystring: { agentId?: string; installationId?: string; limit?: string } }>("/v1/knowledge/sources", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const agentId = request.query.agentId ? z.string().uuid().parse(request.query.agentId) : undefined;
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid knowledge limit");
    return { sources: await knowledge.listSources({ organizationId: auth.organizationId, agentId, installationId }, limit) };
  });

  app.delete<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional() }).parse(request.body);
    await knowledge.deleteSource({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId }, request.params.sourceId, auth.actorId);
    return reply.code(204).send();
  });

  app.post("/v1/evaluations/scenarios", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const input = z.object({
      agentDefinitionId: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(240),
      description: z.string().trim().max(2_000).optional(),
      input: z.record(z.string(), z.unknown()).default({}),
      assertions: z.array(evaluationAssertionSchema).max(100).default([]),
      rubric: z.record(z.string(), z.unknown()).default({}),
      tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    }).parse(request.body);
    const scenario = await evaluations.createScenario({ ...input, scenarioInput: input.input, organizationId: auth.organizationId, actorId: auth.actorId });
    return reply.code(201).send(scenario);
  });

  app.get("/v1/evaluations/scenarios", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    return { scenarios: await evaluations.listScenarios(auth.organizationId) };
  });

  app.post<{ Params: { scenarioId: string } }>("/v1/evaluations/scenarios/:scenarioId/runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    const scenario = await evaluations.getScenario(auth.organizationId, request.params.scenarioId);
    if (!scenario) return reply.code(404).send({ error: "evaluation_scenario_not_found" });
    const input = z.object({ agentVersionId: z.string().uuid().optional(), runId: z.string().uuid().optional(), actualOutput: z.unknown(), evaluatorVersion: z.string().trim().min(1).max(80).default("deterministic-v1") }).parse(request.body);
    const result = evaluateDeterministicAssertions(input.actualOutput, scenario.assertions);
    const run = await evaluations.recordRun({ organizationId: auth.organizationId, scenarioId: scenario.id, agentVersionId: input.agentVersionId, runId: input.runId, status: result.passed ? "passed" : "failed", evaluatorVersion: input.evaluatorVersion, result: { ...result, actualOutput: input.actualOutput }, actorId: auth.actorId });
    return reply.code(201).send(run);
  });

  app.get<{ Querystring: { scenarioId?: string } }>("/v1/evaluations/runs", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    const scenarioId = request.query.scenarioId ? z.string().uuid().parse(request.query.scenarioId) : undefined;
    return { runs: await evaluations.listRuns(auth.organizationId, scenarioId) };
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/runs/:runId/events/stream", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:read");
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
    requireScope(auth, dependencies.config, "runs:cancel");
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
