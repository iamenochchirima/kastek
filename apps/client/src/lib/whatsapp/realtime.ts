import IORedis from "ioredis";
import type { WhatsappRealtimeEvent } from "./types";

const globalForRealtime = globalThis as unknown as {
  whatsappRealtimeRedis: IORedis | undefined;
};

function getRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for WhatsApp realtime");
  }

  return redisUrl;
}

function getRealtimeRedisBase() {
  if (globalForRealtime.whatsappRealtimeRedis) {
    return globalForRealtime.whatsappRealtimeRedis;
  }

  const connection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  if (process.env.NODE_ENV !== "production") {
    globalForRealtime.whatsappRealtimeRedis = connection;
  }

  return connection;
}

export function buildWhatsappUserChannel(userId: string) {
  return `whatsapp:user:${userId}`;
}

export async function publishWhatsappRealtimeEvent(userId: string, event: WhatsappRealtimeEvent) {
  const redis = getRealtimeRedisBase();
  await redis.publish(buildWhatsappUserChannel(userId), JSON.stringify(event));
}

export function createWhatsappRealtimeSubscriber() {
  return getRealtimeRedisBase().duplicate();
}
