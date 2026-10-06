import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import type { AnalyticsContext } from "./context.js";
import {
  IngestionAuthenticator,
  strictObject,
  dtoString,
  dtoI64,
  resolveScope,
  ValidationFailure,
  asObject,
  asI64,
  type AuthenticatedProducer,
} from "./ingestion.js";
import {
  validateSha256Hex,
  timestampNanos,
  type ScopeBinding,
} from "./records.js";
import { enqueueReconciliationRepair } from "./projections.js";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { SQL } from "./reconciliation-sql.js";
export const RECONCILIATION_PATH = "/internal/reconciliation/v1/summary";
export interface ReconciliationRequest {
  reconciliation_run_id: string;
  reconciliation_work_id?: bigint | null;
  producer_id: string;
  source_domain: string;
  source_stream_key: string;
  scope_kind?: string | null;
  scope_external_id?: string | null;
  source_highest_outbox_sequence?: bigint | null;
  source_highest_delivered_sequence?: bigint | null;
  authoritative_count?: bigint | null;
  authoritative_checksum?: string | null;
}
export interface ReconciliationResponse {
  reconciliation_run_id: string;
  reconciliation_work_id?: bigint;
  reconciliation_status: string;
  analytics_highest_received_sequence: bigint;
  analytics_highest_contiguous_sequence: bigint;
  missing_sequence_ranges: unknown;
  unresolved_quarantine_count: bigint;
  analytics_count: bigint;
}
export class ReconciliationError extends Error {
  constructor(
    public code: string,
    public unavailable = false,
  ) {
    super(code);
  }
}
export async function reconcileStream(
  pool: Pool,
  a: AuthenticatedProducer,
  r: ReconciliationRequest,
): Promise<ReconciliationResponse> {
  if (
    r.producer_id !== a.producer_id ||
    !r.reconciliation_run_id.trim() ||
    (r.reconciliation_work_id != null && r.reconciliation_work_id <= 0n) ||
    !r.source_domain.trim() ||
    !r.source_stream_key.trim() ||
    [
      r.source_highest_outbox_sequence,
      r.source_highest_delivered_sequence,
      r.authoritative_count,
    ].some((n) => n != null && n < 0n)
  )
    throw new ReconciliationError("invalid_reconciliation_request");
  if (r.authoritative_checksum != null)
    try {
      validateSha256Hex(r.authoritative_checksum);
    } catch {
      throw new ReconciliationError("invalid_authoritative_checksum");
    }
  if ((r.scope_kind != null) !== (r.scope_external_id != null))
    throw new ReconciliationError("incomplete_scope_binding");
  let tx: PoolClient | undefined,
    committed = false,
    binding: ScopeBinding | null = null;
  try {
    tx = await pool.connect();
    await tx.query("BEGIN");
    const producer = (await tx.query(SQL.reconcile_stream, [r.producer_id]))
      .rows[0];
    if (!producer) throw new ReconciliationError("producer_not_registered");
    if (!producer.active || producer.source_service !== a.source_service)
      throw new ReconciliationError("producer_not_authorized");
    if (
      r.reconciliation_work_id != null &&
      !(
        await tx.query(SQL.reconcile_stream_2, [
          r.reconciliation_work_id,
          r.producer_id,
          a.source_service,
          r.source_stream_key,
        ])
      ).rows[0]?.exists
    )
      throw new ReconciliationError("reconciliation_work_not_authorized");
    if (r.scope_kind != null && r.scope_external_id != null)
      try {
        binding = (await resolveScope(tx, a, r.scope_kind, r.scope_external_id))
          .binding;
      } catch (error) {
        throw new ReconciliationError(
          error instanceof ValidationFailure
            ? error.code
            : "analytics_unavailable",
        );
      }
    const cursor = (
      await tx.query(SQL.reconcile_stream_3, [
        r.producer_id,
        r.source_stream_key,
      ])
    ).rows[0];
    const received = BigInt(cursor?.highest_received_sequence ?? 0),
      contiguous = BigInt(cursor?.highest_contiguous_sequence ?? 0);
    let ranges: unknown = cursor?.known_gap_ranges ?? [];
    if (
      r.source_highest_delivered_sequence != null &&
      r.source_highest_delivered_sequence > received &&
      Array.isArray(ranges)
    )
      ranges = [
        ...ranges,
        { start: received + 1n, end: r.source_highest_delivered_sequence },
      ];
    const count = BigInt(
        (
          await tx.query(SQL.count_stream_facts, [
            r.producer_id,
            r.source_stream_key,
          ])
        ).rows[0]!.count,
      ),
      quarantine = BigInt(
        (
          await tx.query(SQL.reconcile_stream_4, [
            r.producer_id,
            r.source_stream_key,
          ])
        ).rows[0]!.count,
      );
    const countMismatch =
        r.authoritative_count != null && r.authoritative_count !== count,
      hasGap = Array.isArray(ranges) && ranges.length > 0,
      status =
        countMismatch || hasGap || quarantine > 0n ? "mismatch" : "complete",
      safe = countMismatch
        ? "authoritative_count_mismatch"
        : hasGap
          ? "source_sequence_gap"
          : quarantine > 0n
            ? "unresolved_quarantine"
            : null,
      now = new Date().toISOString();
    const inserted = await tx.query(SQL.reconcile_stream_5, [
      r.reconciliation_run_id,
      r.producer_id,
      a.source_service,
      r.source_domain,
      r.source_stream_key,
      binding?.reporting_scope_id ?? null,
      binding?.root_scope_id ?? null,
      r.source_highest_outbox_sequence ?? null,
      r.source_highest_delivered_sequence ?? null,
      received,
      contiguous,
      canonicalJson(ranges),
      quarantine,
      r.authoritative_count ?? null,
      count,
      r.authoritative_checksum ?? null,
      status,
      safe,
      now,
    ]);
    if ((inserted.rowCount ?? 0) > 0 && binding) {
      const w = (
        await tx.query(SQL.reconciliation_fact_window, [
          r.producer_id,
          r.source_stream_key,
          r.source_domain,
        ])
      ).rows[0]!;
      if (
        w.window_start != null &&
        w.window_end != null &&
        timestampNanos(w.window_end) > timestampNanos(w.window_start)
      ) {
        const start = w.window_start.toISOString(),
          end = w.window_end.toISOString(),
          expected = r.authoritative_count ?? null,
          included = expected !== null && expected < count ? expected : count,
          excluded =
            expected !== null && expected > count ? expected - count : 0n;
        await tx.query(SQL.insert_reconciliation_coverage_checkpoint, [
          r.producer_id,
          a.source_service,
          r.source_domain,
          binding.reporting_scope_id,
          binding.root_scope_id,
          start,
          end,
          expected,
          included,
          excluded,
          status === "complete" ? "available" : "partial",
          status === "complete" ? end : null,
          r.reconciliation_run_id,
          now,
        ]);
      }
    }
    await tx.query(SQL.reconcile_stream_6, [
      r.producer_id,
      r.source_stream_key,
    ]);
    if (r.reconciliation_work_id != null)
      await tx.query(SQL.reconcile_stream_7, [
        r.reconciliation_work_id,
        safe,
        a.producer_id,
      ]);
    await tx.query("COMMIT");
    committed = true;
    if (status === "mismatch" && binding)
      await enqueueReconciliationRepair(
        pool,
        r.producer_id,
        r.source_stream_key,
        binding.reporting_scope_id,
        binding.root_scope_id,
      );
    return {
      reconciliation_run_id: r.reconciliation_run_id,
      ...(r.reconciliation_work_id != null
        ? { reconciliation_work_id: r.reconciliation_work_id }
        : {}),
      reconciliation_status: status,
      analytics_highest_received_sequence: received,
      analytics_highest_contiguous_sequence: contiguous,
      missing_sequence_ranges: ranges,
      unresolved_quarantine_count: quarantine,
      analytics_count: count,
    };
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    throw new ReconciliationError("analytics_unavailable", true);
  } finally {
    if (tx) {
      if (!committed)
        try {
          await tx.query("ROLLBACK");
        } catch {}
      tx.release();
    }
  }
}
export function parseReconciliationRequest(
  value: unknown,
): ReconciliationRequest {
  const body = strictObject(value, [
    "reconciliation_run_id",
    "reconciliation_work_id",
    "producer_id",
    "source_domain",
    "source_stream_key",
    "scope_kind",
    "scope_external_id",
    "source_highest_outbox_sequence",
    "source_highest_delivered_sequence",
    "authoritative_count",
    "authoritative_checksum",
  ]);
  return {
    reconciliation_run_id: dtoString(body, "reconciliation_run_id")!,
    reconciliation_work_id: dtoI64(body, "reconciliation_work_id", true),
    producer_id: dtoString(body, "producer_id")!,
    source_domain: dtoString(body, "source_domain")!,
    source_stream_key: dtoString(body, "source_stream_key")!,
    scope_kind: dtoString(body, "scope_kind", true),
    scope_external_id: dtoString(body, "scope_external_id", true),
    source_highest_outbox_sequence: dtoI64(
      body,
      "source_highest_outbox_sequence",
      true,
    ),
    source_highest_delivered_sequence: dtoI64(
      body,
      "source_highest_delivered_sequence",
      true,
    ),
    authoritative_count: dtoI64(body, "authoritative_count", true),
    authoritative_checksum: dtoString(body, "authoritative_checksum", true),
  };
}
export function registerReconciliationRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
): void {
  const auth = new IngestionAuthenticator(context.config.ingestion_credentials);
  app.post(RECONCILIATION_PATH, async (request, reply) => {
    const body = parseReconciliationRequest(request.body);
    let producer: AuthenticatedProducer;
    try {
      producer = auth.authenticate(request);
    } catch {
      return reply.code(401).header("www-authenticate", "Bearer").send();
    }
    try {
      return await reconcileStream(context.pool, producer, body);
    } catch (error) {
      if (!(error instanceof ReconciliationError)) throw error;
      return reply
        .code(error.unavailable ? 503 : 400)
        .send({ error: error.code });
    }
  });
}
