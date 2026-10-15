/** Source reconstruction replays immutable Tenant facts; operational rows only resolve scope ownership. */
import type { Pool } from "pg";
import type {
  AnalyticsOutboxRecord,
  BackfillRecord,
  BackfillBatchResponse,
  SourceBackfillWork,
} from "@kasitek-labs/contracts";
import {
  AnalyticsIngestionClient,
  backfillSourceSequence,
} from "@kasitek-labs/server-support/analytics-producer";
import { resultSpan } from "@kasitek-labs/server-support/telemetry";
import {
  envSigned,
  envUnsigned,
  workerSleep,
  type Log,
  type Env,
} from "./analytics-publisher.js";
import { integer, timestamp } from "@kasitek-labs/server-support/json";
export interface BackfillSettings {
  endpoint: string;
  token: string;
  producer_id: string;
  batch_size: number;
  request_timeout_ms: number;
}
export interface BackfillTransport {
  claimSourceBackfillWork(): Promise<SourceBackfillWork | undefined>;
  sendBackfillBatch(
    producer: string,
    job: string,
    records: BackfillRecord[],
  ): Promise<BackfillBatchResponse>;
}
export interface BackfillStats {
  records: number;
  rejected_records: number;
}
export function backfillSettings(env: Env): BackfillSettings | undefined {
  const token =
    env.ANALYTICS_TENANT_INGESTION_TOKEN ?? env.ANALYTICS_INGESTION_TOKEN;
  if (!token?.trim()) return undefined;
  return {
    endpoint: env.ANALYTICS_INGESTION_URL ?? "http://127.0.0.1:4300",
    token,
    producer_id: env.ANALYTICS_TENANT_PRODUCER_ID?.trim()
      ? env.ANALYTICS_TENANT_PRODUCER_ID
      : "tenant-platform-customer-analytics",
    batch_size: Math.max(
      1,
      Math.min(500, envSigned(env, "ANALYTICS_BACKFILL_BATCH_SIZE", 100)),
    ),
    request_timeout_ms: envUnsigned(
      env,
      "ANALYTICS_BACKFILL_REQUEST_TIMEOUT_MS",
      10000,
    ),
  };
}
export const sourceDomains = (domain: string) =>
  domain === "tenants"
    ? ["scopes", "clients", "leads", "assignments"]
    : [domain];
export async function resolveWorkspaceId(
  pool: Pool,
  external: string,
): Promise<string> {
  try {
    const workspace = (
      await pool.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE id=$1",
        [external],
      )
    ).rows[0];
    if (workspace) return workspace.id;
  } catch (error) {
    throw new Error(
      `resolve_workspace: ${error instanceof Error ? error.message : "database error"}`,
    );
  }
  let client;
  try {
    client = (
      await pool.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM tenant_clients WHERE id=$1",
        [external],
      )
    ).rows[0];
  } catch (error) {
    throw new Error(
      `resolve_client_workspace: ${error instanceof Error ? error.message : "database error"}`,
    );
  }
  if (!client) throw new Error("backfill_scope_not_found");
  return client.workspace_id;
}
export function buildBackfillRecord(
  row: AnalyticsOutboxRecord,
): AnalyticsOutboxRecord {
  if (
    row.source_service !== "tenant-platform" ||
    ![
      row.source_domain,
      row.source_stream_key,
      row.outbox_id,
      row.record_id,
    ].every((v) => typeof v === "string" && v.trim())
  )
    throw new Error("tenant_source_identity_missing");
  if (
    !["event", "observation", "scope_definition", "manifest"].includes(
      row.record_category,
    )
  )
    throw new Error("invalid_record_category");
  if (!["event", "scope_definition"].includes(row.record_category))
    throw new Error("tenant_backfill_record_category_not_supported");
  if (
    !["core_organization", "tenant_workspace", "tenant_client"].includes(
      row.scope_kind,
    )
  )
    throw new Error("invalid_scope_kind");
  return {
    outbox_id: row.outbox_id,
    source_service: row.source_service,
    source_domain: row.source_domain,
    source_stream_key: row.source_stream_key,
    record_category: row.record_category,
    record_id: row.record_id,
    contract_name: row.contract_name,
    schema_version: row.schema_version,
    scope_kind: row.scope_kind,
    scope_external_id: row.scope_external_id,
    idempotency_key: row.idempotency_key,
    envelope: row.envelope,
    payload_hash: row.payload_hash,
  };
}
export const TENANT_HISTORY_SQL = `SELECT source_sequence,outbox_id,source_service,source_domain,source_stream_key,record_category,record_id,contract_name,schema_version,scope_kind,scope_external_id,idempotency_key,envelope,payload_hash
 FROM analytics_outbox WHERE source_service='tenant-platform' AND source_domain=ANY($1) AND source_stream_key=ANY($2) AND record_category IN ('event','scope_definition')
 AND NULLIF(envelope->>'time','')::timestamptz >= $3 AND NULLIF(envelope->>'time','')::timestamptz < $4
 AND ($5::boolean=FALSE OR scope_external_id=$6 OR envelope#>>'{data,tenant_client_id}'=$6 OR envelope#>>'{data,scope_external_id}'=$6)
 AND ($7::bigint IS NULL OR source_sequence>$7) ORDER BY source_sequence LIMIT $8`;
