import type { FastifyInstance } from "fastify";
import type { Pool, QueryResultRow } from "pg";
import type { AnalyticsContext } from "./context.js";
import type { RegistrySnapshot } from "./registry-types.js";
import type { AuthenticatedProducer } from "./ingestion.js";
import { IngestionAuthenticator } from "./ingestion.js";
import { transaction } from "./db.js";
import { apiJson } from "./json.js";
import type { ResultSpanMetrics } from "./metrics.js";
import { SQL } from "./maintenance-sql.js";
import { requestRebuild, enqueueReplayRange } from "./projections.js";
export const RECONCILIATION_WORK_PATH = "/internal/reconciliation/v1/work",
  QUARANTINE_WORK_PATH = "/internal/quarantine/v1/work",
  BACKFILL_WORK_PATH = "/internal/backfill/v1/work";
export interface ReconciliationWork {
  work_id: bigint;
  producer_id: string;
  source_service: string;
  source_domain: string;
  source_stream_key: string;
  reporting_scope_id: bigint | null;
  root_scope_id: bigint | null;
  reason: string;
  priority: number;
  attempt_count: number;
  lease_expires_at: Date;
}
export interface QuarantineReleaseWork {
  work_id: bigint;
  failure_id: bigint;
  producer_id: string;
  source_service: string;
  source_domain: string;
  source_stream_key: string;
  source_sequence: bigint | null;
  record_category: string;
  record_identity: string;
  schema_version: number | null;
  payload_hash: string | null;
  reporting_scope_id: bigint | null;
  root_scope_id: bigint | null;
  safe_error_code: string;
  attempt_count: number;
  lease_expires_at: Date;
}
export interface BackfillWork {
  job_id: string;
  source_service: string;
  source_domain: string;
  reporting_scope_id: bigint;
  root_scope_id: bigint;
  scope_external_id: string;
  requested_range_start: Date;
  requested_range_end: Date;
  contract_version: string;
  projection_version: string | null;
  method: string;
  job_status: string;
  checkpoint: unknown;
  remaining_count: bigint | null;
  lease_expires_at: Date;
}
const ids = (row: QueryResultRow, keys: string[]) => ({
  ...row,
  ...Object.fromEntries(
    keys.map((key) => [key, row[key] == null ? null : BigInt(row[key])]),
  ),
});
function backfill(row: QueryResultRow): BackfillWork {
  if (typeof row.scope_external_id !== "string")
    throw Error("invalid backfill scope external id");
  return ids(row, [
    "reporting_scope_id",
    "root_scope_id",
    "remaining_count",
  ]) as unknown as BackfillWork;
}
export async function claimReconciliationWork(
  pool: Pool,
  authenticated: AuthenticatedProducer,
  lease: number | bigint,
): Promise<ReconciliationWork | null> {
  const row = (
    await pool.query(SQL.claim_reconciliation_work_0, [
      authenticated.producer_id,
      authenticated.source_service,
      authenticated.producer_id,
      lease,
    ])
  ).rows[0];
  return row
    ? (ids(row, [
        "work_id",
        "reporting_scope_id",
        "root_scope_id",
      ]) as unknown as ReconciliationWork)
    : null;
}
export async function claimQuarantineReleaseWork(
  pool: Pool,
  authenticated: AuthenticatedProducer,
  lease: number | bigint,
): Promise<QuarantineReleaseWork | null> {
  return transaction(pool, async (tx) => {
    const row = (
      await tx.query(SQL.claim_quarantine_release_work_0, [
        authenticated.producer_id,
        authenticated.source_service,
        authenticated.producer_id,
        lease,
      ])
    ).rows[0];
    if (!row) return null;
    const failure = (
      await tx.query(SQL.claim_quarantine_release_work_1, [
        row.failure_id,
        authenticated.producer_id,
        authenticated.source_service,
      ])
    ).rows[0];
    if (!failure) return null;
    return ids({ ...row, ...failure }, [
      "work_id",
      "failure_id",
      "source_sequence",
      "reporting_scope_id",
      "root_scope_id",
    ]) as unknown as QuarantineReleaseWork;
  });
}
export async function claimSourceBackfillWork(
  pool: Pool,
  authenticated: AuthenticatedProducer,
  lease: number | bigint,
): Promise<BackfillWork | null> {
  const row = (
    await pool.query(SQL.claim_source_backfill_work_0, [
      authenticated.source_service,
      authenticated.producer_id,
      lease,
    ])
  ).rows[0];
  return row ? backfill(row) : null;
}
export async function scheduleWork(pool: Pool) {
  const reconciliation = await pool.query(SQL.schedule_work_0),
    quarantine = await pool.query(SQL.schedule_work_1);
  return {
    reconciliation_work_created: BigInt(reconciliation.rowCount ?? 0),
    quarantine_work_created: BigInt(quarantine.rowCount ?? 0),
  };
}
export async function claimWorkerBackfillWork(
  pool: Pool,
  worker: string,
  lease: number | bigint,
): Promise<BackfillWork | null> {
  const row = (
    await pool.query(SQL.claim_worker_backfill_work_0, [worker, lease])
  ).rows[0];
  return row ? backfill(row) : null;
}
function checkpointId(value: unknown): bigint | null {
  if (
    typeof value === "bigint" &&
    value >= -9223372036854775808n &&
    value <= 9223372036854775807n
  )
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  return null;
}
export async function processBackfillOnce(
  pool: Pool,
  registry: RegistrySnapshot,
  worker: string,
  lease: number | bigint,
) {
  const work = await claimWorkerBackfillWork(pool, worker, lease);
  if (!work) return false;
  try {
    let checkpoint: unknown,
      waiting = false;
    if (work.method === "projection_rebuild") {
      const existing =
        work.checkpoint !== null && typeof work.checkpoint === "object"
          ? (work.checkpoint as Record<string, unknown>).generation_id
          : null;
      const id =
        checkpointId(existing) ??
        (await requestRebuild(
          pool,
          work.reporting_scope_id,
          work.root_scope_id,
          worker,
          registry.sha256,
        ));
      const row = (
        await pool.query(
          "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1",
          [id],
        )
      ).rows[0];
      if (!row) throw Error("row not found");
      const status = row.generation_status;
      if (["failed", "cancelled"].includes(status))
        throw Error("projection rebuild generation did not complete");
      waiting = status !== "promoted";
      checkpoint = {
        generation_id: id,
        generation_status: status,
        requested_range_start: work.requested_range_start,
        requested_range_end: work.requested_range_end,
      };
    } else if (work.method === "fact_replay") {
      checkpoint = {
        enqueued_projection_work: await enqueueReplayRange(
          pool,
          work.reporting_scope_id,
          work.root_scope_id,
          work.requested_range_start,
          work.requested_range_end,
        ),
        requested_range_start: work.requested_range_start,
        requested_range_end: work.requested_range_end,
      };
    } else throw Error("unsupported analytics backfill method");
    await pool.query(
      waiting ? SQL.defer_backfill_0 : SQL.finish_backfill_0,
      waiting
        ? [work.job_id, apiJson(checkpoint), 30]
        : [work.job_id, apiJson(checkpoint)],
    );
  } catch (e) {
    await pool.query(SQL.fail_backfill_0, [
      work.job_id,
      e instanceof Error ? e.message : String(e),
      30,
    ]);
    throw e;
  }
  return true;
}
export async function runOnce(
  pool: Pool,
  registry: RegistrySnapshot,
  worker: string,
  lease: number | bigint,
  metrics?: ResultSpanMetrics,
): Promise<boolean> {
  const summary = await scheduleWork(pool);
  if (
    summary.reconciliation_work_created > 0n ||
    summary.quarantine_work_created > 0n
  )
    metrics?.log("debug", "queue.item.completed", {
      process: "analytics-worker",
      phase: "schedule",
      ...summary,
    });
  return processBackfillOnce(pool, registry, worker, lease);
}
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
) {
  const authenticator = new IngestionAuthenticator(
    context.config.ingestion_credentials,
  );
  for (const [path, claim] of [
    [RECONCILIATION_WORK_PATH, claimReconciliationWork],
    [QUARANTINE_WORK_PATH, claimQuarantineReleaseWork],
    [BACKFILL_WORK_PATH, claimSourceBackfillWork],
  ] as const)
    app.get(path, async (request, reply) => {
      let auth: AuthenticatedProducer;
      try {
        auth = authenticator.authenticate(request);
      } catch {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send();
      }
      try {
        const result = await claim(context.pool, auth, 300);
        return result ?? reply.code(204).send();
      } catch {
        return reply.code(503).send({ error: "analytics_unavailable" });
      }
    });
}
