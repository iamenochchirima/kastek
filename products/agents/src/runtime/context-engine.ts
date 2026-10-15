import {
  accountProviderUsage,
  planProviderRequest,
  type ContextAccountingStatus,
  type ContextPlan,
  type ContextPlanDecision,
  type ContextPlanInput,
  type ContextPlanRejection,
  type ContextPlanStatus,
  type ContextMeasurementBasis,
  type ContextUsageAccounting,
  type ProviderReportedUsage,
} from "./context-planning";
import {
  compactDurableContext,
  type ContextCompactionDiagnostics,
  type ContextCompactionPolicy,
  type ContextCompactionResult,
  type ContextCompactionRuntimeEvent,
  type ContextSummaryProvider,
  type DurableContextAdapter,
} from "./context-compaction";
import {
  InMemoryContextEngineStateAdapter,
  type ContextEngineStateAdapter,
} from "./context-engine-state";
import type {
  MemoryCheckpointPort,
  MemoryDirectEvidenceEnvelope,
  MemoryRuntimeEventPayload,
  MemoryRuntimeScope,
  MemorySourceEventBoundary,
} from "./context-memory-boundary";

/**
 * The lifecycle owned by ContextEngine. The engine plans one provider request
 * at a time; it does not run the model or retry a turn. Lifecycle snapshots
 * are persisted through the state adapter.
 */
export type ContextEngineLifecycle =
  | "turn_start"
  | "context_compaction"
  | "request_plan"
  | "provider_usage_accounting"
  | "turn_complete";

export type ContextTurnPhase = "started" | "compacted" | "planned" | "usage_accounted" | "completed";

export type ContextTurnOutcome = "completed" | "rejected" | "failed" | "aborted";

export interface ContextTurnStartInput {
  /** The caller-owned stable identity for this durable lifecycle. */
  readonly turnId: string;
  readonly request: ContextPlanInput;
}

export interface ContextCompactionRequest {
  /** Defaults to a turn-scoped operation id when omitted. */
  readonly operationId?: string;
  /** Defaults to the turn id when omitted. */
  readonly contextId?: string;
  readonly revision?: number;
  readonly policy?: ContextCompactionPolicy;
  readonly memoryScope?: MemoryRuntimeScope;
  /** Optional source boundary supplied by the durable journal owner. */
  readonly sourceEventBoundary?: MemorySourceEventBoundary;
  /** Optional digest of the redacted evidence envelope being checkpointed. */
  readonly evidenceDigest?: string;
  /** Redacted evidence only. Raw prompt/tool content never crosses this seam. */
  readonly directEvidence?: MemoryDirectEvidenceEnvelope;
}

export interface ContextTurnHandle {
  readonly turnId: string;
}

/**
 * A fixed-shape, content-free diagnostic snapshot. It is safe to send to a
 * journal or an execution visualizer without copying prompts, tool schemas, or
 * provider output into that surface.
 */
export interface ContextTurnDiagnostics {
  readonly turnId: string;
  readonly provider: string;
  readonly model: string;
  readonly phase: ContextTurnPhase;
  readonly revision: number;
  /** Monotonic only within this ContextEngine instance; it is not durable. */
  readonly eventSequence: number;
  readonly planStatus: ContextPlanStatus | "not_planned";
  readonly planDecision: ContextPlanDecision | "not_planned";
  readonly measurementBasis: ContextMeasurementBasis | "not_measured";
  readonly capabilitySource: string;
  readonly contextWindowTokens: number | undefined;
  readonly planRejectionCode: ContextPlanRejection | undefined;
  readonly planReasons: readonly string[];
  readonly omittedMessageCount: number;
  readonly omittedToolCount: number;
  readonly truncatedToolResultCount: number;
  readonly toolResultReferenceCount: number;
  readonly protectedPairCount: number;
  readonly selectedMessageUnitCount: number;
  readonly estimatedInputTokens: number | undefined;
  readonly inputBudgetTokens: number | undefined;
  readonly outputReservationTokens: number | undefined;
  readonly usageStatus: ContextAccountingStatus | "not_reported";
  readonly providerInputTokens: number | undefined;
  readonly providerOutputTokens: number | undefined;
  readonly providerTotalTokens: number | undefined;
  readonly inputOverrunTokens: number;
  readonly outputOverrunTokens: number;
  readonly totalOverrunTokens: number;
  readonly usageIssues: readonly string[];
  readonly compactionStatus: "not_requested" | "completed" | "replayed";
  readonly compactionSource: ContextCompactionDiagnostics["source"] | undefined;
  readonly compactionFailureCode: ContextCompactionDiagnostics["providerFailureCode"];
  readonly compactionOmittedMessageCount: number;
  readonly compactionProtectedPairCount: number;
  readonly compactionSummaryTokens: number;
  readonly outcome: ContextTurnOutcome | undefined;
  readonly completionErrorCode: string | undefined;
}

