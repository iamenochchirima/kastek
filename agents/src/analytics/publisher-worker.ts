import { createPool } from "../db/pool";
import { loadConfig } from "../config";
import {
  AnalyticsIngestionClient,
  publishOutboxOnce,
  RetryPolicy,
  type AnalyticsPublisherSettings,
} from "./index";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = config.ANALYTICS_AGENT_INGESTION_TOKEN;
  if (!token) {
    console.warn("[analytics-publisher] disabled; ANALYTICS_AGENT_INGESTION_TOKEN is not configured");
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
      const stats = await publishOutboxOnce(pool, client, settings);
      if (stats.claimed > 0 || stats.leasesReleased > 0) {
        console.info(`[analytics-publisher] claimed=${stats.claimed} delivered=${stats.delivered} retryable=${stats.retryable} quarantined=${stats.quarantined} leasesReleased=${stats.leasesReleased}`);
      }
    } catch (error) {
      console.error("[analytics-publisher] iteration failed", error);
    } finally {
      publishing = false;
    }
  };

  await publish();
  const timer = setInterval(() => void publish(), config.ANALYTICS_PUBLISHER_POLL_INTERVAL_MS);
  const close = async (): Promise<void> => {
    clearInterval(timer);
    await pool.end();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
