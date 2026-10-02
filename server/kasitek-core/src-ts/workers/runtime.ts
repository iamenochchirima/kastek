import type { CoreContext } from "../context.js";
import { publishInboxEvent } from "../services/realtime.js";
import { runWhatsappInbox } from "./whatsapp-inbox.js";
import { runEmailInbox } from "./email-inbox.js";
import { runSocialPublishing } from "./social-publishing.js";
import { runSocialInsights } from "./social-insights.js";
import { runWhatsappCampaigns } from "./whatsapp-campaigns.js";
import { runPublicWebhooks } from "./public-webhooks.js";
import { runBillingReconciliation } from "./billing-reconciliation.js";
import { runAnalyticsPublisher } from "../analytics/publisher.js";
import { runAnalyticsBackfill } from "./analytics-backfill.js";

export interface WorkerLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}
export const API_WORKERS = [
  "whatsapp_inbox",
  "email_inbox",
  "social_publishing",
  "social_insights",
  "whatsapp_campaigns",
  "public_webhooks",
  "billing_reconciliation",
] as const;
export const ALL_WORKERS = [
  ...API_WORKERS,
  "analytics_publisher",
  "analytics_backfill",
] as const;
export type WorkerName = (typeof ALL_WORKERS)[number];
export type WorkerRunner = (signal: AbortSignal) => Promise<void>;
export type WorkerRunners = Record<WorkerName, WorkerRunner>;
const PROCESSES: Record<string, readonly WorkerName[]> = {
  "social-publishing-worker": ["social_publishing"],
  "social-insights-worker": ["social_insights"],
  "whatsapp-marketing-worker": ["whatsapp_campaigns"],
  "whatsapp-inbox-worker": ["whatsapp_inbox"],
  "email-inbox-worker": ["email_inbox"],
  "billing-reconciliation-worker": ["billing_reconciliation"],
  "analytics-publisher": ["analytics_publisher", "analytics_backfill"],
  "analytics-backfill-worker": ["analytics_backfill"],
  "public-webhooks-worker": ["public_webhooks"],
  "all-workers": ALL_WORKERS,
};

/** The Rust entrypoint falls back to API for absent or unrecognized process names. */
export function processWorkers(
  mode: string | undefined,
): readonly WorkerName[] | undefined {
  return mode === undefined
    ? undefined
    : Object.hasOwn(PROCESSES, mode)
      ? PROCESSES[mode]
      : undefined;
}
export function apiWorkersEnabled(value: string | undefined): boolean {
  return !["1", "true", "yes", "on"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

export function createWorkerRunners(
  core: CoreContext,
  log: WorkerLogger,
): WorkerRunners {
  const { pool, config } = core;
  return {
    whatsapp_inbox: (signal) => runWhatsappInbox(core, log, signal),
    email_inbox: (signal) => runEmailInbox(pool, config, log, signal),
    social_publishing: (signal) =>
      runSocialPublishing(pool, config.rawEnv, log, signal, { config }),
    social_insights: (signal) =>
      runSocialInsights(pool, config.rawEnv, log, signal, { config }),
    whatsapp_campaigns: (signal) =>
      runWhatsappCampaigns(
        pool,
        config,
        signal,
        (orgId, event) => publishInboxEvent(core, orgId, event, log),
        log,
      ),
    public_webhooks: (signal) => runPublicWebhooks(pool, config, signal, log),
    billing_reconciliation: (signal) =>
      runBillingReconciliation(pool, config, signal, log),
    analytics_publisher: (signal) =>
      runAnalyticsPublisher(pool, config.rawEnv, log, signal),
    analytics_backfill: (signal) =>
      runAnalyticsBackfill(pool, config.rawEnv, log, signal),
  };
}

/** Wait for every worker to release its DB/provider work before closing the pool. */
export async function runWorkerGroup(
  names: readonly WorkerName[],
  runners: WorkerRunners,
  controller: AbortController,
  log: WorkerLogger,
): Promise<void> {
  const results = await Promise.allSettled(
    names.map(async (name) => {
      try {
        await runners[name](controller.signal);
      } catch (error) {
        log.error(
          {
            event: "worker.failed",
            worker: name,
            error_type: error instanceof Error ? error.name : "unknown",
          },
          "worker terminated",
        );
        controller.abort();
        throw error;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
