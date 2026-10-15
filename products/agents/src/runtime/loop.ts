import { ModelGateway } from "../model/gateway";
import type { ModelCredentials, ModelMessage, ModelRequest, ModelResponse, ModelToolCall, ModelToolDefinition } from "../model/types";
import { ModelProviderError } from "../model/types";
import { estimatePromptTokens } from "../model/credit-pricing";
import { approvalSnapshotHashFromResource, ToolPolicyError, type CapabilityPresentationMetadata, type ToolApproval, type ToolDefinition, type ToolInvocationContext, type ToolInvocationLifecycle, type ToolInvocationResult } from "../tools/types";
import { hashToolArguments } from "../tools/registry";
import type { AgentHarnessRunStatus, AgentToolSurface } from "./harness";
import { classifyFailureCode } from "./failures";
import { redactSensitiveValue, redactToolOutput } from "../tools/redaction";
import type { GroundingProvenance } from "./provenance";
import { buildApprovedToolCompletionMessage, buildApprovedToolFailureMessage } from "./approved-tool-completion";
import { agentResponseSchema, findAuthorizationRequirement, type AgentAuthorizationRequirement, type AgentResponse } from "../media/contracts";
import { projectCapabilityResultUi } from "../media/dynamic-ui";
import { prepareModelMessages } from "./message-context";
import { createAgentBudgetLedger, type AgentBudgetLedger } from "./budget";
import { mapBounded, planToolBatch } from "./tool-batch";
import {
  accountProviderUsage,
  planProviderRequest,
  type ContextRequestManifest,
  type ContextPlanningPolicy,
  type ProviderContextProfile,
} from "./context-planning";
import { contextCapabilityCorrectionFromProviderError, resolveContextCapability } from "./context-capability";
import { createContextUsageAnchor } from "./context-usage-anchor";
import type {
  ContextAttemptBudgetPort,
  ContextAttemptBudgetReceipt,
} from "./context-attempt-budget";
import type { EffectiveCapabilitySnapshot } from "./effective-capabilities";
import type { TranscriptSourceIdentity } from "./tool-transcript";
import {
  memoryEvidencePrompt,
  sourceEventBoundaryFromMessages,
  type MemoryEvidencePack,
  type MemoryRetrievalPort,
  type MemoryRuntimeScope,
} from "./context-memory-boundary";

export interface AgentLoopLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd?: number;
  maxWallTimeMs: number;
  /** Number of same-model retries allowed after an empty final response. */
  maxEmptyResponseRetries: number;
}

export interface AgentLoopEvent {
  type: "loop.started" | "context.capability_resolved" | "context.planned" | "context.recovery" | "model.started" | "model.first_token" | "model.completed" | "model.failed" | "route.selected" | "tool.proposed" | "tool.started" | "tool.completed" | "tool.failed" | "loop.paused" | "loop.completed" | "loop.failed" | "loop.limited" | "memory_retrieval_requested" | "memory_retrieval_completed" | "memory_retrieval_blocked";
  iteration: number;
  payload: Record<string, unknown>;
}

export interface AgentLoopInput {
  model: Pick<ModelRequest, "provider" | "model" | "temperature" | "maxTokens">;
  messages: ModelMessage[];
  credentials: ModelCredentials;
  fallbackModels?: Array<{
    model: Pick<ModelRequest, "provider" | "model" | "temperature" | "maxTokens">;
    credentials: ModelCredentials;
  }>;
  gateway: ModelGateway;
  tools: AgentToolSurface;
  toolContext: ToolInvocationContext;
  grantedTools: ReadonlySet<string>;
  /** Required by production capability runtimes for durable proposal/replay/evidence. */
  toolLifecycle?: ToolInvocationLifecycle;
  /** Model-facing capability projection selected by ContextPolicy for this turn. */
  modelTools?: Array<Omit<ToolDefinition, "handler">>;
  /** Immutable per-run capability projection used to derive modelTools. */
  capabilitySnapshot?: EffectiveCapabilitySnapshot;
  /** Provider-aware model-boundary contract. When present, this replaces rough prompt-only admission. */
  contextProfile?: ProviderContextProfile;
  /** Resolves provider/model capacity again for each fallback attempt. */
  contextCapabilityResolver?: (input: { provider: AgentLoopInput["model"]["provider"]; model: string; profile: ProviderContextProfile; credentialRouteId?: string; credentials: ModelCredentials }) => Promise<ProviderContextProfile | undefined> | ProviderContextProfile | undefined;
  /** Persists an evidence-backed provider capacity correction. */
  recordContextCapabilityCorrection?: (input: { provider: AgentLoopInput["model"]["provider"]; model: string; profile: ProviderContextProfile; credentialRouteId?: string; correction: { contextWindowTokens?: number; maxOutputTokens?: number } }) => Promise<void> | void;
  /** Production autonomous turns fail closed if no safe provider capacity is available. */
  requireContextCapability?: boolean;
  /** Opt into adapter streaming so first-token timing can be recorded. */
  streamModel?: boolean;
  /** Durable generation of the context projection used by this turn. */
  contextCompactionGeneration?: number;
  /** Canonical transcript head sequence used by this turn's model requests. */
  contextSourceCursor?: number;
  /** Canonical transcript generation used by this turn's model requests. */
  contextSourceGeneration?: number;
  /** Digest of the canonical active projection used by this turn's model requests. */
  contextSourceProjectionDigest?: string;
  /** Digest of the canonical transcript head used by this turn's model requests. */
  contextSourceHeadDigest?: string;
  /** Durable run admission time, separate from harness execution start. */
  admittedAt?: string;
  /** Stable turn identity shared with memory and context journal events. */
  turnId?: string;
  /** Memory is an injected evidence source; it does not own request assembly. */
  memoryRetrievalPort?: MemoryRetrievalPort;
  memoryScope?: MemoryRuntimeScope;
  memoryRetrievalQuery?: string;
  memoryRetrievalReason?: string;
  memoryMaxEvidenceTokens?: number;
  memorySourceEventIds?: readonly string[];
  /** Optional typed preflight result. The loop consumes it once when its source boundary matches. */
  memoryRetrievalPack?: MemoryEvidencePack;
  memoryRetrievalPackBoundaryDigest?: string;
  /** Maximum number of parallel-safe capability calls in flight for one batch segment. */
  maxParallelToolCalls?: number;
  /** Return a durable batch checkpoint instead of invoking tools in this loop Activity. */
  deferToolExecution?: boolean;
  /** Per-agent limits for tool schemas/results and response reservation. */
  contextPlanningPolicy?: Partial<ContextPlanningPolicy>;
  budgetLedger?: AgentBudgetLedger;
  signal?: AbortSignal;
  /** Prefix used to keep durable operation keys unique across hosted loop contexts. */
  operationKeyPrefix?: string;
  /** Optional durable budget shared by context recovery and provider retries. */
  contextAttemptBudget?: ContextAttemptBudgetPort;
  contextAttemptBudgetId?: string;
  /** Persists the bounded manifest before a provider dispatch. */
  persistContextManifest?: (input: {
    provider: string;
    model: string;
    status: "fits" | "compacted" | "rejected";
    decision: "ready" | "compact" | "prune" | "limited" | "cannot_fit";
    manifest: ContextRequestManifest;
  }) => Promise<void> | void;
  /** Durable fan-out admission lease used by the first model/tool operation in a branch. */
  parallelLeaseId?: string;
  limits?: Partial<AgentLoopLimits>;
  onEvent?: (event: AgentLoopEvent) => Promise<void> | void;
  /** Claims the operation before a provider call and prevents unsafe replay after worker loss. */
  prepareModelCall?: (input: {
    operationKey: string;
    model: AgentLoopInput["model"];
    credentials: ModelCredentials;
  }) => Promise<{ status: "new" | "completed" | "unknown"; response?: ModelResponse }>;
  /** Persists a provider response before budget settlement and later loop bookkeeping. */
  persistModelResponse?: (input: {
    operationKey: string;
    response: ModelResponse;
    attempt: { model: AgentLoopInput["model"]; credentials: ModelCredentials };
  }) => Promise<void> | void;
  onModelResponse?: (response: ModelResponse, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }, operationKey?: string) => Promise<void> | void;
  persistModelError?: (input: {
    operationKey: string;
    model: AgentLoopInput["model"];
    credentials: ModelCredentials;
    error: { code: string; message: string };
  }) => Promise<void> | void;
  onModelError?: (error: { code: string; message: string }, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }, operationKey?: string) => Promise<void> | void;
  reserveModelCall?: (input: {
    request: ModelRequest;
    credentials: ModelCredentials;
    operationKey?: string;
  }) => Promise<ModelCreditReservation | undefined>;
  reserveRunBudget?: (input: {
    request: ModelRequest;
    reservationKey: string;
    parallelLeaseId?: string;
    /** The context runtime's authoritative manifest accounting for this request. */
    estimatedInputTokens?: number;
    reservedOutputTokens?: number;
    contextManifestDigest?: string;
  }) => Promise<ModelCreditReservation | undefined>;
  consumeRunToolCall?: (input?: { parallelLeaseId?: string }) => Promise<void>;
  /** Replays a completed tool outcome after a worker retry without invoking the handler again. */
  replayToolInvocation?: (input: {
    toolCallId: string;
    runtimeOperationId: string;
    name: string;
    argumentsHash: string;
  }) => Promise<ToolInvocationResult | undefined>;
  /** Rehydrates the last server-owned view while a stepped loop continues from a checkpoint. */
  resumeUi?: AgentResponse["ui"];
  /** Selects a registered presentation channel; unsupported channels retain text fallback only. */
  uiChannel?: CapabilityPresentationMetadata["channels"][number];
  /** Allows a scoped rollout to disable rich projections without changing response text. */
  dynamicUiEnabled?: boolean;
  beforeModelCall?: () => Promise<void> | void;
  beforeToolInvoke?: (input: {
    toolCallId: string;
    runtimeOperationId: string;
    name: string;
    arguments: Record<string, unknown>;
    approved: boolean;
  }) => Promise<void> | void;
  onToolProposed?: (input: {
    toolCallId: string;
    runtimeOperationId: string;
    name: string;
    version: string;
    riskClass: string;
    arguments: Record<string, unknown>;
    argumentsHash: string;
    requiresApproval: boolean;
    sequenceNumber: number;
  }) => Promise<void> | void;
  onToolExecuting?: (input: {
    toolCallId: string;
    runtimeOperationId: string;
    name: string;
    version: string;
    arguments: Record<string, unknown>;
    argumentsHash: string;
    requiresApproval: boolean;
  }) => Promise<void> | void;
  onToolCompleted?: (input: {
    toolCallId: string;
    runtimeOperationId: string;
    name: string;
    argumentsHash: string;
    output: unknown;
    latencyMs: number;
    effectId?: string;
    approval?: ToolApproval;
  }) => Promise<void> | void;
  onToolFailed?: (input: { toolCallId: string; runtimeOperationId: string; name: string; argumentsHash?: string; error: { code: string; message: string } }) => Promise<void> | void;
  resumeApprovedToolCall?: {
    id: string;
    providerToolCallId?: string;
    name: string;
    arguments: Record<string, unknown>;
    approval: ToolApproval;
  };
}