export interface ContextTurnStarted {
  readonly lifecycle: "turn_start";
  readonly handle: ContextTurnHandle;
  readonly diagnostics: ContextTurnDiagnostics;
}

export interface ContextRequestPlan {
  readonly lifecycle: "request_plan";
  readonly handle: ContextTurnHandle;
  readonly plan: ContextPlan;
  readonly diagnostics: ContextTurnDiagnostics;
}

export interface ContextCompactionEvent {
  readonly lifecycle: "context_compaction";
  readonly handle: ContextTurnHandle;
  readonly compaction: ContextCompactionDiagnostics;
  readonly diagnostics: ContextTurnDiagnostics;
}

export interface ContextProviderUsageAccounting {
  readonly lifecycle: "provider_usage_accounting";
  readonly handle: ContextTurnHandle;
  readonly accounting: ContextUsageAccounting;
  readonly diagnostics: ContextTurnDiagnostics;
}

export interface ContextTurnCompletionInput {
  readonly outcome: ContextTurnOutcome;
  /** A caller-defined stable code; raw provider errors do not belong here. */
  readonly errorCode?: string;
}

export interface ContextTurnCompleted {
  readonly lifecycle: "turn_complete";
  readonly handle: ContextTurnHandle;
  readonly plan: ContextPlan;
  readonly accounting: ContextUsageAccounting | undefined;
  readonly diagnostics: ContextTurnDiagnostics;
}

/**
 * Serializable lifecycle state. Diagnostics and event results are rebuilt by
 * the engine after a reload so event sequence numbers remain process-local.
 */
export interface ContextEngineState {
  readonly schemaVersion: "v1";
  readonly turnId: string;
  readonly request: ContextPlanInput;
  readonly compactedRequest?: ContextPlanInput;
  readonly compaction?: ContextCompactionResult;
  readonly plan?: ContextPlan;
  readonly accounting?: ContextUsageAccounting;
  readonly providerUsage?: ProviderReportedUsage;
  readonly outcome?: ContextTurnOutcome;
  readonly completionErrorCode?: string;
}

export type ContextEngineJournalEvent =
  | ContextTurnStarted
  | ContextCompactionEvent
  | ContextRequestPlan
  | ContextProviderUsageAccounting
  | ContextTurnCompleted;

export interface ContextEngineOptions {
  /**
   * Best-effort observer seam. The engine does not persist events and journal
   * callback failures do not change planning or lifecycle state.
   */
  readonly journal?: (event: ContextEngineJournalEvent) => void;
  /** Optional durable decision/revision store for compaction operations. */
  readonly durableContext?: DurableContextAdapter;
  /** Durable lifecycle state. The default is a fast in-memory adapter. */
  readonly state?: ContextEngineStateAdapter<ContextEngineState>;
  /** Optional advisory summarizer; deterministic fallback remains authoritative. */
  readonly summaryProvider?: ContextSummaryProvider;
  readonly compactionPolicy?: ContextCompactionPolicy;
  readonly memoryCheckpointPort?: MemoryCheckpointPort;
  readonly memoryCheckpointRequired?: boolean;
  readonly memoryScope?: MemoryRuntimeScope;
  readonly onMemoryEvent?: (event: MemoryRuntimeEventPayload) => void | Promise<void>;
  readonly onCompactionEvent?: (event: ContextCompactionRuntimeEvent) => void | Promise<void>;
}

