import { Worker } from "bullmq";
import IORedis from "ioredis";
import type { Prisma } from "@kasiai/database";
import { prisma } from "../lib/prisma";
import {
  buildBodyParameters,
  isContactEligibleForMarketing,
  recomputeWhatsappCampaignStats,
} from "../lib/whatsapp/campaign-service";
import { decryptSecret } from "../lib/whatsapp/crypto";
import { sendMarketingTemplate } from "../lib/whatsapp/meta-api";
import {
  WHATSAPP_MARKETING_QUEUE_NAME,
} from "../lib/whatsapp/queue";
import type { QueueSendJobData } from "../lib/whatsapp/types";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is required to run whatsapp marketing worker");
}

const sendRatePerSecond = Number(process.env.WHATSAPP_SEND_RATE_PER_SECOND || "30");

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function parseFailure(error: unknown): { code?: string; message: string; blocked: boolean } {
  if (error instanceof Error) {
    const message = error.message;
    const lower = message.toLowerCase();
    const blocked =
      lower.includes("blocked") ||
      lower.includes("131026") ||
      lower.includes("131048");

    return {
      message,
      blocked,
    };
  }

  return {
    message: "Unknown send error",
    blocked: false,
  };
}

const worker = new Worker<QueueSendJobData>(
  WHATSAPP_MARKETING_QUEUE_NAME,
  async (job: { data: QueueSendJobData }) => {
    const recipient = await prisma.whatsappCampaignRecipient.findUnique({
      where: { id: job.data.recipientId },
      include: {
        campaign: {
          include: {
            connection: true,
            template: true,
          },
        },
        contact: true,
      },
    });

    if (!recipient) {
      return;
    }

    if (!["QUEUED", "PENDING", "FAILED"].includes(recipient.status)) {
      return;
    }

    const eligibility = isContactEligibleForMarketing(recipient.contact);
    if (!eligibility.eligible) {
      await prisma.$transaction(async (tx) => {
        await tx.whatsappCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: eligibility.reason === "excluded" ? "UNSUBSCRIBED" : "SKIPPED",
            errorCode: eligibility.reason,
            errorMessage: "Recipient no longer matches marketing safety requirements",
          },
        });

        await tx.whatsappSendEvent.create({
          data: {
            userId: recipient.campaign.userId,
            connectionId: recipient.campaign.connectionId,
            campaignId: recipient.campaignId,
            recipientId: recipient.id,
            contactId: recipient.contactId,
            phone: recipient.contact.phone,
            templateName: recipient.campaign.templateName,
            status: eligibility.reason === "excluded" ? "UNSUBSCRIBED" : "SKIPPED",
            errorCode: eligibility.reason,
            errorMessage: "Recipient no longer matches marketing safety requirements",
          },
        });
      });

      await recomputeWhatsappCampaignStats(recipient.campaignId);
      return;
    }

    const accessToken = decryptSecret(recipient.campaign.connection.accessTokenEncrypted);
    const variableMappings =
      (recipient.campaign.variableMappings as
        | Array<{ source: "static" | "contact"; key: string }>
        | null) || null;

    const bodyParameters = buildBodyParameters(
      {
        fullName: recipient.contact.fullName,
        phone: recipient.contact.phone,
        location: recipient.contact.location,
        tags: recipient.contact.tags,
      },
      variableMappings
    );

    try {
      const sendResult = await sendMarketingTemplate({
        phoneNumberId: recipient.campaign.connection.phoneNumberId,
        accessToken,
        recipientPhone: recipient.contact.phone,
        templateName: recipient.campaign.templateName,
        language: recipient.campaign.templateLanguage,
        bodyParameters,
      });

      await prisma.$transaction(async (tx) => {
        await tx.whatsappCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "SENT",
            waMessageId: sendResult.messageId,
            sentAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });

        await tx.whatsappContact.update({
          where: {
            userId_phone: {
              userId: recipient.campaign.userId,
              phone: recipient.contact.phone,
            },
          },
          data: {
            lastMarketingSent: new Date(),
          },
        });

        await tx.whatsappSendEvent.create({
          data: {
            userId: recipient.campaign.userId,
            connectionId: recipient.campaign.connectionId,
            campaignId: recipient.campaignId,
            recipientId: recipient.id,
            contactId: recipient.contactId,
            phone: recipient.contact.phone,
            templateName: recipient.campaign.templateName,
            status: "SENT",
            whatsappMessageId: sendResult.messageId,
            requestPayload: {
              templateName: recipient.campaign.templateName,
              language: recipient.campaign.templateLanguage,
              bodyParameters,
            } as unknown as Prisma.InputJsonValue,
            responsePayload: sendResult.raw as Prisma.InputJsonValue,
          },
        });
      });
    } catch (error) {
      const failure = parseFailure(error);
      const status = failure.blocked ? "BLOCKED" : "FAILED";

      await prisma.$transaction(async (tx) => {
        await tx.whatsappCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status,
            failedAt: new Date(),
            errorCode: failure.code || null,
            errorMessage: failure.message,
          },
        });

        await tx.whatsappSendEvent.create({
          data: {
            userId: recipient.campaign.userId,
            connectionId: recipient.campaign.connectionId,
            campaignId: recipient.campaignId,
            recipientId: recipient.id,
            contactId: recipient.contactId,
            phone: recipient.contact.phone,
            templateName: recipient.campaign.templateName,
            status,
            errorCode: failure.code || null,
            errorMessage: failure.message,
          },
        });
      });
    } finally {
      await recomputeWhatsappCampaignStats(recipient.campaignId);
    }
  },
  {
    connection,
    concurrency: 20,
    limiter: {
      max: sendRatePerSecond,
      duration: 1000,
    },
  }
);

worker.on("ready", () => {
  console.log(
    `[whatsapp-marketing-worker] ready queue=${WHATSAPP_MARKETING_QUEUE_NAME} rate=${sendRatePerSecond}/s`
  );
});

worker.on("failed", (job: { id?: string; data: QueueSendJobData } | undefined, err: unknown) => {
  console.error(
    `[whatsapp-marketing-worker] job failed id=${job?.id} campaign=${job?.data.campaignId} recipient=${job?.data.recipientId}`,
    err
  );
});

process.on("SIGTERM", async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
