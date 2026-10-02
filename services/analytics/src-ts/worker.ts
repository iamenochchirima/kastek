import { setTimeout } from "node:timers/promises";
import type { Pool } from "pg";
import type { RegistrySnapshot } from "./registry-types.js";
import { ProcessMetrics, type ResultSpanMetrics } from "./metrics.js";
import { processOnce } from "./projections.js";
import { runOnce } from "./maintenance.js";
function positive(
  value: string | undefined,
  fallback: number,
  max: bigint,
): number | bigint {
  if (!value || !/^\+?\d+$/.test(value)) return fallback;
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > max) return fallback;
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
}
export function workerOptions(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    workerId: env.ANALYTICS_PROJECTION_WORKER_ID?.trim()
      ? env.ANALYTICS_PROJECTION_WORKER_ID
      : `analytics-worker-${process.pid}`,
    pollIntervalMs: positive(
      env.ANALYTICS_PROJECTION_POLL_INTERVAL_MS,
      1000,
      (1n << 64n) - 1n,
    ),
    leaseSeconds: positive(
      env.ANALYTICS_PROJECTION_LEASE_SECONDS,
      60,
      (1n << 63n) - 1n,
    ),
    batchSize: positive(
      env.ANALYTICS_PROJECTION_BATCH_SIZE,
      25,
      (1n << 64n) - 1n,
    ),
  };
}
async function waitUntil(deadline: bigint, signal?: AbortSignal) {
  do {
    const remaining = deadline - BigInt(Date.now());
    if (remaining <= 0n) return;
    await setTimeout(
      Number(
        remaining > 2147483647n ? 2147483647n : remaining > 0n ? remaining : 0n,
      ),
      undefined,
      { signal },
    );
  } while (deadline > BigInt(Date.now()) && !signal?.aborted);
}
/** Native replacement of the source projection worker; source maintenance precedes each batch. */
export async function runWorker(
  pool: Pool,
  registry: RegistrySnapshot,
  signal?: AbortSignal,
  metrics: ResultSpanMetrics = new ProcessMetrics(),
): Promise<void> {
  const {
    workerId: worker,
    pollIntervalMs: poll,
    leaseSeconds: lease,
    batchSize: batch,
  } = workerOptions();
  metrics.log("info", "worker.started", {
    process: "analytics-worker",
    worker: "projections",
    projection: "typed_domain_facts",
    version: "1",
    batch_size: batch,
  });
  let next = BigInt(Date.now());
  while (!signal?.aborted) {
    try {
      await metrics.resultSpan(
        "worker",
        "analytics_projection.maintenance",
        () => runOnce(pool, registry, worker, lease, metrics),
      );
    } catch (e) {
      metrics.log("error", "queue.item.failed", {
        process: "analytics-worker",
        worker: "projections",
        phase: "maintenance",
        error_type: e instanceof Error ? e.name : "UnknownError",
      });
    }
    for (let i = 0n; i < BigInt(batch) && !signal?.aborted; i++) {
      try {
        if (!(await processOnce(pool, registry, worker, lease, metrics))) break;
      } catch (e) {
        metrics.log("error", "queue.item.failed", {
          process: "analytics-worker",
          worker: "projections",
          projection: "typed_domain_facts",
          error_type: e instanceof Error ? e.name : "UnknownError",
        });
        break;
      }
    }
    next += BigInt(poll);
    try {
      await waitUntil(next, signal);
    } catch (e) {
      if (signal?.aborted) break;
      throw e;
    }
  }
  metrics.log("info", "service.shutdown", {
    process: "analytics-worker",
    projection: "typed_domain_facts",
  });
}
export const run = runWorker;
