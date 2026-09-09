import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import {
  createAgentInputSchema,
  createExternalAgentInputSchema,
  createInstallationCredentialInputSchema,
  createInstallationInputSchema,
  deployInstallationInputSchema,
  deployStagedVersionInputSchema,
  installationDeploymentPreflightInputSchema,
  installationPromotionInputSchema,
  installationRollbackInputSchema,
  createVersionInputSchema,
  studioAgentCreationInputSchema,
  updateAgentInputSchema,
  startRunInputSchema,
} from "../domain/types";
import { requireExternalConnected, requireHostedInstallation, requireKasiAiInstallation } from "../domain/execution-mode";
import { dependencyProjection, UnknownCapabilityAccessSource, type CapabilityAccessSource } from "../domain/capability-access";
import { AgentRepository, type AgentVersionRecord, type InstallationRecord } from "../db/repositories/agent-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { RunBudgetRepository } from "../db/repositories/run-budget-repository";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { RunStepRepository } from "../db/repositories/run-step-repository";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { ModelCallRepository } from "../db/repositories/model-call-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { InstallationCredentialRepository } from "../db/repositories/installation-credential-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import { MemoryDeletionJobRepository } from "../db/repositories/memory-deletion-job-repository";
import { MemoryRetentionRepository } from "../db/repositories/memory-retention-repository";
import { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import { MemoryRevisionCommandService } from "../memory/revision-command-service";
import { CanonicalMemoryHttpAdmin, type MemoryHttpAdmin } from "../memory/http-admin";
import { chunkKnowledgeText, fetchBoundedKnowledgeDocument } from "../knowledge/ingestion";
import { FirecrawlClient } from "../knowledge/firecrawl";
import { extractKnowledgeFile, MAX_KNOWLEDGE_FILE_BYTES } from "../knowledge/file-ingestion";
import { EvaluationRepository } from "../db/repositories/evaluation-repository";
import { evaluateDeterministicAssertions, evaluationAssertionSchema } from "../evaluations/deterministic";
import { AuditRepository } from "../db/repositories/audit-repository";
import { ScheduleRepository } from "../db/repositories/schedule-repository";
import { ReadinessRepository } from "../db/repositories/readiness-repository";
import { ReadinessSweep } from "../analytics/readiness-sweep";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import { RetentionRepository } from "../db/repositories/retention-repository";
import { parseCanonicalMessageContent } from "../channels/messages";
import { authenticateRequest, type AuthContext } from "./auth";
import type { ApprovalSignal, CancellationSignal, ExternalEventSignal } from "../temporal/contracts";
import { advanceSseCursor, formatSseComment, formatSseEvent, toPublicEvent } from "./sse";
import { KASIAI_SLUG } from "../system/kasiai";
import { PlatformChatRepository, type AcceptedExternalMessage, type HandoffAcknowledgement } from "../db/repositories/platform-chat-repository";
import { HANDOFF_ACKNOWLEDGEMENT_TEXT, HANDOFF_ACTIVE_TEXT } from "../handoff/messages";
import { listAgentTemplates, parseTemplateSettings } from "../system/templates";
import { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import { availableKasiAiModels, getKasiAiModelCatalog, isAllowedKasiAiModel } from "../system/kasiai-models";
import { verifyProviderCredential, type CredentialVerificationResult, type CredentialVerificationInput } from "../model/credential-verification";
import { MODEL_PROVIDERS } from "../model/types";
import { modelProviderEnvironmentKey } from "../model/providers";
import { installationTokenJwks, issueInstallationToken, readClientAssertionSubject, verifyClientAssertion, verifyInstallationToken } from "../auth/installation-token";
import { createHash, createPublicKey } from "node:crypto";
import { createDefaultTools } from "../temporal/activities";
import { validateVersionWorkflow } from "../workflows/graph";
import { agentSpecSchema, compileAgentSpec } from "../domain/agent-spec";
import { resolveModelTarget } from "../model/policy";
import { diffEffectiveAgentConfig, projectEffectiveAgentConfig } from "../domain/effective-agent-config";
import { buildAgentReadiness } from "../domain/agent-readiness";
import { KasitekCoreReadClient } from "../core/client";
import { KasitekCoreDeveloperApiKeyResolver, type DeveloperApiKeyResolver } from "../core/developer-api-key";
import { ToolRegistry } from "../tools/registry";
import { redactSensitiveValue } from "../tools/redaction";
import { randomUUID } from "node:crypto";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TelegramBotClient } from "../channels/telegram-client";
import { TelegramChannelAdapter, normalizeTelegramMimeType, telegramMediaKind } from "../channels/telegram";
import {
  normalizeTelegramAllowedUsers,
  normalizeWhatsappPhone,
  normalizeWhatsappAllowedPhones,
  telegramAllowedUsers,
  telegramUserAllowed,
  whatsappAllowedPhones,
  whatsappPhoneAllowed,
} from "../channels/access";
import { DiscordBotClient } from "../channels/discord-client";
import { DiscordChannelAdapter, discordMediaKind, normalizeDiscordMimeType } from "../channels/discord";
import { channelSecretsEqual, hashChannelSecret } from "../db/channel-secret-crypto";
import {
  clientSupportsExtension,
  cacheableResult,
  completeResult,
  inspectMcpRequest,
  MCP_COMPATIBILITY_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_STATELESS_PROTOCOL_VERSION,
  MCP_TASKS_EXTENSION,
  mcpEnvelopeSchema,
  McpProtocolError,
  unsupportedProtocolVersion,
  validateStatelessRequest,
} from "../mcp/protocol";

const MCP_PROTOCOL_VERSION = MCP_COMPATIBILITY_PROTOCOL_VERSION;
const MCP_DISCOVERY_CACHE_TTL_MS = 30_000;
const MCP_TOOL_LIST_CACHE_TTL_MS = 30_000;
const MCP_TASK_TTL_MS = 86_400_000;
const MCP_TASK_POLL_INTERVAL_MS = 2_000;
const MCP_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCORD_MEDIA_BYTES = 25 * 1024 * 1024;

function projectRuntimeTelemetry(
  events: ReadonlyArray<PersistedExecutionJournalEvent>,
  identity: { readonly runId?: string; readonly turnId?: string } = {},
  now = new Date().toISOString(),
) {
  const accumulator = new RuntimeTelemetryAccumulator(identity);
  for (const event of events) {
    if (event.event.kind !== "harness.turn") continue;
    accumulator.apply({
      type: event.event.data.type,
      payload: event.event.data.payload,
      observedAt: event.occurredAt,
    });
  }
  return accumulator.snapshot(now);
}
import { ConnectorRegistry } from "../connectors";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { InstallationCapabilityError, InstallationCapabilityInvocationService } from "../invocation/installation-capability";
import { InstallationImmediateReadService } from "../invocation/immediate-read";
import { authorizeInstallationCapability } from "../capabilities/authorization";
import { ApprovalDecisionRateLimiter } from "./approval-rate-limit";
import { approveOperatorCommand, createOperatorCommand, getOperatorCommand, operatorCommandInputSchema } from "./operator-commands";
import { acknowledgeOperatorNotification, getOperatorProjection, listOperatorNotifications, rebuildOperatorProjections } from "./operator-projections";
import { ConversationActionService } from "../actions/conversation-actions";
import { ConversationControlService } from "../actions/conversation-controls";
import { AgentUiInteractionCoordinator } from "../actions/ui-interaction-coordinator";
import { UiInteractionRepository } from "../db/repositories/ui-interaction-repository";
import { HandoffRepository } from "../db/repositories/handoff-repository";
import { PostgresConversationEventNotifications, type ConversationEventNotifications } from "../events/postgres-conversation-notifications";
import { verifyChannelApprovalActionToken, type ChannelApprovalDecision } from "../approval/channel-action";
import { IntegrationRepository } from "../integrations/repository";
import { IntegrationToolService } from "../integrations/service";
import { getIntegration, listIntegrations, listToolIntegrations } from "../integrations/catalog";
import { listConnectionDirectory, listPluginDirectory, listSkillDirectory } from "../integrations/directory";
import { buildMcpAuthorizationUrl, createPkcePair, discoverMcpOAuth, exchangeMcpOAuthCode, registerMcpOAuthClient } from "../mcp/oauth";
import { getReviewedMcpCatalogEntry, getReviewedSkillCatalogEntry } from "../integrations/reviewed-catalog";
import { correlationIdFromHeader, currentCorrelationId, runWithCorrelationId } from "../telemetry/context";
import { operationalLogFields, operationalLogRedaction, operationalLogSerializers } from "../telemetry/logger";
import { AudioTranscriptionError, ElevenLabsTranscriptionProvider, hasAudioFileSignature, isSupportedAudioMimeType, MAX_AUDIO_FILE_BYTES, normalizeAudioMimeType, type AudioTranscriptionProvider } from "../transcription";
import { AudioTranscriptionJobRepository } from "../db/repositories/audio-transcription-job-repository";
import { enterDatabaseContext, runWithDatabaseContext } from "../db/context";
import { reconcileRunUsage } from "../operations/usage-reconciliation";
import { SkillRepository } from "../db/repositories/skill-repository";
import { createSkillInputSchema, createSkillVersionInputSchema } from "../skills/contracts";
import { isCustomRemoteMcpProvider, RemoteMcpProviderRepository, createRemoteMcpProviderInputSchema } from "../db/repositories/remote-mcp-provider-repository";
import { executeDraftEvaluation, type DraftEvaluationRunner } from "../evaluations/draft";
import { ModelGateway } from "../model/gateway";
import { VaultCredentialResolver } from "../model/credentials";
import { CoreHostAdapter, HostCapabilityRouter, NativeHostAdapter } from "../hosts/capabilities";
import { createAgentHarness, type AgentHarness } from "../runtime/harness";
import { ExtensionSnapshotRepository } from "../db/repositories/extension-snapshot-repository";
import type { ExtensionKind } from "../extensions";
import { getPluginAdapter } from "../extensions/plugin-adapters";
import { getReviewedPluginAdapterCapabilityIds, getReviewedPluginAdapterConnectorIds, getReviewedPluginAdapterStatus, getReviewedPluginCatalogEntry } from "../extensions/reviewed-plugin-catalog";
import { createCapabilityRuntime } from "../capabilities/runtime";
import { registerIntegrationSources, registerMcpSources, registerPluginSources, registerSkillSources } from "../capabilities/source-adapters";
import { PostgresDeliveryObligationCoordinator, type DeliveryObligationCoordinator } from "../delivery";
import { RuntimeTelemetryAccumulator } from "../runtime/runtime-telemetry";
import type { PersistedExecutionJournalEvent } from "../journal/contracts";

export interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  agents?: AgentRepository;
  extensionSnapshots?: ExtensionSnapshotRepository;
  runs?: RunRepository;
  conversations?: ConversationRepository;
  platformChat?: PlatformChatRepository;
  runSteps?: RunStepRepository;
  toolInvocations?: ToolInvocationRepository;
  toolGrants?: ToolGrantRepository;
  modelCalls?: ModelCallRepository;
  runBudgets?: RunBudgetRepository;
  channels?: ChannelRepository;
  deliveryObligations?: DeliveryObligationCoordinator;
  channelCredentials?: ChannelCredentialRepository;
  telegramClient?: TelegramBotClient;
  discordClient?: DiscordBotClient;
  transcriptionProvider?: AudioTranscriptionProvider;
  audioTranscriptionJobs?: AudioTranscriptionJobRepository;
  credentials?: CredentialVaultRepository;
  /** Provider preflight used before a model credential is persisted. */
  verifyCredential?: (input: CredentialVerificationInput) => Promise<CredentialVerificationResult>;
  installationCredentials?: InstallationCredentialRepository;
  developerApiKeyResolver?: DeveloperApiKeyResolver;
  installationGrants?: InstallationGrantRepository;
  toolRegistry?: ToolRegistry;
  hostCapabilities?: HostCapabilityRouter;
  harness?: AgentHarness;
  conversationActions?: ConversationActionService;
  conversationControls?: ConversationControlService;
  uiInteractionCoordinator?: AgentUiInteractionCoordinator;
  uiInteractions?: UiInteractionRepository;
  /** Product-owned entitlement/provider readiness projection for capabilities. */
  capabilityAccess?: CapabilityAccessSource;
  connectorRegistry?: ConnectorRegistry;
  integrationRepository?: IntegrationRepository;
  integrationTools?: IntegrationToolService;
  effectReceipts?: EffectReceiptRepository;
  approvals?: ApprovalRepository;
  /**
   * Optional protocol-neutral installation invocation boundary. Keeping this
   * injectable makes the MCP and public REST adapters contract-testable
   * without replacing the production policy/runtime service.
   */
  installationInvocations?: Pick<InstallationCapabilityInvocationService, "accept">;
  knowledge?: KnowledgeRepository;
  websiteCrawler?: FirecrawlClient;
  memoryAdmin?: MemoryHttpAdmin;
  memoryDeletionJobs?: MemoryDeletionJobRepository;
  memoryRetention?: MemoryRetentionRepository;
  memoryRevisionCommands?: MemoryRevisionCommandService;
  evaluations?: EvaluationRepository;
  audits?: AuditRepository;
  schedules?: ScheduleRepository;
  readiness?: ReadinessRepository;
  killSwitches?: KillSwitchRepository;
  controls?: OperatorControlRepository;
  retention?: RetentionRepository;
  kasiaiPreferences?: KasiAiPreferenceRepository;
  skills?: SkillRepository;
  remoteMcpProviders?: RemoteMcpProviderRepository;
  draftEvaluator?: DraftEvaluationRunner;
  startWorkflow?: (runId: string) => Promise<void>;
  signalApproval?: (runId: string, signal: ApprovalSignal) => Promise<void>;
  signalCancellation?: (runId: string, signal: CancellationSignal) => Promise<void>;
  signalExternalEvent?: (runId: string, signal: ExternalEventSignal) => Promise<void>;
  eventNotifications?: ConversationEventNotifications;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function secretHeaderMatches(expected: string | undefined, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAuth(request: FastifyRequest, config: AppConfig): AuthContext {
  const auth = authenticateRequest(
    {
      authorization: headerValue(request, "authorization"),
      organizationId: headerValue(request, "x-organization-id"),
      actorId: headerValue(request, "x-actor-id"),
      correlationId: headerValue(request, "x-correlation-id"),
      operator: headerValue(request, "x-kasitek-operator"),
    },
    config,
  );
  enterDatabaseContext({ organizationId: auth.organizationId, actorId: auth.actorId, operator: auth.operator });
  return auth;
}

function requireScope(auth: AuthContext, config: AppConfig, scope: string): void {
  if (config.AUTH_MODE === "headers") return;
  if (!auth.scopes.includes(scope)) {
    throw Object.assign(new Error(`Missing internal scope: ${scope}`), { statusCode: 403 });
  }
}

function isAudioContent(content: Record<string, unknown>): boolean {
  if (typeof content.mediaKind === "string" && content.mediaKind.trim().toLowerCase() === "audio") return true;
  if (typeof content.mimeType !== "string") return false;
  const mimeType = normalizeAudioMimeType(content.mimeType);
  return mimeType.startsWith("audio/") || mimeType === "application/ogg";
}

function hasCompletedTranscription(content: Record<string, unknown>): boolean {
  const transcription = content.transcription;
  return Boolean(
    content.transcript
      && typeof content.transcript === "string"
      && content.transcript.trim()
      && transcription
      && typeof transcription === "object"
      && !Array.isArray(transcription)
      && (transcription as Record<string, unknown>).status === "completed",
  );
}

function safeAudioTranscriptionErrorMessage(errorCode: string | null, status: string): string {
  if (errorCode === "AUDIO_TOO_LARGE") return "That audio file is too large. Please send a shorter recording.";
  if (errorCode === "AUDIO_UNSUPPORTED_FORMAT" || errorCode === "AUDIO_INVALID_MEDIA") return "That audio file could not be read. Please try another recording.";
  if (status === "failed") return "Audio transcription failed. Please try again.";
  return "Audio transcription is still in progress.";
}

function requireOperatorScope(auth: AuthContext, config: AppConfig, scope: "operator:read" | "operator:write"): void {
  if (auth.organizationId !== "platform" || auth.operator !== true) {
    throw Object.assign(new Error("Platform operator authentication required"), { statusCode: 403 });
  }
  if (config.AUTH_MODE !== "headers" && !auth.scopes.includes(scope)) {
    throw Object.assign(new Error(`Missing operator scope: ${scope}`), { statusCode: 403 });
  }
}

interface McpAuthContext extends AuthContext {
  installationId: string;
  credentialId: string;
  agentId: string;
  executionMode: "external_connected";
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
  enterDatabaseContext({ organizationId: claims.organizationId, actorId: `installation:${claims.sub}` });
  const credential = await input.installationCredentials.getActiveForToken({
    credentialId: claims.credentialId,
    organizationId: claims.organizationId,
    installationId: claims.sub,
  });
  if (!credential
    || credential.id !== claims.credentialId
    || credential.organization_id !== claims.organizationId
    || credential.installation_id !== claims.sub) {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation credential is no longer active`), { statusCode: 401 });
  }
  const installation = await input.agents.getInstallation(claims.organizationId, claims.sub);
  if (!installation
    || installation.id !== claims.sub
    || installation.organization_id !== claims.organizationId
    || installation.status !== "active") {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} installation is no longer active`), { statusCode: 401 });
  }
  try {
    requireExternalConnected(installation);
  } catch {
    throw Object.assign(new Error(`${audience === "mcp" ? "MCP" : "Public API"} credentials require an external-connected installation`), { statusCode: 401 });
  }
  return {
    organizationId: claims.organizationId,
    actorId: `installation:${claims.sub}`,
    correlationId: claims.jti,
    scopes: audience === "mcp" ? credential.mcp_scopes : (credential.api_scopes ?? []),
    installationId: claims.sub,
    credentialId: claims.credentialId,
    agentId: installation.agent_definition_id ?? "",
    executionMode: "external_connected",
  };
}

