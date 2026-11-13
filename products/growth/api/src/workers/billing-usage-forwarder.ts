import type { Pool } from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import type { CoreConfig } from "../config.js";
import { workerSpan } from "../observability/operations.js";
import { billingServiceConfig } from "../services/billing-service.js";
import { forwardPendingUsage } from "../services/billing.js";
import { pullGrowthAgentUsage } from "../agents/usage-pull.js";
import type { WorkerLogger } from "./runtime.js";

export async function runBillingUsageForwarder(
  pool: Pool,
  core: CoreConfig,
  log: WorkerLogger,
  signal: AbortSignal,
): Promise<void> {
  const config = billingServiceConfig(process.env);
  if (!config) {
    log.warn({
      event: "worker.disabled",
      worker: "billing_usage_forwarder",
      reason: "billing_not_configured",
    });
    return;
  }
  log.info({ event: "worker.started", worker: "billing_usage_forwarder" });
  while (!signal.aborted) {
    try {
      const recorded = await workerSpan("billing_usage_forwarder.pull_agent_usage", () =>
        pullGrowthAgentUsage(pool, core, 100),
      );
      if (recorded > 0)
        log.info({
          event: "queue.item.completed",
          worker: "billing_usage_forwarder",
          recorded,
        });
      const forwarded = await workerSpan("billing_usage_forwarder.process_batch", () =>
        forwardPendingUsage(pool, config, 100),
      );
      if (forwarded > 0)
        log.info({
          event: "queue.item.completed",
          worker: "billing_usage_forwarder",
          forwarded,
        });
    } catch (error) {
      log.error({
        event: "queue.item.failed",
        worker: "billing_usage_forwarder",
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      await sleep(15_000, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("Billing usage forwarder timer failed");
    }
  }
}
