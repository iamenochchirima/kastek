import type { Pool } from "pg";
import { query } from "../pool";

export type EffectReceiptStatus = "reserved" | "executing" | "succeeded" | "failed" | "unknown" | "reconciled";

export interface EffectReceipt {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  provider_tool_call_id: string;
  capability: string;
  capability_version: string;
  arguments_hash: string;
  idempotency_key: string;
  status: EffectReceiptStatus;
  provider_receipt: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  reconciliation_required: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class EffectReceiptRepository {
  public constructor(private readonly pool: Pool) {}

  public async reserve(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    capability: string;
    capabilityVersion: string;
    argumentsHash: string;
    idempotencyKey: string;
  }): Promise<EffectReceipt> {
    const result = await query<EffectReceipt>(
      this.pool,
      `INSERT INTO agent_effect_receipts
        (organization_id, installation_id, run_id, provider_tool_call_id, capability,
         capability_version, arguments_hash, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved')
       ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [input.organizationId, input.installationId, input.runId, input.providerToolCallId, input.capability, input.capabilityVersion, input.argumentsHash, input.idempotencyKey],
    );
    return result.rows[0]!;
  }

  public async markExecuting(id: string): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'executing', updated_at = now() WHERE id = $1 AND status IN ('reserved', 'reconciled')`, [id]);
  }

  public async markExecutingByKey(organizationId: string, idempotencyKey: string): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'executing', updated_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('reserved', 'reconciled')`, [organizationId, idempotencyKey]);
  }

  public async markSucceeded(id: string, providerReceipt: unknown): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'succeeded', provider_receipt = $2::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE id = $1 AND status IN ('reserved', 'executing', 'unknown', 'reconciled')`, [id, JSON.stringify(providerReceipt ?? {})]);
  }

  public async markSucceededByKey(organizationId: string, idempotencyKey: string, providerReceipt: unknown): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'succeeded', provider_receipt = $3::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('reserved', 'executing', 'unknown', 'reconciled')`, [organizationId, idempotencyKey, JSON.stringify(providerReceipt ?? {})]);
  }

  public async markFailed(id: string, error: unknown, reconciliationRequired = false): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'failed', error = $2::jsonb, reconciliation_required = $3, updated_at = now(), completed_at = now() WHERE id = $1 AND status IN ('reserved', 'executing', 'unknown', 'reconciled')`, [id, JSON.stringify(error ?? {}), reconciliationRequired]);
  }

  public async markFailedByKey(organizationId: string, idempotencyKey: string, error: unknown, reconciliationRequired = false): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'failed', error = $3::jsonb, reconciliation_required = $4, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('reserved', 'executing', 'unknown', 'reconciled')`, [organizationId, idempotencyKey, JSON.stringify(error ?? {}), reconciliationRequired]);
  }

  public async markNotExecuted(organizationId: string, runId: string, providerToolCallId: string, error: unknown): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'failed', error = $4::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND status IN ('reserved', 'executing')`, [organizationId, runId, providerToolCallId, JSON.stringify(error ?? {})]);
  }

  public async markUnknown(id: string, error: unknown): Promise<void> {
    await query(this.pool, `UPDATE agent_effect_receipts SET status = 'unknown', error = $2::jsonb, reconciliation_required = true, updated_at = now() WHERE id = $1 AND status IN ('reserved', 'executing')`, [id, JSON.stringify(error ?? {})]);
  }

  public async reconcile(input: { organizationId: string; effectId: string; outcome: "succeeded" | "failed"; providerReceipt?: unknown; error?: unknown }): Promise<void> {
    const result = await query(this.pool, `UPDATE agent_effect_receipts SET status = $3, provider_receipt = CASE WHEN $4::jsonb = '{}'::jsonb THEN provider_receipt ELSE $4::jsonb END, error = CASE WHEN $5::jsonb = '{}'::jsonb THEN error ELSE $5::jsonb END, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'unknown'`, [input.organizationId, input.effectId, input.outcome, JSON.stringify(input.providerReceipt ?? {}), JSON.stringify(input.error ?? {})]);
    if (!result.rowCount) throw new Error("Effect is not pending reconciliation or is outside the organization");
  }

  public async pendingReconciliation(organizationId: string, limit = 100): Promise<EffectReceipt[]> {
    const result = await query<EffectReceipt>(this.pool, `SELECT * FROM agent_effect_receipts WHERE organization_id = $1 AND reconciliation_required = true ORDER BY updated_at ASC LIMIT $2`, [organizationId, Math.max(1, Math.min(limit, 500))]);
    return result.rows;
  }

  public async countPendingReconciliation(organizationId: string): Promise<number> {
    const result = await query<{ count: string }>(this.pool, `SELECT COUNT(*)::text AS count FROM agent_effect_receipts WHERE organization_id = $1 AND reconciliation_required = true`, [organizationId]);
    return Number(result.rows[0]?.count ?? 0);
  }
}