export interface ModelCreditReservation {
  capture(response: ModelResponse): Promise<void>;
  release(reason: string): Promise<void>;
  markUnknown?(reason: string): Promise<void>;
}

export interface AgentLoopResult {
  status: AgentHarnessRunStatus;
  messages: ModelMessage[];
  response?: ModelResponse;
  completionMessage?: string;
  completionResponse?: AgentResponse;
  /**
   * Result for a direct durable capability invocation (MCP/REST).
   *
   * These runs do not execute a model turn and therefore must not be forced
   * through the assistant-response delivery path. The output is already
   * redacted by the capability activity before it crosses the durable
   * workflow boundary.
   */
  directToolResult?: {
    name: string;
    output: unknown;
  };
  /** Set when an approved batch was admitted but Core still reports PROCESSING. */
  pendingBatch?: {
    toolName: "kasitek.core.content_post_publish_batch" | "kasitek.core.content_post_publish_batch_retry";
    batchId: string;
    title?: string;
  };
  pendingToolCalls?: Array<{ id: string; providerToolCallId?: string; name: string; arguments: Record<string, unknown>; argumentsHash: string; approvalGroupId?: string; approvalPlanDigest?: string }>;
  /** The model response is persisted and must be executed by the durable host before continuation. */
  toolBatchPending?: boolean;
  /** Immutable authorization projection pinned when the model emitted the deferred batch. */
  authorizedToolNames?: string[];
  /** Digest of the effective capability projection used for the deferred batch. */
  capabilitySnapshotDigest?: string;
  /** Canonical transcript identity used by the deferred model request. */
  transcriptSource?: TranscriptSourceIdentity;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
  iterations: number;
  toolCalls: number;
  error?: { code: string; message: string; failureClass?: "retryable" | "terminal"; userMessage?: string; remediation?: string };
  waitingFor?: string;
  ui?: AgentResponse["ui"];
  provenance?: GroundingProvenance;
}

function pendingBatchFromOutput(
  toolName: string,
  outputValue: unknown,
): AgentLoopResult["pendingBatch"] {
  if (toolName !== "kasitek.core.content_post_publish_batch" && toolName !== "kasitek.core.content_post_publish_batch_retry") return undefined;
  if (!outputValue || typeof outputValue !== "object" || Array.isArray(outputValue)) return undefined;
  const output = outputValue as Record<string, unknown>;
  const batch = output.batch;
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return undefined;
  const batchRecord = batch as Record<string, unknown>;
  if (String(batchRecord.status ?? "").toUpperCase() !== "PROCESSING") return undefined;
  const batchId = typeof batchRecord.batchId === "string" ? batchRecord.batchId.trim() : "";
  if (!batchId) return undefined;
  const post = output.post;
  const title = post && typeof post === "object" && !Array.isArray(post) && typeof (post as Record<string, unknown>).title === "string"
    ? ((post as Record<string, unknown>).title as string).trim().slice(0, 240)
    : undefined;
  return {
    toolName: toolName as "kasitek.core.content_post_publish_batch" | "kasitek.core.content_post_publish_batch_retry",
    batchId,
    ...(title ? { title } : {}),
  };
}

const defaultLimits: AgentLoopLimits = {
  maxIterations: 8,
  maxToolCalls: 16,
  maxTotalTokens: 32_000,
  maxWallTimeMs: 60_000,
  maxEmptyResponseRetries: 2,
};

async function emit(input: AgentLoopInput, event: AgentLoopEvent): Promise<void> {
  await input.onEvent?.(event);
}

function runtimeOperationIdForToolCall(operationKey: string, index: number): string {
  return `${operationKey}:tool:${index + 1}`;
}

function attachRuntimeOperationIds(response: ModelResponse, operationKey: string): ModelResponse {
  const toolCalls = response.toolCalls.map((call, index) => ({
    ...call,
    runtimeOperationId: call.runtimeOperationId ?? runtimeOperationIdForToolCall(operationKey, index),
  }));
  return {
    ...response,
    toolCalls,
    message: {
      ...response.message,
      ...(toolCalls.length ? { toolCalls } : {}),
    },
  };
}

