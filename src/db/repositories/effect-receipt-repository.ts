import type { Pool, PoolClient } from "pg";
import {
  buildEffectLifecycleEvent,
  classifyAgentFailure,
  enqueueOutbox,
  type EffectAnalyticsInput,
} from "../../analytics";
import { query, withTransaction } from "../pool";

export type EffectReceiptStatus = "reserved" | "executing" | "succeeded" | "failed" | "unknown";

export interface EffectReceipt {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  provider_tool_call_id: string;
  runtime_operation_id: string;
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

export interface StaleEffectReceipt {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
}

interface PersistedEffectReceipt {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string;
  provider_tool_call_id: string;
  runtime_operation_id: string;
  capability: string;
  capability_version: string;
  arguments_hash: string;
  idempotency_key: string;
  status: EffectReceiptStatus;
  provider_receipt: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  reconciliation_required: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  agent_definition_id: string;
  agent_version_id: string;
  correlation_id: string | null;
}

export class EffectReceiptRepository {
  public constructor(private readonly pool: Pool) {}

  public async reserve(input: {
    organizationId: string;
    installationId: string;
    runId: string;
    providerToolCallId: string;
    runtimeOperationId?: string;
    capability: string;
    capabilityVersion: string;
    argumentsHash: string;
    idempotencyKey: string;
  }): Promise<EffectReceipt> {
    const runtimeOperationId = input.runtimeOperationId ?? input.providerToolCallId;
    return withTransaction(this.pool, async (client) => {
      const created = await client.query<EffectReceipt>(
        `INSERT INTO agent_effect_receipts
          (organization_id, installation_id, run_id, provider_tool_call_id, runtime_operation_id, capability,
           capability_version, arguments_hash, idempotency_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved')
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.organizationId, input.installationId, input.runId, input.providerToolCallId, runtimeOperationId, input.capability, input.capabilityVersion, input.argumentsHash, input.idempotencyKey],
      );
      const receipt = created.rows[0] ?? (await client.query<EffectReceipt>(
        `SELECT * FROM agent_effect_receipts WHERE organization_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.organizationId, input.idempotencyKey],
      )).rows[0];
      if (!receipt) throw new Error("Effect receipt could not be reserved");
      if (
        receipt.installation_id !== input.installationId
        || receipt.run_id !== input.runId
        || receipt.provider_tool_call_id !== input.providerToolCallId
        || receipt.runtime_operation_id !== runtimeOperationId
        || receipt.capability !== input.capability
        || receipt.capability_version !== input.capabilityVersion
        || receipt.arguments_hash !== input.argumentsHash
      ) {
        throw new Error("Effect idempotency key conflicts with a different invocation");
      }
      if (created.rows[0]) {
        const analyticsRow = await this.getAnalyticsRow(client, receipt.id);
        await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(analyticsRow, "reserved")));
      }
      return receipt;
    });
  }

  public async markExecuting(id: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'executing', updated_at = now() WHERE id = $1 AND status = 'reserved' RETURNING id`, [id]);
      if (!result.rowCount) throw new Error("Effect is not reserved for execution; blind retry is prohibited");
      const row = await this.getAnalyticsRow(client, id);
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "executing")));
    });
  }

  public async markExecutingByKey(organizationId: string, idempotencyKey: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'executing', updated_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status = 'reserved' RETURNING id`, [organizationId, idempotencyKey]);
      if (!result.rowCount) throw new Error("Effect is not reserved for execution; blind retry is prohibited");
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "executing")));
    });
  }

  public async markSucceeded(id: string, providerReceipt: unknown): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'succeeded', provider_receipt = $2::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE id = $1 AND status IN ('reserved', 'executing', 'unknown') RETURNING id`, [id, JSON.stringify(providerReceipt ?? {})]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, id);
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "succeeded")));
    });
  }

  public async markSucceededByKey(organizationId: string, idempotencyKey: string, providerReceipt: unknown): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'succeeded', provider_receipt = $3::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('reserved', 'executing', 'unknown') RETURNING id`, [organizationId, idempotencyKey, JSON.stringify(providerReceipt ?? {})]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "succeeded")));
    });
  }

  public async markFailed(id: string, error: unknown, reconciliationRequired = false): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'failed', error = $2::jsonb, reconciliation_required = $3, updated_at = now(), completed_at = now() WHERE id = $1 AND status IN ('reserved', 'executing', 'unknown') RETURNING id`, [id, JSON.stringify(error ?? {}), reconciliationRequired]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, id);
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "failed")));
    });
  }

  public async markFailedByKey(organizationId: string, idempotencyKey: string, error: unknown, reconciliationRequired = false): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'failed', error = $3::jsonb, reconciliation_required = $4, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('reserved', 'executing', 'unknown') RETURNING id`, [organizationId, idempotencyKey, JSON.stringify(error ?? {}), reconciliationRequired]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "failed")));
    });
  }

  public async markNotExecuted(organizationId: string, runId: string, providerToolCallId: string, error: unknown, runtimeOperationId?: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'failed', error = $4::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND run_id = $2 AND provider_tool_call_id = $3 AND runtime_operation_id = COALESCE($5, provider_tool_call_id) AND status = 'reserved' RETURNING id`, [organizationId, runId, providerToolCallId, JSON.stringify(error ?? {}), runtimeOperationId ?? null]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "failed")));
    });
  }

  public async markNotExecutedByKey(organizationId: string, idempotencyKey: string, error: unknown): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'failed', error = $3::jsonb, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status = 'reserved' RETURNING id`, [organizationId, idempotencyKey, JSON.stringify(error ?? {})]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "failed")));
    });
  }

  public async markUnknown(id: string, error: unknown): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'unknown', error = $2::jsonb, reconciliation_required = true, updated_at = now() WHERE id = $1 AND status = 'executing' RETURNING id`, [id, JSON.stringify(error ?? {})]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, id);
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "unknown")));
    });
  }

  public async markUnknownByKey(organizationId: string, idempotencyKey: string, error: unknown): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = 'unknown', error = $3::jsonb, reconciliation_required = true, updated_at = now() WHERE organization_id = $1 AND idempotency_key = $2 AND status = 'executing' RETURNING id`, [organizationId, idempotencyKey, JSON.stringify(error ?? {})]);
      if (!result.rowCount) return;
      const row = await this.getAnalyticsRow(client, String(result.rows[0].id));
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "unknown")));
    });
  }

  public async markStaleExecutingUnknown(maxAgeSeconds = 120, limit = 100): Promise<StaleEffectReceipt[]> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<StaleEffectReceipt & { updated_at: Date | string }>(
        `WITH stale AS (
           SELECT id
           FROM agent_effect_receipts
           WHERE status = 'executing'
             AND updated_at <= now() - make_interval(secs => $1::integer)
           ORDER BY updated_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE agent_effect_receipts AS receipt
         SET status = 'unknown',
             error = '{"code":"EFFECT_OUTCOME_UNKNOWN","message":"Provider outcome was not recorded before the execution lease expired"}'::jsonb,
             reconciliation_required = true,
             updated_at = now()
         FROM stale
         WHERE receipt.id = stale.id
           AND receipt.status = 'executing'
         RETURNING receipt.id, receipt.organization_id, receipt.installation_id, receipt.run_id, receipt.updated_at`,
        [Math.max(1, Math.min(maxAgeSeconds, 86_400)), Math.max(1, Math.min(limit, 500))],
      );
      for (const receipt of result.rows) {
        const row = await this.getAnalyticsRow(client, receipt.id);
        await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "unknown")));
      }
      return result.rows.map(({ id, organization_id, installation_id, run_id }) => ({ id, organization_id, installation_id, run_id }));
    });
  }

  public async reconcile(input: { organizationId: string; effectId: string; outcome: "succeeded" | "failed"; providerReceipt?: unknown; error?: unknown }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE agent_effect_receipts SET status = $3, provider_receipt = CASE WHEN $4::jsonb = '{}'::jsonb THEN provider_receipt ELSE $4::jsonb END, error = CASE WHEN $5::jsonb = '{}'::jsonb THEN error ELSE $5::jsonb END, reconciliation_required = false, updated_at = now(), completed_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'unknown' RETURNING id`, [input.organizationId, input.effectId, input.outcome, JSON.stringify(input.providerReceipt ?? {}), JSON.stringify(input.error ?? {})]);
      if (!result.rowCount) throw new Error("Effect is not pending reconciliation or is outside the organization");
      const row = await this.getAnalyticsRow(client, input.effectId);
      await enqueueOutbox(client, buildEffectLifecycleEvent(this.analyticsInput(row, "reconciled")));
    });
  }

  public async pendingReconciliation(organizationId: string, limit = 100): Promise<EffectReceipt[]> {
    const result = await query<EffectReceipt>(this.pool, `SELECT * FROM agent_effect_receipts WHERE organization_id = $1 AND reconciliation_required = true ORDER BY updated_at ASC LIMIT $2`, [organizationId, Math.max(1, Math.min(limit, 500))]);
    return result.rows;
  }

  public async countPendingReconciliation(organizationId: string): Promise<number> {
    const result = await query<{ count: string }>(this.pool, `SELECT COUNT(*)::text AS count FROM agent_effect_receipts WHERE organization_id = $1 AND reconciliation_required = true`, [organizationId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  public async listForRun(organizationId: string, runId: string): Promise<EffectReceipt[]> {
    const result = await query<EffectReceipt>(this.pool, `SELECT * FROM agent_effect_receipts WHERE organization_id = $1 AND run_id = $2 ORDER BY created_at ASC`, [organizationId, runId]);
    return result.rows;
  }

  private async getAnalyticsRow(client: PoolClient, effectId: string): Promise<PersistedEffectReceipt> {
    const result = await client.query<PersistedEffectReceipt>(
      `SELECT er.*, ar.agent_definition_id, ar.agent_version_id, ar.correlation_id
       FROM agent_effect_receipts er
       JOIN agent_runs ar ON ar.id = er.run_id
       WHERE er.id = $1
       FOR UPDATE OF er`,
      [effectId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("EFFECT_RECEIPT_NOT_FOUND");
    return row;
  }

  private analyticsInput(
    row: PersistedEffectReceipt,
    action: EffectAnalyticsInput["action"],
  ): EffectAnalyticsInput {
    return {
      organizationId: row.organization_id,
      runId: row.run_id,
      agentDefinitionId: row.agent_definition_id,
      agentVersionId: row.agent_version_id,
      installationId: row.installation_id,
      correlationId: row.correlation_id,
      effectId: row.id,
      providerToolCallId: row.provider_tool_call_id,
      capability: row.capability,
      capabilityVersion: row.capability_version,
      action,
      status: row.status,
      reconciliationRequired: row.reconciliation_required,
      failureClass: row.error && (row.status === "failed" || row.status === "unknown") ? classifyAgentFailure(row.error) : null,
      occurredAt: action === "reserved" ? row.created_at : row.updated_at,
      completedAt: row.completed_at,
    };
  }
}
