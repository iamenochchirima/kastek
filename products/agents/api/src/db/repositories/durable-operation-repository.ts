import type { Pool, PoolClient } from "pg";
import { withTransaction, query } from "../pool";
import {
  DurableOperationConflict,
  type DurableOperationIdentity,
  type DurableOperationPreparation,
  type DurableOperationRecord,
  type DurableOperationStore,
  type DurableOperationStatus,
} from "../../operations/durable-operation";

type DurableOperationRow = {
  id: string;
  organization_id: string;
  installation_id: string | null;
  run_id: string | null;
  session_key: string | null;
  kind: DurableOperationRecord["kind"];
  operation_key: string;
  request_fingerprint: string;
  status: DurableOperationStatus;
  attempt: number;
  provider_request_id: string | null;
  response_receipt: Record<string, unknown> | null;
  error: DurableOperationRecord["error"] | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function map(row: DurableOperationRow): DurableOperationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ...(row.installation_id ? { installationId: row.installation_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    kind: row.kind,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attempt: row.attempt,
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    ...(row.response_receipt ? { responseReceipt: row.response_receipt } : {}),
    ...(row.error ? { error: row.error } : {}),
    metadata: row.metadata ?? {},
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.completed_at ? { completedAt: timestamp(row.completed_at) } : {}),
  };
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function boundedJson(value: unknown, code: string): string | null {
  const serialized = json(value);
  if (serialized !== null && Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error(code);
  return serialized;
}

function identityValues(input: DurableOperationIdentity & { metadata?: Record<string, unknown> }): unknown[] {
  return [
    input.organizationId,
    input.installationId ?? null,
    input.runId ?? null,
    input.sessionKey ?? null,
    input.kind,
    input.operationKey,
    input.requestFingerprint,
    JSON.stringify(input.metadata ?? {}),
  ];
}

export class DurableOperationRepository implements DurableOperationStore {
  public constructor(private readonly pool: Pool) {}

  async prepare(input: DurableOperationIdentity & { metadata?: Record<string, unknown> }): Promise<DurableOperationPreparation> {
    if (!input.organizationId.trim() || !input.operationKey.trim() || !input.requestFingerprint.trim()) throw new Error("DURABLE_OPERATION_IDENTITY_INVALID");
    const metadata = boundedJson(input.metadata ?? {}, "DURABLE_OPERATION_METADATA_TOO_LARGE") ?? "{}";
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<DurableOperationRow>(
        `INSERT INTO agent_durable_operations
           (organization_id, installation_id, run_id, session_key, kind, operation_key, request_fingerprint, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (organization_id, operation_key) DO NOTHING
         RETURNING *`,
        [...identityValues({ ...input, metadata: input.metadata ?? {} })],
      );
      const row = inserted.rows[0] ?? (await client.query<DurableOperationRow>(
        `SELECT * FROM agent_durable_operations
         WHERE organization_id = $1 AND operation_key = $2
         FOR UPDATE`,
        [input.organizationId, input.operationKey],
      )).rows[0];
      if (!row) throw new Error("DURABLE_OPERATION_NOT_FOUND");
      const existing = map(row);
      if (existing.requestFingerprint !== input.requestFingerprint
        || existing.kind !== input.kind
        || existing.installationId !== input.installationId
        || existing.runId !== input.runId
        || existing.sessionKey !== input.sessionKey) throw new DurableOperationConflict();
      if (inserted.rows[0]) return { outcome: "new", operation: existing };
      if (existing.status === "completed") return { outcome: "completed", operation: existing };
      if (existing.status === "unknown") return { outcome: "unknown", operation: existing };
      if (existing.status === "running" || existing.status === "proposed") return { outcome: "in_progress", operation: existing };
      const restarted = await client.query<DurableOperationRow>(
        `UPDATE agent_durable_operations
         SET status = 'proposed', error = NULL, completed_at = NULL, updated_at = now(), metadata = $2::jsonb
         WHERE id = $1
         RETURNING *`,
        [existing.id, metadata],
      );
      return { outcome: "new", operation: map(restarted.rows[0]!) };
    });
  }

  async markRunning(input: { operationId: string; providerRequestId?: string }): Promise<DurableOperationRecord> {
    return this.transition(input.operationId, async (client) => {
      const result = await client.query<DurableOperationRow>(
        `UPDATE agent_durable_operations
         SET status = 'running', attempt = attempt + 1,
             provider_request_id = COALESCE($2, provider_request_id), updated_at = now()
         WHERE id = $1 AND status IN ('proposed', 'failed', 'interrupted')
         RETURNING *`,
        [input.operationId, input.providerRequestId ?? null],
      );
      if (!result.rows[0]) {
        const existing = await this.select(client, input.operationId);
        if (existing?.status === "completed") return existing;
        if (existing?.status === "unknown") throw new Error("DURABLE_OPERATION_OUTCOME_UNKNOWN");
        throw new Error("DURABLE_OPERATION_NOT_READY");
      }
      return map(result.rows[0]);
    });
  }

  async complete(input: { operationId: string; responseReceipt?: unknown }): Promise<DurableOperationRecord> {
    const receipt = boundedJson(input.responseReceipt, "DURABLE_OPERATION_RECEIPT_TOO_LARGE");
    return this.transition(input.operationId, async (client) => {
      const result = await client.query<DurableOperationRow>(
        `UPDATE agent_durable_operations
         SET status = 'completed', response_receipt = COALESCE($2::jsonb, response_receipt), error = NULL,
             completed_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('proposed', 'running', 'unknown')
         RETURNING *`,
        [input.operationId, receipt],
      );
      if (result.rows[0]) return map(result.rows[0]);
      const existing = await this.select(client, input.operationId);
      if (existing?.status === "completed") return existing;
      throw new Error("DURABLE_OPERATION_NOT_READY");
    });
  }

  async fail(input: { operationId: string; error: { code: string; message: string; retryable?: boolean } }): Promise<DurableOperationRecord> {
    const error = boundedJson(input.error, "DURABLE_OPERATION_ERROR_TOO_LARGE");
    return this.transition(input.operationId, async (client) => {
      const result = await client.query<DurableOperationRow>(
        `UPDATE agent_durable_operations
         SET status = 'failed', error = $2::jsonb, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('proposed', 'running', 'unknown', 'interrupted')
         RETURNING *`,
        [input.operationId, error],
      );
      if (result.rows[0]) return map(result.rows[0]);
      const existing = await this.select(client, input.operationId);
      if (!existing) throw new Error("DURABLE_OPERATION_NOT_FOUND");
      return existing;
    });
  }

  async interrupt(input: { operationId: string; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    return this.setTerminal(input.operationId, "interrupted", input.error);
  }

  async markUnknown(input: { operationId: string; error: { code: string; message: string } }): Promise<DurableOperationRecord> {
    return this.setTerminal(input.operationId, "unknown", input.error);
  }

  async reconcile(input: { operationId: string; outcome: "completed" | "failed"; responseReceipt?: unknown; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    const current = await this.get(input.operationId);
    if (!current || current.status !== "unknown") throw new Error("DURABLE_OPERATION_NOT_PENDING_RECONCILIATION");
    return input.outcome === "completed"
      ? this.complete({ operationId: input.operationId, responseReceipt: input.responseReceipt })
      : this.fail({ operationId: input.operationId, error: input.error ?? { code: "OPERATION_RECONCILED_FAILED", message: "Provider operation failed" } });
  }

  async get(operationId: string): Promise<DurableOperationRecord | undefined> {
    const result = await query<DurableOperationRow>(this.pool, "SELECT * FROM agent_durable_operations WHERE id = $1", [operationId]);
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }

  private async transition(operationId: string, callback: (client: PoolClient) => Promise<DurableOperationRecord>): Promise<DurableOperationRecord> {
    return withTransaction(this.pool, callback);
  }

  private async setTerminal(operationId: string, status: "interrupted" | "unknown", error?: { code: string; message: string }): Promise<DurableOperationRecord> {
    const serialized = boundedJson(error, "DURABLE_OPERATION_ERROR_TOO_LARGE");
    return this.transition(operationId, async (client) => {
      const result = await client.query<DurableOperationRow>(
        `UPDATE agent_durable_operations
         SET status = $2, error = $3::jsonb, updated_at = now()
         WHERE id = $1 AND status IN ('proposed', 'running')
         RETURNING *`,
        [operationId, status, serialized],
      );
      if (result.rows[0]) return map(result.rows[0]);
      const existing = await this.select(client, operationId);
      if (!existing) throw new Error("DURABLE_OPERATION_NOT_FOUND");
      if (existing.status === status) return existing;
      throw new Error("DURABLE_OPERATION_NOT_ACTIVE");
    });
  }

  private async select(client: PoolClient, operationId: string): Promise<DurableOperationRecord | undefined> {
    const result = await client.query<DurableOperationRow>("SELECT * FROM agent_durable_operations WHERE id = $1 FOR UPDATE", [operationId]);
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
}
