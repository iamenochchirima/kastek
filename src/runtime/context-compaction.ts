import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolCall } from "../model/types";
import { buildTranscriptUnits, toolOperationIdentity, validateModelTranscript } from "./transcript";
import {
  directEvidenceEnvelopeFromMessages,
  sourceEventBoundaryFromMessages,
  type MemoryCheckpointPort,
  type MemoryDirectEvidenceEnvelope,
  type MemoryRuntimeEventPayload,
  type MemoryRuntimeScope,
  type MemorySourceEventBoundary,
} from "./context-memory-boundary";
import type {
  ContextAttemptBudgetPort,
  ContextAttemptBudgetReceipt,
} from "./context-attempt-budget";

const DEFAULT_MAX_SUMMARY_TOKENS = 512;
const DEFAULT_MAX_RETAINED_MESSAGE_UNITS = 20;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_500;
const DEFAULT_CHARS_PER_TOKEN = 4;
const SUMMARY_SOURCE_MARKER = "durable-context-summary";

export type ContextCompactionSource = "none" | "provider" | "deterministic_fallback";

export type ContextSummaryProviderFailureCode =
  | "provider_aborted"
  | "provider_timeout"
  | "provider_error"
  | "provider_empty_result"
  | "provider_result_over_budget";

export interface ContextCompactionPolicy {
  /** Maximum size of the stored summary, measured with the deterministic estimator. */
  readonly maxSummaryTokens?: number;
  /** Number of recent message units retained outside the summary. */
  readonly maxRetainedMessageUnits?: number;
  /** Maximum time allowed for an optional summary provider. */
  readonly providerTimeoutMs?: number;
  /** Character/token estimate used for bounded provider output validation. */
  readonly charsPerToken?: number;
}

export interface ContextSummaryProviderInput {
  /** Stable identity used to make provider work idempotent across retries. */
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  /** Only messages omitted from the active projection are supplied. */
  readonly messages: readonly ModelMessage[];
  readonly maxSummaryTokens: number;
  readonly signal: AbortSignal;
}

export interface ContextSummaryProviderResult {
  readonly summary: string;
}

/**
 * Optional provider seam. The provider is advisory: a timeout, exception,
 * empty result, or oversized result always falls back to the deterministic
 * summary and never prevents durable history from being retained.
 */
export interface ContextSummaryProvider {
  summarize(input: ContextSummaryProviderInput): Promise<ContextSummaryProviderResult>;
}

export interface DurableContextDecisionRevision {
  readonly schemaVersion: "v1";
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  /** Monotonic context projection generation used for compare-and-swap. */
  readonly generation: number;
  /** Generation observed immediately before this operation was admitted. */
  readonly expectedGeneration: number;
  /** Hash of the session/worker fence; the raw token is never persisted here. */
  readonly fenceTokenDigest?: string;
  /** Digest of all source messages, not the summary or active projection. */
  readonly sourceDigest: string;
  /** Digest of operation identity, source, and bounded policy. */
  readonly operationFingerprint: string;
  readonly sourceMessageCount: number;
  readonly retainedMessageCount: number;
  readonly omittedMessageCount: number;
  readonly protectedPairCount: number;
  readonly summaryRequired: boolean;
  readonly maxSummaryTokens: number;
  readonly maxRetainedMessageUnits: number;
}

export interface DurableContextCompactionRevision {
  readonly schemaVersion: "v1";
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation: number;
  readonly expectedGeneration: number;
  readonly fenceTokenDigest?: string;
  readonly sourceDigest: string;
  readonly operationFingerprint: string;
  /** The only content-bearing value persisted by this context seam. */
  readonly summary: string;
  readonly summaryDigest: string;
  /** Digest of the exact projected message list used for replay validation. */
  readonly projectionDigest?: string;
  readonly source: ContextCompactionSource;
  readonly providerFailureCode: ContextSummaryProviderFailureCode | undefined;
  readonly sourceMessageCount: number;
  readonly retainedMessageCount: number;
  readonly omittedMessageCount: number;
  readonly protectedPairCount: number;
  readonly maxSummaryTokens: number;
  readonly maxRetainedMessageUnits: number;
}

export interface DurableContextRecord {
  readonly decision: DurableContextDecisionRevision;
  readonly compaction: DurableContextCompactionRevision;
}

export interface DurableContextPersistenceInput {
  readonly decision: DurableContextDecisionRevision;
  readonly compaction: DurableContextCompactionRevision;
}

export interface DurableContextPersistenceResult {
  readonly status: "created" | "replayed";
  readonly record: DurableContextRecord;
}

/**
 * Durable callers implement this with one atomic insert-or-replay operation.
 * The adapter stores context decisions and compaction revisions; it never
 * owns or deletes the durable message history used as the source input.
 */