export type ContextEngineErrorCode =
  | "invalid_turn_id"
  | "turn_already_started"
  | "turn_not_found"
  | "invalid_lifecycle_transition"
  | "provider_usage_already_accounted"
  | "provider_usage_not_allowed"
  | "state_persistence_failed";

export class ContextEngineError extends Error {
  public constructor(
    message: string,
    public readonly code: ContextEngineErrorCode,
    public readonly turnId?: string,
  ) {
    super(message);
    this.name = "ContextEngineError";
  }
}

interface ActiveContextTurn {
  readonly handle: ContextTurnHandle;
  readonly request: ContextPlanInput;
  compactedRequest?: ContextPlanInput;
  compaction?: ContextCompactionResult;
  plan?: ContextPlan;
  planResult?: ContextRequestPlan;
  accounting?: ContextUsageAccounting;
  usageResult?: ContextProviderUsageAccounting;
  providerUsage?: ProviderReportedUsage;
  outcome?: ContextTurnOutcome;
  completionErrorCode?: string;
  diagnostics: ContextTurnDiagnostics;
}

/**
 * Lifecycle wrapper around provider planning and optional durable compaction.
 * The active-turn map is a cache. Lifecycle snapshots are written through the
 * supplied state adapter so another worker can reload and continue a turn.
 */
export class ContextEngine {
  private readonly activeTurns = new Map<string, ActiveContextTurn>();
  private readonly journal?: (event: ContextEngineJournalEvent) => void;
  private readonly durableContext?: DurableContextAdapter;
  private readonly stateAdapter: ContextEngineStateAdapter<ContextEngineState>;
  private readonly summaryProvider?: ContextSummaryProvider;
  private readonly compactionPolicy?: ContextCompactionPolicy;
  private readonly memoryCheckpointPort?: MemoryCheckpointPort;
  private readonly memoryCheckpointRequired: boolean;
  private readonly memoryScope?: MemoryRuntimeScope;
  private readonly onMemoryEvent?: (event: MemoryRuntimeEventPayload) => void | Promise<void>;
  private readonly onCompactionEvent?: (event: ContextCompactionRuntimeEvent) => void | Promise<void>;
  private nextEventSequence = 1;

  public constructor(options: ContextEngineOptions = {}) {
    this.journal = options.journal;
    this.durableContext = options.durableContext;
    this.stateAdapter = options.state ?? new InMemoryContextEngineStateAdapter<ContextEngineState>();
    this.summaryProvider = options.summaryProvider;
    this.compactionPolicy = options.compactionPolicy;
    this.memoryCheckpointPort = options.memoryCheckpointPort;
    this.memoryCheckpointRequired = options.memoryCheckpointRequired === true;
    this.memoryScope = options.memoryScope;
    this.onMemoryEvent = options.onMemoryEvent;
    this.onCompactionEvent = options.onCompactionEvent;
  }

  public async compactContext(handle: ContextTurnHandle, input: ContextCompactionRequest = {}): Promise<ContextCompactionResult> {
    const state = await this.requireTurn(handle);
    if (state.compaction) return state.compaction;
    if (state.plan || state.outcome) {
      throw new ContextEngineError("Context compaction must happen before request planning or completion.", "invalid_lifecycle_transition", handle.turnId);
    }

    const result = await compactDurableContext({
      operationId: input.operationId ?? `${state.handle.turnId}:context-compaction`,
      contextId: input.contextId ?? state.handle.turnId,
      revision: input.revision ?? 1,
      messages: state.request.messages,
      policy: { ...this.compactionPolicy, ...input.policy },
      adapter: this.durableContext,
      summaryProvider: this.summaryProvider,
      memoryCheckpointPort: this.memoryCheckpointPort,
      memoryCheckpointRequired: this.memoryCheckpointRequired,
      memoryRunId: state.handle.turnId,
      memoryTurnId: state.handle.turnId,
      memoryScope: input.memoryScope ?? this.memoryScope,
      sourceEventBoundary: input.sourceEventBoundary,
      evidenceDigest: input.evidenceDigest,
      directEvidence: input.directEvidence,
      onMemoryEvent: this.onMemoryEvent,
      onCompactionEvent: this.onCompactionEvent,
    });
    const nextState: ActiveContextTurn = {
      ...state,
      compaction: result,
      compactedRequest: snapshotPlanInput({ ...state.request, messages: result.messages }),
      diagnostics: this.createDiagnostics({
        turnId: state.handle.turnId,
        provider: state.request.profile.provider,
        model: state.request.profile.model,
        phase: "compacted",
        revision: 1,
        plan: undefined,
        accounting: undefined,
        compaction: result,
        outcome: undefined,
        completionErrorCode: undefined,
      }),
    };
    await this.persistState(nextState);
    this.activeTurns.set(handle.turnId, nextState);
    const event: ContextCompactionEvent = Object.freeze({
      lifecycle: "context_compaction",
      handle: nextState.handle,
      compaction: result.diagnostics,
      diagnostics: nextState.diagnostics,
    });
    this.emit(event);
    return result;
  }

