import { queueSpan } from "../observability/operations.js";
import type { Pool } from "pg";
import type { ReconciliationCursor } from "@kasitek/contracts";
import {
  AnalyticsIngestionClient,
  publishOutboxOnce,
  reconcileOutboxOnce,
  type AnalyticsPublisherSettings,
  MAX_RECONCILIATION_STREAMS,
} from "@kasitek/server-support/analytics-producer";
import { enqueueMissingScopeDefinitions } from "./scope-bootstrap.js";
interface Log {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}
type Env = Record<string, string | undefined>;
export function envUnsigned(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value || !/^\+?\d+$/.test(value)) return fallback;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fallback;
}
function envSigned(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value || !/^[-+]?\d+$/.test(value)) return fallback;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : fallback;
}
const configured = (env: Env, name: string, fallback: string): string =>
  env[name]?.trim() ? env[name]! : fallback;
export type GrowthPublisherSettings = AnalyticsPublisherSettings & {
  retry_policy: {
    base_delay_ms: number;
    max_delay_ms: number;
    jitter_window_ms: number;
  };
};
export function publisherSettings(
  env: Env,
): GrowthPublisherSettings | undefined {
  // Rust checks the primary variable's existence before falling back, even when primary is blank.
  const token =
    env.ANALYTICS_CORE_INGESTION_TOKEN ?? env.ANALYTICS_INGESTION_TOKEN;
  if (!token?.trim()) return undefined;
  return {
    endpoint: env.ANALYTICS_INGESTION_URL ?? "http://127.0.0.1:4300",
    token,
    producer_id: configured(
      env,
      "ANALYTICS_CORE_PRODUCER_ID",
      "core-customer-analytics",
    ),
    publisher_id: configured(
      env,
      "ANALYTICS_CORE_PUBLISHER_ID",
      "core-analytics-publisher",
    ),
    batch_size: Math.max(
      1,
      Math.min(500, envSigned(env, "ANALYTICS_PUBLISHER_BATCH_SIZE", 100)),
    ),
    lease_duration_ms: envUnsigned(
      env,
      "ANALYTICS_PUBLISHER_LEASE_DURATION_MS",
      30000,
    ),
    request_timeout_ms: envUnsigned(
      env,
      "ANALYTICS_PUBLISHER_REQUEST_TIMEOUT_MS",
      10000,
    ),
    retry_policy: {
      base_delay_ms: envUnsigned(
        env,
        "ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS",
        2000,
      ),
      max_delay_ms: envUnsigned(
        env,
        "ANALYTICS_PUBLISHER_RETRY_MAX_DELAY_MS",
        300000,
      ),
      jitter_window_ms: envUnsigned(
        env,
        "ANALYTICS_PUBLISHER_RETRY_JITTER_MS",
        2000,
      ),
    },
  };
}
export async function runAnalyticsPublisher(
  pool: Pool,
  env: Env,
  log: Log,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const queued = await enqueueMissingScopeDefinitions(pool);
    if (queued > 0)
      log.info(
        {
          event: "queue.item.completed",
          worker: "analytics_publisher",
          phase: "scope_bootstrap",
          queued,
        },
        "organization scopes queued",
      );
  } catch (error) {
    log.error(
      {
        event: "queue.item.failed",
        worker: "analytics_publisher",
        phase: "scope_bootstrap",
        error_type: error instanceof Error ? error.name : "unknown",
      },
      "organization scope bootstrap failed",
    );
  }
  const settings = publisherSettings(env);
  if (!settings) {
    log.warn(
      {
        event: "worker.disabled",
        worker: "analytics_publisher",
        reason: "missing_ingestion_token",
      },
      "analytics publication disabled",
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
        event: "worker.failed",
        worker: "analytics_publisher",
        phase: "configuration",
        error_type: error instanceof Error ? error.name : "unknown",
      },
      "analytics publisher configuration invalid",
    );
    return;
  }
  log.info(
    {
      event: "worker.started",
      worker: "analytics_publisher",
      producer_id: settings.producer_id,
      batch_size: settings.batch_size,
    },
    "analytics publisher started",
  );
  let nextReconciliation = 0;
  let cursor: ReconciliationCursor | undefined;
  while (!signal?.aborted) {
    try {
      const stats = await queueSpan("analytics_publisher.publish", () =>
        publishOutboxOnce(pool, client, settings, new Date()),
      );
      if (stats.claimed > 0 || stats.leases_released > 0)
        log.info(
          {
            event: "queue.item.completed",
            worker: "analytics_publisher",
            phase: "publication",
            ...stats,
          },
          "analytics publication batch completed",
        );
    } catch (error) {
      log.error(
        {
          event: "queue.item.failed",
          worker: "analytics_publisher",
          phase: "publication",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "analytics publication batch failed",
      );
    }
    if (performance.now() >= nextReconciliation) {
      try {
        const stats = await queueSpan("analytics_publisher.reconcile", () =>
          reconcileOutboxOnce(
            pool,
            client,
            settings.producer_id,
            "core",
            cursor,
            Math.max(
              1,
              Math.min(
                MAX_RECONCILIATION_STREAMS,
                envSigned(env, "ANALYTICS_RECONCILIATION_MAX_STREAMS", 100),
              ),
            ),
          ),
        );
        cursor = stats.next_cursor;
        if (stats.attempted > 0 || stats.mismatched > 0)
          log.info(
            {
              event: "queue.item.completed",
              worker: "analytics_publisher",
              phase: "reconciliation",
              attempted: stats.attempted,
              complete: stats.complete,
              mismatched: stats.mismatched,
            },
            "analytics reconciliation completed",
          );
      } catch (error) {
        log.error(
          {
            event: "queue.item.failed",
            worker: "analytics_publisher",
            phase: "reconciliation",
            error_type: error instanceof Error ? error.name : "unknown",
          },
          "analytics reconciliation failed",
        );
      }
      nextReconciliation =
        performance.now() +
        envUnsigned(env, "ANALYTICS_RECONCILIATION_INTERVAL_MS", 60000);
    }
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(
        done,
        envUnsigned(env, "ANALYTICS_PUBLISHER_POLL_INTERVAL_MS", 1000),
      );
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
