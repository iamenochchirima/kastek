import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolDefinition } from "../model/types";
import { buildTranscriptUnits, validateModelTranscript, type ModelTranscriptUnit } from "./transcript";

/**
 * A provider-aware request planner for model-facing context.
 *
 * Planning uses a conservative character estimate. It is deliberately not a
 * billing tokenizer and never replaces provider-reported usage. The planner
 * keeps system messages and recent tool-call/result pairs intact, then drops
 * older message units when the request needs compaction.
 */

export type ContextBudgetCategory =
  | "system"
  | "history"
  | "current_message"
  | "tool_results"
  | "tool_schemas"
  | "output_reservation"
  | "safety_margin";

export type ContextPlanStatus = "fits" | "compacted" | "rejected";

/** The actionable decision made by the context runtime before dispatch. */
export type ContextPlanDecision = "ready" | "compact" | "prune" | "limited" | "cannot_fit";

/** How the runtime knows the context-window value used for this plan. */
export type ContextCapabilitySource =
  | "provider_metadata"
  | "catalog"
  | "configured_override"
  | "provider_error_correction"
  | "unknown";

/** How current occupancy is measured. Estimates are never presented as usage. */
export type ContextMeasurementBasis =
  | "provider_reported"
  | "anchored_estimate"
  | "full_estimate"
  | "unknown_after_compaction";

export type ContextPressure = "normal" | "soft" | "hard";

export type ContextPlanRejection =
  | "invalid_provider_profile"
  | "system_context_exceeds_input_budget"
  | "current_message_cannot_fit"
  | "active_turn_cannot_fit"
  | "request_payload_exceeds_byte_budget"
  | "transcript_projection_invalid";

export interface ProviderContextProfile {
  /** Provider identifier used for diagnostics and provider-specific limits. */
  readonly provider: string;
  /** Model identifier used for diagnostics. */
  readonly model: string;
  /** Context window reported by the provider/model registry. */
  readonly contextWindowTokens: number;
  /** Provider maximum for generated tokens, when known. */
  readonly maxOutputTokens?: number;
  /** Agent policy ceiling applied after provider capacity is resolved. */
  readonly policyLimitTokens?: number;
  /** Extra input capacity kept unused to cover framing/tokenizer variance. */
  readonly safetyMarginTokens?: number;
  /** Approximate characters per token. The default is intentionally conservative. */
  readonly charsPerToken?: number;
  /** Approximate per-message framing overhead. */
  readonly messageOverheadTokens?: number;
  /** Route or credential-bound endpoint identity, when the provider exposes one. */
  readonly endpointId?: string;
  /** Provenance for contextWindowTokens. Missing provenance is treated as unknown. */
  readonly capabilitySource?: ContextCapabilitySource;
  /** Timestamp at which the capability was resolved or last confirmed. */
  readonly capabilityResolvedAt?: string;
}

export interface ContextPlanningPolicy {
  /** Requested response budget before the provider cap is applied. */
  readonly requestedOutputTokens: number;
  /** Maximum approximate schema footprint admitted to the request. */
  readonly maxToolSchemaTokens: number;
  /** Maximum approximate content retained for one tool result. */
  readonly maxToolResultTokens: number;
  /** Maximum number of message units retained after system messages. */
  readonly maxMessageUnits?: number;
  /** Independent serialized request limit for providers/routes with byte caps. */
  readonly maxRequestBytes?: number;
  /** Usable-input maintenance threshold; defaults to Hermes-aligned 50%/75% pressure. */
  readonly softThresholdTokens?: number;
}

/** Provider-envelope measurement supplied by the model adapter boundary. */
export type ContextRequestBytesEstimator = (input: {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}) => number;

export interface ContextBudgetCategories {
  readonly system: number;
  readonly history: number;
  readonly current_message: number;
  readonly tool_results: number;
  readonly tool_schemas: number;
  readonly output_reservation: number;
  readonly safety_margin: number;
}

export interface ApproximateTokenAccounting {
  readonly policyVersion: "v1";
  readonly method: "approximate_characters";
  readonly basis: "full_estimate";
  readonly capabilitySource: ContextCapabilitySource;
  readonly charsPerToken: number;
  readonly categories: ContextBudgetCategories;
  readonly estimatedInputTokens: number;
  readonly reservedRequestTokens: number;
  readonly providerContextWindowTokens: number;
  readonly inputBudgetTokens: number;
  readonly softThresholdTokens: number;
  readonly hardLimitTokens: number;
  readonly pressure: ContextPressure;
}

export interface ContextRequestManifestComponent {
  readonly kind: "system" | "history" | "current_message" | "tool_results" | "tool_schemas";
  readonly selectedCount: number;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
}

/** Durable identifiers for a model-facing request; never contains prompt content. */
export interface ContextRequestIdentity {
  readonly turnId?: string;
  readonly requestManifestId?: string;
  readonly modelAttemptId?: string;
  readonly compactionGeneration?: number;
  /** Canonical transcript head sequence used to build this request. */
  readonly sourceCursor?: number;
  /** Canonical transcript generation used to build this request. */
  readonly sourceGeneration?: number;
  /** Digest of the canonical active projection before provider selection. */
  readonly sourceProjectionDigest?: string;
  readonly sourceEventBoundaryDigest?: string;
  /** Provider-assigned identity, when the adapter exposes one. */
  readonly providerRequestId?: string;
}

/** Content-free identity for the exact selected model-facing projection. */
export interface ContextRequestManifest {
  readonly schemaVersion: "v1";
  readonly identity: {
    readonly turnId?: string;
    readonly requestManifestId: string;
    readonly modelAttemptId?: string;
    readonly compactionGeneration?: number;
    readonly sourceCursor?: number;
    readonly sourceGeneration?: number;
    readonly sourceProjectionDigest?: string;
    readonly sourceEventBoundaryDigest: string;
    readonly providerRequestId?: string;
  };
  readonly digest: string;
  /** Digest of the pre-selection source boundary used to build this request. */
  readonly sourceDigest: string;
  readonly sourceMessageCount: number;
  readonly selectedMessageCount: number;
  readonly sourceToolCount: number;
  readonly selectedToolCount: number;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly providerContextWindowTokens: number;
  readonly inputBudgetTokens: number;
  readonly softThresholdTokens: number;
  readonly hardLimitTokens: number;
  /** UTF-8 size estimate of the serialized message/tool projection. */
  readonly estimatedRequestBytes: number;
  readonly components: readonly ContextRequestManifestComponent[];
}

