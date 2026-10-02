import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import { reconcileBilling } from "../services/billing.js";
import { referralRewardConfig } from "../services/referrals.js";
import { paystackProvider } from "../routes/billing.js";
export async function runBillingReconciliation(
  pool: Pool,
  config: CoreConfig,
  signal: AbortSignal,
  logger: Pick<Console, "info" | "error"> = console,
): Promise<void> {
  let provider;
  try {
    provider = paystackProvider({ pool, config });
  } catch {
    logger.info({
      event: "worker.disabled",
      worker: "billing_reconciliation",
      reason: "paystack_not_configured",
    });
    return;
  }
  const parse = (value: string | undefined, fallback: number) =>
      value && /^\+?\d+$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : fallback,
    interval =
      Math.max(
        30,
        parse(config.env.PAYSTACK_RECONCILIATION_INTERVAL_SECONDS, 300),
      ) * 1000,
    batch = Number(config.env.PAYSTACK_RECONCILIATION_BATCH_SIZE ?? 100);
  logger.info({
    event: "worker.started",
    worker: "billing_reconciliation",
    provider: provider.name,
  });
  while (!signal.aborted) {
    try {
      const result = await reconcileBilling(
        pool,
        provider,
        Number.isSafeInteger(batch) ? batch : 100,
        referralRewardConfig(config),
      );
      if (Number(result.checked) > 0 || Number(result.subscriptionsChecked) > 0)
        logger.info({
          event: "queue.item.completed",
          worker: "billing_reconciliation",
          ...result,
        });
    } catch (error) {
      logger.error({
        event: "queue.item.failed",
        worker: "billing_reconciliation",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      await sleep(interval, undefined, { signal });
    } catch {
      if (!signal.aborted)
        throw new Error("Billing reconciliation timer failed");
    }
  }
}
