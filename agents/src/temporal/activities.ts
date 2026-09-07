import type { Pool } from "pg";
import { RunRepository } from "../db/repositories/run-repository";
import { ModelCallRepository } from "../db/repositories/model-call-repository";
import { RunBudgetRepository } from "../db/repositories/run-budget-repository";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { MemoryRepository } from "../db/repositories/memory-repository";
import { MemoryLifecycle } from "../memory/lifecycle";
import { RetrievalService } from "../memory/retrieval";
import { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import type { AgentRunActivities } from "./contracts";
import { ModelGateway } from "../model/gateway";
import { EnvironmentCredentialResolver, VaultCredentialResolver, type CredentialResolver } from "../model/credentials";
import type { ModelPricing, ModelProvider } from "../model/types";
import { type AgentLoopEvent, type AgentLoopLimits, type AgentLoopResult, type ModelCreditReservation } from "../runtime/loop";
import type { ModelCreditPricing } from "../model/credit-pricing";
import { actualModelCallCredits, estimateModelCallCredits, estimatePromptTokens, shouldChargeModelCredits } from "../model/credit-pricing";
import { buildAgentContext } from "../runtime/context";
import { executionScopeFromRun } from "../runtime/execution-scope";
import { createGroundingFallbackResponse, shouldFailClosedWithoutEvidence } from "../runtime/grounding";
import { createAgentBudgetLedger, type AgentBudgetLedger } from "../runtime/budget";
import { hashToolArguments, ToolRegistry } from "../tools/registry";
import { KasitekCoreReadClient } from "../core/client";
import type { AppConfig } from "../config";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { RunStepRepository } from "../db/repositories/run-step-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { SummaryRepository } from "../db/repositories/summary-repository";
import { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { resolveModelTarget } from "../model/policy";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { TelegramBotClient } from "../channels/telegram-client";
import { DiscordBotClient } from "../channels/discord-client";
import { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { authorizeInstallationCapability } from "../capabilities/authorization";
import { createCapabilityRuntime } from "../capabilities/runtime";
import { validateWorkflowGraph, type WorkflowGraph } from "../workflows/graph";
import { executeWorkflowGraph, type GraphAgentLoopRequest, type GraphAgentLoopResult, type GraphExecutionLimits, type GraphExecutionUsage } from "../workflows/executor";
import { WorkflowStateRepository } from "../db/repositories/workflow-state-repository";
import { WorkflowCheckpointRepository } from "../db/repositories/workflow-checkpoint-repository";
import { redactSensitiveValue, redactToolOutput } from "../tools/redaction";
import { ModelProviderError, type ModelCredentials, type ModelMessage, type ModelRequest, type ModelResponse } from "../model/types";
import { activityInfo, cancellationSignal, heartbeat } from "@temporalio/activity";
import { buildGroundingProvenance } from "../runtime/provenance";
import { approvalSnapshotHashFromResource, toolInvocationContextFromScope, type ToolInvocationContext } from "../tools/types";
import type { CoreContentPost, CoreContentPosts, CoreContentPublishBatch, CoreContentPublishBatchPreflight, CoreWorkspaceConnections, CoreWorkspaceStatus } from "../core/client";
import { buildDomainApprovalSnapshot, projectBookingApprovalResource, projectCampaignApprovalResource } from "../approval/domain-preview";
import { ConversationActionService } from "../actions/conversation-actions";
import type { OfferHandoffArguments } from "../actions/conversation-actions";
import { HandoffRepository } from "../db/repositories/handoff-repository";
import { authorizationRemediationText } from "../channels/authorization";
import { createChannelApprovalActionToken } from "../approval/channel-action";
import { buildChannelApprovalPrompt } from "../approval/channel-prompt";
import { IntegrationRepository } from "../integrations/repository";
import { IntegrationToolService } from "../integrations/service";
import { registerIntegrationTools } from "../integrations/tools";
import { recordBudgetExhaustion, recordRetrievalResult, recordTemporalActivityAttempt, withSpan } from "../telemetry/spans";
import { AGENT_MEDIA_HARNESS_TOOLS, agentResponseSchema, agentResponseToolInputSchema, findAuthorizationRequirement, parseAgentResponse } from "../media/contracts";
import { buildChannelMediaText, buildChannelUiFallback, channelUiNavigationButtons, type ResolvedAgentMedia } from "../media/delivery";
import { channelMediaProfile } from "../media/profiles";
import { runWithRequiredDatabaseContext, type DatabaseContext } from "../db/context";
import { durableAgentLoopCheckpoint, readDurableAgentLoopCheckpoint } from "../runtime/loop-checkpoint";
import { agentLoopOperationKeyPrefix, workflowAgentLoopOperationKeyPrefix, workflowModelOperationKey } from "../runtime/operation-keys";
import { SkillRepository } from "../db/repositories/skill-repository";
import { matchSkills, renderSkillInstructions } from "../skills/contracts";
import { RemoteMcpProviderRepository } from "../db/repositories/remote-mcp-provider-repository";
import { CoreHostAdapter, HostCapabilityRouter, NativeHostAdapter } from "../hosts/capabilities";
import { createAgentHarness, type AgentHarness } from "../runtime/harness";
import { resourceAccessFromExecutionScope } from "../runtime/scope-projections";
import { PostgresExecutionJournal, RunRepositoryExecutionJournalStore } from "../journal";
import { PostgresDeliveryObligationCoordinator } from "../delivery";

export interface ActivityOptions {
  gateway?: ModelGateway;
  credentials?: CredentialResolver;
  tools?: ToolRegistry;
  coreClient?: KasitekCoreReadClient;
  telegramClient?: TelegramBotClient;
  discordClient?: DiscordBotClient;
  config?: AppConfig;
  conversationActions?: ConversationActionService;
  integrationTools?: IntegrationToolService;
  skills?: SkillRepository;
  remoteMcpProviders?: RemoteMcpProviderRepository;
  hostCapabilities?: HostCapabilityRouter;
  harness?: AgentHarness;
}

export function normalizeConnectionFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "all" ? normalized : undefined;
}

function journalHarnessEvent(event: AgentLoopEvent) {
  return {
    kind: "harness.turn" as const,
    data: {
      type: event.type,
      iteration: event.iteration,
      payload: event.payload,
    },
  };
}

type ChannelSelectionObject = {
  id?: unknown;
  channelId?: unknown;
  handle?: unknown;
  displayName?: unknown;
};

const CONTENT_CHANNEL_PLATFORMS = new Set([
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "TIKTOK",
  "BLUESKY",
  "LINKEDIN",
  "X",
]);

function splitContentChannelTarget(value: unknown): { platform: string; selector?: string } | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toUpperCase();
  if (CONTENT_CHANNEL_PLATFORMS.has(normalized)) return { platform: normalized };

  const combined = /^(facebook|instagram|threads|tiktok|bluesky|linkedin|x)(?:\s+|\s*[:\/-]\s*)(.+)$/i.exec(trimmed);
  if (!combined) return { platform: trimmed };
  const selector = combined[2]?.trim().replace(/^\((.*)\)$/, "$1").trim();
  return selector
    ? { platform: combined[1]!.toUpperCase(), selector }
    : { platform: combined[1]!.toUpperCase() };
}

function normalizeChannelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const selection = value as ChannelSelectionObject;
  for (const key of ["channelId", "id", "handle", "displayName"] as const) {
    if (typeof selection[key] !== "string") continue;
    const normalized = selection[key].trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeChannelSelections(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([platform, selection]) => [platform, normalizeChannelSelection(selection)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeContentWriteDestination(args: Record<string, unknown>): {
  channels?: string[];
  primaryChannelId?: string;
  channelSelections?: Record<string, string>;
} {
  const selections = normalizeChannelSelections(args.channelSelections) ?? {};
  const channelsProvided = Array.isArray(args.channels);
  const channels: string[] = [];

  if (channelsProvided) {
    for (const value of args.channels as unknown[]) {
      const target = splitContentChannelTarget(value);
      if (!target || channels.includes(target.platform)) continue;
      channels.push(target.platform);
      if (target.selector && !selections[target.platform]) selections[target.platform] = target.selector;
    }
  }

  const primary = typeof args.primaryChannelId === "string" ? splitContentChannelTarget(args.primaryChannelId) : undefined;
  return {
    ...(channelsProvided ? { channels } : {}),
    ...(primary ? { primaryChannelId: primary.selector ?? args.primaryChannelId as string } : {}),
    ...(Object.keys(selections).length ? { channelSelections: selections } : {}),
  };
}

function pricingFromConfig(config?: AppConfig): Record<string, ModelPricing> {
  if (!config?.MODEL_PRICING_JSON) return {};
  try {
    const parsed = JSON.parse(config.MODEL_PRICING_JSON) as Record<string, ModelPricing>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isFinite(value.inputUsdPerMillion) && Number.isFinite(value.outputUsdPerMillion)));
  } catch {
    throw new Error("MODEL_PRICING_JSON must be valid JSON");
  }
}

function creditPricingFromConfig(config?: AppConfig): ModelCreditPricing {
  return {
    creditsPerUsd: config?.CREDIT_USD_TO_CREDITS ?? 1_000,
    version: config?.CREDIT_PRICING_VERSION ?? "model-cost-v1",
  };
}

const contentMediaAssetOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["IMAGE", "VIDEO", "AUDIO"] },
    mimeType: { type: "string" },
    fileName: { type: ["string", "null"] },
    byteSize: { type: "integer", minimum: 0 },
    checksum: { type: ["string", "null"] },
    width: { type: ["integer", "null"] },
    height: { type: ["integer", "null"] },
    durationMs: { type: ["integer", "null"] },
    processingStatus: { type: "string" },
    scanStatus: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "kind", "mimeType", "byteSize", "processingStatus", "scanStatus", "createdAt"],
  additionalProperties: false,
};

export async function reserveModelCredits(input: {
  billingMode: AppConfig["CREDIT_BILLING_MODE"];
  gateway: ModelGateway;
  modelPricing: Record<string, ModelPricing>;
  creditPricing: ModelCreditPricing;
  coreClient?: KasitekCoreReadClient;
  context: ToolInvocationContext;
  runId: string;
  operationKey?: string;
  request: ModelRequest;
  credentials: ModelCredentials;
}): Promise<ModelCreditReservation | undefined> {
  if (!shouldChargeModelCredits(input.billingMode, input.credentials.fundingSource)) return undefined;
  const estimatedCredits = estimateModelCallCredits(input.gateway, input.modelPricing, input.creditPricing, input.request);
  if (input.billingMode === "shadow") return undefined;
  if (!input.coreClient) throw new Error("CREDIT_BOUNDARY_UNAVAILABLE");
  const reservation = await input.coreClient.reserveCredits(input.context, {
    actionKey: "ai.model_call",
    estimatedCredits,
    sourceType: "AGENT_RUN",
    sourceId: input.runId,
    pricingVersion: input.creditPricing.version,
    expiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
    ...(input.operationKey ? { idempotencyKey: `${input.runId}:credits:${input.operationKey}` } : {}),
  });
  return {
    capture: async (response: ModelResponse) => {
      const actualCredits = actualModelCallCredits(input.gateway, input.modelPricing, input.creditPricing, response);
      await input.coreClient!.captureCredits(input.context, reservation.reservation.id, actualCredits, {
        provider: response.provider,
        model: response.model,
        fundingSource: input.credentials.fundingSource,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.providerCostUsd === undefined ? {} : { providerCostUsd: response.usage.providerCostUsd }),
      });
    },
    release: async (reason: string) => {
      await input.coreClient!.releaseCredits(input.context, reservation.reservation.id, reason.slice(0, 2_000));
    },
  };
}

async function reserveRunModelBudget(input: {
  repository: RunBudgetRepository;
  organizationId: string;
  runId: string;
  reservationKey: string;
  parallelLeaseId?: string;
  gateway: ModelGateway;
  request: ModelRequest;
}): Promise<ModelCreditReservation> {
  const estimatedInputTokens = estimatePromptTokens(input.request);
  const estimatedOutputTokens = Math.max(1, input.request.maxTokens ?? 4_096);
  let reservation;
  try {
    reservation = await input.repository.reserveModelCall({
      organizationId: input.organizationId,
      runId: input.runId,
      reservationKey: input.reservationKey,
      estimatedTokens: estimatedInputTokens + estimatedOutputTokens,
      estimatedCostUsd: input.gateway.estimateCost(input.request.provider, input.request.model, estimatedInputTokens, estimatedOutputTokens),
      ...(input.parallelLeaseId ? { parallelLeaseId: input.parallelLeaseId } : {}),
    });
  } catch (error) {
    if (error instanceof Error && /BUDGET_EXCEEDED$/.test(error.message)) recordBudgetExhaustion(error.message);
    throw error;
  }
  return {
    capture: async (response) => reservation.capture(response.usage),
    release: async (reason) => reservation.release(reason),
    markUnknown: async (reason) => reservation.markUnknown(reason),
  };
}

async function consumeRunToolBudget(repository: RunBudgetRepository, input: { organizationId: string; runId: string; parallelLeaseId?: string }): Promise<void> {
  try {
    await repository.consumeToolCallWithParallelLease(input);
  } catch (error) {
    if (error instanceof Error && error.message === "TOOL_CALL_BUDGET_EXCEEDED") recordBudgetExhaustion(error.message);
    throw error;
  }
}

