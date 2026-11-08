import type { Pool } from "pg";
import { BillingClient } from "@kasitek-labs/server-support/billing-client";
import type { Log } from "./analytics-publisher.js";
import { workerSleep } from "./analytics-publisher.js";
import {
  forwardAgencyUsageRow,
  type AgencyUsageOutboxRow,
} from "./capabilities/billing.js";

type Env = Record<string, string | undefined>;

function interval(env: Env): number {
  const parsed = Number(env.AGENCY_BILLING_USAGE_POLL_INTERVAL_MS ?? 5000);
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : 5000;
}

export async function runBillingUsageForwarder(
  pool: Pool,
  env: Env,
  log: Log,
  signal?: AbortSignal,
): Promise<void> {
  const client = BillingClient.fromEnvironment("agency", env);
  if (!client) {
    log.warn(
      {
        event: "worker.disabled",
        worker: "agency_billing_usage",
        reason: "missing_billing_configuration",
      },
      "agency billing usage forwarding disabled",
    );
    return;
  }
  log.info(
    { event: "worker.started", worker: "agency_billing_usage" },
    "agency billing usage forwarder started",
  );
  while (!signal?.aborted) {
    try {
      const rows = await pool.query<AgencyUsageOutboxRow>(
        `SELECT id, tenant_id, meter_key, quantity::text,
                source_type, source_id, idempotency_key, attempts
           FROM billing_usage_outbox
          WHERE delivered_at IS NULL AND next_attempt_at<=now()
          ORDER BY next_attempt_at, created_at
          LIMIT 50`,
      );
      for (const row of rows.rows) {
        if (signal?.aborted) break;
        const delivered = await forwardAgencyUsageRow(pool, client, row);
        if (!delivered)
          log.warn(
            {
              event: "billing.usage.forward_failed",
              worker: "agency_billing_usage",
              outboxId: row.id,
              tenantId: row.tenant_id,
              attempts: row.attempts + 1,
            },
            "agency billing usage forward failed",
          );
      }
    } catch (error) {
      log.error(
        {
          event: "worker.failed",
          worker: "agency_billing_usage",
          error: error instanceof Error ? error.message : "unknown",
        },
        "agency billing usage forwarder failed",
      );
    }
    await workerSleep(interval(env), signal);
  }
}