export interface DurableContextAdapter {
  read(operationId: string): Promise<DurableContextRecord | undefined>;
  /** Returns the latest committed generation for a context, when available. */
  readLatest?(contextId: string): Promise<number>;
  persist(input: DurableContextPersistenceInput): Promise<DurableContextPersistenceResult>;
}

export interface ContextCompactionDiagnostics {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation: number;
  readonly replayed: boolean;
  readonly source: ContextCompactionSource;
  readonly providerFailureCode: ContextSummaryProviderFailureCode | undefined;
  readonly sourceMessageCount: number;
  readonly retainedMessageCount: number;
  readonly omittedMessageCount: number;
  readonly protectedPairCount: number;
  readonly summaryTokens: number;
  readonly maxSummaryTokens: number;
  readonly maxRetainedMessageUnits: number;
  readonly sourceDigest: string;
  readonly summaryDigest: string;
  /** Content-free digest of the model-facing projection produced by this revision. */
  readonly projectionDigest: string;
}

/** Content-free lifecycle facts for the shared execution journal/telemetry path. */
export type ContextCompactionRuntimeEventType =
  | "compaction_attempted"
  | "compaction_candidate_created"
  | "compaction_committed"
  | "compaction_replayed"
  | "compaction_deferred"
  | "compaction_ineffective"
  | "compaction_cancelled"
  | "compaction_timed_out"
  | "compaction_failed"
  | "compaction_terminal";

export interface ContextCompactionRuntimeEvent {
  readonly type: ContextCompactionRuntimeEventType;
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation?: number;
  readonly sourceDigest?: string;
  readonly source?: ContextCompactionSource;
  readonly providerFailureCode?: ContextSummaryProviderFailureCode;
  readonly omittedMessageCount?: number;
  readonly retainedMessageCount?: number;
  readonly reason?: string;
  readonly errorCode?: ContextCompactionErrorCode;
  readonly attemptNumber?: number;
}

export interface ContextCompactionInput {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  /** Optional compare-and-swap predecessor; adapters may resolve it from durable state. */
  readonly expectedGeneration?: number;
  /** Session/worker fence token. Only its digest is included in durable records. */
  readonly fenceToken?: string;
  /** Durable history is read-only input. This function never mutates it. */
  readonly messages: readonly ModelMessage[];
  readonly policy?: ContextCompactionPolicy;
  readonly adapter?: DurableContextAdapter;
  readonly summaryProvider?: ContextSummaryProvider;
  readonly signal?: AbortSignal;
  /** Optional live session/fencing check performed before checkpoint and commit. */
  readonly assertFenceCurrent?: () => Promise<void> | void;
  /** Optional memory handoff called before a lossy projection is committed. */
  readonly memoryCheckpointPort?: MemoryCheckpointPort;
  /** When true, missing or failed checkpoint persistence blocks compaction. */
  readonly memoryCheckpointRequired?: boolean;
  readonly memoryRunId?: string;
  readonly memoryTurnId?: string;
  readonly memoryScope?: MemoryRuntimeScope;
  readonly sourceEventBoundary?: MemorySourceEventBoundary;
  readonly evidenceDigest?: string;
  readonly directEvidence?: MemoryDirectEvidenceEnvelope;
  /** Shared execution-journal adapter; this seam never creates a second event stream. */
  readonly onMemoryEvent?: (event: MemoryRuntimeEventPayload) => void | Promise<void>;
  /** Content-free compaction lifecycle facts for the shared journal/telemetry path. */
  readonly onCompactionEvent?: (event: ContextCompactionRuntimeEvent) => void | Promise<void>;
  /** One durable bounded budget shared by compaction and recovery attempts. */
  readonly contextAttemptBudget?: ContextAttemptBudgetPort;
  readonly contextAttemptBudgetId?: string;
  readonly contextAttemptRunId?: string;
  readonly contextAttemptTurnId?: string;
}

export interface ContextCompactionResult {
  /** Model-facing projection; omitted source messages remain durable elsewhere. */
  readonly messages: readonly ModelMessage[];
  readonly summary: string;
  readonly decision: DurableContextDecisionRevision;
  readonly revision: DurableContextCompactionRevision;
  readonly diagnostics: ContextCompactionDiagnostics;
}

export type ContextCompactionErrorCode =
  | "invalid_input"
  | "replay_conflict"
  | "fence_conflict"
  | "persistence_failed"
  | "memory_checkpoint_blocked"
  | "memory_checkpoint_failed"
  | "attempt_budget_exhausted"
  | "cancelled"
  | "candidate_invalid"
  | "no_progress"
  | "transcript_invalid";