export function createDefaultTools(coreClient?: KasitekCoreReadClient, conversationActions?: ConversationActionService, integrationTools?: IntegrationToolService, memoryRepository?: MemoryRepository, hostCapabilities?: HostCapabilityRouter): ToolRegistry {
  const resolvedHostCapabilities = hostCapabilities ?? (coreClient
    ? new HostCapabilityRouter([new CoreHostAdapter(coreClient), new NativeHostAdapter()])
    : undefined);
  const tools = new ToolRegistry();
  if (memoryRepository) {
    const memoryLifecycle = new MemoryLifecycle(memoryRepository);
    tools.register({
      name: "kasitek.agent.memory_search",
      version: "1.0.0",
      description: "Search the current agent's permitted memory for relevant prior evidence.",
      riskClass: "read",
      requiresApproval: false,
      timeoutMs: 8_000,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 4_000 }, limit: { type: "integer", minimum: 1, maximum: 20 } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { memories: { type: "array" } }, required: ["memories"], additionalProperties: false },
      manifest: { ownerService: "agents", requiredScope: "agent.memory.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["memories.content", "memories.provenance"] },
      handler: async (context, args) => {
        const records = await memoryLifecycle.search(
          resourceAccessFromExecutionScope(context.scope),
          String(args.query),
          context.memoryPolicy,
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return {
          memories: records.map((record) => ({
            id: record.id,
            namespace: record.namespace,
            memoryType: record.memory_type,
            text: record.canonical_text,
            sensitivity: record.sensitivity,
            confidence: record.confidence,
            expiresAt: record.expires_at,
          })),
        };
      },
    });
    tools.register({
      name: "kasitek.agent.memory_remember",
      version: "1.0.0",
      description: "Save an explicit user-requested memory for this agent after approval.",
      riskClass: "controlled-write",
      requiresApproval: true,
      timeoutMs: 8_000,
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string", enum: ["conversation", "user_private", "organization_shared", "agent_private"] },
          memoryType: { type: "string", enum: ["working", "semantic", "episodic", "procedural"] },
          text: { type: "string", minLength: 1, maxLength: 8_000 },
          factKey: { type: "string", minLength: 1, maxLength: 240 },
          supersedesMemoryId: { type: "string", format: "uuid" },
          sensitivity: { type: "string", enum: ["normal", "sensitive", "restricted"] },
          expiresAt: { type: ["string", "null"] },
        },
        required: ["namespace", "memoryType", "text"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { memory: { type: "object" } }, required: ["memory"], additionalProperties: false },
      manifest: { ownerService: "agents", requiredScope: "agent.memory.write", execution: "durable", idempotency: "required", approval: "always", auditClassification: "restricted", redaction: ["memory.content", "memory.provenance"] },
      handler: async (context, args) => {
        const memory = await memoryLifecycle.rememberExplicit(
          resourceAccessFromExecutionScope(context.scope),
          {
            namespace: String(args.namespace) as Parameters<MemoryLifecycle["rememberExplicit"]>[1]["namespace"],
            memoryType: String(args.memoryType) as Parameters<MemoryLifecycle["rememberExplicit"]>[1]["memoryType"],
            canonicalText: String(args.text),
            ...(typeof args.factKey === "string" ? { factKey: args.factKey } : {}),
            ...(typeof args.supersedesMemoryId === "string" ? { supersedesMemoryId: args.supersedesMemoryId } : {}),
            sensitivity: typeof args.sensitivity === "string" ? args.sensitivity as "normal" | "sensitive" | "restricted" : undefined,
            expiresAt: args.expiresAt === null || typeof args.expiresAt === "string" ? args.expiresAt : undefined,
            ...(String(args.namespace) === "user_private" && context.actorId ? { ownerUserId: context.actorId } : {}),
          },
          context.memoryPolicy,
        );
        return { memory: { id: memory.id, namespace: memory.namespace, memoryType: memory.memory_type, text: memory.canonical_text, expiresAt: memory.expires_at } };
      },
    });
  }
  tools.register({
    name: "kasitek.agent.respond",
    version: "1.0.0",
    description: "Finish the current hosted-agent reply. Use this when returning workspace media: provide the normal text plus stable media asset references. Do not put URLs or raw bytes in the response.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: agentResponseToolInputSchema,
    outputSchema: {
      type: "object",
      properties: { control: { type: "string", const: "final_response" }, response: agentResponseToolInputSchema },
      required: ["control", "response"],
      additionalProperties: false,
    },
    handler: async (context, args) => {
      const response = agentResponseSchema.parse(args);
      if (!response.media.length) return { control: "final_response", response };
      if (!coreClient) throw new Error("kasitek-core media boundary is not configured");
      const media = await Promise.all(response.media.map(async (item) => {
        // Preview resolution verifies both the database record and the backing
        // object before a response can complete. Metadata alone can outlive a
        // lost local object and would otherwise produce a blank attachment.
        const { asset } = await coreClient.getContentMediaPreview(context, item.assetId);
        const kind = asset.kind.toLowerCase();
        if (kind !== item.kind) throw new Error(`Media kind does not match asset: ${item.assetId}`);
        if (asset.processingStatus !== "READY" || asset.scanStatus !== "CLEAN") throw new Error(`Media asset is not ready: ${item.assetId}`);
        return {
          ...item,
          mimeType: asset.mimeType,
          ...(asset.fileName ? { fileName: asset.fileName } : {}),
        };
      }));
      return { control: "final_response", response: { ...response, media } };
    },
  });
  tools.register({
    name: "platform.current_time",
    version: "1.0.0",
    description: "Get the current UTC time from the trusted platform runtime.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { iso: { type: "string" } },
      required: ["iso"],
      additionalProperties: false,
    },
    manifest: { ownerService: "agents", requiredScope: "platform.time.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [] },
    handler: async (context) => {
      if (!resolvedHostCapabilities) throw new Error("HOST_CAPABILITY_ROUTER_NOT_CONFIGURED");
      const result = await resolvedHostCapabilities.invoke<{ iso: string }>({ name: "platform.current_time", scope: context.scope });
      if (result.status !== "succeeded") throw new Error(`HOST_CAPABILITY_${result.code}`);
      return result.value;
    },
  });
  tools.register({
    name: "kasitek.core.content_media_get",
    version: "1.0.0",
    description: "Read safe metadata for one workspace media asset. Use it to verify an asset before attaching it to a hosted-agent response.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["assetId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { asset: contentMediaAssetOutputSchema }, required: ["asset"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_media", argument: "assetId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core media boundary is not configured");
      return coreClient.getContentMediaMetadata(context, String(args.assetId));
    },
  });
  tools.register({
    name: "kasitek.core.content_media_preview",
    version: "1.0.0",
    description: "Resolve one authorized workspace media asset to safe metadata and a short-lived preview URL for the current response.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["assetId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { asset: contentMediaAssetOutputSchema, previewUrl: { type: "string", minLength: 1 } }, required: ["asset", "previewUrl"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_media", argument: "assetId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["previewUrl"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core media boundary is not configured");
      return coreClient.getContentMediaPreview(context, String(args.assetId));
    },
  });
  tools.register({
    name: "kasitek.core.customer_get",
    version: "1.0.0",
    description: "Read a customer profile and scoped history from kasitek-core.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["customerId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["customer"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "customers.read", resourceSelector: { type: "customer", argument: "customerId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["customer.email", "customer.phone"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCustomer(context, String(args.customerId));
    },
  });
  tools.register({
    name: "kasitek.core.workspace_status",
    version: "1.0.0",
    description: "Read connection providers and health statuses for the current KasiTek workspace.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { organizationId: { type: "string" }, connections: { type: "array" } },
      required: ["organizationId", "connections"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "connections.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: ["connections.credentials"] },
    handler: async (context, args) => {
      if (resolvedHostCapabilities) {
        const result = await resolvedHostCapabilities.invoke<CoreWorkspaceStatus>({
          name: "kasitek.core.workspace_status",
          scope: context.scope,
          arguments: args,
        });
        if (result.status !== "succeeded") throw new Error(`HOST_CAPABILITY_${result.code}`);
        return result.value;
      }
      throw new Error("HOST_CAPABILITY_ROUTER_NOT_CONFIGURED");
    },
  });
  tools.register({
    name: "kasitek.core.connections_list",
    version: "1.0.0",
    description: "List connected workspace accounts with provider names, account labels, health, webhook state, and enabled areas without credentials.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          maxLength: 80,
          description: "Optional provider filter. Omit this field to include every provider.",
        },
        status: {
          type: "string",
          maxLength: 40,
          description: "Optional status filter. Omit this field to include every status.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { organizationId: { type: "string" }, connections: { type: "array" } },
      required: ["organizationId", "connections"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "connections.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["connections.metadata", "connections.lastError", "connections.credentials"],
      presentation: {
        projection: "workspace_connections",
        mode: "inline",
        channels: ["platform", "website"],
        workspace: "connections",
        fallback: "I found the workspace connections.",
        actions: [{ id: "open-connections", label: "Open connections", kind: "navigate", href: "/connections" }],
      },
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      const response = await coreClient.listWorkspaceConnections(context, {
        provider: normalizeConnectionFilter(args.provider),
        status: normalizeConnectionFilter(args.status),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return projectWorkspaceConnectionsForAgent(response);
    },
  });
  tools.register({
    name: "kasitek.core.connection_status_update",
    version: "1.0.0",
    description: "Disconnect or revoke a connected workspace account after user approval.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 20_000,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", minLength: 1, maxLength: 80 },
        displayName: { type: "string", minLength: 1, maxLength: 240 },
        handle: { type: "string", minLength: 1, maxLength: 160 },
        status: { type: "string", enum: ["DISCONNECTED", "REVOKED"] },
      },
      required: ["provider", "displayName", "status"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { connection: { type: "object" } },
      required: ["connection"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "connections.write",
      resourceSelector: { type: "connection", argument: "displayName" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "restricted",
      redaction: ["connection.metadata", "connection.lastError", "connection.credentials"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateWorkspaceConnectionStatus(
        context,
        {
          provider: String(args.provider),
          displayName: String(args.displayName),
          handle: typeof args.handle === "string" ? args.handle : undefined,
        },
        String(args.status) as "DISCONNECTED" | "REVOKED",
      );
    },
  });
  tools.register({
    name: "kasitek.core.workspace_report",
    version: "1.0.0",
    description: "Read organization-scoped workspace reporting aggregates without contact values, message bodies, or provider credentials.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        organizationId: { type: "string" },
        connections: { type: "object" },
        content: { type: "object" },
        contacts: { type: "object" },
        inbox: { type: "object" },
        bookings: { type: "object" },
        campaigns: { type: "object" },
        templates: { type: "object" },
      },
      required: ["organizationId", "connections", "content", "contacts", "inbox", "bookings", "campaigns", "templates"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "workspace.reporting.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["contacts.phone", "inbox.messageBody", "connections.credentials"],
      presentation: {
        projection: "workspace_report",
        mode: "expanded",
        channels: ["platform", "website"],
        workspace: "report",
        fallback: "I found the workspace overview.",
        actions: [{ id: "open-workspace-report", label: "Open workspace", kind: "navigate", href: "/workspace" }],
      },
    },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getWorkspaceReport(context);
    },
  });
  tools.register({
    name: "kasitek.core.booking_services_list",
    version: "1.0.0",
    description: "List the booking services configured for the current KasiTek workspace.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { services: { type: "array" }, total: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["services"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "bookings.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listBookingServices(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.bookings_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's upcoming and historical bookings.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { bookings: { type: "array" }, total: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["bookings"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "bookings.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["bookings.contactPhone", "bookings.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listBookings(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.booking_get",
    version: "1.0.0",
    description: "Read one organization-scoped booking with safe customer and scheduling details.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { bookingId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["bookingId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["booking"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "bookings.read",
      resourceSelector: { type: "booking", argument: "bookingId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["booking.contactPhone", "booking.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getBooking(context, String(args.bookingId));
    },
  });
  tools.register({
    name: "kasitek.core.campaigns_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's WhatsApp campaign status and delivery metrics.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { campaigns: { type: "array" }, total: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["campaigns"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "campaigns.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["campaigns.templateBody", "campaigns.recipientPhone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listCampaigns(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.campaign_summary",
    version: "1.0.0",
    description: "Read one organization-scoped WhatsApp campaign summary without recipient details.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["campaignId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { campaign: { type: "object" } }, required: ["campaign"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "campaigns.read",
      resourceSelector: { type: "campaign", argument: "campaignId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["campaign.templateBody", "campaign.recipientPhone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCampaignSummary(context, String(args.campaignId));
    },
  });
  tools.register({
    name: "kasitek.core.templates_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's WhatsApp templates and approval status.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["APPROVED", "PENDING", "REJECTED", "DISABLED"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { templates: { type: "array" }, total: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["templates"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "templates.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["templates.body", "templates.buttons"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listTemplates(
        context,
        typeof args.status === "string" ? args.status as "APPROVED" | "PENDING" | "REJECTED" | "DISABLED" : undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      );
    },
  });
  tools.register({
    name: "kasitek.core.contacts_list",
    version: "1.0.0",
    description: "Search the current KasiTek workspace's WhatsApp contacts and consent state.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 200 },
        optIn: { type: "string", enum: ["all", "true", "false"] },
        excluded: { type: "string", enum: ["all", "true", "false"] },
        tag: { type: "string", maxLength: 120 },
        location: { type: "string", maxLength: 160 },
        listLabel: { type: "string", maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["contacts"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "contacts.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["contacts.phone", "contacts.metadata"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listContacts(context, {
        q: typeof args.q === "string" ? args.q : undefined,
        optIn: typeof args.optIn === "string" ? args.optIn as "all" | "true" | "false" : undefined,
        excluded: typeof args.excluded === "string" ? args.excluded as "all" | "true" | "false" : undefined,
        tag: typeof args.tag === "string" ? args.tag : undefined,
        location: typeof args.location === "string" ? args.location : undefined,
        listLabel: typeof args.listLabel === "string" ? args.listLabel : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.contact_update",
    version: "1.0.0",
    description: "Update one workspace contact's profile, consent, exclusion, or list membership after approval.",
    riskClass: "controlled-write",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", minLength: 1, maxLength: 160 },
        fullName: { type: "string", maxLength: 240 },
        phone: { type: "string", maxLength: 80 },
        location: { type: "string", maxLength: 160 },
        tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 50 },
        notes: { type: "string", maxLength: 4_000 },
        listLabel: { type: "string", maxLength: 160 },
        metadata: { type: "object", additionalProperties: true },
        optIn: { type: "boolean" },
        excluded: { type: "boolean" },
      },
      required: ["contactId"],
      minProperties: 2,
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["contact"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "contacts.write",
      resourceSelector: { type: "contact", argument: "contactId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["contact.phone", "contact.metadata", "contact.notes"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateContact(context, String(args.contactId), {
        fullName: typeof args.fullName === "string" ? args.fullName : undefined,
        phone: typeof args.phone === "string" ? args.phone : undefined,
        location: typeof args.location === "string" ? args.location : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        notes: typeof args.notes === "string" ? args.notes : undefined,
        listLabel: typeof args.listLabel === "string" ? args.listLabel : undefined,
        metadata: args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata) ? args.metadata as Record<string, unknown> : undefined,
        optIn: typeof args.optIn === "boolean" ? args.optIn : undefined,
        excluded: typeof args.excluded === "boolean" ? args.excluded : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversations_list",
    version: "1.0.0",
    description: "List the current KasiTek workspace's inbox conversations and unread counts.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { conversations: { type: "array" }, total: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["conversations"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["conversations.phone", "conversations.lastMessage"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listInboxConversations(context, { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_messages_list",
    version: "1.0.0",
    description: "Read the organization-scoped message timeline for one inbox conversation.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", minLength: 1, maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["messages"], additionalProperties: true },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.read",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["messages.content", "messages.attachments"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listInboxMessages(context, String(args.conversationId), { limit: typeof args.limit === "number" ? args.limit : undefined });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversation_update",
    version: "1.0.0",
    description: "Star or unstar one organization-scoped inbox conversation.",
    riskClass: "controlled-write",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", minLength: 1, maxLength: 160 },
        starred: { type: "boolean" },
      },
      required: ["conversationId", "starred"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { success: { type: "boolean" }, conversationId: { type: "string" }, starred: { type: "boolean" } }, required: ["success", "conversationId", "starred"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "full",
      redaction: ["conversation.phone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.updateInboxConversation(context, String(args.conversationId), { starred: Boolean(args.starred) });
    },
  });
  tools.register({
    name: "kasitek.core.inbox_conversation_mark_read",
    version: "1.0.0",
    description: "Mark one organization-scoped WhatsApp inbox conversation read after approval.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 30_000,
    inputSchema: {
      type: "object",
      properties: { conversationId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["conversationId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { success: { type: "boolean" } }, required: ["success"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "inbox.write",
      resourceSelector: { type: "conversation", argument: "conversationId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["conversation.phone"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.markInboxConversationRead(context, String(args.conversationId));
    },
  });
  tools.register({
    name: "kasitek.core.channel_deliver",
    version: "1.0.0",
    description: "Send an approved reply to an organization-scoped external channel conversation.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        channelType: { type: "string", enum: ["whatsapp", "facebook", "instagram", "website"] },
        externalConversationId: { type: "string", minLength: 1, maxLength: 240 },
        text: { type: "string", minLength: 1, maxLength: 20_000 },
      },
      required: ["channelType", "externalConversationId", "text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        providerMessageId: { type: "string" },
        status: { type: "string", enum: ["sent", "unknown"] },
      },
      required: ["status"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "channels.write",
      resourceSelector: { type: "conversation", argument: "externalConversationId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["text", "externalConversationId", "providerMessageId"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.deliverChannelMessage({
        organizationId: context.organizationId,
        installationId: context.installationId,
        actorId: context.actorId ?? "kasitek-agent-platform",
        runId: context.runId,
        correlationId: context.correlationId,
        channelType: String(args.channelType),
        externalConversationId: String(args.externalConversationId),
        text: String(args.text),
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_posts_list",
    version: "1.0.0",
    description: "List the current workspace's content drafts, schedules, and publication records.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { posts: { type: "array" } }, required: ["posts"], additionalProperties: false },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "content.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["posts.publishJobs.providerReceipt", "posts.media.previewUrl"],
      presentation: {
        projection: "content_posts",
        mode: "inline",
        channels: ["platform", "website"],
        workspace: "content",
        fallback: "I found the workspace content.",
        actions: [{ id: "open-content", label: "Open content", kind: "navigate", href: "/content" }],
      },
    },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return projectContentPostsForAgent(await coreClient.listContentPosts(context));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_get",
    version: "1.0.0",
    description: "Read one workspace-owned content post and its safe publication status.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", properties: { postId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["postId"], additionalProperties: false },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["post.publishJobs.providerReceipt", "post.media.previewUrl"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      const response = await coreClient.getContentPost(context, String(args.postId));
      return { post: projectContentPostForAgent(response.post) };
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish_batch_preflight",
    version: "1.0.0",
    description: "Check every configured social destination for batch publishing readiness without publishing.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: { type: "object", properties: { postId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["postId"], additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1 },
        status: { type: "string", minLength: 1 },
        snapshotHash: { type: "string", minLength: 1 },
        mediaCount: { type: "integer", minimum: 0 },
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              platform: { type: "string" },
              accountName: { type: "string" },
              handle: { type: ["string", "null"] },
              state: { type: "string" },
              status: { type: "string" },
              requiredCapability: { type: "string" },
              remediationMode: { type: "string" },
              reasonCode: { type: ["string", "null"] },
              message: { type: ["string", "null"] },
            },
            required: ["platform", "accountName", "state", "status", "requiredCapability", "remediationMode"],
            additionalProperties: false,
          },
        },
      },
      required: ["postId", "status", "snapshotHash", "targets"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.preflightContentPublishBatch(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish_batch_status",
    version: "1.0.0",
    description: "Read the durable status of a multi-destination content publish batch.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", properties: { batchId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["batchId"], additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        batchId: { type: "string", minLength: 1 },
        status: { type: "string", minLength: 1 },
        postId: { type: "string", minLength: 1 },
        snapshotHash: { type: "string", minLength: 1 },
        targetCount: { type: "integer", minimum: 0 },
        publishedCount: { type: "integer", minimum: 0 },
        processingCount: { type: "integer", minimum: 0 },
        unknownCount: { type: "integer", minimum: 0 },
        failedCount: { type: "integer", minimum: 0 },
        blockedCount: { type: "integer", minimum: 0 },
        errorCode: { type: ["string", "null"] },
        errorMessage: { type: ["string", "null"] },
        completedAt: { type: ["string", "null"] },
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              platform: { type: "string" },
              accountName: { type: "string" },
              handle: { type: ["string", "null"] },
              state: { type: "string" },
              status: { type: "string" },
              requiredCapability: { type: "string" },
              remediationMode: { type: "string" },
              reasonCode: { type: ["string", "null"] },
              message: { type: ["string", "null"] },
            },
            required: ["platform", "accountName", "state", "status", "requiredCapability", "remediationMode"],
            additionalProperties: false,
          },
        },
      },
      required: ["batchId", "status", "unknownCount", "targets"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_publish_batch", argument: "batchId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getContentPublishBatch(context, String(args.batchId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish_batch_retry",
    version: "1.0.0",
    description: "Retry only confirmed failed destinations from an existing content publish batch.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: { type: "object", properties: { batchId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["batchId"], additionalProperties: false },
    outputSchema: { type: "object", required: ["post", "batch"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_publish_batch", argument: "batchId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.retryContentPublishBatch(context, String(args.batchId));
    },
  });
  tools.register({
    name: "kasitek.core.content_posts_insights_report",
    version: "1.0.0",
    description: "Report provider-reported performance for published workspace posts.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", minLength: 1, maxLength: 80 },
        metrics: { type: "array", items: { type: "string", minLength: 1, maxLength: 40 }, minItems: 1, maxItems: 7 },
        publishedFrom: { type: "string", minLength: 1, maxLength: 80 },
        publishedTo: { type: "string", minLength: 1, maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { posts: { type: "array" }, totalPosts: { type: "integer" }, hasMore: { type: "boolean" }, aggregates: { type: "array" }, coverage: { type: "array" }, generatedAt: { type: "string" } },
      required: ["posts", "totalPosts", "hasMore", "aggregates", "coverage", "generatedAt"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "content.read",
      execution: "immediate",
      idempotency: "not_applicable",
      approval: "none",
      auditClassification: "restricted",
      redaction: ["posts.providerPostId", "posts.connectionId", "posts.providerPayload"],
      presentation: {
        projection: "content_insights",
        mode: "expanded",
        channels: ["platform", "website"],
        workspace: "content",
        fallback: "I found the content performance.",
        actions: [{ id: "open-content-analytics", label: "Open analytics", kind: "navigate", href: "/content/analytics" }],
      },
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listContentPostInsights(context, {
        platform: typeof args.platform === "string" ? args.platform : undefined,
        metrics: Array.isArray(args.metrics) ? args.metrics.filter((metric): metric is string => typeof metric === "string") : undefined,
        publishedFrom: typeof args.publishedFrom === "string" ? args.publishedFrom : undefined,
        publishedTo: typeof args.publishedTo === "string" ? args.publishedTo : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_post_insights",
    version: "1.0.0",
    description: "Read provider-reported performance and growth for one published workspace post.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        platform: { type: "string", minLength: 1, maxLength: 80 },
        metrics: { type: "array", items: { type: "string", minLength: 1, maxLength: 40 }, minItems: 1, maxItems: 7 },
      },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["postId", "platforms", "generatedAt"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["providerPostId", "connectionId", "providerPayload"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getContentPostInsights(
        context,
        String(args.postId),
        {
          platform: typeof args.platform === "string" ? args.platform : undefined,
          metrics: Array.isArray(args.metrics) ? args.metrics.filter((metric): metric is string => typeof metric === "string") : undefined,
        },
      );
    },
  });
  tools.register({
    name: "kasitek.core.content_post_update",
    version: "1.0.0",
    description: "Update a workspace content draft without publishing it. Put canonical platform keys in channels, such as INSTAGRAM. Put an account id, handle, or display name in channelSelections. A combined label such as Instagram @handle is normalized when possible. Use media assetId values from attached workspace media to keep user-provided images on the draft.",
    riskClass: "draft",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", maxLength: 240 },
        prompt: { type: "string", maxLength: 4_000 },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
        channels: { type: "array", description: "Canonical platform keys only, for example INSTAGRAM. Do not put an account handle in this array.", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 },
        primaryChannelId: { type: "string", minLength: 1, maxLength: 160 },
        channelSelections: {
          description: "Map each platform key to the selected account id, handle, or display name.",
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string", minLength: 1, maxLength: 160 },
              {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 160 },
                  channelId: { type: "string", minLength: 1, maxLength: 160 },
                  handle: { type: "string", minLength: 1, maxLength: 160 },
                  displayName: { type: "string", minLength: 1, maxLength: 160 },
                },
                minProperties: 1,
                additionalProperties: false,
              },
            ],
          },
        },
        variants: { type: "array", items: { type: "object" }, maxItems: 20 },
        media: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assetId: { type: "string", minLength: 1, maxLength: 160 },
              sortOrder: { type: "integer", minimum: 0, maximum: 9 },
              altText: { type: "string", maxLength: 1_000 },
            },
            required: ["assetId"],
            additionalProperties: false,
          },
          maxItems: 10,
        },
        metadata: { type: "object" },
      },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt", "post.media.previewUrl"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      const destination = normalizeContentWriteDestination(args);
      const input = {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        content: typeof args.content === "string" ? args.content : undefined,
        channels: destination.channels,
        primaryChannelId: destination.primaryChannelId,
        channelSelections: destination.channelSelections,
        variants: Array.isArray(args.variants) ? args.variants as Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }> : undefined,
        media: Array.isArray(args.media) ? args.media as Array<{ assetId: string; sortOrder?: number; altText?: string }> : undefined,
        metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : undefined,
      };
      const response = await coreClient.updateContentDraft(context, String(args.postId), input);
      return projectContentWriteResult(response, "draft_updated", input.channelSelections);
    },
  });
  tools.register({
    name: "kasitek.core.content_post_draft",
    version: "1.0.0",
    description: "Create a workspace content draft without publishing it to any provider. Put canonical platform keys in channels, such as INSTAGRAM. Put an account id, handle, or display name in channelSelections. A combined label such as Instagram @handle is normalized when possible. When the user supplied attached workspace media, include its assetId in media.",
    riskClass: "draft",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 240 },
        prompt: { type: "string", maxLength: 4_000 },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
        channels: { type: "array", description: "Canonical platform keys only, for example INSTAGRAM. Do not put an account handle in this array.", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 },
        primaryChannelId: { type: "string", minLength: 1, maxLength: 160 },
        channelSelections: {
          description: "Map each platform key to the selected account id, handle, or display name.",
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string", minLength: 1, maxLength: 160 },
              {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 160 },
                  channelId: { type: "string", minLength: 1, maxLength: 160 },
                  handle: { type: "string", minLength: 1, maxLength: 160 },
                  displayName: { type: "string", minLength: 1, maxLength: 160 },
                },
                minProperties: 1,
                additionalProperties: false,
              },
            ],
          },
        },
        variants: { type: "array", items: { type: "object" }, maxItems: 20 },
        media: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assetId: { type: "string", minLength: 1, maxLength: 160 },
              sortOrder: { type: "integer", minimum: 0, maximum: 9 },
              altText: { type: "string", maxLength: 1_000 },
            },
            required: ["assetId"],
            additionalProperties: false,
          },
          maxItems: 10,
        },
        metadata: { type: "object" },
      },
      required: ["content", "channels"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", execution: "immediate", idempotency: "required", approval: "none", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt", "post.media.previewUrl"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      const destination = normalizeContentWriteDestination(args);
      const input = {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        content: String(args.content),
        channels: destination.channels ?? [],
        primaryChannelId: destination.primaryChannelId,
        channelSelections: destination.channelSelections,
        variants: Array.isArray(args.variants) ? args.variants as Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }> : undefined,
        media: Array.isArray(args.media) ? args.media as Array<{ assetId: string; sortOrder?: number; altText?: string }> : undefined,
        metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : undefined,
      };
      const response = await coreClient.createContentDraft(context, input);
      return projectContentWriteResult(response, "draft_created", input.channelSelections);
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish",
    version: "1.0.0",
    description: "Publish an approved content post to one configured social channel.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        platform: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["postId", "platform"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "result"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.publishContentPost(context, String(args.postId), String(args.platform));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish_batch",
    version: "1.0.0",
    description: "Publish one approved content post to every configured social destination in its draft as one durable operation.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "batch"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.publishContentPostBatch(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_schedule",
    version: "1.0.0",
    description: "Schedule a draft for provider publishing at a future time.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        scheduledFor: { type: "string", minLength: 20, maxLength: 64 },
      },
      required: ["postId", "scheduledFor"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "status"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.scheduleContentPost(context, String(args.postId), String(args.scheduledFor));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_unschedule",
    version: "1.0.0",
    description: "Move a scheduled content post back to a draft without publishing it.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "status"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.unscheduleContentPost(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_delete",
    version: "1.0.0",
    description: "Delete an unpublished content draft or schedule.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["postId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { postId: { type: "string" }, deleted: { type: "boolean" } }, required: ["postId", "deleted"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: [] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.deleteContentPost(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_delete_published",
    version: "1.0.0",
    description: "Delete a published post from one connected social platform after user approval. If authorizationRequired is returned, explain the missing access, use its remediation intent to direct the user to Connections access, and do not ask them to disconnect by default.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        platform: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["postId", "platform"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        localDeleted: { type: "boolean" },
        providerResults: { type: "array" },
        authorizationRequired: { type: ["object", "null"] },
      },
      required: ["success", "localDeleted", "providerResults"],
      additionalProperties: false,
    },
    manifest: {
      ownerService: "kasitek-core",
      requiredScope: "content.publish",
      resourceSelector: { type: "content_post", argument: "postId" },
      execution: "durable",
      idempotency: "required",
      approval: "always",
      auditClassification: "full",
      redaction: ["providerResults.externalPostId", "providerResults.message"],
    },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.deletePublishedContentPost(context, String(args.postId), String(args.platform));
    },
  });
  if (conversationActions) {
    const registerHandoffOfferTool = (name: "conversation.offer_handoff" | "conversation.request_human"): void => {
      const legacyName = name === "conversation.request_human";
      tools.register({
        name,
        version: "2.0.0",
        description: "Offer to connect the customer with a human. This records an offer only; the customer must agree before a handoff is created.",
        riskClass: "controlled-write",
        requiresApproval: false,
        timeoutMs: 12_000,
        inputSchema: {
          type: "object",
          properties: {
            conversationId: { type: "string", minLength: 1, maxLength: 160 },
            reason: { type: "string", enum: legacyName ? ["customer_requested", "agent_uncertain", "policy_required", "high_value", "configured_workflow", "other"] : ["agent_uncertain", "policy_required", "high_value", "configured_workflow", "other"] },
            priority: { type: "string", enum: ["normal", "high", "urgent"] },
            summary: { type: "string", minLength: 1, maxLength: 2_000 },
            metadata: { type: "object", additionalProperties: true },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 240 },
          },
          required: ["reason", "summary"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            status: { type: "string", const: "handoff_offered" },
            handoffOfferId: { type: "string" },
            conversationId: { type: "string" },
            created: { type: "boolean" },
            control: { type: "string", const: "continue" },
          },
          required: ["status", "handoffOfferId", "conversationId", "created", "control"],
          additionalProperties: false,
        },
        manifest: { ownerService: "agents", requiredScope: "conversations.handoff", execution: "durable", idempotency: "required", approval: "none", auditClassification: "full", redaction: ["metadata"] },
        handler: async (context, args) => {
          const normalized = args as unknown as OfferHandoffArguments;
          const legacyReason = (args as Record<string, unknown>).reason;
          return conversationActions.offerHandoff(context, {
            ...normalized,
            // Old prompts used customer_requested for this model action. Keep
            // them operational, but never let that stale label commit a request.
            reason: legacyReason === "customer_requested" ? "other" : normalized.reason,
          });
        },
      });
    };
    registerHandoffOfferTool("conversation.offer_handoff");
    // Older customer-service versions may still request the legacy capability.
    // Keep the name registered, but route it through the consent-gated offer.
    registerHandoffOfferTool("conversation.request_human");
  }
  if (integrationTools) registerIntegrationTools(tools, integrationTools);
  return tools;
}