async function authenticateMcpRequest(input: {
  request: FastifyRequest;
  config: AppConfig;
  installationCredentials: InstallationCredentialRepository;
  agents: AgentRepository;
  toolRegistry: ToolRegistry;
  developerApiKeyResolver: DeveloperApiKeyResolver;
}): Promise<McpAuthContext> {
  const authorization = headerValue(input.request, "authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (bearer.startsWith("kst_")) {
    const identity = await input.developerApiKeyResolver.resolve(bearer);
    if (!identity) throw Object.assign(new Error("Invalid Developer API key"), { statusCode: 401 });
    enterDatabaseContext({ organizationId: identity.organizationId, actorId: `developer-api-key:${identity.apiKeyId}` });
    const aggregate = await input.agents.getOrCreateDeveloperApiKeyInstallation({
      organizationId: identity.organizationId,
      apiKeyId: identity.apiKeyId,
      toolNames: [...new Set(input.toolRegistry.list().map((tool) => tool.name))],
    });
    return {
      organizationId: identity.organizationId,
      actorId: `developer-api-key:${identity.apiKeyId}`,
      correlationId: identity.apiKeyId,
      scopes: identity.scopes.map((scope) => scope === "api:read" ? "mcp:read" : "mcp:write"),
      installationId: aggregate.installation.id,
      credentialId: identity.apiKeyId,
      agentId: aggregate.agent.id,
      executionMode: "external_connected",
    };
  }
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

async function requireRestFeature(controls: OperatorControlRepository, auth: McpAuthContext): Promise<void> {
  if (!(await controls.isFeatureEnabled(auth.organizationId, "rest_enabled", auth.installationId))) {
    throw Object.assign(new Error("Public REST API is disabled by an active feature policy"), { statusCode: 403, code: "REST_FEATURE_DISABLED" });
  }
}

async function requireHostedResourceScope(
  agents: AgentRepository,
  organizationId: string,
  input: { installationId?: string; agentId?: string },
): Promise<void> {
  if (input.installationId) {
    const installation = await agents.getInstallation(organizationId, input.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    return;
  }
  if (input.agentId) {
    const agent = (await agents.listAgents(organizationId)).find((candidate) => candidate.id === input.agentId);
    if (agent?.execution_mode === "external_connected") {
      throw Object.assign(new Error("Hosted resource scope is not available to external-connected installations"), { statusCode: 403 });
    }
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

type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

function mcpTaskStatus(runStatus: string): McpTaskStatus {
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed" || runStatus === "expired") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  // Approval and human/external waits remain durable work owned by the
  // existing approval/runtime boundary. They are exposed as working until
  // MRTR input requests are enabled for a client and operation.
  return "working";
}

function publicMcpTask(run: { id: string; status: string; updated_at?: string | null; error?: unknown }): Record<string, unknown> {
  const status = mcpTaskStatus(run.status);
  return {
    taskId: run.id,
    status,
    ttlMs: MCP_TASK_TTL_MS,
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
    ...(run.updated_at ? { lastUpdatedAt: run.updated_at } : {}),
    ...(status === "working" && run.status.startsWith("awaiting_") ? { statusMessage: `Operation is ${run.status.replaceAll("_", " ")}.` } : {}),
  };
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: dependencies.config.LOG_LEVEL,
      redact: operationalLogRedaction,
      serializers: operationalLogSerializers,
      mixin: () => ({ ...operationalLogFields(), ...(currentCorrelationId() ? { correlation_id: currentCorrelationId() } : {}) }),
    },
  });
  app.addHook("onRequest", (request, reply, done) => {
    const correlationId = correlationIdFromHeader(request.headers["x-correlation-id"]);
    reply.header("x-correlation-id", correlationId);
    runWithDatabaseContext(undefined, () => runWithCorrelationId(correlationId, done));
  });
  app.register(multipart, {
    limits: {
      files: 1,
      fields: 0,
      fileSize: Math.max(MAX_KNOWLEDGE_FILE_BYTES, MAX_AUDIO_FILE_BYTES),
    },
  });
  const extensionSnapshots = dependencies.extensionSnapshots ?? new ExtensionSnapshotRepository(dependencies.pool);
  const agents = dependencies.agents ?? new AgentRepository(dependencies.pool, extensionSnapshots);
  const runs = dependencies.runs ?? new RunRepository(dependencies.pool);
  const conversations = dependencies.conversations ?? new ConversationRepository(dependencies.pool);
  const runSteps = dependencies.runSteps ?? new RunStepRepository(dependencies.pool);
  const toolInvocations = dependencies.toolInvocations ?? new ToolInvocationRepository(dependencies.pool);
  const toolGrants = dependencies.toolGrants ?? new ToolGrantRepository(dependencies.pool);
  const modelCalls = dependencies.modelCalls ?? new ModelCallRepository(dependencies.pool);
  const runBudgets = dependencies.runBudgets ?? new RunBudgetRepository(dependencies.pool);
  const channels = dependencies.channels ?? new ChannelRepository(dependencies.pool);
  const deliveryObligations = dependencies.deliveryObligations ?? new PostgresDeliveryObligationCoordinator(dependencies.pool);
  const channelCredentials = dependencies.channelCredentials ?? new ChannelCredentialRepository(dependencies.pool, dependencies.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
  const telegramClient = dependencies.telegramClient ?? new TelegramBotClient({ apiBaseUrl: dependencies.config.TELEGRAM_API_BASE_URL, timeoutMs: dependencies.config.TELEGRAM_API_TIMEOUT_MS });
  const discordClient = dependencies.discordClient ?? new DiscordBotClient({ apiBaseUrl: dependencies.config.DISCORD_API_BASE_URL, timeoutMs: dependencies.config.DISCORD_API_TIMEOUT_MS });
  const transcriptionProvider = dependencies.transcriptionProvider ?? ElevenLabsTranscriptionProvider.fromConfig(dependencies.config);
  const audioTranscriptionJobs = dependencies.audioTranscriptionJobs ?? new AudioTranscriptionJobRepository(dependencies.pool);
  const credentials = dependencies.credentials ?? new CredentialVaultRepository(dependencies.pool, dependencies.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
  const verifyCredential = dependencies.verifyCredential ?? ((input: CredentialVerificationInput) => verifyProviderCredential(input));
  const installationCredentials = dependencies.installationCredentials ?? new InstallationCredentialRepository(dependencies.pool);
  const developerApiKeyResolver = dependencies.developerApiKeyResolver ?? new KasitekCoreDeveloperApiKeyResolver(dependencies.config);
  const installationGrants = dependencies.installationGrants ?? new InstallationGrantRepository(dependencies.pool);
  const controls = dependencies.controls ?? new OperatorControlRepository(dependencies.pool);
  const platformChat = dependencies.platformChat ?? new PlatformChatRepository(dependencies.pool, {
    isHandoffEnabled: (organizationId, installationId) => controls.isFeatureEnabled(organizationId, "customer_handoff_enabled", installationId),
  });
  const uiInteractions = dependencies.uiInteractions ?? new UiInteractionRepository(dependencies.pool);
  const uiInteractionCoordinator = dependencies.uiInteractionCoordinator ?? new AgentUiInteractionCoordinator({
    conversations,
    runs,
    platformChat,
    startWorkflow: dependencies.startWorkflow,
    appendEvent: (input) => runs.appendEvent(input),
    signalExternalEvent: dependencies.signalExternalEvent,
    uiInteractions,
    isDynamicUiEnabled: (organizationId, installationId) => controls.isFeatureEnabled(organizationId, "dynamic_ui_enabled", installationId),
    temporalEnabled: dependencies.config.TEMPORAL_ENABLED,
  });
  const handoffs = new HandoffRepository(dependencies.pool);
  const eventNotifications = dependencies.eventNotifications ?? new PostgresConversationEventNotifications(dependencies.pool);
  const ownsEventNotifications = !dependencies.eventNotifications;
  const conversationActions = dependencies.conversationActions ?? new ConversationActionService(handoffs, controls);
  const conversationControls = dependencies.conversationControls ?? new ConversationControlService(handoffs);
  const coreClient = new KasitekCoreReadClient(dependencies.config);
  const hostCapabilities = dependencies.harness?.host ?? dependencies.hostCapabilities ?? new HostCapabilityRouter([
    new CoreHostAdapter(coreClient),
    new NativeHostAdapter(),
  ]);
  const deliverHandoffAcknowledgement = async (input: {
    accepted: AcceptedExternalMessage;
    organizationId: string;
    channelType: string;
    externalConversationId: string;
  }): Promise<void> => {
    const acknowledgement: HandoffAcknowledgement | undefined = input.accepted.handoffAcknowledgement;
    if (!acknowledgement) return;
    const organizationId = input.organizationId;
    let claimed = false;
    const obligation = await deliveryObligations.create({
      id: acknowledgement.deliveryAttemptId,
      idempotencyKey: `handoff-ack:${acknowledgement.deliveryAttemptId}`,
      scope: {
        organizationId,
        installationId: input.accepted.conversation.installation_id,
        conversationId: input.accepted.conversation.id,
      },
      channel: `handoff:${input.channelType}`,
      payloadRef: acknowledgement.message.id,
    });
    const obligationClaimId = `handoff-ack:${acknowledgement.deliveryAttemptId}`;
    try {
      const obligationClaim = await deliveryObligations.claim({
        obligationId: obligation.id,
        claimId: obligationClaimId,
        workerId: "http:handoff-acknowledgement",
      });
      if (obligationClaim.status !== "applied" && obligationClaim.status !== "idempotent") {
        app.log.info({
          event: "conversation.handoff.acknowledgement_delivery_skipped",
          handoffRequestId: input.accepted.handoffRequestId,
          deliveryAttemptId: acknowledgement.deliveryAttemptId,
          obligationState: obligationClaim.obligation.state,
        }, "Handoff acknowledgement delivery already has a terminal or competing obligation");
        return;
      }
      await channels.claimDelivery(organizationId, acknowledgement.deliveryAttemptId);
      claimed = true;
      const channelType = input.channelType.trim().toLowerCase();
      const text = typeof acknowledgement.message.content.text === "string"
        ? acknowledgement.message.content.text
        : HANDOFF_ACKNOWLEDGEMENT_TEXT;
      const delivery = channelType === "telegram"
        ? await (async () => {
          const connection = (await channels.listConnections(organizationId, input.accepted.conversation.installation_id))
            .find((candidate) => candidate.id === acknowledgement.channelConnectionId && candidate.status === "active");
          if (!connection?.credential_reference) throw new Error("Telegram channel delivery is not configured");
          const token = await channelCredentials.resolve(organizationId, connection.credential_reference, "telegram");
          return telegramClient.sendMessage(token, input.externalConversationId, text);
        })()
        : channelType === "discord"
        ? await (async () => {
          const connection = (await channels.listConnections(organizationId, input.accepted.conversation.installation_id))
            .find((candidate) => candidate.id === acknowledgement.channelConnectionId && candidate.status === "active");
          if (!connection?.credential_reference) throw new Error("Discord channel delivery is not configured");
          const token = await channelCredentials.resolve(organizationId, connection.credential_reference, "discord");
          return discordClient.sendMessage(token, input.externalConversationId, text);
        })()
        : await coreClient.deliverChannelMessage({
          organizationId,
          installationId: input.accepted.conversation.installation_id,
          actorId: input.accepted.conversation.owner_actor_id ?? "kasitek-agent-platform",
          runId: acknowledgement.message.id,
          correlationId: acknowledgement.message.id,
          channelType,
          externalConversationId: input.externalConversationId,
          text,
        });
      if (delivery.status === "unknown") throw new Error("HANDOFF_ACKNOWLEDGEMENT_DELIVERY_UNKNOWN");
      await channels.markDelivered({
        organizationId,
        attemptId: acknowledgement.deliveryAttemptId,
        providerMessageId: delivery.providerMessageId,
      });
      const completed = await deliveryObligations.complete({
        obligationId: obligation.id,
        claimId: obligationClaimId,
        receiptRef: delivery.providerMessageId ?? acknowledgement.deliveryAttemptId,
      });
      if (completed.status !== "applied" && completed.status !== "idempotent") {
        throw new Error(`DELIVERY_OBLIGATION_${completed.status.toUpperCase()}`);
      }
      app.log.info({
        event: "conversation.handoff.acknowledgement_delivered",
        channelType,
        handoffRequestId: input.accepted.handoffRequestId,
        deliveryAttemptId: acknowledgement.deliveryAttemptId,
      }, "Handoff acknowledgement delivered");
    } catch (error) {
      const unknown = error instanceof Error && error.message.includes("UNKNOWN");
      await (unknown
        ? deliveryObligations.unknown({ obligationId: obligation.id, claimId: claimed ? obligationClaimId : undefined, reason: error instanceof Error ? error.message : "Handoff acknowledgement delivery unknown" })
        : deliveryObligations.fail({ obligationId: obligation.id, claimId: claimed ? obligationClaimId : undefined, reason: error instanceof Error ? error.message : "Handoff acknowledgement delivery failed" })
      ).catch((obligationError) => {
        app.log.error({ err: obligationError, event: "conversation.handoff.acknowledgement_obligation_update_failed", deliveryAttemptId: acknowledgement.deliveryAttemptId }, "Handoff acknowledgement obligation update failed");
      });
      if (claimed) {
        await channels.markDeliveryFailed({
          organizationId,
          attemptId: acknowledgement.deliveryAttemptId,
          error: {
            code: unknown ? "HANDOFF_ACKNOWLEDGEMENT_DELIVERY_UNKNOWN" : "HANDOFF_ACKNOWLEDGEMENT_DELIVERY_FAILED",
            message: error instanceof Error ? error.message : "Handoff acknowledgement delivery failed",
          },
        }).catch((markError) => {
          app.log.error({ err: markError, event: "conversation.handoff.acknowledgement_status_update_failed", deliveryAttemptId: acknowledgement.deliveryAttemptId }, "Handoff acknowledgement status update failed");
        });
      }
      app.log.error({
        err: error,
        event: "conversation.handoff.acknowledgement_delivery_failed",
        channelType: input.channelType,
        handoffRequestId: input.accepted.handoffRequestId,
        deliveryAttemptId: acknowledgement.deliveryAttemptId,
      }, "Handoff acknowledgement delivery failed");
    }
  };
  const integrationRepository = dependencies.integrationRepository ?? new IntegrationRepository(dependencies.pool, dependencies.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
  const integrationTools = dependencies.integrationTools ?? new IntegrationToolService(integrationRepository, dependencies.config);
  const pluginReadiness = async (organizationId: string, entry: ReturnType<typeof getReviewedPluginCatalogEntry>, installationId?: string) => {
    if (!entry) return { state: "blocked" as const, blockers: ["plugin_not_found"] };
    const adapter = getPluginAdapter(entry);
    if (!adapter) return { state: "blocked" as const, blockers: ["adapter_unavailable"] };
    if (!installationId) return { state: "blocked" as const, blockers: ["installation_required"] };
    const credentials = Object.fromEntries(await Promise.all(adapter.requiredCredentialRefs.map(async (credentialRef) => {
      const connection = await integrationRepository.getConnection(organizationId, installationId, credentialRef);
      const available = await integrationTools.isAvailable(organizationId, installationId, credentialRef);
      const state = available
        ? "configured" as const
        : connection?.status === "revoked"
          ? "revoked" as const
          : connection?.status === "unhealthy"
            ? "unknown" as const
            : "missing" as const;
      return [credentialRef, state] as const;
    })));
    return adapter.checkReadiness({ configuration: {}, credentials });
  };
  const remoteMcpProviders = dependencies.remoteMcpProviders ?? new RemoteMcpProviderRepository(
    dependencies.pool,
    (organizationId, credentialReference) => integrationRepository.resolveCredential(organizationId, credentialReference),
  );
  const configuredTools = dependencies.toolRegistry ?? createDefaultTools(coreClient, conversationActions, integrationTools, hostCapabilities);
  const harness = dependencies.harness ?? createAgentHarness({
    tools: configuredTools,
    host: hostCapabilities,
    capabilities: createCapabilityRuntime({
      registry: configuredTools,
      requireLifecycle: true,
      admission: {
        admit: async ({ request }) => {
          await authorizeInstallationCapability({
            organizationId: request.context.organizationId,
            installationId: request.context.installationId,
            name: request.name,
            argumentsValue: request.arguments,
            grantedTools: request.grantedTools,
            tools: configuredTools,
            installationGrants,
            approved: Boolean(request.approval),
          });
          return { status: "ready" };
        },
      },
    }),
  });
  const toolRegistry = harness.tools;
  const capabilityAccess = dependencies.capabilityAccess ?? new UnknownCapabilityAccessSource();
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
  const memoryDeletionJobs = dependencies.memoryDeletionJobs ?? new MemoryDeletionJobRepository(dependencies.pool);
  const memoryRetention = dependencies.memoryRetention ?? new MemoryRetentionRepository(dependencies.pool);
  const memoryRevisionCommands = dependencies.memoryRevisionCommands ?? new MemoryRevisionCommandService(
    dependencies.pool,
    new MemoryRevisionRepository(dependencies.pool, { analyticsEnabled: true }),
    { analyticsPool: dependencies.pool },
  );
  const memoryAdmin = dependencies.memoryAdmin ?? new CanonicalMemoryHttpAdmin(dependencies.pool, memoryDeletionJobs, memoryRevisionCommands);
  const evaluations = dependencies.evaluations ?? new EvaluationRepository(dependencies.pool);
  const draftEvaluator = dependencies.draftEvaluator ?? ((input) => executeDraftEvaluation(
    input,
    { gateway: new ModelGateway(), credentials: new VaultCredentialResolver(credentials) },
  ));
  const audits = dependencies.audits ?? new AuditRepository(dependencies.pool);
  const schedules = dependencies.schedules ?? new ScheduleRepository(dependencies.pool);
  const readinessAnalytics = dependencies.readiness ?? new ReadinessRepository(dependencies.pool);
  const killSwitches = dependencies.killSwitches ?? new KillSwitchRepository(dependencies.pool);
  const retention = dependencies.retention ?? new RetentionRepository(dependencies.pool);
  const kasiaiPreferences = dependencies.kasiaiPreferences ?? new KasiAiPreferenceRepository(dependencies.pool);
  const skills = dependencies.skills ?? new SkillRepository(dependencies.pool);
  const activateHermesMcp = async (input: {
    organizationId: string;
    actorId: string;
    catalogId: string;
    credentialReference?: string | null;
    agentVersionId?: string;
  }) => {
    const catalogEntry = getReviewedMcpCatalogEntry(input.catalogId);
    if (!catalogEntry || !catalogEntry.managed || !catalogEntry.endpointUrl) throw new Error("HERMES_MCP_ENTRY_NOT_CONNECTABLE");
    let provider = await remoteMcpProviders.getByCatalogId(input.organizationId, catalogEntry.id);
    if (!provider) {
      provider = await remoteMcpProviders.create(input.organizationId, input.actorId, {
        name: catalogEntry.name,
        endpointUrl: catalogEntry.endpointUrl,
        catalogId: catalogEntry.id,
        credentialReference: input.credentialReference ?? undefined,
        timeoutMs: 15_000,
        maxResponseBytes: 1_048_576,
        rateLimitPerMinute: 60,
      });
    } else if (input.credentialReference !== undefined && input.credentialReference !== provider.credential_reference) {
      provider = await remoteMcpProviders.setCredentialReference(input.organizationId, provider.id, input.credentialReference);
    }
    const discovered = await remoteMcpProviders.discover(input.organizationId, input.actorId, provider.id);
    const published = await remoteMcpProviders.publish(input.organizationId, input.actorId, provider.id, discovered.id);
    if (input.agentVersionId) await remoteMcpProviders.pin(input.organizationId, input.actorId, input.agentVersionId, published.id);
    return { provider, version: published, pinned: Boolean(input.agentVersionId) };
  };
  const websiteCrawler = dependencies.websiteCrawler ?? new FirecrawlClient({
    apiKey: dependencies.config.FIRECRAWL_API_KEY,
    baseUrl: dependencies.config.FIRECRAWL_API_BASE_URL,
    timeoutMs: dependencies.config.FIRECRAWL_TIMEOUT_MS,
  });
  const approvalDecisionRateLimiter = new ApprovalDecisionRateLimiter(
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_PER_WINDOW,
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_WINDOW_MS,
    dependencies.config.APPROVAL_DECISION_RATE_LIMIT_MAX_KEYS,
  );
  const immediateReads = new InstallationImmediateReadService({
    runs,
    toolInvocations,
    capabilities: harness.capabilities ?? createCapabilityRuntime({ registry: toolRegistry, requireLifecycle: true }),
  });
  const installationInvocations = dependencies.installationInvocations ?? new InstallationCapabilityInvocationService({
    agents,
    runs,
    toolGrants,
    installationGrants,
    killSwitches,
    tools: toolRegistry,
    capabilities: harness.capabilities,
    temporalEnabled: dependencies.config.TEMPORAL_ENABLED,
    startWorkflow: dependencies.startWorkflow,
    immediateRead: (input) => immediateReads.execute({
      ...input,
      agentId: input.installation.agent_definition_id ?? "",
      agentVersionId: input.installation.agent_version_id,
    }),
  });

  const decideApproval = async (input: {
    organizationId: string;
    runId: string;
    providerToolCallId: string;
    argumentsHash: string;
    decision: ChannelApprovalDecision;
    approvedBy: string;
    rateLimitKey: string;
  }) => {
    const run = await runs.getRun(input.organizationId, input.runId);
    if (!run) throw Object.assign(new Error("run_not_found"), { statusCode: 404, code: "run_not_found" });
    const approvalRecord = await approvals.getForRun(input.organizationId, input.runId);
    const recordedDecision = input.decision === "approved" ? ["approved", "consumed"] : ["denied"];
    if (approvalRecord
      && approvalRecord.provider_tool_call_id === input.providerToolCallId
      && approvalRecord.arguments_hash === input.argumentsHash
      && approvalRecord.installation_id === run.installation_id
      && recordedDecision.includes(approvalRecord.status)
      && approvalRecord.approved_by === input.approvedBy) {
      return { accepted: false, approval: approvalRecord };
    }
    if (run.status !== "awaiting_approval") {
      throw Object.assign(new Error("run_not_awaiting_approval"), { statusCode: 409, code: "run_not_awaiting_approval" });
    }
    if (!dependencies.signalApproval) {
      throw Object.assign(new Error("temporal_not_configured"), { statusCode: 503, code: "temporal_not_configured" });
    }
    if (!approvalRecord || approvalRecord.provider_tool_call_id !== input.providerToolCallId || approvalRecord.arguments_hash !== input.argumentsHash || approvalRecord.installation_id !== run.installation_id) {
      throw Object.assign(new Error("approval_not_found"), { statusCode: 404, code: "approval_not_found" });
    }
    const installation = await agents.getInstallation(input.organizationId, run.installation_id);
    if (!installation || installation.status !== "active") {
      throw Object.assign(new Error("installation_not_active"), { statusCode: 403, code: "installation_not_active" });
    }
    const proposal = await toolInvocations.getProposal(input.organizationId, input.runId, input.providerToolCallId);
    if (!proposal || proposal.toolName !== approvalRecord.capability || proposal.toolVersion !== approvalRecord.capability_version || proposal.argumentsHash !== input.argumentsHash) {
      throw Object.assign(new Error("approval_proposal_mismatch"), { statusCode: 409, code: "approval_proposal_mismatch" });
    }
    const grantedTools = await toolGrants.effectiveTools(input.organizationId, installation.agent_version_id, installation.id);
    try {
      await authorizeInstallationCapability({
        organizationId: input.organizationId,
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
      throw Object.assign(new Error("approval_policy_changed"), {
        statusCode: 403,
        code: "approval_policy_changed",
        detail: error instanceof Error ? error.message : "CAPABILITY_NOT_GRANTED",
      });
    }
    const rateLimit = approvalDecisionRateLimiter.consume(input.rateLimitKey);
    if (!rateLimit.allowed) {
      throw Object.assign(new Error("approval_rate_limited"), {
        statusCode: 429,
        code: "approval_rate_limited",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }
    let decision;
    try {
      decision = await approvals.decide({
        decision: input.decision,
        providerToolCallId: input.providerToolCallId,
        argumentsHash: input.argumentsHash,
        organizationId: input.organizationId,
        runId: input.runId,
        approvedBy: input.approvedBy,
      });
    } catch (error) {
      throw Object.assign(new Error("approval_not_pending"), {
        statusCode: 409,
        code: "approval_not_pending",
        detail: error instanceof Error ? error.message : undefined,
      });
    }
    const approval = decision.approval;
    if (!decision.accepted) return { accepted: false, approval };
    if (input.decision === "rejected") {
      await effectReceipts.markNotExecuted(input.organizationId, input.runId, input.providerToolCallId, {
        code: "APPROVAL_REJECTED",
        message: "The requested effect was denied before execution",
      });
    }
    await dependencies.signalApproval(input.runId, {
      decision: input.decision,
      providerToolCallId: input.providerToolCallId,
      argumentsHash: input.argumentsHash,
      approvedBy: input.approvedBy,
      expiresAt: approval.expires_at,
      resourceSnapshot: approval.resource_snapshot,
    });
    return { accepted: true, approval };
  };

  /**
   * Build the one capability projection consumed by browser, REST, and MCP
   * surfaces. The source is intentionally injected: the Agent Platform owns
   * grants and credential narrowing, while product entitlement and provider
   * readiness belong to their owning services.
   */
  const projectInstallationCapabilities = async (input: {
    organizationId: string;
    installationId: string;
    credentialScopes?: readonly string[];
    transport: "mcp" | "api";
  }) => {
    const installation = await agents.getInstallation(input.organizationId, input.installationId);
    if (!installation) return null;
    const [granted, grants, resourceScopeUnconstrained, dependencyMap] = await Promise.all([
      toolGrants.effectiveTools(input.organizationId, installation.agent_version_id, installation.id),
      installationGrants.effective(input.organizationId, installation.id),
      typeof installationGrants.isResourceScopeUnconstrained === "function"
        ? installationGrants.isResourceScopeUnconstrained(input.organizationId, installation.id)
        : Promise.resolve(false),
      capabilityAccess.getForCapabilities({ organizationId: input.organizationId, capabilityNames: toolRegistry.surfaces().map((surface) => surface.name) }),
    ]);
    const toolIntegrations = listToolIntegrations();
    const integrationAvailability = new Map<string, boolean>(await Promise.all(toolIntegrations.map(async (integration) => [integration.id, await integrationTools.isAvailable(input.organizationId, installation.id, integration.id)] as const)));
    const capabilities = toolRegistry.surfaces().map((surface) => {
      const providers = toolIntegrations.filter((integration) => integration.capabilityNames.includes(surface.name));
      const providerConfigured = providers.length === 0 || providers.some((integration) => integrationAvailability.get(integration.id) === true);
      const dependency = providers.length
        ? { ...(dependencyMap.get(surface.name) ?? {}), providerAvailability: providerConfigured ? "available" as const : "not_configured" as const }
        : dependencyMap.get(surface.name);
      const effectiveAccess = dependencyProjection(dependency, {
        granted: granted.has(surface.name),
        credentialAllowed: input.credentialScopes
          ? input.credentialScopes.includes(`${input.transport}:${surface.riskClass === "read" ? "read" : "write"}`)
          : undefined,
        requiresApproval: surface.requiresApproval,
        resourceScoped: surface.manifest.resourceSelector !== undefined && !resourceScopeUnconstrained,
        connectorScoped: grants.connectors.length > 0,
      }, surface.manifest.availability);
      return {
        ...surface,
        ...effectiveAccess,
        effectiveAccess,
        // Keep the legacy field for existing clients, but make it reflect the
        // effective reason rather than only the registry default.
        availability: effectiveAccess.available ? "available" : effectiveAccess.reasonCode,
      };
    });
    return { installation, grants, capabilities, integrationAvailability: Object.fromEntries(integrationAvailability) };
  };

  const projectCapabilityCatalog = async (organizationId: string) => {
    const surfaces = toolRegistry.surfaces();
    const dependencyMap = await capabilityAccess.getForCapabilities({
      organizationId,
      capabilityNames: surfaces.map((surface) => surface.name),
    });
    const capabilities = surfaces.map((surface) => {
      const effectiveAccess = dependencyProjection(dependencyMap.get(surface.name), {
        // The generic catalog describes organization-level availability. Agent
        // and installation grants are applied later when a version is bound.
        granted: true,
        requiresApproval: surface.requiresApproval,
        resourceScoped: surface.manifest.resourceSelector !== undefined,
      }, surface.manifest.availability);
      return {
        ...surface,
        ...effectiveAccess,
        effectiveAccess,
        availability: effectiveAccess.available ? "available" : effectiveAccess.reasonCode,
      };
    });
    return {
      capabilities,
      directory: toolRegistry.catalog.list(),
      toolsets: toolRegistry.catalog.listToolsets(),
    };
  };

  /**
   * The Studio directory is a discovery projection, not an activation grant.
   * It forks the immutable platform registry so organization-owned skills,
   * packages, and MCP revisions cannot leak into another tenant's catalog or
   * mutate the execution registry used by active runs.
   */
  const projectCapabilityDirectory = async (organizationId: string) => {
    const catalog = toolRegistry.catalog.fork();
    const skillDefinitions = await skills.listSkills(organizationId);
    const skillVersions = (await Promise.all(skillDefinitions.map((definition) => skills.listVersions(organizationId, definition.id))))
      .flat()
      .filter((version) => version.status === "published" && version.skill_status !== "revoked");
    registerSkillSources(catalog, skillVersions.map((version) => ({
      id: version.id,
      version: version.version_number,
      name: version.skill_name ?? version.skill_slug ?? version.id,
      description: version.skill_name ?? version.skill_slug,
      checksum: version.checksum,
      requiredCapabilities: version.required_capabilities,
      requiredConnectors: version.required_connectors,
    })));

    const packages = (await extensionSnapshots.listPackages(organizationId)).filter((entry) => entry.status === "published" && entry.kind === "plugin");
    registerPluginSources(catalog, packages.map((entry) => ({
      id: entry.package_id,
      version: entry.version,
      checksum: entry.checksum,
      name: entry.name,
      description: entry.name,
      permissions: [],
      capabilityIds: entry.declaration.kind === "plugin" ? entry.declaration.capabilityIds : [],
    })));

    const providers = await remoteMcpProviders.list(organizationId);
    const providerVersions = (await Promise.all(providers.map((provider) => remoteMcpProviders.listVersions(organizationId, provider.id))))
      .flat()
      .filter((version) => version.status === "published");
    registerMcpSources(catalog, providerVersions.map((version) => ({
      id: version.id,
      providerId: version.provider_id,
      providerName: version.provider_name ?? version.provider_id,
      version: version.revision,
      checksum: version.checksum,
      protocolVersion: version.protocol_version,
      tools: version.tools,
      timeoutMs: version.timeout_ms,
      credentialConfigured: Boolean(version.credential_reference),
    })));

    return { directory: catalog.list(), toolsets: catalog.listToolsets() };
  };

  const projectAgentVersionConfig = async (input: {
    organizationId: string;
    version: AgentVersionRecord;
    installation?: InstallationRecord;
  }) => {
    const configuration = input.version.configuration ?? {};
    const policy = input.version.policy ?? {};
    const typed = agentSpecSchema.safeParse(configuration.agentSpec);
    const spec = typed.success ? typed.data : undefined;
    const asRecord = (value: unknown): Record<string, unknown> => (
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
    );
    const asStringArray = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const policyMemory = asRecord(policy.memory);
    const configurationMemory = asRecord(configuration.memory);
    const configurationKnowledge = asRecord(configuration.knowledge);
    const blueprint = asRecord(configuration.blueprint);
    const memory = spec?.memory ?? (Object.keys(policyMemory).length ? policyMemory : configurationMemory);
    const knowledge = spec?.knowledge ?? {
      sourceIds: asStringArray(configurationKnowledge.sourceIds ?? configuration.knowledgeSourceIds),
      requiredConnections: asStringArray(configurationKnowledge.requiredConnections ?? blueprint.requiredConnections),
    };
    const channels = spec?.channels.allowed ?? asStringArray(policy.allowedChannels ?? configuration.allowedChannels);
    const configuredRuntime = spec?.runtime ?? {};
    const legacyRuntimeKeys = [
      "maxContextMessages",
      "maxContextTokens",
      "maxIterations",
      "maxModelCalls",
      "maxToolCalls",
      "maxTotalTokens",
      "maxWallTimeMs",
      "temperature",
    ];
    const limits = Object.keys(configuredRuntime).length
      ? configuredRuntime
      : Object.fromEntries(legacyRuntimeKeys.filter((key) => configuration[key] !== undefined).map((key) => [key, configuration[key]]));
    const workflowValue = configuration.workflow;
    let workflow: { configured: boolean; valid: boolean; nodeCount?: number; error?: string } = {
      configured: workflowValue !== undefined,
      valid: true,
    };
    if (workflowValue !== undefined) {
      try {
        validateVersionWorkflow(configuration);
        const graph = asRecord(workflowValue);
        workflow = {
          configured: true,
          valid: true,
          ...(Array.isArray(graph.nodes) ? { nodeCount: graph.nodes.length } : {}),
        };
      } catch {
        workflow = { configured: true, valid: false, error: "invalid_workflow" };
      }
    }
    let model: ReturnType<typeof resolveModelTarget> | null = null;
    let modelError: string | undefined;
    try {
      model = resolveModelTarget(configuration, spec && !policy.modelPolicy ? { ...policy, modelPolicy: spec.model } : policy);
    } catch {
      modelError = "invalid_model_configuration";
    }
    const tools = input.installation
      ? [...await toolGrants.effectiveTools(input.organizationId, input.version.id, input.installation.id)]
      : (await toolGrants.listForVersion(input.organizationId, input.version.id))
        .filter((grant) => grant.installation_id === null && grant.revoked_at === null)
        .map((grant) => grant.tool_name);
    const [effectiveInstallationGrants, pinnedSkills, pinnedProviders] = await Promise.all([
      input.installation ? installationGrants.effective(input.organizationId, input.installation.id) : Promise.resolve(undefined),
      skills.loadPinnedVersions(input.organizationId, input.version.id),
      remoteMcpProviders.listPinned(input.organizationId, input.version.id),
    ]);
    return projectEffectiveAgentConfig({
      version: input.version,
      source: spec ? "typed" : "legacy",
      model,
      modelError,
      tools,
      connectors: effectiveInstallationGrants?.connectors ?? [],
      knowledge: {
        sourceIds: knowledge.sourceIds,
        requiredConnections: knowledge.requiredConnections,
      },
      memory,
      limits,
      workflow,
      channels,
      skills: pinnedSkills,
      remoteMcpProviders: pinnedProviders,
      installation: input.installation,
    });
  };

  const evaluateInstallationReadiness = async (input: {
    organizationId: string;
    installationId: string;
    actorId: string;
    correlationId?: string | null;
    evaluationSource: "readiness_route" | "readiness_sweep";
  }) => {
    const installation = await agents.getInstallation(input.organizationId, input.installationId);
    if (!installation) return null;
    const [agent, version, projected] = await Promise.all([
      agents.getAgent(input.organizationId, installation.agent_definition_id),
      agents.getVersion(input.organizationId, installation.agent_version_id),
      projectInstallationCapabilities({ organizationId: input.organizationId, installationId: installation.id, transport: "api" }),
    ]);
    if (!agent || !version || !projected) return null;

    const configuration = version.configuration ?? {};
    const policy = version.policy ?? {};
    const blueprint = configuration.blueprint && typeof configuration.blueprint === "object" && !Array.isArray(configuration.blueprint)
      ? configuration.blueprint as Record<string, unknown>
      : {};
    const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
    const requiredCapabilities = asStringArray(blueprint.requiredCapabilities).length
      ? asStringArray(blueprint.requiredCapabilities)
      : asStringArray(policy.allowedTools);
    const requiredConnections = asStringArray(blueprint.requiredConnections);
    const knowledgeSources = requiredConnections.includes("website")
      ? await knowledge.listSources({ organizationId: input.organizationId, agentId: installation.agent_definition_id, installationId: installation.id })
      : [];
    const configuredConnections = [
      ...projected.grants.connectors,
      ...(knowledgeSources.length ? ["website"] : []),
      ...Object.entries(projected.integrationAvailability).filter(([, available]) => available).map(([integrationId]) => integrationId),
    ];
    let workflowError: string | undefined;
    try {
      validateVersionWorkflow(configuration);
    } catch (cause) {
      workflowError = cause instanceof Error ? cause.message : "Workflow configuration is invalid.";
    }
    const modelPolicy = policy.modelPolicy && typeof policy.modelPolicy === "object" && !Array.isArray(policy.modelPolicy)
      ? policy.modelPolicy as Record<string, unknown>
      : {};
    const kasiaiPreference = agent.slug === "kasiai"
      ? await kasiaiPreferences.get(input.organizationId, installation.id, input.actorId)
      : null;
    const providerValue = kasiaiPreference?.default_model_provider
      ?? modelPolicy.provider
      ?? (modelPolicy.primary && typeof modelPolicy.primary === "object" && !Array.isArray(modelPolicy.primary) ? (modelPolicy.primary as Record<string, unknown>).provider : configuration.provider);
    const provider = typeof providerValue === "string" ? providerValue : undefined;
    const credentialReference = configuration.credentialReference ?? modelPolicy.credentialReference ?? kasiaiPreference?.default_credential_reference;
    const credentialKey = modelProviderEnvironmentKey(provider);
    const credentialConfigured = (typeof credentialReference === "string" && credentialReference.trim().length > 0) || Boolean(credentialKey && process.env[credentialKey]?.trim());
    const readiness = buildAgentReadiness({
      executionMode: installation.execution_mode,
      installationStatus: installation.status,
      requiredCapabilities,
      capabilityAvailability: projected.capabilities.map((capability) => ({ name: capability.name, available: capability.available === true || capability.availability === "available", reasonCode: capability.reasonCode ?? capability.availability })),
      requiredConnections,
      configuredConnections,
      provider,
      credentialConfigured,
      workflowError,
    });
    await readinessAnalytics.recordSnapshot({
      organizationId: input.organizationId,
      installationId: installation.id,
      agentDefinitionId: agent.id,
      agentVersionId: version.id,
      executionMode: installation.execution_mode,
      status: readiness.status,
      workflowStatus: readiness.checks.workflow.status,
      credentialStatus: readiness.checks.credentials.status,
      blockerCodes: readiness.blockers.map((blocker) => blocker.code),
      requiredCapabilityCount: readiness.checks.capabilities.required.length,
      missingCapabilityCount: readiness.checks.capabilities.missing.length,
      requiredConnectionCount: readiness.checks.connections.required.length,
      missingConnectionCount: readiness.checks.connections.missing.length,
      evaluationSource: input.evaluationSource,
      observedAt: new Date(),
      correlationId: input.correlationId,
    }).catch((error) => {
      app.log.warn({ error: error instanceof Error ? error.message : "unknown error" }, "Readiness analytics snapshot unavailable");
    });
    return { installation, agent, version, projected, readiness };
  };

  if (dependencies.config.NODE_ENV !== "test") {
    const readinessSweep = new ReadinessSweep(readinessAnalytics, {
      intervalMs: dependencies.config.AGENT_READINESS_EVALUATION_INTERVAL_MS,
      batchSize: dependencies.config.AGENT_READINESS_EVALUATION_BATCH_SIZE,
      leaseDurationMs: dependencies.config.AGENT_READINESS_EVALUATION_LEASE_MS,
      evaluate: async (candidate) => {
        await evaluateInstallationReadiness({
          organizationId: candidate.organizationId,
          installationId: candidate.installationId,
          actorId: candidate.actorId,
          evaluationSource: "readiness_sweep",
        });
      },
      onError: (error, candidate) => {
        app.log.warn({ installationId: candidate?.installationId, error: error instanceof Error ? error.message : "unknown error" }, "Readiness evaluation sweep item failed");
      },
    });
    app.addHook("onReady", async () => readinessSweep.start());
    app.addHook("onClose", async () => readinessSweep.stop());
  }
  if (ownsEventNotifications) app.addHook("onClose", async () => eventNotifications.close());

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ZodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 500);
    if (statusCode >= 500) app.log.error(error);
    if (statusCode === 400 && request.method === "POST" && request.url.split("?", 1)[0] === "/v1/channels/inbound") {
      app.log.warn({
        validation: error instanceof ZodError
          ? error.issues.map((issue) => ({ code: issue.code, path: issue.path }))
          : undefined,
      }, "Channel inbound request rejected");
    }
    if (request.url === "/mcp" && request.method === "POST" && statusCode === 400) {
      const requestedProtocol = headerValue(request, "mcp-protocol-version");
      reply.header("mcp-protocol-version", requestedProtocol === MCP_STATELESS_PROTOCOL_VERSION ? MCP_STATELESS_PROTOCOL_VERSION : MCP_PROTOCOL_VERSION);
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

  app.post("/v1/audio/transcriptions", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:ingest");
    if (!(await controls.isFeatureEnabled(auth.organizationId, "audio_transcription_enabled"))) {
      return reply.code(503).send({ error: "Audio transcription is disabled", code: "AUDIO_TRANSCRIPTION_DISABLED" });
    }
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "AUDIO_FILE_REQUIRED", code: "AUDIO_FILE_REQUIRED" });
    const mimeType = normalizeAudioMimeType(part.mimetype);
    if (!isSupportedAudioMimeType(mimeType)) {
      return reply.code(422).send({ error: "AUDIO_UNSUPPORTED_FORMAT", code: "AUDIO_UNSUPPORTED_FORMAT" });
    }
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (error) {
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE" });
      }
      throw error;
    }
    if (bytes.length === 0) return reply.code(422).send({ error: "AUDIO_EMPTY", code: "AUDIO_EMPTY" });
    if (bytes.length > MAX_AUDIO_FILE_BYTES) return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE" });
    if (!hasAudioFileSignature(mimeType, bytes)) {
      return reply.code(422).send({ error: "AUDIO_INVALID_MEDIA", code: "AUDIO_INVALID_MEDIA" });
    }
    try {
      const result = await transcriptionProvider.transcribe({
        bytes,
        mimeType,
        fileName: part.filename,
      });
      return reply.send({ status: "completed", provider: "elevenlabs", text: result.text, ...(result.languageCode ? { languageCode: result.languageCode } : {}) });
    } catch (error) {
      if (error instanceof AudioTranscriptionError) {
        request.log.warn({ code: error.code, retryable: error.retryable }, "Audio transcription failed");
        return reply.code(error.statusCode).send({ error: error.code, code: error.code, retryable: error.retryable });
      }
      throw error;
    }
  });

  app.get<{ Params: { jobId: string } }>("/v1/audio/transcription-jobs/:jobId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:read");
    const job = await audioTranscriptionJobs.get(auth.organizationId, request.params.jobId);
    if (!job) return reply.code(404).send({ error: "AUDIO_TRANSCRIPTION_JOB_NOT_FOUND", code: "AUDIO_TRANSCRIPTION_JOB_NOT_FOUND" });
    return reply.send({
      jobId: job.id,
      status: job.status,
      assetId: job.asset_id,
      ...(job.transcript ? { transcript: job.transcript } : {}),
      ...(job.language_code ? { languageCode: job.language_code } : {}),
      ...(job.result_conversation_id ? { conversationId: job.result_conversation_id } : {}),
      ...(job.result_message_id ? { messageId: job.result_message_id } : {}),
      ...(job.result_run_id ? { runId: job.result_run_id } : {}),
      ...(job.error_code ? { errorCode: job.error_code } : {}),
      ...(job.error_code ? { errorMessage: safeAudioTranscriptionErrorMessage(job.error_code, job.status) } : {}),
      createdAt: job.created_at,
      ...(job.completed_at ? { completedAt: job.completed_at } : {}),
    });
  });

  app.post<{ Params: { jobId: string } }>("/v1/audio/transcription-jobs/:jobId/retry", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const job = await audioTranscriptionJobs.get(auth.organizationId, request.params.jobId);
    if (!job) return reply.code(404).send({ error: "AUDIO_TRANSCRIPTION_JOB_NOT_FOUND", code: "AUDIO_TRANSCRIPTION_JOB_NOT_FOUND" });
    if (job.actor_id !== auth.actorId && auth.operator !== true) return reply.code(403).send({ error: "AUDIO_TRANSCRIPTION_FORBIDDEN", code: "AUDIO_TRANSCRIPTION_FORBIDDEN" });
    const retried = await audioTranscriptionJobs.retry(job.id, auth.actorId);
    return reply.code(202).send({ jobId: retried.id, status: retried.status, assetId: retried.asset_id, created: true, durable: true });
  });

  app.post<{ Params: { connectionId: string } }>("/v1/webhooks/telegram/:connectionId", async (request, reply) => {
    if (!secretHeaderMatches(dependencies.config.INTERNAL_AUTH_SECRET, headerValue(request, "x-kasitek-core-forward-secret"))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    enterDatabaseContext({ organizationId: "platform", actorId: "system:telegram-webhook", operator: true });
    const providerSecret = headerValue(request, "x-telegram-bot-api-secret-token");
    const connection = await channels.getConnectionForWebhook(request.params.connectionId);
    if (!connection || connection.channel_type !== "telegram" || connection.status !== "active" || connection.installation_status !== "active") {
      return reply.code(404).send({ error: "telegram_connection_not_found" });
    }
    if (!connection.webhook_secret_hash || !channelSecretsEqual(connection.webhook_secret_hash, providerSecret ?? "")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    enterDatabaseContext({ organizationId: connection.organization_id, actorId: `telegram-webhook:${connection.id}` });
    const update = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    if ((!update.message || typeof update.message !== "object") && (!update.callback_query || typeof update.callback_query !== "object")) {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const adapter = new TelegramChannelAdapter();
    const event = adapter.normalizeInbound(update);
    const allowedTelegramUsers = connection.execution_mode === "system_hosted" ? telegramAllowedUsers(connection.metadata) : [];
    if (allowedTelegramUsers.length > 0 && !telegramUserAllowed(connection.metadata, event.externalIdentity)) {
      request.log.info({ connectionId: connection.id, externalIdentity: event.externalIdentity }, "Telegram message ignored for a non-allowlisted user");
      return reply.code(200).send({ ok: true, ignored: true, reason: "user_not_allowed" });
    }
    if (allowedTelegramUsers.length > 0) {
      try {
        await channels.bind({
          organizationId: connection.organization_id,
          installationId: connection.installation_id,
          connectionId: connection.id,
          externalIdentity: event.externalIdentity,
          ownerActorId: connection.created_by,
        });
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : "Telegram allowlist binding failed" }, "Telegram allowlist binding failed");
        return reply.code(200).send({ ok: true, ignored: true, reason: "user_not_allowed" });
      }
    }
    const messageText = typeof event.message.content.text === "string" ? event.message.content.text.trim() : "";
    if (event.approvalAction) {
      let result: { accepted: boolean } | undefined;
      let decision: ChannelApprovalDecision | undefined;
      try {
        const claims = verifyChannelApprovalActionToken(event.approvalAction.token, dependencies.config.INTERNAL_AUTH_SECRET ?? "");
        decision = claims.decision;
        const approval = await approvals.getById(connection.organization_id, claims.approvalId);
        const target = approval ? await channels.getApprovalPromptTarget(approval.run_id) : null;
        if (!approval || !target || target.channel_type !== "telegram" || target.external_identity !== event.externalIdentity || target.external_conversation_id !== event.externalConversationId || target.channel_connection_id !== connection.id || target.owner_actor_id === null || target.owner_actor_id === undefined) {
          throw new Error("channel_approval_not_authorized");
        }
        result = await decideApproval({
          organizationId: connection.organization_id,
          runId: approval.run_id,
          providerToolCallId: approval.provider_tool_call_id,
          argumentsHash: approval.arguments_hash,
          decision: claims.decision,
          approvedBy: target.owner_actor_id,
          rateLimitKey: `${connection.organization_id}:channel:${target.owner_actor_id}`,
        });
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : "channel approval failed" }, "Telegram channel approval failed");
      }
      if (connection.credential_reference && event.approvalAction.callbackQueryId && telegramClient) {
        const token = await channelCredentials.resolve(connection.organization_id, connection.credential_reference, "telegram").catch(() => undefined);
        if (token) {
          const acknowledgement = result
            ? (result.accepted ? (decision === "approved" ? "Approval received. Processing…" : "Denied") : "Already decided")
            : "Approval unavailable";
          await telegramClient.answerCallbackQuery(token, event.approvalAction.callbackQueryId, acknowledgement).catch(() => undefined);
          await telegramClient.sendMessage(token, event.externalConversationId, acknowledgement).catch(() => undefined);
        }
      }
      return reply.code(200).send({ ok: true, approval: result ? "processed" : "unavailable" });
    }
    if (connection.execution_mode === "system_hosted") {
      const pairingMatch = messageText.match(/^(?:\/start(?:@[A-Za-z0-9_]+)?\s+)?(kasiai_pair_[A-Za-z0-9_-]+)$/i);
      if (pairingMatch) {
        try {
          await channels.consumePairingToken({
            organizationId: connection.organization_id,
            token: pairingMatch[1]!,
            externalIdentity: event.externalIdentity,
          });
          if (connection.credential_reference) {
            const token = await channelCredentials.resolve(connection.organization_id, connection.credential_reference, "telegram");
            await telegramClient.sendMessage(token, event.externalConversationId, "Connected. You can now message this agent.").catch(() => undefined);
          }
        } catch (error) {
          request.log.warn({ error: error instanceof Error ? error.message : "pairing failed" }, "Telegram pairing attempt failed");
        }
        return reply.code(200).send({ ok: true });
      }
    }

    try {
      const correlationId = randomUUID();
      let messageContent = parseCanonicalMessageContent(event.message.messageType, event.message.content);
      let queuedAudio = false;
      const attachmentId = typeof messageContent.attachmentId === "string" ? messageContent.attachmentId : undefined;
      const mimeType = typeof messageContent.mimeType === "string" ? messageContent.mimeType : undefined;
      const fileName = typeof messageContent.fileName === "string" ? messageContent.fileName : undefined;
      const resolvedMimeType = normalizeTelegramMimeType({
        mimeType,
        fileName,
        fallback: messageContent.mediaKind === "audio" ? "audio/ogg" : undefined,
      });
      const mediaKind = telegramMediaKind(resolvedMimeType);
      if (event.message.messageType === "attachment" && attachmentId) {
        if (!connection.credential_reference) throw new Error("Telegram channel media is not configured");
        const token = await channelCredentials.resolve(connection.organization_id, connection.credential_reference, "telegram");
        if (!mediaKind) {
          request.log.info({ mimeType: resolvedMimeType }, "Telegram attachment type is not supported");
          await telegramClient.sendMessage(token, event.externalConversationId, "I can process image, video, and audio attachments. Please send the file in one of those formats.").catch(() => undefined);
          return reply.code(200).send({ ok: true, media: "unsupported" });
        }
        const isAudio = mediaKind === "audio";
        try {
          const downloaded = await telegramClient.downloadFile(token, attachmentId, isAudio ? MAX_AUDIO_FILE_BYTES : undefined);
          const downloadedMimeType = normalizeTelegramMimeType({
            mimeType: resolvedMimeType,
            fileName: fileName ?? downloaded.filePath,
            fallback: isAudio ? "audio/ogg" : undefined,
          });
          const downloadedMediaKind = telegramMediaKind(downloadedMimeType);
          if (!downloadedMediaKind) throw new Error("Telegram attachment type is not supported");
          const uploaded = await coreClient.uploadContentMedia(
            {
              organizationId: connection.organization_id,
              installationId: connection.installation_id,
              actorId: connection.created_by,
              runId: randomUUID(),
              correlationId,
            },
            {
              bytes: downloaded.bytes,
              mimeType: downloadedMimeType,
              fileName: fileName ?? downloaded.filePath.split("/").at(-1),
              source: "telegram",
              sourceKey: `telegram:${connection.id}:${event.message.providerMessageId}:${attachmentId}`,
            },
          );
          request.log.info({ mediaKind: uploaded.asset.kind, byteSize: downloaded.bytes.byteLength }, "Telegram attachment stored");
          messageContent = { ...messageContent, assetId: uploaded.asset.id, mimeType: downloadedMimeType, mediaKind: isAudio ? "audio" : uploaded.asset.kind };
          if (isAudio) {
            const caption = typeof messageContent.text === "string" ? messageContent.text.trim() : "";
            messageContent = {
              ...messageContent,
              text: caption,
              transcription: { status: "queued", provider: "elevenlabs" },
            };
            queuedAudio = true;
          }
        } catch (error) {
          request.log.warn({ code: error instanceof AudioTranscriptionError ? error.code : undefined, error: error instanceof Error ? error.message : "media ingestion failed", mediaKind }, isAudio ? "Telegram audio ingestion failed" : `Telegram ${mediaKind} ingestion failed`);
          await telegramClient.sendMessage(token, event.externalConversationId, isAudio ? "I couldn't transcribe that audio. Please try sending it again." : `I couldn't process that ${mediaKind}. Please try sending it again.`).catch(() => undefined);
          return reply.code(200).send({ ok: true, media: "failed" });
        }
      }
      if (queuedAudio && typeof messageContent.assetId === "string") {
        if (!(await controls.isFeatureEnabled(connection.organization_id, "audio_transcription_enabled", connection.installation_id))) {
          return reply.code(200).send({ ok: true, media: "disabled" });
        }
        const job = await audioTranscriptionJobs.enqueue({
          organizationId: connection.organization_id,
          installationId: connection.installation_id,
          actorId: connection.created_by,
          correlationId,
          idempotencyKey: `channel:${event.provider}:${event.providerEventId}`,
          assetId: messageContent.assetId,
          dispatchKind: "external",
          dispatchInput: {
            installationId: connection.installation_id,
            channelType: event.channelType,
            channelKey: connection.channel_key,
            provider: event.provider,
            providerEventId: event.providerEventId,
            providerMessageId: event.message.providerMessageId!,
            externalIdentity: event.externalIdentity,
            externalConversationId: event.externalConversationId,
            messageType: event.message.messageType,
            content: messageContent,
            occurredAt: event.message.occurredAt,
            displayName: typeof event.metadata.senderDisplayName === "string" ? event.metadata.senderDisplayName : undefined,
            fileName: typeof messageContent.fileName === "string" ? messageContent.fileName : undefined,
          },
        });
        return reply.code(200).send({ ok: true, media: "queued", jobId: job.job.id, created: job.created });
      }
      const accepted = await platformChat.acceptExternalMessage({
        organizationId: connection.organization_id,
        installationId: connection.installation_id,
        channelType: event.channelType,
        channelKey: connection.channel_key,
        provider: event.provider,
        providerEventId: event.providerEventId,
        providerMessageId: event.message.providerMessageId!,
        externalIdentity: event.externalIdentity,
        externalConversationId: event.externalConversationId,
        messageType: event.message.messageType,
        content: messageContent,
        occurredAt: event.message.occurredAt,
        displayName: typeof event.metadata.senderDisplayName === "string" ? event.metadata.senderDisplayName : undefined,
        correlationId,
      });
      await deliverHandoffAcknowledgement({
        accepted,
        organizationId: connection.organization_id,
        channelType: event.channelType,
        externalConversationId: event.externalConversationId,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run?.status === "received") {
        await dependencies.startWorkflow(accepted.run.id);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "channel_identity_not_paired") {
        if (connection.execution_mode === "system_hosted" && connection.credential_reference) {
          const token = await channelCredentials.resolve(connection.organization_id, connection.credential_reference, "telegram").catch(() => undefined);
          if (token) await telegramClient.sendMessage(token, event.externalConversationId, "This bot is not paired yet.").catch(() => undefined);
        }
        return reply.code(200).send({ ok: true });
      }
      if ((error as { code?: string }).code === "conversation_handoff_active") {
        // The provider webhook must be acknowledged while a human owns the
        // thread; otherwise Telegram will retry the same update indefinitely.
        return reply.code(200).send({ ok: true, handoffActive: true });
      }
      throw error;
    }
    return reply.code(200).send({ ok: true });
  });

  app.post<{ Params: { connectionId: string } }>("/v1/webhooks/discord/:connectionId", async (request, reply) => {
    if (!secretHeaderMatches(dependencies.config.INTERNAL_AUTH_SECRET, headerValue(request, "x-kasitek-core-forward-secret"))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    enterDatabaseContext({ organizationId: "platform", actorId: "system:discord-webhook", operator: true });
    const connection = await channels.getConnectionForWebhook(request.params.connectionId);
    if (!connection || connection.channel_type !== "discord" || connection.status !== "active" || connection.installation_status !== "active") {
      return reply.code(404).send({ error: "discord_connection_not_found" });
    }
    enterDatabaseContext({ organizationId: connection.organization_id, actorId: `discord-webhook:${connection.id}` });
    const payload = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    if (payload.type !== 3 && (typeof payload.id !== "string" || typeof payload.channel_id !== "string" || !payload.author || typeof payload.author !== "object")) {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const event = new DiscordChannelAdapter().normalizeInbound(payload);
    if (event.metadata.authorIsBot === true) return reply.code(200).send({ ok: true, ignored: true });
    const messageText = typeof event.message.content.text === "string" ? event.message.content.text.trim() : "";
    const credential = connection.credential_reference
      ? await channelCredentials.resolve(connection.organization_id, connection.credential_reference, "discord").catch(() => undefined)
      : undefined;

    if (event.approvalAction) {
      let result: { accepted: boolean } | undefined;
      let decision: ChannelApprovalDecision | undefined;
      if (event.approvalAction.interactionId && event.approvalAction.interactionToken && event.approvalAction.applicationId && credential) {
        await discordClient.deferComponent(event.approvalAction.interactionId, event.approvalAction.interactionToken).catch(() => undefined);
      }
      try {
        const claims = verifyChannelApprovalActionToken(event.approvalAction.token, dependencies.config.INTERNAL_AUTH_SECRET ?? "");
        decision = claims.decision;
        const approval = await approvals.getById(connection.organization_id, claims.approvalId);
        const target = approval ? await channels.getApprovalPromptTarget(approval.run_id) : null;
        if (!approval || !target || target.channel_type !== "discord" || target.external_identity !== event.externalIdentity || target.external_conversation_id !== event.externalConversationId || target.channel_connection_id !== connection.id || target.owner_actor_id === null || target.owner_actor_id === undefined) {
          throw new Error("channel_approval_not_authorized");
        }
        result = await decideApproval({
          organizationId: connection.organization_id,
          runId: approval.run_id,
          providerToolCallId: approval.provider_tool_call_id,
          argumentsHash: approval.arguments_hash,
          decision: claims.decision,
          approvedBy: target.owner_actor_id,
          rateLimitKey: `${connection.organization_id}:channel:${target.owner_actor_id}`,
        });
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : "channel approval failed" }, "Discord channel approval failed");
      }
      if (event.approvalAction.applicationId && event.approvalAction.interactionToken && credential) {
        const acknowledgement = result
          ? (result.accepted ? (decision === "approved" ? "Approved" : "Denied") : "Already decided")
          : "Approval unavailable";
        await discordClient.editOriginalResponse(event.approvalAction.applicationId, event.approvalAction.interactionToken, acknowledgement).catch(() => undefined);
      }
      return reply.code(200).send({ ok: true, approval: result ? "processed" : "unavailable" });
    }

    if (connection.execution_mode === "system_hosted") {
      const pairingMatch = messageText.match(/^(?:\/start\s+)?(kasiai_pair_[A-Za-z0-9_-]+)$/i);
      if (pairingMatch) {
        try {
          await channels.consumePairingToken({ organizationId: connection.organization_id, token: pairingMatch[1]!, externalIdentity: event.externalIdentity });
          if (credential) await discordClient.sendMessage(credential, event.externalConversationId, "Connected. You can now message this agent.").catch(() => undefined);
        } catch (error) {
          request.log.warn({ error: error instanceof Error ? error.message : "pairing failed" }, "Discord pairing attempt failed");
        }
        return reply.code(200).send({ ok: true });
      }
    }

    try {
      const correlationId = randomUUID();
      let messageContent = parseCanonicalMessageContent(event.message.messageType, event.message.content);
      let queuedAudio = false;
      const attachmentId = typeof messageContent.attachmentId === "string" ? messageContent.attachmentId : undefined;
      const attachmentUrl = typeof messageContent.url === "string" ? messageContent.url : undefined;
      const mimeType = typeof messageContent.mimeType === "string"
        ? normalizeDiscordMimeType({ mimeType: messageContent.mimeType, fileName: messageContent.fileName })
        : undefined;
      const declaredMediaKind = typeof messageContent.mediaKind === "string" && ["image", "video", "audio"].includes(messageContent.mediaKind)
        ? messageContent.mediaKind as "image" | "video" | "audio"
        : undefined;
      const mediaKind = discordMediaKind(mimeType ?? "") ?? declaredMediaKind;
      const isAudio = mediaKind === "audio";
      if (event.message.messageType === "attachment" && attachmentId) {
        if (!mediaKind) {
          if (credential) await discordClient.sendMessage(credential, event.externalConversationId, "I can process image, video, and audio attachments. Please send the file in one of those formats.").catch(() => undefined);
          return reply.code(200).send({ ok: true, media: "unsupported" });
        }
        if (!credential || !attachmentUrl) {
          if (credential) await discordClient.sendMessage(credential, event.externalConversationId, `I couldn't access that ${mediaKind}. Please try sending it again.`).catch(() => undefined);
          return reply.code(200).send({ ok: true, media: "failed" });
        }
        try {
          const downloaded = await discordClient.downloadAttachment(credential, attachmentUrl, isAudio ? MAX_AUDIO_FILE_BYTES : MAX_DISCORD_MEDIA_BYTES);
          const uploaded = await coreClient.uploadContentMedia(
            {
              organizationId: connection.organization_id,
              installationId: connection.installation_id,
              actorId: connection.created_by,
              runId: randomUUID(),
              correlationId,
            },
            {
              bytes: downloaded.bytes,
              mimeType: mimeType ?? (mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "audio/mpeg"),
              fileName: typeof messageContent.fileName === "string" ? messageContent.fileName : undefined,
              source: "discord",
              sourceKey: `discord:${connection.id}:${event.message.providerMessageId ?? event.providerEventId}:${attachmentId ?? "audio"}`,
            },
          );
          const caption = typeof messageContent.text === "string" ? messageContent.text.trim() : "";
          messageContent = {
            ...messageContent,
            assetId: uploaded.asset.id,
            mimeType: uploaded.asset.mimeType,
            mediaKind: uploaded.asset.kind.toLowerCase(),
            text: caption,
            ...(isAudio ? { transcription: { status: "queued", provider: "elevenlabs" } } : {}),
          };
          queuedAudio = isAudio;
        } catch (error) {
          request.log.warn({ code: error instanceof AudioTranscriptionError ? error.code : undefined, error: error instanceof Error ? error.message : "media ingestion failed", mediaKind }, isAudio ? "Discord audio ingestion failed" : `Discord ${mediaKind} ingestion failed`);
          await discordClient.sendMessage(credential, event.externalConversationId, isAudio ? "I couldn't transcribe that audio. Please try sending it again." : `I couldn't process that ${mediaKind}. Please try sending it again.`).catch(() => undefined);
          return reply.code(200).send({ ok: true, media: "failed" });
        }
      }
      if ("url" in messageContent) {
        const persistableContent = { ...messageContent };
        delete persistableContent.url;
        messageContent = persistableContent;
      }
      if (queuedAudio && typeof messageContent.assetId === "string") {
        if (!(await controls.isFeatureEnabled(connection.organization_id, "audio_transcription_enabled", connection.installation_id))) {
          return reply.code(200).send({ ok: true, media: "disabled" });
        }
        const job = await audioTranscriptionJobs.enqueue({
          organizationId: connection.organization_id,
          installationId: connection.installation_id,
          actorId: connection.created_by,
          correlationId,
          idempotencyKey: `channel:${event.provider}:${event.providerEventId}`,
          assetId: messageContent.assetId,
          dispatchKind: "external",
          dispatchInput: {
            installationId: connection.installation_id,
            channelType: event.channelType,
            channelKey: connection.channel_key,
            provider: event.provider,
            providerEventId: event.providerEventId,
            providerMessageId: event.message.providerMessageId ?? event.providerEventId,
            externalIdentity: event.externalIdentity,
            externalConversationId: event.externalConversationId,
            messageType: event.message.messageType,
            content: messageContent,
            occurredAt: event.message.occurredAt,
            displayName: typeof event.metadata.senderDisplayName === "string" ? event.metadata.senderDisplayName : undefined,
            fileName: typeof messageContent.fileName === "string" ? messageContent.fileName : undefined,
          },
        });
        return reply.code(200).send({ ok: true, media: "queued", jobId: job.job.id, created: job.created });
      }
      const accepted = await platformChat.acceptExternalMessage({
        organizationId: connection.organization_id,
        installationId: connection.installation_id,
        channelType: event.channelType,
        channelKey: connection.channel_key,
        provider: event.provider,
        providerEventId: event.providerEventId,
        providerMessageId: event.message.providerMessageId ?? event.providerEventId,
        externalIdentity: event.externalIdentity,
        externalConversationId: event.externalConversationId,
        messageType: event.message.messageType,
        content: messageContent,
        occurredAt: event.message.occurredAt,
        displayName: typeof event.metadata.senderDisplayName === "string" ? event.metadata.senderDisplayName : undefined,
        correlationId,
      });
      await deliverHandoffAcknowledgement({
        accepted,
        organizationId: connection.organization_id,
        channelType: event.channelType,
        externalConversationId: event.externalConversationId,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run?.status === "received") await dependencies.startWorkflow(accepted.run.id);
    } catch (error) {
      if ((error as { code?: string }).code === "channel_identity_not_paired") {
        if (credential) await discordClient.sendMessage(credential, event.externalConversationId, "This bot is not paired yet.").catch(() => undefined);
        return reply.code(200).send({ ok: true });
      }
      if ((error as { code?: string }).code === "conversation_handoff_active") return reply.code(200).send({ ok: true, handoffActive: true });
      throw error;
    }
    return reply.code(200).send({ ok: true });
  });

  app.get("/v1/operator/summary", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const [runs, installations, definitions, effects, audits, modelCost, executionModes] = await Promise.all([
      dependencies.pool.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM agent_runs GROUP BY status ORDER BY status"),
      dependencies.pool.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM agent_installations GROUP BY status ORDER BY status"),
      dependencies.pool.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM agent_definitions GROUP BY status ORDER BY status"),
      dependencies.pool.query<{ status: string; count: string; reconciliation_required: boolean }>("SELECT status, COUNT(*)::text AS count, reconciliation_required FROM agent_effect_receipts GROUP BY status, reconciliation_required ORDER BY status"),
      dependencies.pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM audit_records"),
      dependencies.pool.query<{ total: string }>("SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS total FROM model_calls"),
      dependencies.pool.query<{ execution_mode: string; count: string }>("SELECT execution_mode, COUNT(*)::text AS count FROM agent_installations GROUP BY execution_mode ORDER BY execution_mode"),
    ]);
    return {
      scope: "platform",
      generatedAt: new Date().toISOString(),
      runs: Object.fromEntries(runs.rows.map((row) => [row.status, Number(row.count)])),
      installations: Object.fromEntries(installations.rows.map((row) => [row.status, Number(row.count)])),
      definitions: Object.fromEntries(definitions.rows.map((row) => [row.status, Number(row.count)])),
      effects: effects.rows.map((row) => ({ status: row.status, count: Number(row.count), reconciliationRequired: row.reconciliation_required })),
      auditRecords: Number(audits.rows[0]?.count ?? 0),
      estimatedModelCostUsd: modelCost.rows[0]?.total ?? "0",
      executionModes: Object.fromEntries(executionModes.rows.map((row) => [row.execution_mode, Number(row.count)])),
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/runs", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator run limit");
    const result = await dependencies.pool.query(
      `SELECT runs.id, runs.organization_id, runs.agent_definition_id, runs.agent_version_id,
              runs.installation_id, runs.conversation_id, runs.trigger_type, runs.status,
              runs.correlation_id, runs.created_by, runs.created_at, runs.started_at,
              runs.finished_at, runs.updated_at, assignments.assignee_id,
              assignments.revision AS assignment_revision
       FROM agent_runs runs
       LEFT JOIN agent_operator_run_assignments assignments ON assignments.run_id = runs.id
       ORDER BY runs.created_at DESC LIMIT $1`,
      [limit],
    );
    return { runs: result.rows };
  });

  app.get<{ Querystring: { organizationId?: string; limit?: string } }>("/v1/operator/agent-credential-inventory", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 500 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new Error("Invalid credential inventory limit");
    return {
      credentials: await installationCredentials.inventory({
        organizationId: request.query.organizationId?.trim() || undefined,
        limit,
      }),
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/exports", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator export limit");
    const result = await dependencies.pool.query(
      `SELECT id, command_id, organization_id, requested_by, scope_type, scope_id,
              status, created_at, updated_at, completed_at
       FROM agent_export_requests
       ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return { exports: result.rows };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/kill-switches", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator kill-switch limit");
    const result = await dependencies.pool.query(
      `SELECT id, organization_id, scope_type, scope_id, reason, enabled,
              created_by, created_at, disabled_at
       FROM agent_kill_switches
       ORDER BY enabled DESC, created_at DESC LIMIT $1`,
      [limit],
    );
    return { killSwitches: result.rows };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/feature-flags", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator feature-flag limit");
    return { featureFlags: await controls.listFeatureFlags(limit) };
  });

  app.get<{ Querystring: { organizationId?: string; status?: string; limit?: string } }>("/v1/operator/audio-transcription/jobs", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid audio transcription job limit");
    const status = request.query.status
      ? z.enum(["queued", "processing", "dispatching", "completed", "retryable_failed", "failed", "deleted"]).parse(request.query.status)
      : undefined;
    return { jobs: await audioTranscriptionJobs.listForOperator({ organizationId: request.query.organizationId?.trim() || undefined, status, limit }) };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/holds", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator hold limit");
    return { holds: await controls.listHolds(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/retention/policies", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid retention policy limit");
    return { policies: await retention.listPolicies(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/retention/legal-holds", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid legal hold limit");
    return { legalHolds: await retention.listLegalHolds(limit) };
  });

  app.get<{ Params: { organizationId: string } }>("/v1/operator/retention/preview/:organizationId", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    return retention.preview(request.params.organizationId);
  });

  app.get("/v1/operator/health", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      await dependencies.pool.query("SELECT 1");
      const provider = dependencies.config.KASIAI_MODEL_PROVIDER ?? "openrouter";
      const credentialKey = modelProviderEnvironmentKey(provider);
      return {
        scope: "platform",
        status: "ready",
        checkedAt,
        database: { status: "ready", latencyMs: Date.now() - startedAt },
        temporal: { enabled: dependencies.config.TEMPORAL_ENABLED, mode: dependencies.config.TEMPORAL_MODE, address: dependencies.config.TEMPORAL_ADDRESS, namespace: dependencies.config.TEMPORAL_NAMESPACE, taskQueue: dependencies.config.TEMPORAL_TASK_QUEUE },
        model: { provider, model: dependencies.config.KASIAI_MODEL, credentialConfigured: Boolean(credentialKey && process.env[credentialKey]?.trim()) },
        audioTranscription: { provider: "elevenlabs", model: dependencies.config.ELEVENLABS_TRANSCRIPTION_MODEL ?? "scribe_v2", credentialConfigured: Boolean(dependencies.config.ELEVENLABS_API_KEY?.trim()) },
      };
    } catch (error) {
      app.log.error(error);
      return { scope: "platform", status: "degraded", checkedAt, database: { status: "unavailable", latencyMs: Date.now() - startedAt }, temporal: { enabled: dependencies.config.TEMPORAL_ENABLED, mode: dependencies.config.TEMPORAL_MODE }, model: { provider: dependencies.config.KASIAI_MODEL_PROVIDER, model: dependencies.config.KASIAI_MODEL, credentialConfigured: false }, audioTranscription: { provider: "elevenlabs", model: dependencies.config.ELEVENLABS_TRANSCRIPTION_MODEL, credentialConfigured: Boolean(dependencies.config.ELEVENLABS_API_KEY?.trim()) } };
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/effects/reconciliation", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator reconciliation limit");
    const result = await dependencies.pool.query(
      `SELECT id, organization_id, installation_id, run_id, provider_tool_call_id,
              capability, capability_version, status, reconciliation_required,
              created_at, updated_at, completed_at
       FROM agent_effect_receipts
       WHERE reconciliation_required = TRUE
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return { effects: result.rows };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/operator/budgets/reconciliation", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator budget reconciliation limit");
    return { reservations: await runBudgets.pendingReconciliation(undefined, limit) };
  });

  app.get<{ Params: { runId: string }; Querystring: { limit?: string } }>("/v1/operator/runs/:runId/usage-reconciliation", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator usage reconciliation limit");

    const result = await dependencies.pool.query<{
      id: string;
      organization_id: string;
      installation_id: string;
      correlation_id: string;
    }>(
      `SELECT id, organization_id, installation_id, correlation_id
       FROM agent_runs
       WHERE id = $1
       LIMIT 1`,
      [request.params.runId],
    );
    const run = result.rows[0];
    if (!run) return reply.code(404).send({ error: "run_not_found" });

    const [localUsage, localBudget] = await Promise.all([
      modelCalls.usageForRun(run.organization_id, run.id, "kasitek"),
      runBudgets.summaryForRun(run.organization_id, run.id),
    ]);

    let billed: Awaited<ReturnType<KasitekCoreReadClient["getCreditUsageReconciliation"]>>;
    try {
      billed = await coreClient.getCreditUsageReconciliation(
        {
          organizationId: run.organization_id,
          actorId: auth.actorId,
          installationId: run.installation_id,
          runId: run.id,
          correlationId: run.correlation_id,
        },
        "AGENT_RUN",
        run.id,
        limit,
      );
    } catch (error) {
      request.log.warn({
        code: (error as { code?: string }).code,
        runId: run.id,
        organizationId: run.organization_id,
      }, "Core usage reconciliation unavailable");
      return reply.code(502).send({
        error: "Core usage reconciliation unavailable",
        code: "CORE_USAGE_RECONCILIATION_UNAVAILABLE",
        runId: run.id,
        organizationId: run.organization_id,
        local: { usage: localUsage, budget: localBudget },
      });
    }

    return {
      runId: run.id,
      organizationId: run.organization_id,
      generatedAt: new Date().toISOString(),
      ...reconcileRunUsage({
        localUsage,
        localBudget,
        reservations: billed.reservations,
        usageEvents: billed.usageEvents,
      }),
    };
  });

  app.get<{ Querystring: { action?: string; resourceType?: string; limit?: string } }>("/v1/operator/audit", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid operator audit limit");
    const action = request.query.action?.trim() || null;
    const resourceType = request.query.resourceType?.trim() || null;
    const result = await dependencies.pool.query(
      `SELECT id, organization_id, actor_type, actor_id, action, resource_type,
              resource_id, correlation_id, execution_mode, created_at
       FROM audit_records
       WHERE ($1::text IS NULL OR action = $1)
         AND ($2::text IS NULL OR resource_type = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [action, resourceType, limit],
    );
    return { records: result.rows };
  });

  app.get<{ Querystring: { q: string; limit?: string } }>("/v1/operator/search", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    const q = request.query.q?.trim() ?? "";
    if (q.length < 2 || q.length > 160) throw new Error("Operator search requires 2-160 characters");
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid operator search limit");
    const escapedQuery = q.replace(/[\\%_]/g, "\\$&");
    const result = await dependencies.pool.query(
      `SELECT 'organization' AS kind, organization_id AS id, organization_id, 'active' AS state,
              'organization' AS resource_type, MIN(created_at) AS created_at
       FROM agent_definitions
       WHERE organization_id ILIKE $1 ESCAPE '\\'
       GROUP BY organization_id
       UNION ALL
       SELECT 'workspace' AS kind, organization_id AS id, organization_id, 'active' AS state,
              'workspace' AS resource_type, MIN(created_at) AS created_at
       FROM agent_definitions
       WHERE organization_id ILIKE $1 ESCAPE '\\'
       GROUP BY organization_id
       UNION ALL
       SELECT 'user' AS kind, COALESCE(external_id, id::text) AS id, organization_id,
              participant_type AS state, 'user' AS resource_type, created_at
       FROM participants
       WHERE external_id ILIKE $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'run' AS kind, id::text AS id, organization_id, status AS state,
              'agent_run' AS resource_type, created_at
       FROM agent_runs
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR correlation_id::text ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'agent' AS kind, id::text AS id, organization_id, status AS state,
              'agent_definition' AS resource_type, created_at
       FROM agent_definitions
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR name ILIKE $1 ESCAPE '\\' OR slug ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'installation' AS kind, id::text AS id, organization_id, status AS state,
              'agent_installation' AS resource_type, created_at
       FROM agent_installations
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR agent_definition_id::text ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'approval' AS kind, id::text AS id, organization_id, status AS state,
              'agent_approval' AS resource_type, created_at
       FROM agent_approval_records
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR run_id::text ILIKE $1 ESCAPE '\\'
          OR provider_tool_call_id ILIKE $1 ESCAPE '\\' OR capability ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'effect' AS kind, id::text AS id, organization_id, status AS state,
              'agent_effect_receipt' AS resource_type, created_at
       FROM agent_effect_receipts
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR run_id::text ILIKE $1 ESCAPE '\\'
          OR provider_tool_call_id ILIKE $1 ESCAPE '\\' OR capability ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'delivery' AS kind, id::text AS id, organization_id, status AS state,
              'delivery_attempt' AS resource_type, created_at
       FROM delivery_attempts
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR conversation_id::text ILIKE $1 ESCAPE '\\'
          OR message_id::text ILIKE $1 ESCAPE '\\' OR provider_message_id ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'conversation' AS kind, id::text AS id, organization_id, status AS state,
              'conversation' AS resource_type, created_at
       FROM conversations
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR installation_id::text ILIKE $1 ESCAPE '\\'
          OR owner_actor_id ILIKE $1 ESCAPE '\\' OR external_conversation_id ILIKE $1 ESCAPE '\\' OR title ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'message' AS kind, id::text AS id, organization_id, delivery_status AS state,
              'provider_message' AS resource_type, created_at
       FROM messages
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR conversation_id::text ILIKE $1 ESCAPE '\\'
          OR provider_message_id ILIKE $1 ESCAPE '\\' OR participant_id::text ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'memory' AS kind, id::text AS id, organization_id, status AS state,
              'memory_record' AS resource_type, created_at
       FROM memory_records
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\'
          OR agent_definition_id::text ILIKE $1 ESCAPE '\\' OR installation_id::text ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'audit' AS kind, id::text AS id, organization_id, action AS state,
              resource_type, created_at
       FROM audit_records
       WHERE id::text ILIKE $1 ESCAPE '\\' OR organization_id ILIKE $1 ESCAPE '\\' OR actor_id ILIKE $1 ESCAPE '\\'
          OR resource_id ILIKE $1 ESCAPE '\\' OR action ILIKE $1 ESCAPE '\\'
       ORDER BY created_at DESC LIMIT $2`,
      [`%${escapedQuery}%`, limit],
    );
    return { query: q, results: result.rows };
  });

  app.post("/v1/operator/commands", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:write");
    const command = operatorCommandInputSchema.parse(request.body ?? {});
    const result = await createOperatorCommand({
      actorId: auth.actorId,
      idempotencyKey: headerValue(request, "idempotency-key"),
      command,
      dependencies: { pool: dependencies.pool, runs, effectReceipts, runBudgets, killSwitches, controls, retention, memoryRetention, audioTranscriptionJobs, coreClient, agents, installationCredentials, schedules, channels, memoryDeletionJobs, memoryRevisionCommands, startWorkflow: dependencies.startWorkflow, signalCancellation: dependencies.signalCancellation },
    });
    return reply.code(result.replayed ? 200 : result.command.status === "awaiting_approval" ? 202 : 201).send(result.command);
  });

  app.get<{ Params: { commandId: string } }>("/v1/operator/commands/:commandId", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    return getOperatorCommand(dependencies.pool, request.params.commandId);
  });

  app.post<{ Params: { commandId: string } }>("/v1/operator/commands/:commandId/approve", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:write");
    return approveOperatorCommand({ actorId: auth.actorId, commandId: request.params.commandId, dependencies: { pool: dependencies.pool, runs, effectReceipts, runBudgets, killSwitches, controls, retention, memoryRetention, audioTranscriptionJobs, coreClient, agents, installationCredentials, schedules, channels, memoryDeletionJobs, memoryRevisionCommands, startWorkflow: dependencies.startWorkflow, signalCancellation: dependencies.signalCancellation } });
  });

  app.get<{ Params: { projectionKey: string } }>("/v1/operator/projections/:projectionKey", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    return getOperatorProjection(dependencies.pool, request.params.projectionKey);
  });

  app.post("/v1/operator/projections/rebuild", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:write");
    const body = z.object({ keys: z.array(z.string().trim().min(1).max(80)).max(20).default([]) }).parse(request.body ?? {});
    return { projections: await rebuildOperatorProjections(dependencies.pool, body.keys.length ? body.keys : undefined) };
  });

  app.get("/v1/operator/notifications", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:read");
    return { notifications: await listOperatorNotifications(dependencies.pool) };
  });

  app.post<{ Params: { notificationId: string } }>("/v1/operator/notifications/:notificationId/acknowledge", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireOperatorScope(auth, dependencies.config, "operator:write");
    return acknowledgeOperatorNotification(dependencies.pool, request.params.notificationId);
  });

  app.get("/.well-known/agent-installation-jwks.json", async () => {
    if (!dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY) throw Object.assign(new Error("Installation token signing is not configured"), { statusCode: 503 });
    return installationTokenJwks(dependencies.config.INSTALLATION_TOKEN_PRIVATE_KEY);
  });

  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: "/mcp",
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    authentication: "KasiTek Developer API key",
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
    enterDatabaseContext({ organizationId: "platform", actorId: "system:installation-token-exchange", operator: true });
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
    enterDatabaseContext({ organizationId: credential.organization_id, actorId: `installation-token:${credential.installation_id}` });
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
    const body = mcpEnvelopeSchema.parse(request.body);
    const inspection = inspectMcpRequest(body, request.headers);
    const isStateless = inspection.era === "stateless_2026";
    const statelessEnabled = dependencies.config.MCP_STATELESS_ENABLED !== false;
    const protocolVersion = isStateless && statelessEnabled ? MCP_STATELESS_PROTOCOL_VERSION : MCP_PROTOCOL_VERSION;
    const respond = (result: Record<string, unknown>) => {
      if (body.id === undefined) return reply.code(204).send();
      const normalized = isStateless ? completeResult(result, { serverInfo: MCP_SERVER_INFO }) : result;
      let encodedSize = 0;
      try {
        encodedSize = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: normalized }), "utf8");
      } catch {
        encodedSize = MCP_MAX_RESPONSE_BYTES + 1;
      }
      if (encodedSize > MCP_MAX_RESPONSE_BYTES) {
        return reply.code(413).send({ jsonrpc: "2.0", id: body.id, error: { code: -32011, message: "mcp_response_too_large" } });
      }
      return reply.send({ jsonrpc: "2.0", id: body.id, result: normalized });
    };
    const failure = (code: number, message: string, data?: unknown) => body.id === undefined
      ? reply.code(204).send()
      : reply.code(isStateless && code === -32601 ? 404 : 200).send({ jsonrpc: "2.0", id: body.id, error: { code, message, ...(data === undefined ? {} : { data }) } });
    const protocolFailure = (error: unknown) => {
      if (!(error instanceof McpProtocolError)) throw error;
      reply.header("mcp-protocol-version", protocolVersion);
      return reply.code(error.statusCode).send({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: error.rpcCode,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      });
    };
    if (isStateless && !statelessEnabled) {
      const error = unsupportedProtocolVersion(
        inspection.bodyProtocolVersion ?? inspection.headerProtocolVersion,
        [MCP_COMPATIBILITY_PROTOCOL_VERSION],
      );
      reply.header("mcp-protocol-version", MCP_PROTOCOL_VERSION);
      return reply.code(error.statusCode).send({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: error.rpcCode,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      });
    }
    if (isStateless) {
      try {
        validateStatelessRequest({ body, headers: request.headers, transport: "http" });
      } catch (error) {
        return protocolFailure(error);
      }
    } else {
      const headerProtocol = request.headers["mcp-protocol-version"];
      const requestedProtocol = typeof headerProtocol === "string"
        ? headerProtocol
        : typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : undefined;
      if (requestedProtocol && requestedProtocol !== MCP_PROTOCOL_VERSION) {
        reply.header("mcp-protocol-version", MCP_PROTOCOL_VERSION);
        return failure(-32602, "unsupported_mcp_protocol_version");
      }
    }
    reply.header("mcp-protocol-version", protocolVersion);
    if (dependencies.config.AGENT_GATEWAY_SHARED_SECRET && request.headers["x-agent-gateway-secret"] !== dependencies.config.AGENT_GATEWAY_SHARED_SECRET) {
      return failure(-32003, "gateway_authentication_required");
    }
    let auth: McpAuthContext;
    try {
      auth = await authenticateMcpRequest({ request, config: dependencies.config, installationCredentials, agents, toolRegistry, developerApiKeyResolver });
      requireMcpScope(auth, "mcp:read");
    } catch (error) {
      return failure(-32003, error instanceof Error ? error.message : "mcp_authentication_failed");
    }
    if (!(await controls.isFeatureEnabled(auth.organizationId, "mcp_enabled", auth.installationId))) {
      return failure(-32031, "mcp_feature_disabled", { code: "MCP_FEATURE_DISABLED" });
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
    if (body.method === "server/discover") {
      if (!isStateless) return failure(-32601, "method_not_found");
      return respond({
        supportedVersions: [MCP_STATELESS_PROTOCOL_VERSION, MCP_COMPATIBILITY_PROTOCOL_VERSION],
        capabilities: {
          tools: { listChanged: false },
          extensions: { [MCP_TASKS_EXTENSION]: {} },
        },
        instructions: "Use the filtered tools/list catalog and durable operation status for KasiTek capabilities.",
        ttlMs: MCP_DISCOVERY_CACHE_TTL_MS,
        cacheScope: "private",
      });
    }
    if (body.method === "initialize") {
      if (isStateless) return failure(-32601, "method_not_found");
      return respond({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO });
    }
    const params = body.params ?? {};
    const suppliedInstallationId = typeof params.installationId === "string" ? params.installationId : undefined;
    if (suppliedInstallationId && suppliedInstallationId !== auth.installationId) return failure(-32602, "installationId does not match authenticated installation");
    if (body.method === "tools/list") {
      const installation = await agents.getInstallation(auth.organizationId, auth.installationId);
      if (!installation || installation.status !== "active") return failure(-32004, "installation_not_found");
      const projected = await projectInstallationCapabilities({
        organizationId: auth.organizationId,
        installationId: installation.id,
        credentialScopes: auth.scopes,
        transport: "mcp",
      });
      const tools = (projected?.capabilities ?? [])
        .filter((capability) => capability.available)
        .map((capability) => ({
          ...capability.mcp,
          _meta: { "kasitek/effectiveAccess": capability.effectiveAccess },
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return respond(isStateless
        ? cacheableResult({ tools }, { ttlMs: MCP_TOOL_LIST_CACHE_TTL_MS, cacheScope: "private" }, { serverInfo: MCP_SERVER_INFO })
        : { tools });
    }
    if (body.method === "tasks/get") {
      if (!isStateless) return failure(-32601, "method_not_found");
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) return failure(-32602, "taskId is required");
      const run = await runs.getRun(auth.organizationId, taskId);
      if (!run || run.installation_id !== auth.installationId) return failure(-32004, "task_not_found");
      const task = publicMcpTask(run);
      const result: Record<string, unknown> = { task };
      if (task.status === "completed") {
        result.result = redactSensitiveValue(run.output ?? { runId: run.id, status: run.status });
      } else if (task.status === "failed") {
        result.error = {
          code: -32001,
          message: run.status === "expired" ? "operation_expired" : "operation_failed",
          ...(run.error ? { data: redactSensitiveValue(run.error) } : {}),
        };
      }
      return respond(result);
    }
    if (body.method === "tasks/cancel") {
      if (!isStateless) return failure(-32601, "method_not_found");
      try {
        requireMcpScope(auth, "mcp:write");
      } catch (error) {
        return failure(-32003, error instanceof Error ? error.message : "mcp_authorization_failed");
      }
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) return failure(-32602, "taskId is required");
      const run = await runs.getRun(auth.organizationId, taskId);
      if (!run || run.installation_id !== auth.installationId) return failure(-32004, "task_not_found");
      if (["completed", "failed", "cancelled", "expired"].includes(run.status)) return respond({});
      if (!dependencies.signalCancellation) return failure(-32004, "durable_mcp_execution_unavailable");
      const reason = typeof params.reason === "string" ? params.reason.trim().slice(0, 500) : "cancelled by MCP client";
      await dependencies.signalCancellation(run.id, { reason: `installation:${auth.installationId}: ${reason}` });
      return respond({});
    }
    if (body.method === "tasks/update") {
      if (!isStateless) return failure(-32601, "method_not_found");
      try {
        requireMcpScope(auth, "mcp:write");
      } catch (error) {
        return failure(-32003, error instanceof Error ? error.message : "mcp_authorization_failed");
      }
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) return failure(-32602, "taskId is required");
      const run = await runs.getRun(auth.organizationId, taskId);
      if (!run || run.installation_id !== auth.installationId) return failure(-32004, "task_not_found");
      // No current capability advertises an MRTR input request yet. Accept and
      // ignore unknown responses as permitted by the Tasks extension, while
      // keeping the task/run and authorization checks strict.
      return respond({});
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
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      if (!name) return failure(-32602, "name is required");
      const manifest = toolRegistry.get(name);
      if (!manifest) return failure(-32602, "tool_not_found");
      try {
        requireMcpScope(auth, manifest.riskClass === "read" ? "mcp:read" : "mcp:write");
      } catch (error) {
        return failure(-32003, error instanceof Error ? error.message : "mcp_authorization_failed");
      }
      const toolCallId = typeof params.toolCallId === "string" && params.toolCallId.length <= 240 ? params.toolCallId : `mcp:${randomUUID()}`;
      const suppliedIdempotencyKey = params.idempotencyKey;
      if (suppliedIdempotencyKey !== undefined
        && (typeof suppliedIdempotencyKey !== "string"
          || suppliedIdempotencyKey.trim().length < 8
          || suppliedIdempotencyKey.trim().length > 240)) {
        return failure(-32602, "idempotencyKey must be 8-240 characters when provided");
      }
      const idempotencyKey = typeof suppliedIdempotencyKey === "string"
        ? `mcp:${auth.credentialId}:${suppliedIdempotencyKey.trim()}`
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
          transport: "mcp",
        });
        const { accepted, manifest } = invocation;
        const immediate = "immediate" in invocation && invocation.immediate === true;
        const taskRequested = isStateless
          && clientSupportsExtension(inspection.metadata, MCP_TASKS_EXTENSION)
          && !immediate;
        if (taskRequested) {
          return respond({
            resultType: "task",
            task: publicMcpTask({ id: accepted.id, status: accepted.status }),
          });
        }
        return respond({
          content: [{ type: "text", text: `Accepted ${name} as operation ${accepted.id}.` }],
          isError: false,
          structuredContent: {
            runId: accepted.id,
            status: accepted.status,
            approvalRequired: manifest.requiresApproval,
            ...(immediate ? { output: invocation.output } : {}),
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
      if (isStateless) return failure(-32601, "notifications/cancelled is only supported by the pre-2026 compatibility path and stdio");
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
    await requireRestFeature(controls, auth);
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
        transport: "rest",
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
    await requireRestFeature(controls, auth);
    if (request.params.installationId !== auth.installationId) return reply.code(404).send({ error: "installation_not_found" });
    requireApiScope(auth, "api:read");
    const installation = await agents.getInstallation(auth.organizationId, auth.installationId);
    if (!installation || installation.status !== "active") return reply.code(404).send({ error: "installation_not_found" });
    const projected = await projectInstallationCapabilities({
      organizationId: auth.organizationId,
      installationId: installation.id,
      credentialScopes: auth.scopes,
      transport: "api",
    });
    return {
      installationId: installation.id,
      resourceScopes: projected?.grants.resources ?? [],
      connectors: projected?.grants.connectors ?? [],
      tools: (projected?.capabilities ?? []).filter((capability) => capability.available).map((capability) => ({
        ...capability,
        access: capability.effectiveAccess,
      })),
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

  app.get<{ Params: { installationId: string }; Querystring: { limit?: string } }>("/v1/installations/:installationId/operations", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    try {
      requireExternalConnected(installation);
    } catch {
      return reply.code(404).send({ error: "external_agent_not_found" });
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: "invalid_limit" });
    const [operations, summary] = await Promise.all([
      runs.listInstallationOperations(auth.organizationId, installation.id, limit),
      runs.installationOperationSummary(auth.organizationId, installation.id),
    ]);
    return { installationId: installation.id, operations, summary };
  });

  app.get<{ Params: { installationId: string; runId: string } }>("/v1/installations/:installationId/operations/:runId", async (request, reply) => {
    const auth = await authenticatePublicApiRequest({ request, config: dependencies.config, installationCredentials, agents });
    await requireRestFeature(controls, auth);
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
    await requireRestFeature(controls, auth);
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
    await requireRestFeature(controls, auth);
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

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/playground/ensure", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.ensurePlaygroundInstallation(auth.organizationId, auth.actorId, request.params.agentId);
    return reply.send(installation);
  });

  app.post("/v1/studio/agents", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = studioAgentCreationInputSchema.parse(request.body);
    const spec = agentSpecSchema.parse({
      specVersion: 1,
      execution: { mode: "autonomous", role: "standalone" },
      identity: {
        displayName: input.name,
        purpose: input.description,
        audience: "personal",
      },
      behavior: { instructions: input.instructions },
      model: {
        version: "studio-autonomous-v1",
        primary: {
          provider: dependencies.config.KASIAI_MODEL_PROVIDER,
          model: dependencies.config.KASIAI_MODEL,
        },
        fallback: [],
        allowUserFundedFallbackToKasiTek: false,
      },
      runtime: {
        maxContextMessages: 24,
        maxIterations: 8,
        maxModelCalls: 8,
        maxToolCalls: 12,
        maxTotalTokens: 24_000,
        maxWallTimeMs: 120_000,
      },
      capabilities: { allowedTools: [], requiredCapabilities: [] },
      knowledge: { sourceIds: [], requiredConnections: [] },
      memory: { mode: "explicit" },
      skills: { allowedSkillIds: [] },
      extensions: { packages: [], grants: [] },
      workflow: {},
      channels: { allowed: ["platform"] },
      release: { mode: "pinned" },
    });
    const created = await agents.createStudioAgent(auth.organizationId, auth.actorId, input, compileAgentSpec(spec));
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = updateAgentInputSchema.parse(request.body);
    return reply.send(await agents.updateAgent(auth.organizationId, auth.actorId, request.params.agentId, input));
  });

  app.delete<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    return reply.send(await agents.deleteAgent(auth.organizationId, auth.actorId, request.params.agentId));
  });

  app.post("/v1/external-agents", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = createExternalAgentInputSchema.parse(request.body);
    const unknownCapabilities = input.capabilities.filter((name) => !toolRegistry.get(name));
    if (unknownCapabilities.length) {
      return reply.code(400).send({ error: "unknown_capabilities", capabilities: unknownCapabilities });
    }
    const unavailableCapabilities = input.capabilities.filter((name) => {
      const manifest = toolRegistry.get(name)?.manifest;
      return manifest?.availability === "not_configured" || manifest?.availability === "unhealthy";
    });
    if (unavailableCapabilities.length) {
      return reply.code(409).send({ error: "capabilities_unavailable", capabilities: unavailableCapabilities });
    }
    const unknownConnectors = input.connectors.filter((id) => !connectorRegistry.get(id));
    if (unknownConnectors.length) {
      return reply.code(400).send({ error: "unknown_connectors", connectors: unknownConnectors });
    }
    const aggregate = await agents.createExternalInstallation(auth.organizationId, auth.actorId, input);
    if (!aggregate.created) {
      return reply.code(409).send({ error: "external_agent_idempotency_key_reused", installationId: aggregate.installation.id });
    }
    return reply.code(201).send({ ...aggregate, credential: aggregate.credential?.credential, secret: aggregate.credential?.secret });
  });

  app.get("/v1/external-agents", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { agents: await agents.listExternalAgents(auth.organizationId) };
  });

  app.get("/v1/external-agents/catalog", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const { capabilities } = await projectCapabilityCatalog(auth.organizationId);
    return {
      capabilities,
      connectors: connectorRegistry.list().map((connector) => ({
        id: connector.id,
        version: connector.version,
        displayName: connector.displayName,
        ownerService: connector.ownerService,
        auth: connector.auth,
        capabilityNames: connector.capabilityNames,
        requiredScopes: connector.requiredScopes,
        supportsReconciliation: connector.supportsReconciliation,
      })),
    };
  });

  app.get("/v1/capabilities", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return projectCapabilityCatalog(auth.organizationId);
  });

  app.get("/v1/capabilities/directory", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return projectCapabilityDirectory(auth.organizationId);
  });

  app.get("/v1/models/catalog", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return getKasiAiModelCatalog(dependencies.config);
  });

  app.get<{ Params: { installationId: string } }>("/v1/external-agents/:installationId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "external_agent_not_found" });
    try {
      requireExternalConnected(installation);
    } catch {
      return reply.code(404).send({ error: "external_agent_not_found" });
    }
    const [agent, versions, credentials, projected] = await Promise.all([
      agents.getAgent(auth.organizationId, installation.agent_definition_id),
      agents.listVersions(auth.organizationId, installation.agent_definition_id),
      installationCredentials.list(auth.organizationId, installation.id),
      projectInstallationCapabilities({ organizationId: auth.organizationId, installationId: installation.id, transport: "api" }),
    ]);
    const activeCredentials = credentials.filter((credential) => credential.status === "active");
    const lastUsedAt = credentials.map((credential) => credential.last_used_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return {
      agent,
      version: versions.find((version) => version.id === installation.agent_version_id) ?? null,
      installation,
      credentials,
      grants: projected?.grants ?? { resources: [], connectors: [] },
      capabilities: projected?.capabilities ?? [],
      health: {
        status: installation.status === "active" && activeCredentials.length > 0 ? "ready" : installation.status === "active" ? "needs_credential" : "paused",
        activeCredentialCount: activeCredentials.length,
        lastUsedAt,
      },
    };
  });

  app.get<{ Params: { installationId: string } }>("/v1/external-agents/:installationId/health", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "external_agent_not_found" });
    try {
      requireExternalConnected(installation);
    } catch {
      return reply.code(404).send({ error: "external_agent_not_found" });
    }
    const credentials = await installationCredentials.list(auth.organizationId, installation.id);
    const activeCredentials = credentials.filter((credential) => credential.status === "active");
    const lastUsedAt = credentials.map((credential) => credential.last_used_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return {
      installationId: installation.id,
      mode: installation.execution_mode,
      status: installation.status,
      health: {
        status: installation.status === "active" && activeCredentials.length > 0 ? "ready" : installation.status === "active" ? "needs_credential" : "paused",
        activeCredentialCount: activeCredentials.length,
        lastUsedAt,
      },
    };
  });

  app.delete<{ Params: { installationId: string } }>("/v1/external-agents/:installationId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "external_agent_not_found" });
    try {
      requireExternalConnected(installation);
    } catch {
      return reply.code(404).send({ error: "external_agent_not_found" });
    }
    const archived = await agents.archiveExternalInstallation(auth.organizationId, installation.id, auth.actorId);
    return reply.send({ archived: true, installation: archived });
  });

  app.post<{ Params: { installationId: string; status: "active" | "paused" | "disabled" } }>("/v1/external-agents/:installationId/status/:status", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "external_agent_not_found" });
    try {
      requireExternalConnected(installation);
    } catch {
      return reply.code(404).send({ error: "external_agent_not_found" });
    }
    const status = z.enum(["active", "paused", "disabled"]).parse(request.params.status);
    const updated = await agents.setInstallationStatus(auth.organizationId, installation.id, status, auth.actorId);
    return reply.send(updated);
  });

  app.get<{ Querystring: { environment?: string } }>("/v1/agents", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const environment = request.query.environment
      ? z.enum(["playground", "live"]).parse(request.query.environment)
      : undefined;
    const listedAgents = await agents.listAgents(auth.organizationId, { environment });
    const counts = !environment && typeof agents.countAgentsByAudience === "function"
      ? await agents.countAgentsByAudience(auth.organizationId)
      : listedAgents.reduce(
        (summary, agent) => {
          if (agent.status === "archived") return summary;
          summary.total += 1;
          if (agent.agent_audience === "customer_service") summary.customer_service += 1;
          else summary.personal += 1;
          return summary;
        },
        { total: 0, personal: 0, customer_service: 0 },
      );
    return { agents: listedAgents, counts };
  });

  app.get<{ Querystring: { audience?: string } }>("/v1/templates", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const audience = request.query.audience ? z.enum(["personal", "customer_service"]).parse(request.query.audience) : undefined;
    return { templates: listAgentTemplates(audience) };
  });

  app.post<{ Params: { installationId: string; catalogId: string }; Body: { agentVersionId?: string } }>("/v1/installations/:installationId/skills/catalog/:catalogId/install", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const entry = getReviewedSkillCatalogEntry(request.params.catalogId);
    if (!entry) return reply.code(404).send({ error: "skill_catalog_entry_not_found" });
    const input = z.object({ agentVersionId: z.string().uuid().optional() }).strict().parse(request.body ?? {});
    let definition = await skills.getByCatalogId(auth.organizationId, entry.id);
    let version = definition ? (await skills.listVersions(auth.organizationId, definition.id)).find((candidate) => candidate.status === "published") : undefined;
    if (!definition || !version) {
      try {
        const instructions = await fetchHermesSkillInstructions(entry.rawUrl);
        definition = await skills.createSkill(auth.organizationId, auth.actorId, {
          slug: hermesSkillSlug(entry.slug),
          name: entry.name,
          description: entry.description,
          ownerType: "organization",
          catalogId: entry.id,
        });
        const created = await skills.createVersion(auth.organizationId, auth.actorId, definition.id, {
          instructions,
          matching: { keywords: [entry.name, ...entry.tags].slice(0, 50), phrases: [], channels: [], audiences: [] },
          requiredCapabilities: [],
          requiredConnectors: [],
          knowledgeSourceIds: [],
          compatibleChannels: [],
          compatibleAudiences: [],
        });
        version = await skills.publishVersion(auth.organizationId, auth.actorId, definition.id, created.id);
      } catch (error) {
        request.log.warn({ event: "hermes_skill.install_failed", catalog_id: entry.id, error_code: error instanceof Error ? error.message : "unknown" }, "Hermes skill installation failed");
        return reply.code(502).send({ error: "skill_catalog_install_failed" });
      }
    }
    if (!version) return reply.code(502).send({ error: "skill_catalog_version_missing" });
    let pinned = false;
    if (input.agentVersionId) {
      await skills.pinVersion(auth.organizationId, auth.actorId, input.agentVersionId, version.id);
      pinned = true;
    }
    return reply.code(201).send({ skill: definition, version, pinned });
  });

  app.get("/v1/skills", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { skills: await skills.listSkills(auth.organizationId) };
  });

  app.get<{ Querystring: { kind?: string } }>("/v1/extensions/packages", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const kind = request.query.kind;
    if (kind && !(["skill", "plugin", "connector", "mcp_capability"] as ExtensionKind[]).includes(kind as ExtensionKind)) {
      throw Object.assign(new Error("Invalid extension package kind"), { statusCode: 400, code: "extension_package_kind_invalid" });
    }
    return {
      packages: (await extensionSnapshots.listPackages(auth.organizationId, kind as ExtensionKind | undefined))
        .filter((entry) => entry.status === "published"),
    };
  });

  app.post("/v1/skills", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const skill = await skills.createSkill(auth.organizationId, auth.actorId, createSkillInputSchema.parse(request.body));
    return reply.code(201).send(skill);
  });

  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId/versions", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { versions: await skills.listVersions(auth.organizationId, request.params.skillId) };
  });

  app.post<{ Params: { skillId: string } }>("/v1/skills/:skillId/versions", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const version = await skills.createVersion(auth.organizationId, auth.actorId, request.params.skillId, createSkillVersionInputSchema.parse(request.body));
    return reply.code(201).send(version);
  });

  app.post<{ Params: { skillId: string; versionId: string } }>("/v1/skills/:skillId/versions/:versionId/publish", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    return skills.publishVersion(auth.organizationId, auth.actorId, request.params.skillId, request.params.versionId);
  });

  app.post<{ Params: { agentVersionId: string; skillVersionId: string } }>("/v1/agent-versions/:agentVersionId/skills/:skillVersionId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await skills.pinVersion(auth.organizationId, auth.actorId, request.params.agentVersionId, request.params.skillVersionId);
    return reply.code(204).send();
  });

  app.delete<{ Params: { agentVersionId: string; skillVersionId: string } }>("/v1/agent-versions/:agentVersionId/skills/:skillVersionId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await skills.unpinVersion(auth.organizationId, request.params.agentVersionId, request.params.skillVersionId);
    return reply.code(204).send();
  });

  app.get<{ Params: { agentVersionId: string } }>("/v1/agent-versions/:agentVersionId/skills", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { skills: await skills.loadPinnedVersions(auth.organizationId, request.params.agentVersionId) };
  });

  app.get("/v1/mcp/providers", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { providers: (await remoteMcpProviders.list(auth.organizationId)).filter(isCustomRemoteMcpProvider) };
  });

  app.post("/v1/mcp/providers", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const provider = await remoteMcpProviders.create(auth.organizationId, auth.actorId, createRemoteMcpProviderInputSchema.parse(request.body));
    return reply.code(201).send(provider);
  });

  app.post<{ Params: { providerId: string } }>("/v1/mcp/providers/:providerId/discover", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    try {
      return reply.code(201).send(await remoteMcpProviders.discover(auth.organizationId, auth.actorId, request.params.providerId));
    } catch (error) {
      request.log.warn({ event: "remote_mcp.discovery_failed", provider_id: request.params.providerId, error_code: error instanceof Error ? error.message : "unknown" }, "Remote MCP discovery failed");
      return reply.code(502).send({ error: "remote_mcp_discovery_failed" });
    }
  });

  app.post<{ Params: { providerId: string } }>("/v1/mcp/providers/:providerId/health", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    try {
      return reply.send(await remoteMcpProviders.healthCheck(auth.organizationId, request.params.providerId));
    } catch (error) {
      request.log.warn({ event: "remote_mcp.health_check_failed", provider_id: request.params.providerId, error_code: error instanceof Error ? error.message : "unknown" }, "Remote MCP health check failed");
      return reply.code(502).send({ error: "remote_mcp_health_check_failed" });
    }
  });

  app.get<{ Params: { providerId: string } }>("/v1/mcp/providers/:providerId/versions", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { versions: await remoteMcpProviders.listVersions(auth.organizationId, request.params.providerId) };
  });

  app.post<{ Params: { providerId: string; versionId: string } }>("/v1/mcp/providers/:providerId/versions/:versionId/publish", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    return remoteMcpProviders.publish(auth.organizationId, auth.actorId, request.params.providerId, request.params.versionId);
  });

  app.post<{ Params: { providerId: string } }>("/v1/mcp/providers/:providerId/revoke", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await remoteMcpProviders.revoke(auth.organizationId, auth.actorId, request.params.providerId);
    return { revoked: true };
  });

  app.post<{ Params: { agentVersionId: string; providerVersionId: string } }>("/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await remoteMcpProviders.pin(auth.organizationId, auth.actorId, request.params.agentVersionId, request.params.providerVersionId);
    return reply.code(204).send();
  });

  app.delete<{ Params: { agentVersionId: string; providerVersionId: string } }>("/v1/agent-versions/:agentVersionId/mcp-providers/:providerVersionId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    await remoteMcpProviders.unpin(auth.organizationId, request.params.agentVersionId, request.params.providerVersionId);
    return reply.code(204).send();
  });

  app.get<{ Params: { agentVersionId: string } }>("/v1/agent-versions/:agentVersionId/mcp-providers", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { providers: await remoteMcpProviders.listPinned(auth.organizationId, request.params.agentVersionId) };
  });

  app.get<{
    Params: { agentVersionId: string };
    Querystring: { installationId?: string; compareVersionId?: string };
  }>("/v1/agent-versions/:agentVersionId/effective-config", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const version = await agents.getVersion(auth.organizationId, request.params.agentVersionId);
    if (!version) return reply.code(404).send({ error: "agent_version_not_found" });

    const installationId = request.query.installationId?.trim() || undefined;
    const installation = installationId
      ? (await agents.getInstallation(auth.organizationId, installationId) ?? undefined)
      : undefined;
    if (installationId && !installation) return reply.code(404).send({ error: "installation_not_found" });
    if (installation && installation.agent_definition_id !== version.agent_definition_id) {
      return reply.code(409).send({ error: "installation_agent_mismatch" });
    }

    const effective = await projectAgentVersionConfig({
      organizationId: auth.organizationId,
      version,
      installation,
    });
    const compareVersionId = request.query.compareVersionId?.trim() || undefined;
    if (!compareVersionId) return { effective };
    const deployed = await agents.getVersion(auth.organizationId, compareVersionId);
    if (!deployed) return reply.code(404).send({ error: "comparison_version_not_found" });
    if (deployed.agent_definition_id !== version.agent_definition_id) {
      return reply.code(400).send({ error: "comparison_agent_mismatch" });
    }
    const deployedEffective = await projectAgentVersionConfig({
      organizationId: auth.organizationId,
      version: deployed,
      installation,
    });
    return {
      effective,
      comparison: {
        deployed: deployedEffective,
        diff: diffEffectiveAgentConfig(effective, deployedEffective),
      },
    };
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
    const requestedTools = Array.isArray(input.policy.allowedTools)
      ? input.policy.allowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      : [];
    const unknownTools = [...new Set(requestedTools.filter((tool) => !toolRegistry.get(tool)))];
    if (unknownTools.length) return reply.code(400).send({ error: "unknown_tools", tools: unknownTools });
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
      const targetAgent = typeof agents.getAgent === "function" ? await agents.getAgent(auth.organizationId, request.params.agentId) : null;
      if (targetAgent?.owner_type === "system" && targetAgent.protected === true) {
        return reply.code(403).send({ error: "protected_installation_policy", code: "PROTECTED_SERVICE_ALLOWLIST_RELEASE_MANAGED" });
      }
      const input = z.object({ toolName: z.string().trim().min(1).max(160) }).parse(request.body);
      if (!toolRegistry.get(input.toolName)) return reply.code(400).send({ error: "unknown_tool", tool: input.toolName });
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
    const targetInstallation = typeof agents.getInstallation === "function" ? await agents.getInstallation(auth.organizationId, request.params.installationId) : null;
    if (targetInstallation?.agent_owner_type === "system" && targetInstallation.agent_protected === true) {
      return reply.code(403).send({ error: "protected_installation_policy", code: "PROTECTED_SERVICE_ALLOWLIST_RELEASE_MANAGED" });
    }
    const input = z.object({ toolName: z.string().trim().min(1).max(160) }).parse(request.body);
    if (!toolRegistry.get(input.toolName)) return reply.code(400).send({ error: "unknown_tool", tool: input.toolName });
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
    const parsed = createInstallationInputSchema.parse(request.body);
    const input = { ...parsed, scopeId: parsed.scopeId ?? auth.organizationId };
    const installation = await agents.createInstallation(auth.organizationId, auth.actorId, input);
    return reply.code(201).send(installation);
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/deploy", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = deployInstallationInputSchema.parse(request.body);
    return agents.deployInstallation(auth.organizationId, auth.actorId, request.params.installationId, input);
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/deployment-status", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const status = await agents.getDeploymentStatus(auth.organizationId, request.params.agentId);
    if (!status) return reply.code(404).send({ error: "agent_not_found" });
    return status;
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/preflight", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const input = installationDeploymentPreflightInputSchema.parse(request.body);
    return agents.preflightInstallationDeployment(auth.organizationId, request.params.installationId, input);
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/promote", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = installationPromotionInputSchema.parse(request.body);
    try {
      return await agents.promoteInstallation(auth.organizationId, auth.actorId, request.params.installationId, input);
    } catch (error) {
      const typed = error as { statusCode?: number; code?: string; preflight?: unknown };
      if (typed.code === "PROMOTION_PREFLIGHT_BLOCKED" && typed.preflight) {
        return reply.code(409).send({ error: typed.code, code: typed.code, preflight: typed.preflight });
      }
      throw error;
    }
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/rollback", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = installationRollbackInputSchema.parse(request.body ?? {});
    return agents.rollbackInstallation(auth.organizationId, auth.actorId, request.params.installationId, input);
  });

  app.post<{ Params: { agentId: string; versionId: string } }>(
    "/v1/agents/:agentId/versions/:versionId/deploy",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:write");
      const input = deployStagedVersionInputSchema.parse(request.body);
      return agents.deployStagedVersion(auth.organizationId, auth.actorId, request.params.agentId, request.params.versionId, input);
    },
  );

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/readiness", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const evaluated = await evaluateInstallationReadiness({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      actorId: auth.actorId,
      correlationId: auth.correlationId,
      evaluationSource: "readiness_route",
    });
    if (!evaluated) return reply.code(404).send({ error: "installation_not_found" });
    return {
      installationId: evaluated.installation.id,
      agentId: evaluated.agent.id,
      versionId: evaluated.version.id,
      profile: evaluated.agent.creation_profile,
      executionMode: evaluated.installation.execution_mode,
      ...evaluated.readiness,
      capabilities: evaluated.projected.capabilities,
    };
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
    const credential = request.query.credentialId ? await installationCredentials.getActiveForToken({ credentialId: request.query.credentialId, organizationId: auth.organizationId, installationId: request.params.installationId }) : null;
    const projected = await projectInstallationCapabilities({
      organizationId: auth.organizationId,
      installationId: installation.id,
      credentialScopes: credential?.api_scopes ?? undefined,
      transport: "api",
    });
    return { installationId: installation.id, apiScopes: credential?.api_scopes ?? null, resourceScopes: projected?.grants.resources ?? [], connectors: projected?.grants.connectors ?? [], capabilities: projected?.capabilities ?? [] };
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/credentials", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireExternalConnected(installation);
    return { credentials: await installationCredentials.list(auth.organizationId, request.params.installationId) };
  });

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/credentials", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireExternalConnected(installation);
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
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireExternalConnected(installation);
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
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireExternalConnected(installation);
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

  app.get("/v1/integrations/catalog", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    return { integrations: listIntegrations() };
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/connection-directory", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const [connections, providers] = await Promise.all([
      integrationRepository.listConnections(auth.organizationId, installation.id),
      remoteMcpProviders.list(auth.organizationId),
    ]);
    const nativeById = new Map(connections.map((connection) => [connection.integration_id, connection]));
    const providerByCatalogId = new Map(providers.filter((provider) => provider.catalog_id).map((provider) => [provider.catalog_id!, provider]));
    return {
      installationId: installation.id,
      connections: listConnectionDirectory().map((entry) => {
        if (entry.kind === "native") {
          const connection = nativeById.get(entry.id);
          const ready = entry.auth === "internal";
          const status = ready ? "ready" as const : connection?.status === "connected" ? "connected" as const : connection?.status === "unhealthy" ? "unhealthy" as const : "not_configured" as const;
          return { ...entry, configured: ready || Boolean(connection), status, connectionId: connection?.id ?? null };
        }
        const provider = providerByCatalogId.get(entry.id);
        const status = !entry.managed
          ? "unsupported" as const
          : provider?.health_status === "unhealthy"
            ? "unhealthy" as const
            : provider
              ? "connected" as const
              : "not_configured" as const;
        return { ...entry, configured: Boolean(provider), status, providerId: provider?.id ?? null };
      }),
    };
  });

  app.get<{ Querystring: { agentVersionId?: string } }>("/v1/skills/directory", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const definitions = await skills.listSkills(auth.organizationId);
    const installed = new Map(definitions.filter((definition) => definition.catalog_id).map((definition) => [definition.catalog_id!, definition]));
    const pinned = request.query.agentVersionId
      ? new Set((await skills.loadPinnedVersions(auth.organizationId, request.query.agentVersionId)).map((version) => version.id))
      : new Set<string>();
    const entries = await Promise.all(listSkillDirectory().map(async (entry) => {
      const definition = installed.get(entry.id);
      const versions = definition ? await skills.listVersions(auth.organizationId, definition.id) : [];
      const version = versions.find((candidate) => candidate.status === "published") ?? versions[0];
      return { ...entry, installed: Boolean(definition), skillId: definition?.id ?? null, versionId: version?.id ?? null, enabled: Boolean(version && pinned.has(version.id)) };
    }));
    return { skills: entries };
  });

  app.get<{ Querystring: { agentVersionId?: string; installationId?: string } }>("/v1/plugins/directory", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    if (request.query.installationId && !await agents.getInstallation(auth.organizationId, request.query.installationId)) {
      return reply.code(404).send({ error: "installation_not_found" });
    }
    const packages = (await extensionSnapshots.listPackages(auth.organizationId, "plugin"))
      .filter((entry) => entry.status === "published" || entry.status === "deprecated");
    const installed = new Map(packages.map((entry) => [`${entry.package_id}:${entry.version}`, entry]));
    return {
      plugins: await Promise.all(listPluginDirectory().map(async (entry) => {
        const packageRecord = installed.get(`${entry.id}:${entry.version}`);
        return {
          ...entry,
          installed: Boolean(packageRecord),
          packageId: packageRecord?.package_id ?? null,
          packageVersionId: packageRecord?.id ?? null,
          packageStatus: packageRecord?.status ?? null,
          ...(request.query.installationId ? { readiness: await pluginReadiness(auth.organizationId, entry, request.query.installationId) } : {}),
        };
      })),
    };
  });

  app.post<{ Params: { installationId: string; catalogId: string } }>("/v1/installations/:installationId/plugins/catalog/:catalogId/install", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const entry = getReviewedPluginCatalogEntry(request.params.catalogId);
    if (!entry) return reply.code(404).send({ error: "plugin_catalog_entry_not_found" });
    const adapter = getPluginAdapter(entry);
    if (!adapter) return reply.code(409).send({ error: "plugin_adapter_unavailable" });
    const adapterStatus = getReviewedPluginAdapterStatus(entry);
    const packageInput = {
      declaration: {
        kind: "plugin" as const,
        id: entry.id,
        version: entry.version,
        checksum: entry.checksum,
        name: entry.name,
        available: true,
        installed: true,
        configured: true,
        capabilityIds: getReviewedPluginAdapterCapabilityIds(entry),
      },
      compatibility: {
        constraints: {
          source: "reviewed-catalog",
          sourceUrl: entry.sourceUrl,
          adapterStatus,
          adapterProtocolVersion: adapter.identity.protocolVersion,
          adapterExecutionMode: adapter.executionMode,
          adapterConnectorIds: getReviewedPluginAdapterConnectorIds(entry),
          requiredCredentialRefs: adapter.requiredCredentialRefs,
          requiredEnv: entry.requiredEnv,
          providedProviders: entry.providedProviders,
          hooks: entry.hooks,
          platforms: entry.platforms,
        },
      },
    };
    try {
      const existing = (await extensionSnapshots.listPackages(auth.organizationId, "plugin"))
        .find((candidate) => candidate.package_id === entry.id && candidate.version === entry.version);
      const pkg = existing ?? await extensionSnapshots.createPackage(auth.organizationId, auth.actorId, packageInput);
      const published = pkg.status === "draft" ? await extensionSnapshots.publishPackage(auth.organizationId, auth.actorId, pkg.id) : pkg;
      return reply.code(existing ? 200 : 201).send({ plugin: entry, package: published, installationId: installation.id });
    } catch (error) {
      request.log.warn({ event: "hermes_plugin.install_failed", catalog_id: entry.id, error_code: error instanceof Error ? error.message : "unknown" }, "Hermes plugin install failed");
      return reply.code(502).send({ error: "plugin_catalog_install_failed" });
    }
  });

  app.get<{ Params: { installationId: string; integrationId: string } }>("/v1/installations/:installationId/integrations/:integrationId/oauth/start", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const entry = getIntegration(request.params.integrationId);
    if (!entry || entry.kind !== "tool" || entry.auth !== "oauth2" || !entry.oauthProvider || entry.requiredScopes.length === 0) {
      return reply.code(400).send({ error: "oauth_integration_not_supported", code: "oauth_integration_not_supported" });
    }
    const clientId = dependencies.config.GOOGLE_OAUTH_CLIENT_ID;
    const redirectUri = dependencies.config.GOOGLE_OAUTH_REDIRECT_URI;
    if (!clientId || !dependencies.config.GOOGLE_OAUTH_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "google_oauth_not_configured", code: "google_oauth_not_configured" });
    }
    const state = randomBytes(32).toString("base64url");
    await integrationRepository.createOAuthState({ organizationId: auth.organizationId, installationId: installation.id, integrationId: entry.id, stateHash: createHash("sha256").update(state).digest("hex"), redirectUri, createdBy: auth.actorId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), flow: "native" });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true", scope: entry.requiredScopes.join(" "), state }).toString();
    return { authorizationUrl: authorizationUrl.toString() };
  });

  app.post<{ Params: { installationId: string; catalogId: string }; Body: { agentVersionId?: string; apiKey?: string } }>("/v1/installations/:installationId/mcp/catalog/:catalogId/connect", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const entry = getReviewedMcpCatalogEntry(request.params.catalogId);
    if (!entry || !entry.managed || !entry.endpointUrl) return reply.code(400).send({ error: "mcp_catalog_entry_not_connectable" });
    const authMode = entry.auth as string;
    if (authMode === "oauth") return reply.code(400).send({ error: "mcp_catalog_entry_requires_oauth" });
    const input = z.object({ agentVersionId: z.string().uuid().optional(), apiKey: z.string().trim().min(1).max(4_000).optional() }).strict().parse(request.body ?? {});
    if (authMode === "api_key" && !input.apiKey) return reply.code(400).send({ error: "mcp_api_key_required" });
    if (authMode === "none" && input.apiKey) return reply.code(400).send({ error: "mcp_api_key_not_expected" });
    let credentialId: string | null = null;
    try {
      if (input.apiKey) {
        const credential = await integrationRepository.storeCredential({ organizationId: auth.organizationId, integrationId: entry.id, secret: input.apiKey, label: `${entry.name} MCP`, actorId: auth.actorId });
        credentialId = credential.id;
      }
      const activated = await activateHermesMcp({ organizationId: auth.organizationId, actorId: auth.actorId, catalogId: entry.id, credentialReference: credentialId, agentVersionId: input.agentVersionId });
      return reply.code(201).send(activated);
    } catch (error) {
      if (credentialId) await integrationRepository.revokeCredential(auth.organizationId, credentialId).catch(() => undefined);
      request.log.warn({ event: "hermes_mcp.catalog_connect_failed", catalog_id: entry.id, error_code: error instanceof Error ? error.message : "unknown" }, "Hermes MCP catalogue connection failed");
      return reply.code(502).send({ error: "mcp_catalog_connection_failed" });
    }
  });

  app.post<{ Params: { installationId: string; catalogId: string }; Body: { agentVersionId?: string; clientId?: string; clientSecret?: string } }>("/v1/installations/:installationId/mcp/catalog/:catalogId/oauth/start", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const entry = getReviewedMcpCatalogEntry(request.params.catalogId);
    if (!entry || !entry.managed || entry.auth !== "oauth" || !entry.endpointUrl) return reply.code(400).send({ error: "mcp_catalog_entry_not_oauth" });
    const redirectUri = dependencies.config.MCP_OAUTH_REDIRECT_URI;
    if (!redirectUri) return reply.code(503).send({ error: "mcp_oauth_not_configured", code: "mcp_oauth_not_configured" });
    const input = z.object({
      agentVersionId: z.string().uuid().optional(),
      clientId: z.string().trim().min(1).max(500).optional(),
      clientSecret: z.string().trim().min(1).max(2_000).optional(),
    }).strict().parse(request.body ?? {});
    if (!input.clientId && input.clientSecret) return reply.code(400).send({ error: "mcp_oauth_client_id_required" });
    try {
      const discovery = await discoverMcpOAuth({ endpointUrl: entry.endpointUrl, environment: dependencies.config.NODE_ENV });
      const client = input.clientId
        ? {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          authorizationEndpoint: discovery.authorizationEndpoint,
          tokenEndpoint: discovery.tokenEndpoint,
          resource: discovery.resource,
          scope: discovery.scopesSupported.length ? discovery.scopesSupported.join(" ") : undefined,
        }
        : await registerMcpOAuthClient({ discovery, redirectUri, clientName: dependencies.config.MCP_OAUTH_CLIENT_NAME, environment: dependencies.config.NODE_ENV });
      const pkce = createPkcePair();
      await integrationRepository.createOAuthState({ organizationId: auth.organizationId, installationId: installation.id, integrationId: entry.id, stateHash: createHash("sha256").update(pkce.state).digest("hex"), redirectUri, createdBy: auth.actorId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), flow: "mcp", codeVerifier: pkce.codeVerifier, clientId: client.clientId, clientSecret: client.clientSecret, resource: client.resource, authorizationEndpoint: client.authorizationEndpoint, tokenEndpoint: client.tokenEndpoint, agentVersionId: input.agentVersionId });
      return { authorizationUrl: buildMcpAuthorizationUrl({ client, redirectUri, state: pkce.state, codeChallenge: pkce.codeChallenge }) };
    } catch (error) {
      const providerError = error instanceof Error ? error.message : "unknown";
      request.log.warn({ event: "hermes_mcp.oauth_start_failed", catalog_id: entry.id, error_code: providerError }, "Hermes MCP OAuth start failed");
      const code = providerError === "MCP_OAUTH_CLIENT_REGISTRATION_UNSUPPORTED"
        ? "mcp_oauth_client_registration_unsupported"
        : providerError === "MCP_OAUTH_CLIENT_REGISTRATION_FAILED"
          ? "mcp_oauth_client_registration_failed"
          : providerError.startsWith("MCP_OAUTH_")
            ? "mcp_oauth_provider_unavailable"
          : "mcp_oauth_start_failed";
      const statusCode = code === "mcp_oauth_client_registration_unsupported" ? 409 : 502;
      return reply.code(statusCode).send({ error: code, code });
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/v1/integrations/google/oauth/callback", async (request, reply) => {
    const state = request.query.state;
    if (!state) return reply.code(400).send({ error: "oauth_state_missing" });
    const stateRecord = await integrationRepository.consumeOAuthState(createHash("sha256").update(state).digest("hex"));
    const entry = stateRecord ? getIntegration(stateRecord.integration_id) : undefined;
    if (!stateRecord || stateRecord.flow !== "native" || !entry || entry.kind !== "tool" || entry.auth !== "oauth2" || !entry.id.startsWith("google.")) return reply.code(400).send({ error: "oauth_state_invalid_or_expired" });
    const returnError = (statusCode: number, code: string) => {
      const payload = { integration: entry.id, status: "error", error: code, installationId: stateRecord.installation_id };
      if (dependencies.config.AGENT_INTEGRATIONS_RETURN_URL && request.headers["x-kasitek-oauth-proxy"] !== "1") {
        const returnUrl = new URL(dependencies.config.AGENT_INTEGRATIONS_RETURN_URL);
        returnUrl.searchParams.set("integration", payload.integration);
        returnUrl.searchParams.set("status", payload.status);
        returnUrl.searchParams.set("error", payload.error);
        returnUrl.searchParams.set("installationId", payload.installationId);
        return reply.redirect(returnUrl.toString());
      }
      return reply.code(statusCode).send(payload);
    };
    if (request.query.error || !request.query.code) return returnError(400, request.query.error ?? "oauth_code_missing");
    const clientId = dependencies.config.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = dependencies.config.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return returnError(503, "google_oauth_not_configured");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: request.query.code, client_id: clientId, client_secret: clientSecret, redirect_uri: stateRecord.redirect_uri, grant_type: "authorization_code" }), signal: AbortSignal.timeout(20_000) });
    if (!tokenResponse.ok) return returnError(502, "google_token_exchange_failed");
    const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!token.access_token) return returnError(502, "google_access_token_missing");
    const credential = await integrationRepository.storeCredential({ organizationId: stateRecord.organization_id, integrationId: entry.id, secret: JSON.stringify({ accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000).toISOString(), scope: token.scope }), label: entry.name, actorId: stateRecord.created_by });
    await integrationRepository.upsertConnection({ organizationId: stateRecord.organization_id, installationId: stateRecord.installation_id, integrationId: entry.id, credentialId: credential.id, status: "connected", configuration: entry.id === "google.calendar" ? { calendarId: "primary" } : {}, actorId: stateRecord.created_by });
    if (dependencies.config.AGENT_INTEGRATIONS_RETURN_URL && request.headers["x-kasitek-oauth-proxy"] !== "1") {
      const returnUrl = new URL(dependencies.config.AGENT_INTEGRATIONS_RETURN_URL);
      returnUrl.searchParams.set("integration", entry.id);
      returnUrl.searchParams.set("status", "connected");
      returnUrl.searchParams.set("installationId", stateRecord.installation_id);
      return reply.redirect(returnUrl.toString());
    }
    return { integration: entry.id, status: "connected", installationId: stateRecord.installation_id };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/v1/integrations/mcp/oauth/callback", async (request, reply) => {
    const state = request.query.state;
    if (!state) return reply.code(400).send({ error: "oauth_state_missing" });
    const stateRecord = await integrationRepository.consumeOAuthState(createHash("sha256").update(state).digest("hex"));
    if (!stateRecord || stateRecord.flow !== "mcp") return reply.code(400).send({ error: "oauth_state_invalid_or_expired" });
    const entry = getReviewedMcpCatalogEntry(stateRecord.integration_id);
    const returnError = (code: string) => {
      if (dependencies.config.AGENT_INTEGRATIONS_RETURN_URL && request.headers["x-kasitek-oauth-proxy"] !== "1") {
        const returnUrl = new URL(dependencies.config.AGENT_INTEGRATIONS_RETURN_URL);
        returnUrl.searchParams.set("connection", stateRecord.integration_id);
        returnUrl.searchParams.set("status", "error");
        returnUrl.searchParams.set("error", code);
        returnUrl.searchParams.set("installationId", stateRecord.installation_id);
        return reply.redirect(returnUrl.toString());
      }
      return reply.code(502).send({ error: code });
    };
    if (!entry || !entry.endpointUrl || !stateRecord.code_verifier || !stateRecord.client_id || !stateRecord.authorization_endpoint || !stateRecord.token_endpoint) return returnError("mcp_oauth_state_incomplete");
    if (request.query.error || !request.query.code) return returnError(request.query.error ?? "mcp_oauth_code_missing");
    try {
      const token = await exchangeMcpOAuthCode({
        client: { clientId: stateRecord.client_id, clientSecret: stateRecord.client_secret ?? undefined, authorizationEndpoint: stateRecord.authorization_endpoint, tokenEndpoint: stateRecord.token_endpoint, resource: stateRecord.resource ?? entry.endpointUrl },
        redirectUri: stateRecord.redirect_uri,
        code: request.query.code,
        codeVerifier: stateRecord.code_verifier,
        environment: dependencies.config.NODE_ENV,
      });
      const credential = await integrationRepository.storeCredential({ organizationId: stateRecord.organization_id, integrationId: entry.id, secret: JSON.stringify(token), label: `${entry.name} MCP`, actorId: stateRecord.created_by });
      const activated = await activateHermesMcp({ organizationId: stateRecord.organization_id, actorId: stateRecord.created_by, catalogId: entry.id, credentialReference: credential.id, agentVersionId: stateRecord.agent_version_id ?? undefined });
      if (dependencies.config.AGENT_INTEGRATIONS_RETURN_URL && request.headers["x-kasitek-oauth-proxy"] !== "1") {
        const returnUrl = new URL(dependencies.config.AGENT_INTEGRATIONS_RETURN_URL);
        returnUrl.searchParams.set("connection", entry.id);
        returnUrl.searchParams.set("status", "connected");
        returnUrl.searchParams.set("installationId", stateRecord.installation_id);
        return reply.redirect(returnUrl.toString());
      }
      return { connection: entry.id, status: "connected", installationId: stateRecord.installation_id, provider: activated.provider, version: activated.version };
    } catch (error) {
      request.log.warn({ event: "hermes_mcp.oauth_callback_failed", catalog_id: entry.id, error_code: error instanceof Error ? error.message : "unknown" }, "Hermes MCP OAuth callback failed");
      return returnError("mcp_oauth_connection_failed");
    }
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/integrations", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const [connections, channelConnections] = await Promise.all([
      integrationRepository.listConnections(auth.organizationId, installation.id),
      channels.listConnections(auth.organizationId, installation.id),
    ]);
    const byIntegration = new Map(connections.map((connection) => [connection.integration_id, connection]));
    return {
      installationId: installation.id,
      integrations: await Promise.all(listIntegrations().map(async (integration) => {
        if (integration.kind === "channel") {
          const matchingConnections = channelConnections.filter((connection) => connection.channel_type === integration.channelType && connection.status !== "revoked");
          const connection = matchingConnections.find((candidate) => candidate.status === "active") ?? matchingConnections[0];
          const connected = connection?.status === "active";
          return {
            ...integration,
            status: connected ? "connected" : connection?.status === "failed" || connection?.status === "paused" ? "unhealthy" : "not_configured",
            available: connected,
            hasCredential: Boolean(connection?.credential_reference),
            connectionId: connection?.id ?? null,
            connectionCount: matchingConnections.length,
            configuration: connection ? { channelKey: connection.channel_key } : {},
            healthMessage: connection?.status === "failed" ? "The channel connection failed." : null,
            lastCheckedAt: connection?.updated_at ?? null,
          };
        }
        const connection = byIntegration.get(integration.id);
        const available = await integrationTools.isAvailable(auth.organizationId, installation.id, integration.id);
        return {
          ...integration,
          status: integration.id === "internal.calendar" ? "connected" : connection?.status ?? (available ? "connected" : "not_configured"),
          available,
          hasCredential: Boolean(connection?.credential_id),
          configuration: connection?.configuration ?? {},
          healthMessage: connection?.health_message ?? null,
          lastCheckedAt: connection?.last_checked_at ?? null,
        };
      })),
    };
  });

  app.post<{ Params: { installationId: string; integrationId: string } }>("/v1/installations/:installationId/integrations/:integrationId/api-key", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const integration = getIntegration(request.params.integrationId);
    if (!integration || integration.kind !== "tool" || integration.auth !== "api_key") return reply.code(400).send({ error: "integration_does_not_use_api_key" });
    const input = z.object({ apiKey: z.string().trim().min(1).max(4_000), label: z.string().trim().min(1).max(160).optional(), configuration: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const credential = await integrationRepository.storeCredential({ organizationId: auth.organizationId, integrationId: integration.id, secret: input.apiKey, label: input.label, actorId: auth.actorId });
    const connection = await integrationRepository.upsertConnection({ organizationId: auth.organizationId, installationId: installation.id, integrationId: integration.id, credentialId: credential.id, status: "connected", configuration: input.configuration, actorId: auth.actorId });
    return reply.code(201).send({ integration: { ...integration, status: connection.status, available: true, hasCredential: true, configuration: connection.configuration } });
  });

  app.post<{ Params: { installationId: string; integrationId: string } }>("/v1/installations/:installationId/integrations/:integrationId/local-connector", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    const integration = getIntegration(request.params.integrationId);
    if (!integration || integration.kind !== "tool" || integration.auth !== "local_connector") return reply.code(400).send({ error: "integration_does_not_use_local_connector" });
    const input = z.object({ endpoint: z.string().trim().url(), secret: z.string().trim().min(1).max(4_000), label: z.string().trim().min(1).max(160).optional() }).parse(request.body);
    const credential = await integrationRepository.storeCredential({ organizationId: auth.organizationId, integrationId: integration.id, secret: input.secret, label: input.label, actorId: auth.actorId });
    const connection = await integrationRepository.upsertConnection({ organizationId: auth.organizationId, installationId: installation.id, integrationId: integration.id, credentialId: credential.id, status: "connected", configuration: { endpoint: input.endpoint.replace(/\/$/, "") }, actorId: auth.actorId });
    return reply.code(201).send({ integration: { ...integration, status: connection.status, available: true, hasCredential: true, configuration: connection.configuration } });
  });

  app.delete<{ Params: { installationId: string; integrationId: string } }>("/v1/installations/:installationId/integrations/:integrationId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const integration = getIntegration(request.params.integrationId);
    if (!integration) return reply.code(404).send({ error: "integration_not_found" });
    if (integration.kind !== "tool" || integration.auth === "internal") return reply.code(400).send({ error: "integration_cannot_be_disconnected_here" });
    const connection = await integrationRepository.getConnection(auth.organizationId, request.params.installationId, integration.id);
    await integrationRepository.disconnect({ organizationId: auth.organizationId, installationId: request.params.installationId, integrationId: integration.id });
    if (connection?.credential_id) await integrationRepository.revokeCredential(auth.organizationId, connection.credential_id);
    return reply.code(204).send();
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
        environment: z.enum(["playground", "live"]).optional(),
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
      requireScope(auth, dependencies.config, "kasiai:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation || installation.status !== "active") return reply.code(404).send({ error: "kasiai_installation_not_found" });
      requireKasiAiInstallation(installation);
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
      requireKasiAiInstallation(installation);
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
      requireKasiAiInstallation(installation);
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
      requireKasiAiInstallation(installation);
      const input = z.object({
        language: z.string().trim().min(2).max(35).optional(),
        tone: z.enum(["concise", "balanced", "detailed"]).optional(),
        responseDetail: z.enum(["concise", "standard", "detailed"]).optional(),
        notificationsEnabled: z.boolean().optional(),
        useSavedPreferences: z.boolean().optional(),
        referencePreviousChats: z.boolean().optional(),
        defaultModelProvider: z.enum([...MODEL_PROVIDERS]).optional(),
        defaultModel: z.string().trim().min(1).max(240).optional(),
        defaultCredentialReference: z.string().trim().max(240).nullable().optional(),
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
        default_credential_reference: input.defaultCredentialReference,
      });
      return { preferences };
    },
  );

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/audio",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const idempotencyKey = headerValue(request, "x-audio-idempotency-key")?.trim() ?? "";
      const conversationId = headerValue(request, "x-audio-conversation-id")?.trim() ?? "";
      if (idempotencyKey.length < 8 || idempotencyKey.length > 240 || !conversationId) {
        return reply.code(400).send({ error: "A valid audio idempotency key and conversation are required", code: "audio_request_invalid" });
      }
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: "AUDIO_FILE_REQUIRED", code: "AUDIO_FILE_REQUIRED" });
      const mimeType = normalizeAudioMimeType(part.mimetype);
      if (!isSupportedAudioMimeType(mimeType)) return reply.code(422).send({ error: "AUDIO_UNSUPPORTED_FORMAT", code: "AUDIO_UNSUPPORTED_FORMAT" });
      let bytes: Buffer;
      try {
        bytes = await part.toBuffer();
      } catch (error) {
        if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE" });
        throw error;
      }
      if (!bytes.length) return reply.code(422).send({ error: "AUDIO_EMPTY", code: "AUDIO_EMPTY" });
      if (bytes.length > MAX_AUDIO_FILE_BYTES) return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE" });
      if (!hasAudioFileSignature(mimeType, bytes)) return reply.code(422).send({ error: "AUDIO_INVALID_MEDIA", code: "AUDIO_INVALID_MEDIA" });
      if (!(await controls.isFeatureEnabled(auth.organizationId, "audio_transcription_enabled", request.params.installationId))) {
        return reply.code(503).send({ error: "Audio transcription is disabled", code: "AUDIO_TRANSCRIPTION_DISABLED" });
      }

      const correlationId = auth.correlationId ?? randomUUID();
      const uploaded = await coreClient.uploadContentMedia(
        {
          organizationId: auth.organizationId,
          installationId: request.params.installationId,
          actorId: auth.actorId,
          runId: randomUUID(),
          correlationId,
        },
        {
          bytes,
          mimeType,
          fileName: part.filename,
          source: "kasiai",
          sourceKey: `kasiai:${request.params.installationId}:${conversationId}:${idempotencyKey}`,
        },
      );
      const caption = headerValue(request, "x-audio-caption")?.trim().slice(0, 4_000) ?? "";
      const context = {
        ...(headerValue(request, "x-audio-context-route")?.trim() ? { route: headerValue(request, "x-audio-context-route")!.trim().slice(0, 500) } : {}),
        ...(headerValue(request, "x-audio-context-title")?.trim() ? { pageTitle: headerValue(request, "x-audio-context-title")!.trim().slice(0, 240) } : {}),
      };
      const content = {
        text: caption,
        assetId: uploaded.asset.id,
        mimeType,
        ...(part.filename ? { fileName: part.filename } : {}),
        mediaKind: "audio",
        transcription: { status: "queued", provider: "elevenlabs" },
      };
      const job = await audioTranscriptionJobs.enqueue({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
        correlationId,
        idempotencyKey,
        assetId: uploaded.asset.id,
        dispatchKind: "platform",
        dispatchInput: {
          idempotencyKey,
          installationId: request.params.installationId,
          actorId: auth.actorId,
          messageType: "attachment",
          content,
          context,
          conversationId,
          fileName: part.filename || undefined,
        },
      });
      return reply.code(202).send({
        jobId: job.job.id,
        status: job.job.status,
        assetId: uploaded.asset.id,
        created: job.created,
        durable: true,
      });
    },
  );

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/conversation",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
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
        installationId: z.string().uuid().optional(),
        channelType: z.string().trim().min(1).max(80),
        channelKey: z.string().trim().min(1).max(160).optional(),
        provider: z.string().trim().min(1).max(80),
        providerEventId: z.string().trim().min(1).max(240),
        providerMessageId: z.string().trim().min(1).max(240),
        externalIdentity: z.string().trim().min(1).max(240),
        externalConversationId: z.string().trim().min(1).max(240),
        messageType: z.string().trim().min(1).max(80).default("text"),
        content: z.record(z.string(), z.unknown()),
        occurredAt: z.string().datetime({ offset: true }).optional(),
        displayName: z.string().trim().max(240).optional(),
      }).parse(request.body);
      const inboundConnection = input.channelKey
        ? await channels.getConnectionForInbound({
          organizationId: auth.organizationId,
          channelType: input.channelType,
          channelKey: input.channelKey,
        })
        : null;
      if (input.channelType === "whatsapp") {
        const normalizedExternalIdentity = normalizeWhatsappPhone(input.externalIdentity);
        if (!normalizedExternalIdentity) {
          return reply.code(400).send({ error: "whatsapp_external_identity_invalid" });
        }
        // Core uses E.164 for provider-facing WhatsApp operations while the
        // agent channel binding format is the same digits-only value used by
        // Meta and the original Waku gateway. Normalize before both binding
        // and route lookup so allowlists and existing pairings agree.
        input.externalIdentity = normalizedExternalIdentity;
      }
      if (input.channelType === "whatsapp" && inboundConnection?.execution_mode === "system_hosted") {
        const allowedPhones = whatsappAllowedPhones(inboundConnection.metadata);
        if (allowedPhones.length > 0 && !whatsappPhoneAllowed(inboundConnection.metadata, input.externalIdentity)) {
          request.log.info({ channelConnectionId: inboundConnection.id, externalIdentity: input.externalIdentity }, "WhatsApp message ignored for a non-allowlisted phone");
          return reply.code(200).send({ ok: true, ignored: true, reason: "phone_not_allowed" });
        }
        if (allowedPhones.length > 0) {
          const phone = normalizeWhatsappAllowedPhones([input.externalIdentity])[0];
          if (!phone) return reply.code(200).send({ ok: true, ignored: true, reason: "phone_not_allowed" });
          try {
            await channels.bind({
              organizationId: auth.organizationId,
              installationId: inboundConnection.installation_id,
              connectionId: inboundConnection.id,
              externalIdentity: phone,
              ownerActorId: inboundConnection.created_by,
            });
          } catch (error) {
            request.log.warn({ error: error instanceof Error ? error.message : "WhatsApp allowlist binding failed" }, "WhatsApp allowlist binding failed");
            return reply.code(200).send({ ok: true, ignored: true, reason: "phone_not_allowed" });
          }
        }
      }
      input.content = parseCanonicalMessageContent(input.messageType, input.content);
      if (isAudioContent(input.content) && !hasCompletedTranscription(input.content)) {
        const assetId = typeof input.content.assetId === "string" ? input.content.assetId : "";
        const installationId = input.installationId ?? inboundConnection?.installation_id;
        if (!assetId) return reply.code(422).send({ error: "AUDIO_ASSET_REQUIRED", code: "AUDIO_ASSET_REQUIRED" });
        if (!installationId) return reply.code(422).send({ error: "AUDIO_INSTALLATION_REQUIRED", code: "AUDIO_INSTALLATION_REQUIRED" });
        if (!(await controls.isFeatureEnabled(auth.organizationId, "audio_transcription_enabled", installationId))) {
          return reply.code(503).send({ error: "Audio transcription is disabled", code: "AUDIO_TRANSCRIPTION_DISABLED" });
        }
        const job = await audioTranscriptionJobs.enqueue({
          organizationId: auth.organizationId,
          installationId,
          actorId: inboundConnection?.created_by ?? auth.actorId,
          correlationId: auth.correlationId ?? randomUUID(),
          idempotencyKey: `channel:${input.provider}:${input.providerEventId}`,
          assetId,
          dispatchKind: "external",
          dispatchInput: {
            ...input,
            installationId,
            content: input.content,
            fileName: typeof input.content.fileName === "string" ? input.content.fileName : undefined,
          },
        });
        return reply.code(job.created ? 202 : 200).send({
          jobId: job.job.id,
          status: job.job.status,
          assetId,
          created: job.created,
          durable: true,
        });
      }
      const accepted = await platformChat.acceptExternalMessage({
        organizationId: auth.organizationId,
        correlationId: auth.correlationId,
        ...input,
      });
      await deliverHandoffAcknowledgement({
        accepted,
        organizationId: auth.organizationId,
        channelType: input.channelType,
        externalConversationId: input.externalConversationId,
      });
      const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run?.status === "received") {
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
        runId: accepted.run?.id ?? null,
        status: accepted.handoffActive ? "handoff_active" : (accepted.run?.status ?? (accepted.handoffRequestId ? "handoff_requested" : "received")),
        handoffRequestId: accepted.handoffRequestId ?? null,
        handoffActive: accepted.handoffActive ?? false,
        ...(accepted.handoffActive ? { handoffMessage: HANDOFF_ACTIVE_TEXT } : {}),
        created: accepted.created,
        durable: workflowEnabled,
      });
    },
  );

  app.get<{ Params: { installationId: string }; Querystring: { search?: string; kind?: string; status?: string; channelType?: string } }>(
    "/v1/installations/:installationId/conversations",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:read");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
      requireHostedInstallation(installation);
      const kind = request.query.kind
        ? z.enum(["customer", "test"]).parse(request.query.kind)
        : "customer" as const;
      const status = request.query.status
        ? z.enum(["active", "archived", "deleted"]).parse(request.query.status)
        : "active" as const;
      if (kind === "customer" && installation.agent_audience !== "customer_service") {
        throw Object.assign(new Error("Personal agents cannot expose customer conversations"), {
          statusCode: 409,
          code: "personal_agent_customer_conversations_not_allowed",
        });
      }
      return {
        mode: installation.execution_mode,
        conversations: await conversations.listInstallationConversationProjections(
          auth.organizationId,
          request.params.installationId,
          {
            kind,
            status,
            channelType: request.query.channelType,
            search: request.query.search,
            limit: 200,
          },
        ),
      };
    },
  );

  app.patch<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const owned = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
    if (!owned) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    const installation = await agents.getInstallation(auth.organizationId, owned.installation_id);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    const input = z.object({
      title: z.string().trim().min(1).max(120).optional(),
      pinned: z.boolean().optional(),
      modelProvider: z.enum([...MODEL_PROVIDERS]).nullable().optional(),
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
    const installation = await agents.getInstallation(auth.organizationId, owned.installation_id);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    return conversations.setChannelDefault(auth.organizationId, owned.installation_id, auth.actorId, owned.id);
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/conversation/new",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const input = z.object({
        modelProvider: z.enum([...MODEL_PROVIDERS]).optional(),
        model: z.string().trim().min(1).max(240).optional(),
      }).parse(request.body ?? {});
      if (Boolean(input.modelProvider) !== Boolean(input.model)) {
        return reply.code(400).send({ error: "Model provider and model must be changed together" });
      }
      if (input.modelProvider && input.model && !await isAllowedKasiAiModel(dependencies.config, input.modelProvider, input.model)) {
        return reply.code(403).send({ error: "Selected model is not available for this workspace" });
      }
      const resolved = await platformChat.createNewConversation({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
        modelProvider: input.modelProvider,
        model: input.model,
      });
      const messages = conversations.listMessagesPage
        ? await conversations.listMessagesPage(auth.organizationId, resolved.conversation.id)
        : { messages: await conversations.listMessages(auth.organizationId, resolved.conversation.id), hasMore: false, nextBefore: null };
      return reply.code(201).send({ ...resolved, ...messages });
    },
  );

  app.get<{ Querystring: { installationId?: string; agentId?: string; channelType?: string; reason?: string; status?: string; assignment?: string; priority?: string; search?: string; limit?: string; cursor?: string; before?: string } }>(
    "/v1/conversations/handoffs",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      const queryInput = z.object({
        installationId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        channelType: z.string().trim().min(1).max(80).optional(),
        reason: z.enum(["customer_requested", "agent_uncertain", "policy_required", "high_value", "configured_workflow", "other"]).optional(),
        status: z.string().optional(),
        assignment: z.enum(["mine", "team"]).optional(),
        priority: z.enum(["normal", "high", "urgent"]).optional(),
        search: z.string().trim().max(240).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().trim().max(512).optional(),
        before: z.string().datetime().optional(),
      }).parse(request.query);
      const statuses = queryInput.status
        ? queryInput.status.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined;
      const validStatuses = statuses?.map((value) => z.enum(["pending", "claimed", "resolved", "expired", "cancelled"]).parse(value));
      return conversationControls.listHandoffs(auth.organizationId, {
        ...queryInput,
        status: validStatuses,
        actorId: auth.actorId,
      });
    },
  );

  app.get<{ Querystring: { installationId?: string; agentId?: string; channelType?: string; search?: string; limit?: string } }>(
    "/v1/conversations/summary",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      const queryInput = z.object({
        installationId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        channelType: z.string().trim().min(1).max(80).optional(),
        search: z.string().trim().max(240).optional(),
      }).parse(request.query);
      return conversationControls.getSummary(auth.organizationId, auth.actorId, queryInput);
    },
  );

  app.get<{ Querystring: { installationId?: string; agentId?: string; channelType?: string; search?: string; limit?: string } }>(
    "/v1/conversations/customer",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      const queryInput = z.object({
        installationId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        channelType: z.string().trim().min(1).max(80).optional(),
        search: z.string().trim().max(240).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }).parse(request.query);
      return conversationControls.listCustomer(auth.organizationId, queryInput);
    },
  );

  app.get<{ Querystring: { installationId?: string; agentId?: string; channelType?: string; search?: string; limit?: string } }>(
    "/v1/conversations/live",
    async (request) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      const queryInput = z.object({
        installationId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        channelType: z.string().trim().min(1).max(80).optional(),
        search: z.string().trim().max(240).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }).parse(request.query);
      return conversationControls.listLive(auth.organizationId, queryInput);
    },
  );

  app.get(
    "/v1/conversations/events/stream",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const keepAliveTimer = setInterval(() => {
        if (!closed) response.write(formatSseComment("keep-alive"));
      }, 15_000);
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        unsubscribe?.();
        response.end();
      };
      request.raw.on("close", close);
      request.raw.on("aborted", close);
      request.raw.socket?.on("close", close);
      response.on("close", close);
      response.on("error", close);
      try {
        unsubscribe = await eventNotifications.subscribe((event) => {
          if (closed || event.organizationId !== auth.organizationId) return;
          response.write(`event: conversation.changed\ndata: ${JSON.stringify(event)}\n\n`);
        });
        if (!closed) response.write(`event: conversation.ready\ndata: ${JSON.stringify({ status: "connected" })}\n\n`);
      } catch {
        if (!closed) response.write(`event: agent.stream_error\ndata: ${JSON.stringify({ error: "conversation_stream_unavailable" })}\n\n`);
        close();
      }
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { after?: string } }>(
    "/v1/conversations/:conversationId/events/stream",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "agents:read");
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      if (!await handoffs.conversationExists(auth.organizationId, conversationId)) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
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
      let unsubscribe: (() => void) | undefined;
      const keepAliveTimer = setInterval(() => {
        if (!closed) response.write(formatSseComment("keep-alive"));
      }, 15_000);
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        unsubscribe?.();
        response.end();
      };
      const poll = async (): Promise<void> => {
        if (closed || polling) return;
        polling = true;
        try {
          const events = await handoffs.listConversationEventsAfter(auth.organizationId, conversationId, cursor);
          for (const event of events) response.write(formatSseEvent(event));
          cursor = advanceSseCursor(cursor, events);
          if (!events.length) response.write(formatSseComment("keep-alive"));
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
      request.raw.on("aborted", close);
      request.raw.socket?.on("close", close);
      response.on("close", close);
      response.on("error", close);
      try {
        unsubscribe = await eventNotifications.subscribe((event) => {
          if (closed || event.organizationId !== auth.organizationId || event.subject !== `conversation:${conversationId}`) return;
          if (event.eventType === "conversation.message.changed") {
            response.write(`event: conversation.message.changed\ndata: ${JSON.stringify(event)}\n\n`);
          } else {
            void poll();
          }
        });
        await poll();
      } catch {
        if (!closed) response.write(`event: agent.stream_error\ndata: ${JSON.stringify({ error: "conversation_stream_unavailable" })}\n\n`);
        close();
      }
    },
  );

  app.get<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    const handoff = await conversationControls.getHandoff(auth.organizationId, handoffId);
    if (!handoff) return reply.code(404).send({ error: "handoff_not_found" });
    return handoff;
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/claim", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    return conversationControls.claim({ organizationId: auth.organizationId, handoffId, actorId: auth.actorId });
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/release", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    const input = z.object({ reason: z.string().trim().max(2_000).optional() }).parse(request.body ?? {});
    return conversationControls.release({ organizationId: auth.organizationId, handoffId, actorId: auth.actorId, reason: input.reason });
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/expire", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    return conversationControls.expire({ organizationId: auth.organizationId, handoffId, actorId: auth.actorId });
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/continue", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    const input = z.object({ resolution: z.string().trim().max(2_000).optional() }).parse(request.body ?? {});
    const result = await conversationControls.continueWithAgent({ organizationId: auth.organizationId, handoffId, actorId: auth.actorId, resolution: input.resolution });
    if (result.continuationRunId && result.continuationRunCreated && dependencies.config.TEMPORAL_ENABLED && dependencies.startWorkflow) {
      try {
        await dependencies.startWorkflow(result.continuationRunId);
      } catch (error) {
        await runs.failRun(result.continuationRunId, {
          code: "WORKFLOW_START_FAILED",
          message: error instanceof Error ? error.message : "Unable to start continuation workflow",
        });
        throw error;
      }
    } else if (!result.continuationRunId && result.handoff.run_id && dependencies.signalExternalEvent) {
      const handoffKey = typeof result.handoff.metadata?.handoffKey === "string" && result.handoff.metadata.handoffKey.trim()
        ? result.handoff.metadata.handoffKey.trim()
        : result.handoff.id;
      await dependencies.signalExternalEvent(result.handoff.run_id, {
        key: handoffKey,
        payload: {
          action: "continue_with_agent",
          handoffId: result.handoff.id,
          resolution: input.resolution ?? null,
        },
      });
    }
    return result;
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/resolve", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    const input = z.object({ resolution: z.string().trim().max(2_000).optional() }).parse(request.body ?? {});
    return conversationControls.resolve({ organizationId: auth.organizationId, handoffId, actorId: auth.actorId, resolution: input.resolution });
  });

  app.post<{ Params: { handoffId: string } }>("/v1/conversations/handoffs/:handoffId/messages", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const handoffId = z.string().uuid().parse(request.params.handoffId);
    const input = z.object({
      text: z.string().trim().min(1).max(20_000),
      idempotencyKey: z.string().trim().min(1).max(240).optional(),
    }).parse(request.body ?? {});
    const idempotencyKey = headerValue(request, "idempotency-key") ?? input.idempotencyKey;
    const result = await conversationControls.sendHumanMessage({
      organizationId: auth.organizationId,
      handoffId,
      actorId: auth.actorId,
      text: input.text,
      idempotencyKey: idempotencyKey ?? "",
    });
    let deliveryAttemptId = result.deliveryAttemptId;
    if (!result.created && result.deliveryAttemptId && (result.deliveryAttemptStatus === "failed" || result.deliveryAttemptStatus === "unknown")) {
      const replay = await channels.replayDelivery({
        organizationId: auth.organizationId,
        attemptId: result.deliveryAttemptId,
        confirmUnknown: result.deliveryAttemptStatus === "unknown",
        expectedStatus: result.deliveryAttemptStatus,
      });
      deliveryAttemptId = replay.replay.id;
    }
    if (!deliveryAttemptId || (!result.created && result.deliveryAttemptStatus !== "failed" && result.deliveryAttemptStatus !== "unknown")) {
      return reply.code(result.created ? 201 : 200).send(result);
    }

    let claimed = false;
    try {
      await channels.claimDelivery(auth.organizationId, deliveryAttemptId);
      claimed = true;
      const text = typeof result.message.content.text === "string" ? result.message.content.text : input.text;
      const delivery = result.conversation.channel_type === "telegram"
        ? await (async () => {
          const connection = (await channels.listConnections(auth.organizationId, result.conversation.installation_id))
            .find((candidate) => candidate.channel_type === "telegram" && candidate.status === "active");
          if (!connection?.credential_reference) throw new Error("Telegram channel delivery is not configured");
          const token = await channelCredentials.resolve(auth.organizationId, connection.credential_reference, "telegram");
          if (!result.conversation.external_conversation_id) throw new Error("Conversation has no external recipient");
          return telegramClient.sendMessage(token, result.conversation.external_conversation_id, text);
        })()
        : await coreClient.deliverChannelMessage({
          organizationId: auth.organizationId,
          installationId: result.conversation.installation_id,
          actorId: auth.actorId,
          runId: result.message.id,
          correlationId: result.message.id,
          channelType: result.conversation.channel_type,
          externalConversationId: result.conversation.external_conversation_id ?? "",
          text,
        });
      await channels.markDelivered({
        organizationId: auth.organizationId,
        attemptId: deliveryAttemptId,
        providerMessageId: delivery.providerMessageId,
      });
      return reply.code(201).send({ ...result, deliveryAttemptId, message: { ...result.message, delivery_status: "sent", provider_message_id: delivery.providerMessageId ?? result.message.provider_message_id }, delivery: { status: delivery.status } });
    } catch (error) {
      if (claimed) {
        await channels.markDeliveryFailed({
          organizationId: auth.organizationId,
          attemptId: deliveryAttemptId,
          error: { code: "HUMAN_MESSAGE_DELIVERY_FAILED", message: error instanceof Error ? error.message : "Human message delivery failed" },
        });
      }
      request.log.warn({
        event: "conversation.human_message.delivery_failed",
        handoff_id: handoffId,
        conversation_id: result.conversation.id,
        delivery_attempt_id: deliveryAttemptId,
        error_code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "HUMAN_MESSAGE_DELIVERY_FAILED",
      }, "Human message delivery failed");
      return reply.code(202).send({
        ...result,
        deliveryAttemptId,
        message: { ...result.message, delivery_status: "failed" },
        delivery: { status: "failed", error: { code: "HUMAN_MESSAGE_DELIVERY_FAILED", message: "Message could not be delivered" } },
      });
    }
  });

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/conversations/clear",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const resolved = await platformChat.clearPrivateConversations({
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
    "/v1/installations/:installationId/platform/ui-interactions",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const input = z.object({
        conversationId: z.string().uuid(),
        messageId: z.string().uuid(),
        blockId: z.string().trim().min(1).max(80),
        actionId: z.string().trim().min(1).max(80),
        idempotencyKey: z.string().trim().min(8).max(240),
        values: z.record(z.string(), z.unknown()).optional(),
        context: z.object({
          route: z.string().trim().max(500).optional(),
          pageTitle: z.string().trim().max(240).optional(),
          resourceType: z.string().trim().max(80).optional(),
          resourceId: z.string().trim().max(240).optional(),
        }).strict().optional(),
      }).strict().parse(request.body ?? {});
      const result = await uiInteractionCoordinator.resolveAndExecute({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        actorId: auth.actorId,
        correlationId: auth.correlationId,
        ...input,
      });
      if (result.kind === "navigate") return reply.code(200).send(result);
      if (result.kind === "resumed") {
        return reply.code(202).send({
          kind: "run",
          actionId: result.actionId,
          blockId: result.blockId,
          conversation: result.conversation,
          message: result.message,
          runId: result.run.id,
          status: result.run.status === "awaiting_human" ? "handoff_signalled" : "external_event_signalled",
          created: false,
          durable: result.durable,
        });
      }
      const accepted = result.accepted;
      return reply.code(202).send({
        kind: result.kind,
        actionId: result.actionId,
        blockId: result.blockId,
        conversation: accepted.conversation,
        message: accepted.message,
        runId: accepted.run?.id ?? null,
        status: accepted.handoffActive ? "handoff_active" : (accepted.run?.status ?? (accepted.handoffRequestId ? "handoff_requested" : "received")),
        handoffRequestId: accepted.handoffRequestId ?? null,
        handoffActive: accepted.handoffActive ?? false,
        ...(accepted.handoffActive ? { handoffMessage: HANDOFF_ACTIVE_TEXT } : {}),
        created: accepted.created,
        durable: result.durable,
      });
    },
  );

  app.post<{ Params: { installationId: string } }>(
    "/v1/installations/:installationId/platform/messages",
    async (request, reply) => {
      const auth = requireAuth(request, dependencies.config);
      requireScope(auth, dependencies.config, "chat:write");
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const input = z.object({
        message: z.string().trim().min(1).max(20_000),
        idempotencyKey: z.string().trim().min(8).max(240),
        conversationId: z.string().uuid().optional(),
        createNew: z.boolean().optional(),
        modelProvider: z.enum([...MODEL_PROVIDERS]).optional(),
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
      if (workflowEnabled && dependencies.startWorkflow && accepted.run?.status === "received") {
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
        runId: accepted.run?.id ?? null,
        status: accepted.handoffActive ? "handoff_active" : (accepted.run?.status ?? (accepted.handoffRequestId ? "handoff_requested" : "received")),
        handoffRequestId: accepted.handoffRequestId ?? null,
        handoffActive: accepted.handoffActive ?? false,
        ...(accepted.handoffActive ? { handoffMessage: HANDOFF_ACTIVE_TEXT } : {}),
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
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      const input = z.object({
        channelType: z.string().trim().min(1).max(80),
        channelKey: z.string().trim().min(1).max(160).optional(),
        provider: z.string().trim().min(1).max(80),
        providerEventId: z.string().trim().min(1).max(240),
        providerMessageId: z.string().trim().min(1).max(240),
        externalIdentity: z.string().trim().min(1).max(240),
        externalConversationId: z.string().trim().min(1).max(240),
        messageType: z.string().trim().min(1).max(80).default("text"),
        content: z.record(z.string(), z.unknown()),
        occurredAt: z.string().datetime({ offset: true }).optional(),
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
      if (workflowEnabled && dependencies.startWorkflow && accepted.created && accepted.run?.status === "received") {
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
        runId: accepted.run?.id ?? null,
        status: accepted.handoffActive ? "handoff_active" : (accepted.run?.status ?? (accepted.handoffRequestId ? "handoff_requested" : "received")),
        handoffRequestId: accepted.handoffRequestId ?? null,
        handoffActive: accepted.handoffActive ?? false,
        ...(accepted.handoffActive ? { handoffMessage: HANDOFF_ACTIVE_TEXT } : {}),
        created: accepted.created,
        durable: workflowEnabled,
      });
    },
  );

  app.post<{ Params: { installationId: string } }>("/v1/installations/:installationId/schedules", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
    const input = z.object({ expression: z.string().trim().min(1).max(240), timezone: z.string().trim().min(1).max(80).default("UTC"), input: z.record(z.string(), z.unknown()).default({}), nextRunAt: z.string().datetime().optional() }).parse(request.body);
    const schedule = await schedules.create({ organizationId: auth.organizationId, installationId: request.params.installationId, expression: input.expression, timezone: input.timezone, scheduleInput: input.input, nextRunAt: input.nextRunAt, actorId: auth.actorId });
    return reply.code(201).send(schedule);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/schedules", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
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
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
    if (installation.execution_mode === "kasitek_hosted" && installation.agent_audience === "personal") {
      return reply.code(409).send({ error: "personal_agent_customer_channels_not_allowed" });
    }
    const input = z.object({
      channelType: z.string().trim().min(1).max(80),
      channelKey: z.string().trim().min(1).max(160).optional(),
      credentialReference: z.string().trim().max(240).optional(),
      credentialSecret: z.string().trim().min(1).max(512).optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    if (!['telegram', 'discord', 'whatsapp', 'facebook', 'instagram', 'website'].includes(input.channelType)) {
      throw Object.assign(new Error(`Unsupported agent channel: ${input.channelType}`), { statusCode: 400, code: "unsupported_channel" });
    }
    if (input.channelType !== "telegram" && input.channelType !== "discord" && !input.channelKey) {
      throw Object.assign(new Error("channelKey is required for this channel"), { statusCode: 400 });
    }
    if (input.credentialSecret && input.credentialReference) {
      throw Object.assign(new Error("Use credentialSecret or credentialReference, not both"), { statusCode: 400 });
    }
    if (input.channelType === "discord" && !input.credentialSecret && !input.credentialReference) {
      throw Object.assign(new Error("A Discord bot token is required"), { statusCode: 400, code: "discord_token_required" });
    }
    if (input.channelType !== "telegram" && input.channelType !== "discord") {
      const connection = await channels.createConnection({ organizationId: auth.organizationId, installationId: request.params.installationId, channelType: input.channelType, channelKey: input.channelKey!, credentialReference: input.credentialReference, metadata: input.metadata, actorId: auth.actorId });
      return reply.code(201).send(connection);
    }

    if (input.channelType === "discord") {
      const botToken = input.credentialSecret
        ?? await channelCredentials.resolve(auth.organizationId, input.credentialReference!, "discord");
      let bot;
      try {
        bot = await discordClient.getMe(botToken);
      } catch (error) {
        throw Object.assign(new Error("Discord bot token could not be verified"), { statusCode: 400, code: "discord_token_invalid", cause: error });
      }
      const channelKey = input.channelKey ?? `bot:${bot.id}`;
      const credential = input.credentialSecret
        ? await channelCredentials.store({ organizationId: auth.organizationId, provider: "discord", secret: input.credentialSecret, label: `Discord ${bot.globalName ?? bot.username}`, actorId: auth.actorId })
        : undefined;
      let connection;
      try {
        connection = await channels.createConnection({
          organizationId: auth.organizationId,
          installationId: request.params.installationId,
          channelType: "discord",
          channelKey,
          credentialReference: credential?.id ?? input.credentialReference,
          metadata: {
            ...input.metadata,
            discord: { botId: bot.id, username: bot.username, ...(bot.globalName ? { globalName: bot.globalName } : {}) },
            gateway: { status: "waiting_for_gateway" },
          },
          actorId: auth.actorId,
        });
        connection = await channels.updateConnection({
          organizationId: auth.organizationId,
          connectionId: connection.id,
          status: "active",
          metadata: { ...connection.metadata, gateway: { status: "waiting_for_gateway" } },
        });
      } catch (error) {
        if (connection) await channels.updateConnection({ organizationId: auth.organizationId, connectionId: connection.id, status: "failed" }).catch(() => undefined);
        if (credential) await channelCredentials.revoke(auth.organizationId, credential.id).catch(() => undefined);
        throw error;
      }
      return reply.code(201).send(connection);
    }

    if (!input.credentialSecret && !input.credentialReference) {
      throw Object.assign(new Error("A Telegram bot token is required"), { statusCode: 400, code: "telegram_token_required" });
    }
    if (!dependencies.config.TELEGRAM_WEBHOOK_BASE_URL) {
      throw Object.assign(new Error("Telegram webhook hosting is not configured"), { statusCode: 503, code: "telegram_webhook_not_configured" });
    }

    const botToken = input.credentialSecret
      ?? await channelCredentials.resolve(auth.organizationId, input.credentialReference!, "telegram");
    let bot;
    try {
      bot = await telegramClient.getMe(botToken);
    } catch (error) {
      throw Object.assign(new Error("Telegram bot token could not be verified"), { statusCode: 400, code: "telegram_token_invalid", cause: error });
    }
    const channelKey = input.channelKey ?? `bot:${bot.id}`;
    const webhookSecret = randomBytes(32).toString("base64url");
    const credential = input.credentialSecret
      ? await channelCredentials.store({ organizationId: auth.organizationId, provider: "telegram", secret: input.credentialSecret, label: bot.username ? `Telegram @${bot.username}` : `Telegram bot ${bot.id}`, actorId: auth.actorId })
      : undefined;
    let connection;
    try {
      connection = await channels.createConnection({
        organizationId: auth.organizationId,
        installationId: request.params.installationId,
        channelType: "telegram",
        channelKey,
        credentialReference: credential?.id ?? input.credentialReference,
        webhookSecretHash: hashChannelSecret(webhookSecret),
        metadata: {
          ...input.metadata,
          telegram: {
            botId: bot.id,
            ...(bot.username ? { username: bot.username } : {}),
            name: [bot.firstName, bot.lastName].filter(Boolean).join(" "),
          },
        },
        actorId: auth.actorId,
      });
      const configuredWebhookUrl = telegramClient.getWebhookUrl(dependencies.config.TELEGRAM_WEBHOOK_BASE_URL, connection.id);
      await telegramClient.setWebhook(botToken, configuredWebhookUrl, webhookSecret);
      connection = await channels.updateConnection({
        organizationId: auth.organizationId,
        connectionId: connection.id,
        status: "active",
        webhookUrl: configuredWebhookUrl,
        metadata: {
          ...connection.metadata,
          webhook: { status: "active", url: configuredWebhookUrl },
        },
      });
    } catch (error) {
      if (connection) {
        await channels.updateConnection({ organizationId: auth.organizationId, connectionId: connection.id, status: "failed" }).catch(() => undefined);
      }
      if (credential) await channelCredentials.revoke(auth.organizationId, credential.id).catch(() => undefined);
      throw error;
    }
    return reply.code(201).send(connection);
  });

  app.patch<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
    const connection = await channels.getConnection(auth.organizationId, request.params.connectionId);
    if (!connection || connection.installation_id !== installation.id) return reply.code(404).send({ error: "channel_connection_not_found" });
    if ((connection.channel_type !== "telegram" && connection.channel_type !== "whatsapp") || installation.execution_mode !== "system_hosted") {
      return reply.code(400).send({ error: "channel_allowlist_only_for_personal_agents" });
    }
    const input = z.object({
      allowedUsers: z.array(z.string().trim().regex(/^\d+$/)).max(100).optional(),
      allowedPhones: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
    }).parse(request.body);
    let metadata: Record<string, unknown>;
    if (connection.channel_type === "telegram") {
      if (!input.allowedUsers) return reply.code(400).send({ error: "allowedUsers_required" });
      metadata = {
        ...connection.metadata,
        telegramAccess: {
          ...(connection.metadata.telegramAccess && typeof connection.metadata.telegramAccess === "object" ? connection.metadata.telegramAccess as Record<string, unknown> : {}),
          allowedUsers: normalizeTelegramAllowedUsers(input.allowedUsers),
        },
      };
    } else {
      if (!input.allowedPhones) return reply.code(400).send({ error: "allowedPhones_required" });
      const allowedPhones = normalizeWhatsappAllowedPhones(input.allowedPhones);
      if (input.allowedPhones.some((value) => normalizeWhatsappAllowedPhones([value]).length !== 1)) return reply.code(400).send({ error: "allowedPhones_invalid" });
      metadata = {
        ...connection.metadata,
        whatsappAccess: {
          ...(connection.metadata.whatsappAccess && typeof connection.metadata.whatsappAccess === "object" ? connection.metadata.whatsappAccess as Record<string, unknown> : {}),
          allowedPhones,
        },
      };
    }
    const updated = await channels.updateConnection({ organizationId: auth.organizationId, connectionId: connection.id, metadata });
    const { credential_reference: _credentialReference, webhook_secret_hash: _webhookSecretHash, ...publicConnection } = updated;
    return reply.send(publicConnection);
  });

  app.get<{ Params: { installationId: string } }>("/v1/installations/:installationId/channels", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:read");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    if (installation.execution_mode === "kasitek_hosted" && installation.agent_audience === "personal") {
      throw Object.assign(new Error("Personal agents cannot serve customer channels"), { statusCode: 409, code: "personal_agent_customer_channels_not_allowed" });
    }
    const [connections, bindings] = await Promise.all([
      channels.listConnections(auth.organizationId, request.params.installationId),
      channels.listOwnerBindings(auth.organizationId, request.params.installationId, auth.actorId),
    ]);
    return {
      connections: connections.map(({ credential_reference: _credentialReference, webhook_secret_hash: _webhookSecretHash, ...connection }) => connection),
      bindings,
    };
  });

  app.post<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId/pairing", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
    const input = z.object({ ttlSeconds: z.number().int().positive().max(86_400).optional() }).parse(request.body);
    const pairing = await channels.issuePairingToken({ organizationId: auth.organizationId, installationId: request.params.installationId, connectionId: request.params.connectionId, ttlSeconds: input.ttlSeconds, actorId: auth.actorId });
    return reply.code(201).send(pairing);
  });

  app.delete<{ Params: { installationId: string; connectionId: string } }>("/v1/installations/:installationId/channels/:connectionId", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:write");
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    const connection = await channels.getConnection(auth.organizationId, request.params.connectionId);
    if (connection?.channel_type === "telegram" && connection.credential_reference) {
      const botToken = await channelCredentials.resolve(auth.organizationId, connection.credential_reference, "telegram").catch(() => undefined);
      if (botToken) await telegramClient.deleteWebhook(botToken).catch(() => undefined);
    }
    await channels.revokeConnection({
      organizationId: auth.organizationId,
      installationId: request.params.installationId,
      connectionId: request.params.connectionId,
    });
    if ((connection?.channel_type === "telegram" || connection?.channel_type === "discord") && connection.credential_reference) {
      await channelCredentials.revoke(auth.organizationId, connection.credential_reference).catch(() => undefined);
    }
    return { disconnected: true };
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
      const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
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
      const conversation = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      const installation = await agents.getInstallation(auth.organizationId, conversation.installation_id);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
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
      const conversation = typeof conversations.getConversation === "function"
        ? await conversations.getConversation(auth.organizationId, request.params.conversationId)
        : await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      const installation = await agents.getInstallation(auth.organizationId, conversation.installation_id);
      if (!installation) return reply.code(404).send({ error: "installation_not_found" });
      requireHostedInstallation(installation);
      if (installation.execution_mode === "kasitek_hosted") {
        if (conversation.conversation_kind && !["customer", "test"].includes(conversation.conversation_kind)) {
          return reply.code(404).send({ error: "conversation_not_found" });
        }
        if (conversation.conversation_kind === "customer" && installation.agent_audience !== "customer_service") {
          return reply.code(404).send({ error: "conversation_not_found" });
        }
        if (typeof conversations.markInstallationOpened === "function") {
          await conversations.markInstallationOpened(auth.organizationId, conversation.id);
        } else {
          await conversations.markOpened(auth.organizationId, conversation.id, auth.actorId);
        }
      } else {
        if (conversation.owner_actor_id !== auth.actorId) return reply.code(404).send({ error: "conversation_not_found" });
        await conversations.markOpened(auth.organizationId, conversation.id, auth.actorId);
      }
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) return reply.code(400).send({ error: "invalid_message_limit" });
      const messages = conversations.listMessagesPage
        ? await conversations.listMessagesPage(auth.organizationId, conversation.id, { limit, beforeSequence: request.query.before })
        : { messages: await conversations.listMessages(auth.organizationId, conversation.id), hasMore: false, nextBefore: null };
      const participants = await conversations.listParticipants(auth.organizationId, conversation.id);
      const activeRuns = typeof runs.listActiveConversationRuns === "function"
        ? await runs.listActiveConversationRuns(auth.organizationId, conversation.id)
        : [];
      return { conversation, ...messages, participants, activeRuns };
    },
  );

  app.post<{ Params: { conversationId: string; status: "archived" | "deleted" } }>("/v1/conversations/:conversationId/status/:status", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const conversation = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
    if (!conversation) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    const installation = await agents.getInstallation(auth.organizationId, conversation.installation_id);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    const status = z.enum(["archived", "deleted"]).parse(request.params.status);
    return conversations.setOwnedStatus(auth.organizationId, request.params.conversationId, auth.actorId, status);
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/restore", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const conversation = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
    if (!conversation) throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    const installation = await agents.getInstallation(auth.organizationId, conversation.installation_id);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
    return conversations.restoreOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
  });

  app.post<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId/participants", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const conversation = await conversations.getOwnedConversation(auth.organizationId, request.params.conversationId, auth.actorId);
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    const installation = await agents.getInstallation(auth.organizationId, conversation.installation_id);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
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
    const installation = await agents.getInstallation(auth.organizationId, request.params.installationId);
    if (!installation) throw Object.assign(new Error("Installation not found"), { statusCode: 404 });
    requireHostedInstallation(installation);
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
    const installation = await agents.getInstallation(auth.organizationId, input.installationId);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
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
    return reply.code(202).send({ runId: run.id, status: run.status, admission: run.admission, durable: Boolean(dependencies.startWorkflow) });
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
    const [events, journal, steps, toolCalls, effects] = await Promise.all([
      runs.listEvents(auth.organizationId, run.id),
      typeof runs.listJournalEvents === "function"
        ? runs.listJournalEvents(auth.organizationId, run.id)
        : Promise.resolve([]),
      runSteps.listSteps(auth.organizationId, run.id),
      toolInvocations.list(auth.organizationId, run.id),
      effectReceipts.listForRun(auth.organizationId, run.id),
    ]);
    return {
      run,
      events,
      journal,
      telemetry: projectRuntimeTelemetry(journal, { runId: run.id }),
      projection: {
        version: "studio.run-timeline.v1",
        cursor: Math.max(
          journal.at(-1)?.sequence ?? 0,
          Number.isSafeInteger(Number(events.at(-1)?.sequence_number)) ? Number(events.at(-1)?.sequence_number) : 0,
        ),
        freshness: ["completed", "failed", "cancelled", "timed_out"].includes(run.status) ? "settled" : "live",
        redaction: "role_scoped",
        observedAt: new Date().toISOString(),
      },
      steps: steps.map((step) => ({ ...step, input: redactSensitiveValue(step.input), output: redactSensitiveValue(step.output), error: redactSensitiveValue(step.error) })),
      toolCalls: toolCalls.map((toolCall) => redactSensitiveValue(toolCall)),
      effects: effects.map((effect) => ({ ...effect, provider_receipt: redactSensitiveValue(effect.provider_receipt), error: redactSensitiveValue(effect.error) })),
    };
  });

  app.get("/v1/operations/summary", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const [runsSummary, modelSummary, toolSummary, pendingReconciliation, budgetSummary] = await Promise.all([
      runs.operationalSummary(auth.organizationId),
      modelCalls.usageSummary(auth.organizationId),
      toolInvocations.outcomeSummary(auth.organizationId),
      effectReceipts.countPendingReconciliation(auth.organizationId),
      runBudgets.summary(auth.organizationId),
    ]);
    return {
      organizationId: auth.organizationId,
      generatedAt: new Date().toISOString(),
      runs: runsSummary,
      models: modelSummary,
      tools: toolSummary,
      effects: { pendingReconciliation },
      budget: budgetSummary,
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

  app.get<{ Querystring: { limit?: string } }>("/v1/operations/budgets/reconciliation", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid budget reconciliation limit");
    return { reservations: await runBudgets.pendingReconciliation(auth.organizationId, limit) };
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
      const credentialKey = modelProviderEnvironmentKey(provider);
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
          credentialConfigured: Boolean(credentialKey && process.env[credentialKey]?.trim()),
        },
        audioTranscription: {
          provider: "elevenlabs",
          model: dependencies.config.ELEVENLABS_TRANSCRIPTION_MODEL ?? "scribe_v2",
          credentialConfigured: Boolean(dependencies.config.ELEVENLABS_API_KEY?.trim()),
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
        audioTranscription: {
          provider: "elevenlabs",
          model: dependencies.config.ELEVENLABS_TRANSCRIPTION_MODEL ?? "scribe_v2",
          credentialConfigured: Boolean(dependencies.config.ELEVENLABS_API_KEY?.trim()),
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

  app.post("/v1/credentials/verify", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ provider: z.enum([...MODEL_PROVIDERS]), apiKey: z.string().min(1).max(10_000) }).parse(request.body);
    // Verification is deliberately separate from persistence so clients can
    // provide an explicit “Test credential” step. The create route repeats
    // the check server-side and cannot be bypassed by skipping this endpoint.
    return { verification: await verifyCredential(input) };
  });

  app.post("/v1/credentials", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ provider: z.enum([...MODEL_PROVIDERS]), apiKey: z.string().min(1).max(10_000), label: z.string().trim().max(160).optional() }).parse(request.body);
    // Never persist a provider secret before a successful, bounded preflight.
    await verifyCredential({ provider: input.provider, apiKey: input.apiKey });
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
    const existing = (await credentials.list(auth.organizationId)).find((credential) => credential.id === request.params.credentialId && credential.status === "active");
    if (!existing) return reply.code(404).send({ error: "Credential not found" });
    await verifyCredential({ provider: existing.provider, apiKey: input.apiKey });
    const credential = await credentials.rotate({ organizationId: auth.organizationId, credentialId: request.params.credentialId, actorId: auth.actorId, ...input });
    return reply.code(201).send(credential);
  });

  app.post("/v1/knowledge/websites/map", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    if (!websiteCrawler.isConfigured()) return reply.code(503).send({ error: "website_crawler_unconfigured" });
    const input = z.object({
      url: z.string().url().max(2_000),
      agentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      limit: z.number().int().positive().max(5_000).default(100),
      includeSubdomains: z.boolean().default(false),
      ignoreQueryParameters: z.boolean().default(true),
      sitemap: z.enum(["include", "skip", "only"]).default("include"),
    }).parse(request.body);
    const url = new URL(input.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return reply.code(422).send({ error: "website_url_invalid" });
    }
    await requireHostedResourceScope(agents, auth.organizationId, input);
    const mapped = await websiteCrawler.map({ ...input, url: url.toString() });
    return { url: url.toString(), ...mapped };
  });

  app.post("/v1/knowledge/websites/crawl", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    if (!websiteCrawler.isConfigured()) return reply.code(503).send({ error: "website_crawler_unconfigured" });
    const input = z.object({
      name: z.string().trim().min(1).max(240),
      url: z.string().url().max(2_000),
      agentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      limit: z.number().int().positive().max(1_000).default(100),
      maxDiscoveryDepth: z.number().int().min(0).max(10).default(3),
      includePaths: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
      excludePaths: z.array(z.string().trim().min(1).max(240)).max(50).default([]),
      allowSubdomains: z.boolean().default(false),
      delaySeconds: z.number().min(0).max(30).optional(),
      maxConcurrency: z.number().int().min(1).max(20).optional(),
    }).parse(request.body);
    const url = new URL(input.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return reply.code(422).send({ error: "website_url_invalid" });
    }
    await requireHostedResourceScope(agents, auth.organizationId, input);
    const source = await knowledge.createSource({
      name: input.name,
      sourceType: "url",
      sourceUri: url.toString(),
      organizationId: auth.organizationId,
      agentId: input.agentId,
      installationId: input.installationId,
      actorId: auth.actorId,
      provenance: { crawler: "firecrawl", rootUrl: url.toString(), crawlStatus: "starting" },
    });
    try {
      const crawl = await websiteCrawler.startCrawl({ ...input, url: url.toString() });
      const updated = await knowledge.updateSource({
        sourceId: source.id,
        scope: { organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId },
        status: "processing",
        provenance: { crawlId: crawl.id, crawlStatus: "scraping", crawlOptions: input, startedAt: new Date().toISOString() },
      });
      return reply.code(202).send({ source: updated, crawlId: crawl.id, status: "scraping" });
    } catch (error) {
      await knowledge.updateSource({
        sourceId: source.id,
        scope: { organizationId: auth.organizationId, agentId: input.agentId, installationId: input.installationId },
        status: "failed",
        provenance: { crawlStatus: "failed", error: error instanceof Error ? error.message : "Firecrawl could not start the crawl" },
      });
      throw error;
    }
  });

  app.get<{ Params: { sourceId: string } }>("/v1/knowledge/websites/crawl/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    if (!websiteCrawler.isConfigured()) return reply.code(503).send({ error: "website_crawler_unconfigured" });
    const source = await knowledge.getSource({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "knowledge_source_not_found" });
    if (source.source_type !== "url" || !source.agent_definition_id) return reply.code(422).send({ error: "website_source_required" });
    await requireHostedResourceScope(agents, auth.organizationId, { agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined });
    const crawlId = source.provenance.crawlId;
    if (typeof crawlId !== "string" || !crawlId) return reply.code(422).send({ error: "website_crawl_not_started" });
    const status = await websiteCrawler.getCrawlStatus(crawlId);
    const isComplete = status.status === "completed";
    const isFailed = status.status === "failed" || status.status === "cancelled";
    const alreadyIngested = typeof source.provenance.ingestedAt === "string";
    let updatedSource = source;
    if (isComplete && !alreadyIngested) {
      const chunks = status.data.flatMap((page) => {
        const content = (page.markdown ?? page.html ?? "").trim();
        if (!content) return [];
        const metadata = page.metadata ?? {};
        const pageUrl = typeof metadata.sourceURL === "string" ? metadata.sourceURL : typeof metadata.url === "string" ? metadata.url : source.source_uri;
        const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
        const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
        const links = (page.links ?? []).slice(0, 20);
        const text = [title, description, content].filter(Boolean).join("\n\n");
        return chunkKnowledgeText(text).map((chunk, index) => ({
          text: [`Source: ${pageUrl}`, links.length ? `Related links: ${links.join(", ")}` : "", chunk].filter(Boolean).join("\n\n"),
          metadata: {
            contentType: "text/markdown",
            pageUrl,
            title,
            language: typeof metadata.language === "string" ? metadata.language : undefined,
            links,
            statusCode: metadata.statusCode,
            characters: chunk.length,
          },
          provenance: { sourceType: "website", url: pageUrl, title, fetchedAt: new Date().toISOString(), chunkIndex: index },
        }));
      });
      if (chunks.length) {
        await knowledge.addChunks({
          sourceId: source.id,
          scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
          revision: source.revision + 1,
          chunks,
        });
        updatedSource = await knowledge.updateSource({
          sourceId: source.id,
          scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
          status: "active",
          provenance: { crawlStatus: "completed", ingestedAt: new Date().toISOString(), pageCount: status.data.length, chunkCount: chunks.length, creditsUsed: status.creditsUsed },
        });
      } else {
        updatedSource = await knowledge.updateSource({
          sourceId: source.id,
          scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
          status: "failed",
          provenance: { crawlStatus: "failed", error: "Firecrawl returned no readable pages" },
        });
      }
    } else if (isFailed && source.status !== "failed") {
      updatedSource = await knowledge.updateSource({
        sourceId: source.id,
        scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
        status: "failed",
        provenance: { crawlStatus: status.status },
      });
    }
    return {
      source: updatedSource,
      crawlId,
      status: isComplete ? "completed" : status.status,
      total: status.total ?? status.data.length,
      completed: status.completed ?? (isComplete ? status.data.length : 0),
      pages: status.data.length,
      creditsUsed: status.creditsUsed,
    };
  });

  app.delete<{ Params: { sourceId: string } }>("/v1/knowledge/websites/crawl/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    if (!websiteCrawler.isConfigured()) return reply.code(503).send({ error: "website_crawler_unconfigured" });
    const source = await knowledge.getSource({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!source || source.source_type !== "url" || !source.agent_definition_id) return reply.code(404).send({ error: "website_source_not_found" });
    await requireHostedResourceScope(agents, auth.organizationId, { agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined });
    const crawlId = source.provenance.crawlId;
    if (typeof crawlId !== "string" || !crawlId) return reply.code(422).send({ error: "website_crawl_not_started" });
    await websiteCrawler.cancelCrawl(crawlId);
    const updated = await knowledge.updateSource({
      sourceId: source.id,
      scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
      status: "failed",
      provenance: { crawlStatus: "cancelled", cancelledAt: new Date().toISOString() },
    });
    return { source: updated, crawlId, status: "cancelled" };
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
    await requireHostedResourceScope(agents, auth.organizationId, input);
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
    await requireHostedResourceScope(agents, auth.organizationId, { installationId: source.installation_id ?? undefined, agentId: source.agent_definition_id });
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

  app.get<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const document = await knowledge.getSourceDocument({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!document) return reply.code(404).send({ error: "knowledge_source_not_found" });
    await requireHostedResourceScope(agents, auth.organizationId, {
      agentId: document.source.agent_definition_id ?? undefined,
      installationId: document.source.installation_id ?? undefined,
    });
    return document;
  });

  app.post<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId/ingest-text", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({
      text: z.string().trim().min(1).max(200_000),
      contentType: z.enum(["text/plain", "text/markdown"]).default("text/markdown"),
    }).parse(request.body);
    const source = await knowledge.getSource({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "knowledge_source_not_found" });
    if (source.source_type !== "manual") return reply.code(422).send({ error: "knowledge_source_manual_required" });
    if (!source.agent_definition_id) return reply.code(422).send({ error: "knowledge_source_agent_scope_required" });
    await requireHostedResourceScope(agents, auth.organizationId, { installationId: source.installation_id ?? undefined, agentId: source.agent_definition_id });
    const chunks = chunkKnowledgeText(input.text);
    if (!chunks.length) return reply.code(422).send({ error: "knowledge_text_empty" });
    const stored = await knowledge.addChunks({
      sourceId: source.id,
      scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
      revision: source.revision + 1,
      chunks: chunks.map((text, index) => ({
        text,
        metadata: { contentType: input.contentType, characters: text.length },
        provenance: { sourceType: "manual", addedAt: new Date().toISOString(), chunkIndex: index },
      })),
    });
    return reply.code(201).send({ sourceId: source.id, revision: source.revision + 1, chunks: stored });
  });

  app.post<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId/ingest-file", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const source = await knowledge.getSource({ organizationId: auth.organizationId }, request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "knowledge_source_not_found" });
    if (source.source_type !== "upload") return reply.code(422).send({ error: "knowledge_source_upload_required" });
    if (!source.agent_definition_id) return reply.code(422).send({ error: "knowledge_source_agent_scope_required" });
    await requireHostedResourceScope(agents, auth.organizationId, { installationId: source.installation_id ?? undefined, agentId: source.agent_definition_id });

    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "knowledge_file_required" });
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (error) {
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "knowledge_file_too_large" });
      }
      throw error;
    }
    let extracted;
    try {
      extracted = await extractKnowledgeFile({ filename: part.filename, contentType: part.mimetype, bytes });
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "knowledge_file_unreadable" });
    }
    const chunks = chunkKnowledgeText(extracted.text);
    if (!chunks.length) return reply.code(422).send({ error: "knowledge_file_empty" });
    const stored = await knowledge.addChunks({
      sourceId: source.id,
      scope: { organizationId: auth.organizationId, agentId: source.agent_definition_id, installationId: source.installation_id ?? undefined },
      revision: source.revision + 1,
      chunks: chunks.map((text, index) => ({
        text,
        metadata: { ...extracted.metadata, contentType: extracted.contentType, format: extracted.format, bytes: extracted.bytes, characters: text.length },
        provenance: { sourceType: "upload", filename: extracted.filename, addedAt: new Date().toISOString(), chunkIndex: index },
      })),
    });
    return reply.code(201).send({ sourceId: source.id, revision: source.revision + 1, filename: extracted.filename, format: extracted.format, bytes: extracted.bytes, chunks: stored });
  });

  app.get<{ Querystring: { agentId?: string; installationId?: string; limit?: string; reviewable?: string } }>("/v1/memory", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const agentId = z.string().uuid().parse(request.query.agentId);
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    await requireHostedResourceScope(agents, auth.organizationId, { installationId, agentId });
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid memory limit");
    const reviewable = request.query.reviewable === "true";
    return { memories: await memoryAdmin.list({ organizationId: auth.organizationId, agentId, installationId, limit, reviewable }) };
  });

  app.delete<{ Params: { memoryId: string } }>("/v1/memory/:memoryId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional(), conversationId: z.string().uuid().optional() }).parse(request.body);
    await requireHostedResourceScope(agents, auth.organizationId, input);
    await memoryAdmin.delete({ organizationId: auth.organizationId, actorId: auth.actorId, memoryId: request.params.memoryId, agentId: input.agentId, installationId: input.installationId, conversationId: input.conversationId });
    return reply.code(204).send();
  });

  app.post<{ Params: { memoryId: string } }>("/v1/memory/:memoryId/revalidate", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional(), conversationId: z.string().uuid().optional(), expiresAt: z.string().datetime().nullable() }).parse(request.body);
    await requireHostedResourceScope(agents, auth.organizationId, input);
    return memoryAdmin.revalidate({ organizationId: auth.organizationId, actorId: auth.actorId, memoryId: request.params.memoryId, agentId: input.agentId, installationId: input.installationId, conversationId: input.conversationId, expiresAt: input.expiresAt, operationId: headerValue(request, "idempotency-key") ?? auth.correlationId ?? randomUUID() });
  });

  app.post<{ Params: { memoryId: string } }>("/v1/memory/:memoryId/review", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({
      agentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      conversationId: z.string().uuid().optional(),
      decision: z.enum(["approve", "reject"]),
      supersedesMemoryId: z.string().uuid().optional(),
    }).parse(request.body);
    await requireHostedResourceScope(agents, auth.organizationId, input);
    if (input.supersedesMemoryId) throw Object.assign(new Error("supersedesMemoryId is not supported by memory v2"), { statusCode: 422 });
    const reviewed = await memoryAdmin.review({
      organizationId: auth.organizationId,
      actorId: auth.actorId,
      memoryId: request.params.memoryId,
      agentId: input.agentId,
      installationId: input.installationId,
      conversationId: input.conversationId,
      decision: input.decision,
      operationId: headerValue(request, "idempotency-key") ?? auth.correlationId ?? randomUUID(),
    });
    await dependencies.pool.query(
      `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, metadata)
       VALUES ($1, 'user', $2, 'memory.reviewed', 'memory', $3, $4, $5::jsonb)`,
      [auth.organizationId, auth.actorId, request.params.memoryId, auth.correlationId ?? null, JSON.stringify({ decision: input.decision, status: reviewed.status })],
    );
    return { memory: reviewed };
  });

  app.get<{ Querystring: { agentId?: string; installationId?: string; limit?: string } }>("/v1/knowledge/sources", async (request) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:read");
    const agentId = request.query.agentId ? z.string().uuid().parse(request.query.agentId) : undefined;
    const installationId = request.query.installationId ? z.string().uuid().parse(request.query.installationId) : undefined;
    await requireHostedResourceScope(agents, auth.organizationId, { installationId, agentId });
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid knowledge limit");
    return { sources: await knowledge.listSources({ organizationId: auth.organizationId, agentId, installationId }, limit) };
  });

  app.delete<{ Params: { sourceId: string } }>("/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const input = z.object({ agentId: z.string().uuid(), installationId: z.string().uuid().optional() }).parse(request.body);
    await requireHostedResourceScope(agents, auth.organizationId, input);
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

  app.post<{ Params: { scenarioId: string } }>("/v1/evaluations/scenarios/:scenarioId/draft-runs", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "agents:write");
    const scenario = await evaluations.getScenario(auth.organizationId, request.params.scenarioId);
    if (!scenario) return reply.code(404).send({ error: "evaluation_scenario_not_found" });
    const input = z.object({
      agentVersionId: z.string().uuid(),
      evaluatorVersion: z.string().trim().min(1).max(80).default("deterministic-v1"),
    }).strict().parse(request.body);
    const version = await agents.getVersion(auth.organizationId, input.agentVersionId);
    if (!version) return reply.code(404).send({ error: "agent_version_not_found" });
    if (scenario.agent_definition_id && scenario.agent_definition_id !== version.agent_definition_id) {
      return reply.code(409).send({ error: "evaluation_agent_mismatch" });
    }
    try {
      const output = await draftEvaluator({ organizationId: auth.organizationId, version, scenarioInput: scenario.input });
      const result = evaluateDeterministicAssertions(output.actualOutput, scenario.assertions);
      const run = await evaluations.recordRun({
        organizationId: auth.organizationId,
        scenarioId: scenario.id,
        agentVersionId: version.id,
        executionMode: "draft",
        status: result.passed ? "passed" : "failed",
        evaluatorVersion: input.evaluatorVersion,
        result: { ...result, ...output },
        actorId: auth.actorId,
      });
      return reply.code(201).send(run);
    } catch (error) {
      const code = error instanceof Error ? error.message : "DRAFT_EVALUATION_FAILED";
      request.log.warn({ code }, "Draft evaluation failed");
      const statusCode = code === "DRAFT_INPUT_TOO_LARGE" ? 400 : code === "DRAFT_VERSION_RETIRED" || code === "DRAFT_TOOL_CALL_UNSUPPORTED" || code === "DRAFT_WORKFLOW_INVALID" ? 409 : 502;
      return reply.code(statusCode).send({ error: code.toLowerCase() });
    }
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
        }
        cursor = advanceSseCursor(cursor, events);
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
    request.raw.on("aborted", close);
    request.raw.socket?.on("close", close);
    response.on("close", close);
    response.on("error", close);
    const timer = setInterval(() => void poll(), 1000);
    await poll();
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/approval", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:approve");
    const input = z.object({ decision: z.enum(["approved", "rejected"]), providerToolCallId: z.string().trim().min(1).max(240), argumentsHash: z.string().length(64) }).parse(request.body);
    try {
      const result = await decideApproval({
        organizationId: auth.organizationId,
        runId: request.params.runId,
        ...input,
        approvedBy: auth.actorId,
        rateLimitKey: `${auth.organizationId}:${request.params.runId}:${auth.actorId}`,
      });
      if (!result.accepted) {
        return reply.code(200).send({
          runId: request.params.runId,
          status: "approval_already_signalled",
          decision: input.decision,
          approvedBy: result.approval.approved_by,
          expiresAt: result.approval.expires_at,
        });
      }
      return reply.code(202).send({ runId: request.params.runId, status: "approval_signalled" });
    } catch (error) {
      const typed = error as { statusCode?: number; code?: string; detail?: string; retryAfterSeconds?: number };
      if (typed.code === "approval_rate_limited" && typed.retryAfterSeconds) reply.header("retry-after", String(typed.retryAfterSeconds));
      return reply.code(typed.statusCode ?? 500).send({
        error: typed.code ?? "internal_error",
        ...(typed.detail ? { detail: typed.detail } : {}),
        ...(typed.retryAfterSeconds ? { retryAfterSeconds: typed.retryAfterSeconds } : {}),
      });
    }
  });

  app.post("/v1/channel-approvals/decide", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "channels:ingest");
    const input = z.object({
      token: z.string().trim().min(32).max(4096),
      channelType: z.enum(["telegram", "whatsapp"]),
      externalIdentity: z.string().trim().min(1).max(240),
      externalConversationId: z.string().trim().min(1).max(240).optional(),
      channelConnectionId: z.string().uuid().optional(),
    }).parse(request.body ?? {});
    let claims;
    try {
      claims = verifyChannelApprovalActionToken(input.token, dependencies.config.INTERNAL_AUTH_SECRET ?? "", {
      });
    } catch {
      return reply.code(401).send({ error: "invalid_channel_approval" });
    }
    const approval = await approvals.getById(auth.organizationId, claims.approvalId);
    const target = approval ? await channels.getApprovalPromptTarget(approval.run_id) : null;
    if (!approval || !target || target.channel_type !== input.channelType || target.external_identity !== input.externalIdentity || (input.externalConversationId && target.external_conversation_id !== input.externalConversationId) || (input.channelConnectionId && target.channel_connection_id !== input.channelConnectionId) || target.owner_actor_id !== auth.actorId) {
      return reply.code(403).send({ error: "channel_approval_not_authorized" });
    }
    try {
      const result = await decideApproval({
        organizationId: auth.organizationId,
        runId: approval.run_id,
        providerToolCallId: approval.provider_tool_call_id,
        argumentsHash: approval.arguments_hash,
        decision: claims.decision,
        approvedBy: target.owner_actor_id,
        rateLimitKey: `${auth.organizationId}:channel:${target.owner_actor_id}`,
      });
      return reply.code(result.accepted ? 202 : 200).send({
        runId: approval.run_id,
        decision: claims.decision,
        status: result.accepted ? "approval_signalled" : "approval_already_signalled",
      });
    } catch (error) {
      const typed = error as { statusCode?: number; code?: string; detail?: string; retryAfterSeconds?: number };
      if (typed.code === "approval_rate_limited" && typed.retryAfterSeconds) reply.header("retry-after", String(typed.retryAfterSeconds));
      return reply.code(typed.statusCode ?? 500).send({
        error: typed.code ?? "internal_error",
        ...(typed.detail ? { detail: typed.detail } : {}),
        ...(typed.retryAfterSeconds ? { retryAfterSeconds: typed.retryAfterSeconds } : {}),
      });
    }
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

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/retry", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "chat:write");
    const source = await runs.getRun(auth.organizationId, request.params.runId);
    if (!source) return reply.code(404).send({ error: "run_not_found" });
    const installation = await agents.getInstallation(auth.organizationId, source.installation_id);
    if (!installation) return reply.code(404).send({ error: "installation_not_found" });
    requireHostedInstallation(installation);
    const retried = await platformChat.retryMessage({
      organizationId: auth.organizationId,
      runId: source.id,
      actorId: auth.actorId,
      correlationId: auth.correlationId,
    });
    const workflowEnabled = dependencies.config.TEMPORAL_ENABLED && Boolean(dependencies.startWorkflow);
    if (workflowEnabled && dependencies.startWorkflow && retried.run.status === "received") {
      try {
        await dependencies.startWorkflow(retried.run.id);
      } catch (error) {
        await runs.appendEvent({
          organizationId: auth.organizationId,
          runId: retried.run.id,
          installationId: retried.run.installation_id,
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
      conversation: retried.conversation,
      message: retried.message,
      runId: retried.run.id,
      status: retried.run.status,
      created: retried.created,
      durable: workflowEnabled,
    });
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/external-event", async (request, reply) => {
    const auth = requireAuth(request, dependencies.config);
    requireScope(auth, dependencies.config, "runs:write");
    const run = await runs.getRun(auth.organizationId, request.params.runId);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    if (run.status !== "awaiting_external_event" && run.status !== "awaiting_human") return reply.code(409).send({ error: "run_not_waiting_for_event", status: run.status });
    if (!dependencies.signalExternalEvent) return reply.code(503).send({ error: "temporal_not_configured" });
    const input = z.object({ key: z.string().trim().min(1).max(160), payload: z.record(z.string(), z.unknown()).default({}) }).strict().parse(request.body ?? {});
    await dependencies.signalExternalEvent(request.params.runId, input);
    return reply.code(202).send({ runId: request.params.runId, status: run.status === "awaiting_human" ? "handoff_signalled" : "external_event_signalled", key: input.key });
  });

  return app;
}

async function fetchHermesSkillInstructions(rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com") throw new Error("HERMES_SKILL_SOURCE_NOT_ALLOWED");
  const response = await fetch(url, { redirect: "error", headers: { accept: "text/plain" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("HERMES_SKILL_SOURCE_UNAVAILABLE");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 40_000) throw new Error("HERMES_SKILL_SOURCE_TOO_LARGE");
  const raw = await response.text();
  if (raw.length > 40_000) throw new Error("HERMES_SKILL_SOURCE_TOO_LARGE");
  const bodyStart = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
  const instructions = bodyStart >= 0 ? raw.slice(bodyStart + 4).trim() : raw.trim();
  if (!instructions) throw new Error("HERMES_SKILL_SOURCE_EMPTY");
  return instructions;
}

function hermesSkillSlug(slug: string): string {
  const readable = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "skill";
  const suffix = createHash("sha256").update(slug).digest("hex").slice(0, 12);
  return `hermes-${readable}-${suffix}`.slice(0, 80).replace(/-+$/, "");
}