  public async startTurn(input: ContextTurnStartInput): Promise<ContextTurnStarted> {
    const turnId = input.turnId.trim();
    if (!turnId) throw new ContextEngineError("A non-empty turn id is required.", "invalid_turn_id");
    if (this.activeTurns.has(turnId)) {
      throw new ContextEngineError(`Turn ${turnId} is already active.`, "turn_already_started", turnId);
    }

    const handle: ContextTurnHandle = Object.freeze({ turnId });
    const diagnostics = this.createDiagnostics({
      turnId,
      provider: input.request.profile.provider,
      model: input.request.profile.model,
      phase: "started",
      revision: 0,
      plan: undefined,
      accounting: undefined,
      compaction: undefined,
      outcome: undefined,
      completionErrorCode: undefined,
    });
    const state: ActiveContextTurn = {
      handle,
      request: snapshotPlanInput(input.request),
      diagnostics,
    };
    let createStatus: "created" | "exists";
    try {
      createStatus = await this.stateAdapter.create(snapshotState(state));
    } catch {
      throw new ContextEngineError("Context turn state could not be persisted.", "state_persistence_failed", turnId);
    }
    if (createStatus === "exists") {
      throw new ContextEngineError(`Turn ${turnId} is already active.`, "turn_already_started", turnId);
    }
    this.activeTurns.set(turnId, state);

    const result: ContextTurnStarted = Object.freeze({ lifecycle: "turn_start", handle, diagnostics });
    this.emit(result);
    return result;
  }

  public async requestPlan(handle: ContextTurnHandle): Promise<ContextRequestPlan> {
    const state = await this.requireTurn(handle);
    if (state.planResult) return state.planResult;
    if (state.outcome) {
      throw new ContextEngineError("A completed turn cannot be planned again.", "invalid_lifecycle_transition", handle.turnId);
    }

    const wasAlreadyPlanned = Boolean(state.plan);
    const plan = state.plan ?? planProviderRequest(state.compactedRequest ?? state.request);
    const diagnostics = wasAlreadyPlanned
      ? state.diagnostics
      : this.createDiagnostics({
        turnId: state.handle.turnId,
        provider: state.request.profile.provider,
        model: state.request.profile.model,
        phase: "planned",
        revision: state.compaction ? 2 : 1,
        plan,
        accounting: undefined,
        compaction: state.compaction,
        outcome: undefined,
        completionErrorCode: undefined,
      });
    const nextState: ActiveContextTurn = { ...state, plan, diagnostics };
    if (!wasAlreadyPlanned) {
      await this.persistState(nextState);
    }
    const result: ContextRequestPlan = Object.freeze({ lifecycle: "request_plan", handle: nextState.handle, plan, diagnostics });
    nextState.planResult = result;
    this.activeTurns.set(handle.turnId, nextState);
    if (!wasAlreadyPlanned) this.emit(result);
    return result;
  }