/** Add the media harness surface to every hosted run after installation policy is resolved. */
export function addAgentMediaHarnessTools(allowedTools: Set<string>): void {
  for (const toolName of AGENT_MEDIA_HARNESS_TOOLS) allowedTools.add(toolName);
}

const approvalPreviewKeys = new Set([
  "postId",
  "platform",
  "scheduledFor",
  "conversationId",
  "contactId",
  "bookingId",
  "campaignId",
  "channelType",
  "externalConversationId",
  "templateName",
  "action",
  "batchId",
]);

const contentPreviewCapabilities = new Set([
  "kasitek.core.content_post_publish",
  "kasitek.core.content_post_publish_batch",
  "kasitek.core.content_post_schedule",
  "kasitek.core.content_post_unschedule",
  "kasitek.core.content_post_delete",
  "kasitek.core.content_post_delete_published",
]);

const batchPreviewCapabilities = new Set([
  "kasitek.core.content_post_publish_batch_retry",
]);

const campaignPreviewCapabilities = new Set([
  "kasitek.core.campaign_launch",
  "kasitek.core.campaign_pause",
  "kasitek.core.campaign_resume",
  "kasitek.core.campaign_cancel",
  "kasitek.core.campaign_delete",
]);

const bookingPreviewCapabilities = new Set([
  "kasitek.core.booking_create",
  "kasitek.core.booking_update",
  "kasitek.core.booking_cancel",
]);

const channelPreviewCapabilities = new Set(["kasitek.core.channel_deliver"]);

function boundedPreviewString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function durableDeliveryTextPreview(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[link]")
    .trim()
    .slice(0, 1_000);
}

function projectContentMediaForAgent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const media = value as Record<string, unknown>;
  const assetId = boundedPreviewString(media.assetId ?? media.asset_id, 160);
  const kind = boundedPreviewString(media.kind, 40)?.toLowerCase();
  const fileName = boundedPreviewString(media.fileName ?? media.file_name, 240);
  const previewUrl = boundedPreviewString(media.previewUrl ?? media.preview_url, 2_048);
  const processingStatus = boundedPreviewString(media.processingStatus ?? media.processing_status, 40);
  const scanStatus = boundedPreviewString(media.scanStatus ?? media.scan_status, 40);
  if (!assetId && !kind && !fileName) return null;
  return {
    ...(assetId ? { assetId } : {}),
    ...(kind ? { kind } : {}),
    ...(fileName ? { fileName } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(processingStatus ? { processingStatus } : {}),
    ...(scanStatus ? { scanStatus } : {}),
  };
}

/** Keep content tool results useful to the model without replaying provider metadata into every turn. */
function projectContentPostForAgent(post: CoreContentPost): Record<string, unknown> {
  const variants = Array.isArray(post.variants)
    ? post.variants.map(projectContentVariant).filter((value): value is Record<string, unknown> => Boolean(value)).slice(0, 20)
    : [];
  const media = Array.isArray(post.media)
    ? post.media.map(projectContentMediaForAgent).filter((value): value is Record<string, unknown> => Boolean(value)).slice(0, 10)
    : [];
  const content = boundedPreviewString(post.content, 4_000) ?? "";
  return {
    id: boundedPreviewString(post.id, 160) ?? "",
    ...(boundedPreviewString(post.title, 240) ? { title: boundedPreviewString(post.title, 240) } : {}),
    content,
    status: boundedPreviewString(post.status, 40) ?? "UNKNOWN",
    channels: Array.isArray(post.channels)
      ? post.channels.filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 80)).slice(0, 20)
      : [],
    ...(boundedPreviewString(post.scheduled_for, 64) ? { scheduledFor: boundedPreviewString(post.scheduled_for, 64) } : {}),
    ...(boundedPreviewString(post.published_at, 64) ? { publishedAt: boundedPreviewString(post.published_at, 64) } : {}),
    ...(variants.length ? { variants } : {}),
    ...(media.length ? { media } : {}),
  };
}

function projectContentPostsForAgent(response: CoreContentPosts): Record<string, unknown> {
  return {
    posts: Array.isArray(response.posts) ? response.posts.map(projectContentPostForAgent).slice(0, 100) : [],
  };
}

function projectContentWriteResult(
  response: { post: CoreContentPost },
  operation: "draft_created" | "draft_updated",
  channelSelections?: Record<string, string>,
): Record<string, unknown> {
  return {
    operation,
    completed: true,
    post: projectContentPostForAgent(response.post),
    ...(channelSelections && Object.keys(channelSelections).length ? { selectedAccounts: channelSelections } : {}),
  };
}

function projectWorkspaceConnectionsForAgent(response: CoreWorkspaceConnections): Record<string, unknown> {
  return {
    organizationId: response.organizationId,
    connections: Array.isArray(response.connections)
      ? response.connections.map((connection) => {
        const capabilities = Array.isArray(connection.capabilities)
          ? connection.capabilities.map((capability) => {
            if (typeof capability === "string") return capability;
            if (!capability || typeof capability !== "object" || Array.isArray(capability)) return undefined;
            const key = (capability as Record<string, unknown>).key;
            const enabled = (capability as Record<string, unknown>).enabled;
            return typeof key === "string" && enabled !== false ? key : undefined;
          }).filter((value): value is string => Boolean(value)).slice(0, 30)
          : [];
        const consumers = Array.isArray(connection.consumers)
          ? connection.consumers.filter((value): value is string => typeof value === "string").slice(0, 20)
          : [];
        return {
          provider: connection.provider,
          displayName: connection.displayName,
          ...(connection.handle ? { handle: connection.handle } : {}),
          status: connection.status,
          credentialStatus: connection.credentialStatus,
          healthStatus: connection.healthStatus,
          webhookStatus: connection.webhookStatus,
          ...(connection.lastCheckedAt ? { lastCheckedAt: connection.lastCheckedAt } : {}),
          ...(capabilities.length ? { capabilities } : {}),
          ...(consumers.length ? { consumers } : {}),
        };
      }).slice(0, 200)
      : [],
  };
}

function projectContentVariant(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const variant = value as Record<string, unknown>;
  const platform = boundedPreviewString(variant.platform, 80);
  const content = boundedPreviewString(variant.content, 2_000);
  if (!platform && !content) return null;
  return {
    ...(platform ? { platform } : {}),
    ...(content ? { contentPreview: content } : {}),
    ...(boundedPreviewString(variant.status, 40) ? { status: boundedPreviewString(variant.status, 40) } : {}),
  };
}

/** Project only the fields an authenticated approver needs to understand a content effect. */
export function projectContentApprovalResource(post: CoreContentPost, preflight?: CoreContentPublishBatchPreflight): Record<string, unknown> {
  const variants = Array.isArray(post.variants)
    ? post.variants.map(projectContentVariant).filter((value): value is Record<string, unknown> => Boolean(value)).slice(0, 20)
    : [];
  return {
    postId: boundedPreviewString(post.id, 160) ?? "",
    ...(boundedPreviewString(post.title, 240) ? { title: boundedPreviewString(post.title, 240) } : {}),
    status: boundedPreviewString(post.status, 40) ?? "UNKNOWN",
    ...(boundedPreviewString(post.content, 2_000) ? { contentPreview: boundedPreviewString(post.content, 2_000) } : {}),
    channels: Array.isArray(post.channels) ? post.channels.filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 80)).slice(0, 20) : [],
    ...(boundedPreviewString(post.scheduled_for, 64) ? { scheduledFor: boundedPreviewString(post.scheduled_for, 64) } : {}),
    ...(boundedPreviewString(post.published_at, 64) ? { publishedAt: boundedPreviewString(post.published_at, 64) } : {}),
    ...(variants.length ? { variants } : {}),
    ...(Array.isArray(post.media) && post.media.length ? { mediaCount: post.media.length } : {}),
    ...(preflight ? {
      batchPreflight: {
        status: boundedPreviewString(preflight.status, 40) ?? "UNKNOWN",
        snapshotHash: boundedPreviewString(preflight.snapshotHash, 128) ?? "",
        targets: Array.isArray(preflight.targets)
          ? preflight.targets.map((target) => ({
            platform: boundedPreviewString(target.platform, 80) ?? "UNKNOWN",
            accountName: boundedPreviewString(target.accountName, 160) ?? "Connected account",
            ...(boundedPreviewString(target.handle, 160) ? { handle: boundedPreviewString(target.handle, 160) } : {}),
            state: boundedPreviewString(target.state, 40) ?? "UNKNOWN",
            status: boundedPreviewString(target.status, 40) ?? "UNKNOWN",
            remediationMode: boundedPreviewString(target.remediationMode, 40) ?? "REVIEW",
            ...(boundedPreviewString(target.reasonCode, 80) ? { reasonCode: boundedPreviewString(target.reasonCode, 80) } : {}),
            ...(boundedPreviewString(target.message, 240) ? { message: boundedPreviewString(target.message, 240) } : {}),
          })).slice(0, 20)
          : [],
      },
    } : {}),
  };
}

function projectContentBatchApprovalResource(batch: CoreContentPublishBatch): Record<string, unknown> {
  return {
    batchId: boundedPreviewString(batch.batchId, 160) ?? "",
    postId: boundedPreviewString(batch.postId, 160) ?? "",
    status: boundedPreviewString(batch.status, 40) ?? "UNKNOWN",
    snapshotHash: boundedPreviewString(batch.snapshotHash, 128) ?? "",
    targetCount: batch.targetCount,
    publishedCount: batch.publishedCount,
    failedCount: batch.failedCount,
    unknownCount: batch.unknownCount,
    targets: Array.isArray(batch.targets)
      ? batch.targets.map((target) => ({
        platform: boundedPreviewString(target.platform, 80) ?? "UNKNOWN",
        accountName: boundedPreviewString(target.accountName, 160) ?? "Connected account",
        ...(boundedPreviewString(target.handle, 160) ? { handle: boundedPreviewString(target.handle, 160) } : {}),
        state: boundedPreviewString(target.state, 40) ?? "UNKNOWN",
        remediationMode: boundedPreviewString(target.remediationMode, 40) ?? "REVIEW",
        ...(boundedPreviewString(target.reasonCode, 80) ? { reasonCode: boundedPreviewString(target.reasonCode, 80) } : {}),
        ...(boundedPreviewString(target.message, 240) ? { message: boundedPreviewString(target.message, 240) } : {}),
      })).slice(0, 20)
      : [],
  };
}

/**
 * Describe the requested state transition separately from the read projection.
 * Keeping the operation in the immutable preview makes an approval legible
 * without exposing provider payloads or relying on the model to infer the
 * effect from a capability name.
 */
export function projectContentApprovalOperation(
  capability: string,
  argumentsValue: Record<string, unknown>,
  post: CoreContentPost,
  preflight?: CoreContentPublishBatchPreflight,
): Record<string, unknown> {
  const postId = boundedPreviewString(post.id, 160) ?? "";
  const fromStatus = boundedPreviewString(post.status, 40) ?? "UNKNOWN";
  switch (capability) {
    case "kasitek.core.content_post_publish":
      return {
        type: "publish",
        postId,
        fromStatus,
        ...(boundedPreviewString(argumentsValue.platform, 80) ? { platform: boundedPreviewString(argumentsValue.platform, 80) } : {}),
        targetStatus: "PUBLISHED",
      };
    case "kasitek.core.content_post_publish_batch":
      return {
        type: "publish_batch",
        postId,
        fromStatus,
        targetStatus: "PROCESSING",
        targetCount: Array.isArray(preflight?.targets) ? preflight!.targets.length : post.channels.length,
        preflightStatus: boundedPreviewString(preflight?.status, 40) ?? "UNKNOWN",
        ...(boundedPreviewString(preflight?.snapshotHash, 128) ? { snapshotHash: boundedPreviewString(preflight?.snapshotHash, 128) } : {}),
      };
    case "kasitek.core.content_post_schedule":
      return {
        type: "schedule",
        postId,
        fromStatus,
        ...(boundedPreviewString(argumentsValue.scheduledFor, 64) ? { scheduledFor: boundedPreviewString(argumentsValue.scheduledFor, 64) } : {}),
        targetStatus: "SCHEDULED",
      };
    case "kasitek.core.content_post_unschedule":
      return {
        type: "unschedule",
        postId,
        fromStatus,
        ...(boundedPreviewString(post.scheduled_for, 64) ? { currentScheduledFor: boundedPreviewString(post.scheduled_for, 64) } : {}),
        targetStatus: "DRAFT",
      };
    case "kasitek.core.content_post_delete":
      return {
        type: "delete",
        postId,
        fromStatus,
        targetStatus: "DELETED",
      };
    case "kasitek.core.content_post_delete_published":
      return {
        type: "delete_published",
        postId,
        fromStatus,
        ...(boundedPreviewString(argumentsValue.platform, 80) ? { platform: boundedPreviewString(argumentsValue.platform, 80) } : {}),
        targetStatus: "DELETED_FROM_PLATFORMS",
      };
    default:
      return { type: "unknown", postId, fromStatus };
  }
}

/**
 * Build the immutable, safe portion of an approval preview. Provider payloads,
 * credentials, and arbitrary metadata never enter the approval record; the
 * exact arguments hash still binds the eventual effect. A domain adapter may
 * provide a read projection captured at proposal time.
 */
export function buildApprovalResourceSnapshot(capability: string, argumentsValue: Record<string, unknown>, resource?: Record<string, unknown>): Record<string, unknown> {
  const request = Object.fromEntries(
    Object.entries(argumentsValue)
      .filter(([key, value]) => approvalPreviewKeys.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 256) : value]),
  );
  return {
    capability,
    request,
    ...(resource ? { resource } : {}),
  };
}

