import type { ContextCompactionRuntimeEventType } from "./context-compaction";
import type { ContextMeasurementBasis, ContextPlanDecision, ContextPressure, ContextRequestManifest } from "./context-planning";

export interface RuntimeTelemetrySnapshot {
  readonly runId?: string;
  readonly turnId?: string;
  /** Monotonic projection revision for correlating UI details with journal evidence. */
  readonly revision: number;
  readonly observedAt: string;
  readonly context: {
    readonly tokens?: number;
    readonly basis: ContextMeasurementBasis | "not_measured";
    readonly contextWindowTokens?: number;
    readonly utilizationPercent?: number;
    readonly reservedOutputTokens?: number;
    readonly safetyMarginTokens?: number;
    readonly softThresholdTokens?: number;
    readonly hardLimitTokens?: number;
    readonly pressure?: ContextPressure;
    readonly capabilitySource?: string;
    readonly decision?: ContextPlanDecision;
    readonly compactionCount: number;
    readonly manifestDigest?: string;
    readonly manifest?: ContextRequestManifest;
    readonly usageAnchorOperationKey?: string;
    readonly latestCompaction?: RuntimeCompactionSnapshot;
  };
  readonly modelAttempt?: RuntimeModelAttemptSnapshot;
  readonly attempts: readonly RuntimeModelAttemptSnapshot[];
  readonly turn: {
    readonly status: "running" | "completed" | "failed" | "limited" | "waiting";
    readonly admittedAt?: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly elapsedMs?: number;
    readonly waitMs?: number;
  };
  readonly rolling: {
    readonly sampleCount: number;
    readonly latencyMs?: number;
    readonly outputTokensPerSecond?: number;
  };
}

export interface RuntimeModelAttemptSnapshot {
  readonly status: "queued" | "running" | "streaming" | "completed" | "failed";
  readonly provider?: string;
  readonly model?: string;
  readonly operationKey?: string;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly firstTokenAt?: string;
  readonly completedAt?: string;
  /** Time spent admitted/queued before the provider call began. */
  readonly queueMs?: number;
  /** Time from provider call start until the first streamed token. */
  readonly timeToFirstTokenMs?: number;
  readonly latencyMs?: number;
  readonly outputTokens?: number;
  readonly throughputTokensPerSecond?: number;
  readonly errorCode?: string;
}

export interface RuntimeCompactionSnapshot {
  readonly type: ContextCompactionRuntimeEventType;
  readonly operationId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly generation?: number;
  readonly source?: string;
  readonly providerFailureCode?: string;
  readonly omittedMessageCount?: number;
  readonly retainedMessageCount?: number;
  readonly reason?: string;
  readonly errorCode?: string;
}

interface ModelSample {
  readonly latencyMs: number;
  readonly outputTokens: number;
}

/**
 * Event-fed telemetry read model. It owns presentation calculations while
 * remaining independent from storage, HTTP, and the Playground. The event
 * journal remains authoritative; this reducer can be rebuilt after a cursor
 * replay or worker replacement.
 */
export class RuntimeTelemetryAccumulator {
  private readonly samples: ModelSample[] = [];
  private readonly completedOperationKeys = new Set<string>();
  private waitStartedAt?: string;
  private revision = 0;
  private awaitingPostCompactionAnchor = false;
  private snapshotState: RuntimeTelemetrySnapshot;

  public constructor(identity: Pick<RuntimeTelemetrySnapshot, "runId" | "turnId"> = {}) {
    this.snapshotState = {
      ...identity,
      revision: 0,
      observedAt: new Date(0).toISOString(),
      context: { basis: "not_measured", compactionCount: 0 },
      attempts: [],
      turn: { status: "running" },
      rolling: { sampleCount: 0 },
    };
  }