export class ContextCompactionError extends Error {
  public constructor(
    message: string,
    public readonly code: ContextCompactionErrorCode,
    public readonly operationId?: string,
  ) {
    super(message);
    this.name = "ContextCompactionError";
  }
}

interface NormalizedPolicy {
  readonly maxSummaryTokens: number;
  readonly maxRetainedMessageUnits: number;
  readonly providerTimeoutMs: number;
  readonly charsPerToken: number;
}

interface Projection {
  readonly messages: ModelMessage[];
  readonly omittedMessages: ModelMessage[];
  readonly retainedMessageCount: number;
  readonly omittedMessageCount: number;
  readonly protectedPairCount: number;
}

interface SummarySelection {
  readonly summary: string;
  readonly source: ContextCompactionSource;
  readonly providerFailureCode: ContextSummaryProviderFailureCode | undefined;
}

/**
 * Compacts a durable transcript into an immutable revision. Replay is keyed by
 * operation id and an input fingerprint; a same-id/different-input attempt is
 * rejected rather than silently replacing a previous durable decision.
 */
export async function compactDurableContext(input: ContextCompactionInput): Promise<ContextCompactionResult> {
  try {
    return await compactDurableContextInternal(input);
  } catch (error) {
    const operationId = typeof input.operationId === "string" ? input.operationId : "unknown";
    const contextId = typeof input.contextId === "string" ? input.contextId : "unknown";
    const revision = Number.isInteger(input.revision) ? input.revision : 0;
    const code = error instanceof ContextCompactionError ? error.code : "persistence_failed";
    if (code === "no_progress") {
      await emitCompactionEvent(input, {
        type: "compaction_ineffective",
        operationId,
        contextId,
        revision,
        reason: "no_progress",
        errorCode: code,
      });
    }
    await emitCompactionEvent(input, {
      type: code === "cancelled" ? "compaction_cancelled" : code === "no_progress" || code === "candidate_invalid" || code === "attempt_budget_exhausted" ? "compaction_terminal" : "compaction_failed",
      operationId,
      contextId,
      revision,
      errorCode: code,
    });
    throw error;
  }
}