  public async accountProviderUsage(handle: ContextTurnHandle, usage: ProviderReportedUsage): Promise<ContextProviderUsageAccounting> {
    const state = await this.requireTurn(handle);
    if (!state.plan) {
      throw new ContextEngineError("Provider usage can only be accounted after request planning.", "invalid_lifecycle_transition", handle.turnId);
    }
    if (state.plan.status === "rejected") {
      throw new ContextEngineError("A rejected request plan cannot receive provider usage.", "provider_usage_not_allowed", handle.turnId);
    }
    if (state.usageResult) {
      if (sameProviderUsage(state.providerUsage, usage)) {
        return state.usageResult;
      }
      throw new ContextEngineError("Provider usage was already accounted for this turn.", "provider_usage_already_accounted", handle.turnId);
    }
    if (state.providerUsage) {
      if (state.accounting && sameProviderUsage(state.providerUsage, usage)) {
        const result: ContextProviderUsageAccounting = Object.freeze({
          lifecycle: "provider_usage_accounting",
          handle: state.handle,
          accounting: state.accounting,
          diagnostics: state.diagnostics,
        });
        state.usageResult = result;
        this.activeTurns.set(handle.turnId, state);
        return result;
      }
      throw new ContextEngineError("Provider usage was already accounted for this turn.", "provider_usage_already_accounted", handle.turnId);
    }
    if (state.outcome) {
      throw new ContextEngineError("A completed turn cannot receive provider usage.", "invalid_lifecycle_transition", handle.turnId);
    }

    const providerUsage = { ...usage };
    const accounting = accountProviderUsage(state.plan, providerUsage);
    const diagnostics = this.createDiagnostics({
      turnId: state.handle.turnId,
      provider: state.request.profile.provider,
      model: state.request.profile.model,
      phase: "usage_accounted",
      revision: state.compaction ? 3 : 2,
      plan: state.plan,
      accounting,
      compaction: state.compaction,
      outcome: undefined,
      completionErrorCode: undefined,
    });
    const nextState: ActiveContextTurn = { ...state, providerUsage, accounting, diagnostics };
    const result: ContextProviderUsageAccounting = Object.freeze({
      lifecycle: "provider_usage_accounting",
      handle: nextState.handle,
      accounting,
      diagnostics,
    });
    await this.persistState(nextState);
    nextState.usageResult = result;
    this.activeTurns.set(handle.turnId, nextState);
    this.emit(result);
    return result;
  }

  public async completeTurn(handle: ContextTurnHandle, input: ContextTurnCompletionInput): Promise<ContextTurnCompleted> {
    const state = await this.requireTurn(handle);
    if (!state.plan) {
      throw new ContextEngineError("A turn must have a request plan before it can complete.", "invalid_lifecycle_transition", handle.turnId);
    }
    if (state.outcome) {
      throw new ContextEngineError("A turn can only complete once.", "invalid_lifecycle_transition", handle.turnId);
    }
    if (input.errorCode !== undefined && !input.errorCode.trim()) {
      throw new ContextEngineError("A completion error code cannot be empty.", "invalid_lifecycle_transition", handle.turnId);
    }

    const plan = state.plan;
    const completionErrorCode = input.errorCode?.trim();
    const diagnostics = this.createDiagnostics({
      turnId: state.handle.turnId,
      provider: state.request.profile.provider,
      model: state.request.profile.model,
      phase: "completed",
      revision: state.compaction ? (state.accounting ? 4 : 3) : (state.accounting ? 3 : 2),
      plan,
      accounting: state.accounting,
      compaction: state.compaction,
      outcome: input.outcome,
      completionErrorCode,
    });
    const completedState: ActiveContextTurn = {
      ...state,
      outcome: input.outcome,
      completionErrorCode,
      diagnostics,
    };
    await this.persistState(completedState);
    this.activeTurns.set(handle.turnId, completedState);
    const result: ContextTurnCompleted = Object.freeze({
      lifecycle: "turn_complete",
      handle: completedState.handle,
      plan,
      accounting: completedState.accounting,
      diagnostics: completedState.diagnostics,
    });
    this.emit(result);
    await this.removePersistedState(handle.turnId);
    // Completion releases the cache and durable active-lifecycle record. The
    // journal and surrounding run record own the terminal result.
    this.activeTurns.delete(handle.turnId);
    return result;
  }