export interface ContextPlanDiagnostics {
  readonly reasons: readonly string[];
  readonly omittedMessageCount: number;
  readonly omittedToolCount: number;
  readonly truncatedToolResultCount: number;
  /** Tool results replaced by a bounded digest reference in the wire projection. */
  readonly toolResultReferenceCount: number;
  /** Empty assistant rows removed from the wire projection. */
  readonly blankAssistantEchoCount: number;
  /** Historical provider replay fields removed from the wire projection. */
  readonly staleReplayArtifactCount: number;
  readonly protectedPairCount: number;
  readonly selectedMessageUnitCount: number;
  readonly estimatedRequestBytes?: number;
  readonly maxRequestBytes?: number;
}

export interface ContextPlanBase {
  readonly provider: string;
  readonly model: string;
  readonly status: ContextPlanStatus;
  readonly decision: ContextPlanDecision;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly accounting: ApproximateTokenAccounting;
  readonly manifest: ContextRequestManifest;
  readonly diagnostics: ContextPlanDiagnostics;
}

export interface ContextPlanAccepted extends ContextPlanBase {
  readonly status: "fits" | "compacted";
  readonly rejection: undefined;
}

export interface ContextPlanRejected extends ContextPlanBase {
  readonly status: "rejected";
  readonly rejection: {
    readonly code: ContextPlanRejection;
    readonly message: string;
  };
}

export type ContextPlan = ContextPlanAccepted | ContextPlanRejected;

export interface ContextPlanInput {
  readonly profile: ProviderContextProfile;
  readonly policy: ContextPlanningPolicy;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  /** Defaults to the newest user message. */
  readonly currentMessageIndex?: number;
  /** Optional provider-specific serialization measurement for the final byte gate. */
  readonly requestBytesEstimator?: ContextRequestBytesEstimator;
  /** Stable run/turn/attempt identity shared with journal and memory seams. */
  readonly identity?: ContextRequestIdentity;
}

export interface ProviderReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly inputTokensReported?: boolean;
  readonly outputTokensReported?: boolean;
  readonly totalTokensReported?: boolean;
}

export type ContextAccountingStatus = "accepted" | "provider_overrun" | "invalid_usage" | "usage_unavailable";

export interface ContextUsageAccounting {
  readonly status: ContextAccountingStatus;
  readonly source: "provider_reported" | "estimated";
  readonly basis: ContextMeasurementBasis;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly plannedInputTokens: number;
  readonly plannedOutputReservation: number;
  readonly inputOverrunTokens: number;
  readonly outputOverrunTokens: number;
  readonly totalOverrunTokens: number;
  readonly issues: readonly string[];
}

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 8;
const DEFAULT_SAFETY_MARGIN_TOKENS = 256;
const DEFAULT_MAX_TOOL_SCHEMA_TOKENS = 2_000;
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 1_500;
const MINIMUM_MESSAGE_TOKENS = 1;
const MINIMUM_CONTEXT_LENGTH_TOKENS = 64_000;
const MINIMUM_CONTEXT_TRIGGER_RATIO = 0.85;