async function compactDurableContextInternal(input: ContextCompactionInput): Promise<ContextCompactionResult> {
  const operationId = normalizeIdentifier(input.operationId, "operationId");
  const contextId = normalizeIdentifier(input.contextId, "contextId");
  const revision = normalizeRevision(input.revision);
  const policy = normalizePolicy(input.policy);
  const messages = input.messages.map(cloneMessage);
  const sourceDigest = digest(messages);
  const existing = await readExisting(input.adapter, operationId);
  const expectedGeneration = input.expectedGeneration
    ?? existing?.decision.expectedGeneration
    ?? await resolveExpectedGeneration(input.adapter, contextId, undefined, revision);
  const generation = existing?.decision.generation ?? expectedGeneration + 1;
  const operationFingerprint = digest({
    operationId,
    contextId,
    revision,
    generation,
    sourceDigest,
    expectedGeneration,
    fenceTokenDigest: input.fenceToken ? digest(input.fenceToken) : undefined,
    policy,
  });

  if (existing) {
    assertReplayCompatible(existing, { operationId, contextId, revision, generation, expectedGeneration, sourceDigest, operationFingerprint });
    await emitCompactionEvent(input, {
      type: "compaction_replayed",
      operationId,
      contextId,
      revision,
      generation,
      sourceDigest,
      source: existing.compaction.source,
      providerFailureCode: existing.compaction.providerFailureCode,
      omittedMessageCount: existing.compaction.omittedMessageCount,
      retainedMessageCount: existing.compaction.retainedMessageCount,
    });
    return resultFromRecord(messages, existing, true, existing.compaction.providerFailureCode, policy);
  }

  await assertCompactionCanCommit(input, operationId);
  const projection = selectProjection(messages, policy.maxRetainedMessageUnits);
  await emitCompactionEvent(input, {
    type: projection.omittedMessageCount > 0 ? "compaction_attempted" : "compaction_deferred",
    operationId,
    contextId,
    revision,
    generation,
    sourceDigest,
    omittedMessageCount: projection.omittedMessageCount,
    retainedMessageCount: projection.retainedMessageCount,
    ...(projection.omittedMessageCount === 0 ? { reason: "no_lossy_rewrite_required" } : {}),
  });
  const attemptReceipt = projection.omittedMessageCount > 0
    ? await reserveContextAttempt(input, { operationId, contextId })
    : undefined;
  // The memory seam is also the durable capture boundary. When memory is
  // required, capture the source range even if this particular projection
  // did not omit messages; a later retry or compaction must not be the first
  // time the turn becomes durable memory evidence.
  if (projection.omittedMessageCount > 0 || input.memoryCheckpointRequired) {
    await checkpointMemoryBeforeCompaction(input, {
      operationId,
      contextId,
      generation,
      sourceDigest,
      messages,
    });
  }
  const selection = await selectSummary({
    operationId,
    contextId,
    revision,
    generation,
    omittedMessages: projection.omittedMessages,
    policy,
    summaryProvider: input.summaryProvider,
    signal: input.signal,
  });
  await assertCompactionCanCommit(input, operationId);
  const projectedMessages = applySummary(projection, selection.summary);
  validateCompactionCandidate({
    messages,
    projection,
    projectedMessages,
    selection,
    policy,
    operationId,
    allowNoProgress: input.memoryCheckpointRequired === true,
  });
  if (projection.omittedMessageCount === 0) {
    await emitCompactionEvent(input, {
      type: "compaction_ineffective",
      operationId,
      contextId,
      revision,
      generation,
      sourceDigest,
      reason: "no_lossy_rewrite_required",
      omittedMessageCount: 0,
      retainedMessageCount: projection.retainedMessageCount,
    });
  } else {
    await emitCompactionEvent(input, {
      type: "compaction_candidate_created",
      operationId,
      contextId,
      revision,
      generation,
      sourceDigest,
      source: selection.source,
      providerFailureCode: selection.providerFailureCode,
      omittedMessageCount: projection.omittedMessageCount,
      retainedMessageCount: projection.retainedMessageCount,
    });
    if (selection.providerFailureCode === "provider_timeout") {
      await emitCompactionEvent(input, {
        type: "compaction_timed_out",
        operationId,
        contextId,
        revision,
        generation,
        sourceDigest,
        source: selection.source,
        providerFailureCode: selection.providerFailureCode,
        reason: "summary_provider_timeout_fell_back_to_deterministic_summary",
      });
    }
  }
  const record = createRecord({
    operationId,
    contextId,
    revision,
    generation,
    sourceDigest,
    operationFingerprint,
    expectedGeneration,
    fenceTokenDigest: input.fenceToken ? digest(input.fenceToken) : undefined,
    policy,
    projection,
    selection,
  });

  let persisted = record;
  let replayed = false;
  if (input.adapter) {
    let persistence: DurableContextPersistenceResult;
    try {
      await assertCompactionCanCommit(input, operationId);
      persistence = await input.adapter.persist({ decision: record.decision, compaction: record.compaction });
    } catch (error) {
      if (error instanceof Error && error.message === "CONTEXT_COMPACTION_FENCE_CONFLICT") {
        throw new ContextCompactionError("Context compaction lost its durable generation fence.", "fence_conflict", operationId);
      }
      throw new ContextCompactionError("Context compaction persistence failed.", "persistence_failed", operationId);
    }
    assertReplayCompatible(persistence.record, { operationId, contextId, revision, generation, expectedGeneration, sourceDigest, operationFingerprint });
    persisted = persistence.record;
    replayed = persistence.status === "replayed";
  }

  if (attemptReceipt && input.contextAttemptBudget) {
    try {
      await input.contextAttemptBudget.consume(attemptReceipt);
    } catch {
      throw new ContextCompactionError("Context compaction completed but its durable attempt budget could not be settled.", "persistence_failed", operationId);
    }
  }

  await emitCompactionEvent(input, {
    type: replayed ? "compaction_replayed" : "compaction_committed",
    operationId,
    contextId,
    revision,
    generation,
    sourceDigest,
    source: persisted.compaction.source,
    providerFailureCode: persisted.compaction.providerFailureCode,
    omittedMessageCount: persisted.compaction.omittedMessageCount,
    retainedMessageCount: persisted.compaction.retainedMessageCount,
  });

  return resultFromRecord(messages, persisted, replayed, selection.providerFailureCode, policy);
}

async function reserveContextAttempt(
  input: ContextCompactionInput,
  context: { operationId: string; contextId: string },
): Promise<ContextAttemptBudgetReceipt | undefined> {
  if (!input.contextAttemptBudget) return undefined;
  const result = await input.contextAttemptBudget.reserve({
    budgetId: input.contextAttemptBudgetId ?? `context-attempts:${context.contextId}`,
    runId: input.contextAttemptRunId ?? context.contextId,
    turnId: input.contextAttemptTurnId ?? context.operationId,
    operationKey: context.operationId,
    kind: "proactive_compaction",
  });
  if (result.status === "exhausted") {
    throw new ContextCompactionError("The durable context attempt budget is exhausted.", "attempt_budget_exhausted", context.operationId);
  }
  return result.receipt;
}

