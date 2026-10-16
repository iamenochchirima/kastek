/**
 * The context runtime's one bounded admission budget.
 *
 * This contract counts context work before it is performed. A reservation is
 * therefore charged even when its worker later disappears. A replacement
 * worker must reuse the same operation key and replay that reservation rather
 * than opening another slot.
 *
 * The port deliberately has no provider, model, memory, or persistence
 * knowledge. A durable adapter can implement it with the runtime's existing
 * durable store. The in-memory implementation below is deterministic and is
 * intended for contract tests.
 */

export const CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION = "v1" as const;

export type ContextAttemptKind =
  | "proactive_compaction"
  | "overflow_recovery"
  | "provider_retry"
  | "worker_replacement";

export type ContextAttemptReceiptState = "reserved" | "consumed";

export interface ContextAttemptBudgetRequest {
  /** Stable identity for the single budget shared by all context recovery work. */
  readonly budgetId: string;
  readonly runId: string;
  readonly turnId: string;
  /** Stable idempotency key for one logical context attempt. */
  readonly operationKey: string;
  readonly kind: ContextAttemptKind;
}

export interface ContextAttemptBudgetReceipt {
  readonly schemaVersion: typeof CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION;
  readonly budgetId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly operationKey: string;
  /** The first reservation number assigned to this operation. */
  readonly attemptNumber: number;
  readonly kind: ContextAttemptKind;
  readonly state: ContextAttemptReceiptState;
}

export type ContextAttemptBudgetReserveResult =
  | { readonly status: "reserved"; readonly receipt: ContextAttemptBudgetReceipt }
  | { readonly status: "replayed"; readonly receipt: ContextAttemptBudgetReceipt }
  | { readonly status: "exhausted"; readonly outcome: ContextAttemptBudgetExhaustedError };

export type ContextAttemptBudgetConsumeResult =
  | { readonly status: "consumed"; readonly receipt: ContextAttemptBudgetReceipt }
  | { readonly status: "replayed"; readonly receipt: ContextAttemptBudgetReceipt };

export type ContextAttemptBudgetReplayResult =
  | { readonly status: "replayed"; readonly receipt: ContextAttemptBudgetReceipt }
  | { readonly status: "not_found" };

export interface ContextAttemptBudgetPort {
  /** Admit one unique operation, or return its prior receipt. */
  reserve(request: ContextAttemptBudgetRequest): Promise<ContextAttemptBudgetReserveResult>;
  /** Mark an admitted operation complete. Repeating this call is idempotent. */
  consume(receipt: ContextAttemptBudgetReceipt): Promise<ContextAttemptBudgetConsumeResult>;
  /** Recover an operation receipt after a worker replacement or replay. */
  replay(input: { readonly budgetId: string; readonly operationKey: string }): Promise<ContextAttemptBudgetReplayResult>;
}

export interface ContextAttemptBudgetSnapshot {
  readonly budgetId: string | undefined;
  readonly maxAttempts: number;
  readonly reservedAttempts: number;
  readonly consumedAttempts: number;
  readonly remainingAttempts: number;
}

export type ContextAttemptBudgetErrorCode =
  | "CONTEXT_ATTEMPT_BUDGET_INVALID_LIMIT"
  | "CONTEXT_ATTEMPT_REQUEST_INVALID"
  | "CONTEXT_ATTEMPT_BUDGET_ID_CONFLICT"
  | "CONTEXT_ATTEMPT_OPERATION_CONFLICT"
  | "CONTEXT_ATTEMPT_RESERVATION_NOT_FOUND"
  | "CONTEXT_ATTEMPT_RECEIPT_MISMATCH";

export class ContextAttemptBudgetError extends Error {
  public readonly name = "ContextAttemptBudgetError";

  public constructor(
    public readonly code: ContextAttemptBudgetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class ContextAttemptBudgetExhaustedError extends Error {
  public readonly name = "ContextAttemptBudgetExhaustedError";
  public readonly code = "CONTEXT_ATTEMPT_BUDGET_EXHAUSTED" as const;
  public readonly retryable = false as const;

  public constructor(
    public readonly budgetId: string,
    public readonly runId: string,
    public readonly turnId: string,
    public readonly maxAttempts: number,
    public readonly attemptedAttempts: number,
    public readonly operationKey: string,
    public readonly kind: ContextAttemptKind,
  ) {
    super(`Context attempt budget exhausted for ${budgetId}`);
  }
}

interface StoredAttempt {
  readonly request: ContextAttemptBudgetRequest;
  readonly attemptNumber: number;
  state: ContextAttemptReceiptState;
}

export interface InMemoryContextAttemptBudgetOptions {
  readonly maxAttempts: number;
  /** If supplied, every request must belong to this budget. */
  readonly budgetId?: string;
}

/**
 * Deterministic reference adapter for runtime contract tests.
 *
 * Reservations are intentionally not released. Releasing would let a timed
 * out worker and its replacement both obtain new slots for the same logical
 * work. Callers retry by reusing the original operation key.
 */
export class InMemoryContextAttemptBudget implements ContextAttemptBudgetPort {
  private readonly maxAttempts: number;
  private readonly configuredBudgetId: string | undefined;
  private activeBudgetId: string | undefined;
  private readonly attempts = new Map<string, StoredAttempt>();

  public constructor(options: InMemoryContextAttemptBudgetOptions) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new ContextAttemptBudgetError(
        "CONTEXT_ATTEMPT_BUDGET_INVALID_LIMIT",
        "Context attempt budget maxAttempts must be a positive safe integer",
      );
    }
    this.maxAttempts = options.maxAttempts;
    this.configuredBudgetId = options.budgetId;
    this.activeBudgetId = options.budgetId;
  }

