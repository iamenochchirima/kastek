import { workerSpan } from "../observability/operations.js";
import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import { setTimeout as sleep } from "node:timers/promises";
import { processQueuedCampaignRecipients } from "../services/whatsapp/campaigns.js";
import {
  envInteger,
  type MarketingOptions,
} from "../services/whatsapp/common.js";
export async function runWhatsappCampaigns(
  pool: Pool,
  config: CoreConfig,
  signal: AbortSignal,
  publishEvent: MarketingOptions["publishEvent"],
  logger: Pick<Console, "info" | "error"> = console,
): Promise<void> {
  const interval = envInteger(
      config,
      "WHATSAPP_MARKETING_POLL_INTERVAL_MS",
      5000,
      true,
    ),
    batch = envInteger(config, "WHATSAPP_MARKETING_BATCH_SIZE", 25);
  logger.info({ event: "worker.started", worker: "whatsapp_campaigns" });
  while (!signal.aborted) {
    try {
      const processed = await workerSpan(
        "whatsapp_campaigns.process_batch",
        () =>
          processQueuedCampaignRecipients(pool, batch, {
            config,
            publishEvent,
          }),
      );
      if (processed > 0)
        logger.info({
          event: "queue.item.completed",
          worker: "whatsapp_campaigns",
          items: processed,
        });
    } catch (error) {
      logger.error({
        event: "queue.item.failed",
        worker: "whatsapp_campaigns",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      await sleep(interval, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("WhatsApp campaigns timer failed");
    }
  }
}
