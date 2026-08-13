import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import {
  createAgentInputSchema,
  createInstallationCredentialInputSchema,
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
import { InstallationCredentialRepository } from "../db/repositories/installation-credential-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
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
import type { ApprovalSignal, CancellationSignal, ExternalEventSignal } from "../temporal/contracts";
import { formatSseComment, formatSseEvent, toPublicEvent } from "./sse";
import { KASIAI_SLUG } from "../system/kasiai";
import { PlatformChatRepository } from "../db/repositories/platform-chat-repository";
import { listAgentTemplates, parseTemplateSettings } from "../system/templates";
import { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import { availableKasiAiModels, getKasiAiModelCatalog, isAllowedKasiAiModel } from "../system/kasiai-models";
import { installationTokenJwks, issueInstallationToken, readClientAssertionSubject, verifyClientAssertion, verifyInstallationToken } from "../auth/installation-token";
import { createPublicKey } from "node:crypto";
import { createDefaultTools } from "../temporal/activities";
import { KasitekCoreReadClient } from "../core/client";
import { ToolRegistry } from "../tools/registry";
import { redactSensitiveValue } from "../tools/redaction";
import { randomUUID } from "node:crypto";

const MCP_PROTOCOL_VERSION = "2025-06-18";
import { ConnectorRegistry } from "../connectors";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { InstallationCapabilityError, InstallationCapabilityInvocationService } from "../invocation/installation-capability";
import { InstallationImmediateReadService } from "../invocation/immediate-read";
import { authorizeInstallationCapability } from "../capabilities/authorization";
import { ApprovalDecisionRateLimiter } from "./approval-rate-limit";

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
  installationCredentials?: InstallationCredentialRepository;
  installationGrants?: InstallationGrantRepository;
  toolRegistry?: ToolRegistry;
  connectorRegistry?: ConnectorRegistry;
  effectReceipts?: EffectReceiptRepository;
  approvals?: ApprovalRepository;
  knowledge?: KnowledgeRepository;
  memory?: MemoryRepository;
  evaluations?: EvaluationRepository;
  audits?: AuditRepository;
  schedules?: ScheduleRepository;
  killSwitches?: KillSwitchRepository;
  kasiaiPreferences?: KasiAiPreferenceRepository;
  startWorkflow?: (runId: string) => Promise<void>;
  signalApproval?: (runId: string, signal: ApprovalSignal) => Promise<void>;
  signalCancellation?: (runId: string, signal: CancellationSignal) => Promise<void>;
  signalExternalEvent?: (runId: string, signal: ExternalEventSignal) => Promise<void>;
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
      correlationId: headerValue(request, "x-correlation-id"),
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

interface McpAuthContext extends AuthContext {
  installationId: string;
  credentialId: string;
  agentId: string;
}

async function authenticateInstallationRequest(input: {
  request: FastifyRequest;
  config: AppConfig;
  installationCredentials: InstallationCredentialRepository;
  agents: AgentRepository;
}, audience: "mcp" | "kasitek-public-api"): Promise<McpAuthContext> {
  const authorization = headerValue(input.request, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation token required`), { statusCode: 401 });
  }
  if (!input.config.INSTALLATION_TOKEN_PRIVATE_KEY) {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation token verification is unavailable`), { statusCode: 503 });
  }
  let claims;
  try {
    const publicKeyPem = createPublicKey(input.config.INSTALLATION_TOKEN_PRIVATE_KEY).export({ type: "spki", format: "pem" }).toString();
    claims = verifyInstallationToken(
      authorization.slice("Bearer ".length),
      publicKeyPem,
      audience,
      Math.floor(Date.now() / 1000),
      input.config.INSTALLATION_TOKEN_ISSUER,
    );
  } catch {
    throw Object.assign(new Error(`Invalid ${audience === "mcp" ? "MCP" : "public API"} installation token`), { statusCode: 401 });
  }
  const credential = await input.installationCredentials.getActiveForToken({
    credentialId: claims.credentialId,
    organizationId: claims.organizationId,
    installationId: claims.sub,
  });
  if (!credential) throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation credential is no longer active`), { statusCode: 401 });
  const installation = await input.agents.getInstallation(claims.organizationId, claims.sub);
  if (!installation || installation.status !== "active") {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation is no longer active`), { statusCode: 401 });
  }
  return {
    organizationId: claims.organizationId,
    actorId: `installation:${claims.sub}`,
    correlationId: claims.jti,
    scopes: audience === "mcp" ? credential.mcp_scopes : (credential.api_scopes ?? []),
    installationId: claims.sub,
    credentialId: claims.credentialId,
    agentId: installation.agent_definition_id ?? "",
  };
}

async function authenticateMcpRequest(input: {
  request: FastifyRequest;
  config: AppConfig;
  installationCredentials: InstallationCredentialRepository;
  agents: AgentRepository;
}): Promise<McpAuthContext> {
  return authenticateInstallationRequest(input, "mcp");
}

async function authenticatePublicApiRequest(input: {
  request: FastifyRequest;
  config: AppConfig;
  installationCredentials: InstallationCredentialRepository;
  agents: AgentRepository;
}): Promise<McpAuthContext> {
  return authenticateInstallationRequest(input, "kasitek-public-api");
}

function requireMcpScope(auth: McpAuthContext, scope: "mcp:read" | "mcp:write"): void {
  if (!auth.scopes.includes(scope)) {
    throw Object.assign(new Error(`MCP credential is missing scope: ${scope}`), { statusCode: 403 });
  }
}

function requireApiScope(auth: McpAuthContext, scope: "api:read" | "api:write"): void {
  if (!auth.scopes.includes(scope)) {
    throw Object.assign(new Error(`Public API credential is missing scope: ${scope}`), { statusCode: 403 });
  }
}