export function planProviderRequest(input: ContextPlanInput): ContextPlan {
  const profile = normalizeProfile(input.profile);
  const policy = normalizePolicy(input.policy);
  const charsPerToken = profile.charsPerToken;
  const tools = selectTools(input.tools ?? [], policy.maxToolSchemaTokens, charsPerToken);
  const wireHistory = pruneWireHistory(input.messages);
  const normalizedMessages = limitToolResults(wireHistory.messages, policy.maxToolResultTokens, charsPerToken);
  const systemMessages = normalizedMessages.messages.filter((message) => message.role === "system");
  const bodyMessages = normalizedMessages.messages.filter((message) => message.role !== "system");
  const systemTokens = sumMessages(systemMessages, charsPerToken, profile.messageOverheadTokens);
  const toolSchemaTokens = sumTools(tools.selected, charsPerToken);
  const outputReservation = Math.min(policy.requestedOutputTokens, profile.maxOutputTokens ?? policy.requestedOutputTokens);
  const inputBudgetTokens = profile.contextWindowTokens - outputReservation - profile.safetyMarginTokens;
  const reasons: string[] = [];

  if (tools.omittedCount > 0) reasons.push("tool_schema_budget");
  if (normalizedMessages.truncatedToolResultCount > 0) reasons.push("tool_result_budget");
  if (normalizedMessages.toolResultReferenceCount > 0) reasons.push("tool_result_reference");
  if (wireHistory.blankAssistantEchoCount > 0) reasons.push("blank_assistant_echo");
  if (wireHistory.staleReplayArtifactCount > 0) reasons.push("stale_replay_artifact");
  if (outputReservation < policy.requestedOutputTokens) reasons.push("provider_output_cap");

  const emptyDiagnostics = (overrides: Partial<ContextPlanDiagnostics> = {}): ContextPlanDiagnostics => ({
    reasons,
    omittedMessageCount: 0,
    omittedToolCount: tools.omittedCount,
    truncatedToolResultCount: normalizedMessages.truncatedToolResultCount,
    toolResultReferenceCount: normalizedMessages.toolResultReferenceCount,
    blankAssistantEchoCount: wireHistory.blankAssistantEchoCount,
    staleReplayArtifactCount: wireHistory.staleReplayArtifactCount,
    protectedPairCount: 0,
    selectedMessageUnitCount: 0,
    ...overrides,
  });

  const transcriptIssues = validateModelTranscript(normalizedMessages.messages.filter((message) => message.role !== "system"));
  if (transcriptIssues.length > 0) {
    reasons.push("transcript_projection_invalid");
    return rejectedPlan(input.profile, tools.selected, systemMessages, emptyDiagnostics({ reasons }), {
      code: "transcript_projection_invalid",
      message: "The active model transcript is incomplete or out of order; no provider call was dispatched.",
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation, policy.softThresholdTokens, input.identity);
  }

  if (!profile.valid) {
    return rejectedPlan(input.profile, tools.selected, [], emptyDiagnostics(), {
      code: "invalid_provider_profile",
      message: "The provider context profile must contain a positive context window and non-negative budgets.",
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation, policy.softThresholdTokens, input.identity);
  }

  if (inputBudgetTokens < systemTokens + toolSchemaTokens) {
    reasons.push("system_context_exceeds_input_budget");
    return rejectedPlan(input.profile, tools.selected, systemMessages, emptyDiagnostics({ reasons }), {
      code: "system_context_exceeds_input_budget",
      message: "System instructions and selected tool schemas exceed the provider input budget.",
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation, policy.softThresholdTokens, input.identity);
  }

  const units = buildTranscriptUnits(bodyMessages);
  const selectedUnits = selectRecentUnits({
    units,
    systemTokens,
    toolSchemaTokens,
    inputBudgetTokens,
    charsPerToken,
    messageOverheadTokens: profile.messageOverheadTokens,
    maxMessageUnits: policy.maxMessageUnits,
    currentMessageIndex: resolveCurrentMessageIndex(
      normalizedMessages.messages,
      input.currentMessageIndex === undefined
        ? undefined
        : wireHistory.originalIndexByNormalizedIndex.indexOf(input.currentMessageIndex),
    ),
    systemMessages,
    tools: tools.selected,
    maxRequestBytes: policy.maxRequestBytes,
    requestBytesEstimator: input.requestBytesEstimator,
  });

  if (selectedUnits.status === "rejected") {
    reasons.push(selectedUnits.code);
    return rejectedPlan(input.profile, tools.selected, systemMessages, emptyDiagnostics({
      reasons,
      omittedMessageCount: bodyMessages.length,
      protectedPairCount: selectedUnits.protectedPairCount,
      selectedMessageUnitCount: selectedUnits.units.length,
    }), {
      code: selectedUnits.code,
      message: selectedUnits.message,
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation, policy.softThresholdTokens, input.identity);
  }

  const selectedMessages = [...systemMessages, ...selectedUnits.units.flatMap((unit) => unit.messages)];
  const categories = { ...categorizeMessages(selectedMessages, charsPerToken, profile.messageOverheadTokens), tool_schemas: toolSchemaTokens };
  const omittedMessageCount = Math.max(0, bodyMessages.length - selectedUnits.units.reduce((total, unit) => total + unit.messages.length, 0));
  if (omittedMessageCount > 0) reasons.push("history_compacted");
  if (reasons.length > 0 && !reasons.includes("history_compacted") && !reasons.includes("tool_schema_budget") && !reasons.includes("tool_result_budget") && !reasons.includes("tool_result_reference") && !reasons.includes("blank_assistant_echo") && !reasons.includes("stale_replay_artifact")) {
    reasons.push("request_adjusted");
  }

  const status: ContextPlanStatus = omittedMessageCount > 0 ? "compacted" : "fits";
  const estimatedRequestBytes = measureRequestBytes(selectedMessages, tools.selected, input.requestBytesEstimator);
  if (estimatedRequestBytes > policy.maxRequestBytes) {
    reasons.push("payload_byte_budget");
    return rejectedPlan(input.profile, tools.selected, selectedMessages, emptyDiagnostics({
      reasons,
      omittedMessageCount,
      protectedPairCount: selectedUnits.protectedPairCount,
      selectedMessageUnitCount: selectedUnits.units.length,
      estimatedRequestBytes,
      maxRequestBytes: policy.maxRequestBytes,
    }), {
      code: "request_payload_exceeds_byte_budget",
      message: "The serialized model request exceeds the provider payload byte budget.",
    }, charsPerToken, categories.system, categories.history, categories.current_message, categories.tool_results, toolSchemaTokens, outputReservation, policy.softThresholdTokens, input.identity);
  }
  const decision: ContextPlanDecision = omittedMessageCount > 0
    ? "compact"
    : (normalizedMessages.truncatedToolResultCount > 0 || normalizedMessages.toolResultReferenceCount > 0 || wireHistory.blankAssistantEchoCount > 0 || wireHistory.staleReplayArtifactCount > 0 || tools.omittedCount > 0 ? "prune" : "ready");
  return {
    provider: input.profile.provider,
    model: input.profile.model,
    status,
    decision,
    rejection: undefined,
    messages: selectedMessages,
    tools: tools.selected,
    accounting: createAccounting(categories, profile, outputReservation, charsPerToken, policy.softThresholdTokens),
    manifest: createManifest({
      // Source accounting describes the input before the wire-only prune.
      // The original durable transcript is never replaced by the bounded
      // references used in selectedMessages.
      sourceMessages: input.messages,
      selectedMessages,
      sourceTools: input.tools ?? [],
      selectedTools: tools.selected,
      accounting: createAccounting(categories, profile, outputReservation, charsPerToken, policy.softThresholdTokens),
      estimatedRequestBytes,
      identity: input.identity,
    }),
    diagnostics: {
      reasons,
      omittedMessageCount,
      omittedToolCount: tools.omittedCount,
      truncatedToolResultCount: normalizedMessages.truncatedToolResultCount,
      toolResultReferenceCount: normalizedMessages.toolResultReferenceCount,
      blankAssistantEchoCount: wireHistory.blankAssistantEchoCount,
      staleReplayArtifactCount: wireHistory.staleReplayArtifactCount,
      protectedPairCount: selectedUnits.protectedPairCount,
      selectedMessageUnitCount: selectedUnits.units.length,
      estimatedRequestBytes,
      ...(policy.maxRequestBytes === Number.MAX_SAFE_INTEGER ? {} : { maxRequestBytes: policy.maxRequestBytes }),
    },
  };
}

export function accountProviderUsage(plan: ContextPlan, usage: ProviderReportedUsage): ContextUsageAccounting {
  const issues: string[] = [];
  if (!isValidUsageNumber(usage.inputTokens)) issues.push("invalid_input_tokens");
  if (!isValidUsageNumber(usage.outputTokens)) issues.push("invalid_output_tokens");
  if (usage.totalTokens !== undefined && !isValidUsageNumber(usage.totalTokens)) issues.push("invalid_total_tokens");
  if (issues.length > 0) {
    return {
      status: "invalid_usage",
      source: "provider_reported",
      basis: "provider_reported",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      plannedInputTokens: plan.accounting.estimatedInputTokens,
      plannedOutputReservation: plan.accounting.categories.output_reservation,
      inputOverrunTokens: 0,
      outputOverrunTokens: 0,
      totalOverrunTokens: 0,
      issues,
    };
  }

  const inputReported = usage.inputTokensReported !== false;
  const outputReported = usage.outputTokensReported !== false;
  if (!inputReported || !outputReported) {
    if (!inputReported) issues.push("provider_input_usage_unavailable");
    if (!outputReported) issues.push("provider_output_usage_unavailable");
    return {
      status: "usage_unavailable",
      source: "estimated",
      basis: "full_estimate",
      inputTokens: inputReported ? usage.inputTokens : plan.accounting.estimatedInputTokens,
      outputTokens: outputReported ? usage.outputTokens : 0,
      totalTokens: inputReported && outputReported ? (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) : plan.accounting.estimatedInputTokens,
      plannedInputTokens: plan.accounting.estimatedInputTokens,
      plannedOutputReservation: plan.accounting.categories.output_reservation,
      inputOverrunTokens: 0,
      outputOverrunTokens: 0,
      totalOverrunTokens: 0,
      issues,
    };
  }

  const totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
  const inputOverrunTokens = Math.max(0, usage.inputTokens - plan.accounting.inputBudgetTokens);
  const outputOverrunTokens = Math.max(0, usage.outputTokens - plan.accounting.categories.output_reservation);
  const totalOverrunTokens = Math.max(0, totalTokens - plan.accounting.providerContextWindowTokens);
  if (inputOverrunTokens > 0) issues.push("provider_input_exceeded_planned_budget");
  if (outputOverrunTokens > 0) issues.push("provider_output_exceeded_reserved_budget");
  if (totalOverrunTokens > 0) issues.push("provider_total_exceeded_context_window");
  return {
    status: issues.length > 0 ? "provider_overrun" : "accepted",
    source: "provider_reported",
    basis: "provider_reported",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
    plannedInputTokens: plan.accounting.estimatedInputTokens,
    plannedOutputReservation: plan.accounting.categories.output_reservation,
    inputOverrunTokens,
    outputOverrunTokens,
    totalOverrunTokens,
    issues,
  };
}

export function estimateApproximateTokens(value: unknown, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return Math.max(MINIMUM_MESSAGE_TOKENS, Math.ceil(serialized.length / normalizeCharsPerToken(charsPerToken)));
}

export function estimateRequestBytes(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify({ messages, tools }), "utf8");
}

interface NormalizedProfile {
  readonly provider: string;
  readonly model: string;
  /** The model/provider capacity, never reduced by an agent policy ceiling. */
  readonly providerContextWindowTokens: number;
  /** The effective context ceiling used for fit decisions. */
  readonly contextWindowTokens: number;
  readonly policyLimitTokens: number;
  readonly maxOutputTokens: number | undefined;
  readonly safetyMarginTokens: number;
  readonly charsPerToken: number;
  readonly messageOverheadTokens: number;
  readonly capabilitySource: ContextCapabilitySource;
  readonly valid: boolean;
}

function normalizeProfile(profile: ProviderContextProfile): NormalizedProfile {
  const providerContextWindowTokens = finiteInteger(profile.contextWindowTokens);
  const policyLimitTokens = profile.policyLimitTokens === undefined ? Number.MAX_SAFE_INTEGER : finiteInteger(profile.policyLimitTokens);
  const contextWindowTokens = Math.min(providerContextWindowTokens, policyLimitTokens);
  const maxOutputTokens = profile.maxOutputTokens === undefined ? undefined : finiteInteger(profile.maxOutputTokens);
  const safetyMarginTokens = profile.safetyMarginTokens === undefined ? DEFAULT_SAFETY_MARGIN_TOKENS : finiteInteger(profile.safetyMarginTokens);
  const charsPerToken = profile.charsPerToken === undefined ? DEFAULT_CHARS_PER_TOKEN : normalizeCharsPerToken(profile.charsPerToken);
  const messageOverheadTokens = profile.messageOverheadTokens === undefined ? DEFAULT_MESSAGE_OVERHEAD_TOKENS : finiteInteger(profile.messageOverheadTokens);
  return {
    provider: profile.provider,
    model: profile.model,
    providerContextWindowTokens,
    contextWindowTokens,
    policyLimitTokens,
    maxOutputTokens,
    safetyMarginTokens,
    charsPerToken,
    messageOverheadTokens,
    capabilitySource: profile.capabilitySource ?? "unknown",
    valid: Boolean(profile.provider && profile.model && providerContextWindowTokens > 0 && policyLimitTokens > 0 && contextWindowTokens > 0 && (maxOutputTokens === undefined || maxOutputTokens > 0) && safetyMarginTokens >= 0 && messageOverheadTokens >= 0),
  };
}

function normalizePolicy(policy: ContextPlanningPolicy): Required<ContextPlanningPolicy> {
  return {
    requestedOutputTokens: Math.max(1, finiteInteger(policy.requestedOutputTokens)),
    maxToolSchemaTokens: Math.max(0, finiteInteger(policy.maxToolSchemaTokens ?? DEFAULT_MAX_TOOL_SCHEMA_TOKENS)),
    maxToolResultTokens: Math.max(1, finiteInteger(policy.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS)),
    // The current user task is structurally required; a zero historical
    // allowance must not make the planner silently drop it.
    maxMessageUnits: policy.maxMessageUnits === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, finiteInteger(policy.maxMessageUnits)),
    maxRequestBytes: policy.maxRequestBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, finiteInteger(policy.maxRequestBytes)),
    softThresholdTokens: policy.softThresholdTokens === undefined ? -1 : Math.max(0, finiteInteger(policy.softThresholdTokens)),
  };
}

function selectTools(tools: readonly ModelToolDefinition[], maxTokens: number, charsPerToken: number): { selected: ModelToolDefinition[]; omittedCount: number } {
  const selected: ModelToolDefinition[] = [];
  let usedTokens = 0;
  for (const tool of tools) {
    const candidateTokens = estimateApproximateTokens(tool, charsPerToken);
    if (usedTokens + candidateTokens > maxTokens) continue;
    selected.push(tool);
    usedTokens += candidateTokens;
  }
  return { selected, omittedCount: tools.length - selected.length };
}

const MIN_DUPLICATE_TOOL_RESULT_CHARS = 64;
const STALE_REPLAY_KEYS = [
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "codex_reasoning_items",
  "codex_message_items",
  "media",
  "images",
  "attachments",
] as const;

interface WireHistoryNormalization {
  readonly messages: ModelMessage[];
  /** Maps each wire-projection row back to its durable source row. */
  readonly originalIndexByNormalizedIndex: readonly number[];
  readonly blankAssistantEchoCount: number;
  readonly staleReplayArtifactCount: number;
}

/**
 * Apply only deterministic, wire-projection hygiene. This operates on a
 * cloned message list; durable transcript rows are never rewritten here.
 * Unknown assistant content is left untouched unless it is an explicit JSON
 * envelope containing one of the known provider replay fields.
 */
function pruneWireHistory(messages: readonly ModelMessage[]): WireHistoryNormalization {
  const latestAssistantIndex = messages.reduce((latest, message, index) => message.role === "assistant" ? index : latest, -1);
  let blankAssistantEchoCount = 0;
  let staleReplayArtifactCount = 0;
  const normalized: ModelMessage[] = [];
  const originalIndexByNormalizedIndex: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && !message.toolCalls?.length && message.content.trim() === "") {
      blankAssistantEchoCount += 1;
      continue;
    }
    if (message.role !== "assistant" || index >= latestAssistantIndex || message.toolCalls?.length) {
      normalized.push(message);
      originalIndexByNormalizedIndex.push(index);
      continue;
    }
    const parsed = parseJsonObject(message.content);
    if (!parsed) {
      normalized.push(message);
      originalIndexByNormalizedIndex.push(index);
      continue;
    }
    const replayKeys = STALE_REPLAY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    if (replayKeys.length === 0 || !hasAssistantTextEnvelope(parsed)) {
      normalized.push(message);
      originalIndexByNormalizedIndex.push(index);
      continue;
    }
    const cleaned = { ...parsed };
    for (const key of replayKeys) delete cleaned[key];
    staleReplayArtifactCount += replayKeys.length;
    normalized.push({
      ...message,
      content: Object.keys(cleaned).length > 0
        ? JSON.stringify(cleaned)
        : `[replay-ref:${shortContentDigest(message.content)}]`,
    });
    originalIndexByNormalizedIndex.push(index);
  }
  return { messages: normalized, originalIndexByNormalizedIndex, blankAssistantEchoCount, staleReplayArtifactCount };
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  if (!content.trim().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function hasAssistantTextEnvelope(value: Record<string, unknown>): boolean {
  return ["text", "content", "message"].some((key) => typeof value[key] === "string");
}

function limitToolResults(messages: readonly ModelMessage[], maxTokens: number, charsPerToken: number): {
  messages: ModelMessage[];
  truncatedToolResultCount: number;
  toolResultReferenceCount: number;
} {
  let truncatedToolResultCount = 0;
  let toolResultReferenceCount = 0;
  const seenDigests = new Set<string>();
  // Walk newest-first so duplicate older results become references while the
  // latest identical result remains available verbatim when it fits.
  const limited = [...messages].reverse().map((message) => {
    if (message.role !== "tool") return message;
    const digest = shortContentDigest(message.content);
    const isOversized = estimateApproximateTokens(message.content, charsPerToken) > maxTokens;
    const isDuplicate = message.content.length >= MIN_DUPLICATE_TOOL_RESULT_CHARS && seenDigests.has(digest);
    seenDigests.add(digest);
    if (!isOversized && !isDuplicate) return message;
    if (isOversized) truncatedToolResultCount += 1;
    toolResultReferenceCount += 1;
    return { ...message, content: boundedToolResultReference(message.content, maxTokens, charsPerToken) };
  }).reverse();
  return { messages: limited, truncatedToolResultCount, toolResultReferenceCount };
}

function shortContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Keep the model-facing projection small while leaving the original result in
 * the durable transcript. The short digest lets operators and later runtime
 * code correlate the omitted result without copying its contents into the
 * request manifest.
 */
function boundedToolResultReference(content: string, maxTokens: number, charsPerToken: number): string {
  const maxCharacters = Math.max(1, maxTokens * charsPerToken);
  const marker = `[ref:${shortContentDigest(content)}]`;
  if (marker.length >= maxCharacters) return marker.slice(0, maxCharacters);
  const remaining = maxCharacters - marker.length - 1;
  if (remaining <= 0) return marker;
  return `${marker} ${content.slice(0, remaining)}`;
}

function selectRecentUnits(input: {
  units: readonly ModelTranscriptUnit[];
  systemMessages: readonly ModelMessage[];
  systemTokens: number;
  toolSchemaTokens: number;
  inputBudgetTokens: number;
  charsPerToken: number;
  messageOverheadTokens: number;
  maxMessageUnits: number;
  currentMessageIndex: number;
  tools: readonly ModelToolDefinition[];
  maxRequestBytes: number;
  requestBytesEstimator: ContextRequestBytesEstimator | undefined;
}): { status: "selected"; units: ModelTranscriptUnit[]; protectedPairCount: number } | { status: "rejected"; code: "current_message_cannot_fit" | "active_turn_cannot_fit" | "request_payload_exceeds_byte_budget"; message: string; units: ModelTranscriptUnit[]; protectedPairCount: number } {
  const available = input.inputBudgetTokens - input.systemTokens - input.toolSchemaTokens;
  const selected: ModelTranscriptUnit[] = [];
  let usedTokens = 0;
  let protectedPairCount = 0;
  let selectedUnits = 0;
  for (let index = input.units.length - 1; index >= 0; index -= 1) {
    const unit = input.units[index]!;
    const containsCurrentMessage = input.currentMessageIndex >= 0
      && unit.startIndex <= input.currentMessageIndex
      && unit.endIndex >= input.currentMessageIndex;
    const isActiveTurnTail = input.currentMessageIndex >= 0 && unit.startIndex > input.currentMessageIndex;
    // The active turn is newer than the current user message. It is not
    // historical context and must remain eligible for the next model call.
    // The message-unit allowance still bounds older history, while the
    // current user and active tail remain protected structural units.
    if (selectedUnits >= input.maxMessageUnits && !containsCurrentMessage && !isActiveTurnTail) break;
    const unitTokens = sumMessages(unit.messages, input.charsPerToken, input.messageOverheadTokens);
    if (usedTokens + unitTokens > available) {
      if (containsCurrentMessage && unit.messages.length === 1 && unit.messages[0]?.role === "user") {
        const room = Math.max(0, available - usedTokens);
        const current = { ...unit.messages[0], content: truncateText(unit.messages[0].content, room, input.charsPerToken) };
        if (current && sumMessages([current], input.charsPerToken, input.messageOverheadTokens) <= room && current.content.length > 0) {
          if (input.requestBytesEstimator && measureRequestBytes([...input.systemMessages, current], input.tools, input.requestBytesEstimator) > input.maxRequestBytes) {
            return { status: "rejected", code: "request_payload_exceeds_byte_budget", message: "The serialized model request exceeds the provider payload byte budget.", units: [], protectedPairCount: 0 };
          }
          selected.push({ messages: [current], protectedPair: false, startIndex: unit.startIndex, endIndex: unit.endIndex });
          selectedUnits += 1;
          usedTokens += sumMessages([current], input.charsPerToken, input.messageOverheadTokens);
          break;
        }
        return { status: "rejected", code: "current_message_cannot_fit", message: "The current user message cannot fit after provider overhead and safety margin.", units: [], protectedPairCount: 0 };
      }
      if (isActiveTurnTail) {
        return { status: "rejected", code: "active_turn_cannot_fit", message: "The active tool round cannot fit after provider overhead and safety margin.", units: [], protectedPairCount: 0 };
      }
      break;
    }
    if (input.requestBytesEstimator) {
      const candidateUnits = [...selected, unit].reverse();
      const candidateMessages = [...input.systemMessages, ...candidateUnits.flatMap((candidateUnit) => candidateUnit.messages)];
      if (measureRequestBytes(candidateMessages, input.tools, input.requestBytesEstimator) > input.maxRequestBytes) {
        if (selected.length === 0) {
          return { status: "rejected", code: "request_payload_exceeds_byte_budget", message: "The serialized model request exceeds the provider payload byte budget.", units: [], protectedPairCount: 0 };
        }
        break;
      }
    }
    selected.push(unit);
    selectedUnits += 1;
    usedTokens += unitTokens;
    if (unit.protectedPair) protectedPairCount += 1;
  }
  selected.reverse();
  return { status: "selected", units: selected, protectedPairCount };
}

function resolveCurrentMessageIndex(messages: readonly ModelMessage[], explicitIndex: number | undefined): number {
  let fullIndex = -1;
  if (explicitIndex !== undefined && Number.isInteger(explicitIndex) && explicitIndex >= 0 && explicitIndex < messages.length) {
    fullIndex = explicitIndex;
  } else {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        fullIndex = index;
        break;
      }
    }
  }
  if (fullIndex < 0) return -1;
  return messages.slice(0, fullIndex + 1).filter((message) => message.role !== "system").length - 1;
}

