import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import type { QueueInboxSendJobData, QueueSendJobData, QueueWebhookJobData } from "./types";

export const WHATSAPP_MARKETING_QUEUE_NAME = "whatsapp-marketing-sends";
export const WHATSAPP_INBOX_SEND_QUEUE_NAME = "whatsapp-inbox-sends";
export const WHATSAPP_WEBHOOK_QUEUE_NAME = "whatsapp-webhook-events";

const globalForQueue = globalThis as unknown as {
  whatsappRedis: IORedis | undefined;
  whatsappMarketingQueue: Queue<QueueSendJobData> | undefined;
  whatsappInboxSendQueue: Queue<QueueInboxSendJobData> | undefined;
  whatsappWebhookQueue: Queue<QueueWebhookJobData> | undefined;
};

function getRedisConnection(): IORedis {
  if (globalForQueue.whatsappRedis) {
    return globalForQueue.whatsappRedis;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for WhatsApp marketing queue");
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  if (process.env.NODE_ENV !== "production") {
    globalForQueue.whatsappRedis = connection;
  }

  return connection;
}

function getBullConnection() {
  // BullMQ and the app can end up resolving slightly different ioredis types at build time.
  // The runtime object is still a valid Redis connection.
  return getRedisConnection() as unknown as ConnectionOptions;
}

export function getWhatsappMarketingQueue(): Queue<QueueSendJobData> {
  if (globalForQueue.whatsappMarketingQueue) {
    return globalForQueue.whatsappMarketingQueue;
  }

  const queue = new Queue<QueueSendJobData>(WHATSAPP_MARKETING_QUEUE_NAME, {
    connection: getBullConnection(),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 1000,
      removeOnFail: 1000,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    },
  });

  if (process.env.NODE_ENV !== "production") {
    globalForQueue.whatsappMarketingQueue = queue;
  }

  return queue;
}

export function getWhatsappInboxSendQueue(): Queue<QueueInboxSendJobData> {
  if (globalForQueue.whatsappInboxSendQueue) {
    return globalForQueue.whatsappInboxSendQueue;
  }

  const queue = new Queue<QueueInboxSendJobData>(WHATSAPP_INBOX_SEND_QUEUE_NAME, {
    connection: getBullConnection(),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 1000,
      removeOnFail: 1000,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    },
  });

  if (process.env.NODE_ENV !== "production") {
    globalForQueue.whatsappInboxSendQueue = queue;
  }

  return queue;
}

export function getWhatsappWebhookQueue(): Queue<QueueWebhookJobData> {
  if (globalForQueue.whatsappWebhookQueue) {
    return globalForQueue.whatsappWebhookQueue;
  }

  const queue = new Queue<QueueWebhookJobData>(WHATSAPP_WEBHOOK_QUEUE_NAME, {
    connection: getBullConnection(),
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 1000,
      removeOnFail: 1000,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    },
  });

  if (process.env.NODE_ENV !== "production") {
    globalForQueue.whatsappWebhookQueue = queue;
  }

  return queue;
}
