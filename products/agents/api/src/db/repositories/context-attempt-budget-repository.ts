import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import {
  CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION,
  ContextAttemptBudgetError,
  ContextAttemptBudgetExhaustedError,
  type ContextAttemptBudgetConsumeResult,
  type ContextAttemptBudgetPort,
  type ContextAttemptBudgetReceipt,
  type ContextAttemptBudgetReplayResult,
  type ContextAttemptBudgetRequest,
  type ContextAttemptBudgetReserveResult,
} from "../../runtime/context-attempt-budget";

type ContextAttemptKind = ContextAttemptBudgetRequest["kind"];

interface ContextAttemptBudgetRepositoryOptions {
  readonly maxAttempts: number;
}

interface BudgetRow {
  budget_id: string;
  run_id: string;
  max_attempts: number;
  reserved_attempts: number;
  consumed_attempts: number;
}

interface AttemptRow {
  budget_id: string;
  run_id: string;
  turn_id: string;
  operation_key: string;
  attempt_number: number;
  kind: ContextAttemptKind;
  state: "reserved" | "consumed";
}

const ATTEMPT_KINDS = new Set<ContextAttemptKind>([
  "proactive_compaction",
  "overflow_recovery",
  "provider_retry",
  "worker_replacement",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateText(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 240) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_REQUEST_INVALID", code);
  }
}

function validateRunId(value: unknown): asserts value is string {
  validateText(value, "runId is required");
  if (!UUID_PATTERN.test(value)) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_REQUEST_INVALID", "runId must be a UUID");
  }
}

function validateMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ContextAttemptBudgetError(
      "CONTEXT_ATTEMPT_BUDGET_INVALID_LIMIT",
      "Context attempt budget maxAttempts must be a positive safe integer",
    );
  }
}

function validateRequest(request: ContextAttemptBudgetRequest): void {
  validateText(request.budgetId, "budgetId is required");
  validateRunId(request.runId);
  validateText(request.turnId, "turnId is required");
  validateText(request.operationKey, "operationKey is required");
  if (!ATTEMPT_KINDS.has(request.kind)) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_REQUEST_INVALID", "kind is invalid");
  }
}

function validateReceipt(receipt: ContextAttemptBudgetReceipt): void {
  if (receipt.schemaVersion !== CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Receipt schema version is invalid");
  }
  validateText(receipt.budgetId, "budgetId is required");
  validateRunId(receipt.runId);
  validateText(receipt.turnId, "turnId is required");
  validateText(receipt.operationKey, "operationKey is required");
  if (!Number.isSafeInteger(receipt.attemptNumber) || receipt.attemptNumber < 1) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Receipt attempt number is invalid");
  }
  if (!ATTEMPT_KINDS.has(receipt.kind)) {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Receipt kind is invalid");
  }
  if (receipt.state !== "reserved" && receipt.state !== "consumed") {
    throw new ContextAttemptBudgetError("CONTEXT_ATTEMPT_RECEIPT_MISMATCH", "Receipt state is invalid");
  }
}

function mapReceipt(row: AttemptRow): ContextAttemptBudgetReceipt {
  return {
    schemaVersion: CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION,
    budgetId: row.budget_id,
    runId: row.run_id,
    turnId: row.turn_id,
    operationKey: row.operation_key,
    attemptNumber: row.attempt_number,
    kind: row.kind,
    state: row.state,
  };
}

function assertSameOperation(existing: AttemptRow, request: ContextAttemptBudgetRequest): void {
  if (existing.run_id !== request.runId || existing.turn_id !== request.turnId) {
    throw new ContextAttemptBudgetError(
      "CONTEXT_ATTEMPT_OPERATION_CONFLICT",
      "Operation key was reused for a different context identity",
    );
  }
}

function assertReceiptMatches(existing: AttemptRow, receipt: ContextAttemptBudgetReceipt): void {
  if (
    existing.run_id !== receipt.runId
    || existing.turn_id !== receipt.turnId
    || existing.attempt_number !== receipt.attemptNumber
  ) {
    throw new ContextAttemptBudgetError(
      "CONTEXT_ATTEMPT_RECEIPT_MISMATCH",
      "Receipt does not match the reserved context attempt",
    );
  }
}

/** PostgreSQL adapter for the context runtime's single bounded attempt budget. */
export class ContextAttemptBudgetRepository implements ContextAttemptBudgetPort {
  private readonly maxAttempts: number;

