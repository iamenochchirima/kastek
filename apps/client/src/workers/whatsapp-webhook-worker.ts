import { Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { processWhatsappWebhookChange } from "../lib/whatsapp/webhook-service";
import { WHATSAPP_WEBHOOK_QUEUE_NAME } from "../lib/whatsapp/queue";
import type { QueueWebhookJobData } from "../lib/whatsapp/types";
const WEBHOOK_DEBUG = process.env.WHATSAPP_WEBHOOK_DEBUG === "1";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is required to run whatsapp webhook worker");
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function getBullConnection() {
  return connection as unknown as ConnectionOptions;
}

const worker = new Worker<QueueWebhookJobData>(
  WHATSAPP_WEBHOOK_QUEUE_NAME,
  async (job: { id?: string; data: QueueWebhookJobData }) => {
    if (WEBHOOK_DEBUG) {
      console.info("[whatsapp:webhook:worker] start", {
        jobId: job.id,
        field: job.data.field || "unknown",
        valueKeys: Object.keys(job.data.value || {}),
        messageCount: Array.isArray(job.data.value?.messages)
          ? (job.data.value.messages as unknown[]).length
          : 0,
        statusCount: Array.isArray(job.data.value?.statuses)
          ? (job.data.value.statuses as unknown[]).length
          : 0,
      });
    }

    await processWhatsappWebhookChange(job.data);

    if (WEBHOOK_DEBUG) {
      console.info("[whatsapp:webhook:worker] done", {
        jobId: job.id,
        field: job.data.field || "unknown",
      });
    }
  },
  {
    connection: getBullConnection(),
    concurrency: 20,
  }
);

worker.on("ready", () => {
  console.log(`[whatsapp-webhook-worker] ready queue=${WHATSAPP_WEBHOOK_QUEUE_NAME}`);
});

worker.on("failed", (job: { id?: string } | undefined, err: unknown) => {
  console.error(`[whatsapp-webhook-worker] job failed id=${job?.id}`, err);
});

process.on("SIGTERM", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
