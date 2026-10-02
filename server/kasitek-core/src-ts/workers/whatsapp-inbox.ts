import type { CoreContext } from "../context.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  processQueuedInboxMessages,
  createInboxDeliveryOptions,
  type InboxDeliveryOptions,
} from "../services/whatsapp/inbox-queue.js";

interface Logger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}
function integer(
  value: string | undefined,
  fallback: bigint,
  unsigned = false,
): bigint {
  if (
    value === undefined ||
    !(unsigned ? /^\+?\d+$/ : /^[+-]?\d+$/).test(value)
  )
    return fallback;
  const parsed = BigInt(value);
  return parsed < (unsigned ? 0n : -(1n << 63n)) ||
    parsed >= (unsigned ? 1n << 64n : 1n << 63n)
    ? fallback
    : parsed;
}
async function sleep(
  milliseconds: bigint,
  signal?: AbortSignal,
): Promise<void> {
  do {
    const chunk = milliseconds > 2147483647n ? 2147483647n : milliseconds;
    try {
      await delay(Number(chunk), undefined, { signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      throw error;
    }
    milliseconds -= chunk;
  } while (milliseconds > 0n && !signal?.aborted);
}
export async function runWhatsappInbox(
  context: CoreContext,
  logger: Logger,
  signal?: AbortSignal,
  options: InboxDeliveryOptions = createInboxDeliveryOptions(context),
): Promise<void> {
  logger.info({ event: "worker.started", worker: "whatsapp_inbox" });
  const interval = integer(
    context.config.rawEnv.WHATSAPP_INBOX_POLL_INTERVAL_MS,
    1000n,
    true,
  );
  const batch = integer(context.config.rawEnv.WHATSAPP_INBOX_BATCH_SIZE, 50n);
  while (!signal?.aborted) {
    try {
      const processed = await processQueuedInboxMessages(
        context,
        Number(batch),
        options,
      );
      if (processed > 0)
        logger.info({
          event: "queue.item.completed",
          worker: "whatsapp_inbox",
          items: processed,
        });
    } catch (error) {
      logger.error({
        event: "queue.item.failed",
        worker: "whatsapp_inbox",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    await sleep(interval, signal);
  }
}
