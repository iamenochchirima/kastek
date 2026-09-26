import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";

export interface RunBudgetLimits {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
}

export interface ModelBudgetReservation {
  capture: (usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd?: number }) => Promise<void>;
  release: (reason: string) => Promise<void>;
  markUnknown: (reason: string) => Promise<void>;
}

export interface ParallelBranchCapacityLease {
  id: string;
  branchKey: string;
  consumeModelSlot: () => Promise<void>;
  consumeToolSlot: () => Promise<void>;
  release: () => Promise<void>;
}

export interface UnknownModelBudgetReservation {
  id: string;
  runId: string;
  organizationId: string;
  reservationKey: string;
  estimatedTokens: number;
  estimatedCostUsd: number;
  installationId: string;
}

export interface RunBudgetReconciliationRecord {
  id: string;
  organizationId: string;
  installationId: string;
  runId: string;
  runStatus: string;
  reservationKey: string;
  status: "unknown";
  estimatedTokens: number;
  estimatedCostUsd: number;
  actualTotalTokens: number | null;
  actualCostUsd: number | null;
  reconciliationReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export class RunBudgetRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Admit all branches of a fan-out before any branch can reach a provider or
   * tool. A lease reserves the first possible model and tool operation in each
   * branch; later sequential operations still use the normal run ledger.
   *
   * The run budget row is locked while the active leases are counted, so two
   * concurrent fan-outs cannot both admit work beyond the configured limits.
   */
  public async reserveParallelBranchCapacity(input: {
    organizationId: string;
    runId: string;
    branches: Array<{ branchKey: string; modelSlot: boolean; toolSlot: boolean }>;
  }): Promise<Array<ParallelBranchCapacityLease | undefined>> {
    if (!input.branches.length) return [];
    return withTransaction(this.pool, async (client) => {
      const budget = await client.query<{
        max_model_calls: number | null;
        max_tool_calls: number | null;
        captured_model_calls: number;
        captured_tool_calls: number;
        reserved_model_calls: number;
      }>(
        `SELECT max_model_calls, max_tool_calls, captured_model_calls,
                captured_tool_calls, reserved_model_calls
         FROM run_budgets
         WHERE run_id = $1 AND organization_id = $2
         FOR UPDATE`,
        [input.runId, input.organizationId],
      );
      const currentBudget = budget.rows[0];
      if (!currentBudget) throw new Error("RUN_BUDGET_NOT_INITIALIZED");

      const branchKeys = [...new Set(input.branches.map((branch) => branch.branchKey))];
      if (branchKeys.length !== input.branches.length) throw new Error("PARALLEL_BRANCH_KEY_DUPLICATE");
      const existing = await client.query<{
        id: string;
        branch_key: string;
        status: "active" | "released";
        model_slot_status: "reserved" | "consumed" | "released";
        tool_slot_status: "reserved" | "consumed" | "released";
      }>(
        `SELECT id, branch_key, status, model_slot_status, tool_slot_status
         FROM run_budget_parallel_leases
         WHERE run_id = $1 AND organization_id = $2 AND branch_key = ANY($3::text[])
         FOR UPDATE`,
        [input.runId, input.organizationId, branchKeys],
      );
      const byKey = new Map(existing.rows.map((row) => [row.branch_key, row]));

      for (const branch of input.branches) {
        const row = byKey.get(branch.branchKey);
        if (!row || row.status === "released") {
          if (row) {
            await client.query(
              `UPDATE run_budget_parallel_leases
               SET status = 'active',
                   model_slot_status = CASE WHEN $3 THEN 'reserved' ELSE 'released' END,
                   tool_slot_status = CASE WHEN $4 THEN 'reserved' ELSE 'released' END,
                   settled_at = NULL
               WHERE id = $1 AND run_id = $2`,
              [row.id, input.runId, branch.modelSlot, branch.toolSlot],
            );
          } else {
            const created = await client.query<{
              id: string;
              branch_key: string;
              status: "active";
              model_slot_status: "reserved" | "released";
              tool_slot_status: "reserved" | "released";
            }>(
              `INSERT INTO run_budget_parallel_leases
                (run_id, organization_id, branch_key, model_slot_status, tool_slot_status)
               VALUES ($1, $2, $3, CASE WHEN $4 THEN 'reserved' ELSE 'released' END,
                       CASE WHEN $5 THEN 'reserved' ELSE 'released' END)
               RETURNING id, branch_key, status, model_slot_status, tool_slot_status`,
              [input.runId, input.organizationId, branch.branchKey, branch.modelSlot, branch.toolSlot],
            );
            byKey.set(branch.branchKey, created.rows[0]!);
          }
        }
      }

      const active = await client.query<{ model_slots: string; tool_slots: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active' AND model_slot_status = 'reserved')::text AS model_slots,
           COUNT(*) FILTER (WHERE status = 'active' AND tool_slot_status = 'reserved')::text AS tool_slots
         FROM run_budget_parallel_leases
         WHERE run_id = $1 AND organization_id = $2`,
        [input.runId, input.organizationId],
      );
      const activeModelSlots = Number(active.rows[0]?.model_slots ?? 0);
      const activeToolSlots = Number(active.rows[0]?.tool_slots ?? 0);
      const modelDemand = Number(currentBudget.captured_model_calls) + Number(currentBudget.reserved_model_calls) + activeModelSlots;
      const toolDemand = Number(currentBudget.captured_tool_calls) + activeToolSlots;
      if (currentBudget.max_model_calls !== null && modelDemand > currentBudget.max_model_calls) throw new Error("PARALLEL_MODEL_CAPACITY_EXCEEDED");
      if (currentBudget.max_tool_calls !== null && toolDemand > currentBudget.max_tool_calls) throw new Error("PARALLEL_TOOL_CAPACITY_EXCEEDED");

      return input.branches.map((branch) => {
        const row = byKey.get(branch.branchKey);
        if (!row) return undefined;
        return {
          id: row.id,
          branchKey: branch.branchKey,
          consumeModelSlot: () => this.consumeParallelBranchSlot({ organizationId: input.organizationId, runId: input.runId, leaseId: row.id, slot: "model" }),
          consumeToolSlot: () => this.consumeParallelBranchSlot({ organizationId: input.organizationId, runId: input.runId, leaseId: row.id, slot: "tool" }),
          release: () => this.releaseParallelBranchCapacity({ organizationId: input.organizationId, runId: input.runId, leaseId: row.id }),
        } satisfies ParallelBranchCapacityLease;
      });
    });
  }

  public async ensure(run: { organizationId: string; runId: string }, limits: RunBudgetLimits): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO run_budgets
         (run_id, organization_id, max_model_calls, max_tool_calls, max_total_tokens, max_estimated_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO NOTHING`,
      [run.runId, run.organizationId, limits.maxModelCalls ?? null, limits.maxToolCalls ?? null, limits.maxTotalTokens ?? null, limits.maxEstimatedCostUsd ?? null],
    );
  }

  public async reserveModelCall(input: {
    organizationId: string;
    runId: string;
    reservationKey: string;
    estimatedTokens: number;
    estimatedCostUsd: number;
    parallelLeaseId?: string;
  }): Promise<ModelBudgetReservation> {
    const existing = await withTransaction(this.pool, async (client) => {
      const budget = await client.query<{
        max_model_calls: number | null;
        max_total_tokens: string | null;
        max_estimated_cost_usd: string | null;
      }>("SELECT max_model_calls, max_total_tokens, max_estimated_cost_usd FROM run_budgets WHERE run_id = $1 AND organization_id = $2 FOR UPDATE", [input.runId, input.organizationId]);
      if (!budget.rows[0]) throw new Error("RUN_BUDGET_NOT_INITIALIZED");
      const current = await client.query<{ status: "reserved" | "captured" | "released" | "unknown"; id: string }>(
        "SELECT id, status FROM run_budget_reservations WHERE run_id = $1 AND organization_id = $2 AND reservation_key = $3 FOR UPDATE",
        [input.runId, input.organizationId, input.reservationKey],
      );
      if (current.rows[0]?.status === "reserved") {
        if (input.parallelLeaseId) await this.consumeParallelBranchSlotInTransaction(client, { organizationId: input.organizationId, runId: input.runId, leaseId: input.parallelLeaseId, slot: "model" });
        return current.rows[0];
      }
      if (current.rows[0]?.status === "captured") throw new Error("MODEL_CALL_ALREADY_SETTLED");
      if (current.rows[0]?.status === "unknown") throw new Error("MODEL_CALL_OUTCOME_UNKNOWN");
      if (current.rows[0]?.status === "released") {
        if (input.parallelLeaseId) await this.consumeParallelBranchSlotInTransaction(client, { organizationId: input.organizationId, runId: input.runId, leaseId: input.parallelLeaseId, slot: "model" });
        const reReserved = await client.query<{ id: string; status: "reserved" }>(
          `UPDATE run_budget_reservations
           SET status = 'reserved', estimated_tokens = $2, estimated_cost_usd = $3,
               actual_input_tokens = NULL, actual_output_tokens = NULL,
               actual_total_tokens = NULL, actual_cost_usd = NULL,
               settled_at = NULL, reconciliation_required = false,
               reconciliation_reason = NULL
           WHERE id = $1
           RETURNING id, status`,
          [current.rows[0].id, input.estimatedTokens, input.estimatedCostUsd],
        );
        await client.query(
          `UPDATE run_budgets
           SET reserved_model_calls = reserved_model_calls + 1,
               reserved_tokens = reserved_tokens + $2,
               reserved_cost_usd = reserved_cost_usd + $3,
               updated_at = now()
           WHERE run_id = $1`,
          [input.runId, input.estimatedTokens, input.estimatedCostUsd],
        );
        return reReserved.rows[0]!;
      }
      const usage = await client.query<{ reserved_model_calls: number; reserved_tokens: string; reserved_cost_usd: string; captured_model_calls: number; captured_total_tokens: string; captured_cost_usd: string }>(
        `SELECT reserved_model_calls, reserved_tokens, reserved_cost_usd, captured_model_calls, captured_total_tokens, captured_cost_usd
         FROM run_budgets WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      const row = usage.rows[0]!;
      if (input.parallelLeaseId) await this.consumeParallelBranchSlotInTransaction(client, { organizationId: input.organizationId, runId: input.runId, leaseId: input.parallelLeaseId, slot: "model" });
      const activeCapacity = await client.query<{ model_slots: string }>(
        `SELECT COUNT(*)::text AS model_slots
         FROM run_budget_parallel_leases
         WHERE run_id = $1 AND organization_id = $2
           AND status = 'active' AND model_slot_status = 'reserved'`,
        [input.runId, input.organizationId],
      );
      const modelCalls = Number(row.reserved_model_calls) + Number(row.captured_model_calls) + 1;
      const modelCallsWithParallelCapacity = modelCalls + Number(activeCapacity.rows[0]?.model_slots ?? 0);
      const tokens = Number(row.reserved_tokens) + Number(row.captured_total_tokens) + input.estimatedTokens;
      const cost = Number(row.reserved_cost_usd) + Number(row.captured_cost_usd) + input.estimatedCostUsd;
      const limits = budget.rows[0]!;
      if (limits.max_model_calls !== null && modelCallsWithParallelCapacity > limits.max_model_calls) throw new Error("MODEL_REQUEST_BUDGET_EXCEEDED");
      if (limits.max_total_tokens !== null && tokens > Number(limits.max_total_tokens)) throw new Error("MODEL_TOKEN_BUDGET_EXCEEDED");
      if (limits.max_estimated_cost_usd !== null && cost > Number(limits.max_estimated_cost_usd)) throw new Error("MODEL_SPEND_BUDGET_EXCEEDED");
      const inserted = await client.query<{ id: string; status: "reserved" }>(
        `INSERT INTO run_budget_reservations
          (run_id, organization_id, reservation_key, estimated_tokens, estimated_cost_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         RETURNING id, status`,
        [input.runId, input.organizationId, input.reservationKey, input.estimatedTokens, input.estimatedCostUsd],
      );
      await client.query(
        `UPDATE run_budgets
         SET reserved_model_calls = reserved_model_calls + 1,
             reserved_tokens = reserved_tokens + $2,
             reserved_cost_usd = reserved_cost_usd + $3,
             updated_at = now()
         WHERE run_id = $1`,
        [input.runId, input.estimatedTokens, input.estimatedCostUsd],
      );
      return inserted.rows[0]!;
    });
    return {
      capture: async (usage) => this.captureModelCall({ ...input, usage }),
      release: async (reason) => this.releaseModelCall({ ...input, reason }),
      markUnknown: async (reason) => this.markModelCallUnknown({ ...input, reason }),
    };
  }

  private async captureModelCall(input: {
    organizationId: string;
    runId: string;
    reservationKey: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd?: number };
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const reservation = await client.query<{ id: string; status: "reserved" | "captured" | "released" | "unknown"; estimated_tokens: string; estimated_cost_usd: string }>(
        "SELECT id, status, estimated_tokens, estimated_cost_usd FROM run_budget_reservations WHERE run_id = $1 AND organization_id = $2 AND reservation_key = $3 FOR UPDATE",
        [input.runId, input.organizationId, input.reservationKey],
      );
      const current = reservation.rows[0];
      if (!current) throw new Error("RUN_BUDGET_RESERVATION_NOT_FOUND");
      if (current.status !== "reserved") return;
      const actualCost = Math.max(0, input.usage.estimatedCostUsd ?? 0);
      const budget = await client.query<{ max_total_tokens: string | null; max_estimated_cost_usd: string | null }>("SELECT max_total_tokens, max_estimated_cost_usd FROM run_budgets WHERE run_id = $1 FOR UPDATE", [input.runId]);
      const next = await client.query<{ captured_total_tokens: string; captured_cost_usd: string }>("SELECT captured_total_tokens, captured_cost_usd FROM run_budgets WHERE run_id = $1", [input.runId]);
      const nextTokens = Number(next.rows[0]?.captured_total_tokens ?? 0) + input.usage.totalTokens;
      const nextCost = Number(next.rows[0]?.captured_cost_usd ?? 0) + actualCost;
      await client.query(
        `UPDATE run_budget_reservations
         SET status = 'captured', actual_input_tokens = $2, actual_output_tokens = $3,
             actual_total_tokens = $4, actual_cost_usd = $5, settled_at = now()
         WHERE id = $1 AND status = 'reserved'`,
        [current.id, input.usage.inputTokens, input.usage.outputTokens, input.usage.totalTokens, actualCost],
      );
      await client.query(
        `UPDATE run_budgets
         SET reserved_model_calls = GREATEST(0, reserved_model_calls - 1),
             reserved_tokens = GREATEST(0, reserved_tokens - $2),
             reserved_cost_usd = GREATEST(0, reserved_cost_usd - $3),
             captured_model_calls = captured_model_calls + 1,
             captured_input_tokens = captured_input_tokens + $4,
             captured_output_tokens = captured_output_tokens + $5,
             captured_total_tokens = captured_total_tokens + $6,
             captured_cost_usd = captured_cost_usd + $7,
             updated_at = now()
         WHERE run_id = $1`,
        [input.runId, current.estimated_tokens, current.estimated_cost_usd, input.usage.inputTokens, input.usage.outputTokens, input.usage.totalTokens, actualCost],
      );
      if (budget.rows[0]?.max_total_tokens !== null && budget.rows[0]?.max_total_tokens !== undefined && nextTokens > Number(budget.rows[0].max_total_tokens)) throw new Error("MODEL_TOKEN_BUDGET_EXCEEDED");
      if (budget.rows[0]?.max_estimated_cost_usd !== null && budget.rows[0]?.max_estimated_cost_usd !== undefined && nextCost > Number(budget.rows[0].max_estimated_cost_usd)) throw new Error("MODEL_SPEND_BUDGET_EXCEEDED");
    });
  }

  private async releaseModelCall(input: { organizationId: string; runId: string; reservationKey: string; reason: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const reservation = await client.query<{ id: string; status: string; estimated_tokens: string; estimated_cost_usd: string }>("SELECT id, status, estimated_tokens, estimated_cost_usd FROM run_budget_reservations WHERE run_id = $1 AND organization_id = $2 AND reservation_key = $3 FOR UPDATE", [input.runId, input.organizationId, input.reservationKey]);
      const current = reservation.rows[0];
      if (!current || current.status !== "reserved") return;
      await client.query("UPDATE run_budget_reservations SET status = 'released', settled_at = now() WHERE id = $1", [current.id]);
      await client.query("UPDATE run_budgets SET reserved_model_calls = GREATEST(0, reserved_model_calls - 1), reserved_tokens = GREATEST(0, reserved_tokens - $2), reserved_cost_usd = GREATEST(0, reserved_cost_usd - $3), updated_at = now() WHERE run_id = $1", [input.runId, current.estimated_tokens, current.estimated_cost_usd]);
    });
  }

  /** Mark a model reservation unknown when the provider outcome cannot be proven. */
  private async markModelCallUnknown(input: { organizationId: string; runId: string; reservationKey: string; reason: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const reservation = await client.query<{ id: string; status: string; estimated_tokens: string; estimated_cost_usd: string }>(
        `SELECT id, status, estimated_tokens, estimated_cost_usd
         FROM run_budget_reservations
         WHERE run_id = $1 AND organization_id = $2 AND reservation_key = $3
         FOR UPDATE`,
        [input.runId, input.organizationId, input.reservationKey],
      );
      const current = reservation.rows[0];
      if (!current || current.status !== "reserved") return;
      await client.query(
        `UPDATE run_budget_reservations
         SET status = 'unknown', reconciliation_required = true,
             reconciliation_reason = $2, settled_at = now()
         WHERE id = $1 AND status = 'reserved'`,
        [current.id, input.reason.slice(0, 2_000)],
      );
      await client.query(
        `UPDATE run_budgets
         SET reserved_model_calls = GREATEST(0, reserved_model_calls - 1),
             reserved_tokens = GREATEST(0, reserved_tokens - $2),
             reserved_cost_usd = GREATEST(0, reserved_cost_usd - $3),
             updated_at = now()
         WHERE run_id = $1 AND organization_id = $4`,
        [input.runId, current.estimated_tokens, current.estimated_cost_usd, input.organizationId],
      );
    });
  }

  /**
   * Move reservations left behind by a timed-out or terminated worker into an
   * explicit unknown state. This releases only the estimate held by the
   * ledger; it never claims that the provider did not execute the request.
   */
  public async markStaleReservationsUnknown(input: {
    olderThanMs: number;
    limit?: number;
    reason?: string;
    organizationId?: string;
    runId?: string;
  }): Promise<UnknownModelBudgetReservation[]> {
    const ageMs = Number.isFinite(input.olderThanMs) && input.olderThanMs > 0 ? input.olderThanMs : 300_000;
    const limit = Number.isSafeInteger(input.limit) && input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
    const cutoff = new Date(Date.now() - ageMs);
    return withTransaction(this.pool, async (client) => {
      const reservations = await client.query<{
        id: string;
        run_id: string;
        organization_id: string;
        reservation_key: string;
        estimated_tokens: string;
        estimated_cost_usd: string;
        installation_id: string;
      }>(
        `SELECT reservation.id, reservation.run_id, reservation.organization_id,
                reservation.reservation_key, reservation.estimated_tokens,
                reservation.estimated_cost_usd, run.installation_id
         FROM run_budget_reservations reservation
         JOIN agent_runs run ON run.id = reservation.run_id
         WHERE reservation.status = 'reserved' AND reservation.created_at <= $1
           AND ($3::text IS NULL OR reservation.organization_id = $3)
           AND ($4::uuid IS NULL OR reservation.run_id = $4::uuid)
         ORDER BY reservation.created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [cutoff, limit, input.organizationId ?? null, input.runId ?? null],
      );
      const unknown: UnknownModelBudgetReservation[] = [];
      for (const reservation of reservations.rows) {
        await client.query(
          `UPDATE run_budget_reservations
           SET status = 'unknown', reconciliation_required = true,
               reconciliation_reason = $2, settled_at = now()
           WHERE id = $1 AND status = 'reserved'`,
          [reservation.id, input.reason ?? "Worker reservation exceeded reconciliation age"],
        );
        await client.query(
          `UPDATE run_budgets
           SET reserved_model_calls = GREATEST(0, reserved_model_calls - 1),
               reserved_tokens = GREATEST(0, reserved_tokens - $2),
               reserved_cost_usd = GREATEST(0, reserved_cost_usd - $3),
               updated_at = now()
           WHERE run_id = $1 AND organization_id = $4`,
          [reservation.run_id, reservation.estimated_tokens, reservation.estimated_cost_usd, reservation.organization_id],
        );
        unknown.push({
          id: reservation.id,
          runId: reservation.run_id,
          organizationId: reservation.organization_id,
          reservationKey: reservation.reservation_key,
          estimatedTokens: Number(reservation.estimated_tokens),
          estimatedCostUsd: Number(reservation.estimated_cost_usd),
          installationId: reservation.installation_id,
        });
      }
      return unknown;
    });
  }

  /**
   * Resolve an unknown provider outcome after an operator or provider lookup.
   * A captured outcome must include actual usage; a released outcome means the
   * provider confirmed that no request was accepted.
   */
  public async reconcileUnknownReservation(input: {
    organizationId: string;
    reservationId: string;
    outcome: "captured" | "released";
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd?: number };
    reason?: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const reservation = await client.query<{
        id: string;
        run_id: string;
        estimated_tokens: string;
        estimated_cost_usd: string;
        status: string;
      }>(
        `SELECT id, run_id, estimated_tokens, estimated_cost_usd, status
         FROM run_budget_reservations
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [input.reservationId, input.organizationId],
      );
      const current = reservation.rows[0];
      if (!current) throw new Error("RUN_BUDGET_RESERVATION_NOT_FOUND");
      if (current.status !== "unknown") throw new Error("RUN_BUDGET_RESERVATION_NOT_PENDING_RECONCILIATION");
      if (input.outcome === "captured") {
        const usage = input.usage;
        if (!usage) throw new Error("RECONCILIATION_USAGE_REQUIRED");
        const actualCost = Math.max(0, usage.estimatedCostUsd ?? 0);
        await client.query(
          `UPDATE run_budget_reservations
           SET status = 'captured', reconciliation_required = false,
               reconciliation_reason = $2, actual_input_tokens = $3,
               actual_output_tokens = $4, actual_total_tokens = $5,
               actual_cost_usd = $6, settled_at = now()
           WHERE id = $1`,
          [current.id, input.reason ?? "Provider outcome reconciled as captured", usage.inputTokens, usage.outputTokens, usage.totalTokens, actualCost],
        );
        await client.query(
          `UPDATE run_budgets
           SET captured_model_calls = captured_model_calls + 1,
               captured_input_tokens = captured_input_tokens + $2,
               captured_output_tokens = captured_output_tokens + $3,
               captured_total_tokens = captured_total_tokens + $4,
               captured_cost_usd = captured_cost_usd + $5,
               updated_at = now()
           WHERE run_id = $1 AND organization_id = $6`,
          [current.run_id, usage.inputTokens, usage.outputTokens, usage.totalTokens, actualCost, input.organizationId],
        );
        return;
      }
      await client.query(
        `UPDATE run_budget_reservations
         SET status = 'released', reconciliation_required = false,
             reconciliation_reason = $2, settled_at = now()
         WHERE id = $1`,
        [current.id, input.reason ?? "Provider outcome reconciled as released"],
      );
    });
  }

  /**
   * Charges one logical tool operation. When operationKey is supplied, the
   * tool invocation row is the idempotency ledger and the marker plus budget
   * counter are updated in one transaction. Temporal retries therefore do not
   * turn one provider operation into multiple budget charges.
   */
  public async consumeToolCall(input: { organizationId: string; runId: string; operationKey?: string }): Promise<void> {
    await this.consumeToolCallWithParallelLease(input);
  }

  public async consumeToolCallWithParallelLease(input: { organizationId: string; runId: string; operationKey?: string; parallelLeaseId?: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT run_id FROM run_budgets WHERE run_id = $1 AND organization_id = $2 FOR UPDATE", [input.runId, input.organizationId]);
      if (input.parallelLeaseId) await this.consumeParallelBranchSlotInTransaction(client, { organizationId: input.organizationId, runId: input.runId, leaseId: input.parallelLeaseId, slot: "tool" });
      if (input.operationKey) {
        const claimed = await client.query(
          `UPDATE tool_invocations
           SET tool_budget_consumed_at = now()
           WHERE run_id = $1 AND organization_id = $2 AND runtime_operation_id = $3
             AND tool_budget_consumed_at IS NULL
           RETURNING runtime_operation_id`,
          [input.runId, input.organizationId, input.operationKey],
        );
        if (!claimed.rowCount) {
          const existing = await client.query(
            `SELECT 1
             FROM tool_invocations
             WHERE run_id = $1 AND organization_id = $2 AND runtime_operation_id = $3
             LIMIT 1`,
            [input.runId, input.organizationId, input.operationKey],
          );
          if (!existing.rowCount) throw new Error("TOOL_INVOCATION_NOT_FOUND");
          return;
        }
      }
      const active = await client.query<{ tool_slots: string }>(
        `SELECT COUNT(*)::text AS tool_slots
         FROM run_budget_parallel_leases
         WHERE run_id = $1 AND organization_id = $2
           AND status = 'active' AND tool_slot_status = 'reserved'`,
        [input.runId, input.organizationId],
      );
      const result = await client.query<{ max_tool_calls: number | null; captured_tool_calls: number }>(
        `UPDATE run_budgets
         SET captured_tool_calls = captured_tool_calls + 1, updated_at = now()
         WHERE run_id = $1 AND organization_id = $2
           AND (max_tool_calls IS NULL OR captured_tool_calls + $3 < max_tool_calls)
         RETURNING max_tool_calls, captured_tool_calls`,
        [input.runId, input.organizationId, Number(active.rows[0]?.tool_slots ?? 0)],
      );
      if (!result.rows[0]) throw new Error("TOOL_CALL_BUDGET_EXCEEDED");
    });
  }

  private async consumeParallelBranchSlot(input: { organizationId: string; runId: string; leaseId: string; slot: "model" | "tool" }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT run_id FROM run_budgets WHERE run_id = $1 AND organization_id = $2 FOR UPDATE", [input.runId, input.organizationId]);
      await this.consumeParallelBranchSlotInTransaction(client, input);
    });
  }

  private async consumeParallelBranchSlotInTransaction(client: PoolClient, input: { organizationId: string; runId: string; leaseId: string; slot: "model" | "tool" }): Promise<void> {
    const lease = await client.query<{ status: "active" | "released"; model_slot_status: "reserved" | "consumed" | "released"; tool_slot_status: "reserved" | "consumed" | "released" }>(
      `SELECT status, model_slot_status, tool_slot_status
       FROM run_budget_parallel_leases
       WHERE id = $1 AND run_id = $2 AND organization_id = $3
       FOR UPDATE`,
      [input.leaseId, input.runId, input.organizationId],
    );
    const row = lease.rows[0];
    if (!row || row.status !== "active") throw new Error("PARALLEL_CAPACITY_LEASE_NOT_ACTIVE");
    const status = input.slot === "model" ? row.model_slot_status : row.tool_slot_status;
    if (status === "released") throw new Error(`PARALLEL_${input.slot.toUpperCase()}_CAPACITY_NOT_RESERVED`);
    if (status === "reserved") {
      const column = input.slot === "model" ? "model_slot_status" : "tool_slot_status";
      await client.query(`UPDATE run_budget_parallel_leases SET ${column} = 'consumed' WHERE id = $1`, [input.leaseId]);
    }
  }

  private async releaseParallelBranchCapacity(input: { organizationId: string; runId: string; leaseId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT run_id FROM run_budgets WHERE run_id = $1 AND organization_id = $2 FOR UPDATE", [input.runId, input.organizationId]);
      await client.query(
        `UPDATE run_budget_parallel_leases
         SET status = 'released', model_slot_status = 'released',
             tool_slot_status = 'released', settled_at = now()
         WHERE id = $1 AND run_id = $2 AND organization_id = $3 AND status = 'active'`,
        [input.leaseId, input.runId, input.organizationId],
      );
    });
  }

  public async pendingReconciliation(organizationId: string | undefined, limit = 100): Promise<RunBudgetReconciliationRecord[]> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    const result = await query<{
      id: string;
      organization_id: string;
      installation_id: string;
      run_id: string;
      run_status: string;
      reservation_key: string;
      estimated_tokens: string;
      estimated_cost_usd: string;
      actual_total_tokens: number | null;
      actual_cost_usd: string | null;
      reconciliation_reason: string | null;
      created_at: string;
      settled_at: string | null;
    }>(
      this.pool,
      `SELECT reservation.id, reservation.organization_id, run.installation_id,
              reservation.run_id, run.status AS run_status, reservation.reservation_key,
              reservation.estimated_tokens, reservation.estimated_cost_usd,
              reservation.actual_total_tokens, reservation.actual_cost_usd,
              reservation.reconciliation_reason, reservation.created_at,
              reservation.settled_at
       FROM run_budget_reservations reservation
       JOIN agent_runs run ON run.id = reservation.run_id
       WHERE reservation.reconciliation_required = TRUE
         AND ($1::text IS NULL OR reservation.organization_id = $1)
       ORDER BY reservation.created_at ASC
       LIMIT $2`,
      [organizationId ?? null, boundedLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      installationId: row.installation_id,
      runId: row.run_id,
      runStatus: row.run_status,
      reservationKey: row.reservation_key,
      status: "unknown",
      estimatedTokens: Number(row.estimated_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
      actualTotalTokens: row.actual_total_tokens,
      actualCostUsd: row.actual_cost_usd === null ? null : Number(row.actual_cost_usd),
      reconciliationReason: row.reconciliation_reason,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    }));
  }

  public async summary(organizationId: string): Promise<{
    reservations: number;
    reserved: number;
    captured: number;
    released: number;
    unknown: number;
    reconciliationRequired: number;
    capturedTokens: number;
    capturedCostUsd: number;
  }> {
    const result = await query<{
      reservations: string;
      reserved: string;
      captured: string;
      released: string;
      unknown: string;
      reconciliation_required: string;
      captured_tokens: string;
      captured_cost_usd: string;
    }>(
      this.pool,
      `SELECT COUNT(*)::text AS reservations,
              COUNT(*) FILTER (WHERE reservation.status = 'reserved')::text AS reserved,
              COUNT(*) FILTER (WHERE reservation.status = 'captured')::text AS captured,
              COUNT(*) FILTER (WHERE reservation.status = 'released')::text AS released,
              COUNT(*) FILTER (WHERE reservation.status = 'unknown')::text AS unknown,
              COUNT(*) FILTER (WHERE reservation.reconciliation_required)::text AS reconciliation_required,
              COALESCE(SUM(reservation.actual_total_tokens) FILTER (WHERE reservation.status = 'captured'), 0)::text AS captured_tokens,
              COALESCE(SUM(reservation.actual_cost_usd) FILTER (WHERE reservation.status = 'captured'), 0)::text AS captured_cost_usd
       FROM run_budget_reservations reservation
       WHERE reservation.organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0]!;
    return {
      reservations: Number(row.reservations),
      reserved: Number(row.reserved),
      captured: Number(row.captured),
      released: Number(row.released),
      unknown: Number(row.unknown),
      reconciliationRequired: Number(row.reconciliation_required),
      capturedTokens: Number(row.captured_tokens),
      capturedCostUsd: Number(row.captured_cost_usd),
    };
  }

  public async summaryForRun(organizationId: string, runId: string): Promise<{
    reservations: number;
    reserved: number;
    captured: number;
    released: number;
    unknown: number;
    reconciliationRequired: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
    capturedTokens: number;
    capturedCostUsd: number;
  }> {
    const result = await query<{
      reservations: string;
      reserved: string;
      captured: string;
      released: string;
      unknown: string;
      reconciliation_required: string;
      estimated_tokens: string;
      estimated_cost_usd: string;
      captured_tokens: string;
      captured_cost_usd: string;
    }>(
      this.pool,
      `SELECT COUNT(*)::text AS reservations,
              COUNT(*) FILTER (WHERE reservation.status = 'reserved')::text AS reserved,
              COUNT(*) FILTER (WHERE reservation.status = 'captured')::text AS captured,
              COUNT(*) FILTER (WHERE reservation.status = 'released')::text AS released,
              COUNT(*) FILTER (WHERE reservation.status = 'unknown')::text AS unknown,
              COUNT(*) FILTER (WHERE reservation.reconciliation_required)::text AS reconciliation_required,
              COALESCE(SUM(reservation.estimated_tokens), 0)::text AS estimated_tokens,
              COALESCE(SUM(reservation.estimated_cost_usd), 0)::text AS estimated_cost_usd,
              COALESCE(SUM(reservation.actual_total_tokens) FILTER (WHERE reservation.status = 'captured'), 0)::text AS captured_tokens,
              COALESCE(SUM(reservation.actual_cost_usd) FILTER (WHERE reservation.status = 'captured'), 0)::text AS captured_cost_usd
       FROM run_budget_reservations reservation
       WHERE reservation.organization_id = $1 AND reservation.run_id = $2`,
      [organizationId, runId],
    );
    const row = result.rows[0]!;
    return {
      reservations: Number(row.reservations),
      reserved: Number(row.reserved),
      captured: Number(row.captured),
      released: Number(row.released),
      unknown: Number(row.unknown),
      reconciliationRequired: Number(row.reconciliation_required),
      estimatedTokens: Number(row.estimated_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
      capturedTokens: Number(row.captured_tokens),
      capturedCostUsd: Number(row.captured_cost_usd),
    };
  }

  public static limitsFrom(values: Record<string, unknown>): RunBudgetLimits {
    return {
      ...(positiveInteger(values.maxModelCalls) === undefined ? {} : { maxModelCalls: positiveInteger(values.maxModelCalls) }),
      ...(positiveInteger(values.maxToolCalls) === undefined ? {} : { maxToolCalls: positiveInteger(values.maxToolCalls) }),
      ...(positiveInteger(values.maxTotalTokens) === undefined ? {} : { maxTotalTokens: positiveInteger(values.maxTotalTokens) }),
      ...(nonNegativeNumber(values.maxEstimatedCostUsd) === undefined ? {} : { maxEstimatedCostUsd: nonNegativeNumber(values.maxEstimatedCostUsd) }),
    };
  }
}
