import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { createPool } from "../db/pool";
import { loadConfig } from "../config";
import {
  AnalyticsIngestionClient,
  publishOutboxOnce,
  RetryPolicy,
  type AnalyticsPublisherSettings,
} from "./index";
import { operationalLogger } from "../telemetry/logger";
import { recordQueueAge, recordRetry, withSpan } from "../telemetry/spans";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = config.ANALYTICS_AGENT_INGESTION_TOKEN;
  if (!token) {
    operationalLogger.warn({ event: "analytics_publisher.disabled", reason: "missing_ingestion_token" }, "Analytics publisher disabled");
    await shutdownTelemetry();
    return;
  }

  const settings: AnalyticsPublisherSettings = {
    endpoint: config.ANALYTICS_INGESTION_URL,
    token,
    producerId: config.ANALYTICS_AGENT_PRODUCER_ID,
    publisherId: config.ANALYTICS_AGENT_PUBLISHER_ID,
    batchSize: config.ANALYTICS_PUBLISHER_BATCH_SIZE,
    leaseDurationMs: config.ANALYTICS_PUBLISHER_LEASE_DURATION_MS,
    requestTimeoutMs: config.ANALYTICS_PUBLISHER_REQUEST_TIMEOUT_MS,
    retryPolicy: new RetryPolicy({
      baseDelayMs: config.ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS,
      maxDelayMs: config.ANALYTICS_PUBLISHER_RETRY_MAX_DELAY_MS,
      jitterWindowMs: config.ANALYTICS_PUBLISHER_RETRY_JITTER_MS,
    }),
  };
  const pool = createPool(config);
  const client = new AnalyticsIngestionClient(settings);
  let publishing = false;
  const publish = async (): Promise<void> => {
    if (publishing) return;
    publishing = true;
    try {
      const stats = await withSpan("analytics.outbox.publish", {}, () => publishOutboxOnce(pool, client, settings));
      if (stats.oldestQueuedAgeSeconds !== null) recordQueueAge("analytics.outbox", stats.oldestQueuedAgeSeconds);
      if (stats.retryable > 0) recordRetry("analytics.outbox", stats.retryable);
      if (stats.claimed > 0 || stats.leasesReleased > 0) {
        operationalLogger.info({
          event: "analytics_publisher.batch_completed",
          claimed: stats.claimed,
          delivered: stats.delivered,
          retryable: stats.retryable,
          quarantined: stats.quarantined,
          leases_released: stats.leasesReleased,
        }, "Analytics publisher batch completed");
      }
    } catch (error) {
      operationalLogger.error({ err: error, event: "analytics_publisher.iteration_failed" }, "Analytics publisher iteration failed");
    } finally {
      publishing = false;
    }
  };

  await publish();
  const timer = setInterval(() => void publish(), config.ANALYTICS_PUBLISHER_POLL_INTERVAL_MS);
  const close = async (): Promise<void> => {
    clearInterval(timer);
    await pool.end();
    await shutdownTelemetry();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "analytics_publisher.startup_failed" }, "Analytics publisher startup failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
