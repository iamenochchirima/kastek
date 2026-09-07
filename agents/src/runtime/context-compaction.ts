import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolCall } from "../model/types";

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
  readonly sourceDigest: string;
  readonly operationFingerprint: string;
  /** The only content-bearing value persisted by this context seam. */
  readonly summary: string;
  readonly summaryDigest: string;
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
  persist(input: DurableContextPersistenceInput): Promise<DurableContextPersistenceResult>;
}

export interface ContextCompactionDiagnostics {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
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
}

export interface ContextCompactionInput {
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  /** Durable history is read-only input. This function never mutates it. */
  readonly messages: readonly ModelMessage[];
  readonly policy?: ContextCompactionPolicy;
  readonly adapter?: DurableContextAdapter;
  readonly summaryProvider?: ContextSummaryProvider;
  readonly signal?: AbortSignal;
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
  | "persistence_failed";

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

interface MessageUnit {
  readonly messages: ModelMessage[];
  readonly protectedPair: boolean;
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
  const operationId = normalizeIdentifier(input.operationId, "operationId");
  const contextId = normalizeIdentifier(input.contextId, "contextId");
  const revision = normalizeRevision(input.revision);
  const policy = normalizePolicy(input.policy);
  const messages = input.messages.map(cloneMessage);
  const sourceDigest = digest(messages);
  const operationFingerprint = digest({
    operationId,
    contextId,
    revision,
    sourceDigest,
    policy,
  });

  const existing = await readExisting(input.adapter, operationId);
  if (existing) {
    assertReplayCompatible(existing, { operationId, contextId, revision, sourceDigest, operationFingerprint });
    return resultFromRecord(messages, existing, true, existing.compaction.providerFailureCode, policy);
  }

  const projection = selectProjection(messages, policy.maxRetainedMessageUnits);
  const selection = await selectSummary({
    operationId,
    contextId,
    revision,
    omittedMessages: projection.omittedMessages,
    policy,
    summaryProvider: input.summaryProvider,
    signal: input.signal,
  });
  const record = createRecord({
    operationId,
    contextId,
    revision,
    sourceDigest,
    operationFingerprint,
    policy,
    projection,
    selection,
  });

  let persisted = record;
  let replayed = false;
  if (input.adapter) {
    let persistence: DurableContextPersistenceResult;
    try {
      persistence = await input.adapter.persist({ decision: record.decision, compaction: record.compaction });
    } catch {
      throw new ContextCompactionError("Context compaction persistence failed.", "persistence_failed", operationId);
    }
    assertReplayCompatible(persistence.record, { operationId, contextId, revision, sourceDigest, operationFingerprint });
    persisted = persistence.record;
    replayed = persistence.status === "replayed";
  }

  return resultFromRecord(messages, persisted, replayed, selection.providerFailureCode, policy);
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

function assertReplayCompatible(
  record: DurableContextRecord,
  expected: { operationId: string; contextId: string; revision: number; sourceDigest: string; operationFingerprint: string },
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
  readonly sourceDigest: string;
  readonly operationFingerprint: string;
  readonly policy: NormalizedPolicy;
  readonly projection: Projection;
  readonly selection: SummarySelection;
}): DurableContextRecord {
  const summaryDigest = digest(input.selection.summary);
  const shared = {
    schemaVersion: "v1" as const,
    operationId: input.operationId,
    contextId: input.contextId,
    revision: input.revision,
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
    },
  };
}

function selectProjection(messages: readonly ModelMessage[], maxRetainedMessageUnits: number): Projection {
  const systemMessages = messages.filter((message) => message.role === "system").map(cloneMessage);
  const bodyMessages = messages.filter((message) => message.role !== "system");
  const units = buildMessageUnits(bodyMessages);
  const retainedUnitStart = Math.max(0, units.length - maxRetainedMessageUnits);
  const omittedUnits = units.slice(0, retainedUnitStart);
  const retainedUnits = units.slice(retainedUnitStart);
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

function buildMessageUnits(messages: readonly ModelMessage[]): MessageUnit[] {
  const units: MessageUnit[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push({ messages: [cloneMessage(message)], protectedPair: false });
      index += 1;
      continue;
    }
    const expected = new Set(message.toolCalls.map((call) => call.id));
    const pair: ModelMessage[] = [cloneMessage(message)];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool" && expected.has(messages[cursor]?.toolCallId ?? "")) {
      pair.push(cloneMessage(messages[cursor]!));
      cursor += 1;
    }
    units.push({ messages: pair, protectedPair: pair.length > 1 });
    index = cursor;
  }
  return units;
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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function normalizeCharsPerToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHARS_PER_TOKEN;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