function publicApprovalStatus(approval: { status: string; provider_tool_call_id: string; capability: string; arguments_hash: string; resource_snapshot?: Record<string, unknown>; preview_revision?: string; expires_at: string } | null) {
  if (!approval) return null;
  return {
    status: approval.status,
    providerToolCallId: approval.provider_tool_call_id,
    capability: approval.capability,
    argumentsHash: approval.arguments_hash,
    resourceSnapshot: approval.resource_snapshot ?? {},
    previewRevision: approval.preview_revision ?? null,
    expiresAt: approval.expires_at,
  };
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
  const installationCredentials = dependencies.installationCredentials ?? new InstallationCredentialRepository(dependencies.pool);
  const installationGrants = dependencies.installationGrants ?? new InstallationGrantRepository(dependencies.pool);
  const toolRegistry = dependencies.toolRegistry ?? createDefaultTools(new KasitekCoreReadClient(dependencies.config));
  const connectorRegistry = dependencies.connectorRegistry ?? new ConnectorRegistry();
  if (connectorRegistry.list().length === 0) {
    connectorRegistry.register({
      id: "telegram.messaging",
      version: "1.0.0",
      displayName: "Telegram messaging",
      ownerService: "agents",
      auth: "api_key",
      requiredScopes: ["channels:ingest", "channels:deliver"],
      capabilityNames: ["kasitek.core.channel_deliver"],
      rateLimit: { requests: 30, windowSeconds: 60 },
      redactedFields: ["botToken", "accessToken"],
      supportsReconciliation: true,
    });
    connectorRegistry.register({
      id: "discord.messaging",
      version: "1.0.0",
      displayName: "Discord messaging",
      ownerService: "agents",
      auth: "oauth2",
      requiredScopes: ["channels:ingest", "channels:deliver"],
      capabilityNames: ["kasitek.core.channel_deliver"],
      rateLimit: { requests: 30, windowSeconds: 60 },
      redactedFields: ["botToken", "accessToken"],
      supportsReconciliation: true,
    });
  }
  const effectReceipts = dependencies.effectReceipts ?? new EffectReceiptRepository(dependencies.pool);
  const approvals = dependencies.approvals ?? new ApprovalRepository(dependencies.pool);
  const knowledge = dependencies.knowledge ?? new KnowledgeRepository(dependencies.pool);
  const memory = dependencies.memory ?? new MemoryRepository(dependencies.pool);
  const evaluations = dependencies.evaluations ?? new EvaluationRepository(dependencies.pool);
  const audits = dependencies.audits ?? new AuditRepository(dependencies.pool);
  const schedules = dependencies.schedules ?? new ScheduleRepository(dependencies.pool);
  const killSwitches = dependencies.killSwitches ?? new KillSwitchRepository(dependencies.pool);
  const kasiaiPreferences = dependencies.kasiaiPreferences ?? new KasiAiPreferenceRepository(dependencies.pool);
  const approvalDecisionRateLimiter = new ApprovalDecisionRateLimiter(
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_PER_WINDOW,
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_WINDOW_MS,
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_MAX_KEYS,
  );
  const immediateReads = new InstallationImmediateReadService({ runs, toolInvocations, tools: toolRegistry });
  const installationInvocations = new InstallationCapabilityInvocationService({
    agents,
    runs,
    toolGrants,
    installationGrants,
    killSwitches,
    tools: toolRegistry,
    temporalEnabled: dependencies.config.TEMPORAL_ENABLED,
    startWorkflow: dependencies.startWorkflow,
    immediateRead: (input) => immediateReads.execute({
      ...input,
      agentId: input.installation.agent_definition_id ?? "",
      agentVersionId: input.installation.agent_version_id,
    }),
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ZodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 500);
    if (statusCode >= 500) app.log.error(error);
    if (request.url === "/mcp" && request.method === "POST" && statusCode === 400) {
      reply.header("mcp-protocol-version", MCP_PROTOCOL_VERSION);
      return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_mcp_request" } });
    }
    const message = error instanceof ZodError ? "Invalid request" : error instanceof Error ? error.message : "Request failed";
    const code = (error as { code?: string }).code;
    reply.code(statusCode).send({ error: statusCode >= 500 ? "internal_error" : message, ...(code ? { code } : {}) });
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

  app.get("/.well-known/agent-installation-jwks.json", async () => {
    if (!dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY) throw Object.assign(new Error("Installation token signing is not configured"), { statusCode: 503 });
    return installationTokenJwks(dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY);
  });

  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: "/mcp",
    authorization_servers: [],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    installation_token_exchange_endpoint: "/v1/installation-tokens/exchange",
  }));

  app.post("/v1/installation-tokens/exchange", async (request, reply) => {
    const body = z.object({
      secret: z.string().trim().min(20).max(1_000).optional(),
      clientAssertion: z.string().trim().min(1).max(10_000).optional(),
      audience: z.enum(["mcp", "kasitek-public-api"]),
    }).superRefine((value, context) => {
      if ((value.secret === undefined) === (value.clientAssertion === undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: "Provide exactly one of secret or clientAssertion" });
      }
    }).parse(request.body);
    if (!dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY) return reply.code(503).send({ error: "installation_token_exchange_unavailable" });
    let credential;
    if (body.secret) {
      credential = await installationCredentials.authenticate(body.secret);
      if (!credential) return reply.code(401).send({ error: "invalid_installation_credential" });
    } else {
      try {
        const subject = readClientAssertionSubject(body.clientAssertion!);
        const registered = await installationCredentials.getActiveForClientAssertion({ credentialId: subject.credentialId, clientKeyId: subject.keyId });
        if (!registered?.client_public_key || registered.client_key_id !== subject.keyId) throw new Error("Client assertion credential not active");
        const claims = verifyClientAssertion(body.clientAssertion!, registered.client_public_key, { keyId: subject.keyId, credentialId: registered.id });
        const consumed = await installationCredentials.consumeClientAssertionReplay({ credentialId: registered.id, jti: claims.jti, expiresAt: new Date(claims.exp * 1000).toISOString() });
        if (!consumed) throw new Error("Client assertion replayed");
        await installationCredentials.markUsed(registered.id);
        credential = registered;
      } catch {
        return reply.code(401).send({ error: "invalid_installation_client_assertion" });
      }
    }
    const token = issueInstallationToken({
      privateKeyPem: dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY,
      issuer: dependencies.config.INSTALLATION_TOKEN_ISSUER,
      installationId: credential.installation_id,
      organizationId: credential.organization_id,
      credentialId: credential.id,
      audience: body.audience,
    });
    return reply.send({ accessToken: token.accessToken, tokenType: "Bearer", expiresAt: token.expiresAt, audience: body.audience });
  });

  app.post("/mcp", async (request, reply) => {
    const body = z.object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number(), z.null()]).optional(),
      method: z.string().min(1).max(120),
      params: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    const respond = (result: unknown) => body.id === undefined ? reply.code(204).send() : reply.send({ jsonrpc: "2.0", id: body.id, result });
    const failure = (code: number, message: string, data?: unknown) => body.id === undefined ? reply.code(204).send() : reply.send({ jsonrpc: "2.0", id: body.id, error: { code, message, ...(data === undefined ? {} : { data }) } });
    const headerProtocol = request.headers["mcp-protocol-version"];
    const requestedProtocol = typeof headerProtocol === "string"
      ? headerProtocol
      : typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : undefined;
    if (requestedProtocol && requestedProtocol !== MCP_PROTOCOL_VERSION) {
      reply.header("mcp-protocol-version", MCP_PROTOCOL_VERSION);
      return failure(-32602, "unsupported_mcp_protocol_version");
    }
    reply.header("mcp-protocol-version", MCP_PROTOCOL_VERSION);
    if (dependencies.config.AGENT_GATEWAY_SHARED_SECRET && request.headers["x-agent-gateway-secret"] !== dependencies.config.AGENT_GATEWAY_SHARED_SECRET) {
      return failure(-32003, "gateway_authentication_required");
    }
    let auth: McpAuthContext;
    try {
      auth = await authenticateMcpRequest({ request, config: dependencies.config, installationCredentials, agents });
      requireMcpScope(auth, "mcp:read");
    } catch (error) {
      return failure(-32003, error instanceof Error ? error.message : "mcp_authentication_failed");
    }
    // Global, organization, agent, and installation kill switches are checked
    // after bearer revalidation and before any MCP method is served. Tool-level
    // switches are enforced by the shared invocation service for tools/call.
    if (await killSwitches.isBlocked({
      organizationId: auth.organizationId,
      agentId: auth.agentId,
      installationId: auth.installationId,
    })) {
      return failure(-32030, "mcp_kill_switch_active", { code: "MCP_KILL_SWITCH_ACTIVE" });
    }
    if (body.method === "initialize") {
      return respond({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kasitek-agent-platform", version: "1.0.0" } });
    }
    const params = body.params ?? {};
    const suppliedInstallationId = typeof params.installationId === "string" ? params.installationId : undefined;
    if (suppliedInstallationId && suppliedInstallationId !== auth.installationId) return failure(-32602, "installationId does not match authenticated installation");
    if (body.method === "tools/list") {
      const installation = await agents.getInstallation(auth.organizationId, auth.installationId);
      if (!installation || installation.status !== "active") return failure(-32004, "installation_not_found");
      const granted = await toolGrants.effectiveTools(auth.organizationId, installation.agent_version_id, installation.id);
      return respond({ tools: toolRegistry.surfaces(granted).map((surface) => surface.mcp) });
    }
    if (body.method === "tools/status") {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) return failure(-32602, "runId is required");
      const run = await runs.getRun(auth.organizationId, runId);
      if (!run || run.installation_id !== auth.installationId) return failure(-32004, "operation_not_found");
      const approval = await approvals.getForRun(auth.organizationId, run.id);
      return respond({
        content: [{ type: "text", text: `Operation ${run.id} is ${run.status}.` }],
        structuredContent: {
          runId: run.id,
          status: run.status,
          terminal: ["completed", "failed", "cancelled", "expired"].includes(run.status),
          approval: publicApprovalStatus(approval),
        },
      });
    }
    if (body.method === "tools/call") {
      try {
        requireMcpScope(auth, "mcp:write");
      } catch (error) {
        return failure(-32003, error instanceof Error ? error.message : "mcp_authorization_failed");
      }
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      if (!name) return failure(-32602, "name is required");
      const toolCallId = typeof params.toolCallId === "string" && params.toolCallId.length <= 240 ? params.toolCallId : `mcp:${randomUUID()}`;
      const idempotencyKey = typeof params.idempotencyKey === "string" && params.idempotencyKey.length >= 8 && params.idempotencyKey.length <= 240
        ? `mcp:${auth.credentialId}:${params.idempotencyKey}`
        : undefined;
      try {
        const invocation = await installationInvocations.accept({
          organizationId: auth.organizationId,
          actorId: auth.actorId,
          installationId: auth.installationId,
          name,
          argumentsValue: args,
          toolCallId,
          idempotencyKey: idempotencyKey ?? `mcp:${auth.credentialId}:${randomUUID()}`,
        });
        const { accepted, manifest } = invocation;
        return respond({
          content: [{ type: "text", text: `Accepted ${name} as operation ${accepted.id}.` }],
          isError: false,
          structuredContent: {
            runId: accepted.id,
            status: accepted.status,
            approvalRequired: manifest.requiresApproval,
            ...( "immediate" in invocation && invocation.immediate === true ? { output: invocation.output } : {}),
            statusReference: { method: "tools/status", params: { runId: accepted.id } },
          },
        });
      } catch (error) {
        const code = error instanceof InstallationCapabilityError ? error.code : "TOOL_FAILED";
        const rpcCode = code === "INVALID_TOOL_ARGUMENTS" || code === "TOOL_NOT_FOUND" ? -32602 : code === "INSTALLATION_NOT_FOUND" ? -32004 : -32001;
        return failure(rpcCode, error instanceof Error ? error.message : "tool_call_failed", { code });
      }
    }
    if (body.method === "notifications/cancelled") {
      try {
        requireMcpScope(auth, "mcp:write");
      } catch (error) {
        return failure(-32003, error instanceof Error ? error.message : "mcp_authorization_failed");
      }
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) return failure(-32602, "runId is required");
      const run = await runs.getRun(auth.organizationId, runId);
      if (!run || run.installation_id !== auth.installationId) {
        return failure(-32004, "operation_not_found");
      }
      if (["completed", "failed", "cancelled", "expired"].includes(run.status)) {
        return body.id === undefined ? reply.code(204).send() : respond({ runId, status: run.status });
      }
      if (!dependencies.signalCancellation) return failure(-32004, "durable_mcp_execution_unavailable");
      const reason = typeof params.reason === "string" ? params.reason.trim().slice(0, 500) : "cancelled by MCP client";
      await dependencies.signalCancellation(run.id, { reason: `installation:${auth.installationId}: ${reason}` });
      return body.id === undefined ? reply.code(204).send() : respond({ runId, status: "cancellation_signalled" });
    }
    return failure(-32601, "method_not_found");
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/tools/call", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "installation_not_found" });
    const input = z.object({
      name: z.string().trim().min(1).max(160),
      arguments: z.record(z.string(), z.unknown()).default({}),
      toolCallId: z.string().trim().min(1).max(240).optional(),
      idempotencyKey: z.string().trim().min(8).max(240),
    }).parse(request.body ?? {});
    const manifest = toolRegistry.get(input.name);
    if (!manifest) return reply.code(404).send({ error: "tool_not_found" });
    requireApiScope(auth, manifest.riskClass === "read" ? "api:read" : "api:write");
    try {
      const invocation = await installationInvocations.accept({
        organizationId: auth.organizationId,
        actorId: auth.actorId,
        installationId: auth.installationId,
        name: input.name,
        argumentsValue: input.arguments,
        toolCallId: input.toolCallId ?? `api:${randomUUID()}`,
        idempotencyKey: `api:${auth.credentialId}:${input.idempotencyKey}`,
      });
      const { accepted } = invocation;
      return reply.code(202).send({
        operationId: accepted.id,
        runId: accepted.id,
        status: accepted.status,
        durable: true,
        approvalRequired: manifest.requiresApproval,
        ...( "immediate" in invocation && invocation.immediate === true ? { output: invocation.output } : {}),
      });
    } catch (error) {
      const code = error instanceof InstallationCapabilityError ? error.code : "TOOL_FAILED";
      const statusCode = code === "INSTALLATION_NOT_FOUND" || code === "TOOL_NOT_FOUND" ? 404
        : code === "INVALID_TOOL_ARGUMENTS" ? 400
          : code === "DURABLE_EXECUTION_UNAVAILABLE" ? 503 : 403;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "tool_call_failed", code });
    }
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/tools", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "installation_not_found" });
    requireApiScope(auth, "api:read");
    const installation = await agents.getInstallation(auth.organizationId, auth.installationId);
    if (!installation || installation.status !== "active") return reply.code(404).send({ error: "installation_not_found" });
    const granted = await toolGrants.effectiveTools(auth.organizationId, installation.agent_version_id, installation.id);
    return {
      installationId: installation.id,
      tools: toolRegistry.surfaces(granted),
    };
  });

  app.get<{ Params: { installationId: string }; Querystring: { limit?: string } }>("/v1/installations/:installationId/runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    if (request.params.installationId.trim().length === 0) return reply.code(404).send({ error: "installation_not_found" });
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: "invalid_limit" });
    return { installationId: installation.id, runs: await runs.listInstallationRuns(auth.organizationId, installation.id, limit) };
  });

  app.get<{ Params: { installationId: string; runId: string } }>("/v1/installations/:installationId/operations/:runId", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    requireApiScope(auth, "api:read");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run || run.installation_id !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    const [events, approval] = await Promise.all([
      runs.listEvents(auth.organizationId, run.id),
      approvals.getForRun(auth.organizationId, run.id),
    ]);
    return { operationId: run.id, run, approval: publicApprovalStatus(approval), events: events.map(toPublicEvent) };
  });

  app.get<{ Params: { installationId: string; runId: string }; Querystring: { after?: string } }>("/v1/installations/:installationId/operations/:runId/events", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    requireApiScope(auth, "api:read");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run || run.installation_id !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(after) || after < 0) return reply.code(400).send({ error: "invalid_after_cursor" });
    const events = await runs.listEventsAfter(auth.organizationId, run.id, after);
    const publicEvents = events.map(toPublicEvent);
    const nextAfter = events.length ? Number(events[events.length - 1]!.sequence_number) : after;
    return { operationId: run.id, events: publicEvents, nextAfter, status: run.status, terminal: ["completed", "failed", "cancelled", "expired"].includes(run.status) };
  });

  app.post<{ Params: { installationId: string; runId: string } }>("/v1/installations/:installationId/operations/:runId/cancel", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    requireApiScope(auth, "api:write");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run || run.installation_id !== auth.installationId) return reply.code(404).send({ error: "operation_not_found" });
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) return { operationId: run.id, status: run.status };
    if (!dependencies.signalCancellation) return reply.code(503).send({ error: "durable_api_execution_unavailable" });
    const input = z.object({ reason: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    await dependencies.signalCancellation(run.id, { reason: `${auth.actorId}: ${input.reason ?? "cancelled by API client"}` });
    return { operationId: run.id, status: "cancellation_signalled" };
  });

  app.post("/v1/agents", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
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
    requireScope(auth, dependencies.config, "agents:read");
    const agent = await agents.getAgent(auth.organizationId, request.params.agentId);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return { versions: await agents.listVersions(auth.organizationId, request.params.agentId) };
  });

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/versions", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = createVersionInputSchema.parse(request.body);
    const version = await agents.createVersion(auth.organizationId, auth.actorId, request.params.agentId, input);
    return reply.code(201).send(version);
  });

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/publish",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:write");
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
      requireScope(auth, dependencies.config, "agents:write");
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
      requireScope(auth, dependencies.config, "agents:read");
      return { grants: await toolGrants.listForVersion(auth.organizationId, request.params.versionId) };
    },
  );

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/tools", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
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
    requireScope(auth, dependencies.config, "agents:write");
    await toolGrants.revoke({ organizationId: auth.organizationId, grantId: request.params.grantId, actorId: auth.actorId });
    return reply.code(204).send();
  });

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/rollback",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:write");
      return agents.rollbackVersion(auth.organizationId, auth.actorId, request.params.agentId, request.params.versionId);
    },
  );

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/retire",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:write");
      return agents.retireVersion(auth.organizationId, auth.actorId, request.params.agentId, request.params.versionId);
    },
  );

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/archive", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    return agents.archiveAgent(auth.organizationId, auth.actorId, request.params.agentId);
  });

  app.post("/v1/installations", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = createInstallationInputSchema.parse(request.body);
    const installation = await agents.createInstallation(auth.organizationId, auth.actorId, input);
    return reply.code(201).send(installation);
  });

  app.get<{ Params: { installationId: string }; Querystring: { credentialId?: string } }>("/v1/installations/:installationId/capabilities", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    if (request.query.credentialId) {
      const credential = await installationCredentials.getActiveForToken({ credentialId: request.query.credentialId, organizationId: auth.organizationId, installationId: request.params.installationId });
      if (!credential) return reply.code(401).send({ error: "installation_credential_not_active" });
    }
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const granted = await toolGrants.effectiveTools(auth.organizationId, installation.agent_version_id, installation.id);
    const capabilities = toolRegistry.surfaces().map((surface) => ({
      ...surface,
      availability: granted.has(surface.name) ? (surface.manifest.availability ?? "available") : "not_granted",
    }));
    const credential = request.query.credentialId ? await installationCredentials.getActiveForToken({ credentialId: request.query.credentialId, organizationId: auth.organizationId, installationId: request.params.installationId }) : null;
    return { installationId: installation.id, apiScopes: credential?.api_scopes ?? null, capabilities };
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/credentials", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { credentials: await installationCredentials.list(auth.organizationId, request.params.installationId) };
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/credentials", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = createInstallationCredentialInputSchema.parse(request.body);
    const created = await installationCredentials.create({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      actorId: auth.actorId,
      ...input,
    });
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { installationId: string; credentialId: string } }>("/v1/installations/:installationId/credentials/:credentialId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await installationCredentials.revoke({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      credentialId: request.params.credentialId,
      actorId: auth.actorId,
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { installationId: string; credentialId: string } }>("/v1/installations/:installationId/credentials/:credentialId/rotate", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const rotated = await installationCredentials.rotate({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      credentialId: request.params.credentialId,
      actorId: auth.actorId,
    });
    return reply.code(201).send(rotated);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/grants", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return installationGrants.effective(auth.organizationId, request.params.installationId);
  });

  app.get("/v1/connectors", async (request) => {
    requireScope(requireAuth(request, dependencies.config), dependencies.config, "agents:read");
    return { connectors: connectorRegistry.list() };
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/connectors", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const grants = await installationGrants.effective(auth.organizationId, installation.id);
    return { installationId: installation.id, connectors: grants.connectors.map((id) => connectorRegistry.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) };
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/grants/resources", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ resourceType: z.string().trim().min(1).max(120), resourceId: z.string().trim().min(1).max(240) }).parse(request.body);
    await installationGrants.grantResource({ organizationId: auth.organizationId, installationId: request.params.installationId, actorId: auth.actorId, ...input });
    return reply.code(204).send();
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/grants/connectors", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ connectorId: z.string().trim().min(1).max(240) }).parse(request.body);
    await installationGrants.grantConnector({ organizationId: auth.organizationId, installationId: request.params.installationId, actorId: auth.actorId, ...input });
    return reply.code(204).send();
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
    "/v1/installations/:installationId/kasiai/home",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      requireScope(auth, dependencies.config, "kasiai:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation || installation.status !== "active") return reply.code(404).send({ error: "kasiai_installation_not_found" });
      const [allConversations, preferences, modelCatalog] = await Promise.all([
        conversations.listOwnerConversations(auth.organizationId, request.params.installationId, auth.actorId),
        kasiaiPreferences.get(auth.organizationId, request.params.installationId, auth.actorId),
        getKasiAiModelCatalog(dependencies.config),
      ]);
      const activeConversations = allConversations.filter((conversation) => conversation.status === "active");
      return {
        installation,
        conversations: activeConversations,
        archivedConversations: allConversations.filter((conversation) => conversation.status === "archived"),
        channelDefaultConversationId: activeConversations.find((conversation) => conversation.is_primary)?.id ?? null,
        preferences,
        models: modelCatalog.models,
        modelCatalog: { source: modelCatalog.source, fetchedAt: modelCatalog.fetchedAt, error: modelCatalog.error },
      };
    },
  );

  app.get<{ Params: { installationId: string }; Querystring: { search?: string } }>(
    "/v1/installations/:installationId/kasiai/models",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "kasiai:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation || installation.status !== "active") throw Object.assign(new Error("KasiAi installation not found"), { statusCode: 404 });
      return { models: await availableKasiAiModels(dependencies.config) };
    },
  );

  app.get<{ Params: { installationId: string }; Querystring: { search?: string } }>(
    "/v1/installations/:installationId/kasiai/preferences",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "kasiai:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation || installation.status !== "active") throw Object.assign(new Error("KasiAi installation not found"), { statusCode: 404 });
      return { preferences: await kasiaiPreferences.get(auth.organizationId, request.params.installationId, auth.actorId) };
    },
  );

  app.patch<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/kasiai/preferences",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "kasiai:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation || installation.status !== "active") throw Object.assign(new Error("KasiAi installation not found"), { statusCode: 404 });
      const input = z.object({
        language: z.string().trim().min(2).max(35).optional(),
        tone: z.enum(["concise", "balanced", "detailed"]).optional(),
        responseDetail: z.enum(["concise", "standard", "detailed"]).optional(),
        notificationsEnabled: z.boolean().optional(),
        useSavedPreferences: z.boolean().optional(),
        referencePreviousChats: z.boolean().optional(),
        defaultModelProvider: z.enum(["openrouter", "openai", "anthropic", "gemini"]).optional(),
        defaultModel: z.string().trim().min(1).max(240).optional(),
      }).strict().parse(request.body ?? {});
      if (!Object.keys(input).length) throw Object.assign(new Error("At least one preference is required"), { statusCode: 400 });
      if (Boolean(input.defaultModelProvider) !== Boolean(input.defaultModel)) {
        throw Object.assign(new Error("Model provider and model must be changed together"), { statusCode: 400 });
      }
      if (input.defaultModelProvider && input.defaultModel && !await isAllowedKasiAiModel(dependencies.config, input.defaultModelProvider, input.defaultModel)) {
        throw Object.assign(new Error("Selected model is not available for this workspace"), { statusCode: 403 });
      }
      const preferences = await kasiaiPreferences.upsert(auth.organizationId, request.params.installationId, auth.actorId, {
        language: input.language,
        tone: input.tone,
        response_detail: input.responseDetail,
        notifications_enabled: input.notificationsEnabled,
        use_saved_preferences: input.useSavedPreferences,
        reference_previous_chats: input.referencePreviousChats,
        default_model_provider: input.defaultModelProvider,
        default_model: input.defaultModel,
      });
      return { preferences };
    },
  );

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
      const messages = conversations.listMessagesPage
        ? await conversations.listMessagesPage(auth.organizationId, resolved.conversation.id)
        : { messages: await conversations.listMessages(auth.organizationId, resolved.conversation.id), hasMore: false, nextBefore: null };
      return reply.send({ ...resolved, ...messages });
    },
  );

  app.post(
    "/v1/channels/inbound",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "channels:ingest");
      const input = z.object({
        channelType: z.string().trim().min(1).max(80),
        provider: z.string().trim().min(1).max(80),
        providerEventId: z.string().trim().min(1).max(240),
        providerMessageId: z.string().trim().min(1).max(240),
        externalIdentity: z.string().trim().min(1).max(240),
        externalConversationId: z.string().trim().min(1).max(240),
        messageType: z.string().trim().min(1).max(80).default("text"),
        content: z.record(z.string(), z.unknown()),
        occurredAt: z.string().datetime().optional(),
        displayName: z.string().trim().max(240).optional(),
      }).parse(request.body);
      input.content = parseCanonicalMessageContent(input.messageType, input.content);
      const accepted = await platformChat.acceptExternalMessage({
        organizationId: auth.organizationId,
        correlationId: auth.correlationId,
        ...input,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run.status === "received") {
        try {
          await dependencies.startWorkflow(accepted.run.id);
        } catch (error) {
          await runs.appendEvent({
            organizationId: auth.organizationId,
            runId: accepted.run.id,
            installationId: accepted.run.installation_id,
            eventType: "run.dispatch_failed",
            payload: {
              message: error instanceof Error ? error.message : "Unable to dispatch workflow",
              retryable: true,
            },
          });
          throw error;
        }
      }
      return reply.code(accepted.created ? 202 : 200).send({
        conversation: accepted.conversation,
        message: accepted.message,
        runId: accepted.run.id,
        status: accepted.run.status,
        created: accepted.created,
        durable: workflowEnabled,
      });
    },
  );

  app.get<{ Params: { installationId: string }; Querystring: { search?: string } }>(
    "/v1/installations/:installationId/conversations",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:read");
      return {
        conversations: await conversations.listOwnerConversations(
          auth.organizationId,
          request.params.installationId,
          auth.actorId,
          200,
          request.query.search,
        ),
      };
    },
  );

  app.patch<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const input = z.object({
      title: z.string().trim().min(1).max(120).optional(),
      pinned: z.boolean().optional(),
      modelProvider: z.enum(["openrouter", "openai", "anthropic", "gemini"]).nullable().optional(),
      model: z.string().trim().min(1).max(240).nullable().optional(),
      clearModel: z.boolean().optional(),
    }).strict().parse(request.body ?? {});
    if (!Object.keys(input).length) throw Object.assign(new Error("At least one conversation change is required"), { statusCode: 400 });
    const hasProvider = input.modelProvider !== undefined;
    const hasModel = input.model !== undefined;
    if (!input.clearModel && hasProvider !== hasModel) throw Object.assign(new Error("Model provider and model must be changed together"), { statusCode: 400 });
    if (input.modelProvider && input.model && !await isAllowedKasiAiModel(dependencies.config, input.modelProvider, input.model)) {
      throw Object.assign(new Error("Selected model is not available for this workspace"), { statusCode: 403 });
    }
    return conversations.updateOwnedConversation({
      organizationId: auth.organizationId,
      conversationId: request.params.conversationId,
      ownerActorId: auth.actorId,
      title: input.title,
      pinned: input.pinned,
      modelProvider: input.modelProvider,
      model: input.model,
      clearModel: input.clearModel,
    });
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/channel-default", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const owned = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
    if (!owned) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    return conversations.setChannelDefault(auth.organizationId, owned.installation_id, auth.actorId, owned.id);
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/conversation/new",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const resolved = await platformChat.createNewConversation({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
      });
      const messages = conversations.listMessagesPage
        ? await conversations.listMessagesPage(auth.organizationId, resolved.conversation.id)
        : { messages: await conversations.listMessages(auth.organizationId, resolved.conversation.id), hasMore: false, nextBefore: null };
      return reply.code(201).send({ ...resolved, ...messages });
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
        conversationId: z.string().uuid().optional(),
        createNew: z.boolean().optional(),
        modelProvider: z.enum(["openrouter", "openai", "anthropic", "gemini"]).optional(),
        model: z.string().trim().min(1).max(240).optional(),
        context: z.object({
          route: z.string().trim().max(500).optional(),
          pageTitle: z.string().trim().max(240).optional(),
          resourceType: z.string().trim().max(80).optional(),
          resourceId: z.string().trim().max(240).optional(),
        }).strict().optional(),
      }).parse(request.body);
      if (Boolean(input.conversationId) === Boolean(input.createNew)) {
        return reply.code(400).send({ error: "Choose either conversationId or createNew=true", code: "conversation_target_required" });
      }
      if (Boolean(input.modelProvider) !== Boolean(input.model)) {
        return reply.code(400).send({ error: "Model provider and model must be changed together" });
      }
      if (input.modelProvider && input.model && !await isAllowedKasiAiModel(dependencies.config, input.modelProvider, input.model)) {
        return reply.code(403).send({ error: "Selected model is not available for this workspace" });
      }
      const accepted = await platformChat.acceptMessage({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
        correlationId: auth.correlationId,
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

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/channels/inbound",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "channels:ingest");
      const input = z.object({
        channelType: z.string().trim().min(1).max(80),
        provider: z.string().trim().min(1).max(80),
        providerEventId: z.string().trim().min(1).max(240),
        providerMessageId: z.string().trim().min(1).max(240),
        externalIdentity: z.string().trim().min(1).max(240),
        externalConversationId: z.string().trim().min(1).max(240),
        messageType: z.string().trim().min(1).max(80).default("text"),
        content: z.record(z.string(), z.unknown()),
        occurredAt: z.string().datetime().optional(),
        displayName: z.string().trim().max(240).optional(),
      }).parse(request.body);
      input.content = parseCanonicalMessageContent(input.messageType, input.content);
      const accepted = await platformChat.acceptExternalMessage({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        correlationId: auth.correlationId,
        ...input,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run.status === "received") {
        try {
          await dependencies.startWorkflow(accepted.run.id);
        } catch (error) {
          await runs.appendEvent({
            organizationId: auth.organizationId,
            runId: accepted.run.id,
            installationId: request.params.installationId,
            eventType: "run.dispatch_failed",
            payload: { message: error instanceof Error ? error.message : "Unable to dispatch workflow", retryable: true },
          });
          throw error;
        }
      }
      return reply.code(accepted.created ? 202 : 200).send({
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
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ expression: z.string().trim().min(1).max(240), timezone: z.string().trim().min(1).max(80).default("UTC"), input: z.record(z.string(), z.unknown()).default({}), nextRunAt: z.string().datetime().optional() }).parse(request.body);
    const schedule = await schedules.create({ organizationId: auth.organizationId, installationId: request.params.installationId, expression: input.expression, timezone: input.timezone, scheduleInput: input.input, nextRunAt: input.nextRunAt, actorId: auth.actorId });
    return reply.code(201).send(schedule);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/schedules", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { schedules: await schedules.list(auth.organizationId, request.params.installationId) };
  });

  app.post<{ Params: { scheduleId: string; status: "active" | "paused" | "disabled" } }>("/v1/schedules/:scheduleId/status/:status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const status = z.enum(["active", "paused", "disabled"]).parse(request.params.status);
    return schedules.setStatus(auth.organizationId, request.params.scheduleId, status, auth.actorId);
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/channels", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
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
    requireScope(auth, dependencies.config, "channels:read");
    const [connections, bindings] = await Promise.all([
      channels.listConnections(auth.organizationId, request.params.installationId),
      channels.listOwnerBindings(auth.organizationId, request.params.installationId, auth.actorId),
    ]);
    return {
      connections: connections.map(({ credential_reference: _credentialReference, ...connection }) => connection),
      bindings,
    };
  });

  app.post<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId/pairing", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
    const input = z.object({ ttlSeconds: z.number().int().positive().max(86_400).optional() }).parse(request.body);
    const pairing = await channels.issuePairingToken({ organizationId: auth.organizationId, installationId: request.params.installationId, connectionId: request.params.connectionId, ttlSeconds: input.ttlSeconds, actorId: auth.actorId });
    return reply.code(201).send(pairing);
  });

  app.post("/v1/channel-pairing/consume", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:ingest");
    const input = z.object({
      token: z.string().trim().min(20).max(200),
      externalIdentity: z.string().trim().min(1).max(240),
    }).parse(request.body);
    const binding = await channels.consumePairingToken({ organizationId: auth.organizationId, ...input });
    return reply.code(201).send(binding);
  });

  app.delete<{ Params: { bindingId: string } }>("/v1/channel-bindings/:bindingId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
    await channels.revokeOwnerBinding(auth.organizationId, request.params.bindingId, auth.actorId);
    return reply.send({ disconnected: true });
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/conversations",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
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

  app.post("/v1/channels/delivery-status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:ingest");
    const input = z.object({
      providerMessageId: z.string().trim().min(1).max(240),
      status: z.enum(["sent", "delivered", "read", "failed", "unknown"]),
      error: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    return channels.updateProviderDeliveryStatus({ organizationId: auth.organizationId, ...input });
  });

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
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

  app.get<{ Params: { conversationId: string }; Querystring: { limit?: string; before?: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:read");
      const conversation = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      await conversations.markOpened(auth.organizationId, conversation.id, auth.actorId);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) return reply.code(400).send({ error: "invalid_message_limit" });
      const messages = conversations.listMessagesPage
        ? await conversations.listMessagesPage(auth.organizationId, conversation.id, { limit, beforeSequence: request.query.before })
        : { messages: await conversations.listMessages(auth.organizationId, conversation.id), hasMore: false, nextBefore: null };
      const participants = await conversations.listParticipants(auth.organizationId, conversation.id);
      return { conversation, ...messages, participants };
    },
  );

  app.post<{ Params: { conversationId: string; status: "archived" | "deleted" } }>("/v1/conversations/:conversationId/status/:status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const status = z.enum(["archived", "deleted"]).parse(request.params.status);
    return conversations.setOwnedStatus(auth.organizationId, request.params.conversationId, auth.actorId, status);
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/restore", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    return conversations.restoreOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/participants", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const input = z.object({ participantType: z.enum(["user", "customer", "staff", "agent", "system"]), externalId: z.string().trim().max(240).optional(), displayName: z.string().trim().max(240).optional() }).parse(request.body);
    const participant = await conversations.createParticipant({ organizationId: auth.organizationId, conversationId: request.params.conversationId, ...input });
    return reply.code(201).send(participant);
  });

  app.post<{ Params: { installationId: string; status: "active" | "paused" | "disabled" } }>(
    "/v1/installations/:installationId/status/:status",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:write");
      const status = z.enum(["active", "paused", "disabled"]).parse(request.params.status);
      return agents.setInstallationStatus(auth.organizationId, request.params.installationId, status, auth.actorId);
    },
  );

  app.patch<{ Params: { installationId: string } }>("/v1/installations/:installationId/settings", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({
      language: z.string().trim().min(2).max(20).optional(),
      tone: z.enum(["concise", "balanced", "detailed"]).optional(),
      responseDetail: z.enum(["concise", "standard", "detailed"]).optional(),
      notificationsEnabled: z.boolean().optional(),
    }).strict().parse(request.body ?? {});
    if (!Object.keys(input).length) throw new Error("At least one installation setting is required");
    return agents.setInstallationSettings(auth.organizationId, request.params.installationId, auth.actorId, input);
  });

  app.post("/v1/runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:write");
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
    const [events, approval] = await Promise.all([
      runs.listEvents(auth.organizationId, run.id),
      approvals.getForRun(auth.organizationId, run.id),
    ]);
    return { run, approval: publicApprovalStatus(approval), events };
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/timeline", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:read");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const [events, steps, toolCalls, effects] = await Promise.all([
      runs.listEvents(auth.organizationId, run.id),
      runSteps.listSteps(auth.organizationId, run.id),
      toolInvocations.list(auth.organizationId, run.id),
      effectReceipts.listForRun(auth.organizationId, run.id),
    ]);
    return {
      run,
      events,
      steps: steps.map((step) => ({ ...step, input: redactSensitiveValue(step.input), output: redactSensitiveValue(step.output), error: redactSensitiveValue(step.error) })),
      toolCalls: toolCalls.map((toolCall) => redactSensitiveValue(toolCall)),
      effects: effects.map((effect) => ({ ...effect, provider_receipt: redactSensitiveValue(effect.provider_receipt), error: redactSensitiveValue(effect.error) })),
    };
  });

  app.get("/v1/operations/summary", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const [runsSummary, modelSummary, toolSummary, pendingReconciliation] = await Promise.all([
      runs.operationalSummary(auth.organizationId),
      modelCalls.usageSummary(auth.organizationId),
      toolInvocations.outcomeSummary(auth.organizationId),
      effectReceipts.countPendingReconciliation(auth.organizationId),
    ]);
    return {
      organizationId: auth.organizationId,
      generatedAt: new Date().toISOString(),
      runs: runsSummary,
      models: modelSummary,
      tools: toolSummary,
      effects: { pendingReconciliation },
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operations/runs", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid run limit");
    return { runs: await runs.listOrganizationRuns(auth.organizationId, limit) };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operations/effects/reconciliation", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid reconciliation limit");
    return { effects: await effectReceipts.pendingReconciliation(auth.organizationId, limit) };
  });

  app.post<{ Params: { effectId: string } }>("/v1/operations/effects/:effectId/reconcile", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ outcome: z.enum(["succeeded", "failed"]), providerReceipt: z.record(z.string(), z.unknown()).optional(), error: z.record(z.string(), z.unknown()).optional() }).parse(request.body ?? {});
    await effectReceipts.reconcile({ organizationId: auth.organizationId, effectId: request.params.effectId, ...input });
    await dependencies.pool.query(
      `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, metadata)
       VALUES ($1, 'user', $2, 'agent_effect.reconciliation_resolved', 'agent_effect_receipt', $3, $4, $5::jsonb)`,
      [auth.organizationId, auth.actorId, request.params.effectId, auth.correlationId ?? null, JSON.stringify({ outcome: input.outcome })],
    );
    return reply.code(202).send({ effectId: request.params.effectId, status: input.outcome, reconciliationRequired: false });
  });

  app.get("/v1/operations/health", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      await dependencies.pool.query("SELECT 1");
      const provider = dependencies.config.KASIAI_MODEL_PROVIDER ?? "openrouter";
      const model = dependencies.config.KASIAI_MODEL ?? "openai/gpt-4o-mini";
      const credentialKey = {
        openrouter: "OPENROUTER_API_KEY",
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        gemini: "GEMINI_API_KEY",
      }[provider];
      return {
        status: "ready",
        checkedAt,
        database: { status: "ready", latencyMs: Date.now() - startedAt },
        temporal: {
          enabled: dependencies.config.TEMPORAL_ENABLED,
          mode: dependencies.config.TEMPORAL_MODE,
          address: dependencies.config.TEMPORAL_ADDRESS,
          namespace: dependencies.config.TEMPORAL_NAMESPACE,
          taskQueue: dependencies.config.TEMPORAL_TASK_QUEUE,
        },
        model: {
          provider,
          model,
          credentialConfigured: Boolean(process.env[credentialKey]?.trim()),
        },
      };
    } catch (error) {
      app.log.error(error);
      return {
        status: "degraded",
        checkedAt,
        database: { status: "unavailable", latencyMs: Date.now() - startedAt },
        temporal: { enabled: dependencies.config.TEMPORAL_ENABLED, mode: dependencies.config.TEMPORAL_MODE },
        model: {
          provider: dependencies.config.KASIAI_MODEL_PROVIDER ?? "openrouter",
          model: dependencies.config.KASIAI_MODEL ?? "openai/gpt-4o-mini",
          credentialConfigured: false,
        },
      };
    }
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
    requireScope(auth, dependencies.config, "agents:read");
    return { killSwitches: await killSwitches.list(auth.organizationId) };
  });

  app.post("/v1/operations/kill-switches", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ scopeType: z.enum(["global", "organization", "agent", "installation", "tool"]), scopeId: z.string().trim().min(1).max(240), reason: z.string().trim().min(1).max(500) }).parse(request.body);
    if (input.scopeType === "global") throw new Error("Global kill switches require platform operator scope");
    const record = await killSwitches.set({ organizationId: auth.organizationId, ...input, actorId: auth.actorId });
    return reply.code(201).send(record);
  });

  app.delete<{ Params: { switchId: string } }>("/v1/operations/kill-switches/:switchId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await killSwitches.disable(auth.organizationId, request.params.switchId, auth.actorId);
    return reply.code(204).send();
  });

  app.post("/v1/credentials", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ provider: z.enum(["openrouter", "openai", "anthropic", "gemini"]), apiKey: z.string().min(1).max(10_000), label: z.string().trim().max(160).optional() }).parse(request.body);
    const credential = await credentials.store({ organizationId: auth.organizationId, actorId: auth.actorId, ...input });
    return reply.code(201).send(credential);
  });

  app.get("/v1/credentials", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { credentials: await credentials.list(auth.organizationId) };
  });

  app.delete<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await credentials.revoke(auth.organizationId, request.params.credentialId);
    return reply.code(204).send();
  });

  app.post<{ Params: { credentialId: string } }>("/v1/credentials/:credentialId/rotate", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ apiKey: z.string().min(1).max(10_000), label: z.string().trim().max(160).optional() }).parse(request.body);
    const credential = await credentials.rotate({ organizationId: auth.organizationId, credentialId: request.params.credentialId, actorId: auth.actorId, ...input });
    return reply.code(201).send(credential);
  });

  app.post("/v1/knowledge/sources", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
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
    requireScope(auth, dependencies.config, "agents:write");
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
    requireScope(auth, dependencies.config, "agents:read");
    const agentId = z.string().uuid().parse(request.query.agentId);
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid memory limit");
    return { memories: await memory.listMemory({ organizationId: auth.organizationId, agentId, installationId, actorId: auth.actorId }, limit) };
  });

  app.delete<{ Params: { memoryId: string } }>("/v1/memory/:memoryId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional() }).parse(request.body);
    await memory.deleteMemory({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId, actorId: auth.actorId }, request.params.memoryId, auth.actorId);
    return reply.code(204).send();
  });

  app.post<{ Params: { memoryId: string } }>("/v1/memory/:memoryId/revalidate", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional(), expiresAt: z.string().datetime().nullable() }).parse(request.body);
    return memory.revalidateMemory({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId, actorId: auth.actorId }, request.params.memoryId, input.expiresAt);
  });

  app.get<{ Querystring: { agentId?: string; installationId?: string; limit?: string } }>("/v1/knowledge/sources", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const agentId = request.query.agentId ? z.string().uuid().parse(request.query.agentId) : undefined;
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid knowledge limit");
    return { sources: await knowledge.listSources({ organizationId: auth.organizationId, agentId, installationId }, limit) };
  });

  app.delete<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional() }).parse(request.body);
    await knowledge.deleteSource({ organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId }, request.params.sourceId, auth.actorId);
    return reply.code(204).send();
  });

  app.post("/v1/evaluations/scenarios", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
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
    requireScope(auth, dependencies.config, "agents:read");
    return { scenarios: await evaluations.listScenarios(auth.organizationId) };
  });

  app.post<{ Params: { scenarioId: string } }>("/v1/evaluations/scenarios/:scenarioId/runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const scenario = await evaluations.getScenario(auth.organizationId, request.params.scenarioId);
    if (!scenario) return reply.code(404).send({ error: "evaluation_scenario_not_found" });
    const input = z.object({ agentVersionId: z.string().uuid().optional(), runId: z.string().uuid().optional(), actualOutput: z.unknown(), evaluatorVersion: z.string().trim().min(1).max(80).default("deterministic-v1") }).parse(request.body);
    const result = evaluateDeterministicAssertions(input.actualOutput, scenario.assertions);
    const run = await evaluations.recordRun({ organizationId: auth.organizationId, scenarioId: scenario.id, agentVersionId: input.agentVersionId, runId: input.runId, status: result.passed ? "passed" : "failed", evaluatorVersion: input.evaluatorVersion, result: { ...result, actualOutput: input.actualOutput }, actorId: auth.actorId });
    return reply.code(201).send(run);
  });

  app.get<{ Querystring: { scenarioId?: string } }>("/v1/evaluations/runs", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
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
    requireScope(auth, dependencies.config, "runs:approve");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.status !== "awaiting_approval") return reply.code(409).send({ error: "run_not_awaiting_approval" });
    if (!dependencies.signalApproval) return reply.code(503).send({ error: "temporal_not_configured" });
    const input = z.object({ decision: z.enum(["approved", "rejected"]), providerToolCallId: z.string().trim().min(1).max(240), argumentsHash: z.string().length(64) }).parse(request.body);
    if (input.decision === "approved" && run.created_by === auth.actorId) {
      return reply.code(403).send({ error: "approval_self_approval_forbidden", code: "SEPARATION_OF_DUTIES_REQUIRED" });
    }
    const approvalRecord = await approvals.getForRun(auth.organizationId, request.params.runId);
    if (!approvalRecord || approvalRecord.provider_tool_call_id !== input.providerToolCallId || approvalRecord.arguments_hash !== input.argumentsHash || approvalRecord.installation_id !== run.installation_id) {
      return reply.code(404).send({ error: "approval_not_found" });
    }
    const installation = await agents.getInstallation(auth.organizationId, run.installation_id);
    if (!installation || installation.status !== "active") return reply.code(403).send({ error: "installation_not_active" });
    const proposal = await toolInvocations.getProposal(auth.organizationId, request.params.runId, input.providerToolCallId);
    if (!proposal || proposal.toolName !== approvalRecord.capability || proposal.toolVersion !== approvalRecord.capability_version || proposal.argumentsHash !== input.argumentsHash) {
      return reply.code(409).send({ error: "approval_proposal_mismatch" });
    }
    const grantedTools = await toolGrants.effectiveTools(auth.organizationId, installation.agent_version_id, installation.id);
    try {
      await authorizeInstallationCapability({
        organizationId: auth.organizationId,
        installationId: installation.id,
        name: approvalRecord.capability,
        argumentsValue: proposal.arguments,
        grantedTools,
        tools: toolRegistry,
        installationGrants,
        approved: false,
        enforceApproval: false,
      });
    } catch (error) {
      return reply.code(403).send({ error: "approval_policy_changed", code: error instanceof Error ? error.message : "CAPABILITY_NOT_GRANTED" });
    }
    const rateLimit = approvalDecisionRateLimiter.consume(`${auth.organizationId}:${request.params.runId}:${auth.actorId}`);
    if (!rateLimit.allowed) {
      reply.header("retry-after", String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({ error: "approval_rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
    }
    let decision;
    try {
      decision = await approvals.decide({ ...input, organizationId: auth.organizationId, runId: request.params.runId, approvedBy: auth.actorId });
    } catch (error) {
      return reply.code(409).send({ error: "approval_not_pending", detail: error instanceof Error ? error.message : undefined });
    }
    const approval = decision.approval;
    if (!decision.accepted) {
      return reply.code(200).send({
        runId: request.params.runId,
        status: "approval_already_signalled",
        decision: input.decision,
        approvedBy: approval.approved_by,
        expiresAt: approval.expires_at,
      });
    }
    if (input.decision === "rejected") {
      await effectReceipts.markNotExecuted(auth.organizationId, request.params.runId, input.providerToolCallId, {
        code: "APPROVAL_REJECTED",
        message: "The requested effect was denied before execution",
      });
    }
    await dependencies.signalApproval(request.params.runId, { ...input, approvedBy: auth.actorId, expiresAt: approval.expires_at });
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

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/external-event", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:write");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.status !== "awaiting_external_event") return reply.code(409).send({ error: "run_not_waiting_for_external_event", status: run.status });
    if (!dependencies.signalExternalEvent) return reply.code(503).send({ error: "temporal_not_configured" });
    const input = z.object({ key: z.string().trim().min(1).max(160), payload: z.record(z.string(), z.unknown()).default({}) }).strict().parse(request.body ?? {});
    await dependencies.signalExternalEvent(request.params.runId, input);
    return reply.code(202).send({ runId: request.params.runId, status: "external_event_signalled", key: input.key });
  });

  return app;
}
