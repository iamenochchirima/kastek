import type { Pool } from "pg";
import type { BillingClient } from "@kasitek-labs/server-support/billing-client";

export async function forwardAgentsUsage(
  pool: Pool,
  client: BillingClient,
  limit = 100,
): Promise<number> {
  const rows = await pool.query<{
    task_id: string;
    organization_id: string;
    accounted_tokens: number;
    outcome: string;
  }>(
    `SELECT l.task_id, t.organization_id, l.accounted_tokens, l.outcome
       FROM agents_platform.usage_ledger l
       JOIN agents_platform.tasks t ON t.id=l.task_id
      WHERE t.product='agents'
        AND NOT EXISTS (
          SELECT 1 FROM agents_platform.product_execution_tenants p
           WHERE p.organization_id=t.organization_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM agents_platform.billing_usage_forwarded f
           WHERE f.task_id=l.task_id
        )
      ORDER BY l.created_at
      LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  let forwarded = 0;
  for (const row of rows.rows) {
    await client.usage({
      tenantId: row.organization_id,
      meterKey: "agent_tokens",
      quantity: String(row.accounted_tokens),
      sourceType: "agent_task",
      sourceId: row.task_id,
      idempotencyKey: `agents:task:${row.task_id}`,
      metadata: { outcome: row.outcome },
    });
    await pool.query(
      `INSERT INTO agents_platform.billing_usage_forwarded(
         task_id, organization_id, accounted_tokens, outcome
       ) VALUES($1,$2,$3,$4)
       ON CONFLICT (task_id) DO NOTHING`,
      [row.task_id, row.organization_id, row.accounted_tokens, row.outcome],
    );
    forwarded++;
  }
  return forwarded;
}
