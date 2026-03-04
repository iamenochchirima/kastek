import { Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { processWhatsappWebhookChange } from "../lib/whatsapp/webhook-service";
import { WHATSAPP_WEBHOOK_QUEUE_NAME } from "../lib/whatsapp/queue";
import type { QueueWebhookJobData } from "../lib/whatsapp/types";

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
  async (job: { data: QueueWebhookJobData }) => {
    await processWhatsappWebhookChange(job.data);
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
