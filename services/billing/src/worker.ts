import type { Pool } from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import type { BillingConfig } from "./config.js";
import { activateCheckout } from "./subscriptions.js";
import { expireTrialsAndGrace, reconcileSubscription } from "./subscriptions.js";
import { expireCreditGrants } from "./credits.js";
import { retryFailedWebhooks } from "./webhooks.js";
import type { BillingProvider } from "./paystack.js";
import type { CheckoutRow } from "./types.js";
import { jsonObject } from "./util.js";

export async function runWorker(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  signal: AbortSignal,
  logger: Pick<Console, "info" | "error"> = console,
): Promise<void> {
  const lock = await pool.connect();
  const locked = await lock.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext('kasitek-billing-worker')) AS locked`,
  );
  if (!locked.rows[0]?.locked) {
    lock.release();
    logger.info({ event: "worker.disabled", worker: "billing", reason: "already_running" });
    return;
  }
  logger.info({ event: "worker.started", worker: "billing", provider: provider.name });
  try {
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const webhooks = await retryFailedWebhooks(
          pool,
          config,
          provider,
          config.reconciliationBatchSize,
        );
        const expiredCredits = await expireCreditGrants(
          pool,
          config.reconciliationBatchSize,
        );
        const lifecycle = await expireTrialsAndGrace(pool, config);
        const checkouts = await reconcilePendingCheckouts(
          pool,
          config,
          provider,
          config.reconciliationBatchSize,
        );
        const subscriptions = await reconcileSubscriptions(
          pool,
          provider,
          config.reconciliationBatchSize,
        );
        const result = {
          webhooks,
          expiredCredits,
          trialsExpired: lifecycle.trialsExpired,
          graceExpired: lifecycle.graceExpired,
          checkouts,
          subscriptions,
          durationMs: Date.now() - started,
        };
        if (Object.values(result).some((value) => typeof value === "number" && value > 0))
          logger.info({ event: "queue.item.completed", worker: "billing", ...result });
      } catch (error) {
        logger.error({
          event: "queue.item.failed",
          worker: "billing",
          error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        });
      }
      try {
        await sleep(config.reconciliationIntervalSeconds * 1000, undefined, {
          signal,
        });
      } catch {
        if (!signal.aborted) throw new Error("Billing worker timer failed");
      }
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('kasitek-billing-worker'))`).catch(() => {});
    lock.release();
  }
}

async function reconcilePendingCheckouts(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  limit: number,
): Promise<number> {
  const rows = await pool.query<CheckoutRow>(
    `SELECT id, reference, idempotency_key, billing_account_id, plan_version_id,
            product_key, provider, status, authorization_url, return_url,
            expected_amount_minor::text, expected_currency, expected_tax_inclusive,
            expected_tax_rate_bps, provider_transaction_id, provider_response,
            completed_at, created_at, updated_at
       FROM billing.checkouts
      WHERE provider=$1 AND status='pending' AND created_at < now() - interval '5 minutes'
      ORDER BY created_at LIMIT $2`,
    [provider.name, Math.min(500, Math.max(1, limit))],
  );
  let completed = 0;
  for (const checkout of rows.rows) {
    try {
      const verification = await provider.verifyTransaction(checkout.reference);
      const response = jsonObject(checkout.provider_response);
      if (verification.successful) {
        await activateCheckout(pool, config, provider, checkout, verification);
        completed++;
      } else if (
        typeof response.reference === "string" &&
        verification.reference !== checkout.reference
      ) {
        await pool.query(
          `UPDATE billing.checkouts SET status='failed', updated_at=now() WHERE id=$1`,
          [checkout.id],
        );
      }
    } catch {
      // Leave pending. A provider outage must not turn a checkout into a
      // terminal failure; the next reconciliation pass retries it.
    }
  }
  return completed;
}

async function reconcileSubscriptions(
  pool: Pool,
  provider: BillingProvider,
  limit: number,
): Promise<number> {
  const rows = await pool.query<{ id: string }>(
    `SELECT id FROM billing.subscriptions
      WHERE provider=$1 AND provider_subscription_id IS NOT NULL
        AND status IN ('trialing','active','past_due','grace')
      ORDER BY updated_at LIMIT $2`,
    [provider.name, Math.min(500, Math.max(1, limit))],
  );
  let updated = 0;
  for (const row of rows.rows) {
    try {
      const result = await reconcileSubscription(pool, provider, row.id);
      if (result.updated) updated++;
    } catch {
      // The subscription remains in its local state; a later pass retries.
    }
  }
  return updated;
}
