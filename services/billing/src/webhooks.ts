import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { BillingConfig } from "./config.js";
import { paystackEventKey, type BillingProvider } from "./paystack.js";
import { processProviderEvent, recordIssue } from "./subscriptions.js";
import { jsonObject, optionalText } from "./util.js";

export async function recordWebhookEvent(
  pool: Pool,
  provider: string,
  eventKey: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO billing.webhook_events(
       id, provider, event_key, event_type, payload, status, processed_at
     ) VALUES($1,$2,$3,$4,$5,'processing',now())
     ON CONFLICT (event_key) DO NOTHING`,
    [`whe_${randomUUID()}`, provider, eventKey, eventType, JSON.stringify(payload)],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function finishWebhookEvent(
  pool: Pool,
  provider: string,
  eventKey: string,
  status: "processed" | "ignored" | "failed",
  error: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE billing.webhook_events
        SET status=$3, error_message=$4, processed_at=now()
      WHERE provider=$1 AND event_key=$2`,
    [provider, eventKey, status, error],
  );
}

export async function processStoredWebhook(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  eventKey: string,
  payload: unknown,
): Promise<boolean> {
  try {
    const event = provider.parseWebhook(payload);
    const processed = await processProviderEvent(pool, config, provider, event);
    await finishWebhookEvent(
      pool,
      provider.name,
      eventKey,
      processed ? "processed" : "ignored",
      null,
    );
    return processed;
  } catch (error) {
    await finishWebhookEvent(
      pool,
      provider.name,
      eventKey,
      "failed",
      error instanceof Error ? error.message.slice(0, 1000) : "Webhook failed",
    );
    throw error;
  }
}

export async function handleWebhook(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  payload: unknown,
): Promise<{ received: boolean; duplicate: boolean; processed: boolean }> {
  const event = jsonObject(payload);
  const eventType = optionalText(event.event) ?? "unknown";
  const eventKey = paystackEventKey(payload);
  if (!(await recordWebhookEvent(pool, provider.name, eventKey, eventType, payload)))
    return { received: true, duplicate: true, processed: true };
  const processed = await processStoredWebhook(
    pool,
    config,
    provider,
    eventKey,
    payload,
  );
  return { received: true, duplicate: false, processed };
}

export async function retryFailedWebhooks(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  limit = 100,
): Promise<number> {
  const rows = await pool.query<{ event_key: string; payload: unknown }>(
    `SELECT event_key, payload FROM billing.webhook_events
      WHERE status IN ('received','failed')
         OR (status='processing' AND processed_at < now() - interval '10 minutes')
      ORDER BY received_at LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  let processed = 0;
  for (const row of rows.rows) {
    try {
      const claimed = await pool.query(
        `UPDATE billing.webhook_events
            SET status='processing', processed_at=now(), error_message=NULL
          WHERE event_key=$1
            AND (status IN ('received','failed')
              OR (status='processing' AND processed_at < now() - interval '10 minutes'))`,
        [row.event_key],
      );
      if (!claimed.rowCount) continue;
      await processStoredWebhook(pool, config, provider, row.event_key, row.payload);
      processed++;
    } catch (error) {
      await recordIssue(pool, {
        billingAccountId: null,
        provider: provider.name,
        resourceType: "webhook",
        resourceId: row.event_key,
        issueType: "webhook_retry_failed",
        details: {
          error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        },
      });
    }
  }
  return processed;
}