function categorizeMessages(messages: readonly ModelMessage[], charsPerToken: number, messageOverheadTokens: number): ContextBudgetCategories {
  const categories = { system: 0, history: 0, current_message: 0, tool_results: 0, tool_schemas: 0, output_reservation: 0, safety_margin: 0 };
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      currentUserIndex = index;
      break;
    }
  }
  messages.forEach((message, index) => {
    const tokens = sumMessages([message], charsPerToken, messageOverheadTokens);
    if (message.role === "system") categories.system += tokens;
    else if (message.role === "tool") categories.tool_results += tokens;
    else if (index === currentUserIndex) categories.current_message += tokens;
    else categories.history += tokens;
  });
  return categories;
}

function createAccounting(categories: ContextBudgetCategories, profile: NormalizedProfile, outputReservation: number, charsPerToken: number, softThresholdTokens?: number): ApproximateTokenAccounting {
  const withReservation: ContextBudgetCategories = { ...categories, output_reservation: outputReservation, safety_margin: profile.safetyMarginTokens };
  const estimatedInputTokens = categories.system + categories.history + categories.current_message + categories.tool_results + categories.tool_schemas;
  const hardLimitTokens = profile.contextWindowTokens - outputReservation - profile.safetyMarginTokens;
  const softLimit = resolveContextSoftThreshold(hardLimitTokens, softThresholdTokens, profile.providerContextWindowTokens);
  return {
    policyVersion: "v1",
    method: "approximate_characters",
    basis: "full_estimate",
    capabilitySource: profile.capabilitySource,
    charsPerToken,
    categories: withReservation,
    estimatedInputTokens,
    reservedRequestTokens: estimatedInputTokens + outputReservation + profile.safetyMarginTokens,
    providerContextWindowTokens: profile.providerContextWindowTokens,
    inputBudgetTokens: hardLimitTokens,
    softThresholdTokens: softLimit,
    hardLimitTokens,
    pressure: pressureFor(estimatedInputTokens, softLimit, hardLimitTokens),
  };
}

