import { randomUUID } from "node:crypto";

/**
 * The stable identity carried by every execution-journal event.
 *
 * This deliberately contains only correlation data. Model prompts, tool
 * arguments, outputs, and credentials belong in their own durable records and
 * may be referenced here by identifier when needed.
 */
export interface ExecutionJournalScope {
  /** Tenant boundary; required for every durable journal read and write. */
  readonly organizationId: string;
  /** Installation boundary; a run cannot be used to cross an installation. */
  readonly installationId: string;
  readonly runId: string;
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out";
export type WaitReason = "approval" | "external_event" | "rate_limit" | "scheduled" | "operator";
export type DeliveryObligationStatus = "queued" | "claimed" | "sent" | "failed" | "unknown" | "cancelled";

export interface RunTransitionEvent {
  readonly kind: "run.transition";
  readonly data: {
    readonly from?: RunStatus;
    readonly to: RunStatus;
    readonly reason?: string;
  };
}

export interface ContextEvent {
  readonly kind: "context.assembled";
  readonly data: {
    readonly contextId?: string;
    readonly messageCount: number;
    readonly tokenCount?: number;
    readonly knowledgeMatchCount?: number;
    readonly compacted: boolean;
  };
}

export interface ModelEvent {
  readonly kind: "model.completed";
  readonly data: {
    readonly modelCallId: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly finishReason?: string;
  };
}

export interface ToolEvent {
  readonly kind: "tool.invoked";
  readonly data: {
    readonly toolCallId: string;
    readonly capability: string;
    readonly outcome: "completed" | "failed" | "awaiting_approval" | "replayed";
    readonly effectId?: string;
    readonly errorCode?: string;
  };
}

export interface WaitingEvent {
  readonly kind: "operation.waiting";
  readonly data: {
    readonly reason: WaitReason;
    readonly resumeKey?: string;
    readonly expiresAt?: string;
  };
}

export interface EffectUncertainEvent {
  readonly kind: "effect.uncertain";
  readonly data: {
    readonly effectId: string;
    readonly capability: string;
    readonly reason: string;
    readonly reconciliationRequired: boolean;
  };
}

export interface DeliveryObligationEvent {
  readonly kind: "delivery.obligation";
  readonly data: {
    readonly deliveryId: string;
    readonly status: DeliveryObligationStatus;
    readonly channel: string;
    readonly reason?: string;
  };
}

/** A lossless, bounded record of one harness loop lifecycle transition. */
export interface HarnessTurnEvent {
  readonly kind: "harness.turn";
  readonly data: {
    readonly type: "loop.started" | "model.completed" | "tool.proposed" | "tool.completed" | "loop.paused" | "loop.completed" | "loop.failed" | "loop.limited";
    readonly iteration: number;
    readonly payload: Record<string, unknown>;
  };
}

/** Compatibility envelope for operational facts still emitted by legacy callers. */
export interface RuntimeFactEvent {
  readonly kind: "runtime.fact";
  readonly data: {
    readonly type: string;
    readonly payload: Record<string, unknown>;
  };
}

export type ExecutionJournalEvent =
  | RunTransitionEvent
  | ContextEvent
  | ModelEvent
  | ToolEvent
  | WaitingEvent
  | EffectUncertainEvent
  | DeliveryObligationEvent
  | HarnessTurnEvent
  | RuntimeFactEvent;

export interface ExecutionJournalEventInput {
  readonly scope: ExecutionJournalScope;
  readonly event: ExecutionJournalEvent;
  readonly occurredAt?: string;
}

export interface PersistedExecutionJournalEvent extends ExecutionJournalEventInput {
  readonly id: string;
  /** Monotonic within one journal adapter instance. */
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface ExecutionJournalRead {
  readonly organizationId: string;
  readonly runId: string;
  /** Return events strictly after this sequence. */
  readonly afterSequence?: number;
  readonly limit?: number;
}

export type ExecutionJournalListener = (event: PersistedExecutionJournalEvent) => void | Promise<void>;

/**
 * The execution-journal seam.
 *
 * `read` is ordered by sequence. `subscribe` receives future matching events
 * only; callers that need a lossless projection must read to a cursor first,
 * then subscribe and de-duplicate by sequence.
 */
export interface ExecutionJournal {
  append(input: ExecutionJournalEventInput): Promise<PersistedExecutionJournalEvent>;
  read(query: ExecutionJournalRead): Promise<ReadonlyArray<PersistedExecutionJournalEvent>>;
  subscribe(query: ExecutionJournalRead, listener: ExecutionJournalListener): () => void;
}

export function createExecutionJournalEvent(input: ExecutionJournalEventInput, sequence: number): PersistedExecutionJournalEvent {
  return {
    ...input,
    id: randomUUID(),
    sequence,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}
