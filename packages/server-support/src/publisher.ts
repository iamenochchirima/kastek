import { randomUUID } from "node:crypto";
import type {
  OutboxRow,
  BackfillRecord,
  BackfillBatchResponse,
  SourceBackfillWork,
  ReconciliationRequest,
  ReconciliationResponse,
  ReconciliationCursor,
} from "@kasitek/contracts";
import {
  canonicalJson,
  parseLosslessJson,
  integer,
  wireInteger,
} from "./json.js";
import { nextRetryAt, backfillSourceSequence } from "./analytics-producer.js";
import {
  claimOutboxBatch,
  releaseExpiredLeases,
  applyDeliveryOutcome,
  listOutboxReconciliationSummaries,
} from "./outbox.js";
import type { Database, DeliveryOutcome } from "./outbox.js";
import {
  injectTraceContext,
  providerResultSpan,
  recordQueueAge,
  recordRetry,
} from "./telemetry.js";
export const BACKFILL_WORK_PATH = "/internal/backfill/v1/work",
  MAX_RECONCILIATION_STREAMS = 500;
export class PublisherError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = true,
  ) {
    super(code);
  }
}
export interface AnalyticsPublisherSettings {
  endpoint: string;
  token: string;
  producer_id: string;
  publisher_id: string;
  batch_size: number;
  lease_duration_ms: number;
  request_timeout_ms: number;
}
const safeCode = (v: string | undefined | null, fallback: string): string =>
  v && /^[a-z0-9._-]{1,128}$/.test(v) ? v : fallback;
