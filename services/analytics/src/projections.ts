import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { RegistrySnapshot, MetricDefinition } from "./registry-types.js";
import { transaction } from "./db.js";
import { apiJson } from "./json.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import type { ResultSpanMetrics } from "./metrics.js";
import { SQL } from "./projections-sql.js";
export const PROJECTION_NAME = "typed_domain_facts",
  PROJECTION_VERSION = "1",
  DEFAULT_SHARD_KEY = "default";
const DELETED_SCOPE_CANCELLATION_BATCH_SIZE = 100;
export type FactKind = "event" | "observation";
export interface FactWindow {
  fact_kind: FactKind;
  reporting_scope_id: bigint;
  root_scope_id: bigint;
  source_storage_id: bigint;
  source_window_start: Date;
  source_window_end: Date;
}
interface ClaimedWork {
  work_id: bigint;
  available_at: Date;
  fact_kind: FactKind;
  reporting_scope_id: bigint;
  root_scope_id: bigint;
  source_window_start: Date;
  source_window_end: Date;
  max_source_storage_id: bigint;
  generation_id: bigint | null;
}
interface GenerationSelection {
  generation_id: bigint;
  shadow: boolean;
  rebuild_in_progress: boolean;
}
const one = async (
  tx: Pool | PoolClient,
  sql: string,
  values: unknown[] = [],
) => {
  const row = (await tx.query(sql, values)).rows[0];
  if (!row) throw Error("row not found");
  return row;
};
const scalar = async (
  tx: Pool | PoolClient,
  sql: string,
  values: unknown[] = [],
) => Object.values(await one(tx, sql, values))[0];
const key = (scope: bigint) =>
  `${PROJECTION_NAME}:${PROJECTION_VERSION}:${scope}:${DEFAULT_SHARD_KEY}`;
