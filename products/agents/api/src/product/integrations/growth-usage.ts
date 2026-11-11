import type { Pool } from "pg";

export interface GrowthUsageItem {
  taskId: string;
  accountedTokens: number;
  managedCostMicros: string;
  outcome: string;
  settledAt: string;
}

/**
 * Settled usage for a Growth tenant, ordered by settlement time.
 * Task usage is billed because the task settled, not because a client later opened it.
 * The cursor is an exact microsecond timestamp string so a row is never replayed by
 * JavaScript millisecond truncation.
 */
export async function growthUsageFeed(
  pool: Pool,
  input: { tenantId: string; since: string | null; limit: number },
): Promise<{ items: GrowthUsageItem[]; nextSince: string | null }> {
  const rows = (
    await pool.query<{
      task_id: string;
      accounted_tokens: number;
      managed_cost_micros: string;
      outcome: string;
      settled_at: string;
    }>(
      `SELECT l.task_id, l.accounted_tokens, l.managed_cost_micros::text AS managed_cost_micros,
              l.outcome,
              to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at
         FROM agents_platform.usage_ledger l
         JOIN agents_platform.tasks t ON t.id=l.task_id
         JOIN agents_platform.product_task_contexts p ON p.task_id=t.id
        WHERE t.product='growth' AND p.tenant_id=$1
          AND l.created_at > COALESCE($2::timestamptz, '-infinity'::timestamptz)
        ORDER BY l.created_at, l.task_id
        LIMIT $3`,
      [input.tenantId, input.since, input.limit],
    )
  ).rows;
  return {
    items: rows.map(row => ({
      taskId: row.task_id,
      accountedTokens: row.accounted_tokens,
      managedCostMicros: row.managed_cost_micros,
      outcome: row.outcome,
      settledAt: row.settled_at,
    })),
    nextSince: rows.length ? rows[rows.length - 1]!.settled_at : null,
  };
}