async function emitCompactionEvent(input: ContextCompactionInput, event: ContextCompactionRuntimeEvent): Promise<void> {
  try {
    await input.onCompactionEvent?.(event);
  } catch {
    // Telemetry must not change the durable context decision.
  }
}

async function assertCompactionCanCommit(input: ContextCompactionInput, operationId: string): Promise<void> {
  if (input.signal?.aborted) throw new ContextCompactionError("Context compaction was cancelled.", "cancelled", operationId);
  try {
    await input.assertFenceCurrent?.();
  } catch {
    throw new ContextCompactionError("Context compaction lost its active session fence.", "fence_conflict", operationId);
  }
}

function validateCompactionCandidate(input: {
  readonly messages: readonly ModelMessage[];
  readonly projection: Projection;
  readonly projectedMessages: readonly ModelMessage[];
  readonly selection: SummarySelection;
  readonly policy: NormalizedPolicy;
  readonly operationId: string;
  readonly allowNoProgress: boolean;
}): void {
  if (estimateSummaryTokens(input.selection.summary, input.policy.charsPerToken) > input.policy.maxSummaryTokens) {
    throw new ContextCompactionError("The context summary exceeds its bounded candidate budget.", "candidate_invalid", input.operationId);
  }
  if (!hasCompleteToolPairs(input.projectedMessages)) {
    throw new ContextCompactionError("The context compaction candidate would split a tool call/result pair.", "candidate_invalid", input.operationId);
  }
  // A one-message omission may legitimately be replaced by one bounded
  // summary message. The hard progress invariant is therefore structural:
  // candidates must omit an eligible range and retain a bounded projection;
  // request-fit progress is validated by the next provider-aware planner.
  if (!input.allowNoProgress && input.projection.omittedMessageCount === 0) {
    throw new ContextCompactionError("The context compaction candidate makes no material progress.", "no_progress", input.operationId);
  }
}

function hasCompleteToolPairs(messages: readonly ModelMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        const identity = toolOperationIdentity(call);
        if (identity) pending.add(identity);
      }
      continue;
    }
    if (message.role === "tool") {
      const identity = toolOperationIdentity(message);
      if (!identity || !pending.has(identity)) return false;
      pending.delete(identity);
    }
  }
  return pending.size === 0;
}

async function checkpointMemoryBeforeCompaction(
  input: ContextCompactionInput,
  context: { operationId: string; contextId: string; generation: number; sourceDigest: string; messages: readonly ModelMessage[] },
): Promise<void> {
  const runId = input.memoryRunId ?? context.contextId;
  const turnId = input.memoryTurnId ?? context.operationId;
  const sourceEventBoundary = input.sourceEventBoundary ?? sourceEventBoundaryFromMessages(context.messages);
  const directEvidence = input.directEvidence ?? directEvidenceEnvelopeFromMessages(context.messages);
  const evidenceDigest = input.evidenceDigest ?? context.sourceDigest;
  const emit = async (event: MemoryRuntimeEventPayload): Promise<void> => {
    await input.onMemoryEvent?.(event);
  };
  if (!input.memoryCheckpointPort && !input.memoryCheckpointRequired) return;
  const requested = {
    type: "memory_checkpoint_requested" as const,
    runId,
    turnId,
    compactionGeneration: context.generation,
    sourceEventBoundaryDigest: sourceEventBoundary.digest,
  };
  await emit(requested);
  if (!input.memoryCheckpointPort) {
    if (input.memoryCheckpointRequired) {
      await emit({ ...requested, type: "memory_checkpoint_blocked", status: "blocked", reason: "checkpoint_port_missing", errorCode: "MEMORY_CHECKPOINT_PORT_MISSING" });
      throw new ContextCompactionError("Memory evidence must be checkpointed before context compaction.", "memory_checkpoint_blocked", context.operationId);
    }
    return;
  }
  if (!input.memoryScope) {
    await emit({ ...requested, type: "memory_checkpoint_failed", status: "failed", reason: "scope_missing", errorCode: "MEMORY_CHECKPOINT_SCOPE_MISSING" });
    if (input.memoryCheckpointRequired) {
      await emit({
        ...requested,
        type: "memory_checkpoint_blocked",
        status: "blocked",
        reason: "scope_missing",
        errorCode: "MEMORY_CHECKPOINT_SCOPE_MISSING",
      });
      throw new ContextCompactionError("Memory checkpoint scope is missing.", "memory_checkpoint_blocked", context.operationId);
    }
    return;
  }
  try {
    const result = await input.memoryCheckpointPort.checkpoint({
      runId,
      turnId,
      compactionGeneration: context.generation,
      sourceEventBoundary,
      scope: input.memoryScope,
      evidenceDigest,
      directEvidence,
    });
    await emit({
      ...requested,
      type: "memory_checkpoint_committed",
      status: result.status,
      checkpointId: result.checkpointId,
    });
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "MEMORY_CHECKPOINT_FAILED";
    await emit({ ...requested, type: "memory_checkpoint_failed", status: "failed", errorCode });
    if (input.memoryCheckpointRequired) {
      await emit({
        ...requested,
        type: "memory_checkpoint_blocked",
        status: "blocked",
        reason: "checkpoint_failed",
        errorCode,
      });
      throw new ContextCompactionError("Memory checkpoint failed; context compaction is blocked.", "memory_checkpoint_blocked", context.operationId);
    }
  }
}

