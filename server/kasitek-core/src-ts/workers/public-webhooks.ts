import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import { processDueDeliveries } from "../services/public-webhooks.js";
export async function runPublicWebhooks(
  pool: Pool,
  config: CoreConfig,
  signal: AbortSignal,
  logger: Pick<Console, "info" | "error"> = console,
): Promise<void> {
  const raw = config.env.PUBLIC_WEBHOOK_POLL_INTERVAL_MS,
    interval =
      raw && /^\+?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : 1000,
    batch = Number(config.env.PUBLIC_WEBHOOK_BATCH_SIZE ?? 25);
  logger.info({ event: "worker.started", worker: "public_webhooks" });
  while (!signal.aborted) {
    try {
      const processed = await processDueDeliveries(
        pool,
        config,
        Number.isSafeInteger(batch) ? batch : 25,
        signal,
      );
      if (processed)
        logger.info({
          event: "queue.item.completed",
          worker: "public_webhooks",
          items: processed,
        });
    } catch (error) {
      logger.error({
        event: "queue.item.failed",
        worker: "public_webhooks",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      await sleep(interval, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("Public webhooks timer failed");
    }
  }
}
