import { workerSpan } from "../observability/operations.js";
import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import {
  syncAllSocialPostInsights,
  type InsightOptions,
} from "../services/social/insights.js";
interface Log {
  info(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}
export function socialWorkerInteger(
  value: string | undefined,
  fallback: bigint,
  unsigned = false,
): bigint {
  if (
    value === undefined ||
    !(unsigned ? /^\+?\d+$/ : /^[-+]?\d+$/).test(value)
  )
    return fallback;
  const parsed = BigInt(value);
  return parsed < (unsigned ? 0n : -(1n << 63n)) ||
    parsed >= (unsigned ? 1n << 64n : 1n << 63n)
    ? fallback
    : parsed;
}
export async function socialWorkerSleep(
  milliseconds: bigint,
  signal?: AbortSignal,
): Promise<void> {
  while (milliseconds > 0n && !signal?.aborted) {
    const chunk = milliseconds > 2147483647n ? 2147483647n : milliseconds;
    try {
      await delay(Number(chunk), undefined, { signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      throw error;
    }
    milliseconds -= chunk;
  }
  if (milliseconds === 0n && !signal?.aborted)
    await delay(0, undefined, { signal }).catch((error) => {
      if ((error as Error).name !== "AbortError") throw error;
    });
}
export async function runSocialInsights(
  pool: Pool,
  env: Record<string, string | undefined>,
  log: Log,
  signal?: AbortSignal,
  options: InsightOptions = {},
): Promise<void> {
  log.info(
    { event: "worker.started", worker: "social_insights" },
    "social insights worker started",
  );
  const poll = socialWorkerInteger(
      env.SOCIAL_INSIGHTS_POLL_INTERVAL_MS,
      900000n,
      true,
    ),
    batch = socialWorkerInteger(env.SOCIAL_INSIGHTS_BATCH_SIZE, 25n);
  while (!signal?.aborted) {
    try {
      const synced = await workerSpan("social_insights.process_batch", () =>
        syncAllSocialPostInsights(pool, Number(batch), options),
      );
      if (synced > 0)
        log.info(
          {
            event: "queue.item.completed",
            worker: "social_insights",
            items: synced,
          },
          "social insights batch completed",
        );
    } catch (error) {
      log.error(
        {
          event: "queue.item.failed",
          worker: "social_insights",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "social insights batch failed",
      );
    }
    await socialWorkerSleep(poll, signal);
  }
}