  public apply(input: {
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly observedAt?: string;
  }): RuntimeTelemetrySnapshot {
    this.revision += 1;
    this.snapshotState = { ...this.snapshotState, revision: this.revision };
    const observedAt = input.observedAt ?? new Date().toISOString();
    const payload = input.payload;
    if (input.type === "loop.started") {
      // Internal compaction/retry markers are progress within the same turn,
      // not a new admission. Never reset the turn clock for those markers.
      if (payload.phase === "iteration" || (payload.phase === undefined && payload.reason !== undefined)) return this.snapshot(observedAt);
      const resumedWaitMs = this.waitStartedAt ? Math.max(0, Date.parse(observedAt) - Date.parse(this.waitStartedAt)) : 0;
      this.waitStartedAt = undefined;
      const admittedAt = stringValue(payload.admittedAt) ?? this.snapshotState.turn.admittedAt ?? stringValue(payload.startedAt) ?? observedAt;
      const startedAt = this.snapshotState.turn.startedAt ?? stringValue(payload.startedAt) ?? observedAt;
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        turn: {
          ...this.snapshotState.turn,
          status: "running",
          admittedAt,
          startedAt,
          ...(resumedWaitMs > 0 ? { waitMs: (this.snapshotState.turn.waitMs ?? 0) + resumedWaitMs } : {}),
          finishedAt: undefined,
        },
      };
    } else if (input.type === "context.planned") {
      const accounting = recordValue(payload.accounting);
      const decision = contextDecision(payload.decision);
      const manifest = recordValue(payload.manifest);
      const contextWindowTokens = integerValue(accounting?.contextWindowTokens);
      const tokens = integerValue(accounting?.estimatedInputTokens);
      // A wire-only prune is fully accounted before dispatch. Only a lossy
      // durable compaction invalidates the prior occupancy estimate.
      const compactionInvalidatedEstimate = decision === "compact" || this.awaitingPostCompactionAnchor;
      const basis = compactionInvalidatedEstimate ? "unknown_after_compaction" : "full_estimate";
      if (decision === "compact") this.awaitingPostCompactionAnchor = true;
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        context: {
          ...this.snapshotState.context,
          tokens: basis === "unknown_after_compaction" ? undefined : tokens,
          basis,
          contextWindowTokens,
          // A compacted projection no longer describes the exact payload that
          // was dispatched. Showing the pre-compaction estimate as live
          // utilization would make the status row look authoritative when it
          // is not. The next provider-reported usage re-anchors it.
          utilizationPercent: basis === "unknown_after_compaction" ? undefined : utilization(tokens, contextWindowTokens),
          reservedOutputTokens: integerValue(accounting?.reservedOutputTokens),
          safetyMarginTokens: integerValue(accounting?.safetyMarginTokens),
          softThresholdTokens: integerValue(accounting?.softThresholdTokens),
          hardLimitTokens: integerValue(accounting?.hardLimitTokens),
          pressure: contextPressure(accounting?.pressure),
          capabilitySource: stringValue(accounting?.capabilitySource),
          decision,
          compactionCount: this.snapshotState.context.compactionCount + (decision === "compact" ? 1 : 0),
          manifestDigest: stringValue(manifest?.digest),
          manifest: isManifest(manifest) ? manifest : undefined,
        },
      };
    } else if (isCompactionEventType(input.type)) {
      const operationId = stringValue(payload.operationId);
      const contextId = stringValue(payload.contextId);
      const revision = integerValue(payload.revision);
      if (operationId && contextId && revision !== undefined) {
        if (input.type === "compaction_committed" || input.type === "compaction_replayed") {
          this.awaitingPostCompactionAnchor = true;
        }
        this.snapshotState = {
          ...this.snapshotState,
          observedAt,
          context: {
            ...this.snapshotState.context,
            ...(input.type === "compaction_committed" || input.type === "compaction_replayed"
              ? { basis: "unknown_after_compaction" as const, tokens: undefined, utilizationPercent: undefined }
              : {}),
            latestCompaction: {
              type: input.type,
              operationId,
              contextId,
              revision,
              ...(integerValue(payload.generation) === undefined ? {} : { generation: integerValue(payload.generation) }),
              ...(stringValue(payload.source) ? { source: stringValue(payload.source) } : {}),
              ...(stringValue(payload.providerFailureCode) ? { providerFailureCode: stringValue(payload.providerFailureCode) } : {}),
              ...(integerValue(payload.omittedMessageCount) === undefined ? {} : { omittedMessageCount: integerValue(payload.omittedMessageCount) }),
              ...(integerValue(payload.retainedMessageCount) === undefined ? {} : { retainedMessageCount: integerValue(payload.retainedMessageCount) }),
              ...(stringValue(payload.reason) ? { reason: stringValue(payload.reason) } : {}),
              ...(stringValue(payload.errorCode) ? { errorCode: stringValue(payload.errorCode) } : {}),
            },
          },
        };
      }
    } else if (input.type === "model.started") {
      const queuedAt = stringValue(payload.queuedAt);
      const startedAt = stringValue(payload.startedAt) ?? observedAt;
      const modelAttempt: RuntimeModelAttemptSnapshot = {
        status: "running",
        provider: stringValue(payload.provider),
        model: stringValue(payload.model),
        operationKey: stringValue(payload.operationKey),
        ...(queuedAt ? { queuedAt } : {}),
        startedAt,
        ...(queuedAt ? { queueMs: elapsedBetween(queuedAt, startedAt) } : {}),
      };
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        modelAttempt,
        attempts: upsertAttempt(this.snapshotState.attempts, modelAttempt),
      };
    } else if (input.type === "model.completed") {
      const operationKey = stringValue(payload.operationKey);
      const latencyMs = nonNegativeNumber(payload.latencyMs);
      const outputTokens = nonNegativeNumber(payload.outputTokens);
      const providerInputTokens = nonNegativeNumber(payload.inputTokens);
      const reportedBasis = stringValue(payload.contextMeasurementBasis);
      const providerReported = reportedBasis === "provider_reported";
      const usageAnchor = recordValue(payload.contextUsageAnchor);
      const firstTokenAt = stringValue(payload.firstTokenAt) ?? this.snapshotState.modelAttempt?.firstTokenAt;
      const timeToFirstTokenMs = nonNegativeNumber(payload.timeToFirstTokenMs)
        ?? (firstTokenAt && this.snapshotState.modelAttempt?.startedAt
          ? elapsedBetween(this.snapshotState.modelAttempt.startedAt, firstTokenAt)
          : undefined);
      const modelAttempt: RuntimeModelAttemptSnapshot = {
        ...this.snapshotState.modelAttempt,
        status: "completed" as const,
        provider: stringValue(payload.provider) ?? this.snapshotState.modelAttempt?.provider,
        model: stringValue(payload.model) ?? this.snapshotState.modelAttempt?.model,
        completedAt: stringValue(payload.completedAt) ?? observedAt,
        ...(firstTokenAt ? { firstTokenAt } : {}),
        ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(latencyMs && outputTokens !== undefined ? { throughputTokensPerSecond: (outputTokens / latencyMs) * 1_000 } : {}),
      };
      const isNewCompletedAttempt = operationKey === undefined || !this.completedOperationKeys.has(operationKey);
      if (operationKey !== undefined) this.completedOperationKeys.add(operationKey);
      if (isNewCompletedAttempt && latencyMs !== undefined && outputTokens !== undefined) {
        this.samples.push({ latencyMs, outputTokens });
        while (this.samples.length > 10) this.samples.shift();
      }
      const canAnchorAfterCompaction = (providerReported && providerInputTokens !== undefined) || reportedBasis === "anchored_estimate";
      if (canAnchorAfterCompaction) this.awaitingPostCompactionAnchor = false;
      const basis = this.awaitingPostCompactionAnchor && !canAnchorAfterCompaction
        ? "unknown_after_compaction"
        : providerReported
        ? "provider_reported"
        : reportedBasis === "full_estimate" || reportedBasis === "anchored_estimate"
          ? reportedBasis
          : this.snapshotState.context.basis;
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        context: {
          ...this.snapshotState.context,
          ...(canAnchorAfterCompaction && providerInputTokens !== undefined ? { tokens: providerInputTokens } : {}),
          basis: basis as RuntimeTelemetrySnapshot["context"]["basis"],
          utilizationPercent: basis === "unknown_after_compaction" ? undefined : utilization(
            canAnchorAfterCompaction ? providerInputTokens : this.snapshotState.context.tokens,
            this.snapshotState.context.contextWindowTokens,
          ),
          ...(stringValue(usageAnchor?.operationKey) ? { usageAnchorOperationKey: stringValue(usageAnchor?.operationKey) } : {}),
        },
        modelAttempt,
        attempts: upsertAttempt(this.snapshotState.attempts, modelAttempt),
        rolling: rollingStats(this.samples),
      };
    } else if (input.type === "model.first_token") {
      const firstTokenAt = stringValue(payload.firstTokenAt) ?? observedAt;
      const timeToFirstTokenMs = nonNegativeNumber(payload.timeToFirstTokenMs)
        ?? (this.snapshotState.modelAttempt?.startedAt
          ? elapsedBetween(this.snapshotState.modelAttempt.startedAt, firstTokenAt)
          : undefined);
      const modelAttempt: RuntimeModelAttemptSnapshot = {
        ...this.snapshotState.modelAttempt,
        status: "streaming",
        firstTokenAt,
        ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
      };
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        modelAttempt,
        attempts: upsertAttempt(this.snapshotState.attempts, modelAttempt),
      };
    } else if (input.type === "model.failed") {
      const modelAttempt: RuntimeModelAttemptSnapshot = {
        ...this.snapshotState.modelAttempt,
        status: "failed",
        provider: stringValue(payload.provider) ?? this.snapshotState.modelAttempt?.provider,
        model: stringValue(payload.model) ?? this.snapshotState.modelAttempt?.model,
        errorCode: stringValue(payload.code),
        completedAt: stringValue(payload.failedAt) ?? observedAt,
        ...(nonNegativeNumber(payload.latencyMs) === undefined ? {} : { latencyMs: nonNegativeNumber(payload.latencyMs) }),
      };
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        modelAttempt,
        attempts: upsertAttempt(this.snapshotState.attempts, modelAttempt),
      };
    } else if (input.type === "loop.paused") {
      this.waitStartedAt = observedAt;
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        turn: { ...this.snapshotState.turn, status: "waiting", finishedAt: undefined },
      };
    } else if (input.type === "loop.completed" || input.type === "loop.failed" || input.type === "loop.limited") {
      const status = input.type === "loop.completed" ? "completed" : input.type === "loop.failed" ? "failed" : "limited";
      const startedAt = this.snapshotState.turn.startedAt;
      const waitMs = this.waitStartedAt
        ? (this.snapshotState.turn.waitMs ?? 0) + Math.max(0, Date.parse(observedAt) - Date.parse(this.waitStartedAt))
        : this.snapshotState.turn.waitMs;
      this.waitStartedAt = undefined;
      this.snapshotState = {
        ...this.snapshotState,
        observedAt,
        turn: {
          status,
          admittedAt: this.snapshotState.turn.admittedAt,
          startedAt,
          finishedAt: observedAt,
          elapsedMs: startedAt ? Math.max(0, Date.parse(observedAt) - Date.parse(startedAt)) : undefined,
          ...(waitMs === undefined ? {} : { waitMs }),
        },
      };
    }
    return this.snapshot();
  }

  public snapshot(now = new Date().toISOString()): RuntimeTelemetrySnapshot {
    const startedAt = this.snapshotState.turn.startedAt;
    const liveElapsed = this.snapshotState.turn.status === "running" && startedAt
      ? Math.max(0, Date.parse(now) - Date.parse(startedAt))
      : this.snapshotState.turn.elapsedMs;
    return {
      ...this.snapshotState,
      observedAt: now,
      turn: { ...this.snapshotState.turn, ...(liveElapsed !== undefined ? { elapsedMs: liveElapsed } : {}) },
    };
  }
}