function rejectedPlan(
  profile: ProviderContextProfile,
  tools: readonly ModelToolDefinition[],
  messages: readonly ModelMessage[],
  diagnostics: ContextPlanDiagnostics,
  rejection: ContextPlanRejected["rejection"],
  charsPerToken: number,
  systemTokens: number,
  historyTokens: number,
  currentMessageTokens: number,
  toolResultTokens: number,
  toolSchemaTokens: number,
  outputReservation: number,
  softThresholdTokens?: number,
  identity?: ContextRequestIdentity,
): ContextPlanRejected {
  const normalized = normalizeProfile(profile);
  const categories: ContextBudgetCategories = {
    system: systemTokens,
    history: historyTokens,
    current_message: currentMessageTokens,
    tool_results: toolResultTokens,
    tool_schemas: toolSchemaTokens,
    output_reservation: outputReservation,
    safety_margin: normalized.safetyMarginTokens,
  };
  const estimatedInputTokens = systemTokens + historyTokens + currentMessageTokens + toolResultTokens + toolSchemaTokens;
  const hardLimitTokens = normalized.contextWindowTokens - outputReservation - normalized.safetyMarginTokens;
  const softLimit = resolveContextSoftThreshold(hardLimitTokens, softThresholdTokens, normalized.providerContextWindowTokens);
  return {
    provider: profile.provider,
    model: profile.model,
    status: "rejected",
    decision: rejection.code === "invalid_provider_profile" ? "limited" : "cannot_fit",
    rejection,
    messages,
    tools,
    accounting: {
      policyVersion: "v1",
      method: "approximate_characters",
      basis: "full_estimate",
      capabilitySource: normalized.capabilitySource,
      charsPerToken,
      categories,
      estimatedInputTokens,
      reservedRequestTokens: estimatedInputTokens + outputReservation + normalized.safetyMarginTokens,
      providerContextWindowTokens: normalized.providerContextWindowTokens,
      inputBudgetTokens: hardLimitTokens,
      softThresholdTokens: softLimit,
      hardLimitTokens,
      pressure: pressureFor(estimatedInputTokens, softLimit, hardLimitTokens),
    },
    manifest: createManifest({
      sourceMessages: messages,
      selectedMessages: messages,
      sourceTools: tools,
      selectedTools: tools,
      accounting: {
        policyVersion: "v1",
        method: "approximate_characters",
        basis: "full_estimate",
        capabilitySource: normalized.capabilitySource,
        charsPerToken,
        categories,
        estimatedInputTokens,
        reservedRequestTokens: estimatedInputTokens + outputReservation + normalized.safetyMarginTokens,
        providerContextWindowTokens: normalized.providerContextWindowTokens,
        inputBudgetTokens: normalized.contextWindowTokens - outputReservation - normalized.safetyMarginTokens,
        softThresholdTokens: softLimit,
        hardLimitTokens,
        pressure: pressureFor(estimatedInputTokens, softLimit, hardLimitTokens),
      },
      identity,
    }),
    diagnostics,
  };
}

