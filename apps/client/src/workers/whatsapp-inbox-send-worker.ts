import { Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../lib/prisma";
import { decryptSecret } from "../lib/whatsapp/crypto";
import { parseWhatsappConversationIdentifier } from "../lib/whatsapp/inbox";
import { sendTextMessage } from "../lib/whatsapp/meta-api";
import { WHATSAPP_INBOX_SEND_QUEUE_NAME } from "../lib/whatsapp/queue";
import { publishWhatsappRealtimeEvent } from "../lib/whatsapp/realtime";
import type { QueueInboxSendJobData } from "../lib/whatsapp/types";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is required to run whatsapp inbox send worker");
}

const sendRatePerSecond = Number(process.env.WHATSAPP_SERVICE_SEND_RATE_PER_SECOND || "20");

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function getBullConnection() {
  return connection as unknown as ConnectionOptions;
}

const worker = new Worker<QueueInboxSendJobData>(
  WHATSAPP_INBOX_SEND_QUEUE_NAME,
  async (job: { data: QueueInboxSendJobData }) => {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: job.data.conversationId,
        channel: "whatsapp",
      },
      select: {
        id: true,
        customerIdentifier: true,
        customerName: true,
      },
    });

    if (!conversation) {
      return;
    }

    const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
    if (!parsed) {
      throw new Error("Invalid WhatsApp conversation identifier");
    }

    const connectionRecord = await prisma.whatsappConnection.findFirst({
      where: {
        id: parsed.connectionId,
        userId: job.data.userId,
      },
      select: {
        id: true,
        phoneNumberId: true,
        accessTokenEncrypted: true,
      },
    });

    if (!connectionRecord) {
      throw new Error("WhatsApp connection not found");
    }

    const accessToken = decryptSecret(connectionRecord.accessTokenEncrypted);
    const sendResult = await sendTextMessage({
      phoneNumberId: connectionRecord.phoneNumberId,
      accessToken,
      recipientPhone: parsed.phone,
      text: job.data.text,
    });

    const createdMessage = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          sender: "bot",
          content: job.data.text,
          whatsappMessageId: sendResult.messageId,
          whatsappStatus: "SENT",
        },
      });

      await tx.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessageAt: new Date(),
          status: "active",
        },
      });

      return created;
    });

    await publishWhatsappRealtimeEvent(job.data.userId, {
      type: "message.created",
      conversationId: conversation.id,
      conversation: {
        customerName: null,
      },
      message: {
        id: createdMessage.id,
        sender: "bot",
        content: createdMessage.content,
        timestamp: createdMessage.timestamp.toISOString(),
        whatsappStatus: "SENT",
      },
    });

    await publishWhatsappRealtimeEvent(job.data.userId, {
      type: "conversation.updated",
      conversationId: conversation.id,
      conversation: {
        id: conversation.id,
        customerName: conversation.customerName,
        phone: parsed.phone,
        lastMessageAt: createdMessage.timestamp.toISOString(),
        unreadCount: 0,
      },
    });
  },
  {
    connection: getBullConnection(),
    concurrency: 10,
    limiter: {
      max: sendRatePerSecond,
      duration: 1000,
    },
  }
);

worker.on("ready", () => {
  console.log(`[whatsapp-inbox-send-worker] ready queue=${WHATSAPP_INBOX_SEND_QUEUE_NAME}`);
});

worker.on("failed", async (job: { data: QueueInboxSendJobData } | undefined, err: unknown) => {
  console.error(
    `[whatsapp-inbox-send-worker] job failed conversation=${job?.data.conversationId}`,
    err
  );

  if (!job) return;

  await publishWhatsappRealtimeEvent(job.data.userId, {
    type: "message.send_failed",
    conversationId: job.data.conversationId,
    error: err instanceof Error ? err.message : "Failed to send WhatsApp reply",
    text: job.data.text,
  });
});

process.on("SIGTERM", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