/**
 * Deterministic, evidence-preserving fallback. It emits bounded excerpts of
 * source content in source order. It does not paraphrase, infer, or delete
 * the durable messages passed to the compaction function.
 */
export function deterministicFallbackSummary(messages: readonly ModelMessage[], maxSummaryTokens: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): string {
  const normalizedMaxTokens = normalizePositiveInteger(maxSummaryTokens, DEFAULT_MAX_SUMMARY_TOKENS);
  const normalizedCharsPerToken = normalizeCharsPerToken(charsPerToken);
  const maxCharacters = Math.max(1, normalizedMaxTokens * normalizedCharsPerToken);
  const header = `[Durable history excerpts; ${messages.length} messages omitted from active context. Durable history remains unchanged.]`;
  let summary = header.slice(0, maxCharacters);
  if (summary.length >= maxCharacters) return summary;

  for (const message of messages) {
    const line = messageExcerpt(message);
    const separator = summary.length ? "\n" : "";
    const remaining = maxCharacters - summary.length - separator.length;
    if (remaining <= 0) break;
    if (line.length <= remaining) {
      summary += separator + line;
      continue;
    }
    const marker = " [excerpt truncated]";
    if (remaining <= marker.length) summary += separator + line.slice(0, remaining);
    else summary += separator + line.slice(0, remaining - marker.length) + marker;
    break;
  }
  return summary;
}

function normalizePolicy(policy: ContextCompactionPolicy | undefined): NormalizedPolicy {
  return {
    maxSummaryTokens: normalizePositiveInteger(policy?.maxSummaryTokens, DEFAULT_MAX_SUMMARY_TOKENS),
    maxRetainedMessageUnits: normalizePositiveInteger(policy?.maxRetainedMessageUnits, DEFAULT_MAX_RETAINED_MESSAGE_UNITS),
    providerTimeoutMs: normalizePositiveInteger(policy?.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS),
    charsPerToken: normalizeCharsPerToken(policy?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN),
  };
}

async function readExisting(adapter: DurableContextAdapter | undefined, operationId: string): Promise<DurableContextRecord | undefined> {
  if (!adapter) return undefined;
  try {
    return await adapter.read(operationId);
  } catch {
    throw new ContextCompactionError("Context compaction replay lookup failed.", "persistence_failed", operationId);
  }
}

async function resolveExpectedGeneration(
  adapter: DurableContextAdapter | undefined,
  contextId: string,
  requested: number | undefined,
  revision: number,
): Promise<number> {
  if (requested !== undefined) return normalizeGeneration(requested);
  if (adapter?.readLatest) {
    try {
      return normalizeGeneration(await adapter.readLatest(contextId));
    } catch {
      throw new ContextCompactionError("Context compaction generation could not be loaded.", "persistence_failed");
    }
  }
  return Math.max(0, revision - 1);
}

function assertReplayCompatible(
  record: DurableContextRecord,
  expected: { operationId: string; contextId: string; revision: number; generation: number; expectedGeneration: number; sourceDigest: string; operationFingerprint: string },
): void {
  const decision = record.decision;
  const compaction = record.compaction;
  if (
    decision.operationId !== expected.operationId
    || compaction.operationId !== expected.operationId
    || decision.contextId !== expected.contextId
    || compaction.contextId !== expected.contextId
    || decision.revision !== expected.revision
    || compaction.revision !== expected.revision
    || decision.generation !== expected.generation
    || compaction.generation !== expected.generation
    || decision.expectedGeneration !== expected.expectedGeneration
    || compaction.expectedGeneration !== expected.expectedGeneration
    || decision.sourceDigest !== expected.sourceDigest
    || compaction.sourceDigest !== expected.sourceDigest
    || decision.operationFingerprint !== expected.operationFingerprint
    || compaction.operationFingerprint !== expected.operationFingerprint
  ) {
    throw new ContextCompactionError("Context compaction operation identity conflicts with a durable revision.", "replay_conflict", expected.operationId);
  }
}