export function resolveContextSoftThreshold(hardLimitTokens: number, requested: number | undefined, providerContextWindowTokens: number): number {
  const fallbackRatio = providerContextWindowTokens >= 512_000 ? 0.5 : 0.75;
  const effectiveInputBudget = Math.max(0, hardLimitTokens);
  const percentageThreshold = Math.floor(effectiveInputBudget * fallbackRatio);
  const minimumFloorThreshold = Math.max(percentageThreshold, MINIMUM_CONTEXT_LENGTH_TOKENS);
  const triggerCap = Math.floor(effectiveInputBudget * MINIMUM_CONTEXT_TRIGGER_RATIO);
  // Hermes uses a minimum context floor for normal-sized models, but caps the
  // floor when it would make the trigger unreachable on a small window.
  const fallback = minimumFloorThreshold > percentageThreshold && minimumFloorThreshold > triggerCap
    ? Math.max(percentageThreshold, triggerCap)
    : minimumFloorThreshold;
  const reachableFallback = effectiveInputBudget > 0 && fallback >= effectiveInputBudget
    ? Math.max(1, Math.min(triggerCap, effectiveInputBudget - 1))
    : fallback;
  if (requested === undefined || requested < 0 || !Number.isFinite(requested)) return reachableFallback;
  return Math.max(0, Math.min(effectiveInputBudget, Math.floor(requested)));
}