/** Read the current resource once, at proposal time, so approval is bound to what was reviewed. */
export async function buildApprovalResourceSnapshotFromCore(
  coreClient: KasitekCoreReadClient | undefined,
  context: ToolInvocationContext,
  capability: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (contentPreviewCapabilities.has(capability) && (!coreClient || typeof argumentsValue.postId !== "string")) {
    throw new Error("CONTENT_PREVIEW_UNAVAILABLE");
  }
  if (batchPreviewCapabilities.has(capability) && (!coreClient || typeof argumentsValue.batchId !== "string")) {
    throw new Error("CONTENT_BATCH_PREVIEW_UNAVAILABLE");
  }
  if (campaignPreviewCapabilities.has(capability) && (!coreClient || typeof argumentsValue.campaignId !== "string")) {
    throw new Error("CAMPAIGN_PREVIEW_UNAVAILABLE");
  }
  if (bookingPreviewCapabilities.has(capability) && capability !== "kasitek.core.booking_create" && (!coreClient || typeof argumentsValue.bookingId !== "string")) {
    throw new Error("BOOKING_PREVIEW_UNAVAILABLE");
  }
  if (channelPreviewCapabilities.has(capability)) {
    return buildDomainApprovalSnapshot(capability, argumentsValue);
  }
  if (batchPreviewCapabilities.has(capability)) {
    try {
      const response = await coreClient!.getContentPublishBatch(context, argumentsValue.batchId as string);
      const resource = projectContentBatchApprovalResource(response);
      return buildApprovalResourceSnapshot(capability, argumentsValue, {
        kind: "content_publish_batch",
        revision: "content-publish-batch.v1",
        ...resource,
        operation: { type: "retry_failed_targets", batchId: resource.batchId, targetStatus: "PROCESSING" },
      });
    } catch {
      throw new Error("CONTENT_BATCH_PREVIEW_UNAVAILABLE");
    }
  }
  if (!contentPreviewCapabilities.has(capability) && !campaignPreviewCapabilities.has(capability) && !bookingPreviewCapabilities.has(capability)) {
    return capability.startsWith("kasitek.core.") ? buildDomainApprovalSnapshot(capability, argumentsValue) : buildApprovalResourceSnapshot(capability, argumentsValue);
  }
  try {
    if (contentPreviewCapabilities.has(capability)) {
      const response = await coreClient!.getContentPost(context, argumentsValue.postId as string);
      const preflight = capability === "kasitek.core.content_post_publish_batch"
        ? await coreClient!.preflightContentPublishBatch(context, argumentsValue.postId as string)
        : undefined;
      const resource = projectContentApprovalResource(response.post, preflight);
      return buildApprovalResourceSnapshot(capability, argumentsValue, { kind: "content_post", revision: "content-post.v1", ...resource, operation: projectContentApprovalOperation(capability, argumentsValue, response.post, preflight) });
    }
    if (campaignPreviewCapabilities.has(capability)) {
      const response = await coreClient!.getCampaignSummary(context, argumentsValue.campaignId as string);
      const resource = projectCampaignApprovalResource(response.campaign);
      return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "campaign", revision: "campaign.v1", ...resource });
    }
    if (capability !== "kasitek.core.booking_create") {
      const response = await coreClient!.getBooking(context, argumentsValue.bookingId as string);
      const resource = projectBookingApprovalResource(response.booking);
      return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "booking", revision: "booking.v1", ...resource });
    }
    return buildDomainApprovalSnapshot(capability, argumentsValue, { kind: "booking", revision: "booking.v1", status: "NEW" });
  } catch {
    // A missing/unavailable preview must never turn into an unreviewed effect.
    throw new Error(contentPreviewCapabilities.has(capability) ? "CONTENT_PREVIEW_UNAVAILABLE" : campaignPreviewCapabilities.has(capability) ? "CAMPAIGN_PREVIEW_UNAVAILABLE" : "BOOKING_PREVIEW_UNAVAILABLE");
  }
}

function restrictiveLimit(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : undefined;
}

function currentActivitySignal(): AbortSignal | undefined {
  try {
    return cancellationSignal();
  } catch {
    return undefined;
  }
}

function activityHeartbeat(details: Record<string, unknown>): void {
  try {
    heartbeat(details);
  } catch {
    // Direct activity tests do not have a Temporal context.
  }
}

async function withActivityHeartbeat<T>(details: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
  activityHeartbeat(details);
  const timer = setInterval(() => activityHeartbeat(details), 5_000);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

async function assertCurrentCapabilityPolicy(input: {
  organizationId: string;
  installationId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  grantedTools: ReadonlySet<string>;
  tools: ToolRegistry;
  installationGrants: InstallationGrantRepository;
  approved: boolean;
}): Promise<void> {
  await authorizeInstallationCapability(input);
}

export function createActivities(pool: Pool, options: ActivityOptions = {}): AgentRunActivities {
  const runs = new RunRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const runBudgets = new RunBudgetRepository(pool);
  const conversations = new ConversationRepository(pool);
  const memory = new MemoryRepository(pool);
  const knowledge = new KnowledgeRepository(pool);
  const skills = options.skills ?? new SkillRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const runSteps = new RunStepRepository(pool);
  const toolGrants = new ToolGrantRepository(pool);
  const summaries = new SummaryRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const controls = new OperatorControlRepository(pool);
  const channels = new ChannelRepository(pool);
  const deliveryObligations = new PostgresDeliveryObligationCoordinator(pool);
  const channelCredentials = options.config ? new ChannelCredentialRepository(pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY) : undefined;
  const kasiaiPreferences = new KasiAiPreferenceRepository(pool);
  const effectReceipts = new EffectReceiptRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const installationGrants = new InstallationGrantRepository(pool);
  const workflowState = new WorkflowStateRepository(pool);
  const workflowCheckpoints = new WorkflowCheckpointRepository(pool);
  const modelPricing = pricingFromConfig(options.config);
  const creditPricing = creditPricingFromConfig(options.config);
  const creditBillingMode = options.config?.CREDIT_BILLING_MODE ?? "disabled";
  const gateway = options.gateway ?? new ModelGateway(undefined, { pricing: modelPricing });
  const credentials = options.credentials ?? (options.config
    ? new VaultCredentialResolver(new CredentialVaultRepository(pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY))
    : new EnvironmentCredentialResolver());
  const coreClient = options.coreClient ?? (options.config ? new KasitekCoreReadClient(options.config) : undefined);
  const hostCapabilities = options.harness?.host ?? options.hostCapabilities ?? new HostCapabilityRouter([
    ...(coreClient ? [new CoreHostAdapter(coreClient)] : []),
    new NativeHostAdapter(),
  ]);
  const telegramClient = options.telegramClient ?? (options.config ? new TelegramBotClient({ apiBaseUrl: options.config.TELEGRAM_API_BASE_URL, timeoutMs: options.config.TELEGRAM_API_TIMEOUT_MS }) : undefined);
  const discordClient = options.discordClient ?? (options.config ? new DiscordBotClient({ apiBaseUrl: options.config.DISCORD_API_BASE_URL, timeoutMs: options.config.DISCORD_API_TIMEOUT_MS }) : undefined);
  const conversationActions = options.conversationActions ?? new ConversationActionService(new HandoffRepository(pool), controls);
  const handoffs = new HandoffRepository(pool);
  const integrationRepository = options.config ? new IntegrationRepository(pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY) : undefined;
  const remoteMcpProviders = options.remoteMcpProviders ?? new RemoteMcpProviderRepository(pool, integrationRepository ? (organizationId, credentialReference) => integrationRepository.resolveCredential(organizationId, credentialReference) : undefined);
  const integrationTools = options.integrationTools ?? (integrationRepository ? new IntegrationToolService(integrationRepository, options.config) : undefined);
  const tools = options.harness?.tools ?? options.tools ?? createDefaultTools(coreClient, conversationActions, integrationTools, memory, hostCapabilities);
  const harness = options.harness ?? createAgentHarness({
    tools,
    host: hostCapabilities,
    capabilities: createCapabilityRuntime({
      registry: tools,
      admission: {
        admit: async ({ request }) => {
          await authorizeInstallationCapability({
            organizationId: request.context.organizationId,
            installationId: request.context.installationId,
            name: request.name,
            argumentsValue: request.arguments,
            grantedTools: request.grantedTools,
            tools,
            installationGrants,
            approved: Boolean(request.approval),
          });
          return { status: "ready" };
        },
      },
    }),
  });
  const activities: AgentRunActivities = {
    async transitionRun(input) {
      await runs.transitionRun(input.runId, input.expectedStatus, input.nextStatus);
    },
    async executeLoop(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      if (isMcpToolRun(run.input)) {
        return executeMcpToolRun(
          run,
          input.resumeApprovedToolCall,
          runs,
          runBudgets,
          toolInvocations,
          approvals,
          effectReceipts,
          runSteps,
          toolGrants,
          installationGrants,
          killSwitches,
          controls,
          tools,
          coreClient,
        );
      }
      return executeLoopForRun(run, input.resumeApprovedToolCall, input.resumeExternalEvent, input.loopStep, runs, modelCalls, runBudgets, conversations, memory, knowledge, skills, remoteMcpProviders, toolInvocations, approvals, effectReceipts, runSteps, toolGrants, installationGrants, summaries, killSwitches, controls, kasiaiPreferences, gateway, credentials, tools, harness, workflowState, workflowCheckpoints, modelPricing, creditPricing, creditBillingMode, coreClient, conversationActions, options.config?.TEMPORAL_STEP_ACTIVITIES_ENABLED === true);
    },
    async getContentPublishBatchStatus(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run || !coreClient) return { status: "UNAVAILABLE" };
      try {
        const batch = await coreClient.getContentPublishBatch(toolInvocationContextFromScope(executionScopeFromRun(run)), input.batchId);
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "content.publish_batch.status_observed",
          payload: { batchId: input.batchId, status: batch.status },
        });
        return { status: batch.status, batch: batch as unknown as Record<string, unknown> };
      } catch (error) {
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "content.publish_batch.status_observation_failed",
          payload: {
            batchId: input.batchId,
            errorCode: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "BATCH_STATUS_UNAVAILABLE") : "BATCH_STATUS_UNAVAILABLE",
          },
        });
        return { status: "UNAVAILABLE" };
      }
    },
    async pauseRun(input) {
      await runs.pauseRun(input.runId, input.status, input.output);
    },
    async deliverApprovalPrompt(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      const target = await channels.getApprovalPromptTarget(run.id);
      if (!target) {
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.approval.prompt_skipped",
          payload: { reason: "no_owner_channel" },
        });
        return;
      }
      const approval = await approvals.getForRun(run.organization_id, run.id);
      const secret = options.config?.INTERNAL_AUTH_SECRET?.trim();
      if (!approval || approval.status !== "pending" || !secret) {
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.approval.prompt_skipped",
          payload: { reason: !secret ? "approval_signing_not_configured" : "approval_not_pending" },
        });
        return;
      }
      const approve = createChannelApprovalActionToken({
        approvalId: approval.id,
        organizationId: target.organization_id,
        installationId: target.installation_id,
        runId: target.run_id,
        providerToolCallId: approval.provider_tool_call_id,
        argumentsHash: approval.arguments_hash,
        bindingId: target.binding_id,
        channelType: target.channel_type,
        externalIdentity: target.external_identity,
        externalConversationId: target.external_conversation_id,
        decision: "approved",
        expiresAt: approval.expires_at,
      }, secret);
      const reject = createChannelApprovalActionToken({
        approvalId: approval.id,
        organizationId: target.organization_id,
        installationId: target.installation_id,
        runId: target.run_id,
        providerToolCallId: approval.provider_tool_call_id,
        argumentsHash: approval.arguments_hash,
        bindingId: target.binding_id,
        channelType: target.channel_type,
        externalIdentity: target.external_identity,
        externalConversationId: target.external_conversation_id,
        decision: "rejected",
        expiresAt: approval.expires_at,
      }, secret);
      const prompt = buildChannelApprovalPrompt(approval.capability, approval.resource_snapshot);
      try {
        if (target.channel_type === "telegram") {
          if (!channelCredentials || !telegramClient || !target.credential_reference) throw new Error("Telegram approval prompt is not configured");
          const token = await channelCredentials.resolve(target.organization_id, target.credential_reference, "telegram");
          await telegramClient.sendApprovalPrompt(token, target.external_conversation_id, prompt, { approve, reject });
        } else if (target.channel_type === "discord") {
          if (!channelCredentials || !discordClient || !target.credential_reference) throw new Error("Discord approval prompt is not configured");
          const token = await channelCredentials.resolve(target.organization_id, target.credential_reference, "discord");
          await discordClient.sendApprovalPrompt(token, target.external_conversation_id, prompt, { approve, reject });
        } else if (target.channel_type === "whatsapp") {
          if (!coreClient) throw new Error("WhatsApp approval prompt boundary is not configured");
          await coreClient.deliverChannelMessage({
            organizationId: target.organization_id,
            installationId: target.installation_id,
            actorId: target.owner_actor_id,
            runId: target.run_id,
            correlationId: run.correlation_id,
            channelType: "whatsapp",
            externalConversationId: target.external_conversation_id,
            text: prompt,
            buttons: [{ id: approve, title: "Approve" }, { id: reject, title: "Deny" }],
          });
        } else {
          throw new Error(`Unsupported approval prompt channel: ${target.channel_type}`);
        }
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.approval.prompt_delivered",
          payload: { channelType: target.channel_type, bindingId: target.binding_id },
        });
      } catch (error) {
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.approval.prompt_failed",
          payload: { channelType: target.channel_type, error: error instanceof Error ? error.message : "approval_prompt_failed" },
        });
      }
    },
    async cancelPendingApproval(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      await approvals.cancel(run.organization_id, run.id, input.providerToolCallId);
      await effectReceipts.markNotExecuted(run.organization_id, run.id, input.providerToolCallId, {
        code: "RUN_CANCELLED",
        message: input.reason ?? "The run was cancelled before the approved effect began",
      });
      await runs.appendEvent({
        organizationId: run.organization_id,
        runId: run.id,
        installationId: run.installation_id,
        eventType: input.outcome === "expired" ? "agent.approval.expired" : "agent.approval.cancelled",
        payload: { providerToolCallId: input.providerToolCallId },
      });
    },
    async cancelHandoff(input) {
      const run = await runs.getRunById(input.runId);
      if (!run) throw new Error("Run not found");
      await handoffs.cancelForRun({
        organizationId: run.organization_id,
        runId: run.id,
        actorId: run.created_by,
        reason: input.reason,
      });
    },
    async completeRun(input) {
      const completed = await runs.completeRun(input.runId, input.output);
      if (completed.conversation_id) {
        try {
          const messages = await conversations.listMessages(completed.organization_id, completed.conversation_id);
          await summaries.rebuildFromMessages({
            organizationId: completed.organization_id,
            conversationId: completed.conversation_id,
            messages,
          });
        } catch (error) {
          await runs.appendEvent({
            organizationId: completed.organization_id,
            runId: completed.id,
            installationId: completed.installation_id,
            eventType: "agent.summary.failed",
            payload: { message: error instanceof Error ? error.message : "Conversation summary failed" },
          });
        }
      }
    },
    async generateConversationTitle(input) {
      try {
        const run = await runs.getRuntimeRunById(input.runId);
        if (!run?.conversation_id) return;
        const candidate = await conversations.getTitleCandidate(run.organization_id, run.conversation_id);
        if (!candidate || candidate.title_locked || candidate.title_source !== "fallback" || !candidate.first_message) return;
        const configuration = run.configuration;
        const target = resolveModelTarget(configuration, run.policy);
        const isKasiAiInstallation = run.execution_mode === "system_hosted"
          && run.agent_owner_type === "system"
          && run.agent_protected === true
          && run.agent_slug === "kasiai";
        const preference = isKasiAiInstallation
          ? await kasiaiPreferences.get(run.organization_id, run.installation_id, run.created_by)
          : null;
        const provider = (run.resolved_model_provider ?? target.provider) as typeof target.provider;
        const model = run.resolved_model ?? target.model;
        const credentialReference = isKasiAiInstallation && typeof preference?.default_credential_reference === "string"
          ? preference.default_credential_reference
          : typeof configuration.credentialReference === "string"
          ? configuration.credentialReference
          : target.credentialReference;
        const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
        const response = await gateway.complete({
          provider,
          model,
          temperature: 0,
          maxTokens: 24,
          timeoutMs: 12_000,
          maxAttempts: 1,
          messages: [
            { role: "system", content: "Create a concise 3 to 7 word chat title. Return only the title, no quotes, punctuation, Markdown, or explanation." },
            { role: "user", content: candidate.first_message.slice(0, 1_000) },
          ],
        }, modelCredentials);
        const title = response.message.content
          .replace(/[\r\n]+/g, " ")
          .replace(/^[-#*\s\"']+|[-#*\s\"']+$/g, "")
          .trim()
          .slice(0, 120);
        if (!title || /^(?:hi|hello|hey|yo|new chat)(?:[!,.?\s]+)?$/i.test(title)) return;
        const updated = await conversations.setGeneratedTitle({
          organizationId: run.organization_id,
          conversationId: run.conversation_id,
          title,
        });
        if (updated) {
          await runs.appendEvent({
            organizationId: run.organization_id,
            runId: run.id,
            installationId: run.installation_id,
            eventType: "conversation.title.generated",
            payload: { conversationId: run.conversation_id },
          });
        }
      } catch (error) {
        // A conversation title is decorative metadata. Never fail or retry the
        // completed user run because a provider cannot generate one.
        void error;
      }
    },
    async deliverRunReply(input) {
      const pending = await channels.getRunReplyDelivery(input.runId);
      if (!pending) return;
      if (await controls.isHeld({ organizationId: pending.organization_id, installationId: pending.installation_id, runId: pending.run_id, holdType: "delivery" })) {
        throw new Error("AGENT_DELIVERY_HOLD_ACTIVE");
      }
      const response = parseAgentResponse(pending.content);
      const channelType = pending.channel_type.trim().toLowerCase();
      const mediaProfile = channelMediaProfile(channelType);
      const coreMediaChannel = channelType === "whatsapp" || channelType === "website";
      const linkChannel = channelType === "telegram" || channelType === "discord";
      const nativeMedia = response.media.filter((item) => mediaProfile.nativeKinds.has(item.kind));
      const fallbackMedia = response.media.filter((item) => !mediaProfile.nativeKinds.has(item.kind));
      const resolvedMedia: ResolvedAgentMedia[] = [];
      let mediaResolutionFailures = 0;
      if (response.media.length && coreClient && (linkChannel || fallbackMedia.length)) {
        for (const item of (linkChannel ? response.media : fallbackMedia)) {
          try {
            const preview = await coreClient.getContentMediaPreview({
              organizationId: pending.organization_id,
              installationId: pending.installation_id,
              actorId: pending.actor_id,
              runId: pending.run_id,
              correlationId: pending.correlation_id,
            }, item.assetId);
            resolvedMedia.push({ assetId: item.assetId, kind: item.kind, fileName: preview.asset.fileName, previewUrl: preview.previewUrl });
          } catch {
            mediaResolutionFailures += 1;
          }
        }
      }
      if (mediaResolutionFailures > 0) {
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.media_resolution_failed",
          payload: { channelType, mediaResolutionFailures },
        });
      }
      const deliveryMedia = resolvedMedia.filter((item) => mediaProfile.nativeKinds.has(item.kind));
      const resolutionCandidates = (linkChannel ? response.media : fallbackMedia).map((item) => item.assetId);
      const mediaText = buildChannelMediaText(response, mediaProfile, resolvedMedia, resolutionCandidates).trim();
      const uiText = buildChannelUiFallback(response.ui, channelType, options.config?.KASITEK_APP_URL);
      const text = [mediaText, uiText].filter(Boolean).join("\n\n").trim()
        || (!coreMediaChannel && response.media.length ? "Attachment" : "");
      const uiNavigationButtons = channelUiNavigationButtons(response.ui, channelType, options.config?.KASITEK_APP_URL);
      if (!text && !response.media.length) throw new Error("External channel reply has no text or media content");
      const externalText = response.authorizationRequired
        ? authorizationRemediationText(text, response.authorizationRequired, options.config?.KASITEK_APP_URL)
        : text;
      const deliveryStep = await runSteps.startStep({
        runId: pending.run_id,
        organizationId: pending.organization_id,
        stepType: "delivery",
        input: { preview: buildDomainApprovalSnapshot("kasitek.core.channel_deliver", { channelType, externalConversationId: pending.external_conversation_id, text: durableDeliveryTextPreview(response.text || (response.media.length ? "[media attachment]" : "")), media: response.media.map((item) => ({ assetId: item.assetId, kind: item.kind })) }) },
      });
      let claimed = false;
      const obligation = await deliveryObligations.create({
        id: pending.attempt_id,
        idempotencyKey: `channel:${pending.attempt_id}`,
        scope: {
          organizationId: pending.organization_id,
          installationId: pending.installation_id,
          runId: pending.run_id,
          conversationId: pending.conversation_id,
          correlationId: pending.correlation_id,
        },
        channel: channelType,
        payloadRef: pending.message_id,
      });
      const obligationClaimId = `channel-delivery:${pending.attempt_id}`;
      try {
        await channels.claimDelivery(pending.organization_id, pending.attempt_id);
        const claim = await deliveryObligations.claim({ obligationId: obligation.id, claimId: obligationClaimId, workerId: "temporal:agent-delivery" });
        if (claim.status !== "applied" && claim.status !== "idempotent") throw new Error(`DELIVERY_OBLIGATION_${claim.status.toUpperCase()}`);
        claimed = true;
        const result = channelType === "telegram"
          ? await (async () => {
            if (!channelCredentials || !telegramClient || !pending.credential_reference) throw new Error("Telegram channel delivery is not configured");
            const token = await channelCredentials.resolve(pending.organization_id, pending.credential_reference, "telegram");
            return telegramClient.sendMediaResponse(token, pending.external_conversation_id, externalText, deliveryMedia, uiNavigationButtons.length
              ? { inlineButtons: [uiNavigationButtons.map((button) => ({ text: button.label, url: button.url }))] }
              : {});
          })()
          : channelType === "discord"
          ? await (async () => {
            if (!channelCredentials || !discordClient || !pending.credential_reference) throw new Error("Discord channel delivery is not configured");
            const token = await channelCredentials.resolve(pending.organization_id, pending.credential_reference, "discord");
            return discordClient.sendMediaResponse(token, pending.external_conversation_id, externalText, deliveryMedia, uiNavigationButtons.length
              ? { buttons: uiNavigationButtons.map((button) => ({ label: button.label, url: button.url })) }
              : {});
          })()
          : await (async () => {
            if (!coreClient) throw new Error("kasitek-core channel delivery boundary is not configured");
            return coreClient.deliverChannelMessage({
              organizationId: pending.organization_id,
              installationId: pending.installation_id,
              actorId: pending.actor_id,
              runId: pending.run_id,
              correlationId: pending.correlation_id,
              channelType,
              externalConversationId: pending.external_conversation_id,
              text: externalText,
              ...(coreMediaChannel && nativeMedia.length ? { media: nativeMedia } : {}),
              ...(channelType === "website" && response.ui ? { ui: response.ui } : {}),
            });
          })();
        if (result.status === "unknown") throw new Error("CHANNEL_DELIVERY_UNKNOWN");
        await channels.markDelivered({
          organizationId: pending.organization_id,
          attemptId: pending.attempt_id,
          providerMessageId: result.providerMessageId,
        });
        const completion = await deliveryObligations.complete({ obligationId: obligation.id, claimId: obligationClaimId, receiptRef: result.providerMessageId ?? pending.attempt_id });
        if (completion.status !== "applied" && completion.status !== "idempotent") throw new Error(`DELIVERY_OBLIGATION_${completion.status.toUpperCase()}`);
        await runSteps.finishStep({ stepId: deliveryStep.id, status: "completed", output: { status: result.status } });
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivered",
          payload: { channelType, status: result.status, mediaCount: response.media.length, resolvedMediaCount: resolvedMedia.length, mediaResolutionFailures, mediaKinds: [...new Set(response.media.map((item) => item.kind))], ...(response.authorizationRequired ? { authorizationRequired: response.authorizationRequired } : {}) },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Channel delivery failed";
        const deliveryOutcomeUnknown = reason === "CHANNEL_DELIVERY_UNKNOWN" || reason.includes("UNKNOWN");
        if (deliveryOutcomeUnknown) {
          await deliveryObligations.unknown({ obligationId: obligation.id, claimId: claimed ? obligationClaimId : undefined, reason }).catch(() => undefined);
        } else {
          await deliveryObligations.fail({ obligationId: obligation.id, claimId: claimed ? obligationClaimId : undefined, reason }).catch(() => undefined);
        }
        if (claimed) {
          const deliveryError = {
            code: deliveryOutcomeUnknown ? "CHANNEL_DELIVERY_UNKNOWN" : "CHANNEL_DELIVERY_FAILED",
            message: reason,
          };
          if (deliveryOutcomeUnknown) {
            await channels.markDeliveryUnknown({
              organizationId: pending.organization_id,
              attemptId: pending.attempt_id,
              error: deliveryError,
            });
          } else {
            await channels.markDeliveryFailed({
              organizationId: pending.organization_id,
              attemptId: pending.attempt_id,
              error: deliveryError,
            });
          }
        }
        await runSteps.finishStep({ stepId: deliveryStep.id, status: "failed", error: { code: "CHANNEL_DELIVERY_FAILED", message: error instanceof Error ? error.message : "Channel delivery failed" } });
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivery_failed",
          payload: { channelType, mediaCount: response.media.length, resolvedMediaCount: resolvedMedia.length, mediaResolutionFailures, mediaKinds: [...new Set(response.media.map((item) => item.kind))], ...(response.authorizationRequired ? { authorizationRequired: response.authorizationRequired } : {}), message: reason },
        });
      }
    },
    async failRun(input) {
      await runs.failRun(input.runId, input.error);
    },
  };
  return Object.fromEntries(Object.entries(activities).map(([name, handler]) => [
    name,
    async (input: unknown) => {
      let attempt = 1;
      try {
        attempt = activityInfo().attempt;
      } catch {
        // Direct activity tests do not have a Temporal context.
      }
      recordTemporalActivityAttempt(name, attempt);
      const scope = input && typeof input === "object" ? input as { organizationId?: unknown; actorId?: unknown } : {};
      const organizationId = typeof scope.organizationId === "string" && scope.organizationId.trim() ? scope.organizationId : undefined;
      const actorId = typeof scope.actorId === "string" && scope.actorId.trim() ? scope.actorId : undefined;
      let databaseContext: DatabaseContext | undefined = organizationId || actorId ? { organizationId, actorId } : undefined;
      const runId = input && typeof input === "object" && typeof (input as { runId?: unknown }).runId === "string"
        ? (input as { runId: string }).runId
        : undefined;
      if (!databaseContext && runId) {
        const run = await runWithRequiredDatabaseContext(
          "temporal-scope-recovery",
          { organizationId: "platform", actorId: "system:temporal-scope-recovery", operator: true },
          () => runs.getRunById(runId),
        );
        if (run) databaseContext = { organizationId: run.organization_id, actorId: run.created_by };
      }
      return runWithRequiredDatabaseContext(
        `temporal.activity.${name}`,
        databaseContext,
        () => withSpan(`temporal.activity.${name}`, { "temporal.activity.name": name, "temporal.activity.attempt": attempt }, () => handler(input as never)),
      );
    },
  ])) as unknown as AgentRunActivities;
}

