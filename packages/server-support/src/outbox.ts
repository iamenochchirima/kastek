import type { Pool, PoolClient } from "pg";
import type {
  AnalyticsOutboxRecord,
  OutboxRow,
  ReconciliationCursor,
  OutboxReconciliationSummary,
} from "@kasitek/contracts";
import { canonicalJson } from "./json.js";
import * as sql from "./outbox-sql.js";
export type Database = Pick<Pool | PoolClient, "query">;
export type EnqueueResult =
  | { kind: "inserted"; outbox_id: string; source_sequence: string }
  | { kind: "duplicate" | "conflict"; outbox_id: string };
export type DeliveryOutcome =
  | { kind: "accepted" | "duplicate" }
  | { kind: "retryable"; error_code: string; retry_at: Date }
  | { kind: "quarantined"; error_code: string };
export async function enqueueOutbox(
  transaction: PoolClient,
  r: AnalyticsOutboxRecord,
): Promise<EnqueueResult> {
  const inserted = await transaction.query(sql.ENQUEUE_OUTBOX_0, [
    r.outbox_id,
    r.source_service,
    r.source_domain,
    r.source_stream_key,
    r.record_category,
    r.record_id,
    r.contract_name,
    r.schema_version,
    r.scope_kind,
    r.scope_external_id,
    r.idempotency_key,
    canonicalJson(r.envelope),
    r.payload_hash,
  ]);
  if (inserted.rows[0]) return { kind: "inserted", ...inserted.rows[0] };
  const existing = (
    await transaction.query(sql.ENQUEUE_OUTBOX_1, [
      r.source_service,
      r.record_category,
      r.record_id,
    ])
  ).rows[0];
  if (!existing) throw new Error("analytics outbox conflicting record missing");
  return {
    kind: existing.payload_hash === r.payload_hash ? "duplicate" : "conflict",
    outbox_id: existing.outbox_id,
  };
}
function batch(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("outbox batch size must be between 1 and 500");
}
export async function claimOutboxBatch(
  db: Database,
  publisherId: string,
  batchSize: number,
  now: Date,
  leaseMilliseconds: number,
): Promise<OutboxRow[]> {
  batch(batchSize);
  if (!publisherId.trim() || leaseMilliseconds < 0)
    throw new Error("invalid outbox lease");
  return (
    await db.query(sql.CLAIM_OUTBOX_BATCH_0, [
      now,
      batchSize,
      publisherId,
      new Date(now.getTime() + leaseMilliseconds),
    ])
  ).rows;
}
export async function releaseExpiredLeases(
  db: Database,
  now: Date,
  limit: number,
): Promise<number> {
  batch(limit);
  return (
    (await db.query(sql.RELEASE_EXPIRED_LEASES_0, [now, limit])).rowCount ?? 0
  );
}
export async function applyDeliveryOutcome(
  db: Database,
  outboxId: string,
  publisherId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  const statement =
    outcome.kind === "accepted" || outcome.kind === "duplicate"
      ? sql.APPLY_DELIVERY_OUTCOME_0
      : outcome.kind === "retryable"
        ? sql.APPLY_DELIVERY_OUTCOME_1
        : sql.APPLY_DELIVERY_OUTCOME_2;
  const values =
    outcome.kind === "retryable"
      ? [outboxId, publisherId, outcome.retry_at, outcome.error_code]
      : outcome.kind === "quarantined"
        ? [outboxId, publisherId, outcome.error_code]
        : [outboxId, publisherId];
  if ((await db.query(statement, values)).rowCount === 0)
    throw new Error(`outbox row ${outboxId} is not leased by this publisher`);
}
export async function listOutboxReconciliationSummaries(
  db: Database,
  sourceService: string,
  after: ReconciliationCursor | undefined,
  maxStreams: number,
): Promise<OutboxReconciliationSummary[]> {
  batch(maxStreams);
  if (!sourceService.trim())
    throw new Error("invalid analytics publisher configuration");
  const rows = (
    await db.query(sql.RECONCILIATION_SQL, [
      sourceService,
      after?.source_stream_key ?? null,
      after?.source_domain ?? null,
      after?.scope_kind ?? null,
      after?.scope_external_id ?? null,
      maxStreams,
    ])
  ).rows;
  return rows.map((row) => ({
    ...row,
    cursor: {
      source_stream_key: row.source_stream_key,
      source_domain: row.source_domain,
      scope_kind: row.scope_kind,
      scope_external_id: row.scope_external_id,
    },
  }));
}