async function selectSummary(input: {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation: number;
  readonly omittedMessages: readonly ModelMessage[];
  readonly policy: NormalizedPolicy;
  readonly summaryProvider: ContextSummaryProvider | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<SummarySelection> {
  if (!input.omittedMessages.length) return { summary: "", source: "none", providerFailureCode: undefined };
  if (!input.summaryProvider) {
    return {
      summary: deterministicFallbackSummary(input.omittedMessages, input.policy.maxSummaryTokens, input.policy.charsPerToken),
      source: "deterministic_fallback",
      providerFailureCode: undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = (): void => controller.abort();
  if (input.signal?.aborted) {
    return fallbackAfterProviderFailure(input.omittedMessages, input.policy, "provider_aborted");
  }
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("context_summary_provider_timeout"));
      }, input.policy.providerTimeoutMs);
    });
    const providerWork = input.summaryProvider.summarize({
      operationId: input.operationId,
      contextId: input.contextId,
      revision: input.revision,
      messages: input.omittedMessages.map(cloneMessage),
      maxSummaryTokens: input.policy.maxSummaryTokens,
      signal: controller.signal,
    });
    const result = await Promise.race([providerWork, timeout]);
    const summary = typeof result.summary === "string" ? result.summary.trim() : "";
    if (!summary) return fallbackAfterProviderFailure(input.omittedMessages, input.policy, "provider_empty_result");
    if (estimateSummaryTokens(summary, input.policy.charsPerToken) > input.policy.maxSummaryTokens) {
      return fallbackAfterProviderFailure(input.omittedMessages, input.policy, "provider_result_over_budget");
    }
    return { summary, source: "provider", providerFailureCode: undefined };
  } catch (error) {
    const failureCode: ContextSummaryProviderFailureCode = timedOut
      ? "provider_timeout"
      : input.signal?.aborted
        ? "provider_aborted"
        : isAbortError(error)
          ? "provider_aborted"
          : "provider_error";
    return fallbackAfterProviderFailure(input.omittedMessages, input.policy, failureCode);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function fallbackAfterProviderFailure(
  messages: readonly ModelMessage[],
  policy: NormalizedPolicy,
  providerFailureCode: ContextSummaryProviderFailureCode,
): SummarySelection {
  return {
    summary: deterministicFallbackSummary(messages, policy.maxSummaryTokens, policy.charsPerToken),
    source: "deterministic_fallback",
    providerFailureCode,
  };
}

function createRecord(input: {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation: number;
  readonly sourceDigest: string;
  readonly operationFingerprint: string;
  readonly expectedGeneration: number;
  readonly fenceTokenDigest: string | undefined;
  readonly policy: NormalizedPolicy;
  readonly projection: Projection;
  readonly selection: SummarySelection;
}): DurableContextRecord {
  const summaryDigest = digest(input.selection.summary);
  const projectionDigest = digest(applySummary(input.projection, input.selection.summary));
  const shared = {
    schemaVersion: "v1" as const,
    operationId: input.operationId,
    contextId: input.contextId,
    revision: input.revision,
    generation: input.generation,
    expectedGeneration: input.expectedGeneration,
    ...(input.fenceTokenDigest ? { fenceTokenDigest: input.fenceTokenDigest } : {}),
    sourceDigest: input.sourceDigest,
    operationFingerprint: input.operationFingerprint,
    sourceMessageCount: input.projection.omittedMessages.length + input.projection.retainedMessageCount,
    retainedMessageCount: input.projection.retainedMessageCount,
    omittedMessageCount: input.projection.omittedMessageCount,
    protectedPairCount: input.projection.protectedPairCount,
    maxSummaryTokens: input.policy.maxSummaryTokens,
    maxRetainedMessageUnits: input.policy.maxRetainedMessageUnits,
  };
  return {
    decision: {
      ...shared,
      summaryRequired: input.projection.omittedMessageCount > 0,
    },
    compaction: {
      ...shared,
      summary: input.selection.summary,
      summaryDigest,
      projectionDigest,
      source: input.selection.source,
      providerFailureCode: input.selection.providerFailureCode,
    },
  };
}

function resultFromRecord(
  messages: readonly ModelMessage[],
  record: DurableContextRecord,
  replayed: boolean,
  providerFailureCode: ContextSummaryProviderFailureCode | undefined,
  policy: NormalizedPolicy,
): ContextCompactionResult {
  const projection = selectProjection(messages, record.compaction.maxRetainedMessageUnits);
  if (projection.omittedMessageCount !== record.compaction.omittedMessageCount || projection.retainedMessageCount !== record.compaction.retainedMessageCount) {
    throw new ContextCompactionError("Durable context revision does not match the current source projection.", "replay_conflict", record.compaction.operationId);
  }
  const projectedMessages = applySummary(projection, record.compaction.summary);
  const projectionDigest = digest(projectedMessages);
  if (record.compaction.projectionDigest && record.compaction.projectionDigest !== projectionDigest) {
    throw new ContextCompactionError("Durable context revision does not match the projected request.", "replay_conflict", record.compaction.operationId);
  }
  const summaryTokens = estimateSummaryTokens(record.compaction.summary, policy.charsPerToken);
  return {
    messages: projectedMessages,
    summary: record.compaction.summary,
    decision: record.decision,
    revision: record.compaction,
    diagnostics: {
      operationId: record.compaction.operationId,
      contextId: record.compaction.contextId,
      revision: record.compaction.revision,
      generation: record.compaction.generation,
      replayed,
      source: record.compaction.source,
      providerFailureCode: providerFailureCode ?? record.compaction.providerFailureCode,
      sourceMessageCount: record.compaction.sourceMessageCount,
      retainedMessageCount: record.compaction.retainedMessageCount,
      omittedMessageCount: record.compaction.omittedMessageCount,
      protectedPairCount: record.compaction.protectedPairCount,
      summaryTokens,
      maxSummaryTokens: record.compaction.maxSummaryTokens,
      maxRetainedMessageUnits: record.compaction.maxRetainedMessageUnits,
      sourceDigest: record.compaction.sourceDigest,
      summaryDigest: record.compaction.summaryDigest,
      projectionDigest,
    },
  };
}

function selectProjection(messages: readonly ModelMessage[], maxRetainedMessageUnits: number): Projection {
  const systemMessages = messages.filter((message) => message.role === "system").map(cloneMessage);
  const bodyMessages = messages.filter((message) => message.role !== "system");
  if (validateModelTranscript(bodyMessages).length > 0) {
    throw new ContextCompactionError("Context compaction cannot split or repair an incomplete tool round.", "transcript_invalid");
  }
  const units = buildTranscriptUnits(bodyMessages, { clone: true });
  const retainedIndexes = new Set<number>();
  for (let index = Math.max(0, units.length - maxRetainedMessageUnits); index < units.length; index += 1) retainedIndexes.add(index);
  // A tail-only slice is not sufficient when an external event or an
  // interrupted tool result follows the active task. Keep the newest user
  // task as a protected structural unit even when it falls before the tail.
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]?.messages.some((message) => message.role === "user")) {
      retainedIndexes.add(index);
      break;
    }
  }
  const omittedUnits = units.filter((_unit, index) => !retainedIndexes.has(index));
  const retainedUnits = units.filter((_unit, index) => retainedIndexes.has(index));
  const omittedMessages = omittedUnits.flatMap((unit) => unit.messages.map(cloneMessage));
  const retainedMessages = retainedUnits.flatMap((unit) => unit.messages.map(cloneMessage));
  return {
    messages: [...systemMessages, ...retainedMessages],
    omittedMessages,
    retainedMessageCount: systemMessages.length + retainedMessages.length,
    omittedMessageCount: omittedMessages.length,
    protectedPairCount: retainedUnits.filter((unit) => unit.protectedPair).length,
  };
}