const constants = (scope: bigint) => [
  PROJECTION_NAME,
  PROJECTION_VERSION,
  scope,
  DEFAULT_SHARD_KEY,
];
export function hourlyWindow(timestamp: Date): [Date, Date] {
  const start = new Date(Math.floor(timestamp.getTime() / 3600000) * 3600000);
  return [start, new Date(start.getTime() + 3600000)];
}
export async function enqueueFact(
  tx: PoolClient,
  fact: FactWindow,
): Promise<void> {
  await enqueueProjectionWork(tx, fact, fact.source_storage_id, 100, null);
}
async function enqueueProjectionWork(
  tx: PoolClient,
  f: FactWindow,
  max: bigint,
  priority: number,
  reason: string | null,
) {
  await tx.query(SQL.enqueue_projection_work_0, [
    PROJECTION_NAME,
    PROJECTION_VERSION,
    f.reporting_scope_id,
    f.root_scope_id,
    DEFAULT_SHARD_KEY,
  ]);
  const updated = await tx.query(SQL.enqueue_projection_work_1, [
    PROJECTION_NAME,
    PROJECTION_VERSION,
    f.fact_kind,
    f.reporting_scope_id,
    f.source_window_start,
    f.source_window_end,
    f.source_storage_id,
    max,
    priority,
    reason,
    DEFAULT_SHARD_KEY,
  ]);
  if (updated.rowCount) return;
  await tx.query(SQL.enqueue_projection_work_2, [
    PROJECTION_NAME,
    PROJECTION_VERSION,
    f.fact_kind,
    f.reporting_scope_id,
    f.root_scope_id,
    f.source_window_start,
    f.source_window_end,
    f.source_storage_id,
    max,
    priority,
    reason,
  ]);
}
export async function enqueueReconciliationRepair(
  pool: Pool,
  producer: string,
  stream: string,
  scope: bigint,
  root: bigint,
): Promise<bigint> {
  return transaction(pool, async (tx) => {
    const windows = (
      await tx.query(SQL.enqueue_reconciliation_repair_0, [
        producer,
        stream,
        scope,
      ])
    ).rows;
    for (const w of windows) {
      if (!["event", "observation"].includes(w.fact_kind))
        throw Error("invalid projection fact kind");
      await enqueueProjectionWork(
        tx,
        {
          fact_kind: w.fact_kind,
          reporting_scope_id: scope,
          root_scope_id: root,
          source_storage_id: BigInt(w.min_storage_id),
          source_window_start: w.window_start,
          source_window_end: w.window_end,
        },
        BigInt(w.max_storage_id),
        25,
        "reconciliation_mismatch",
      );
    }
    return BigInt(windows.length);
  });
}
async function promoteEmptyGeneration(
  tx: PoolClient,
  id: bigint,
  scope: bigint,
) {
  await tx.query(SQL.promote_empty_generation_0, [...constants(scope), id]);
  await tx.query(SQL.promote_empty_generation_1, [id]);
  await tx.query(SQL.promote_empty_generation_2, [id]);
  await tx.query(SQL.promote_empty_generation_3, [
    id,
    PROJECTION_NAME,
    PROJECTION_VERSION,
    scope,
    DEFAULT_SHARD_KEY,
  ]);
}
export async function requestRebuild(
  pool: Pool,
  scope: bigint,
  root: bigint,
  requestedBy: string,
  hash: string,
): Promise<bigint> {
  return transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key(scope),
    ]);
    await tx.query(SQL.request_rebuild_0, [
      PROJECTION_NAME,
      PROJECTION_VERSION,
      scope,
      root,
      DEFAULT_SHARD_KEY,
    ]);
    const number = BigInt(
      (await scalar(tx, SQL.request_rebuild_1, constants(scope))) as string,
    );
    const id = BigInt(
      (await scalar(tx, SQL.request_rebuild_2, [
        PROJECTION_NAME,
        PROJECTION_VERSION,
        scope,
        root,
        DEFAULT_SHARD_KEY,
        number,
        hash,
        requestedBy,
      ])) as string,
    );
    await tx.query(SQL.request_rebuild_3, [id, ...constants(scope)]);
    const windows = (await tx.query(SQL.request_rebuild_4, [scope])).rows;
    for (const w of windows)
      await tx.query(SQL.request_rebuild_5, [
        PROJECTION_NAME,
        PROJECTION_VERSION,
        w.fact_kind,
        scope,
        root,
        w.window_start,
        w.window_end,
        w.min_storage_id,
        w.max_storage_id,
        id,
      ]);
    if (!windows.length) await promoteEmptyGeneration(tx, id, scope);
    return id;
  });
}
export async function enqueueReplayRange(
  pool: Pool,
  scope: bigint,
  root: bigint,
  start: Date,
  end: Date,
): Promise<bigint> {
  return transaction(pool, async (tx) => {
    const windows = (
      await tx.query(SQL.enqueue_replay_range_0, [scope, start, end])
    ).rows;
    let count = 0n;
    for (const w of windows) {
      const reset = await tx.query(SQL.enqueue_replay_range_1, [
        PROJECTION_NAME,
        PROJECTION_VERSION,
        w.fact_kind,
        scope,
        w.window_start,
        w.window_end,
        w.min_storage_id,
        w.max_storage_id,
        DEFAULT_SHARD_KEY,
      ]);
      if (reset.rowCount) {
        count++;
        continue;
      }
      const inserted = await tx.query(SQL.enqueue_replay_range_2, [
        PROJECTION_NAME,
        PROJECTION_VERSION,
        w.fact_kind,
        scope,
        root,
        w.window_start,
        w.window_end,
        w.min_storage_id,
        w.max_storage_id,
      ]);
      count += BigInt(inserted.rowCount ?? 0);
    }
    await tx.query(SQL.enqueue_replay_range_3, [
      PROJECTION_NAME,
      PROJECTION_VERSION,
      scope,
      root,
      DEFAULT_SHARD_KEY,
    ]);
    return count;
  });
}
function claimed(row: QueryResultRow): ClaimedWork {
  if (!["event", "observation"].includes(row.fact_kind))
    throw Error("invalid projection fact kind");
  return {
    ...row,
    work_id: BigInt(row.work_id),
    reporting_scope_id: BigInt(row.reporting_scope_id),
    root_scope_id: BigInt(row.root_scope_id),
    max_source_storage_id: BigInt(row.max_source_storage_id),
    generation_id:
      row.generation_id === null ? null : BigInt(row.generation_id),
  } as ClaimedWork;
}
export async function claimWork(
  pool: Pool,
  worker: string,
  lease: number | bigint,
): Promise<ClaimedWork | null> {
  const row = (
    await pool.query(SQL.claim_work_0, [
      PROJECTION_NAME,
      PROJECTION_VERSION,
      10,
      worker,
      lease,
    ])
  ).rows[0];
  return row ? claimed(row) : null;
}
export async function cancelDeletedScopeWork(
  pool: Pool,
  limit = DELETED_SCOPE_CANCELLATION_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw Error("Invalid deleted-scope cancellation batch size");
  const result = await pool.query(SQL.cancel_deleted_scope_work, [limit]);
  return result.rowCount ?? 0;
}
export async function processOnce(
  pool: Pool,
  registry: RegistrySnapshot,
  worker: string,
  lease: number | bigint,
  metrics?: ResultSpanMetrics,
): Promise<boolean> {
  await cancelDeletedScopeWork(pool);
  const work = await claimWork(pool, worker, lease);
  if (!work) return false;
  const age = Date.now() - work.available_at.getTime();
  if (age >= 0) metrics?.recordQueueAge("analytics.projection", age);
  try {
    const run = () => processWork(pool, registry, worker, work);
    if (metrics)
      await metrics.resultSpan("queue", "analytics_projection.process", run);
    else await run();
  } catch (e) {
    await pool.query(SQL.mark_failed_0, [
      work.work_id,
      worker,
      e instanceof Error ? e.message : String(e),
    ]);
    throw e;
  }
  return true;
}
async function ensureGeneration(
  tx: PoolClient,
  registry: RegistrySnapshot,
  worker: string,
  w: ClaimedWork,
): Promise<GenerationSelection> {
  await tx.query(SQL.ensure_generation_0, [
    PROJECTION_NAME,
    PROJECTION_VERSION,
    w.reporting_scope_id,
    w.root_scope_id,
    DEFAULT_SHARD_KEY,
  ]);
  const c = await one(
    tx,
    SQL.ensure_generation_1,
    constants(w.reporting_scope_id),
  );
  const generation = c.generation_id === null ? null : BigInt(c.generation_id),
    rebuild =
      c.rebuild_generation_id === null ? null : BigInt(c.rebuild_generation_id);
  let selection: GenerationSelection | null =
    w.generation_id !== null
      ? {
          generation_id: w.generation_id,
          shadow: true,
          rebuild_in_progress: true,
        }
      : generation !== null
        ? {
            generation_id: generation,
            shadow: false,
            rebuild_in_progress: rebuild !== null,
          }
        : rebuild !== null
          ? { generation_id: rebuild, shadow: true, rebuild_in_progress: true }
          : null;
  if (selection) {
    const status = await scalar(
      tx,
      "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1",
      [selection.generation_id],
    );
    if (["building", "validated", "promoted"].includes(String(status))) {
      await tx.query(SQL.ensure_generation_2, [
        selection.generation_id,
        selection.shadow,
        ...constants(w.reporting_scope_id),
        selection.rebuild_in_progress,
      ]);
      return selection;
    }
  }
  const number = await scalar(
    tx,
    SQL.ensure_generation_3,
    constants(w.reporting_scope_id),
  );
  const id = BigInt(
    (await scalar(tx, SQL.ensure_generation_4, [
      PROJECTION_NAME,
      PROJECTION_VERSION,
      w.reporting_scope_id,
      w.root_scope_id,
      DEFAULT_SHARD_KEY,
      number,
      w.max_source_storage_id,
      registry.sha256,
      worker,
    ])) as string,
  );
  const shadow = w.generation_id !== null;
  await tx.query(SQL.ensure_generation_5, [
    id,
    shadow,
    ...constants(w.reporting_scope_id),
  ]);
  return { generation_id: id, shadow, rebuild_in_progress: shadow };
}
async function processWork(
  pool: Pool,
  registry: RegistrySnapshot,
  worker: string,
  w: ClaimedWork,
) {
  await transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key(w.reporting_scope_id),
    ]);
    const selection = await ensureGeneration(tx, registry, worker, w);
    await rebuildWindow(tx, registry, selection.generation_id, w);
    await tx.query(SQL.process_work_0, [
      w.work_id,
      w.max_source_storage_id,
      selection.generation_id,
      worker,
      selection.shadow,
    ]);
    const remaining = BigInt(
      (await scalar(tx, SQL.process_work_1, [
        PROJECTION_NAME,
        PROJECTION_VERSION,
        w.reporting_scope_id,
        selection.generation_id,
        selection.shadow || w.generation_id === null,
      ])) as string,
    );
    if (
      remaining === 0n &&
      (selection.shadow || !selection.rebuild_in_progress)
    )
      await finishGeneration(tx, selection, w, registry);
    else
      await tx.query(SQL.process_work_2, [
        w.max_source_storage_id,
        w.work_id,
        selection.shadow,
        w.root_scope_id,
        selection.generation_id,
        PROJECTION_NAME,
        PROJECTION_VERSION,
        w.reporting_scope_id,
        DEFAULT_SHARD_KEY,
        selection.rebuild_in_progress,
      ]);
  });
}
type Attributes = Record<string, unknown>;
const protocol = (message: string): never => {
  throw Error(message);
};
const text = (a: Attributes, key: string) =>
  typeof a[key] === "string" && (a[key] as string).trim()
    ? (a[key] as string)
    : protocol(`typed projection builder missing ${key}`);