function upsertAttempt(
  attempts: readonly RuntimeModelAttemptSnapshot[],
  next: RuntimeModelAttemptSnapshot,
): readonly RuntimeModelAttemptSnapshot[] {
  const operationKey = next.operationKey;
  const index = operationKey
    ? attempts.findIndex((attempt) => attempt.operationKey === operationKey)
    : attempts.length - 1;
  if (index < 0) return [...attempts, next];
  return attempts.map((attempt, attemptIndex) => attemptIndex === index ? next : attempt);
}

function rollingStats(samples: readonly ModelSample[]): RuntimeTelemetrySnapshot["rolling"] {
  if (!samples.length) return { sampleCount: 0 };
  const duration = samples.reduce((total, sample) => total + sample.latencyMs, 0);
  const outputTokens = samples.reduce((total, sample) => total + sample.outputTokens, 0);
  return {
    sampleCount: samples.length,
    latencyMs: duration / samples.length,
    outputTokensPerSecond: duration > 0 ? (outputTokens / duration) * 1_000 : undefined,
  };
}

function utilization(tokens: number | undefined, window: number | undefined): number | undefined {
  if (tokens === undefined || window === undefined || window <= 0) return undefined;
  return Math.max(0, Math.min(100, Number(((tokens / window) * 100).toFixed(1))));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function elapsedBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function contextDecision(value: unknown): ContextPlanDecision | undefined {
  return value === "ready" || value === "compact" || value === "prune" || value === "limited" || value === "cannot_fit" ? value : undefined;
}

function contextPressure(value: unknown): ContextPressure | undefined {
  return value === "normal" || value === "soft" || value === "hard" ? value : undefined;
}

function isCompactionEventType(value: string): value is ContextCompactionRuntimeEventType {
  return value === "compaction_attempted"
    || value === "compaction_candidate_created"
    || value === "compaction_committed"
    || value === "compaction_replayed"
    || value === "compaction_deferred"
    || value === "compaction_ineffective"
    || value === "compaction_cancelled"
    || value === "compaction_timed_out"
    || value === "compaction_failed"
    || value === "compaction_terminal";
}

function isManifest(value: unknown): value is ContextRequestManifest {
  const record = recordValue(value);
  return record?.schemaVersion === "v1" && typeof record.digest === "string" && Array.isArray(record.components);
}