export async function runBoundedAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  // Callers pass optional configuration fields explicitly. Unset fields must
  // preserve the defaults; an intentional zero still remains an execution limit.
  const limits: AgentLoopLimits = { ...defaultLimits,
    ...Object.fromEntries(Object.entries(input.limits ?? {}).filter(([, value]) => value !== undefined)) };
  const budget = input.budgetLedger ?? createAgentBudgetLedger({ contextTokens: limits.maxTotalTokens, modelTokens: limits.maxTotalTokens, toolCalls: limits.maxToolCalls, wallTimeMs: limits.maxWallTimeMs });
  const messages = [...input.messages];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
  let toolCalls = 0;
  const identicalToolCallCounts = new Map<string, number>();
  let authorizationRequired: AgentAuthorizationRequirement | undefined;
  let lastToolUi: AgentResponse["ui"] | undefined = input.dynamicUiEnabled === false ? undefined : input.resumeUi;
  let lastModelAttempt: { model: AgentLoopInput["model"]; credentials: ModelCredentials } = { model: input.model, credentials: input.credentials };
  let lastModelOperationKey: string | undefined;
  let emptyResponseRetries = 0;
  let memoryEvidenceBoundaryDigest: string | undefined;
  let memoryPreloadedPackConsumed = false;
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  await emit(input, {
    type: "loop.started",
    iteration: 0,
    payload: {
      phase: "turn",
      admittedAt: input.admittedAt ?? startedAtIso,
      startedAt: startedAtIso,
      budget: { maxTotalTokens: limits.maxTotalTokens },
    },
  });

  if (input.resumeApprovedToolCall) {
  try {
      const resumed = input.resumeApprovedToolCall;
      const resumedProviderToolCallId = resumed.providerToolCallId ?? resumed.id;
      const resumedRuntimeOperationId = resumed.id;
      const resumedManifest = input.tools.get(resumed.name);
      await input.beforeToolInvoke?.({
        toolCallId: resumedProviderToolCallId,
        runtimeOperationId: resumedRuntimeOperationId,
        name: resumed.name,
        arguments: resumed.arguments,
        approved: true,
      });
      const resumedArgumentsHash = hashToolArguments(resumed.arguments);
      const replayed = await input.replayToolInvocation?.({ toolCallId: resumedProviderToolCallId, runtimeOperationId: resumedRuntimeOperationId, name: resumed.name, argumentsHash: resumedArgumentsHash });
      if (replayed && (replayed.name !== resumed.name || replayed.argumentsHash !== resumedArgumentsHash)) {
        throw new ToolPolicyError("TOOL_REPLAY_SCOPE_CONFLICT", "A durable tool outcome did not match the approved tool call");
      }
      if (!replayed) await input.onToolProposed?.({
        toolCallId: resumedProviderToolCallId,
        runtimeOperationId: resumedRuntimeOperationId,
        name: resumed.name,
        version: resumedManifest?.version ?? "unknown",
        riskClass: resumedManifest?.riskClass ?? "privileged",
        arguments: resumed.arguments,
        argumentsHash: resumedArgumentsHash,
        requiresApproval: resumedManifest?.requiresApproval ?? true,
        sequenceNumber: 1,
      });
      if (!replayed) await input.consumeRunToolCall?.({ parallelLeaseId: input.parallelLeaseId });
      await emit(input, { type: "route.selected", iteration: 0, payload: { sourceStageId: "model", targetStageId: `capability:${resumed.name}`, operationId: resumedRuntimeOperationId, toolCallId: resumedProviderToolCallId } });
      await emit(input, {
        type: "tool.started",
        iteration: 0,
        payload: {
          toolCallId: resumedProviderToolCallId,
          operationId: resumedRuntimeOperationId,
          name: resumed.name,
          startedAt: new Date().toISOString(),
          ...(replayed ? { replayed: true } : {}),
        },
      });
      const result = replayed ?? await input.tools.invoke({
          name: resumed.name,
          arguments: resumed.arguments,
          context: {
            ...input.toolContext,
            ...(resumed.approval.resourceSnapshot && typeof resumed.approval.resourceSnapshot === "object"
              ? { approvalSnapshotHash: approvalSnapshotHashFromResource(resumed.approval.resourceSnapshot) }
              : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
          signal: input.signal,
          grantedTools: input.grantedTools,
          operationId: resumedRuntimeOperationId,
          sequenceNumber: 1,
          lifecycle: input.toolLifecycle,
          approval: resumed.approval,
          beforeEffect: resumedManifest?.riskClass === "external-effect" ? async () => {
            await input.onToolExecuting?.({
              toolCallId: resumedProviderToolCallId,
              runtimeOperationId: resumedRuntimeOperationId,
              name: resumed.name,
              version: resumedManifest.version,
              arguments: resumed.arguments,
              argumentsHash: resumedArgumentsHash,
              requiresApproval: resumedManifest.requiresApproval,
            });
          } : undefined,
        });
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: resumedProviderToolCallId, name: resumed.name, arguments: resumed.arguments, runtimeOperationId: resumedRuntimeOperationId }] });
      const authorization = findAuthorizationRequirement(result.output);
      const safeOutput = redactSensitiveValue(result.output);
      const pendingBatch = pendingBatchFromOutput(resumed.name, safeOutput);
      const durableOutput = redactToolOutput(result.output, resumedManifest?.manifest?.redaction ?? []);
      const resumedUi = input.dynamicUiEnabled === false ? undefined : projectCapabilityResultUi({ presentation: resumedManifest?.manifest?.presentation, output: durableOutput, channel: input.uiChannel ?? "platform" });
      if (resumedUi || resumedManifest?.manifest?.presentation) lastToolUi = resumedUi;
      authorizationRequired = authorization;
      messages.push({ role: "tool", name: resumed.name, toolCallId: resumedProviderToolCallId, runtimeOperationId: resumedRuntimeOperationId, content: JSON.stringify(safeOutput) });
      toolCalls += 1;
      if (!replayed) await input.onToolCompleted?.({ toolCallId: resumedProviderToolCallId, runtimeOperationId: resumedRuntimeOperationId, name: resumed.name, argumentsHash: resumedArgumentsHash, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId, approval: resumed.approval });
      await emit(input, {
        type: "tool.completed",
        iteration: 0,
        payload: {
          toolCallId: resumedProviderToolCallId,
          operationId: resumedRuntimeOperationId,
          name: resumed.name,
          resumed: true,
          latencyMs: result.latencyMs,
          ...(authorizationRequired ? { authorizationRequired } : {}),
        },
      });
      const completionMessage = buildApprovedToolCompletionMessage(resumed.name, resumed.arguments, safeOutput);
      messages.push({ role: "assistant", content: completionMessage });
      await emit(input, { type: "loop.completed", iteration: 0, payload: { toolCalls, totalTokens: usage.totalTokens, resumed: true } });
      return {
        status: "completed",
        messages,
        completionMessage,
        ...(pendingBatch ? { pendingBatch } : {}),
        ...(authorizationRequired || lastToolUi
          ? { completionResponse: { version: "1" as const, text: completionMessage, media: [], ...(authorizationRequired ? { authorizationRequired } : {}), ...(lastToolUi ? { ui: lastToolUi } : {}) } }
          : {}),
        usage,
        iterations: 0,
        toolCalls,
      };
    } catch (error) {
      const normalized = error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : { code: "APPROVED_TOOL_FAILED", message: error instanceof Error ? error.message : "Approved tool failed", failureClass: "terminal" as const };
      const failure = {
        ...normalized,
        userMessage: buildApprovedToolFailureMessage(input.resumeApprovedToolCall.name, error, input.resumeApprovedToolCall.arguments),
      };
      await emit(input, {
        type: "tool.failed",
        iteration: 0,
        payload: {
          toolCallId: input.resumeApprovedToolCall.providerToolCallId ?? input.resumeApprovedToolCall.id,
          operationId: input.resumeApprovedToolCall.id,
          name: input.resumeApprovedToolCall.name,
          error: normalized,
          failedAt: new Date().toISOString(),
        },
      });
      await input.onToolFailed?.({ toolCallId: input.resumeApprovedToolCall.providerToolCallId ?? input.resumeApprovedToolCall.id, runtimeOperationId: input.resumeApprovedToolCall.id, name: input.resumeApprovedToolCall.name, argumentsHash: hashToolArguments(input.resumeApprovedToolCall.arguments), error: normalized });
      await emit(input, { type: "loop.failed", iteration: 0, payload: failure });
      return { status: "failed", messages, usage, iterations: 0, toolCalls, error: failure };
    }
  }

  for (let iteration = 1; iteration <= limits.maxIterations; iteration += 1) {
    if (Date.now() - startedAt >= limits.maxWallTimeMs) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "wall_clock" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
    }
    if (usage.totalTokens >= limits.maxTotalTokens || (limits.maxEstimatedCostUsd !== undefined && usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "budget" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
    }
  const remainingTokens = Math.max(1, limits.maxTotalTokens - usage.totalTokens);
    try {
      if (input.memoryRetrievalPort) {
        const sourceEventBoundary = sourceEventBoundaryFromMessages(messages, input.memorySourceEventIds);
        if (sourceEventBoundary.digest !== memoryEvidenceBoundaryDigest && !(input.memoryRetrievalPack && memoryPreloadedPackConsumed)) {
          const runId = input.toolContext.runId;
          const turnId = input.turnId ?? runId;
          const attemptId = `${input.operationKeyPrefix ?? "model"}:${iteration}:memory`;
          // Memory retrieval is admitted only with a typed planner intent. The
          // runtime never turns free-form prompt text into a storage query.
          const reason = input.memoryRetrievalReason ?? "semantic_context";
          await emit(input, {
            type: "memory_retrieval_requested",
            iteration,
            payload: {
              runId,
              turnId,
              attemptId,
              compactionGeneration: input.contextCompactionGeneration ?? 0,
              sourceEventBoundaryDigest: sourceEventBoundary.digest,
              reason,
            },
          });
          memoryEvidenceBoundaryDigest = sourceEventBoundary.digest;
          if (!input.memoryScope) {
            await emit(input, { type: "memory_retrieval_blocked", iteration, payload: { runId, turnId, attemptId, reason: "scope_missing", errorCode: "MEMORY_RETRIEVAL_SCOPE_MISSING" } });
          } else {
            try {
              const preflightPack = input.memoryRetrievalPack
                && input.memoryRetrievalPackBoundaryDigest === sourceEventBoundary.digest
                ? input.memoryRetrievalPack
                : undefined;
              const pack = preflightPack ?? await input.memoryRetrievalPort.retrieve({
                  runId,
                  turnId,
                  attemptId,
                  compactionGeneration: input.contextCompactionGeneration ?? 0,
                  sourceEventBoundary,
                  scope: input.memoryScope,
                  reason,
                  query: input.memoryRetrievalQuery ?? lastUserMessage(messages),
                  ...(input.memoryMaxEvidenceTokens === undefined ? {} : { maxEvidenceTokens: input.memoryMaxEvidenceTokens }),
                });
              if (preflightPack) memoryPreloadedPackConsumed = true;
              if (pack.status === "blocked") {
                await emit(input, { type: "memory_retrieval_blocked", iteration, payload: { runId, turnId, attemptId, reason: pack.blockedReason ?? "memory_provider_blocked", packId: pack.packId } });
                if (/(?:MEMORY_SCOPE|MEMORY_RETRIEVAL_INTENT|MEMORY_POLICY|MEMORY_AUTH)/u.test(pack.blockedReason ?? "")) {
                  throw Object.assign(new Error(pack.blockedReason ?? "Memory retrieval was blocked"), { code: "MEMORY_RETRIEVAL_BLOCKED" });
                }
              } else {
                const prompt = memoryEvidencePrompt(pack.evidence);
                if (prompt) messages.splice(Math.min(1, messages.length), 0, { role: "system", content: prompt });
                await emit(input, {
                  type: "memory_retrieval_completed",
                  iteration,
                  payload: {
                    runId,
                    turnId,
                    attemptId,
                    packId: pack.packId,
                    evidenceCount: pack.evidence.length,
                    sourceEventBoundaryDigest: sourceEventBoundary.digest,
                    ...(pack.diagnostics ? { diagnostics: pack.diagnostics } : {}),
                  },
                });
              }
            } catch (error) {
              await emit(input, { type: "memory_retrieval_blocked", iteration, payload: { runId, turnId, attemptId, reason: "memory_provider_failed", errorCode: error instanceof Error ? error.name : "MEMORY_RETRIEVAL_FAILED" } });
              const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
              if (/(?:MEMORY_RETRIEVAL_BLOCKED|MEMORY_SCOPE|MEMORY_RETRIEVAL_INTENT|MEMORY_POLICY|MEMORY_AUTH)/u.test(code)) throw error;
            }
          }
        }
      }
      const attempts = [
        { model: input.model, credentials: input.credentials },
        ...(input.fallbackModels ?? []),
      ];
      let contextBudgetConsumed = false;
      let response: ModelResponse | undefined;
      let lastError: unknown;
      let contextPlanForResponse: ReturnType<typeof planProviderRequest> | undefined;
      let contextRecoveryAttempted = false;
      let contextRecoverySafetyMarginTokens = 0;
      let contextRecoveryContextWindowTokens: number | undefined;
      let completedFirstTokenAt: string | undefined;
      let completedModelAttemptStartedAt: number | undefined;
      let contextRecoveryOutputTokens: number | undefined;
      for (const [attemptIndex, attempt] of attempts.entries()) {
        lastModelAttempt = attempt;
        let creditReservation: ModelCreditReservation | undefined;
        let runBudgetReservation: ModelCreditReservation | undefined;
        let operationKey: string | undefined;
        let attemptContextProfile: ProviderContextProfile | undefined;
        let modelAttemptStartedAt: number | undefined;
        let contextAttemptReceipt: ContextAttemptBudgetReceipt | undefined;
        try {
          await input.beforeModelCall?.();
          const tools = input.modelTools ?? input.tools.list(input.grantedTools);
          operationKey = `${input.operationKeyPrefix ?? "model"}:${iteration}:${attemptIndex}`;
          lastModelOperationKey = operationKey;
          // Structural validation is the only responsibility at this seam;
          // history selection belongs to the provider-aware planner below.
          prepareModelMessages({ messages });
          const isPrimaryModel = attempt.model.provider === input.model.provider && attempt.model.model === input.model.model;
          const profileForAttempt: ProviderContextProfile | undefined = input.contextProfile
            ? {
              ...input.contextProfile,
              provider: attempt.model.provider,
              model: attempt.model.model,
              // A fallback model must prove its own capacity. A same-model
              // overflow recovery may retain the original profile while the
              // durable resolver still records the corrected capacity.
              contextWindowTokens: isPrimaryModel ? input.contextProfile.contextWindowTokens : 0,
            }
            : undefined;
          attemptContextProfile = profileForAttempt
            ? input.contextCapabilityResolver
              ? await input.contextCapabilityResolver({ provider: attempt.model.provider, model: attempt.model.model, profile: profileForAttempt, credentialRouteId: attempt.credentials.credentialReference, credentials: attempt.credentials })
              : resolveContextCapability({
                profile: profileForAttempt,
                provider: attempt.model.provider,
                model: attempt.model.model,
              })
            : undefined;
          if (attemptContextProfile && (!Number.isSafeInteger(attemptContextProfile.contextWindowTokens) || attemptContextProfile.contextWindowTokens <= 0)) {
            attemptContextProfile = undefined;
          }
          if (!attemptContextProfile && input.requireContextCapability) {
            await emit(input, {
              type: "context.planned",
              iteration,
              payload: {
                provider: attempt.model.provider,
                model: attempt.model.model,
                decision: "cannot_fit",
                status: "rejected",
                diagnostics: { reasons: ["context_capability_unknown"] },
              },
            });
            await emit(input, { type: "loop.limited", iteration, payload: { reason: "context_capability_unknown", provider: attempt.model.provider, model: attempt.model.model } });
            return {
              status: "limited",
              messages,
              usage,
              iterations: iteration - 1,
              toolCalls,
              error: {
                code: "CONTEXT_CAPABILITY_UNKNOWN",
                message: "The model context capacity is not known for this provider route",
                failureClass: "terminal",
                userMessage: "I can't safely run this request because the selected provider route has no verified context capacity.",
                remediation: "Choose a model with verified context metadata or configure a provider route with a known context window.",
              },
              ...(lastToolUi ? { ui: lastToolUi } : {}),
            };
          }
          if (attemptContextProfile) {
            await emit(input, {
              type: "context.capability_resolved",
              iteration,
              payload: {
                provider: attemptContextProfile.provider,
                model: attemptContextProfile.model,
                endpointId: attemptContextProfile.endpointId,
                contextWindowTokens: attemptContextProfile.contextWindowTokens,
                maxOutputTokens: attemptContextProfile.maxOutputTokens,
                capabilitySource: attemptContextProfile.capabilitySource,
                capabilityResolvedAt: attemptContextProfile.capabilityResolvedAt,
              },
            });
          }
          const contextPlan = attemptContextProfile
            ? (() => {
              const planningProfile = {
                ...attemptContextProfile,
                ...(contextRecoveryContextWindowTokens === undefined ? {} : { contextWindowTokens: contextRecoveryContextWindowTokens }),
                ...(contextRecoverySafetyMarginTokens > 0
                  ? { safetyMarginTokens: Math.max(attemptContextProfile.safetyMarginTokens ?? 0, contextRecoverySafetyMarginTokens) }
                  : {}),
              };
              const requestedOutputLimit = Math.min(
                attempt.model.maxTokens ?? Math.min(2_048, Math.max(1, remainingTokens)),
                contextRecoveryOutputTokens ?? Number.MAX_SAFE_INTEGER,
              );
              let planningOutputTokens = Math.max(1, requestedOutputLimit);
              let plan;
              // The run budget can be smaller than the provider request budget.
              // Re-plan when that budget clamps output so the immutable manifest
              // and the dispatched request reserve the same number of tokens.
              for (let pass = 0; pass < 12; pass += 1) {
                plan = planProviderRequest({
                  profile: planningProfile,
                  policy: {
                    requestedOutputTokens: planningOutputTokens,
                    maxToolSchemaTokens: input.contextPlanningPolicy?.maxToolSchemaTokens ?? 2_000,
                    maxToolResultTokens: input.contextPlanningPolicy?.maxToolResultTokens ?? 1_500,
                    ...(input.contextPlanningPolicy?.maxMessageUnits !== undefined ? { maxMessageUnits: input.contextPlanningPolicy.maxMessageUnits } : {}),
                    ...(input.contextPlanningPolicy?.maxRequestBytes !== undefined ? { maxRequestBytes: input.contextPlanningPolicy.maxRequestBytes } : {}),
                    ...(input.contextPlanningPolicy?.softThresholdTokens !== undefined ? { softThresholdTokens: input.contextPlanningPolicy.softThresholdTokens } : {}),
                  },
                  messages,
                  tools,
                  identity: {
                    turnId: input.turnId ?? input.toolContext.runId,
                    modelAttemptId: operationKey,
                    compactionGeneration: input.contextCompactionGeneration ?? 0,
                    ...(input.contextSourceCursor === undefined ? {} : { sourceCursor: input.contextSourceCursor }),
                    ...(input.contextSourceGeneration === undefined ? {} : { sourceGeneration: input.contextSourceGeneration }),
                    ...(input.contextSourceProjectionDigest ? { sourceProjectionDigest: input.contextSourceProjectionDigest } : {}),
                    ...(input.contextSourceHeadDigest ? { sourceHeadDigest: input.contextSourceHeadDigest } : {}),
                    sourceEventBoundaryDigest: sourceEventBoundaryFromMessages(messages, input.memorySourceEventIds ?? []).digest,
                  },
                  requestBytesEstimator: ({ messages: candidateMessages, tools: candidateTools }) => input.gateway.estimateRequestBytes({
                    provider: attempt.model.provider,
                    model: attempt.model.model,
                    ...(attempt.model.temperature === undefined ? {} : { temperature: attempt.model.temperature }),
                    maxTokens: Math.min(planningOutputTokens, planningProfile.maxOutputTokens ?? Number.MAX_SAFE_INTEGER),
                    messages: [...candidateMessages],
                    tools: [...candidateTools],
                  }),
                });
                if (plan.status === "rejected") break;
                const availableOutputTokens = Math.max(1, remainingTokens - plan.accounting.estimatedInputTokens);
                const nextOutputTokens = Math.max(1, Math.min(
                  planningOutputTokens,
                  planningProfile.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
                  contextRecoveryOutputTokens ?? Number.MAX_SAFE_INTEGER,
                  availableOutputTokens,
                ));
                if (nextOutputTokens === plan.accounting.categories.output_reservation) break;
                planningOutputTokens = nextOutputTokens;
              }
              return plan;
            })()
            : undefined;
          const persistManifestFailure = async (): Promise<AgentLoopResult | undefined> => {
            if (!contextPlan || !input.persistContextManifest) return undefined;
            try {
              await input.persistContextManifest({
                provider: contextPlan.provider,
                model: contextPlan.model,
                status: contextPlan.status,
                decision: contextPlan.decision,
                manifest: contextPlan.manifest,
              });
              return undefined;
            } catch {
              await emit(input, {
                type: "loop.limited",
                iteration,
                payload: { reason: "context_manifest_persistence_failed", manifestDigest: contextPlan.manifest.digest },
              });
              return {
                status: "limited",
                messages: [...contextPlan.messages],
                usage,
                iterations: iteration - 1,
                toolCalls,
                error: {
                  code: "CONTEXT_MANIFEST_PERSISTENCE_FAILED",
                  message: "The bounded context manifest could not be persisted before dispatch",
                  failureClass: "terminal",
                  userMessage: "I couldn't safely start this request because its context record could not be saved.",
                  remediation: "Retry the request after the context runtime is available; no provider call was dispatched.",
                },
                ...(lastToolUi ? { ui: lastToolUi } : {}),
              };
            }
          };
          const manifestPersistenceFailure = await persistManifestFailure();
          if (manifestPersistenceFailure) return manifestPersistenceFailure;
          if (contextPlan?.status === "rejected") {
            await emit(input, {
              type: "loop.limited",
              iteration,
              payload: {
                reason: "context_plan_rejected",
                code: contextPlan.rejection.code,
                message: contextPlan.rejection.message,
                accounting: contextPlan.accounting,
                diagnostics: contextPlan.diagnostics,
              },
            });
            return {
              status: "limited",
              messages: [...contextPlan.messages],
              usage,
              iterations: iteration - 1,
              toolCalls,
              error: {
                code: contextPlan.rejection.code === "request_payload_exceeds_byte_budget" ? "CONTEXT_PAYLOAD_TOO_LARGE" : "CONTEXT_PLAN_REJECTED",
                message: contextPlan.rejection.message,
                failureClass: "terminal",
                userMessage: contextPlan.rejection.code === "request_payload_exceeds_byte_budget"
                  ? "I couldn't send this request because its serialized payload is too large."
                  : "I couldn't fit the required request content into the selected model context.",
                remediation: contextPlan.rejection.code === "request_payload_exceeds_byte_budget"
                  ? "Remove large media or tool output, or choose a provider route with a larger request-size limit."
                  : "Shorten the request, remove unnecessary attachments or tools, or choose a model with a larger verified context window.",
              },
              ...(lastToolUi ? { ui: lastToolUi } : {}),
            };
          }
          if (contextPlan) {
            contextPlanForResponse = contextPlan;
            await emit(input, {
              type: "context.planned",
              iteration,
              payload: {
                provider: contextPlan.provider,
                model: contextPlan.model,
                decision: contextPlan.decision,
                status: contextPlan.status,
                manifest: contextPlan.manifest,
                accounting: {
                  basis: contextPlan.accounting.basis,
                  capabilitySource: contextPlan.accounting.capabilitySource,
                  estimatedInputTokens: contextPlan.accounting.estimatedInputTokens,
                  inputBudgetTokens: contextPlan.accounting.inputBudgetTokens,
                  contextWindowTokens: contextPlan.accounting.providerContextWindowTokens,
                  reservedOutputTokens: contextPlan.accounting.categories.output_reservation,
                  safetyMarginTokens: contextPlan.accounting.categories.safety_margin,
                  softThresholdTokens: contextPlan.accounting.softThresholdTokens,
                  hardLimitTokens: contextPlan.accounting.hardLimitTokens,
                  pressure: contextPlan.accounting.pressure,
                },
                diagnostics: contextPlan.diagnostics,
              },
            });
            if (contextPlan.status === "compacted" || contextPlan.diagnostics.truncatedToolResultCount > 0 || contextPlan.diagnostics.omittedToolCount > 0) {
              messages.splice(0, messages.length, ...contextPlan.messages);
              await emit(input, {
                type: "loop.started",
                iteration,
                payload: {
                  phase: "iteration",
                  contextCompacted: contextPlan.status === "compacted",
                  contextPlan: contextPlan.diagnostics,
                  contextAccounting: contextPlan.accounting,
                },
              });
            }
          }
          const modelMessages: ModelMessage[] = contextPlan ? [...contextPlan.messages] : messages;
          const modelTools: ModelToolDefinition[] = contextPlan ? [...contextPlan.tools] : tools;
          const estimatedInputTokens = contextPlan?.accounting.estimatedInputTokens ?? estimatePromptTokens({ messages: modelMessages, tools: modelTools });
          const requestedOutputTokens = attempt.model.maxTokens
            ?? attemptContextProfile?.maxOutputTokens
            ?? Math.min(2_048, remainingTokens);
          const plannedOutputTokens = contextPlan?.accounting.categories.output_reservation ?? Math.max(1, Math.min(
            requestedOutputTokens,
            contextRecoveryOutputTokens ?? Number.MAX_SAFE_INTEGER,
            Math.max(1, remainingTokens - estimatedInputTokens),
          ));
          if (!contextBudgetConsumed && (estimatedInputTokens + plannedOutputTokens > remainingTokens || !budget.admit("context", estimatedInputTokens))) {
            const contextBudgetError = {
              code: "CONTEXT_RUN_BUDGET_EXCEEDED",
              message: "The planned request exceeds the remaining durable run token budget",
              failureClass: "terminal" as const,
              userMessage: "I couldn't safely start this request because the remaining run token budget is too small for its context.",
              remediation: "Shorten the request or increase the run token budget before retrying.",
            };
            await emit(input, { type: "loop.limited", iteration, payload: { reason: "context_budget", code: contextBudgetError.code, estimatedInputTokens, reservedOutputTokens: plannedOutputTokens, budget: budget.snapshot() } });
            return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, error: contextBudgetError, ...(lastToolUi ? { ui: lastToolUi } : {}) };
          }
          if (!contextBudgetConsumed) {
            budget.consume("context", estimatedInputTokens);
            contextBudgetConsumed = true;
          }
          const request: ModelRequest = {
            ...attempt.model,
            messages: modelMessages,
            signal: input.signal,
            tools: modelTools,
            maxTokens: plannedOutputTokens,
          };
          if (input.contextAttemptBudget) {
            const attemptBudget = await input.contextAttemptBudget.reserve({
              budgetId: input.contextAttemptBudgetId ?? `context-attempts:${input.toolContext.runId}:${input.turnId ?? input.toolContext.runId}`,
              runId: input.toolContext.runId,
              turnId: input.turnId ?? input.toolContext.runId,
              operationKey,
              kind: "provider_retry",
            });
            if (attemptBudget.status === "exhausted") {
              await emit(input, {
                type: "loop.limited",
                iteration,
                payload: {
                  reason: "context_attempt_budget_exhausted",
                  code: attemptBudget.outcome.code,
                  budgetId: attemptBudget.outcome.budgetId,
                  attemptedAttempts: attemptBudget.outcome.attemptedAttempts,
                  maxAttempts: attemptBudget.outcome.maxAttempts,
                },
              });
              return {
                status: "limited",
                messages,
                usage,
                iterations: iteration - 1,
                toolCalls,
                error: {
                  code: attemptBudget.outcome.code,
                  message: "The durable context attempt budget is exhausted",
                  failureClass: "terminal",
                  userMessage: "I couldn't safely recover the request within the context runtime's retry budget.",
                  remediation: "Retry after the current run settles or increase the configured context recovery attempt budget.",
                },
                ...(lastToolUi ? { ui: lastToolUi } : {}),
              };
            }
            contextAttemptReceipt = attemptBudget.receipt;
          }
          let firstTokenAt: string | undefined;
          const modelQueuedAt = new Date().toISOString();
          const prepared = await input.prepareModelCall?.({ operationKey, model: attempt.model, credentials: attempt.credentials });
          try {
            runBudgetReservation = await input.reserveRunBudget?.({
              request,
              reservationKey: operationKey,
              parallelLeaseId: input.parallelLeaseId,
              estimatedInputTokens,
              reservedOutputTokens: plannedOutputTokens,
              ...(contextPlan ? { contextManifestDigest: contextPlan.manifest.digest } : {}),
            });
          } catch (error) {
            // The provider response may already be durable while the worker
            // was lost after run-budget settlement. Replay the remaining
            // settlement path instead of failing the run or calling the
            // provider again.
            if (prepared?.status === "completed" && error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED") {
              // Continue through the durable response replay path.
            } else if (error instanceof Error && error.message === "MODEL_TOKEN_BUDGET_EXCEEDED") {
              // A concurrent durable reservation can exhaust the run budget
              // after local context admission succeeds. Keep this a typed
              // context/run-budget outcome instead of leaking the old model
              // error or converting it into a generic loop failure.
              if (contextAttemptReceipt && input.contextAttemptBudget) {
                await input.contextAttemptBudget.consume(contextAttemptReceipt).catch(() => undefined);
                contextAttemptReceipt = undefined;
              }
              const budgetError = {
                code: "CONTEXT_RUN_BUDGET_EXCEEDED",
                message: "The durable run token budget was exhausted before the model request could be admitted",
                failureClass: "terminal" as const,
                userMessage: "I couldn't safely start this request because the remaining run token budget is too small.",
                remediation: "Retry after the current work settles or increase the run token budget before retrying.",
              };
              await emit(input, {
                type: "loop.limited",
                iteration,
                payload: {
                  reason: "durable_run_budget",
                  code: budgetError.code,
                  estimatedInputTokens,
                  reservedOutputTokens: plannedOutputTokens,
                  contextManifestDigest: contextPlan?.manifest.digest,
                },
              });
              return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, error: budgetError, ...(lastToolUi ? { ui: lastToolUi } : {}) };
            } else {
              throw error;
            }
          }
          if (prepared?.status === "unknown") {
            await runBudgetReservation?.markUnknown?.("The worker lost the model operation before its provider outcome was recorded");
            runBudgetReservation = undefined;
            throw new Error("MODEL_CALL_OUTCOME_UNKNOWN");
          }
          modelAttemptStartedAt = Date.now();
          completedModelAttemptStartedAt = modelAttemptStartedAt;
          await emit(input, {
            type: "model.started",
            iteration,
            payload: {
              provider: request.provider,
              model: request.model,
              operationKey,
              queuedAt: modelQueuedAt,
              startedAt: new Date(modelAttemptStartedAt).toISOString(),
              estimatedInputTokens,
              reservedOutputTokens: request.maxTokens,
              contextManifestDigest: contextPlan?.manifest.digest,
            },
          });
          if (prepared?.status === "completed") {
            response = prepared.response;
            if (!response) throw new Error("MODEL_CALL_RESPONSE_MISSING");
            // Core credit reservations use the same stable operation key, so
            // replay the same settlement path when the worker died between
            // response persistence and credit capture.
            creditReservation = await input.reserveModelCall?.({ request, credentials: attempt.credentials, operationKey });
          } else {
            creditReservation = await input.reserveModelCall?.({ request, credentials: attempt.credentials, operationKey });
            const shouldStream = input.streamModel === true && input.gateway.capabilities(request.provider, request.model)?.streaming === true;
            if (shouldStream) {
              response = (await input.gateway.stream(request, attempt.credentials, async (delta) => {
                if (firstTokenAt || (delta.type !== "text_delta" && delta.type !== "tool_call_delta")) return;
                firstTokenAt = new Date().toISOString();
                completedFirstTokenAt = firstTokenAt;
                await emit(input, {
                  type: "model.first_token",
                  iteration,
                  payload: {
                    provider: request.provider,
                    model: request.model,
                    operationKey,
                    firstTokenAt,
                    timeToFirstTokenMs: Math.max(0, Date.parse(firstTokenAt) - (modelAttemptStartedAt ?? Date.now())),
                  },
                });
              })).response;
            } else {
              response = await input.gateway.complete(request, attempt.credentials);
            }
          }
          response = attachRuntimeOperationIds(response, operationKey);
          if (prepared?.status !== "completed") await input.persistModelResponse?.({ operationKey, response, attempt });
          if (runBudgetReservation) {
            try {
              await runBudgetReservation.capture(response);
            } catch (error) {
              // The response is already durable. A retry may arrive after the
              // budget settlement, in which case it must replay without a
              // second capture.
              if (!(prepared?.status === "completed" && error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED")) throw error;
            }
            runBudgetReservation = undefined;
          }
          if (creditReservation) {
            await creditReservation.capture(response);
            creditReservation = undefined;
          }
          if (contextAttemptReceipt && input.contextAttemptBudget) {
            await input.contextAttemptBudget.consume(contextAttemptReceipt);
            contextAttemptReceipt = undefined;
          }
          break;
        } catch (error) {
          if (runBudgetReservation) {
            await runBudgetReservation.release(error instanceof Error ? error.message : "model provider failure").catch(() => undefined);
          }
          if (creditReservation) {
            await creditReservation.release(error instanceof Error ? error.message : "model provider failure").catch(() => undefined);
          }
          if (contextAttemptReceipt && input.contextAttemptBudget && !(error instanceof Error && error.message === "MODEL_CALL_OUTCOME_UNKNOWN")) {
            await input.contextAttemptBudget.consume(contextAttemptReceipt).catch(() => undefined);
          }
          lastError = error;
          if (error instanceof ModelProviderError) {
            const normalized = { code: error.code, message: error.message };
            await emit(input, {
              type: "model.failed",
              iteration,
              payload: {
                provider: attempt.model.provider,
                model: attempt.model.model,
                operationKey,
                code: error.code,
                retryable: error.retryable,
                ...(modelAttemptStartedAt === undefined ? {} : {
                  failedAt: new Date().toISOString(),
                  latencyMs: Math.max(0, Date.now() - modelAttemptStartedAt),
                }),
              },
            });
            if (operationKey) await input.persistModelError?.({ operationKey, model: attempt.model, credentials: attempt.credentials, error: normalized });
            if (isProviderPayloadOverflow(error)) {
              await emit(input, { type: "loop.limited", iteration, payload: { reason: "provider_payload_too_large", code: error.code, statusCode: error.statusCode } });
              return {
                status: "limited",
                messages,
                usage,
                iterations: iteration - 1,
                toolCalls,
                error: {
                  code: "PROVIDER_PAYLOAD_TOO_LARGE",
                  message: "The provider rejected the serialized request payload size",
                  failureClass: "terminal",
                  userMessage: "The provider rejected this request because its serialized payload is too large.",
                  remediation: "Remove large media or tool output, or choose a provider route with a larger request-size limit.",
                },
                ...(lastToolUi ? { ui: lastToolUi } : {}),
              };
            }
            if (isProviderContextOverflow(error)) {
              const correction = contextCapabilityCorrectionFromProviderError({ code: error.code, message: error.message });
              if (correction && attemptContextProfile) {
                if (correction.contextWindowTokens !== undefined && correction.contextWindowTokens < attemptContextProfile.contextWindowTokens) {
                  contextRecoveryContextWindowTokens = correction.contextWindowTokens;
                }
                if (correction.maxOutputTokens !== undefined) {
                  contextRecoveryOutputTokens = Math.max(1, Math.min(contextRecoveryOutputTokens ?? requestMaxTokensForRecovery(attempt, input, remainingTokens), correction.maxOutputTokens));
                }
                await input.recordContextCapabilityCorrection?.({ provider: attempt.model.provider, model: attempt.model.model, profile: attemptContextProfile, credentialRouteId: attempt.credentials.credentialReference, correction });
              }
              if (!contextRecoveryAttempted && attemptContextProfile && attemptContextProfile.capabilitySource !== "unknown") {
                contextRecoveryAttempted = true;
                attempts.splice(attemptIndex + 1, 0, attempt);
                contextRecoverySafetyMarginTokens = Math.max(
                  (attemptContextProfile.safetyMarginTokens ?? 0) + 256,
                  Math.ceil(attemptContextProfile.contextWindowTokens * 0.1),
                );
                contextRecoveryOutputTokens = Math.max(1, Math.floor((requestMaxTokensForRecovery(attempt, input, remainingTokens)) / 2));
                await emit(input, {
                  type: "context.recovery",
                  iteration,
                  payload: {
                    status: "provider_overflow_recovering",
                    provider: attempt.model.provider,
                    model: attempt.model.model,
                    operationKey,
                    safetyMarginTokens: contextRecoverySafetyMarginTokens,
                    reservedOutputTokens: contextRecoveryOutputTokens,
                  },
                });
                continue;
              }
              if (contextRecoveryAttempted && attemptIndex < attempts.length - 1) continue;
              await emit(input, { type: "loop.limited", iteration, payload: { reason: "provider_context_overflow", code: error.code } });
              return {
                status: "limited",
                messages,
                usage,
                iterations: iteration - 1,
                toolCalls,
                error: {
                  code: "PROVIDER_CONTEXT_OVERFLOW",
                  message: "The provider rejected the bounded context",
                  failureClass: "terminal",
                  userMessage: "The provider rejected this request because it still exceeds the verified context boundary.",
                  remediation: "Shorten the request or choose a model with a larger verified context window.",
                },
                ...(lastToolUi ? { ui: lastToolUi } : {}),
              };
            }
          }
          // A fallback is only for provider failures. Budget, policy, and
          // cancellation errors must stop the run immediately.
          if (!(error instanceof ModelProviderError)) throw error;
        }
      }
      if (!response) throw lastError ?? new Error("Model gateway returned no response");
      await input.onModelResponse?.(response, lastModelAttempt, lastModelOperationKey);
      const hadDurableToolResult = messages.at(-1)?.role === "tool";
          messages.push(response.message);
          budget.consume("model", response.usage.totalTokens);
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.totalTokens += response.usage.totalTokens;
      usage.estimatedCostUsd += response.usage.estimatedCostUsd ?? 0;
      const contextUsage = contextPlanForResponse ? accountProviderUsage(contextPlanForResponse, response.usage) : undefined;
      const contextUsageAnchor = contextPlanForResponse
        && lastModelOperationKey
        && response.usage.inputTokensReported !== false
        && response.usage.outputTokensReported !== false
        ? createContextUsageAnchor({
          operationKey: lastModelOperationKey,
          boundary: {
            provider: contextPlanForResponse.provider,
            model: contextPlanForResponse.model,
            manifestDigest: contextPlanForResponse.manifest.digest,
            sourceDigest: contextPlanForResponse.manifest.sourceDigest,
            compactionGeneration: input.contextCompactionGeneration ?? (contextPlanForResponse.status === "compacted" ? 1 : 0),
          },
          estimatedInputTokens: contextPlanForResponse.accounting.estimatedInputTokens,
          providerInputTokens: response.usage.inputTokens,
          providerOutputTokens: response.usage.outputTokens,
          providerTotalTokens: response.usage.totalTokens,
        })
        : undefined;
      await emit(input, {
        type: "model.completed",
        iteration,
        payload: {
          provider: response.provider,
          model: response.model,
          ...(lastModelOperationKey ? { operationKey: lastModelOperationKey } : {}),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokensReported: response.usage.inputTokensReported !== false,
          outputTokensReported: response.usage.outputTokensReported !== false,
          totalTokensReported: response.usage.inputTokensReported !== false && response.usage.outputTokensReported !== false,
          latencyMs: response.latencyMs,
          ...(completedFirstTokenAt ? { firstTokenAt: completedFirstTokenAt, timeToFirstTokenMs: Math.max(0, Date.parse(completedFirstTokenAt) - (completedModelAttemptStartedAt ?? Date.now())) } : {}),
          completedAt: new Date().toISOString(),
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          contextMeasurementBasis: contextUsage?.basis ?? contextPlanForResponse?.accounting.basis,
          contextManifestDigest: contextPlanForResponse?.manifest.digest,
          ...(contextUsageAnchor ? { contextUsageAnchor } : {}),
          ...(contextUsage ? {
            contextUsage: {
              status: contextUsage.status,
              plannedInputTokens: contextUsage.plannedInputTokens,
              inputOverrunTokens: contextUsage.inputOverrunTokens,
              outputOverrunTokens: contextUsage.outputOverrunTokens,
              totalOverrunTokens: contextUsage.totalOverrunTokens,
              issues: contextUsage.issues,
            },
          } : {}),
        },
      });
      if (response.toolCalls.length === 0) {
        if (!response.message.content.trim()) {
          // Decomposed Temporal runs intentionally execute one model slice per
          // Activity. If the provider returns an empty final response, let the
          // next Activity retry the same durable model turn. Adding an internal
          // repair message here would hide the transcript boundary from the
          // durable host, causing the slice to be reported as a generic limit
          // instead of a resumable continuation.
          if (input.deferToolExecution) {
            messages.pop();
            const error = {
              code: "EMPTY_ASSISTANT_RESPONSE",
              message: hadDurableToolResult
                ? "The model returned no assistant text after a durable tool result"
                : "The model returned no assistant text for the current turn",
              failureClass: "retryable" as const,
            };
            await emit(input, { type: "loop.limited", iteration, payload: { reason: "empty_response_slice", code: error.code } });
            return { status: "limited", messages, response, usage, iterations: iteration, toolCalls, error, ...(lastToolUi ? { ui: lastToolUi } : {}) };
          }
          if (emptyResponseRetries < limits.maxEmptyResponseRetries) {
            emptyResponseRetries += 1;
            messages.push({
              role: "user",
              content: "The previous response was empty. Continue the same task and provide a concise visible answer.",
            });
            await emit(input, {
              type: "loop.started",
              iteration,
              payload: {
                reason: "empty_response_retry",
                retry: emptyResponseRetries,
                maxRetries: limits.maxEmptyResponseRetries,
              },
            });
            continue;
          }
          const error = {
            code: "EMPTY_ASSISTANT_RESPONSE",
            message: `The model returned no assistant text after ${emptyResponseRetries} recovery attempt${emptyResponseRetries === 1 ? "" : "s"}`,
            failureClass: "terminal" as const,
          };
          await emit(input, { type: "loop.failed", iteration, payload: error });
          return { status: "failed", messages, response, usage, iterations: iteration, toolCalls, error };
        }
        emptyResponseRetries = 0;
        await emit(input, { type: "loop.completed", iteration, payload: { toolCalls, totalTokens: usage.totalTokens } });
        const completionResponse = authorizationRequired || lastToolUi
          ? agentResponseSchema.parse({
            version: "1",
            text: response.message.content,
            media: [],
            ...(authorizationRequired ? { authorizationRequired } : {}),
            ...(lastToolUi ? { ui: lastToolUi } : {}),
          })
          : undefined;
        return {
          status: "completed",
          messages,
          response,
          ...(completionResponse ? { completionResponse } : {}),
          usage,
          iterations: iteration,
          toolCalls,
        };
      }
      type ToolExecutionOutcome = {
        runtimeOperationId: string;
        toolCallId: string;
        name: string;
        sequenceNumber: number;
        message?: ModelMessage;
        authorization?: AgentAuthorizationRequirement;
        ui?: AgentResponse["ui"];
        control?: "final_response" | "awaiting_human";
        completionResponse?: AgentResponse;
        waitingFor?: string;
        pendingToolCall?: NonNullable<AgentLoopResult["pendingToolCalls"]>[number];
        budgetExhausted?: boolean;
      };

      if (input.deferToolExecution) {
        const pendingToolCalls = response.toolCalls.map((toolCall, index) => {
          const runtimeOperationId = toolCall.runtimeOperationId ?? runtimeOperationIdForToolCall(lastModelOperationKey ?? `${input.operationKeyPrefix ?? "model"}:${iteration}:response`, index);
          return {
            id: runtimeOperationId,
            providerToolCallId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            argumentsHash: hashToolArguments(toolCall.arguments),
          };
        });
        for (const [index, toolCall] of response.toolCalls.entries()) {
          const pending = pendingToolCalls[index]!;
          const manifest = input.tools.get(toolCall.name);
          await emit(input, {
            type: "route.selected",
            iteration,
            payload: {
              sourceStageId: "model",
              targetStageId: `capability:${toolCall.name}`,
              operationId: pending.id,
              toolCallId: toolCall.id,
            },
          });
          await emit(input, {
            type: "tool.proposed",
            iteration,
            payload: { toolCallId: toolCall.id, operationId: pending.id, name: toolCall.name, argumentsHash: pending.argumentsHash },
          });
          await input.onToolProposed?.({
            toolCallId: toolCall.id,
            runtimeOperationId: pending.id,
            name: toolCall.name,
            version: manifest?.version ?? "unknown",
            riskClass: manifest?.riskClass ?? "privileged",
            arguments: toolCall.arguments,
            argumentsHash: pending.argumentsHash,
            requiresApproval: manifest?.requiresApproval ?? false,
            sequenceNumber: index + 1,
          });
        }
        await emit(input, {
          type: "loop.limited",
          iteration,
          payload: { reason: "tool_batch_pending", toolCalls: pendingToolCalls.length },
        });
        return {
          status: "limited",
          messages,
          response,
          pendingToolCalls,
          toolBatchPending: true,
          authorizedToolNames: [...input.grantedTools].sort(),
          ...(input.capabilitySnapshot?.digest ? { capabilitySnapshotDigest: input.capabilitySnapshot.digest } : {}),
          ...(input.contextSourceCursor !== undefined
            && input.contextSourceGeneration !== undefined
            && input.contextSourceHeadDigest
            && input.contextSourceProjectionDigest
            ? {
                transcriptSource: {
                  generation: input.contextSourceGeneration,
                  cursor: input.contextSourceCursor,
                  headDigest: input.contextSourceHeadDigest,
                  projectionDigest: input.contextSourceProjectionDigest,
                },
              }
            : {}),
          usage,
          iterations: iteration,
          toolCalls,
        };
      }

      const executeToolCall = async (toolCall: ModelToolCall, toolIndex: number, sequenceNumber: number): Promise<ToolExecutionOutcome> => {
        const runtimeOperationId = toolCall.runtimeOperationId ?? runtimeOperationIdForToolCall(lastModelOperationKey ?? `${input.operationKeyPrefix ?? "model"}:${iteration}:response`, toolIndex);
        const argumentsHash = hashToolArguments(toolCall.arguments);
        const repetitionKey = `${toolCall.name}:${argumentsHash}`;
        const repetitionCount = (identicalToolCallCounts.get(repetitionKey) ?? 0) + 1;
        identicalToolCallCounts.set(repetitionKey, repetitionCount);
        if (repetitionCount > 2) {
          const repetitionError = new ToolPolicyError("TOOL_REPETITION_GUARD", "The same tool operation was proposed repeatedly without making progress");
          await emit(input, { type: "tool.failed", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, error: { code: repetitionError.code, message: repetitionError.message }, failedAt: new Date().toISOString(), repetitionCount } });
          throw repetitionError;
        }
        const manifest = input.tools.get(toolCall.name);
        let toolInvocationBoundaryEntered = false;
        let toolResultAvailable = false;
        try {
          await input.beforeToolInvoke?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, arguments: toolCall.arguments, approved: false });
          const replayed = await input.replayToolInvocation?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, argumentsHash });
          if (replayed && (replayed.name !== toolCall.name || replayed.argumentsHash !== argumentsHash)) throw new ToolPolicyError("TOOL_REPLAY_SCOPE_CONFLICT", "A durable tool outcome did not match the provider tool call");
          if (!replayed) {
            await emit(input, { type: "route.selected", iteration, payload: { sourceStageId: "model", targetStageId: `capability:${toolCall.name}`, operationId: runtimeOperationId, toolCallId: toolCall.id } });
            await emit(input, { type: "tool.proposed", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, argumentsHash } });
            await input.onToolProposed?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, version: manifest?.version ?? "unknown", riskClass: manifest?.riskClass ?? "privileged", arguments: toolCall.arguments, argumentsHash, requiresApproval: manifest?.requiresApproval ?? false, sequenceNumber });
          }
          const budgetFailure = async (code: string, message: string): Promise<ToolExecutionOutcome> => {
            const error = { code, message };
            await emit(input, { type: "tool.failed", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, error, failedAt: new Date().toISOString() } });
            await input.onToolFailed?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, argumentsHash, error });
            return {
              runtimeOperationId,
              toolCallId: toolCall.id,
              name: toolCall.name,
              sequenceNumber,
              budgetExhausted: true,
              message: { role: "tool", name: toolCall.name, toolCallId: toolCall.id, runtimeOperationId, content: JSON.stringify({ ok: false, error }) },
            };
          };
          if (!replayed && !budget.admit("tool")) return budgetFailure("TOOL_CALL_BUDGET_EXCEEDED", "The run tool-operation budget was exhausted before this call could start");
          // Claim the local slot before the first awaited host callback. This
          // makes parallel workers observe one atomic in-process budget state.
          if (!replayed) budget.consume("tool");
          if (!replayed) {
            try {
              await input.consumeRunToolCall?.({ parallelLeaseId: input.parallelLeaseId });
            } catch (error) {
              const code = error instanceof Error ? error.message : "";
              if (code === "TOOL_CALL_BUDGET_EXCEEDED" || code === "PARALLEL_TOOL_CAPACITY_EXCEEDED") return budgetFailure(code, "The run tool-operation budget was exhausted before this call could start");
              throw error;
            }
          }
          await emit(input, { type: "tool.started", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, startedAt: new Date().toISOString(), ...(replayed ? { replayed: true } : {}) } });
          toolInvocationBoundaryEntered = true;
          const result = replayed ?? await input.tools.invoke({
            name: toolCall.name,
            arguments: toolCall.arguments,
            context: input.signal ? { ...input.toolContext, signal: input.signal } : input.toolContext,
            signal: input.signal,
            grantedTools: input.grantedTools,
            operationId: runtimeOperationId,
            sequenceNumber,
            lifecycle: input.toolLifecycle,
            beforeEffect: manifest?.riskClass === "external-effect" ? async () => input.onToolExecuting?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, version: manifest.version, arguments: toolCall.arguments, argumentsHash, requiresApproval: manifest.requiresApproval }) : undefined,
          });
          toolResultAvailable = true;
          const toolAuthorization = findAuthorizationRequirement(result.output);
          const safeOutput = redactSensitiveValue(result.output);
          const durableOutput = redactToolOutput(result.output, manifest?.manifest?.redaction ?? []);
          const toolUi = input.dynamicUiEnabled === false ? undefined : projectCapabilityResultUi({ presentation: manifest?.manifest?.presentation, output: durableOutput, channel: input.uiChannel ?? "platform" });
          await emit(input, { type: "tool.completed", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, latencyMs: result.latencyMs, ...(replayed ? { replayed: true } : {}), ...(toolAuthorization ? { authorizationRequired: toolAuthorization } : {}) } });
          if (!replayed) await input.onToolCompleted?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, argumentsHash, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId });
          const outcome: ToolExecutionOutcome = {
            runtimeOperationId,
            toolCallId: toolCall.id,
            name: toolCall.name,
            sequenceNumber,
            message: { role: "tool", name: toolCall.name, toolCallId: toolCall.id, runtimeOperationId, content: JSON.stringify(safeOutput) },
            authorization: toolAuthorization,
            ui: toolUi,
          };
          if (result.control === "final_response") {
            const agentResponse = (safeOutput as { response: AgentResponse }).response;
            outcome.control = "final_response";
            outcome.completionResponse = agentResponseSchema.parse({ ...agentResponse, ...(toolAuthorization ? { authorizationRequired: toolAuthorization } : {}), ...(toolUi ? { ui: toolUi } : {}) });
          } else if (result.control === "awaiting_human") {
            const safeOutputRecord = safeOutput && typeof safeOutput === "object" ? safeOutput as Record<string, unknown> : undefined;
            outcome.control = "awaiting_human";
            outcome.waitingFor = safeOutputRecord && typeof safeOutputRecord.handoffRequestId === "string" ? safeOutputRecord.handoffRequestId : undefined;
          }
          return outcome;
        } catch (error) {
          if (error instanceof ToolPolicyError && error.code === "APPROVAL_REQUIRED") {
            await emit(input, { type: "loop.paused", iteration, payload: { reason: "approval", name: toolCall.name } });
            return { runtimeOperationId, toolCallId: toolCall.id, name: toolCall.name, sequenceNumber, pendingToolCall: { id: runtimeOperationId, providerToolCallId: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, argumentsHash } };
          }
          if (!toolInvocationBoundaryEntered || toolResultAvailable) throw error;
          const normalized = error instanceof ToolPolicyError ? { code: error.code, message: error.message } : { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "Tool failed" };
          await emit(input, { type: "tool.failed", iteration, payload: { toolCallId: toolCall.id, operationId: runtimeOperationId, name: toolCall.name, error: normalized, failedAt: new Date().toISOString() } });
          await input.onToolFailed?.({ toolCallId: toolCall.id, runtimeOperationId, name: toolCall.name, argumentsHash, error: normalized });
          if (normalized.code === "TOOL_REPLAY_SCOPE_CONFLICT" || normalized.code === "CAPABILITY_OUTCOME_UNKNOWN" || normalized.code === "EFFECT_OUTCOME_UNKNOWN") throw error;
          return { runtimeOperationId, toolCallId: toolCall.id, name: toolCall.name, sequenceNumber, message: { role: "tool", name: toolCall.name, toolCallId: toolCall.id, runtimeOperationId, content: JSON.stringify({ ok: false, error: normalized }) } };
        }
      };

      const segments = planToolBatch(response.toolCalls, (name) => input.tools.get(name));
      let budgetExhausted = false;
      for (const segment of segments) {
        const outcomes = segment.kind === "parallel"
          ? await mapBounded(segment.calls, ({ call, index }) => executeToolCall(call, index, toolCalls + index + 1), input.maxParallelToolCalls ?? 8)
          : [await executeToolCall(segment.calls[0]!.call, segment.calls[0]!.index, toolCalls + 1)];
        toolCalls += outcomes.length;
        for (const outcome of outcomes) {
          if (outcome.message) messages.push(outcome.message);
          if (outcome.budgetExhausted) budgetExhausted = true;
          if (outcome.authorization) authorizationRequired = outcome.authorization;
          if (outcome.ui) lastToolUi = outcome.ui;
          if (outcome.pendingToolCall) {
            return { status: "awaiting_approval", messages, response, pendingToolCalls: [outcome.pendingToolCall], usage, iterations: iteration, toolCalls };
          }
          if (outcome.control === "final_response" && outcome.completionResponse) {
            await emit(input, { type: "loop.completed", iteration, payload: { toolCalls, totalTokens: usage.totalTokens, responseFormat: "agent-response.v1" } });
            return { status: "completed", messages, response, completionMessage: outcome.completionResponse.text, completionResponse: outcome.completionResponse, usage, iterations: iteration, toolCalls };
          }
          if (outcome.control === "awaiting_human") {
            await emit(input, { type: "loop.paused", iteration, payload: { reason: "handoff", name: outcome.name } });
            return { status: "awaiting_human", messages, response, usage, iterations: iteration, toolCalls, waitingFor: outcome.waitingFor };
          }
        }
      }
      if (budgetExhausted) {
        await emit(input, { type: "loop.limited", iteration, payload: { reason: "tool_calls" } });
        return { status: "limited", messages, response, usage, iterations: iteration, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
      }
    } catch (error) {
      const codedError = error instanceof Error
        && "code" in error
        && typeof error.code === "string"
        ? { code: error.code, message: error.message }
        : undefined;
      const normalized = error instanceof ModelProviderError || error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : codedError
          ? { ...codedError, failureClass: classifyFailureCode(codedError.code) }
          : { code: "AGENT_LOOP_FAILED", message: error instanceof Error ? error.message : "Unknown agent loop failure", failureClass: "terminal" as const };
      if (error instanceof ModelProviderError) await input.onModelError?.(normalized, lastModelAttempt, lastModelOperationKey);
      await emit(input, { type: "loop.failed", iteration, payload: normalized });
      return { status: "failed", messages, usage, iterations: iteration, toolCalls, error: normalized };
    }
  }
  await emit(input, { type: "loop.limited", iteration: limits.maxIterations, payload: { reason: "iterations" } });
  return { status: "limited", messages, usage, iterations: limits.maxIterations, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
}

function isProviderContextOverflow(error: ModelProviderError): boolean {
  return /(?:context|token).*(?:length|limit|exceed|overflow)|(?:context|token)_?(?:length|limit|exceed|overflow)/i.test(`${error.code} ${error.message}`);
}

function isProviderPayloadOverflow(error: ModelProviderError): boolean {
  return error.statusCode === 413 || /(?:payload|request).*(?:too large|size|limit)|entity[_ -]?too[_ -]?large/i.test(`${error.code} ${error.message}`);
}

function requestMaxTokensForRecovery(
  attempt: { readonly model: Pick<ModelRequest, "maxTokens"> },
  input: AgentLoopInput,
  remainingTokens: number,
): number {
  return Math.max(1, attempt.model.maxTokens ?? input.contextProfile?.maxOutputTokens ?? Math.min(2_048, remainingTokens));
}

function lastUserMessage(messages: readonly ModelMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  return message && typeof message.content === "string" ? message.content.slice(0, 4_000) : "";
}
