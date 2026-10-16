import { workerSpan } from "../observability/operations.js";
import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreConfig } from "../config.js";
import { syncAllConnections } from "../services/email/sync.js";
import type { HttpFetch } from "../integrations/email.js";
interface Log {
  info(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
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
  const n = BigInt(value);
  return n < (unsigned ? 0n : -(1n << 63n)) ||
    n >= (unsigned ? 1n << 64n : 1n << 63n)
    ? fallback
    : n;
}
async function sleep(milliseconds: bigint, signal?: AbortSignal) {
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
export async function runEmailInbox(
  pool: Pool,
  config: CoreConfig,
  log: Log,
  signal?: AbortSignal,
  http: HttpFetch = fetch,
): Promise<void> {
  log.info(
    { event: "worker.started", worker: "email_inbox" },
    "worker started",
  );
  const interval = integer(
      config.rawEnv.EMAIL_INBOX_POLL_INTERVAL_MS,
      30000n,
      true,
    ),
    batch = integer(config.rawEnv.EMAIL_INBOX_BATCH_SIZE, 10n);
  while (!signal?.aborted) {
    try {
      const count = await workerSpan("email_inbox.process_batch", () =>
        syncAllConnections(pool, config, Number(batch), http),
      );
      if (count > 0)
        log.info(
          {
            event: "queue.item.completed",
            worker: "email_inbox",
            items: count,
          },
          "email Inbox sync batch completed",
        );
    } catch (error) {
      log.error(
        {
          event: "queue.item.failed",
          worker: "email_inbox",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "email Inbox sync batch failed",
      );
    }
    await sleep(interval, signal);
  }
}