const fields = (a: Attributes, keys: string[]) => {
  for (const key of keys) text(a, key);
};
function numeric(value: unknown): number | null {
  if (typeof value === "number" || typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value instanceof SerdeFloat) {
    const n = value.value;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const number = (a: Attributes, key: string) =>
  numeric(a[key]) ?? protocol(`typed projection builder missing ${key}`);
function builder(metric: MetricDefinition) {
  if (
    !["agents", "campaigns", "connections", "inbox", "tenants"].includes(
      metric.domain,
    )
  )
    protocol(`no typed projection builder for domain ${metric.domain}`);
  return metric.domain;
}
export function typedEventDimensions(
  domain: string,
  m: MetricDefinition,
  a: Attributes,
  subjectType: string,
  subjectId: string,
) {
  if (domain === "agents") fields(a, ["installation_id", "status"]);
  else if (domain === "campaigns") {
    fields(a, ["campaign_id", "recipient_id", "channel", "status"]);
    if (m.key === "campaign.delivery_delay_ms") {
      fields(a, ["timing_kind"]);
      number(a, "duration_ms");
    }
    if (m.key === "campaign.recipients.pricing_recorded") {
      fields(a, ["pricing_category"]);
      if (typeof a.billable !== "boolean")
        protocol("typed projection builder missing billable");
    }
  } else if (domain === "inbox")
    fields(a, [
      "conversation_id",
      "channel",
      m.key === "conversation.lifecycle_events"
        ? "actor_type"
        : "responder_type",
    ]);
  else if (domain === "connections") {
    fields(a, ["connection_id", "provider"]);
    switch (m.key) {
      case "connection.lifecycle_events":
        fields(a, [
          "action",
          "status",
          "credential_status",
          "health_status",
          "webhook_status",
        ]);
        break;
      case "connection.health_checks":
        fields(a, [
          "status",
          "health_status",
          "credential_status",
          "webhook_status",
          "check_result",
        ]);
        break;
      case "connection.capability_events":
        fields(a, ["capability", "action"]);
        if (typeof a.enabled !== "boolean")
          protocol("typed projection builder missing enabled");
        break;
      case "connection.sync_attempts":
        fields(a, ["attempt_id", "operation", "outcome", "failure_class"]);
        number(a, "duration_ms");
        break;
      case "connection.rate_limit_encounters":
        fields(a, ["operation", "rate_limit_scope"]);
        break;
      case "connection.incidents":
        fields(a, ["incident_key", "action", "severity", "reason_code"]);
        break;
      default:
        protocol(`unsupported Connections metric ${m.key}`);
    }
  } else if (domain === "tenants") {
    fields(a, ["tenant_client_id", "action", "status"]);
    switch (m.key) {
      case "tenant.leads.lifecycle_events":
        fields(a, ["lead_id", "source", "score_band"]);
        if (a.action === "status_changed")
          fields(a, ["previous_status", "reason_code", "actor_type"]);
        break;
      case "tenant.clients.lifecycle_events":
        break;
      case "tenant.client.assignment_events":
        fields(a, ["tenant_user_id", "assignment_role"]);
        break;
      default:
        protocol(`unsupported Tenant metric ${m.key}`);
    }
  }
  return eventDimensions(m, a, subjectType, subjectId);
}
export function eventMetricValue(
  m: MetricDefinition,
  a: Attributes,
): number | null {
  if (m.default_aggregation !== "weighted_average") return 1;
  const comma = m.formula.indexOf(",");
  if (comma < 0 || !m.formula.endsWith(")")) return null;
  const field = m.formula.slice(comma + 1, -1).trim();
  return field ? numeric(a[field]) : null;
}
function deduplicationKey(m: MetricDefinition, a: Attributes): string | null {
  const key =
    m.deduplication === "recipient"
      ? "recipient_id"
      : m.deduplication === "conversation"
        ? "conversation_id"
        : m.deduplication === "source_entity"
          ? Object.hasOwn(a, "source_entity_id")
            ? "source_entity_id"
            : "connection_id"
          : null;
  return key && typeof a[key] === "string" && (a[key] as string).trim()
    ? (a[key] as string)
    : null;
}
function ratioComponent(
  m: MetricDefinition,
  event: string,
  r: RegistrySnapshot,
): [number | null, number | null] {
  if (m.default_aggregation !== "ratio_of_sums") return [null, null];
  const component = (id: string | null | undefined) =>
    r.metrics
      .find((c) => `${c.key}@${c.version}` === id)
      ?.sources.includes(event)
      ? 1
      : null;
  return [component(m.numerator), component(m.denominator)];
}
const safe = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  numeric(value) !== null;
const dimensionMap: Record<string, string> = {
  agent_version: "agent_version_id",
  agent_installation: "installation_id",
  agent_audience: "agent_audience",
  campaign: "campaign_id",
  conversation_channel: "channel",
  lifecycle_action: "action",
  message_action: "action",
  message_direction: "direction",
  message_delivery_status: "delivery_status",
  connection_health_status: "health_status",
  connection_credential_status: "credential_status",
  connection_webhook_status: "webhook_status",
  connection_sync_operation: "operation",
  incident_severity: "severity",
  incident_reason_code: "reason_code",
  tenant_client: "tenant_client_id",
  client_lifecycle_action: "action",
  assignment_action: "action",
  lead_action: "action",
  lead_status: "status",
  lead_source: "source",
  lead_score_band: "score_band",
  lead_reason_code: "reason_code",
  lead_actor_type: "actor_type",
  handoff_channel: "channel_type",
  handoff_conversation_state: "conversation_state",
  handoff_reason: "reason",
  handoff_priority: "priority",
  handoff_actor_type: "actor_type",
  handoff_resolution_code: "resolution_code",
};
const direct = new Set([
  "channel",
  "provider",
  "responder_type",
  "outcome",
  "failure_class",
  "suppression_class",
  "unsubscribe_source",
  "timing_kind",
  "pricing_category",
  "pricing_model",
  "pricing_type",
  "status",
  "message_type",
  "capability",
  "rate_limit_scope",
  "assignment_role",
]);
export function eventDimensions(
  m: MetricDefinition,
  a: Attributes,
  subject: string,
  id: string,
) {
  const result: Attributes = {};
  for (const key of m.dimensions) {
    let value: unknown;
    if (key === "agent_definition")
      value = Object.hasOwn(a, "agent_definition_id")
        ? a.agent_definition_id
        : subject === "agent_definition"
          ? id
          : undefined;
    else if (key === "pricing_billable")
      value =
        typeof a.billable === "boolean"
          ? a.billable
            ? "billable"
            : "non_billable"
          : undefined;
    else if (dimensionMap[key]) value = a[dimensionMap[key]!];
    else if (direct.has(key)) value = a[key];
    if (safe(value)) result[key] = value;
  }
  return result;
}
function observationDimensions(m: MetricDefinition, a: Attributes) {
  return Object.fromEntries(
    m.dimensions.filter((k) => safe(a[k])).map((k) => [k, a[k]]),
  );
}
async function rebuildWindow(
  tx: PoolClient,
  r: RegistrySnapshot,
  id: bigint,
  w: ClaimedWork,
) {
  const window = [
    id,
    w.reporting_scope_id,
    w.source_window_start,
    w.source_window_end,
  ];
  await tx.query(SQL.rebuild_window_0, window);
  await tx.query(SQL.rebuild_window_1, window);
  const events = (await tx.query(SQL.rebuild_window_2, window.slice(1))).rows;
  const insert = async (
    row: QueryResultRow,
    m: MetricDefinition,
    kind: FactKind,
    dimensions: Attributes,
    value: number,
    numerator: number | null,
    denominator: number | null,
    dedup: string | null,
    domain: string,
  ) => {
    await tx.query(SQL.rebuild_window_4, [
      id,
      PROJECTION_NAME,
      PROJECTION_VERSION,
      m.key,
      m.version | 0,
      kind,
      row.storage_id,
      row.target_scope_id,
      row.source_scope_id,
      row.target_root_scope_id,
      row.bucket_start,
      row.bucket_end,
      row.timezone_name,
      row.timezone_revision,
      apiJson(dimensions),
      dedup,
      `${domain}.v1`,
      value,
      numerator,
      denominator,
      apiJson({
        builder: `${domain}.v1`,
        source_kind: kind,
        coverage_state: "observed",
        required_sources: m.coverage.required_sources,
        exactness: m.exactness,
      }),
    ]);
  };
  for (const row of events)
    for (const m of r.metrics.filter(
      (m) =>
        m.sources.includes(row.event_type) &&
        m.scope_kinds.includes(row.target_scope_kind),
    )) {
      const domain = builder(m),
        dimensions = typedEventDimensions(
          domain,
          m,
          row.attributes,
          row.subject_type,
          row.subject_id,
        ),
        value = eventMetricValue(m, row.attributes);
      if (value === null) continue;
      const [num, den] = ratioComponent(m, row.event_type, r);
      if (
        m.default_aggregation === "ratio_of_sums" &&
        num === null &&
        den === null
      )
        continue;
      await insert(
        row,
        m,
        "event",
        dimensions,
        value,
        num,
        den,
        deduplicationKey(m, row.attributes),
        domain,
      );
    }
  const observations = (await tx.query(SQL.rebuild_window_3, window.slice(1)))
    .rows;
  for (const row of observations) {
    const m = r.metrics.find((m) => m.key === row.metric_key);
    if (!m || !m.scope_kinds.includes(row.target_scope_kind)) continue;
    const domain = builder(m);
    await insert(
      row,
      m,
      "observation",
      observationDimensions(m, row.dimensions),
      row.numeric_value,
      null,
      null,
      null,
      domain,
    );
  }
  await rebuildRollups(tx, r, id, w);
}
async function rebuildRollups(
  tx: PoolClient,
  r: RegistrySnapshot,
  id: bigint,
  w: ClaimedWork,
) {
  const start = new Date(w.source_window_start.getTime() - 31 * 86400000),
    end = new Date(w.source_window_end.getTime() + 31 * 86400000);
  await tx.query(SQL.rebuild_rollups_0, [id, w.reporting_scope_id, start, end]);
  for (const m of r.metrics)
    for (const interval of ["hour", "day", "month"]) {
      if (!m.supported_intervals.includes(interval)) continue;
      const expressions: Record<string, string> = {
        bucket:
          interval === "hour"
            ? "bucket_start"
            : `date_trunc('${interval}', bucket_start AT TIME ZONE timezone_name) AT TIME ZONE timezone_name`,
        end:
          interval === "hour"
            ? "bucket_end"
            : `(date_trunc('${interval}', bucket_start AT TIME ZONE timezone_name) + INTERVAL '1 ${interval}') AT TIME ZONE timezone_name`,
        value_count:
          m.default_aggregation === "distinct_count"
            ? "COUNT(DISTINCT deduplication_key)"
            : "COALESCE(SUM(value_count), 0)",
        value_sum:
          m.default_aggregation === "ratio_of_sums"
            ? "COALESCE(COALESCE(SUM(numerator), 0) / NULLIF(SUM(denominator), 0), 0)"
            : "COALESCE(SUM(value_sum), 0)",
        numerator:
          m.default_aggregation === "ratio_of_sums" ? "SUM(numerator)" : "NULL",
        denominator:
          m.default_aggregation === "ratio_of_sums"
            ? "SUM(denominator)"
            : "NULL",
      };
      const sql = SQL.rebuild_rollups_1.replace(
        /\{(\w+)\}/g,
        (_, key: string) => expressions[key]!,
      );
      // SQLx supplies parameter OIDs; node-postgres relies on SQL inference. In this
      // statement $4/$10 enter polymorphic JSON builders and $3 is otherwise unused.
      // Explicit source bind types preserve the exact query/filter/aggregation behavior.
      const typedSql = `WITH bound_root AS (SELECT $3::BIGINT) ${sql.replace(/\$(\d+)\b/g, (token, index: string) => `${token}::${({ 1: "BIGINT", 2: "BIGINT", 4: "TEXT", 5: "TEXT", 6: "INTEGER", 7: "TIMESTAMPTZ", 8: "TIMESTAMPTZ", 9: "JSONB", 10: "TEXT" } as Record<string, string>)[index]}`)}`;
      await tx.query(typedSql, [
        id,
        w.reporting_scope_id,
        w.root_scope_id,
        interval,
        m.key,
        m.version | 0,
        start,
        end,
        apiJson(m.coverage.required_sources),
        m.exactness,
      ]);
    }
}
async function validateProjectionWindow(
  tx: PoolClient,
  r: RegistrySnapshot,
  id: bigint,
  w: ClaimedWork,
) {
  const scopes = (
    await tx.query(SQL.validate_projection_window_0, [w.reporting_scope_id])
  ).rows;
  let checked = 0n,
    expectedFacts = 0n,
    actualFacts = 0n;
  for (const m of r.metrics) {
    const domain = builder(m);
    if (!m.scope_kinds.some((k) => scopes.some((s) => s.scope_kind === k)))
      continue;
    const window = [
      w.reporting_scope_id,
      w.source_window_start,
      w.source_window_end,
    ];
    let expected: bigint;
    if (w.fact_kind === "event") {
      expected = BigInt(
        (await scalar(tx, SQL.validate_projection_window_1, [
          ...window,
          m.sources,
        ])) as string,
      );
      if (m.default_aggregation === "weighted_average") {
        const rows = (
          await tx.query(SQL.validate_projection_window_2, [
            ...window,
            m.sources,
          ])
        ).rows;
        expected = BigInt(
          rows.filter((row) => eventMetricValue(m, row.attributes) !== null)
            .length,
        );
      }
    } else
      expected = BigInt(
        (await scalar(tx, SQL.validate_projection_window_3, [
          ...window,
          m.key,
        ])) as string,
      );
    for (const scope of scopes) {
      if (!m.scope_kinds.includes(scope.scope_kind)) continue;
      const params = [
        id,
        w.reporting_scope_id,
        scope.scope_id,
        m.key,
        m.version | 0,
        w.source_window_start,
        w.source_window_end,
      ];
      if (w.fact_kind === "event") params.push(m.sources);
      const actual = BigInt(
        (await scalar(
          tx,
          w.fact_kind === "event"
            ? SQL.validate_projection_window_4
            : SQL.validate_projection_window_5,
          params,
        )) as string,
      );
      if (actual !== expected)
        protocol(
          `projection parity failed metric=${m.key} target_scope=${scope.scope_id} expected=${expected} actual=${actual} builder=${domain}.v1`,
        );
      expectedFacts += expected;
      actualFacts += actual;
      checked++;
    }
  }
  return {
    status: "passed",
    builder_count: 5,
    metrics_checked: checked,
    expected_source_facts: expectedFacts,
    contribution_rows: actualFacts,
    scope_id: w.reporting_scope_id,
    work_id: w.work_id,
  };
}
async function finishGeneration(
  tx: PoolClient,
  s: GenerationSelection,
  w: ClaimedWork,
  r: RegistrySnapshot,
) {
  const id = s.generation_id,
    status = await scalar(
      tx,
      "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1 FOR UPDATE",
      [id],
    );
  if (status === "building" || status === "validated") {
    const summary = await validateProjectionWindow(tx, r, id, w);
    await tx.query(SQL.finish_generation_0, [
      id,
      w.max_source_storage_id,
      r.sha256,
      apiJson(summary),
    ]);
    await tx.query(SQL.finish_generation_1, [
      ...constants(w.reporting_scope_id),
      id,
    ]);
    await tx.query(SQL.finish_generation_2, [id]);
  }
  await tx.query(SQL.finish_generation_3, [
    id,
    w.max_source_storage_id,
    w.work_id,
    PROJECTION_NAME,
    PROJECTION_VERSION,
    w.reporting_scope_id,
    DEFAULT_SHARD_KEY,
  ]);
}
/** Source projections::run boundary; native process bootstrap normally calls worker.runWorker. */
export async function run(
  pool: Pool,
  registry: RegistrySnapshot,
  signal?: AbortSignal,
  metrics?: ResultSpanMetrics,
): Promise<void> {
  const { runWorker } = await import("./worker.js");
  return runWorker(pool, registry, signal, metrics);
}