/**
 * Resolve the durable compactor's unit ceiling from the same provider-relative
 * pressure policy used by the request planner. The compactor still preserves
 * whole transcript units; this only chooses how many newest units form the
 * retained tail before a checkpoint is created.
 */
export function resolveContextRetainedMessageUnitLimit(input: {
  readonly messages: readonly ModelMessage[];
  readonly hardLimitTokens: number;
  readonly providerContextWindowTokens: number;
  readonly configuredMaxUnits?: number;
  readonly charsPerToken?: number;
  readonly messageOverheadTokens?: number;
}): number {
  const configuredMaxUnits = Number.isSafeInteger(input.configuredMaxUnits) && (input.configuredMaxUnits ?? 0) > 0
    ? input.configuredMaxUnits!
    : 20;
  const bodyMessages = input.messages.filter((message) => message.role !== "system");
  const units = buildTranscriptUnits(bodyMessages);
  if (units.length === 0) return Math.max(1, configuredMaxUnits);
  const charsPerToken = Number.isFinite(input.charsPerToken) && (input.charsPerToken ?? 0) > 0 ? input.charsPerToken! : DEFAULT_CHARS_PER_TOKEN;
  const messageOverheadTokens = Number.isFinite(input.messageOverheadTokens) && (input.messageOverheadTokens ?? 0) >= 0
    ? input.messageOverheadTokens!
    : DEFAULT_MESSAGE_OVERHEAD_TOKENS;
  const sourceTokens = sumMessages(bodyMessages, charsPerToken, messageOverheadTokens);
  const softThresholdTokens = resolveContextSoftThreshold(input.hardLimitTokens, undefined, input.providerContextWindowTokens);
  if (sourceTokens < softThresholdTokens) return configuredMaxUnits;
  const retainedTailTargetTokens = Math.max(MINIMUM_MESSAGE_TOKENS, Math.floor(softThresholdTokens * 0.2));
  let retainedUnits = 0;
  let retainedTokens = 0;
  for (let index = units.length - 1; index >= 0 && retainedUnits < configuredMaxUnits; index -= 1) {
    const unit = units[index]!;
    const unitTokens = sumMessages(unit.messages, charsPerToken, messageOverheadTokens);
    if (retainedUnits > 0 && retainedTokens + unitTokens > retainedTailTargetTokens) break;
    retainedUnits += 1;
    retainedTokens += unitTokens;
  }
  return Math.max(1, retainedUnits);
}

