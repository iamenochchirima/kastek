import { workerSpan } from "../observability/operations.js";
import type { Pool } from "pg";
import {
  processDueSocialPublishJobs,
  type SocialExecutionOptions,
} from "../services/social/publishing.js";
import { socialWorkerInteger, socialWorkerSleep } from "./social-insights.js";
interface Log {
  info(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}
export async function runSocialPublishing(
  pool: Pool,
  env: Record<string, string | undefined>,
  log: Log,
  signal?: AbortSignal,
  options: SocialExecutionOptions = {},
): Promise<void> {
  log.info(
    { event: "worker.started", worker: "social_publishing" },
    "worker started",
  );
  const poll = socialWorkerInteger(
      env.SOCIAL_PUBLISH_POLL_INTERVAL_MS,
      10000n,
      true,
    ),
    batch = socialWorkerInteger(env.SOCIAL_PUBLISH_BATCH_SIZE, 10n);
  while (!signal?.aborted) {
    try {
      const count = await workerSpan("social_publishing.process_batch", () =>
        processDueSocialPublishJobs(pool, Number(batch), {
          ...options,
          log,
        }),
      );
      if (count > 0)
        log.info(
          {
            event: "queue.item.completed",
            worker: "social_publishing",
            items: count,
          },
          "worker batch completed",
        );
    } catch (error) {
      log.error(
        {
          event: "queue.item.failed",
          worker: "social_publishing",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "worker batch failed",
      );
    }
    await socialWorkerSleep(poll, signal);
  }
}