function exactTime(input: string | Date): bigint {
  const value = timestamp(input),
    date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("invalid_tenant_source_backfill_work");
  return (
    BigInt(Math.floor(date.getTime() / 1000)) * 1000000000n +
    BigInt((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9))
  );
}
export async function processSourceReconstruction(
  pool: Pool,
  client: BackfillTransport,
  settings: BackfillSettings,
  work: SourceBackfillWork,
): Promise<BackfillStats> {
  if (
    work.source_service !== "tenant-platform" ||
    !settings.producer_id.trim() ||
    settings.batch_size < 1 ||
    settings.batch_size > 500 ||
    !Number.isInteger(settings.batch_size) ||
    work.method !== "source_reconstruction" ||
    !work.scope_external_id.trim() ||
    exactTime(work.requested_range_end) <=
      exactTime(work.requested_range_start) ||
    work.remaining_count == null
  )
    throw new Error("invalid_tenant_source_backfill_work");
  const workspace = await resolveWorkspaceId(pool, work.scope_external_id),
    domains = sourceDomains(work.source_domain),
    stats = { records: 0, rejected_records: 0 };
  let cursor: bigint | null = null;
  while (true) {
    let rows: (AnalyticsOutboxRecord & {
      source_sequence: string | number | bigint;
    })[];
    try {
      rows = (
        await pool.query(TENANT_HISTORY_SQL, [
          domains,
          domains.map((d) => `workspace:${workspace}:${d}`),
          timestamp(work.requested_range_start),
          timestamp(work.requested_range_end),
          workspace !== work.scope_external_id,
          work.scope_external_id,
          cursor,
          settings.batch_size,
        ])
      ).rows;
    } catch (error) {
      throw new Error(
        `load_tenant_history: ${error instanceof Error ? error.message : "database error"}`,
      );
    }
    if (!rows.length) break;
    let records: BackfillRecord[];
    try {
      records = rows.map((row) => {
        const record = buildBackfillRecord(row);
        return {
          source_sequence: backfillSourceSequence(record.record_id),
          record,
        };
      });
    } catch (error) {
      throw new Error(
        `build_tenant_fact: ${error instanceof Error ? error.message : "invalid record"}`,
      );
    }
    let response: BackfillBatchResponse;
    try {
      response = await client.sendBackfillBatch(
        settings.producer_id,
        work.job_id,
        records,
      );
    } catch (error) {
      throw new Error(
        `send_tenant_batch: ${error instanceof Error ? error.message : "transport failed"}`,
      );
    }
    if (response.retryable_count > 0)
      throw new Error("tenant_batch_has_retryable_records");
    stats.records += records.length;
    stats.rejected_records += response.rejected_count;
    cursor = integer(rows[rows.length - 1]!.source_sequence);
  }
  return stats;
}
export async function runAnalyticsBackfill(
  pool: Pool,
  env: Env,
  log: Log,
  signal?: AbortSignal,
): Promise<void> {
  const settings = backfillSettings(env);
  if (!settings) {
    log.warn(
      {
        event: "worker.disabled",
        worker: "tenant_analytics_backfill",
        reason: "missing_ingestion_token",
      },
      "worker disabled",
    );
    return;
  }
  let client: AnalyticsIngestionClient;
  try {
    client = new AnalyticsIngestionClient(
      settings.endpoint,
      settings.token,
      settings.request_timeout_ms,
    );
  } catch (error) {
    log.error(
      {
        event: "worker.startup.failed",
        worker: "tenant_analytics_backfill",
        error_type: error instanceof Error ? error.name : "unknown",
      },
      "worker transport configuration failed",
    );
    return;
  }
  log.info(
    {
      event: "worker.started",
      worker: "tenant_analytics_backfill",
      producer_id: settings.producer_id,
      batch_size: settings.batch_size,
    },
    "worker started",
  );
  while (!signal?.aborted) {
    try {
      const work = await client.claimSourceBackfillWork();
      if (work?.source_service === "tenant-platform") {
        try {
          const stats = await resultSpan(
            "queue",
            "tenant_analytics_backfill.process",
            () => processSourceReconstruction(pool, client, settings, work),
          );
          log.info(
            {
              event: "queue.item.completed",
              worker: "tenant_analytics_backfill",
              ...stats,
            },
            "backfill job completed",
          );
        } catch {
          log.error(
            {
              event: "queue.item.failed",
              worker: "tenant_analytics_backfill",
              error_code: "backfill_processing_failed",
            },
            "backfill job failed",
          );
        }
      } else if (work) {
        log.warn(
          {
            event: "queue.item.ignored",
            worker: "tenant_analytics_backfill",
            source_service: work.source_service,
          },
          "backfill job belongs to another source service",
        );
      }
    } catch (error) {
      log.error(
        {
          event: "queue.claim.failed",
          worker: "tenant_analytics_backfill",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "backfill work claim failed",
      );
    }
    await workerSleep(
      envUnsigned(env, "ANALYTICS_BACKFILL_POLL_INTERVAL_MS", 5000),
      signal,
    );
  }
}