  public async diagnostics(handle: ContextTurnHandle): Promise<ContextTurnDiagnostics> {
    return (await this.requireTurn(handle)).diagnostics;
  }

  private async requireTurn(handle: ContextTurnHandle): Promise<ActiveContextTurn> {
    const turnId = handle?.turnId;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw new ContextEngineError("A valid context turn handle is required.", "turn_not_found", turnId);
    }
    const state = this.activeTurns.get(turnId);
    if (state) return state;

    let persisted: ContextEngineState | undefined;
    try {
      persisted = await this.stateAdapter.load(turnId);
    } catch {
      throw new ContextEngineError("Context turn state could not be loaded.", "state_persistence_failed", turnId);
    }
    if (!persisted) throw new ContextEngineError(`Turn ${turnId} is not active.`, "turn_not_found", turnId);
    if (persisted.schemaVersion !== "v1" || persisted.turnId !== turnId) {
      throw new ContextEngineError("Context turn state is invalid.", "state_persistence_failed", turnId);
    }
    const reloaded = this.hydrateState(persisted);
    this.activeTurns.set(turnId, reloaded);
    return reloaded;
  }

  private async persistState(state: ActiveContextTurn): Promise<void> {
    try {
      await this.stateAdapter.save(snapshotState(state));
    } catch {
      throw new ContextEngineError("Context turn state could not be persisted.", "state_persistence_failed", state.handle.turnId);
    }
  }

  private async removePersistedState(turnId: string): Promise<void> {
    try {
      await this.stateAdapter.remove(turnId);
    } catch {
      throw new ContextEngineError("Completed context turn state could not be removed.", "state_persistence_failed", turnId);
    }
  }

  private hydrateState(snapshot: ContextEngineState): ActiveContextTurn {
    const handle: ContextTurnHandle = Object.freeze({ turnId: snapshot.turnId });
    const phase: ContextTurnPhase = snapshot.outcome
      ? "completed"
      : snapshot.accounting
        ? "usage_accounted"
        : snapshot.plan
          ? "planned"
          : snapshot.compaction
            ? "compacted"
            : "started";
    const diagnostics = this.createDiagnostics({
      turnId: snapshot.turnId,
      provider: snapshot.request.profile.provider,
      model: snapshot.request.profile.model,
      phase,
      revision: snapshot.outcome
        ? snapshot.compaction ? (snapshot.accounting ? 4 : 3) : (snapshot.accounting ? 3 : 2)
        : snapshot.accounting
          ? (snapshot.compaction ? 3 : 2)
          : snapshot.plan
            ? (snapshot.compaction ? 2 : 1)
            : snapshot.compaction ? 1 : 0,
      plan: snapshot.plan,
      accounting: snapshot.accounting,
      compaction: snapshot.compaction,
      outcome: snapshot.outcome,
      completionErrorCode: snapshot.completionErrorCode,
    });
    return {
      handle,
      request: snapshotPlanInput(snapshot.request),
      compactedRequest: snapshot.compactedRequest ? snapshotPlanInput(snapshot.compactedRequest) : undefined,
      compaction: snapshot.compaction,
      plan: snapshot.plan,
      accounting: snapshot.accounting,
      providerUsage: snapshot.providerUsage,
      outcome: snapshot.outcome,
      completionErrorCode: snapshot.completionErrorCode,
      diagnostics,
    };
  }

  private createDiagnostics(input: {
    readonly turnId: string;
    readonly provider: string;
    readonly model: string;
    readonly phase: ContextTurnPhase;
    readonly revision: number;
    readonly plan: ContextPlan | undefined;
    readonly accounting: ContextUsageAccounting | undefined;
    readonly compaction: ContextCompactionResult | undefined;
    readonly outcome: ContextTurnOutcome | undefined;
    readonly completionErrorCode: string | undefined;
    readonly providerCapabilitySource?: string;
  }): ContextTurnDiagnostics {
    const planDiagnostics = input.plan?.diagnostics;
    const accounting = input.accounting;
    return Object.freeze({
      turnId: input.turnId,
      provider: input.provider,
      model: input.model,
      phase: input.phase,
      revision: input.revision,
      eventSequence: this.nextEventSequence++,
      planStatus: input.plan?.status ?? "not_planned",
      planDecision: input.plan?.decision ?? "not_planned",
      measurementBasis: accounting?.basis ?? (input.plan ? "full_estimate" : "not_measured"),
      capabilitySource: input.plan?.accounting.capabilitySource ?? input.providerCapabilitySource ?? "unknown",
      contextWindowTokens: input.plan?.accounting.providerContextWindowTokens,
      planRejectionCode: input.plan?.status === "rejected" ? input.plan.rejection.code : undefined,
      planReasons: Object.freeze([...(planDiagnostics?.reasons ?? [])]),
      omittedMessageCount: planDiagnostics?.omittedMessageCount ?? 0,
      omittedToolCount: planDiagnostics?.omittedToolCount ?? 0,
      truncatedToolResultCount: planDiagnostics?.truncatedToolResultCount ?? 0,
      toolResultReferenceCount: planDiagnostics?.toolResultReferenceCount ?? 0,
      protectedPairCount: planDiagnostics?.protectedPairCount ?? 0,
      selectedMessageUnitCount: planDiagnostics?.selectedMessageUnitCount ?? 0,
      estimatedInputTokens: input.plan?.accounting.estimatedInputTokens,
      inputBudgetTokens: input.plan?.accounting.inputBudgetTokens,
      outputReservationTokens: input.plan?.accounting.categories.output_reservation,
      usageStatus: accounting?.status ?? "not_reported",
      providerInputTokens: accounting?.inputTokens,
      providerOutputTokens: accounting?.outputTokens,
      providerTotalTokens: accounting?.totalTokens,
      inputOverrunTokens: accounting?.inputOverrunTokens ?? 0,
      outputOverrunTokens: accounting?.outputOverrunTokens ?? 0,
      totalOverrunTokens: accounting?.totalOverrunTokens ?? 0,
      usageIssues: Object.freeze([...(accounting?.issues ?? [])]),
      compactionStatus: input.compaction ? (input.compaction.diagnostics.replayed ? "replayed" : "completed") : "not_requested",
      compactionSource: input.compaction?.diagnostics.source,
      compactionFailureCode: input.compaction?.diagnostics.providerFailureCode,
      compactionOmittedMessageCount: input.compaction?.diagnostics.omittedMessageCount ?? 0,
      compactionProtectedPairCount: input.compaction?.diagnostics.protectedPairCount ?? 0,
      compactionSummaryTokens: input.compaction?.diagnostics.summaryTokens ?? 0,
      outcome: input.outcome,
      completionErrorCode: input.completionErrorCode,
    });
  }

  private emit(event: ContextEngineJournalEvent): void {
    if (!this.journal) return;
    try {
      this.journal(event);
    } catch {
      // Journal observers are deliberately non-authoritative. A failing
      // observer must not turn a valid context plan into a model failure.
    }
  }
}

function sameProviderUsage(left: ProviderReportedUsage | undefined, right: ProviderReportedUsage): boolean {
  return left?.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.totalTokens === right.totalTokens;
}

function snapshotState(state: ActiveContextTurn): ContextEngineState {
  return {
    schemaVersion: "v1",
    turnId: state.handle.turnId,
    request: snapshotPlanInput(state.request),
    ...(state.compactedRequest ? { compactedRequest: snapshotPlanInput(state.compactedRequest) } : {}),
    ...(state.compaction ? { compaction: state.compaction } : {}),
    ...(state.plan ? { plan: state.plan } : {}),
    ...(state.accounting ? { accounting: state.accounting } : {}),
    ...(state.providerUsage ? { providerUsage: { ...state.providerUsage } } : {}),
    ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(state.completionErrorCode ? { completionErrorCode: state.completionErrorCode } : {}),
  };
}

function snapshotPlanInput(input: ContextPlanInput): ContextPlanInput {
  return {
    profile: { ...input.profile },
    policy: { ...input.policy },
    messages: input.messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, arguments: { ...call.arguments } })),
    })),
    tools: input.tools?.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
    currentMessageIndex: input.currentMessageIndex,
  };
}
