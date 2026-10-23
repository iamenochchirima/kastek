import { metrics } from "@opentelemetry/api";
import type pg from "pg";
import type { OperationsConfig } from "./config.js";
const meter = metrics.getMeter("kasitek-operations", "1");
const collection = meter.createCounter("kasitek.operations.collection.count");
const leases = meter.createCounter("kasitek.operations.lease.contention");
const deliveries = meter.createCounter("kasitek.operations.delivery.count");
const sources = new Set([
  "growth",
  "agents",
  "agency",
  "analytics",
  "operations",
]);
export function recordCollection(
  source: string,
  outcome: "success" | "failed" | "fenced",
): void {
  if (sources.has(source)) collection.add(1, { source, outcome });
}
export function recordLeaseContention(): void {
  leases.add(1);
}
export function recordDelivery(
  outcome: "delivered" | "suppressed" | "failed",
): void {
  deliveries.add(1, { outcome });
}
export function operationLog(
  config: OperationsConfig,
  event: string,
  fields: { source?: string; code?: string; count?: number } = {},
): void {
  const value = {
    service: "operations",
    environment: config.environment,
    release: (process.env.KASITEK_RELEASE_ID ?? "development")
      .replace(/[^a-zA-Z0-9_.:-]/g, "_")
      .slice(0, 128),
    event,
    ...(fields.source && sources.has(fields.source)
      ? { source: fields.source }
      : {}),
    ...(fields.code && /^[a-z_]{1,60}$/.test(fields.code)
      ? { code: fields.code }
      : {}),
    ...(fields.count !== undefined && Number.isSafeInteger(fields.count)
      ? { count: fields.count }
      : {}),
  };
  console.info(JSON.stringify(value));
}
export interface MetricsSnapshot {
  collectionAge: { source: string; value: number }[];
  coverage: { source: string; status: string; count: number }[];
  incidents: {
    source: string;
    severity: string;
    status: string;
    count: number;
  }[];
  notificationPending: number;
  notificationOldestAge: number;
  workerAge: number | null;
}
export async function readMetricsSnapshot(
  pool: pg.Pool,
  now = new Date(),
): Promise<MetricsSnapshot> {
  const [monitors, observations, incidents, outbox, workers] =
    await Promise.all([
      pool.query(
        "SELECT source,last_completed_at FROM ops_monitors WHERE enabled ORDER BY source LIMIT 4",
      ),
      pool.query(
        `SELECT DISTINCT ON(m.id) m.source,o.snapshot FROM ops_monitors m JOIN ops_observations o ON o.monitor_id=m.id WHERE m.enabled ORDER BY m.id,o.observed_at DESC`,
      ),
      pool.query(
        "SELECT source,severity,status,count(*)::int count FROM ops_incidents WHERE status<>'resolved' GROUP BY source,severity,status LIMIT 20",
      ),
      pool.query(
        "SELECT count(*)::int count,min(created_at) oldest FROM ops_outbox WHERE delivered_at IS NULL",
      ),
      pool.query("SELECT max(updated_at) updated_at FROM ops_worker_progress"),
    ]);
  const age = (value: unknown) =>
      Math.max(0, (now.getTime() - new Date(value as string).getTime()) / 1000),
    coverage: MetricsSnapshot["coverage"] = [];
  for (const row of observations.rows) {
    const counts = new Map<string, number>();
    for (const signal of row.snapshot.signals as { status: string }[]) {
      const status = [
        "available",
        "unknown",
        "unsupported",
        "not_configured",
        "no_activity",
      ].includes(signal.status)
        ? signal.status
        : "unknown";
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    for (const [status, count] of counts)
      coverage.push({ source: row.source, status, count });
  }
  for (const row of monitors.rows.filter(
    (m) => !observations.rows.some((o) => o.source === m.source),
  ))
    coverage.push({ source: row.source, status: "not_started", count: 1 });
  return {
    collectionAge: monitors.rows
      .filter((r) => r.last_completed_at)
      .map((r) => ({ source: r.source, value: age(r.last_completed_at) })),
    coverage,
    incidents: incidents.rows,
    notificationPending: outbox.rows[0].count,
    notificationOldestAge: outbox.rows[0].oldest
      ? age(outbox.rows[0].oldest)
      : 0,
    workerAge: workers.rows[0].updated_at
      ? age(workers.rows[0].updated_at)
      : null,
  };
}
export function startMetrics(
  pool: pg.Pool,
  config: OperationsConfig,
): () => void {
  const age = meter.createObservableGauge("kasitek.operations.collection.age", {
      unit: "s",
    }),
    coverage = meter.createObservableGauge(
      "kasitek.operations.measurement.coverage",
    ),
    incidents = meter.createObservableGauge(
      "kasitek.operations.incidents.active",
    ),
    pending = meter.createObservableGauge(
      "kasitek.operations.notification.pending",
    ),
    oldest = meter.createObservableGauge(
      "kasitek.operations.notification.oldest_age",
      { unit: "s" },
    ),
    worker = meter.createObservableGauge(
      "kasitek.operations.worker.progress_age",
      { unit: "s" },
    );
  let snapshot: MetricsSnapshot | null = null,
    refreshing = false;
  const callback = (
    result: Parameters<
      Parameters<typeof meter.addBatchObservableCallback>[0]
    >[0],
  ) => {
    if (!snapshot) return;
    for (const row of snapshot.collectionAge)
      result.observe(age, row.value, { source: row.source });
    for (const row of snapshot.coverage)
      result.observe(coverage, row.count, {
        source: row.source,
        status: row.status,
      });
    for (const source of sources)
      for (const severity of ["warning", "critical"])
        for (const status of ["open", "acknowledged"]) {
          const row = snapshot.incidents.find(
            (r) =>
              r.source === source &&
              r.severity === severity &&
              r.status === status,
          );
          result.observe(incidents, row?.count ?? 0, {
            source,
            severity,
            status,
          });
        }
    result.observe(pending, snapshot.notificationPending);
    result.observe(oldest, snapshot.notificationOldestAge);
    if (snapshot.workerAge !== null) result.observe(worker, snapshot.workerAge);
  };
  const instruments = [age, coverage, incidents, pending, oldest, worker];
  meter.addBatchObservableCallback(callback, instruments);
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      snapshot = await readMetricsSnapshot(pool);
    } catch {
      snapshot = null;
      operationLog(config, "metrics_snapshot_failed", {
        code: "database_unavailable",
      });
    } finally {
      refreshing = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 15000);
  timer.unref();
  return () => {
    clearInterval(timer);
    meter.removeBatchObservableCallback(callback, instruments);
  };
}