function isMcpToolRun(input: Record<string, unknown>): input is Record<string, unknown> & { mcpTool: { name: string; arguments: Record<string, unknown>; toolCallId: string } } {
  const tool = input.mcpTool;
  return Boolean(
    tool
      && typeof tool === "object"
      && typeof (tool as Record<string, unknown>).name === "string"
      && typeof (tool as Record<string, unknown>).toolCallId === "string"
      && (tool as Record<string, unknown>).arguments
      && typeof (tool as Record<string, unknown>).arguments === "object"
      && !Array.isArray((tool as Record<string, unknown>).arguments),
  );
}

async function executeMcpToolRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  runs: RunRepository,
  runBudgets: RunBudgetRepository,
  toolInvocations: ToolInvocationRepository,
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  killSwitches: KillSwitchRepository,
  controls: OperatorControlRepository,
  tools: ToolRegistry,
  coreClient: KasitekCoreReadClient | undefined,
) {
  if (!isMcpToolRun(run.input)) throw new Error("Invalid MCP run input");
  const invocation = resumeApprovedToolCall ?? {
    id: run.input.mcpTool.toolCallId,
    name: run.input.mcpTool.name,
    arguments: run.input.mcpTool.arguments,
  };
  const configuration = run.configuration ?? {};
  const installationSettings = run.installation_settings ?? {};
  await runBudgets.ensure(
    { organizationId: run.organization_id, runId: run.id },
    { maxToolCalls: restrictiveLimit(configuration.maxToolCalls, installationSettings.maxToolCalls) ?? 16 },
  );
  const manifest = tools.get(invocation.name);
  if (!manifest) throw new Error(`Tool is not registered: ${invocation.name}`);
  const argumentsHash = hashToolArguments(invocation.arguments);
  const approvalRecord = resumeApprovedToolCall ? await approvals.getForRun(run.organization_id, run.id) : null;
  const resourceSnapshot = resumeApprovedToolCall?.approval.resourceSnapshot
    ?? approvalRecord?.resource_snapshot
    ?? await buildApprovalResourceSnapshotFromCore(coreClient, toolInvocationContextFromScope(executionScopeFromRun(run)), invocation.name, invocation.arguments);
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  // New direct calls must be granted before a proposal is created. Resumed
  // approvals are re-authorized in the guarded path below so revocation closes
  // the reserved effect as unexecuted without reaching the provider.
  if (!resumeApprovedToolCall && !grantedTools.has(invocation.name)) throw new Error(`Tool is not granted: ${invocation.name}`);
  if (!resumeApprovedToolCall && run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");

  let stepId: string | undefined;
  if (!resumeApprovedToolCall) {
    await toolInvocations.recordProposal({
      organizationId: run.organization_id,
      runId: run.id,
      providerToolCallId: invocation.id,
      sequenceNumber: 1,
      toolName: invocation.name,
      toolVersion: manifest.version,
      riskClass: manifest.riskClass,
      argumentsHash,
      arguments: invocation.arguments,
      requiresApproval: manifest.requiresApproval,
    });
    if (manifest.riskClass === "external-effect") {
      await effectReceipts.reserve({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        idempotencyKey: `${run.id}:${invocation.name}:${argumentsHash}`,
      });
    }
    const step = await runSteps.startStep({
      runId: run.id,
      organizationId: run.organization_id,
      stepType: "tool",
      input: { toolCallId: invocation.id, name: invocation.name, argumentsHash },
    });
    stepId = step.id;
    if (manifest.requiresApproval) {
      await approvals.createPending({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        resourceSnapshot,
        previewRevision: argumentsHash,
        policyRevision: "v1",
        permittedEffectKey: `${run.id}:${invocation.id}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      return {
        status: "awaiting_approval" as const,
        messages: [],
        pendingToolCalls: [{ id: invocation.id, name: invocation.name, arguments: invocation.arguments, argumentsHash }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        iterations: 0,
        toolCalls: 1,
        provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
      };
    }
  }

  let policyApplied = false;
  let effectTransitioned = false;
  try {
    if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
    if (await killSwitches.isBlocked({
      organizationId: run.organization_id,
      agentId: run.agent_definition_id,
      installationId: run.installation_id,
      toolNames: [invocation.name],
    })) throw new Error("AGENT_KILL_SWITCH_ACTIVE");
    if (manifest.riskClass === "external-effect") {
      if (!(await controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
      if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
    }
    await assertCurrentCapabilityPolicy({
      organizationId: run.organization_id,
      installationId: run.installation_id,
      name: invocation.name,
      argumentsValue: invocation.arguments,
      grantedTools,
      tools,
      installationGrants,
      approved: !manifest.requiresApproval || Boolean(resumeApprovedToolCall?.approval),
    });
    policyApplied = true;
    const effectIdempotencyKey = `${run.id}:${invocation.name}:${argumentsHash}`;
    if (manifest.requiresApproval && manifest.riskClass !== "external-effect") {
      await approvals.consume({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        resourceSnapshot,
        previewRevision: argumentsHash,
        policyRevision: "v1",
        permittedEffectKey: `${run.id}:${invocation.id}`,
      });
    }
    await consumeRunToolBudget(runBudgets, { organizationId: run.organization_id, runId: run.id });
    const result = await tools.invoke({
      name: invocation.name,
      arguments: invocation.arguments,
      grantedTools,
      approval: resumeApprovedToolCall?.approval,
      beforeEffect: manifest.riskClass === "external-effect" ? async () => {
        if (manifest.requiresApproval) {
          await approvals.consumeAndStartEffect({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: invocation.id,
            capability: invocation.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            resourceSnapshot,
            previewRevision: argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${run.id}:${invocation.id}`,
            effectIdempotencyKey,
          });
        } else {
          await effectReceipts.markExecutingByKey(run.organization_id, effectIdempotencyKey);
        }
        effectTransitioned = true;
      } : undefined,
      context: toolInvocationContextFromScope(executionScopeFromRun(run), {
        approvalSnapshotHash: approvalSnapshotHashFromResource(resourceSnapshot),
      }),
    });
    const durableOutput = redactToolOutput(result.output, manifest.manifest?.redaction ?? []);
    await toolInvocations.recordCompleted({
      runId: run.id,
      providerToolCallId: invocation.id,
      output: durableOutput,
      latencyMs: result.latencyMs,
      effectId: result.effectId,
    });
    if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${invocation.name}:${argumentsHash}`, durableOutput);
    if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    await runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: "mcp.tool.completed",
      payload: { toolCallId: invocation.id, name: invocation.name },
    });
    return {
      status: "completed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
      provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
    };
  } catch (error) {
    const normalized = { code: "MCP_TOOL_FAILED", message: error instanceof Error ? error.message : "MCP tool failed" };
    await toolInvocations.recordFailed({ runId: run.id, providerToolCallId: invocation.id, error: normalized });
    if (manifest.riskClass === "external-effect") {
      const effectKey = `${run.id}:${invocation.name}:${argumentsHash}`;
      if (effectTransitioned) {
        await effectReceipts.markUnknownByKey(run.organization_id, effectKey, normalized);
      } else if (!policyApplied) {
        await effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, normalized);
      }
    }
    if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: normalized });
    return {
      status: "failed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
      error: normalized,
      provenance: buildGroundingProvenance({ authorizedTools: grantedTools, usedTools: [invocation.name], retrievalRequested: false, knowledgeMatchCount: 0 }),
    };
  }
}

async function executeLoopForRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  resumeExternalEvent: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeExternalEvent"],
  loopStep: Parameters<AgentRunActivities["executeLoop"]>[0]["loopStep"],
  runs: RunRepository,
  modelCalls: ModelCallRepository,
  runBudgets: RunBudgetRepository,
  conversations: ConversationRepository,
  memory: MemoryRepository,
  knowledge: KnowledgeRepository,
  skills: SkillRepository,
  remoteMcpProviders: RemoteMcpProviderRepository,
  toolInvocations: ToolInvocationRepository,
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  summaries: SummaryRepository,
  killSwitches: KillSwitchRepository,
  controls: OperatorControlRepository,
  kasiaiPreferences: KasiAiPreferenceRepository,
  gateway: ModelGateway,
  credentials: CredentialResolver,
  tools: ToolRegistry,
  harness: AgentHarness,
  workflowState: WorkflowStateRepository,
  workflowCheckpoints: WorkflowCheckpointRepository,
  modelPricing: Record<string, ModelPricing>,
  creditPricing: ModelCreditPricing,
  creditBillingMode: AppConfig["CREDIT_BILLING_MODE"],
  coreClient: KasitekCoreReadClient | undefined,
  conversationActions: ConversationActionService,
  stepActivitiesEnabled: boolean,
) {
  if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
  const journal = new PostgresExecutionJournal(new RunRepositoryExecutionJournalStore(runs));
  const configuration = run.configuration;
  const installationSettings = run.installation_settings ?? {};
  const storedWorkflowState = await workflowState.get(run.organization_id, run.id);
  const storedLoopState = storedWorkflowState?.state?.__agentLoop;
  const loopCheckpoint = readDurableAgentLoopCheckpoint(storedLoopState);
  if (storedLoopState !== undefined && !loopCheckpoint) throw new Error("AGENT_LOOP_CHECKPOINT_INVALID");
  const stepExecutionEnabled = (stepActivitiesEnabled || loopCheckpoint?.stepIndex !== undefined)
    && !(configuration.workflow && typeof configuration.workflow === "object" && !Array.isArray(configuration.workflow));
  const activeLoopStep = loopStep ?? loopCheckpoint?.stepIndex ?? 0;
  const checkpointReplaysCurrentActivity = stepExecutionEnabled
    && loopCheckpoint?.stepIndex === activeLoopStep
    && !resumeApprovedToolCall
    && !resumeExternalEvent
    && loopCheckpoint.status !== undefined;
  if (checkpointReplaysCurrentActivity) {
    const usage = await modelCalls.usageForRun(run.organization_id, run.id);
    if (loopCheckpoint.status === "limited") {
      const replayLimitedResult: AgentLoopResult & { checkpointed?: boolean } = {
        status: "limited",
        messages: loopCheckpoint.messages,
        usage,
        iterations: loopCheckpoint.iterations,
        toolCalls: loopCheckpoint.toolCalls,
        ...(loopCheckpoint.ui ? { ui: loopCheckpoint.ui } : {}),
        checkpointed: true,
      };
      return replayLimitedResult;
    }
    const replayStatus = loopCheckpoint.status;
    if (!replayStatus) throw new Error("AGENT_LOOP_CHECKPOINT_STATUS_MISSING");
    const replayResult: AgentLoopResult & { checkpointed?: boolean } = {
      status: replayStatus,
      messages: loopCheckpoint.messages,
      usage,
      iterations: loopCheckpoint.iterations,
      toolCalls: loopCheckpoint.toolCalls,
      ...(loopCheckpoint.pendingToolCalls ? { pendingToolCalls: loopCheckpoint.pendingToolCalls } : {}),
      ...(loopCheckpoint.waitingFor ? { waitingFor: loopCheckpoint.waitingFor } : {}),
      ...(loopCheckpoint.ui ? { ui: loopCheckpoint.ui } : {}),
    };
    return replayResult;
  }
  const activitySignal = currentActivitySignal();
  const modelTarget = resolveModelTarget(configuration, run.policy);
  const runBudgetLimits = {
    maxModelCalls: restrictiveLimit(configuration.maxModelCalls, installationSettings.maxModelCalls) ?? 8,
    maxToolCalls: restrictiveLimit(configuration.maxToolCalls, installationSettings.maxToolCalls) ?? 16,
    maxTotalTokens: restrictiveLimit(modelTarget.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens) ?? 32_000,
    maxEstimatedCostUsd: restrictiveLimit(modelTarget.maxEstimatedCostUsd, configuration.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
  };
  const configuredMaxIterations = typeof configuration.maxIterations === "number"
    ? Math.max(0, Math.floor(configuration.maxIterations))
    : 8;
  const remainingIterations = Math.max(0, configuredMaxIterations - (loopCheckpoint?.iterations ?? 0));
  const remainingToolCalls = Math.max(0, runBudgetLimits.maxToolCalls - (loopCheckpoint?.toolCalls ?? 0));
  await runBudgets.ensure({ organizationId: run.organization_id, runId: run.id }, runBudgetLimits);
  const isKasiAiInstallation = run.execution_mode === "system_hosted"
    && run.agent_owner_type === "system"
    && run.agent_protected === true
    && run.agent_slug === "kasiai";
  const preference = isKasiAiInstallation
    ? await kasiaiPreferences.get(run.organization_id, run.installation_id, run.created_by)
    : null;
  const channelUsesKasiAiPreference = isKasiAiInstallation
    && Boolean(run.reply_channel_type && run.reply_channel_type !== "platform");
  const provider = ((channelUsesKasiAiPreference ? preference?.default_model_provider : run.resolved_model_provider)
    ?? preference?.default_model_provider
    ?? run.resolved_model_provider
    ?? modelTarget.provider) as typeof modelTarget.provider;
  const model = (channelUsesKasiAiPreference ? preference?.default_model : run.resolved_model)
    ?? preference?.default_model
    ?? run.resolved_model
    ?? modelTarget.model;
  const policyTools = new Set(
    Array.isArray(run.policy.allowedTools) ? run.policy.allowedTools.filter((value): value is string => typeof value === "string") : [],
  );
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  const allowedTools = new Set([...policyTools].filter((toolName) => grantedTools.has(toolName)));
  for (const toolName of await remoteMcpProviders.registerPinnedTools(run.organization_id, run.agent_version_id, tools)) allowedTools.add(toolName);
  if (await killSwitches.isBlocked({ organizationId: run.organization_id, agentId: run.agent_definition_id, installationId: run.installation_id, toolNames: [...allowedTools] })) {
    throw new Error("AGENT_KILL_SWITCH_ACTIVE");
  }
  // Harness controls are available to every hosted run. They are not an
  // installation grant and are never exposed as external business actions.
  addAgentMediaHarnessTools(allowedTools);
  const executionScope = {
    ...executionScopeFromRun(run),
    capabilityGrants: [...allowedTools],
  };
  if (!(await controls.isFeatureEnabled(run.organization_id, "agent_execution_enabled", run.installation_id))) throw new Error("AGENT_EXECUTION_FLAG_DISABLED");
  if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "execution" })) throw new Error("AGENT_EXECUTION_HOLD_ACTIVE");
  const credentialReference = isKasiAiInstallation && typeof preference?.default_credential_reference === "string"
    ? preference.default_credential_reference
    : typeof configuration.credentialReference === "string"
      ? configuration.credentialReference
      : modelTarget.credentialReference;
  const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
  const fallbackModels = [] as Array<{
    model: { provider: typeof provider; model: string; temperature?: number };
    credentials: ModelCredentials;
  }>;
  for (const fallback of modelTarget.fallback) {
    if (fallback.provider === provider && fallback.model === model) continue;
    const fallbackCredentials = await credentials.resolve(fallback.provider, credentialReference, run.organization_id);
    if (modelCredentials.fundingSource === "user" && fallbackCredentials.fundingSource === "kasitek" && !modelTarget.allowUserFundedFallbackToKasiTek) continue;
    fallbackModels.push({
      model: { provider: fallback.provider, model: fallback.model, temperature: typeof configuration.temperature === "number" ? configuration.temperature : undefined },
      credentials: fallbackCredentials,
    });
  }
  const dynamicUiEnabled = await controls.isFeatureEnabled(run.organization_id, "dynamic_ui_enabled", run.installation_id);
  const currentInputMessage = run.input.message;
  const currentInputRecord = currentInputMessage && typeof currentInputMessage === "object" && !Array.isArray(currentInputMessage)
    ? currentInputMessage as Record<string, unknown>
    : undefined;
  const currentMessage = typeof currentInputMessage === "string"
    ? currentInputMessage
    : currentInputRecord && Array.isArray(currentInputRecord.media)
        ? JSON.stringify({ text: currentInputRecord.text, attachedWorkspaceMedia: currentInputRecord.media })
      : currentInputRecord && typeof currentInputRecord.assetId === "string"
        ? JSON.stringify({
          text: currentInputRecord.text,
          attachedWorkspaceMedia: {
            assetId: currentInputRecord.assetId,
            mimeType: currentInputRecord.mimeType,
            fileName: currentInputRecord.fileName,
            mediaKind: currentInputRecord.mediaKind,
          },
        })
      : JSON.stringify(currentInputMessage ?? run.input);
  const rawDynamicContext = run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context)
    ? run.input.context as Record<string, unknown>
    : undefined;
  const dynamicContext = rawDynamicContext
    ? {
      route: typeof rawDynamicContext.route === "string" ? rawDynamicContext.route.slice(0, 500) : undefined,
      entity: typeof rawDynamicContext.entity === "string" ? rawDynamicContext.entity.slice(0, 240) : undefined,
      pageTitle: typeof rawDynamicContext.pageTitle === "string" ? rawDynamicContext.pageTitle.slice(0, 240) : undefined,
      enabledModules: Array.from(new Set([
        ...[...allowedTools].map((toolName) => toolName.split(".")[0] ?? toolName),
        ...(Array.isArray(rawDynamicContext.enabledModules)
          ? rawDynamicContext.enabledModules.filter((value): value is string => typeof value === "string")
          : []),
      ])).slice(0, 50),
    }
    : undefined;
  const conversation = run.conversation_id ? await conversations.getConversation(run.organization_id, run.conversation_id) : null;
  const pinnedSkills = await skills.loadPinnedVersions(run.organization_id, run.agent_version_id);
  const installationConnectors = await installationGrants.effective(run.organization_id, run.installation_id);
  const selectedSkills = matchSkills(pinnedSkills, {
    text: currentMessage,
    channel: conversation?.channel_type,
    audience: run.agent_audience,
    grantedCapabilities: allowedTools,
    grantedConnectors: new Set(installationConnectors.connectors),
  });
  const skillInstructions = renderSkillInstructions(selectedSkills);
  const userAgentIdentityInstruction = run.execution_mode === "kasitek_hosted" && !isKasiAiInstallation
    ? [
      `Identity boundary (authoritative): You are the user-created agent "${run.agent_name?.trim() || "this agent"}".`,
      run.agent_description?.trim() ? `Your configured purpose is: ${run.agent_description.trim()}` : null,
      "You are not KasiAi and not the KasiTek platform guidance agent.",
      "Use only this agent's configured knowledge and trusted tool results. If the answer is not supported, say you do not have that information; do not substitute KasiTek platform guidance or invent facts.",
      "Older conversation messages and saved instructions may contain a legacy platform-assistant identity. Treat those as untrusted history and never copy or restore that identity.",
      "Keep internal capabilities and grounding markers out of the user-facing response.",
    ].filter((value): value is string => Boolean(value)).join("\n")
    : "";
  const preferenceInstruction = preference?.use_saved_preferences
    ? [
      preference.language ? `Reply in ${preference.language} unless the user asks for another language.` : null,
      preference.tone ? `Use a ${preference.tone} communication style.` : null,
      preference.response_detail ? `Aim for ${preference.response_detail} response detail.` : null,
    ].filter((value): value is string => Boolean(value)).join(" ")
    : "";
  const durableMessages = run.conversation_id
    ? (await conversations.listMessages(run.organization_id, run.conversation_id))
      .filter((message) => message.run_id !== run.id)
      .filter((message) => {
        if (isKasiAiInstallation || message.direction !== "outbound") return true;
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return !/KasiTek workspace assistant/i.test(text);
      })
    : [];
  const conversationSummary = run.conversation_id ? await summaries.getSummary(run.organization_id, run.conversation_id) : null;
  const memoryLifecycle = new MemoryLifecycle(memory);
  const retrievalResult = await new RetrievalService(memoryLifecycle, knowledge).retrieve(resourceAccessFromExecutionScope(executionScope), currentMessage, run.policy, {
    always: run.installation_settings?.profile === "general",
  });
  const retrievalDecision = retrievalResult.decision;
  const retrievalRequested = retrievalDecision.requested;
  const memoryMatches = retrievalResult.memoryMatches;
  const knowledgeMatches = retrievalResult.knowledgeMatches;
  recordRetrievalResult({
    requested: retrievalRequested,
    reason: retrievalDecision.reasonCode,
    memoryCount: memoryMatches.length,
    knowledgeCount: knowledgeMatches.length,
    evidenceCount: retrievalResult.evidence.length,
  });
  const retrievalStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "retrieval",
    input: {
      requested: retrievalRequested,
      reasonCode: retrievalDecision.reasonCode,
      sourceTypes: retrievalDecision.sourceTypes,
      query: retrievalRequested ? retrievalDecision.query : undefined,
    },
  });
  await runSteps.finishStep({
    stepId: retrievalStep.id,
    status: "completed",
    output: {
      memoryMatchCount: memoryMatches.length,
      knowledgeMatchCount: knowledgeMatches.length,
      evidence: retrievalResult.evidence.map((entry) => ({ sourceType: entry.sourceType, id: entry.id, rank: entry.rank, score: entry.score })),
    },
  });
  const longTermMemory = retrievalResult.evidence
    .map((entry) => entry.sourceType === "memory"
      ? `[memory:${entry.namespace ?? "unknown"}:${entry.rank}] ${entry.text}`
      : `[knowledge:${entry.sourceId ?? "unknown"}:${entry.chunkIndex ?? 0}:${entry.rank}] ${entry.text}`)
    .join("\n");
  const context = harness.buildContext({
    instructions: [
      isKasiAiInstallation
        ? run.instructions
        : run.instructions.replace(/You are a general-purpose KasiTek workspace assistant\.\s*/gi, ""),
      preferenceInstruction,
      userAgentIdentityInstruction,
      skillInstructions,
      "Media delivery is a shared harness capability across every hosted agent and channel. Use kasitek.agent.respond for final responses containing workspace media, passing stable asset IDs and kinds. Keep provider URLs and raw bytes out of durable responses; the channel adapter resolves the appropriate preview, upload, or native attachment at delivery time.",
      "When batch social publishing tools are available and the user names multiple destinations, prepare one draft with explicit account selections and visible platform variants, preflight it before approval, request one approval, and execute one batch publish. Do not loop over single-destination publish tools. Use the batch status tool for a later PROCESSING update and report each destination state.",
    ].filter(Boolean).join("\n\n"),
    scope: executionScope,
    channelType: conversation?.channel_type,
    currentMessage,
    alwaysRetrieveKnowledge: run.installation_settings?.profile === "general",
    retrievalDecision,
    summary: conversationSummary?.summary,
    longTermMemory: longTermMemory || undefined,
    recentMessages: durableMessages.map((message) => ({
      direction: message.direction as "inbound" | "outbound" | "system",
      messageType: message.message_type,
      content: message.content,
      createdAt: message.created_at,
    })),
    authorizedTools: tools.list(allowedTools),
    dynamicContext,
    temporaryContext: run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context)
      ? JSON.stringify(run.input.context)
      : undefined,
    budget: {
      maxMessages: restrictiveLimit(configuration.maxContextMessages, installationSettings.maxContextMessages),
      maxContextTokens: restrictiveLimit(configuration.maxContextTokens, installationSettings.maxContextTokens),
    },
  });
  const modelToolContext = toolInvocationContextFromScope(executionScope, {
    memoryPolicy: run.policy && typeof run.policy.memory === "object" && !Array.isArray(run.policy.memory) ? run.policy.memory as Record<string, unknown> : undefined,
  });
  const contextStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "context",
    input: { messageCount: durableMessages.length },
  });
  await runSteps.finishStep({
    stepId: contextStep.id,
    status: "completed",
    output: {
      estimatedTokens: context.estimatedTokens,
      messageCount: context.messages.length,
      omittedMessageCount: context.omittedMessageCount,
      omittedToolCount: context.omittedToolCount,
      budget: context.budget,
      decision: context.decision,
    },
  });
  await runs.appendEvent({
    organizationId: run.organization_id,
    runId: run.id,
    installationId: run.installation_id,
    eventType: "agent.context.built",
    payload: {
      estimatedTokens: context.estimatedTokens,
      omittedMessageCount: context.omittedMessageCount,
      retrievalRequested: context.retrievalRequested,
      retrievalReason: context.retrievalDecision.reason,
      messageCount: context.messages.length,
      memoryMatchCount: memoryMatches.length,
      knowledgeMatchCount: knowledgeMatches.length,
      omittedToolCount: context.omittedToolCount,
      budget: context.budget,
      decision: context.decision,
    },
  });
  if (context.decision.status === "limited") {
    const error = {
      code: "CONTEXT_MINIMUM_EXCEEDS_BUDGET",
      message: "The minimum required instructions, current message, and tool schemas exceed the configured context budget.",
      failureClass: "terminal" as const,
    };
    await runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: "agent.context.limited",
      payload: { error, decision: context.decision, budget: context.budget },
    });
    return {
      status: "limited" as const,
      messages: context.messages,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 0,
      error,
    };
  }
  const budgetLedger: AgentBudgetLedger = createAgentBudgetLedger({
    contextTokens: runBudgetLimits.maxTotalTokens,
    modelTokens: runBudgetLimits.maxTotalTokens,
    toolCalls: runBudgetLimits.maxToolCalls,
    graphSteps: 2_000,
    childInvocations: 16,
    wallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : 60_000,
  });
  if (shouldFailClosedWithoutEvidence({
    message: currentMessage,
    agentAudience: run.agent_audience,
    isSystemAgent: isKasiAiInstallation,
    evidenceCount: retrievalResult.evidence.length,
  })) {
    const response = createGroundingFallbackResponse(provider, model);
    const usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      estimatedCostUsd: response.usage.estimatedCostUsd ?? 0,
    };
    const groundingStep = await runSteps.startStep({
      runId: run.id,
      organizationId: run.organization_id,
      stepType: "policy",
      input: { policy: "grounding", decision: "no_trusted_evidence" },
    });
    await runSteps.finishStep({
      stepId: groundingStep.id,
      status: "completed",
      output: { decision: "no_trusted_evidence", modelCallSkipped: true },
    });
    await runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: "agent.grounding.blocked",
      payload: { reason: "no_trusted_evidence", retrievalRequested, knowledgeMatchCount: retrievalResult.evidence.filter((entry) => entry.sourceType === "knowledge").length },
    });
    const groundingResult: AgentLoopResult = {
      status: "completed",
      messages: [response.message],
      response,
      usage,
      iterations: 0,
      toolCalls: 0,
      provenance: buildGroundingProvenance({
        authorizedTools: allowedTools,
        usedTools: [],
        retrievalRequested,
        knowledgeMatchCount: retrievalResult.evidence.filter((entry) => entry.sourceType === "knowledge").length,
      }),
    };
    return groundingResult;
  }
  const approvedResourceSnapshot = resumeApprovedToolCall?.approval.resourceSnapshot
    ?? (resumeApprovedToolCall ? (await approvals.getForRun(run.organization_id, run.id))?.resource_snapshot : undefined);
  const toolSteps = new Map<string, string>();
  const startedExternalEffects = new Set<string>();
  const usedTools = new Set<string>();
  const unavailableTools = new Set<string>();
  const runHostedAgentLoop = async (options: {
    messages: ModelMessage[];
    operationKeyPrefix?: string;
    parallelLeaseId?: string;
    model?: { temperature?: number; maxTokens?: number };
    limits?: Partial<AgentLoopLimits>;
  }): Promise<AgentLoopResult> => withActivityHeartbeat(
    { phase: options.operationKeyPrefix ? "workflow.agent_loop" : "agent.loop" },
    () => harness.runTurn({
      model: {
        provider,
        model,
        temperature: options.model?.temperature ?? (typeof configuration.temperature === "number" ? configuration.temperature : undefined),
        maxTokens: options.model?.maxTokens,
      },
      messages: options.messages,
      credentials: modelCredentials,
      fallbackModels,
      gateway,
      grantedTools: allowedTools,
      modelTools: context.tools,
      modelContextTokens: context.budget.maxContextTokens,
      budgetLedger,
      toolContext: modelToolContext,
      uiChannel: run.reply_channel_type === "website" ? "website" : "platform",
      dynamicUiEnabled,
      signal: activitySignal,
      operationKeyPrefix: options.operationKeyPrefix,
      parallelLeaseId: options.parallelLeaseId,
      limits: {
        maxIterations: typeof configuration.maxIterations === "number" ? configuration.maxIterations : undefined,
        maxToolCalls: runBudgetLimits.maxToolCalls,
        maxTotalTokens: runBudgetLimits.maxTotalTokens,
        maxEstimatedCostUsd: runBudgetLimits.maxEstimatedCostUsd,
        maxWallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : undefined,
        ...options.limits,
      },
      reserveRunBudget: async ({ request, reservationKey, parallelLeaseId }) => reserveRunModelBudget({ repository: runBudgets, organizationId: run.organization_id, runId: run.id, reservationKey, parallelLeaseId, gateway, request }),
      consumeRunToolCall: ({ parallelLeaseId } = {}) => consumeRunToolBudget(runBudgets, { organizationId: run.organization_id, runId: run.id, parallelLeaseId }),
      replayToolInvocation: async ({ toolCallId, name, argumentsHash }) => (await toolInvocations.getCompleted({
        organizationId: run.organization_id,
        runId: run.id,
        providerToolCallId: toolCallId,
        toolName: name,
        argumentsHash,
      })) ?? undefined,
      prepareModelCall: async ({ operationKey, model: attemptModel, credentials: attemptCredentials }) => modelCalls.prepare({
        organizationId: run.organization_id,
        runId: run.id,
        operationKey,
        provider: attemptModel.provider,
        model: attemptModel.model,
        fundingSource: attemptCredentials.fundingSource,
        credentialReference: attemptCredentials.credentialReference,
      }),
      persistModelResponse: async ({ operationKey, response, attempt }) => modelCalls.recordCompleted({
        organizationId: run.organization_id,
        runId: run.id,
        operationKey,
        provider: response.provider,
        model: response.model,
        fundingSource: attempt.credentials.fundingSource,
        credentialReference: attempt.credentials.credentialReference,
        response,
        correlationId: run.correlation_id,
      }),
      persistModelError: async ({ operationKey, model: attemptModel, credentials: attemptCredentials, error }) => modelCalls.recordFailed({
        organizationId: run.organization_id,
        runId: run.id,
        operationKey,
        provider: attemptModel.provider,
        model: attemptModel.model,
        fundingSource: attemptCredentials.fundingSource,
        error,
        correlationId: run.correlation_id,
      }),
      reserveModelCall: async ({ request, credentials: attemptCredentials, operationKey }) => reserveModelCredits({
        billingMode: creditBillingMode,
        gateway,
        modelPricing,
        creditPricing,
        coreClient,
        context: modelToolContext,
        runId: run.id,
        operationKey,
        request,
        credentials: attemptCredentials,
      }),
      beforeToolInvoke: async (invocation) => {
        const manifest = tools.get(invocation.name);
        if (manifest?.requiresApproval && !invocation.approved) return;
        await assertCurrentCapabilityPolicy({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          name: invocation.name,
          argumentsValue: invocation.arguments,
          grantedTools: allowedTools,
          tools,
          installationGrants,
          approved: invocation.approved,
        });
      },
      resumeApprovedToolCall,
      onEvent: async (event) => {
        activityHeartbeat({ phase: event.type, iteration: event.iteration });
        await journal.append({
          scope: {
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            correlationId: run.correlation_id,
          },
          event: journalHarnessEvent(event),
        });
      },
      onToolProposed: async (proposal) => {
        usedTools.add(proposal.name);
        const resourceSnapshot = proposal.requiresApproval && approvedResourceSnapshot
          ? approvedResourceSnapshot
          : await buildApprovalResourceSnapshotFromCore(coreClient, toolInvocationContextFromScope(executionScopeFromRun(run)), proposal.name, proposal.arguments);
        await toolInvocations.recordProposal({
          organizationId: run.organization_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          sequenceNumber: proposal.sequenceNumber,
          toolName: proposal.name,
          toolVersion: proposal.version,
          riskClass: proposal.riskClass,
          argumentsHash: proposal.argumentsHash,
          arguments: proposal.arguments,
          requiresApproval: proposal.requiresApproval,
        });
        if (proposal.requiresApproval) {
          await approvals.createPending({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: proposal.toolCallId,
            capability: proposal.name,
            capabilityVersion: proposal.version,
            argumentsHash: proposal.argumentsHash,
            resourceSnapshot,
            previewRevision: proposal.argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${run.id}:${proposal.toolCallId}`,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
        }
        if (proposal.riskClass === "external-effect") {
          await effectReceipts.reserve({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: proposal.toolCallId,
            capability: proposal.name,
            capabilityVersion: proposal.version,
            argumentsHash: proposal.argumentsHash,
            idempotencyKey: `${run.id}:${proposal.name}:${proposal.argumentsHash}`,
          });
        }
        const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: proposal.toolCallId, name: proposal.name, argumentsHash: proposal.argumentsHash } });
        toolSteps.set(proposal.toolCallId, step.id);
      },
      onToolExecuting: async (execution) => {
        if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
        const manifest = tools.get(execution.name);
        const resourceSnapshot = execution.requiresApproval && approvedResourceSnapshot
          ? approvedResourceSnapshot
          : await buildApprovalResourceSnapshotFromCore(coreClient, toolInvocationContextFromScope(executionScopeFromRun(run)), execution.name, execution.arguments);
        await assertCurrentCapabilityPolicy({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          name: execution.name,
          argumentsValue: execution.arguments,
          grantedTools: allowedTools,
          tools,
          installationGrants,
          approved: execution.requiresApproval,
        });
        if (manifest?.riskClass === "external-effect") {
          if (!(await controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
          if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
        }
        if (execution.requiresApproval) {
          await approvals.consumeAndStartEffect({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: execution.toolCallId,
            capability: execution.name,
            capabilityVersion: execution.version,
            argumentsHash: execution.argumentsHash,
            resourceSnapshot,
            previewRevision: execution.argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${run.id}:${execution.toolCallId}`,
            effectIdempotencyKey: `${run.id}:${execution.name}:${execution.argumentsHash}`,
          });
        } else {
          await effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${execution.name}:${execution.argumentsHash}`);
        }
        startedExternalEffects.add(execution.toolCallId);
      },
      onToolCompleted: async (result) => {
        const completedManifest = tools.get(result.name);
        await toolInvocations.recordCompleted({
          runId: run.id,
          providerToolCallId: result.toolCallId,
          output: result.output,
          latencyMs: result.latencyMs,
          effectId: result.effectId,
        });
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.tool.completed",
          operationId: result.toolCallId,
          payload: {
            name: result.name,
            argumentsHash: result.argumentsHash,
            latencyMs: result.latencyMs,
            output: redactToolOutput(result.output, completedManifest?.manifest?.redaction ?? []),
          },
        });
        if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${result.name}:${result.argumentsHash}`, result.output);
        const stepId = toolSteps.get(result.toolCallId);
        if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
      },
      onToolFailed: async (failure) => {
        if (["TOOL_NOT_FOUND", "TOOL_NOT_GRANTED", "CAPABILITY_NOT_GRANTED", "UNAVAILABLE", "NOT_CONFIGURED"].some((code) => failure.error.code.includes(code))) unavailableTools.add(failure.name);
        await toolInvocations.recordFailed({
          runId: run.id,
          providerToolCallId: failure.toolCallId,
          error: failure.error,
        });
        await runs.appendEvent({
          organizationId: run.organization_id,
          runId: run.id,
          installationId: run.installation_id,
          eventType: "agent.tool.failed",
          operationId: failure.toolCallId,
          payload: { name: failure.name, argumentsHash: failure.argumentsHash, error: failure.error },
        });
        const failedTool = tools.get(failure.name);
        if (failedTool?.riskClass === "external-effect" && failure.argumentsHash) {
          const effectKey = `${run.id}:${failure.name}:${failure.argumentsHash}`;
          if (startedExternalEffects.has(failure.toolCallId)) {
            await effectReceipts.markUnknownByKey(run.organization_id, effectKey, failure.error);
          } else {
            await effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, failure.error);
          }
        }
        const stepId = toolSteps.get(failure.toolCallId);
        if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: failure.error });
      },
      onModelResponse: async (response, attempt, operationKey) => {
        const attemptCredentials = attempt?.credentials ?? modelCredentials;
        await modelCalls.recordCompleted({
          organizationId: run.organization_id,
          runId: run.id,
          operationKey,
          provider: response.provider,
          model: response.model,
          fundingSource: attemptCredentials.fundingSource,
          credentialReference: attemptCredentials.credentialReference,
          response,
          correlationId: run.correlation_id,
        });
        const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model } });
        await runSteps.finishStep({ stepId: step.id, status: "completed", output: { totalTokens: response.usage.totalTokens, finishReason: response.finishReason, latencyMs: response.latencyMs } });
      },
      onModelError: async (error, attempt, operationKey) => {
        const attemptModel = attempt?.model ?? { provider, model };
        const attemptCredentials = attempt?.credentials ?? modelCredentials;
        await modelCalls.recordFailed({
          organizationId: run.organization_id,
          runId: run.id,
          operationKey,
          provider: attemptModel.provider,
          model: attemptModel.model,
          fundingSource: attemptCredentials.fundingSource,
          error,
          correlationId: run.correlation_id,
        });
        const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: attemptModel.provider, model: attemptModel.model } });
        await runSteps.finishStep({ stepId: step.id, status: "failed", error });
      },
    }),
  );
  if (configuration.workflow && typeof configuration.workflow === "object" && !Array.isArray(configuration.workflow)) {
    const workflowResult = await executeConfiguredWorkflow({
      run,
      graphInput: configuration.workflow,
      inputState: { input: currentMessage, context: dynamicContext ?? {}, output: {} },
      context,
      modelProvider: provider,
      model,
      modelCredentials,
      gateway,
      modelPricing,
      creditPricing,
      creditBillingMode,
      tools,
      allowedTools,
      runRepository: runs,
      modelCalls,
      toolInvocations,
      approvals,
      effectReceipts,
      runSteps,
      installationGrants,
      killSwitches,
      controls,
      workflowState,
      workflowCheckpoints,
      runBudget: runBudgets,
      resumeApprovedToolCall,
      resumeExternalEvent,
      coreClient,
      modelToolContext,
      conversationActions,
      harness,
      budgetLedger,
      runAgentLoop: async ({ nodeId, config, state, maxIterations, usage, limits, parallelLeaseId }) => {
        const instruction = typeof config.instruction === "string" && config.instruction.trim()
          ? config.instruction
          : "Continue the workflow.";
        const configuredIterations = typeof maxIterations === "number" && Number.isFinite(maxIterations)
          ? Math.max(0, Math.floor(maxIterations))
          : 8;
        const remainingModelCalls = limits?.maxModelCalls === undefined
          ? configuredIterations
          : Math.max(0, limits.maxModelCalls - usage.modelCalls);
        const loopResult = await runHostedAgentLoop({
          messages: [...context.messages, { role: "user", content: JSON.stringify({ nodeId, instruction, state }) }],
          operationKeyPrefix: workflowAgentLoopOperationKeyPrefix(run.id, nodeId),
          parallelLeaseId,
          model: {
            maxTokens: typeof config.maxTokens === "number" ? Math.max(1, Math.min(8_000, Math.floor(config.maxTokens))) : undefined,
            temperature: typeof config.temperature === "number" ? config.temperature : undefined,
          },
          limits: {
            maxIterations: Math.min(configuredIterations, remainingModelCalls),
            maxToolCalls: limits?.maxToolCalls === undefined ? undefined : Math.max(0, limits.maxToolCalls - usage.toolCalls),
            maxTotalTokens: limits?.maxTotalTokens === undefined ? undefined : Math.max(0, limits.maxTotalTokens - usage.totalTokens),
            maxEstimatedCostUsd: limits?.maxEstimatedCostUsd === undefined ? undefined : Math.max(0, limits.maxEstimatedCostUsd - usage.estimatedCostUsd),
            maxWallTimeMs: limits?.maxWallTimeMs,
          },
        });
        const output = loopResult.completionResponse
          ?? loopResult.completionMessage
          ?? loopResult.response?.message.content;
        return {
          status: loopResult.status,
          ...(loopResult.response ? { response: loopResult.response } : {}),
          ...(output === undefined ? {} : { output }),
          ...(loopResult.pendingToolCalls ? { pendingToolCalls: loopResult.pendingToolCalls } : {}),
          ...(loopResult.waitingFor ? { waitingFor: loopResult.waitingFor } : {}),
          ...(loopResult.error ? { error: loopResult.error } : {}),
          usage: { ...loopResult.usage, modelCalls: loopResult.iterations, toolCalls: loopResult.toolCalls },
        };
      },
      limits: {
        maxSteps: restrictiveLimit(configuration.maxIterations) ?? 8,
        maxModelCalls: runBudgetLimits.maxModelCalls,
        maxToolCalls: runBudgetLimits.maxToolCalls,
        maxTotalTokens: runBudgetLimits.maxTotalTokens,
        maxEstimatedCostUsd: runBudgetLimits.maxEstimatedCostUsd,
        maxWallTimeMs: restrictiveLimit(configuration.maxWallTimeMs) ?? 60_000,
      },
      graphStepActivitiesEnabled: stepActivitiesEnabled,
    });
    return { ...workflowResult, usage: await modelCalls.usageForRun(run.organization_id, run.id) };
  }
  {
  const approvedResourceSnapshot = resumeApprovedToolCall?.approval.resourceSnapshot
    ?? (resumeApprovedToolCall ? (await approvals.getForRun(run.organization_id, run.id))?.resource_snapshot : undefined);
  const toolSteps = new Map<string, string>();
  const startedExternalEffects = new Set<string>();
  const usedTools = new Set<string>();
  const unavailableTools = new Set<string>();
  const loopResult = await withActivityHeartbeat({ phase: "agent.loop" }, () => harness.runTurn({
    model: { provider, model, temperature: typeof configuration.temperature === "number" ? configuration.temperature : undefined },
    messages: resumeExternalEvent
      ? [...(loopCheckpoint?.messages ?? context.messages), { role: "user" as const, content: JSON.stringify({ externalEvent: resumeExternalEvent }) }]
      : loopCheckpoint?.messages ?? context.messages,
    credentials: modelCredentials,
    fallbackModels,
    gateway,
    grantedTools: allowedTools,
    modelTools: context.tools,
    toolContext: modelToolContext,
    uiChannel: run.reply_channel_type === "website" ? "website" : "platform",
    dynamicUiEnabled,
    resumeUi: loopCheckpoint?.ui,
    signal: activitySignal,
    operationKeyPrefix: agentLoopOperationKeyPrefix(run.id, stepExecutionEnabled ? (loopCheckpoint?.iterations ?? 0) : undefined),
    limits: {
      maxIterations: stepExecutionEnabled ? Math.min(1, remainingIterations) : (typeof configuration.maxIterations === "number" ? configuration.maxIterations : undefined),
      // A slice is bounded by one model iteration. Keep all tool calls returned by that
      // response together so the persisted assistant/tool message sequence stays valid.
      maxToolCalls: stepExecutionEnabled ? remainingToolCalls : runBudgetLimits.maxToolCalls,
      maxTotalTokens: runBudgetLimits.maxTotalTokens,
      maxEstimatedCostUsd: runBudgetLimits.maxEstimatedCostUsd,
      maxWallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : undefined,
    },
    reserveRunBudget: async ({ request, reservationKey, parallelLeaseId }) => reserveRunModelBudget({ repository: runBudgets, organizationId: run.organization_id, runId: run.id, reservationKey, parallelLeaseId, gateway, request }),
    consumeRunToolCall: ({ parallelLeaseId } = {}) => consumeRunToolBudget(runBudgets, { organizationId: run.organization_id, runId: run.id, parallelLeaseId }),
    prepareModelCall: async ({ operationKey, model: attemptModel, credentials: attemptCredentials }) => modelCalls.prepare({
      organizationId: run.organization_id,
      runId: run.id,
      operationKey,
      provider: attemptModel.provider,
      model: attemptModel.model,
      fundingSource: attemptCredentials.fundingSource,
      credentialReference: attemptCredentials.credentialReference,
    }),
    persistModelResponse: async ({ operationKey, response, attempt }) => modelCalls.recordCompleted({
      organizationId: run.organization_id,
      runId: run.id,
      operationKey,
      provider: response.provider,
      model: response.model,
      fundingSource: attempt.credentials.fundingSource,
      credentialReference: attempt.credentials.credentialReference,
      response,
      correlationId: run.correlation_id,
    }),
    persistModelError: async ({ operationKey, model: attemptModel, credentials: attemptCredentials, error }) => modelCalls.recordFailed({
      organizationId: run.organization_id,
      runId: run.id,
      operationKey,
      provider: attemptModel.provider,
      model: attemptModel.model,
      fundingSource: attemptCredentials.fundingSource,
      error,
      correlationId: run.correlation_id,
    }),
    reserveModelCall: async ({ request, credentials: attemptCredentials, operationKey }) => {
      return reserveModelCredits({
        billingMode: creditBillingMode,
        gateway,
        modelPricing,
        creditPricing,
        coreClient,
        context: modelToolContext,
        runId: run.id,
        operationKey,
        request,
        credentials: attemptCredentials,
      });
    },
    beforeToolInvoke: async (invocation) => {
      const manifest = tools.get(invocation.name);
      if (manifest?.requiresApproval && !invocation.approved) return;
      await assertCurrentCapabilityPolicy({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        name: invocation.name,
        argumentsValue: invocation.arguments,
        grantedTools: allowedTools,
        tools,
        installationGrants,
        approved: invocation.approved,
      });
    },
    resumeApprovedToolCall,
    onEvent: async (event) => {
      activityHeartbeat({ phase: event.type, iteration: event.iteration });
      await journal.append({
        scope: executionScopeFromRun(run),
        event: journalHarnessEvent(event),
      });
      await runs.appendEvent({
        organizationId: run.organization_id,
        runId: run.id,
        installationId: run.installation_id,
        eventType: `agent.${event.type}`,
        payload: event.payload,
      });
    },
    onToolProposed: async (proposal) => {
      usedTools.add(proposal.name);
      const resourceSnapshot = proposal.requiresApproval && approvedResourceSnapshot
        ? approvedResourceSnapshot
        : await buildApprovalResourceSnapshotFromCore(coreClient, toolInvocationContextFromScope(executionScopeFromRun(run)), proposal.name, proposal.arguments);
      await toolInvocations.recordProposal({
        organizationId: run.organization_id,
        runId: run.id,
        providerToolCallId: proposal.toolCallId,
        sequenceNumber: proposal.sequenceNumber,
        toolName: proposal.name,
        toolVersion: proposal.version,
        riskClass: proposal.riskClass,
        argumentsHash: proposal.argumentsHash,
        arguments: proposal.arguments,
        requiresApproval: proposal.requiresApproval,
      });
      if (proposal.requiresApproval) {
        await approvals.createPending({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          resourceSnapshot,
          previewRevision: proposal.argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${run.id}:${proposal.toolCallId}`,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
      }
      if (proposal.riskClass === "external-effect") {
        await effectReceipts.reserve({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          idempotencyKey: `${run.id}:${proposal.name}:${proposal.argumentsHash}`,
        });
      }
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: proposal.toolCallId, name: proposal.name, argumentsHash: proposal.argumentsHash } });
      toolSteps.set(proposal.toolCallId, step.id);
    },
    onToolExecuting: async (execution) => {
      if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
      const manifest = tools.get(execution.name);
      const resourceSnapshot = execution.requiresApproval && approvedResourceSnapshot
        ? approvedResourceSnapshot
        : await buildApprovalResourceSnapshotFromCore(coreClient, toolInvocationContextFromScope(executionScopeFromRun(run)), execution.name, execution.arguments);
      await assertCurrentCapabilityPolicy({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        name: execution.name,
        argumentsValue: execution.arguments,
        grantedTools: allowedTools,
        tools,
        installationGrants,
        approved: execution.requiresApproval,
      });
      if (manifest?.riskClass === "external-effect") {
        if (!(await controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
        if (await controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
      }
      if (execution.requiresApproval) {
        await approvals.consumeAndStartEffect({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: execution.toolCallId,
          capability: execution.name,
          capabilityVersion: execution.version,
          argumentsHash: execution.argumentsHash,
          resourceSnapshot,
          previewRevision: execution.argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${run.id}:${execution.toolCallId}`,
          effectIdempotencyKey: `${run.id}:${execution.name}:${execution.argumentsHash}`,
        });
      } else {
        await effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${execution.name}:${execution.argumentsHash}`);
      }
      startedExternalEffects.add(execution.toolCallId);
    },
    onToolCompleted: async (result) => {
      await toolInvocations.recordCompleted({
        runId: run.id,
        providerToolCallId: result.toolCallId,
        output: result.output,
        latencyMs: result.latencyMs,
        effectId: result.effectId,
      });
      if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${result.name}:${result.argumentsHash}`, result.output);
      const stepId = toolSteps.get(result.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    },
    onToolFailed: async (failure) => {
      if (["TOOL_NOT_FOUND", "TOOL_NOT_GRANTED", "CAPABILITY_NOT_GRANTED", "UNAVAILABLE", "NOT_CONFIGURED"].some((code) => failure.error.code.includes(code))) unavailableTools.add(failure.name);
      await toolInvocations.recordFailed({
        runId: run.id,
        providerToolCallId: failure.toolCallId,
        error: failure.error,
      });
      const failedTool = tools.get(failure.name);
      if (failedTool?.riskClass === "external-effect" && failure.argumentsHash) {
        const effectKey = `${run.id}:${failure.name}:${failure.argumentsHash}`;
        if (startedExternalEffects.has(failure.toolCallId)) {
          await effectReceipts.markUnknownByKey(run.organization_id, effectKey, failure.error);
        } else {
          await effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, failure.error);
        }
      }
      const stepId = toolSteps.get(failure.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: failure.error });
    },
    onModelResponse: async (response, attempt, operationKey) => {
      const attemptCredentials = attempt?.credentials ?? modelCredentials;
      await modelCalls.recordCompleted({
        organizationId: run.organization_id,
        runId: run.id,
        operationKey,
        provider: response.provider,
        model: response.model,
        fundingSource: attemptCredentials.fundingSource,
        credentialReference: attemptCredentials.credentialReference,
        response,
        correlationId: run.correlation_id,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model } });
      await runSteps.finishStep({ stepId: step.id, status: "completed", output: { totalTokens: response.usage.totalTokens, finishReason: response.finishReason, latencyMs: response.latencyMs } });
    },
    onModelError: async (error, attempt, operationKey) => {
      const attemptModel = attempt?.model ?? { provider, model };
      const attemptCredentials = attempt?.credentials ?? modelCredentials;
      await modelCalls.recordFailed({
        organizationId: run.organization_id,
        runId: run.id,
        operationKey,
        provider: attemptModel.provider,
        model: attemptModel.model,
        fundingSource: attemptCredentials.fundingSource,
        error,
        correlationId: run.correlation_id,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: attemptModel.provider, model: attemptModel.model } });
      await runSteps.finishStep({ stepId: step.id, status: "failed", error });
    },
  }));
  loopResult.provenance = buildGroundingProvenance({
    authorizedTools: allowedTools,
    usedTools,
    unavailableTools,
    retrievalRequested,
    knowledgeMatchCount: knowledgeMatches.length,
  });
  loopResult.usage = await modelCalls.usageForRun(run.organization_id, run.id);
  if (stepExecutionEnabled) {
    const shouldContinue = loopResult.status === "limited"
      && loopResult.iterations > 0
      && loopResult.messages.at(-1)?.role === "tool";
    const shouldPause = loopResult.status === "awaiting_approval"
      || loopResult.status === "awaiting_human"
      || loopResult.status === "awaiting_external_event";
    const nextState = { ...(storedWorkflowState?.state ?? {}) };
    if (shouldContinue || shouldPause) {
      nextState.__agentLoop = durableAgentLoopCheckpoint(loopResult, loopCheckpoint, { stepIndex: activeLoopStep });
    } else if (Object.prototype.hasOwnProperty.call(nextState, "__agentLoop")) {
      delete nextState.__agentLoop;
    }
    if (shouldContinue) {
      await workflowState.put({
        organizationId: run.organization_id,
        runId: run.id,
        expectedRevision: storedWorkflowState?.revision,
        state: nextState,
      });
      return { ...loopResult, checkpointed: true };
    }
    if (shouldPause || loopCheckpoint) {
      await workflowState.put({
        organizationId: run.organization_id,
        runId: run.id,
        expectedRevision: storedWorkflowState?.revision,
        state: nextState,
      });
    }
  }
  return loopResult;
  }
}

type ConfiguredWorkflowRun = Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object;

async function executeConfiguredWorkflow(input: {
  run: ConfiguredWorkflowRun;
  graphInput: unknown;
  inputState: Record<string, unknown>;
  context: ReturnType<typeof buildAgentContext>;
  modelProvider: ModelProvider;
  model: string;
  modelCredentials: ModelCredentials;
  gateway: ModelGateway;
  modelPricing: Record<string, ModelPricing>;
  creditPricing: ModelCreditPricing;
  creditBillingMode: AppConfig["CREDIT_BILLING_MODE"];
  tools: ToolRegistry;
  allowedTools: ReadonlySet<string>;
  runRepository: RunRepository;
  modelCalls: ModelCallRepository;
  toolInvocations: ToolInvocationRepository;
  approvals: ApprovalRepository;
  effectReceipts: EffectReceiptRepository;
  runSteps: RunStepRepository;
  installationGrants: InstallationGrantRepository;
  killSwitches: KillSwitchRepository;
  controls: OperatorControlRepository;
  workflowState: WorkflowStateRepository;
  workflowCheckpoints: WorkflowCheckpointRepository;
  runBudget: RunBudgetRepository;
  coreClient?: KasitekCoreReadClient;
  modelToolContext: ToolInvocationContext;
  conversationActions: ConversationActionService;
  harness: AgentHarness;
  budgetLedger: AgentBudgetLedger;
  runAgentLoop: (input: GraphAgentLoopRequest) => Promise<GraphAgentLoopResult>;
  limits: GraphExecutionLimits;
  /** Enables one-node Temporal continuation for linear graphs during controlled rollout. */
  graphStepActivitiesEnabled: boolean;
  resumeApprovedToolCall?: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"];
  resumeExternalEvent?: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeExternalEvent"];
}): Promise<AgentLoopResult & { checkpointed?: boolean }> {
  let graph: WorkflowGraph;
  try {
    graph = validateWorkflowGraph(input.graphInput).graph;
  } catch (error) {
    return { status: "failed", messages: [], usage: emptyWorkflowUsage(), iterations: 0, toolCalls: 0, error: { code: "WORKFLOW_INVALID", message: error instanceof Error ? error.message : "Workflow graph is invalid" } };
  }
  const persisted = await input.workflowState.get(input.run.organization_id, input.run.id);
  const latestCheckpoint = await input.workflowCheckpoints.getLatest(input.run.organization_id, input.run.id);
  if (latestCheckpoint?.status === "completed" && latestCheckpoint.next_node_id === null) {
    const checkpointOutput = asRecord(latestCheckpoint.output);
    const output = typeof checkpointOutput?.text === "string"
      ? checkpointOutput.text
      : typeof latestCheckpoint.state.output === "string"
        ? latestCheckpoint.state.output
        : typeof latestCheckpoint.state.answer === "string"
          ? latestCheckpoint.state.answer
          : "Workflow completed";
    const response = {
      provider: input.modelProvider,
      model: input.model,
      message: { role: "assistant" as const, content: output },
      toolCalls: [],
      finishReason: "workflow",
      usage: workflowUsage(latestCheckpoint.usage),
      latencyMs: 0,
    };
    const checkpointAuthorization = findAuthorizationRequirement(checkpointOutput) ?? findAuthorizationRequirement(latestCheckpoint.state);
    const completionResponse = checkpointAuthorization
      ? { version: "1" as const, text: output, media: [], authorizationRequired: checkpointAuthorization }
      : undefined;
    return { status: "completed", messages: [response.message], response, ...(completionResponse ? { completionResponse } : {}), usage: response.usage, iterations: latestCheckpoint.trace.length, toolCalls: latestCheckpoint.usage.toolCalls, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools: [], retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  const persistedState = persisted?.state;
  const workflowStateValue = latestCheckpoint?.state
    ?? (persistedState?.__workflowState && typeof persistedState.__workflowState === "object" && !Array.isArray(persistedState.__workflowState)
    ? persistedState.__workflowState as Record<string, unknown>
    : input.inputState);
  const pausedNodeId = latestCheckpoint?.next_node_id
    ?? (typeof persistedState?.__workflowNodeId === "string" ? persistedState.__workflowNodeId : undefined);
  const executionGraph = pausedNodeId && graph.nodes.some((node) => node.id === pausedNodeId) ? { ...graph, entryNodeId: pausedNodeId } : graph;
  const supportsLinearStepContinuation = !executionGraph.nodes.some((node) => node.type === "fan_out" || node.type === "agent_loop");
  const graphStepActivitiesEnabled = input.graphStepActivitiesEnabled && supportsLinearStepContinuation;
  const toolSequence = { value: 0 };
  const usedTools = new Set<string>();
  const workflowJournal = new PostgresExecutionJournal(new RunRepositoryExecutionJournalStore(input.runRepository));
  const workflowJournalScope = executionScopeFromRun(input.run);
  let authorizationRequired: ReturnType<typeof findAuthorizationRequirement>;
  let lastModelResponse: ModelResponse | undefined;

  const executeTool = async (request: { name: string; arguments: Record<string, unknown>; nodeId: string; approved?: unknown }): Promise<unknown> => {
    activityHeartbeat({ phase: "workflow.tool.started", nodeId: request.nodeId, tool: request.name });
    usedTools.add(request.name);
    const manifest = input.harness.get(request.name);
    if (!manifest) throw new Error(`WORKFLOW_TOOL_NOT_FOUND:${request.name}`);
    if (manifest.requiresApproval && !request.approved) throw new Error(`WORKFLOW_APPROVAL_REQUIRED:${request.name}`);
    if (manifest.riskClass === "external-effect" && !request.approved) throw new Error(`WORKFLOW_APPROVAL_REQUIRED:${request.name}`);
    await assertCurrentCapabilityPolicy({
      organizationId: input.run.organization_id,
      installationId: input.run.installation_id,
      name: request.name,
      argumentsValue: request.arguments,
      grantedTools: input.allowedTools,
      tools: input.tools,
      installationGrants: input.installationGrants,
      approved: Boolean(request.approved),
    });
    const argumentsHash = hashToolArguments(request.arguments);
    const providerToolCallId = `workflow:${request.nodeId}`;
    const replayed = await input.toolInvocations.getCompleted({
      organizationId: input.run.organization_id,
      runId: input.run.id,
      providerToolCallId,
      toolName: request.name,
      argumentsHash,
    });
    if (replayed) {
      const safeOutput = redactSensitiveValue(replayed.output);
      activityHeartbeat({ phase: "workflow.tool.replayed", nodeId: request.nodeId, tool: request.name });
      return safeOutput;
    }
    const persistedApproval = manifest.requiresApproval ? await input.approvals.getForRun(input.run.organization_id, input.run.id) : null;
    const resourceSnapshot = request.approved && persistedApproval?.provider_tool_call_id === providerToolCallId
      ? persistedApproval.resource_snapshot
      : await buildApprovalResourceSnapshotFromCore(input.coreClient, toolInvocationContextFromScope(executionScopeFromRun(input.run)), request.name, request.arguments);
    const step = await input.runSteps.startStep({ runId: input.run.id, organizationId: input.run.organization_id, stepType: "tool", input: { toolCallId: providerToolCallId, name: request.name, argumentsHash } });
    await input.toolInvocations.recordProposal({
      organizationId: input.run.organization_id,
      runId: input.run.id,
      providerToolCallId,
      sequenceNumber: toolSequence.value += 1,
      toolName: request.name,
      toolVersion: manifest.version,
      riskClass: manifest.riskClass,
      argumentsHash,
      arguments: request.arguments,
      requiresApproval: manifest.requiresApproval,
    });
    try {
      if (manifest.requiresApproval && manifest.riskClass !== "external-effect") {
        await input.approvals.consume({
          organizationId: input.run.organization_id,
          installationId: input.run.installation_id,
          runId: input.run.id,
          providerToolCallId,
          capability: request.name,
          capabilityVersion: manifest.version,
          argumentsHash,
          resourceSnapshot,
          previewRevision: argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${input.run.id}:${providerToolCallId}`,
        });
      }
      await consumeRunToolBudget(input.runBudget, { organizationId: input.run.organization_id, runId: input.run.id });
      const result = await withActivityHeartbeat({ phase: "workflow.tool.running", nodeId: request.nodeId, tool: request.name }, () => input.harness.capabilities.invoke({
        name: request.name,
        arguments: request.arguments,
        context: toolInvocationContextFromScope(executionScopeFromRun(input.run), {
          memoryPolicy: input.run.policy && typeof input.run.policy.memory === "object" && !Array.isArray(input.run.policy.memory) ? input.run.policy.memory as Record<string, unknown> : undefined,
          approvalSnapshotHash: approvalSnapshotHashFromResource(resourceSnapshot),
          signal: currentActivitySignal(),
        }),
        signal: currentActivitySignal(),
        grantedTools: input.allowedTools,
        approval: request.approved as Parameters<ToolRegistry["invoke"]>[0]["approval"],
        beforeEffect: manifest.riskClass === "external-effect" ? async () => {
          if (!(await input.controls.isFeatureEnabled(input.run.organization_id, "effect_execution_enabled", input.run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
          if (await input.controls.isHeld({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
          await input.approvals.consumeAndStartEffect({
            organizationId: input.run.organization_id,
            installationId: input.run.installation_id,
            runId: input.run.id,
            providerToolCallId,
            capability: request.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            resourceSnapshot,
            previewRevision: argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${input.run.id}:${providerToolCallId}`,
            effectIdempotencyKey: `${input.run.id}:${request.name}:${argumentsHash}`,
          });
        } : undefined,
      }));
      const toolAuthorization = findAuthorizationRequirement(result.output);
      const safeOutput = redactSensitiveValue(result.output);
      const durableOutput = redactToolOutput(result.output, manifest.manifest?.redaction ?? []);
      if (toolAuthorization) authorizationRequired = toolAuthorization;
      await input.toolInvocations.recordCompleted({ runId: input.run.id, providerToolCallId, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId });
      await input.runSteps.finishStep({ stepId: step.id, status: "completed", output: { latencyMs: result.latencyMs } });
      activityHeartbeat({ phase: "workflow.tool.completed", nodeId: request.nodeId, tool: request.name });
      if (result.effectId) await input.effectReceipts.markSucceededByKey(input.run.organization_id, `${input.run.id}:${request.name}:${argumentsHash}`, durableOutput);
      return safeOutput;
    } catch (error) {
      const normalized = { code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "WORKFLOW_TOOL_FAILED", message: error instanceof Error ? error.message : "Workflow tool failed" };
      await input.toolInvocations.recordFailed({ runId: input.run.id, providerToolCallId, error: normalized });
      await input.runSteps.finishStep({ stepId: step.id, status: "failed", error: normalized });
      throw error;
    }
  };

  const result = await executeWorkflowGraph(executionGraph, workflowStateValue, {
    limits: input.limits,
    signal: currentActivitySignal(),
    resume: latestCheckpoint ? {
      edgeIterations: latestCheckpoint.edge_iterations,
      nodeIterations: latestCheckpoint.node_iterations,
      steps: latestCheckpoint.steps,
      trace: latestCheckpoint.trace,
      usage: latestCheckpoint.usage,
    } : undefined,
    stopAfterCheckpoint: graphStepActivitiesEnabled,
    reserveParallelBranchCapacity: async ({ branches }) => input.runBudget.reserveParallelBranchCapacity({
      organizationId: input.run.organization_id,
      runId: input.run.id,
      branches,
    }),
    budgetLedger: input.budgetLedger,
    model: async ({ nodeId, config, state, parallelLeaseId }) => {
      const result = await input.runAgentLoop({
        nodeId,
        config,
        state,
        maxIterations: 1,
        usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        limits: input.limits,
        ...(parallelLeaseId ? { parallelLeaseId } : {}),
      });
      if (result.response) lastModelResponse = result.response;
      if (result.status !== "completed") {
        throw new Error(`WORKFLOW_MODEL_${result.status.toUpperCase()}`);
      }
      return {
        output: result.output ?? result.response?.message.content,
        text: result.output ?? result.response?.message.content,
        usage: {
          ...(result.usage ?? {}),
          estimatedCostUsd: result.usage?.estimatedCostUsd ?? 0,
        },
      };
    },
    agentLoop: input.runAgentLoop,
    tool: executeTool,
    resumeApprovedToolCall: input.resumeApprovedToolCall,
    resumeExternalEvent: input.resumeExternalEvent,
    checkpoint: async (checkpoint) => {
      await input.workflowCheckpoints.put({
        organizationId: input.run.organization_id,
        runId: input.run.id,
        nodeId: checkpoint.nodeId,
        nextNodeId: checkpoint.nextNodeId,
        status: checkpoint.status,
        state: checkpoint.state,
        output: checkpoint.output,
        trace: checkpoint.trace,
        edgeIterations: checkpoint.edgeIterations,
        nodeIterations: checkpoint.nodeIterations,
        steps: checkpoint.steps,
        usage: checkpoint.usage,
        idempotencyKey: checkpoint.idempotencyKey,
      });
    },
  });

  if (result.checkpointed) {
    return {
      status: "limited",
      messages: [],
      usage: workflowUsage(result.usage),
      iterations: result.trace.length,
      toolCalls: result.usage.toolCalls,
      checkpointed: true,
      provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }),
    };
  }

  if (result.status === "awaiting_approval") {
    const pending = result.pendingToolCalls?.[0];
    if (!pending) return { status: "failed", messages: [], usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, error: { code: "WORKFLOW_APPROVAL_UNCONFIGURED", message: "Approval node must identify a capability and arguments" } };
    const manifest = input.harness.get(pending.name);
    if (!manifest) return { status: "failed", messages: [], usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, error: { code: "WORKFLOW_TOOL_NOT_FOUND", message: `Workflow tool is not registered: ${pending.name}` } };
    const approvalAlreadyRecorded = executionGraph.nodes.find((node) => node.id === result.pausedAt)?.type === "agent_loop";
    if (!approvalAlreadyRecorded) {
      await input.toolInvocations.recordProposal({ organizationId: input.run.organization_id, runId: input.run.id, providerToolCallId: pending.id, sequenceNumber: toolSequence.value + 1, toolName: pending.name, toolVersion: manifest.version, riskClass: manifest.riskClass, argumentsHash: pending.argumentsHash, arguments: pending.arguments, requiresApproval: true });
      await input.approvals.createPending({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, providerToolCallId: pending.id, capability: pending.name, capabilityVersion: manifest.version, argumentsHash: pending.argumentsHash, resourceSnapshot: await buildApprovalResourceSnapshotFromCore(input.coreClient, toolInvocationContextFromScope(executionScopeFromRun(input.run)), pending.name, pending.arguments), previewRevision: pending.argumentsHash, policyRevision: "v1", permittedEffectKey: `${input.run.id}:${pending.id}`, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
      if (manifest.riskClass === "external-effect") await input.effectReceipts.reserve({ organizationId: input.run.organization_id, installationId: input.run.installation_id, runId: input.run.id, providerToolCallId: pending.id, capability: pending.name, capabilityVersion: manifest.version, argumentsHash: pending.argumentsHash, idempotencyKey: `${input.run.id}:${pending.name}:${pending.argumentsHash}` });
    }
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: result.pausedAt, __workflowState: result.state } });
    await workflowJournal.append({ scope: workflowJournalScope, event: { kind: "operation.waiting", data: { reason: "approval", resumeKey: pending.id } } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.approval.pending", payload: { nodeId: result.pausedAt, capability: pending.name, providerToolCallId: pending.id } });
    return { status: "awaiting_approval", messages: [], pendingToolCalls: [pending], usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "awaiting_external_event") {
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: result.pausedAt, __workflowState: result.state } });
    await workflowJournal.append({ scope: workflowJournalScope, event: { kind: "operation.waiting", data: { reason: "external_event", resumeKey: result.waitingFor } } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.external_event.pending", payload: { nodeId: result.pausedAt, waitingFor: result.waitingFor } });
    return { status: "awaiting_external_event", messages: [], usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, waitingFor: result.waitingFor, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "awaiting_human") {
    const offer = input.run.conversation_id
      ? await input.conversationActions.offerHandoff(toolInvocationContextFromScope(executionScopeFromRun(input.run)), {
        reason: "configured_workflow",
        summary: `Configured workflow requested human handoff${result.waitingFor ? ` (${result.waitingFor})` : ""}.`,
        metadata: { handoffKey: result.waitingFor ?? result.pausedAt ?? "handoff", nodeId: result.pausedAt ?? null },
        idempotencyKey: `workflow-handoff:${input.run.id}:${result.waitingFor ?? result.pausedAt ?? "handoff"}`,
      })
      : null;
    await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: null, __workflowState: result.state } });
    await workflowJournal.append({ scope: workflowJournalScope, event: { kind: "operation.waiting", data: { reason: "operator", resumeKey: offer?.handoffOfferId ?? result.waitingFor } } });
    await input.runRepository.appendEvent({ organizationId: input.run.organization_id, runId: input.run.id, installationId: input.run.installation_id, eventType: "agent.workflow.handoff.offer", payload: { nodeId: result.pausedAt, waitingFor: result.waitingFor, handoffOfferId: offer?.handoffOfferId } });
    const response = lastModelResponse ?? {
      provider: input.modelProvider,
      model: input.model,
      message: { role: "assistant" as const, content: "Would you like me to connect you with a human?" },
      toolCalls: [],
      finishReason: "handoff_offer",
      usage: emptyWorkflowUsage(),
      latencyMs: 0,
    };
    return { status: "completed", messages: [response.message], response, usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  }
  if (result.status === "failed") return { status: "failed", messages: [], usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, error: { code: "WORKFLOW_FAILED", message: result.error ?? "Workflow execution failed" }, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
  await input.workflowState.put({ organizationId: input.run.organization_id, runId: input.run.id, expectedRevision: persisted?.revision, state: { __workflowNodeId: null, __workflowState: result.state } });
  const workflowResponse = (() => {
    const candidate = result.state.response ?? result.state.output;
    if (candidate === undefined) return undefined;
    try {
      return parseAgentResponse(candidate);
    } catch {
      return undefined;
    }
  })();
  const output = workflowResponse?.text
    || (typeof result.state.output === "string" ? result.state.output : typeof result.state.answer === "string" ? result.state.answer : lastModelResponse?.message.content ?? "Workflow completed");
  const response = lastModelResponse ?? { provider: input.modelProvider, model: input.model, message: { role: "assistant" as const, content: output }, toolCalls: [], finishReason: "workflow", usage: emptyWorkflowUsage(), latencyMs: 0 };
  const workflowAuthorization = authorizationRequired ?? result.authorizationRequired ?? findAuthorizationRequirement(workflowResponse) ?? findAuthorizationRequirement(result.state);
  const completionResponse = workflowResponse
    ? workflowAuthorization && !workflowResponse.authorizationRequired
      ? { ...workflowResponse, authorizationRequired: workflowAuthorization }
      : workflowResponse
    : workflowAuthorization
      ? { version: "1" as const, text: output, media: [], authorizationRequired: workflowAuthorization }
      : undefined;
  return { status: "completed", messages: [response.message], response, ...(completionResponse ? { completionResponse } : {}), usage: workflowUsage(result.usage), iterations: result.trace.length, toolCalls: result.usage.toolCalls, provenance: buildGroundingProvenance({ authorizedTools: input.allowedTools, usedTools, retrievalRequested: input.context.retrievalRequested, knowledgeMatchCount: 0 }) };
}

function workflowUsage(usage: GraphExecutionUsage): { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number } {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function emptyWorkflowUsage(): { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number } {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}
