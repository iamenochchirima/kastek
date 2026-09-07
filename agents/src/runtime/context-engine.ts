import {
  accountProviderUsage,
  planProviderRequest,
  type ContextAccountingStatus,
  type ContextPlan,
  type ContextPlanInput,
  type ContextPlanRejection,
  type ContextPlanStatus,
  type ContextUsageAccounting,
  type ProviderReportedUsage,
} from "./context-planning";
import {
  compactDurableContext,
  type ContextCompactionDiagnostics,
  type ContextCompactionPolicy,
  type ContextCompactionResult,
  type ContextSummaryProvider,
  type DurableContextAdapter,
} from "./context-compaction";

/**
 * The lifecycle owned by ContextEngine. The engine plans one provider request
 * at a time; it does not run the model, persist state, or retry a turn.
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
  /** The caller-owned stable identity for this in-memory lifecycle. */
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
  readonly planRejectionCode: ContextPlanRejection | undefined;
  readonly planReasons: readonly string[];
  readonly omittedMessageCount: number;
  readonly omittedToolCount: number;
  readonly truncatedToolResultCount: number;
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
  /** Optional advisory summarizer; deterministic fallback remains authoritative. */
  readonly summaryProvider?: ContextSummaryProvider;
  readonly compactionPolicy?: ContextCompactionPolicy;
}

export type ContextEngineErrorCode =
  | "invalid_turn_id"
  | "turn_already_started"
  | "turn_not_found"
  | "invalid_lifecycle_transition"
  | "provider_usage_already_accounted"
  | "provider_usage_not_allowed";

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
 * Turn state remains in memory; durable context decisions are delegated to the
 * supplied adapter rather than being hidden inside this engine.
 */
export class ContextEngine {
  private readonly activeTurns = new Map<string, ActiveContextTurn>();
  private readonly journal?: (event: ContextEngineJournalEvent) => void;
  private readonly durableContext?: DurableContextAdapter;
  private readonly summaryProvider?: ContextSummaryProvider;
  private readonly compactionPolicy?: ContextCompactionPolicy;
  private nextEventSequence = 1;

  public constructor(options: ContextEngineOptions = {}) {
    this.journal = options.journal;
    this.durableContext = options.durableContext;
    this.summaryProvider = options.summaryProvider;
    this.compactionPolicy = options.compactionPolicy;
  }

  public async compactContext(handle: ContextTurnHandle, input: ContextCompactionRequest = {}): Promise<ContextCompactionResult> {
    const state = this.requireTurn(handle);
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
    });
    state.compaction = result;
    state.compactedRequest = snapshotPlanInput({ ...state.request, messages: result.messages });
    state.diagnostics = this.createDiagnostics({
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
    });
    const event: ContextCompactionEvent = Object.freeze({
      lifecycle: "context_compaction",
      handle: state.handle,
      compaction: result.diagnostics,
      diagnostics: state.diagnostics,
    });
    this.emit(event);
    return result;
  }

  public startTurn(input: ContextTurnStartInput): ContextTurnStarted {
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
    this.activeTurns.set(turnId, state);

    const result: ContextTurnStarted = Object.freeze({ lifecycle: "turn_start", handle, diagnostics });
    this.emit(result);
    return result;
  }

  public requestPlan(handle: ContextTurnHandle): ContextRequestPlan {
    const state = this.requireTurn(handle);
    if (state.planResult) return state.planResult;
    if (state.outcome) {
      throw new ContextEngineError("A completed turn cannot be planned again.", "invalid_lifecycle_transition", handle.turnId);
    }

    const plan = planProviderRequest(state.compactedRequest ?? state.request);
    state.plan = plan;
    state.diagnostics = this.createDiagnostics({
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
    const result: ContextRequestPlan = Object.freeze({ lifecycle: "request_plan", handle: state.handle, plan, diagnostics: state.diagnostics });
    state.planResult = result;
    this.emit(result);
    return result;
  }

  public accountProviderUsage(handle: ContextTurnHandle, usage: ProviderReportedUsage): ContextProviderUsageAccounting {
    const state = this.requireTurn(handle);
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
    if (state.outcome) {
      throw new ContextEngineError("A completed turn cannot receive provider usage.", "invalid_lifecycle_transition", handle.turnId);
    }

    state.providerUsage = { ...usage };
    state.accounting = accountProviderUsage(state.plan, usage);
    state.diagnostics = this.createDiagnostics({
      turnId: state.handle.turnId,
      provider: state.request.profile.provider,
      model: state.request.profile.model,
      phase: "usage_accounted",
      revision: state.compaction ? 3 : 2,
      plan: state.plan,
      accounting: state.accounting,
      compaction: state.compaction,
      outcome: undefined,
      completionErrorCode: undefined,
    });
    const result: ContextProviderUsageAccounting = Object.freeze({
      lifecycle: "provider_usage_accounting",
      handle: state.handle,
      accounting: state.accounting,
      diagnostics: state.diagnostics,
    });
    state.usageResult = result;
    this.emit(result);
    return result;
  }

  public completeTurn(handle: ContextTurnHandle, input: ContextTurnCompletionInput): ContextTurnCompleted {
    const state = this.requireTurn(handle);
    if (!state.plan) {
      throw new ContextEngineError("A turn must have a request plan before it can complete.", "invalid_lifecycle_transition", handle.turnId);
    }
    if (state.outcome) {
      throw new ContextEngineError("A turn can only complete once.", "invalid_lifecycle_transition", handle.turnId);
    }
    if (input.errorCode !== undefined && !input.errorCode.trim()) {
      throw new ContextEngineError("A completion error code cannot be empty.", "invalid_lifecycle_transition", handle.turnId);
    }

    state.outcome = input.outcome;
    state.completionErrorCode = input.errorCode?.trim();
    state.diagnostics = this.createDiagnostics({
      turnId: state.handle.turnId,
      provider: state.request.profile.provider,
      model: state.request.profile.model,
      phase: "completed",
      revision: state.compaction ? (state.accounting ? 4 : 3) : (state.accounting ? 3 : 2),
      plan: state.plan,
      accounting: state.accounting,
      compaction: state.compaction,
      outcome: state.outcome,
      completionErrorCode: state.completionErrorCode,
    });
    const result: ContextTurnCompleted = Object.freeze({
      lifecycle: "turn_complete",
      handle: state.handle,
      plan: state.plan,
      accounting: state.accounting,
      diagnostics: state.diagnostics,
    });
    this.emit(result);
    // Completion releases the in-memory lifecycle state. The caller owns any
    // durable record or later replay of the returned result.
    this.activeTurns.delete(handle.turnId);
    return result;
  }

  public diagnostics(handle: ContextTurnHandle): ContextTurnDiagnostics {
    return this.requireTurn(handle).diagnostics;
  }

  private requireTurn(handle: ContextTurnHandle): ActiveContextTurn {
    const turnId = handle?.turnId;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw new ContextEngineError("A valid context turn handle is required.", "turn_not_found", turnId);
    }
    const state = this.activeTurns.get(turnId);
    if (!state) throw new ContextEngineError(`Turn ${turnId} is not active.`, "turn_not_found", turnId);
    return state;
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
      planRejectionCode: input.plan?.status === "rejected" ? input.plan.rejection.code : undefined,
      planReasons: Object.freeze([...(planDiagnostics?.reasons ?? [])]),
      omittedMessageCount: planDiagnostics?.omittedMessageCount ?? 0,
      omittedToolCount: planDiagnostics?.omittedToolCount ?? 0,
      truncatedToolResultCount: planDiagnostics?.truncatedToolResultCount ?? 0,
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
