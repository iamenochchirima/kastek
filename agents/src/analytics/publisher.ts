import { createHash } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { MAX_OUTBOX_BATCH_SIZE, type AnalyticsEnvelope, type RecordCategory, type ScopeKind } from "./producer";

export interface AgentOutboxRow {
  outboxId: string;
  sourceSequence: string;
  sourceService: "agent-platform";
  sourceDomain: string;
  sourceStreamKey: string;
  recordCategory: RecordCategory;
  recordId: string;
  contractName: string;
  schemaVersion: number;
  scopeKind: ScopeKind;
  scopeExternalId: string;
  idempotencyKey: string;
  envelope: AnalyticsEnvelope;
  payloadHash: string;
  deliveryStatus: "pending" | "leased" | "delivered" | "quarantined";
  attemptCount: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export type DeliveryOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "retryable"; errorCode: string; retryAt: Date }
  | { kind: "quarantined"; errorCode: string };

export class AnalyticsPublisherError extends Error {
  public constructor(public readonly code: "invalid_batch" | "lease_ownership" | "invalid_error_code", message: string) {
    super(message);
    this.name = "AnalyticsPublisherError";
  }
}

export interface RetryPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterWindowMs?: number;
}

export class RetryPolicy {
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly jitterWindowMs: number;

  public constructor(options: RetryPolicyOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 300_000;
    this.jitterWindowMs = options.jitterWindowMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0
      || !Number.isSafeInteger(this.maxDelayMs) || this.maxDelayMs < this.baseDelayMs
      || !Number.isSafeInteger(this.jitterWindowMs) || this.jitterWindowMs < 0
    ) {
      throw new AnalyticsPublisherError("invalid_batch", "Retry policy durations must be non-negative safe integers");
    }
  }

  public nextRetryAt(now: Date, attempt: number, stableSeed: string): Date {
    const exponent = Math.min(Math.max(attempt - 1, 0), 16);
    const exponential = Math.min(this.baseDelayMs * (2 ** exponent), this.maxDelayMs);
    const jitter = this.jitterWindowMs === 0
      ? 0
      : Number.parseInt(createHash("sha256").update(`${stableSeed}:${attempt}`, "utf8").digest("hex").slice(0, 12), 16)
        % (this.jitterWindowMs + 1);
    return new Date(now.getTime() + exponential + jitter);
  }
}

interface OutboxDatabaseRow extends QueryResultRow {
  outbox_id: string;
  source_sequence: string;
  source_service: "agent-platform";
  source_domain: string;
  source_stream_key: string;
  record_category: RecordCategory;
  record_id: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  idempotency_key: string;
  envelope: AnalyticsEnvelope;
  payload_hash: string;
  delivery_status: AgentOutboxRow["deliveryStatus"];
  attempt_count: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
}

export async function claimOutboxBatch(
  pool: Pool,
  publisherId: string,
  batchSize: number,
  now = new Date(),
  leaseDurationMs = 30_000,
): Promise<AgentOutboxRow[]> {
  if (
    publisherId.trim().length === 0
    || !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > MAX_OUTBOX_BATCH_SIZE
    || !Number.isSafeInteger(leaseDurationMs)
    || leaseDurationMs < 1
  ) {
    throw new AnalyticsPublisherError("invalid_batch", "Invalid publisher batch or lease configuration");
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const result = await pool.query<OutboxDatabaseRow>(
    `WITH claimable AS (
       SELECT outbox_id
       FROM analytics_outbox
       WHERE (
         (delivery_status = 'pending' AND next_attempt_at <= $1)
         OR (delivery_status = 'leased' AND lease_expires_at <= $1)
       )
       ORDER BY source_sequence
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE analytics_outbox AS outbox
     SET delivery_status = 'leased',
         attempt_count = outbox.attempt_count + 1,
         lease_owner = $3,
         lease_expires_at = $4,
         updated_at = $1
     FROM claimable
     WHERE outbox.outbox_id = claimable.outbox_id
     RETURNING outbox.*`,
    [now, batchSize, publisherId, leaseExpiresAt],
  );
  return result.rows.map(toOutboxRow);
}

export async function releaseExpiredLeases(pool: Pool, now = new Date(), limit = MAX_OUTBOX_BATCH_SIZE): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTBOX_BATCH_SIZE) {
    throw new AnalyticsPublisherError("invalid_batch", "Invalid stale-lease recovery limit");
  }
  const result = await pool.query(
    `WITH expired AS (
       SELECT outbox_id
       FROM analytics_outbox
       WHERE delivery_status = 'leased' AND lease_expires_at <= $1
       ORDER BY source_sequence
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE analytics_outbox AS outbox
     SET delivery_status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
     FROM expired
     WHERE outbox.outbox_id = expired.outbox_id`,
    [now, limit],
  );
  return result.rowCount ?? 0;
}

export async function applyDeliveryOutcome(
  pool: Pool,
  outboxId: string,
  publisherId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  if (outboxId.trim().length === 0 || publisherId.trim().length === 0) {
    throw new AnalyticsPublisherError("lease_ownership", "Outbox and publisher identities are required");
  }
  let result;
  if (outcome.kind === "accepted" || outcome.kind === "duplicate") {
    result = await pool.query(
      `UPDATE analytics_outbox
       SET delivery_status = 'delivered', lease_owner = NULL, lease_expires_at = NULL,
           delivered_at = now(), updated_at = now()
       WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2`,
      [outboxId, publisherId],
    );
  } else if (outcome.kind === "retryable") {
    assertErrorCode(outcome.errorCode);
    result = await pool.query(
      `UPDATE analytics_outbox
       SET delivery_status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = $3, last_error_code = $4, updated_at = now()
       WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2`,
      [outboxId, publisherId, outcome.retryAt, outcome.errorCode],
    );
  } else {
    assertErrorCode(outcome.errorCode);
    result = await pool.query(
      `UPDATE analytics_outbox
       SET delivery_status = 'quarantined', lease_owner = NULL, lease_expires_at = NULL,
           quarantined_at = now(), last_error_code = $3, updated_at = now()
       WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2`,
      [outboxId, publisherId, outcome.errorCode],
    );
  }
  if (!result.rowCount) {
    throw new AnalyticsPublisherError("lease_ownership", `Outbox row ${outboxId} is not leased by this publisher`);
  }
}

function assertErrorCode(value: string): void {
  if (!/^[a-z][a-z0-9_.-]+$/.test(value)) {
    throw new AnalyticsPublisherError("invalid_error_code", "Delivery error codes must be safe lowercase identifiers");
  }
}

function toOutboxRow(row: OutboxDatabaseRow): AgentOutboxRow {
  return {
    outboxId: row.outbox_id,
    sourceSequence: row.source_sequence,
    sourceService: row.source_service,
    sourceDomain: row.source_domain,
    sourceStreamKey: row.source_stream_key,
    recordCategory: row.record_category,
    recordId: row.record_id,
    contractName: row.contract_name,
    schemaVersion: row.schema_version,
    scopeKind: row.scope_kind,
    scopeExternalId: row.scope_external_id,
    idempotencyKey: row.idempotency_key,
    envelope: row.envelope,
    payloadHash: row.payload_hash,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
  };
}