function ingestionRecord(
  producerId: string,
  row: OutboxRow | BackfillRecord["record"],
  sequence: OutboxRow["source_sequence"],
) {
  return {
    producer_id: producerId,
    source_stream_key: row.source_stream_key,
    source_sequence: wireInteger(sequence),
    record_category: row.record_category,
    record_id: row.record_id,
    contract_name: row.contract_name,
    schema_version: row.schema_version,
    scope_kind: row.scope_kind,
    scope_external_id: row.scope_external_id,
    payload_hash: row.payload_hash,
    envelope: row.envelope,
  };
}
export class AnalyticsIngestionClient {
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly requestTimeoutMilliseconds = 10000,
  ) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    if (
      !this.endpoint.trim() ||
      !token.trim() ||
      requestTimeoutMilliseconds <= 0
    )
      throw new PublisherError("invalid analytics publisher configuration");
    new URL(this.endpoint);
  }
  private async request<T>(
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    return providerResultSpan("kasitek-analytics", path, async () => {
      const headers = new Headers({ authorization: `Bearer ${this.token}` });
      injectTraceContext(headers);
      if (body !== undefined) headers.set("content-type", "application/json");
      let response: Response;
      try {
        response = await fetch(this.endpoint + path, {
          method: body === undefined ? "GET" : "POST",
          headers,
          body: body === undefined ? undefined : canonicalJson(body),
          signal: AbortSignal.timeout(this.requestTimeoutMilliseconds),
          redirect: "manual",
        });
      } catch {
        throw new PublisherError("analytics.transport_unavailable");
      }
      if (response.status === 204) return undefined;
      if (!response.ok) {
        const retryable =
          [408, 429, 401, 403].includes(response.status) ||
          response.status >= 500;
        throw new PublisherError(
          retryable
            ? "analytics.http_unavailable"
            : `analytics.http_${response.status}`,
          retryable,
        );
      }
      try {
        return parseLosslessJson(await response.text()) as T;
      } catch {
        throw new PublisherError("analytics.invalid_response");
      }
    });
  }
  async sendBatch(
    producerId: string,
    rows: OutboxRow[],
  ): Promise<BackfillBatchResponse> {
    const response = await this.request<BackfillBatchResponse>(
      "/internal/ingest/v1/batch",
      {
        records: rows.map((row) =>
          ingestionRecord(producerId, row, row.source_sequence),
        ),
      },
    );
    if (!response) throw new PublisherError("analytics.invalid_response");
    return response;
  }
  async sendReconciliation(
    request: ReconciliationRequest,
  ): Promise<ReconciliationResponse> {
    const response = await this.request<ReconciliationResponse>(
      "/internal/reconciliation/v1/summary",
      request,
    );
    if (!response) throw new PublisherError("analytics.invalid_response");
    return response;
  }
  async claimSourceBackfillWork(): Promise<SourceBackfillWork | undefined> {
    return this.request(BACKFILL_WORK_PATH);
  }
  async sendBackfillBatch(
    producerId: string,
    jobId: string,
    records: BackfillRecord[],
  ): Promise<BackfillBatchResponse> {
    if (
      !producerId.trim() ||
      !jobId.trim() ||
      records.length === 0 ||
      records.length > 500 ||
      records.some(
        (r) =>
          integer(r.source_sequence) !==
          backfillSourceSequence(r.record.record_id),
      )
    )
      throw new PublisherError("invalid analytics publisher configuration");
    const response = await this.request<BackfillBatchResponse>(
      "/internal/ingest/v1/batch",
      {
        records: records.map((r) =>
          ingestionRecord(producerId, r.record, r.source_sequence),
        ),
        backfill_job_id: jobId,
      },
    );
    if (!response) throw new PublisherError("analytics.invalid_response");
    validateBackfillResponse(records, response);
    return response;
  }
}
export function validateBackfillResponse(
  records: BackfillRecord[],
  response: BackfillBatchResponse,
): void {
  const expected = new Map(
    records.map((r) => [
      integer(r.source_sequence).toString(),
      r.record.record_id,
    ]),
  );
  const seen = new Set<string>();
  const counts = [0, 0, 0, 0];
  if (
    expected.size !== records.length ||
    !Array.isArray(response.acknowledgements) ||
    response.acknowledgements.length !== records.length
  )
    throw new PublisherError("analytics.invalid_acknowledgement");
  for (const ack of response.acknowledgements) {
    const seq = integer(ack.source_sequence).toString(),
      index = ["accepted", "duplicate", "rejected", "retryable"].indexOf(
        ack.status,
      );
    if (expected.get(seq) !== ack.record_id || seen.has(seq) || index < 0)
      throw new PublisherError("analytics.invalid_acknowledgement");
    seen.add(seq);
    counts[index] = counts[index]! + 1;
  }
  if (
    counts.some(
      (count, i) =>
        count !==
        [
          response.accepted_count,
          response.duplicate_count,
          response.rejected_count,
          response.retryable_count,
        ][i],
    )
  )
    throw new PublisherError("analytics.invalid_acknowledgement");
}
export function responseOutcomes(
  rows: OutboxRow[],
  response: BackfillBatchResponse,
  now: Date,
): DeliveryOutcome[] {
  const retry = (row: OutboxRow, code: string): DeliveryOutcome => ({
    kind: "retryable",
    error_code: code,
    retry_at: nextRetryAt(now, row.attempt_count, row.outbox_id),
  });
  if (
    !Array.isArray(response.acknowledgements) ||
    response.acknowledgements.length !== rows.length
  )
    return rows.map((row) => retry(row, "analytics.invalid_acknowledgement"));
  const acks = new Map(
    response.acknowledgements.map((ack) => [
      integer(ack.source_sequence).toString(),
      ack,
    ]),
  );
  if (acks.size !== rows.length)
    return rows.map((row) => retry(row, "analytics.invalid_acknowledgement"));
  return rows.map((row) => {
    const ack = acks.get(integer(row.source_sequence).toString());
    if (!ack) return retry(row, "analytics.missing_acknowledgement");
    if (ack.record_id !== row.record_id)
      return retry(row, "analytics.acknowledgement_mismatch");
    switch (ack.status) {
      case "accepted":
        return { kind: "accepted" };
      case "duplicate":
        return { kind: "duplicate" };
      case "rejected":
        return {
          kind: "quarantined",
          error_code: safeCode(ack.error_code, "analytics.rejected"),
        };
      case "retryable":
        return retry(
          row,
          safeCode(ack.error_code, "analytics.retryable_rejection"),
        );
      default:
        return retry(row, "analytics.invalid_acknowledgement");
    }
  });
}
export async function publishOutboxOnce(
  db: Database,
  client: AnalyticsIngestionClient,
  settings: AnalyticsPublisherSettings,
  now = new Date(),
) {
  if (
    !settings.endpoint.trim() ||
    !settings.token.trim() ||
    !settings.producer_id.trim() ||
    !settings.publisher_id.trim() ||
    !Number.isInteger(settings.batch_size) ||
    settings.batch_size < 1 ||
    settings.batch_size > 500 ||
    settings.lease_duration_ms <= 0 ||
    settings.request_timeout_ms <= 0
  )
    throw new PublisherError("invalid analytics publisher configuration");
  const leases_released = await releaseExpiredLeases(
      db,
      now,
      settings.batch_size,
    ),
    rows = await claimOutboxBatch(
      db,
      settings.publisher_id,
      settings.batch_size,
      now,
      settings.lease_duration_ms,
    );
  const stats = {
    leases_released,
    claimed: rows.length,
    delivered: 0,
    retryable: 0,
    quarantined: 0,
  };
  if (!rows.length) return stats;
  recordQueueAge(
    "analytics.outbox",
    Math.max(
      0,
      (now.getTime() -
        Math.min(...rows.map((r) => new Date(r.created_at).getTime()))) /
        1000,
    ),
  );
  let outcomes: DeliveryOutcome[];
  try {
    outcomes = responseOutcomes(
      rows,
      await client.sendBatch(settings.producer_id, rows),
      now,
    );
  } catch (error) {
    const err =
      error instanceof PublisherError
        ? error
        : new PublisherError("analytics.invalid_response");
    outcomes = rows.map((row) =>
      err.retryable
        ? {
            kind: "retryable",
            error_code: err.code,
            retry_at: nextRetryAt(now, row.attempt_count, row.outbox_id),
          }
        : { kind: "quarantined", error_code: err.code },
    );
  }
  for (const [index, row] of rows.entries()) {
    const outcome = outcomes[index]!;
    if (outcome.kind === "accepted" || outcome.kind === "duplicate")
      stats.delivered++;
    else if (outcome.kind === "retryable") stats.retryable++;
    else stats.quarantined++;
    await applyDeliveryOutcome(
      db,
      row.outbox_id,
      settings.publisher_id,
      outcome,
    );
  }
  if (stats.retryable)
    recordRetry("worker", "analytics_outbox.delivery", stats.retryable);
  return stats;
}
export async function reconcileOutboxOnce(
  db: Database,
  client: AnalyticsIngestionClient,
  producerId: string,
  sourceService: string,
  after: ReconciliationCursor | undefined,
  maxStreams: number,
) {
  if (!producerId.trim())
    throw new PublisherError("invalid analytics publisher configuration");
  const stats: {
    attempted: number;
    complete: number;
    mismatched: number;
    next_cursor?: ReconciliationCursor;
  } = { attempted: 0, complete: 0, mismatched: 0 };
  for (const { cursor, ...summary } of await listOutboxReconciliationSummaries(
    db,
    sourceService,
    after,
    maxStreams,
  )) {
    const response = await client.sendReconciliation({
      ...summary,
      source_highest_outbox_sequence: wireInteger(
        summary.source_highest_outbox_sequence,
      ),
      source_highest_delivered_sequence:
        summary.source_highest_delivered_sequence == null
          ? null
          : wireInteger(summary.source_highest_delivered_sequence),
      authoritative_count: wireInteger(summary.authoritative_count),
      reconciliation_run_id: randomUUID(),
      producer_id: producerId,
    });
    stats.attempted++;
    if (response.reconciliation_status === "mismatch") stats.mismatched++;
    else stats.complete++;
    stats.next_cursor = cursor;
  }
  return stats;
}