  public async reserve(request: ContextAttemptBudgetRequest): Promise<ContextAttemptBudgetReserveResult> {
    this.validateRequest(request);
    const key = this.operationMapKey(request.budgetId, request.operationKey);
    const existing = this.attempts.get(key);
    if (existing) {
      this.assertSameOperation(existing.request, request);
      return { status: "replayed", receipt: this.receipt(existing) };
    }

    const attemptedAttempts = this.attempts.size;
    if (attemptedAttempts >= this.maxAttempts) {
      return {
        status: "exhausted",
        outcome: new ContextAttemptBudgetExhaustedError(
          request.budgetId,
          request.runId,
          request.turnId,
          this.maxAttempts,
          attemptedAttempts,
          request.operationKey,
          request.kind,
        ),
      };
    }

    const stored: StoredAttempt = {
      request: { ...request },
      attemptNumber: attemptedAttempts + 1,
      state: "reserved",
    };
    this.attempts.set(key, stored);
    return { status: "reserved", receipt: this.receipt(stored) };
  }

  public async consume(receipt: ContextAttemptBudgetReceipt): Promise<ContextAttemptBudgetConsumeResult> {
    this.validateReceipt(receipt);
    const existing = this.attempts.get(this.operationMapKey(receipt.budgetId, receipt.operationKey));
    if (!existing) {
      throw new ContextAttemptBudgetError(
        "CONTEXT_ATTEMPT_RESERVATION_NOT_FOUND",
        `No context attempt reservation exists for ${receipt.operationKey}`,
      );
    }
    this.assertReceiptMatches(existing, receipt);
    if (existing.state === "consumed") return { status: "replayed", receipt: this.receipt(existing) };
    existing.state = "consumed";
    return { status: "consumed", receipt: this.receipt(existing) };
  }

  public async replay(input: { readonly budgetId: string; readonly operationKey: string }): Promise<ContextAttemptBudgetReplayResult> {
    if (!input.budgetId.trim() || !input.operationKey.trim()) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_REQUEST_INVALID", "budgetId and operationKey are required for replay");
    }
    const existing = this.attempts.get(this.operationMapKey(input.budgetId, input.operationKey));
    return existing ? { status: "replayed", receipt: this.receipt(existing) } : { status: "not_found" };
  }

  public snapshot(): ContextAttemptBudgetSnapshot {
    const consumedAttempts = [...this.attempts.values()].filter((attempt) => attempt.state === "consumed").length;
    return {
      budgetId: this.activeBudgetId,
      maxAttempts: this.maxAttempts,
      reservedAttempts: this.attempts.size,
      consumedAttempts,
      remainingAttempts: Math.max(0, this.maxAttempts - this.attempts.size),
    };
  }

  private validateRequest(request: ContextAttemptBudgetRequest): void {
    if (!request.budgetId.trim() || !request.runId.trim() || !request.turnId.trim() || !request.operationKey.trim()) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_REQUEST_INVALID", "budgetId, runId, turnId, and operationKey are required");
    }
    if (this.configuredBudgetId && request.budgetId !== this.configuredBudgetId) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_BUDGET_ID_CONFLICT", "Request belongs to a different context attempt budget");
    }
    if (!this.activeBudgetId) this.activeBudgetId = request.budgetId;
    if (this.activeBudgetId !== request.budgetId) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_BUDGET_ID_CONFLICT", "One budget port cannot mix budget identities");
    }
  }

  private validateReceipt(receipt: ContextAttemptBudgetReceipt): void {
    if (receipt.schemaVersion !== CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION || !receipt.budgetId.trim() || !receipt.operationKey.trim()) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Invalid context attempt budget receipt");
    }
  }

  private assertSameOperation(existing: ContextAttemptBudgetRequest, incoming: ContextAttemptBudgetRequest): void {
    if (existing.budgetId !== incoming.budgetId || existing.runId !== incoming.runId || existing.turnId !== incoming.turnId) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_OPERATION_CONFLICT", "Operation key was reused for a different context identity");
    }
  }

  private assertReceiptMatches(existing: StoredAttempt, receipt: ContextAttemptBudgetReceipt): void {
    if (existing.request.runId !== receipt.runId || existing.request.turnId !== receipt.turnId || existing.attemptNumber !== receipt.attemptNumber) {
      throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Receipt does not match the reserved context attempt");
    }
  }

  private operationMapKey(budgetId: string, operationKey: string): string {
    return `${budgetId}\u0000${operationKey}`;
  }

  private receipt(attempt: StoredAttempt): ContextAttemptBudgetReceipt {
    return {
      schemaVersion: CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION,
      ...attempt.request,
      attemptNumber: attempt.attemptNumber,
      state: attempt.state,
    };
  }
}
