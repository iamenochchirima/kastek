import type { Pool } from "pg";
import type { BillingClient } from "@kasitek-labs/server-support/billing-client";

/**
 * Forward settled task usage to billing.
 * `agent_ai_cost` is the billed meter: managed model cost in micro-USD.
 * `agent_tokens` stays as an analytics meter and is priced at zero.
 */
export async function forwardAgentsUsage(
  pool: Pool,
  client: BillingClient,
  limit = 100,
): Promise<number> {
  const rows = await pool.query<{
    task_id: string;
    organization_id: string;
    accounted_tokens: number;
    managed_cost_micros: string;
    outcome: string;
  }>(
    `SELECT l.task_id, t.organization_id, l.accounted_tokens,
            l.managed_cost_micros::text AS managed_cost_micros, l.outcome
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
    const managedCost = BigInt(row.managed_cost_micros);
    try {
      if (managedCost > 0n) {
        await client.usage({
          tenantId: row.organization_id,
          meterKey: "agent_ai_cost",
          quantity: managedCost.toString(),
          sourceType: "agent_task",
          sourceId: row.task_id,
          idempotencyKey: `agents:task:${row.task_id}:cost`,
          metadata: { outcome: row.outcome, unit: "micro_usd" },
        });
      }
      await client.usage({
        tenantId: row.organization_id,
        meterKey: "agent_tokens",
        quantity: String(row.accounted_tokens),
        sourceType: "agent_task",
        sourceId: row.task_id,
        idempotencyKey: `agents:task:${row.task_id}`,
        metadata: { outcome: row.outcome },
      });
    } catch (error) {
      // A tenant without a billing link can never settle. Record it and keep the queue moving;
      // transient failures still retry on the next pass.
      if (!/not linked/i.test(error instanceof Error ? error.message : "")) throw error;
      await pool.query(
        `INSERT INTO agents_platform.billing_usage_forwarded(
           task_id, organization_id, accounted_tokens, managed_cost_micros, outcome, skipped_reason
         ) VALUES($1,$2,$3,$4,$5,'account_not_linked')
         ON CONFLICT (task_id) DO NOTHING`,
        [row.task_id, row.organization_id, row.accounted_tokens, row.managed_cost_micros, row.outcome],
      );
      forwarded++;
      continue;
    }
    await pool.query(
      `INSERT INTO agents_platform.billing_usage_forwarded(
         task_id, organization_id, accounted_tokens, managed_cost_micros, outcome
       ) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (task_id) DO NOTHING`,
      [row.task_id, row.organization_id, row.accounted_tokens, row.managed_cost_micros, row.outcome],
    );
    forwarded++;
  }
  return forwarded;
}
