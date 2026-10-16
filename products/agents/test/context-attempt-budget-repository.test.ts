import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ContextAttemptBudgetRepository,
} from "../src/db/repositories/context-attempt-budget-repository";
import {
  CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION,
  ContextAttemptBudgetError,
  type ContextAttemptBudgetReceipt,
} from "../src/runtime/context-attempt-budget";

const organizationId = "org-context-attempts";
const runId = "11111111-1111-4111-8111-111111111111";

function request(overrides: Record<string, unknown> = {}) {
  return {
    budgetId: "budget-1",
    runId,
    turnId: "turn-1",
    operationKey: "operation-1",
    kind: "overflow_recovery" as const,
    ...overrides,
  };
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    budget_id: "budget-1",
    run_id: runId,
    turn_id: "turn-1",
    operation_key: "operation-1",
    attempt_number: 1,
    kind: "overflow_recovery" as const,
    state: "reserved" as const,
    ...overrides,
  };
}

function budgetRow(overrides: Record<string, unknown> = {}) {
  return {
    budget_id: "budget-1",
    run_id: runId,
    max_attempts: 2,
    reserved_attempts: 0,
    consumed_attempts: 0,
    ...overrides,
  };
}

function transactionalPool(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    return responses.shift() ?? { rows: [], rowCount: 0 };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return { pool, clientQuery };
}

function receipt(overrides: Partial<ContextAttemptBudgetReceipt> = {}): ContextAttemptBudgetReceipt {
  return {
    schemaVersion: CONTEXT_ATTEMPT_BUDGET_SCHEMA_VERSION,
    ...request(),
    attemptNumber: 1,
    state: "reserved",
    ...overrides,
  };
}

describe("ContextAttemptBudgetRepository", () => {
  it("reserves one durable slot and replays the same operation without charging twice", async () => {
    const { pool, clientQuery } = transactionalPool([
      { rows: [] },
      { rows: [budgetRow()] },
      { rows: [] },
      { rows: [attemptRow()] },
      { rowCount: 1 },
    ]);
    const repository = new ContextAttemptBudgetRepository(pool as never, organizationId, { maxAttempts: 2 });

    await expect(repository.reserve(request())).resolves.toEqual({
      status: "reserved",
      receipt: receipt(),
    });
    expect(clientQuery.mock.calls[1]?.[0]).toContain("agent_context_attempt_budgets");
    expect(clientQuery.mock.calls[4]?.[0]).toContain("agent_context_attempt_reservations");

    const replayPool = transactionalPool([
      { rows: [] },
      { rows: [budgetRow({ reserved_attempts: 1 })] },
      { rows: [attemptRow()] },
    ]);
    const replayRepository = new ContextAttemptBudgetRepository(replayPool.pool as never, organizationId, { maxAttempts: 2 });
    await expect(replayRepository.reserve(request())).resolves.toEqual({
      status: "replayed",
      receipt: receipt(),
    });
    expect(replayPool.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO agent_context_attempt_reservations"))).toBe(false);
  });

  it("returns a typed exhausted result and leaves the durable reservation untouched", async () => {
    const { pool, clientQuery } = transactionalPool([
      { rows: [] },
      { rows: [budgetRow({ reserved_attempts: 2 })] },
      { rows: [] },
    ]);
    const repository = new ContextAttemptBudgetRepository(pool as never, organizationId, { maxAttempts: 2 });

    const result = await repository.reserve(request({ operationKey: "operation-3" }));
    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      expect(result.outcome.code).toBe("CONTEXT_ATTEMPT_BUDGET_EXHAUSTED");
      expect(result.outcome.maxAttempts).toBe(2);
      expect(result.outcome.attemptedAttempts).toBe(2);
    }
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO agent_context_attempt_reservations"))).toBe(false);
  });

  it("consumes once and replays the consumed receipt after worker loss or duplicate completion", async () => {
    const { pool, clientQuery } = transactionalPool([
      { rows: [budgetRow({ reserved_attempts: 1 })] },
      { rows: [attemptRow()] },
      { rows: [attemptRow({ state: "consumed" })] },
      { rowCount: 1 },
    ]);
    const repository = new ContextAttemptBudgetRepository(pool as never, organizationId, { maxAttempts: 2 });

    await expect(repository.consume(receipt())).resolves.toEqual({
      status: "consumed",
      receipt: receipt({ state: "consumed" }),
    });

    const replayPool = transactionalPool([
      { rows: [budgetRow({ reserved_attempts: 1, consumed_attempts: 1 })] },
      { rows: [attemptRow({ state: "consumed" })] },
    ]);
    const replayRepository = new ContextAttemptBudgetRepository(replayPool.pool as never, organizationId, { maxAttempts: 2 });
    await expect(replayRepository.consume(receipt())).resolves.toEqual({
      status: "replayed",
      receipt: receipt({ state: "consumed" }),
    });
    expect(replayPool.clientQuery.mock.calls.some(([sql]) => String(sql).includes("SET state = 'consumed'"))).toBe(false);
  });

  it("replays a reservation by tenant-scoped budget and operation identity", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [attemptRow()] }),
    };
    const repository = new ContextAttemptBudgetRepository(pool as never, organizationId, { maxAttempts: 2 });

    await expect(repository.replay({ budgetId: "budget-1", operationKey: "operation-1" })).resolves.toEqual({
      status: "replayed",
      receipt: receipt(),
    });
    expect(pool.query.mock.calls[0]?.[1]).toEqual([organizationId, "budget-1", "operation-1"]);
  });

  it("rejects invalid storage identities before opening a transaction", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const repository = new ContextAttemptBudgetRepository(pool as never, organizationId, { maxAttempts: 2 });

    await expect(repository.reserve(request({ runId: "run-1" }))).rejects.toMatchObject<Partial<ContextAttemptBudgetError>>({
      code: "CONTEXT_ATTEMPT_REQUEST_INVALID",
    });
    await expect(repository.replay({ budgetId: "", operationKey: "operation-1" })).rejects.toMatchObject<Partial<ContextAttemptBudgetError>>({
      code: "CONTEXT_ATTEMPT_REQUEST_INVALID",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("defines only bounded identifiers and counters with tenant and run protection", async () => {
    const migration = await readFile(new URL("../migrations/146_context_attempt_budgets.sql", import.meta.url), "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS agent_context_attempt_budgets");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS agent_context_attempt_reservations");
    expect(migration).toContain("UNIQUE (organization_id, budget_id, operation_key)");
    expect(migration).toContain("UNIQUE (organization_id, budget_id, attempt_number)");
    expect(migration).toContain("kasitek_validate_run_child_scope");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("state IN ('reserved', 'consumed')");
    const ddl = migration.replace(/^\s*--.*$/gm, "");
    expect(ddl).not.toMatch(/prompt|model|credential|memory|content|schema\b/i);
  });
});
