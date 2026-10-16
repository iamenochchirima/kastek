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
  createdAt: Date;
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
  public constructor(
    public readonly code:
      | "invalid_batch"
      | "lease_ownership"
      | "invalid_error_code"
      | "invalid_response"
      | "transport_unavailable"
      | "batch_rejected",
    message: string,
  ) {
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

export interface AnalyticsPublisherSettings {
  endpoint: string;
  token: string;
  producerId: string;
  publisherId: string;
  batchSize: number;
  leaseDurationMs: number;
  requestTimeoutMs: number;
  retryPolicy: RetryPolicy;
}

interface IngestionAcknowledgement {
  record_id: string;
  source_sequence: number | string;
  status: "accepted" | "duplicate" | "rejected" | "retryable";
  error_code?: string;
}

interface IngestionBatchResponse {
  acknowledgements: IngestionAcknowledgement[];
}

export interface AgentPublisherStats {
  leasesReleased: number;
  claimed: number;
  oldestQueuedAgeSeconds: number | null;
  delivered: number;
  retryable: number;
  quarantined: number;
}

type TransportFailure = {
  kind: "retryable" | "quarantined";
  errorCode: string;
};

export class AnalyticsIngestionClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;

  public constructor(settings: Pick<AnalyticsPublisherSettings, "endpoint" | "token" | "requestTimeoutMs">) {
    if (
      settings.endpoint.trim().length === 0
      || settings.token.trim().length === 0
      || !Number.isSafeInteger(settings.requestTimeoutMs)
      || settings.requestTimeoutMs < 1
    ) {
      throw new AnalyticsPublisherError("invalid_batch", "Invalid Analytics transport configuration");
    }
    this.endpoint = settings.endpoint.replace(/\/$/, "");
    this.token = settings.token;
    this.requestTimeoutMs = settings.requestTimeoutMs;
  }

  public async sendBatch(producerId: string, rows: AgentOutboxRow[]): Promise<IngestionBatchResponse> {
    const response = await fetch(`${this.endpoint}/internal/ingest/v1/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ records: rows.map((row) => ({
        producer_id: producerId,
        source_stream_key: row.sourceStreamKey,
        source_sequence: sourceSequenceNumber(row.sourceSequence),
        record_category: row.recordCategory,
        record_id: row.recordId,
        contract_name: row.contractName,
        schema_version: row.schemaVersion,
        scope_kind: row.scopeKind,
        scope_external_id: row.scopeExternalId,
        payload_hash: row.payloadHash,
        envelope: row.envelope,
      })) }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof AnalyticsPublisherError) throw error;
      throw new AnalyticsPublisherError("transport_unavailable", "Analytics ingestion request failed");
    });

    if (response.status === 401 || response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new AnalyticsPublisherError("transport_unavailable", `Analytics ingestion returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new AnalyticsPublisherError("batch_rejected", `Analytics ingestion returned HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AnalyticsPublisherError("invalid_response", "Analytics ingestion returned invalid JSON");
    }
    if (!isIngestionBatchResponse(payload)) {
      throw new AnalyticsPublisherError("invalid_response", "Analytics ingestion returned an invalid acknowledgement batch");
    }
    return payload;
  }
}

export async function publishOutboxOnce(
  pool: Pool,
  client: AnalyticsIngestionClient,
  settings: AnalyticsPublisherSettings,
  now = new Date(),
): Promise<AgentPublisherStats> {
  validatePublisherSettings(settings);
  const leasesReleased = await releaseExpiredLeases(pool, now, settings.batchSize);
  const rows = await claimOutboxBatch(pool, settings.publisherId, settings.batchSize, now, settings.leaseDurationMs);
  const stats: AgentPublisherStats = {
    leasesReleased,
    claimed: rows.length,
    oldestQueuedAgeSeconds: rows.length === 0
      ? null
      : Math.max(...rows.map((row) => Math.max(0, (now.getTime() - row.createdAt.getTime()) / 1_000))),
    delivered: 0,
    retryable: 0,
    quarantined: 0,
  };
  if (rows.length === 0) return stats;

  let outcomes: DeliveryOutcome[];
  try {
    const response = await client.sendBatch(settings.producerId, rows);
    outcomes = responseOutcomes(rows, response, now, settings.retryPolicy);
  } catch (error) {
    const failure = transportFailure(error);
    outcomes = rows.map((row) => failure.kind === "retryable"
      ? { kind: "retryable", errorCode: failure.errorCode, retryAt: settings.retryPolicy.nextRetryAt(now, row.attemptCount, row.outboxId) }
      : { kind: "quarantined", errorCode: failure.errorCode });
  }

  for (const [index, row] of rows.entries()) {
    const outcome = outcomes[index]!;
    if (outcome.kind === "accepted" || outcome.kind === "duplicate") stats.delivered += 1;
    else if (outcome.kind === "retryable") stats.retryable += 1;
    else stats.quarantined += 1;
    await applyDeliveryOutcome(pool, row.outboxId, settings.publisherId, outcome);
  }
  return stats;
}

function validatePublisherSettings(settings: AnalyticsPublisherSettings): void {
  if (
    settings.endpoint.trim().length === 0
    || settings.token.trim().length === 0
    || settings.producerId.trim().length === 0
    || settings.publisherId.trim().length === 0
    || !Number.isSafeInteger(settings.batchSize)
    || settings.batchSize < 1
    || settings.batchSize > MAX_OUTBOX_BATCH_SIZE
    || !Number.isSafeInteger(settings.leaseDurationMs)
    || settings.leaseDurationMs < 1
  ) {
    throw new AnalyticsPublisherError("invalid_batch", "Invalid Analytics publisher settings");
  }
}

function responseOutcomes(
  rows: AgentOutboxRow[],
  response: IngestionBatchResponse,
  now: Date,
  retryPolicy: RetryPolicy,
): DeliveryOutcome[] {
  const acknowledgements = new Map<string, IngestionAcknowledgement>();
  let valid = response.acknowledgements.length === rows.length;
  for (const acknowledgement of response.acknowledgements) {
    const key = sequenceKey(acknowledgement.source_sequence);
    if (key === null || acknowledgements.has(key)) valid = false;
    else acknowledgements.set(key, acknowledgement);
  }
  if (!valid) return rows.map((row) => retryOutcome(row, now, retryPolicy, "analytics.invalid_acknowledgement"));

  return rows.map((row) => {
    const acknowledgement = acknowledgements.get(sequenceKey(row.sourceSequence) ?? "");
    if (!acknowledgement || acknowledgement.record_id !== row.recordId) {
      return retryOutcome(row, now, retryPolicy, "analytics.acknowledgement_mismatch");
    }
    if (acknowledgement.status === "accepted") return { kind: "accepted" };
    if (acknowledgement.status === "duplicate") return { kind: "duplicate" };
    const errorCode = safeErrorCode(acknowledgement.error_code, acknowledgement.status === "retryable" ? "analytics.retryable_rejection" : "analytics.rejected");
    return acknowledgement.status === "retryable"
      ? retryOutcome(row, now, retryPolicy, errorCode)
      : { kind: "quarantined", errorCode };
  });
}

function retryOutcome(row: AgentOutboxRow, now: Date, retryPolicy: RetryPolicy, errorCode: string): DeliveryOutcome {
  return {
    kind: "retryable",
    errorCode: safeErrorCode(errorCode, "analytics.retryable"),
    retryAt: retryPolicy.nextRetryAt(now, row.attemptCount, row.outboxId),
  };
}

function transportFailure(error: unknown): TransportFailure {
  if (error instanceof AnalyticsPublisherError && error.code === "batch_rejected") {
    return { kind: "quarantined", errorCode: "analytics.batch_rejected" };
  }
  return { kind: "retryable", errorCode: "analytics.transport_unavailable" };
}

function sourceSequenceNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AnalyticsPublisherError("invalid_batch", "Analytics source sequence exceeds the JSON integer boundary");
  }
  return parsed;
}

function sequenceKey(value: number | string): string | null {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeErrorCode(value: string | undefined, fallback: string): string {
  return value !== undefined && /^[a-z][a-z0-9_.-]{0,127}$/.test(value) ? value : fallback;
}

function isIngestionBatchResponse(value: unknown): value is IngestionBatchResponse {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { acknowledgements?: unknown }).acknowledgements)) return false;
  return (value as { acknowledgements: unknown[] }).acknowledgements.every((acknowledgement) => {
    if (acknowledgement === null || typeof acknowledgement !== "object") return false;
    const candidate = acknowledgement as Partial<IngestionAcknowledgement>;
    return typeof candidate.record_id === "string"
      && sequenceKey(candidate.source_sequence ?? "") !== null
      && (candidate.status === "accepted" || candidate.status === "duplicate" || candidate.status === "rejected" || candidate.status === "retryable")
      && (candidate.error_code === undefined || typeof candidate.error_code === "string");
  });
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
  created_at: Date;
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
    createdAt: row.created_at,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
  };
}