  public constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    options: ContextAttemptBudgetRepositoryOptions,
  ) {
    validateText(organizationId, "organizationId is required");
    validateMaxAttempts(options.maxAttempts);
    this.maxAttempts = options.maxAttempts;
  }

  public async reserve(request: ContextAttemptBudgetRequest): Promise<ContextAttemptBudgetReserveResult> {
    validateRequest(request);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_context_attempt_budgets (
           organization_id, budget_id, run_id, max_attempts
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, budget_id) DO NOTHING`,
        [this.organizationId, request.budgetId, request.runId, this.maxAttempts],
      );

      const budget = await this.lockBudget(client, request.budgetId);
      if (!budget) {
        throw new ContextAttemptBudgetError(
          "CONTEXT_ATTEMPT_RESERVATION_NOT_FOUND",
          `No context attempt budget exists for ${request.budgetId}`,
        );
      }
      if (budget.run_id !== request.runId) {
        throw new ContextAttemptBudgetError(
          "CONTEXT_ATTEMPT_BUDGET_ID_CONFLICT",
          "Budget ID was reused for a different run",
        );
      }

      const existing = await this.findAttempt(client, request.budgetId, request.operationKey);
      if (existing) {
        assertSameOperation(existing, request);
        return { status: "replayed", receipt: mapReceipt(existing) };
      }

      if (budget.reserved_attempts >= budget.max_attempts) {
        return {
          status: "exhausted",
          outcome: new ContextAttemptBudgetExhaustedError(
            request.budgetId,
            request.runId,
            request.turnId,
            budget.max_attempts,
            budget.reserved_attempts,
            request.operationKey,
            request.kind,
          ),
        };
      }

      const attemptNumber = budget.reserved_attempts + 1;
      const inserted = await client.query<AttemptRow>(
        `INSERT INTO agent_context_attempt_reservations (
           organization_id, budget_id, run_id, turn_id, operation_key,
           attempt_number, kind, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved')
         RETURNING budget_id, run_id, turn_id, operation_key, attempt_number, kind, state`,
        [
          this.organizationId,
          request.budgetId,
          request.runId,
          request.turnId,
          request.operationKey,
          attemptNumber,
          request.kind,
        ],
      );
      const attempt = inserted.rows[0];
      if (!attempt) throw new Error("Context attempt reservation was not persisted");

      const updated = await client.query(
        `UPDATE agent_context_attempt_budgets
         SET reserved_attempts = reserved_attempts + 1, updated_at = now()
         WHERE organization_id = $1 AND budget_id = $2
           AND reserved_attempts = $3`,
        [this.organizationId, request.budgetId, budget.reserved_attempts],
      );
      if (updated.rowCount !== 1) throw new Error("Context attempt budget counter did not advance");
      return { status: "reserved", receipt: mapReceipt(attempt) };
    });
  }

  public async consume(receipt: ContextAttemptBudgetReceipt): Promise<ContextAttemptBudgetConsumeResult> {
    validateReceipt(receipt);
    return withTransaction(this.pool, async (client) => {
      const budget = await this.lockBudget(client, receipt.budgetId);
      if (!budget) {
        throw new ContextAttemptBudgetError(
          "CONTEXT_ATTEMPT_RESERVATION_NOT_FOUND",
          `No context attempt budget exists for ${receipt.budgetId}`,
        );
      }
      if (budget.run_id !== receipt.runId) {
        throw new ContextAttemptBudgetError(
          "CONTEXT_ATTEMPT_RECEIPT_MISMATCH",
          "Receipt does not match the budget run",
        );
      }

      const existing = await this.findAttempt(client, receipt.budgetId, receipt.operationKey);
      if (!existing) {
        throw new ContextAttemptBudgetError(
          "CONTEXT_ATTEMPT_RESERVATION_NOT_FOUND",
          `No context attempt reservation exists for ${receipt.operationKey}`,
        );
      }
      assertReceiptMatches(existing, receipt);
      if (existing.state === "consumed") return { status: "replayed", receipt: mapReceipt(existing) };

      const updatedAttempt = await client.query<AttemptRow>(
        `UPDATE agent_context_attempt_reservations
         SET state = 'consumed', consumed_at = now()
         WHERE organization_id = $1 AND budget_id = $2 AND operation_key = $3
         RETURNING budget_id, run_id, turn_id, operation_key, attempt_number, kind, state`,
        [this.organizationId, receipt.budgetId, receipt.operationKey],
      );
      const consumed = updatedAttempt.rows[0];
      if (!consumed) throw new Error("Context attempt reservation was not consumed");

      const updatedBudget = await client.query(
        `UPDATE agent_context_attempt_budgets
         SET consumed_attempts = consumed_attempts + 1, updated_at = now()
         WHERE organization_id = $1 AND budget_id = $2`,
        [this.organizationId, receipt.budgetId],
      );
      if (updatedBudget.rowCount !== 1) throw new Error("Context attempt consumed counter did not advance");
      return { status: "consumed", receipt: mapReceipt(consumed) };
    });
  }

  public async replay(input: { readonly budgetId: string; readonly operationKey: string }): Promise<ContextAttemptBudgetReplayResult> {
    validateText(input.budgetId, "budgetId is required");
    validateText(input.operationKey, "operationKey is required");
    const result = await query<AttemptRow>(
      this.pool,
      `SELECT budget_id, run_id, turn_id, operation_key, attempt_number, kind, state
       FROM agent_context_attempt_reservations
       WHERE organization_id = $1 AND budget_id = $2 AND operation_key = $3`,
      [this.organizationId, input.budgetId, input.operationKey],
    );
    const attempt = result.rows[0];
    return attempt ? { status: "replayed", receipt: mapReceipt(attempt) } : { status: "not_found" };
  }

  private async lockBudget(client: PoolClient, budgetId: string): Promise<BudgetRow | undefined> {
    const result = await client.query<BudgetRow>(
      `SELECT budget_id, run_id, max_attempts, reserved_attempts, consumed_attempts
       FROM agent_context_attempt_budgets
       WHERE organization_id = $1 AND budget_id = $2
       FOR UPDATE`,
      [this.organizationId, budgetId],
    );
    return result.rows[0];
  }

  private async findAttempt(client: PoolClient, budgetId: string, operationKey: string): Promise<AttemptRow | undefined> {
    const result = await client.query<AttemptRow>(
      `SELECT budget_id, run_id, turn_id, operation_key, attempt_number, kind, state
       FROM agent_context_attempt_reservations
       WHERE organization_id = $1 AND budget_id = $2 AND operation_key = $3
       FOR UPDATE`,
      [this.organizationId, budgetId, operationKey],
    );
    return result.rows[0];
  }
}

export type { ContextAttemptBudgetRepositoryOptions };