function applySummary(projection: Projection, summary: string): ModelMessage[] {
  if (!summary) return projection.messages.map(cloneMessage);
  const systemCount = projection.messages.filter((message) => message.role === "system").length;
  const system = projection.messages.slice(0, systemCount).map(cloneMessage);
  const retained = projection.messages.slice(systemCount).map(cloneMessage);
  const summaryMessage: ModelMessage = {
    role: "system",
    content: `<untrusted-data source="${SUMMARY_SOURCE_MARKER}">\n${summary}\n</untrusted-data>`,
  };
  return [...system, summaryMessage, ...retained];
}

function messageExcerpt(message: ModelMessage): string {
  const role = message.role;
  const content = JSON.stringify(message.content);
  const calls = message.toolCalls?.length
    ? ` [tool_calls=${message.toolCalls.map((call) => call.name).join(",")}]`
    : "";
  return `- ${role}: ${content}${calls}`;
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(cloneToolCall) } : {}),
  };
}

function cloneToolCall(call: ModelToolCall): ModelToolCall {
  return { ...call, arguments: { ...call.arguments } };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function estimateSummaryTokens(value: string, charsPerToken: number): number {
  return Math.max(0, Math.ceil(value.length / charsPerToken));
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ContextCompactionError(`A non-empty ${field} is required.`, "invalid_input");
  return normalized;
}

function normalizeRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new ContextCompactionError("A positive context revision is required.", "invalid_input");
  return value;
}

function normalizeGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new ContextCompactionError("A non-negative context generation is required.", "invalid_input");
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function normalizeCharsPerToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHARS_PER_TOKEN;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