function pressureFor(estimatedInputTokens: number, softThresholdTokens: number, hardLimitTokens: number): ContextPressure {
  if (estimatedInputTokens >= hardLimitTokens) return "hard";
  if (estimatedInputTokens >= softThresholdTokens) return "soft";
  return "normal";
}

function createManifest(input: {
  readonly sourceMessages: readonly ModelMessage[];
  readonly selectedMessages: readonly ModelMessage[];
  readonly sourceTools: readonly ModelToolDefinition[];
  readonly selectedTools: readonly ModelToolDefinition[];
  readonly accounting: ApproximateTokenAccounting;
  readonly estimatedRequestBytes?: number;
  readonly identity?: ContextRequestIdentity;
}): ContextRequestManifest {
  const selected = input.selectedMessages;
  const currentIndex = findCurrentUserIndex(selected);
  const components: ContextRequestManifestComponent[] = [
    component("system", selected.filter((message) => message.role === "system"), input.accounting.categories.system),
    component("history", selected.filter((message, index) => message.role !== "system" && index !== currentIndex && message.role !== "tool"), input.accounting.categories.history),
    component("current_message", currentIndex >= 0 ? [selected[currentIndex]!] : [], input.accounting.categories.current_message),
    component("tool_results", selected.filter((message) => message.role === "tool"), input.accounting.categories.tool_results),
    { kind: "tool_schemas", selectedCount: input.selectedTools.length, estimatedTokens: input.accounting.categories.tool_schemas, estimatedBytes: Buffer.byteLength(JSON.stringify(input.selectedTools), "utf8") },
  ];
  const estimatedRequestBytes = input.estimatedRequestBytes ?? estimateRequestBytes(selected, input.selectedTools);
  const digest = createHash("sha256").update(JSON.stringify({ messages: selected, tools: input.selectedTools })).digest("hex");
  const sourceDigest = createHash("sha256").update(JSON.stringify({ messages: input.sourceMessages, tools: input.sourceTools })).digest("hex");
  const identity = input.identity;
  return {
    schemaVersion: "v1",
    identity: {
      ...(identity?.turnId ? { turnId: identity.turnId } : {}),
      requestManifestId: identity?.requestManifestId ?? `context-manifest:${identity?.modelAttemptId ?? "request"}:${digest}`,
      ...(identity?.modelAttemptId ? { modelAttemptId: identity.modelAttemptId } : {}),
      ...(identity?.compactionGeneration === undefined ? {} : { compactionGeneration: identity.compactionGeneration }),
      ...(identity?.sourceCursor === undefined ? {} : { sourceCursor: identity.sourceCursor }),
      ...(identity?.sourceGeneration === undefined ? {} : { sourceGeneration: identity.sourceGeneration }),
      ...(identity?.sourceProjectionDigest ? { sourceProjectionDigest: identity.sourceProjectionDigest } : {}),
      sourceEventBoundaryDigest: identity?.sourceEventBoundaryDigest ?? sourceDigest,
      ...(identity?.providerRequestId ? { providerRequestId: identity.providerRequestId } : {}),
    },
    digest,
    sourceDigest,
    sourceMessageCount: input.sourceMessages.length,
    selectedMessageCount: selected.length,
    sourceToolCount: input.sourceTools.length,
    selectedToolCount: input.selectedTools.length,
    estimatedInputTokens: input.accounting.estimatedInputTokens,
    reservedOutputTokens: input.accounting.categories.output_reservation,
    safetyMarginTokens: input.accounting.categories.safety_margin,
    providerContextWindowTokens: input.accounting.providerContextWindowTokens,
    inputBudgetTokens: input.accounting.inputBudgetTokens,
    softThresholdTokens: input.accounting.softThresholdTokens,
    hardLimitTokens: input.accounting.hardLimitTokens,
    estimatedRequestBytes,
    components,
  };
}

function measureRequestBytes(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
  estimator: ContextRequestBytesEstimator | undefined,
): number {
  if (!estimator) return estimateRequestBytes(messages, tools);
  try {
    const measured = estimator({ messages, tools });
    return Number.isFinite(measured) && measured >= 0 ? Math.ceil(measured) : estimateRequestBytes(messages, tools);
  } catch {
    return estimateRequestBytes(messages, tools);
  }
}

function component(kind: ContextRequestManifestComponent["kind"], messages: readonly ModelMessage[], estimatedTokens: number): ContextRequestManifestComponent {
  return { kind, selectedCount: messages.length, estimatedTokens, estimatedBytes: Buffer.byteLength(JSON.stringify(messages), "utf8") };
}

function findCurrentUserIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function sumMessages(messages: readonly ModelMessage[], charsPerToken: number, messageOverheadTokens: number): number {
  return messages.reduce((total, message) => total + messageTokens(message, charsPerToken, messageOverheadTokens), 0);
}

function messageTokens(message: ModelMessage, charsPerToken: number, messageOverheadTokens: number): number {
  const toolCalls = message.toolCalls?.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  return messageOverheadTokens + estimateApproximateTokens({ role: message.role, name: message.name, toolCallId: message.toolCallId, content: message.content, toolCalls }, charsPerToken);
}

function sumTools(tools: readonly ModelToolDefinition[], charsPerToken: number): number {
  return tools.reduce((total, tool) => total + estimateApproximateTokens(tool, charsPerToken), 0);
}

function truncateText(value: string, maxTokens: number, charsPerToken: number): string {
  const maxChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
  if (value.length <= maxChars) return value;
  const marker = "\n[content truncated by context planner]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function isValidUsageNumber(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : -1;
}

function normalizeCharsPerToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHARS_PER_TOKEN;
}
