import { prisma } from "@/lib/prisma";
import type { Prisma } from "@kasiai/database";
import type {
  CreateCampaignResult,
  CreateWhatsappCampaignInput,
  MarketingVariableMapping,
} from "./types";
import { getWhatsappMarketingQueue } from "./queue";

const MIN_MARKETING_INTERVAL_DAYS = Number(
  process.env.WHATSAPP_MARKETING_MIN_DAYS || "10"
);

function hasMarketingCooldownExpired(lastMarketingSent: Date | null | undefined): boolean {
  if (!lastMarketingSent) return true;

  const minIntervalMs = MIN_MARKETING_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - lastMarketingSent.getTime() >= minIntervalMs;
}

export function isContactEligibleForMarketing(contact: {
  optIn: boolean;
  excluded: boolean;
  lastMarketingSent: Date | null;
}) {
  if (!contact.optIn) return { eligible: false, reason: "not_opted_in" as const };
  if (contact.excluded) return { eligible: false, reason: "excluded" as const };
  if (!hasMarketingCooldownExpired(contact.lastMarketingSent)) {
    return { eligible: false, reason: "cooldown" as const };
  }

  return { eligible: true, reason: null };
}

export async function createWhatsappCampaign(
  userId: string,
  input: CreateWhatsappCampaignInput
): Promise<CreateCampaignResult> {
  if (!input.name?.trim()) {
    throw new Error("Campaign name is required");
  }

  const [connection, template] = await Promise.all([
    prisma.whatsappConnection.findFirst({
      where: {
        id: input.connectionId,
        userId,
      },
    }),
    prisma.whatsappTemplate.findFirst({
      where: {
        id: input.templateId,
        userId,
      },
    }),
  ]);

  if (!connection) {
    throw new Error("WhatsApp connection not found");
  }

  if (!template) {
    throw new Error("Template not found");
  }

  if (template.category !== "MARKETING") {
    throw new Error("Only MARKETING templates are allowed for campaigns");
  }

  if (template.status !== "APPROVED") {
    throw new Error("Only APPROVED templates can be used in campaigns");
  }

  const contacts = await prisma.whatsappContact.findMany({
    where: {
      userId,
      ...(input.recipientIds?.length
        ? {
            id: {
              in: input.recipientIds,
            },
          }
        : {}),
    },
    select: {
      id: true,
      optIn: true,
      excluded: true,
      lastMarketingSent: true,
    },
  });

  const skipped = {
    notOptedIn: 0,
    excluded: 0,
    cooldown: 0,
  };

  const eligibleContactIds: string[] = [];

  for (const contact of contacts) {
    const eligibility = isContactEligibleForMarketing(contact);
    if (eligibility.eligible) {
      eligibleContactIds.push(contact.id);
      continue;
    }

    if (eligibility.reason === "not_opted_in") skipped.notOptedIn += 1;
    if (eligibility.reason === "excluded") skipped.excluded += 1;
    if (eligibility.reason === "cooldown") skipped.cooldown += 1;
  }

  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;

  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.whatsappCampaign.create({
      data: {
        userId,
        connectionId: connection.id,
        templateId: template.id,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        templateName: template.templateName,
        templateLanguage: template.language,
        variableMappings: input.variableMappings?.length
          ? (input.variableMappings as unknown as Prisma.InputJsonValue)
          : undefined,
        status: scheduledAt && scheduledAt > new Date() ? "SCHEDULED" : "DRAFT",
        scheduledAt,
        totalRecipients: eligibleContactIds.length,
      },
    });

    if (eligibleContactIds.length > 0) {
      await tx.whatsappCampaignRecipient.createMany({
        data: eligibleContactIds.map((contactId) => ({
          campaignId: created.id,
          contactId,
          status: "PENDING",
        })),
      });
    }

    return created;
  });

  return {
    campaign,
    createdRecipients: eligibleContactIds.length,
    skipped,
  };
}

export function buildBodyParameters(
  contact: { fullName: string | null; phone: string; location: string | null; tags: string[] },
  mappings: MarketingVariableMapping[] | null
): string[] {
  if (!mappings?.length) return [];

  return mappings.map((mapping) => {
    if (mapping.source === "static") {
      return mapping.key;
    }

    switch (mapping.key) {
      case "fullName":
      case "name":
        return contact.fullName || "";
      case "phone":
        return contact.phone;
      case "location":
        return contact.location || "";
      case "tags":
        return contact.tags.join(", ");
      default:
        return "";
    }
  });
}

export async function launchWhatsappCampaign(
  userId: string,
  campaignId: string,
  launchInput: { scheduledAt?: string | null }
) {
  const campaign = await prisma.whatsappCampaign.findFirst({
    where: {
      id: campaignId,
      userId,
    },
    include: {
      connection: true,
      recipients: {
        where: {
          status: {
            in: ["PENDING", "FAILED"],
          },
        },
      },
    },
  });

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (!campaign.recipients.length) {
    throw new Error("Campaign has no recipients to launch");
  }

  if (
    campaign.connection.dailyLimitEstimate &&
    campaign.recipients.length > campaign.connection.dailyLimitEstimate
  ) {
    throw new Error(
      `Campaign size (${campaign.recipients.length}) exceeds estimated daily portfolio limit (${campaign.connection.dailyLimitEstimate})`
    );
  }

  const queue = getWhatsappMarketingQueue();

  const requestedScheduledAt = launchInput.scheduledAt
    ? new Date(launchInput.scheduledAt)
    : campaign.scheduledAt;
  const shouldSchedule = Boolean(
    requestedScheduledAt && requestedScheduledAt.getTime() > Date.now()
  );

  const delay = shouldSchedule
    ? Math.max(0, requestedScheduledAt!.getTime() - Date.now())
    : 0;

  const queuedRecipientIds = campaign.recipients.map((recipient) => recipient.id);

  await prisma.$transaction(async (tx) => {
    await tx.whatsappCampaignRecipient.updateMany({
      where: {
        id: {
          in: queuedRecipientIds,
        },
      },
      data: {
        status: "QUEUED",
        errorCode: null,
        errorMessage: null,
      },
    });

    await tx.whatsappCampaign.update({
      where: { id: campaign.id },
      data: {
        status: shouldSchedule ? "SCHEDULED" : "SENDING",
        scheduledAt: requestedScheduledAt || null,
        launchedAt: shouldSchedule ? campaign.launchedAt : new Date(),
        completedAt: null,
      },
    });
  });

  try {
    await queue.addBulk(
      campaign.recipients.map((recipient) => ({
        name: "send-marketing-template",
        data: {
          campaignId: campaign.id,
          recipientId: recipient.id,
          userId,
        },
        opts: {
          delay,
          jobId: `${campaign.id}:${recipient.id}`,
        },
      }))
    );
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.whatsappCampaignRecipient.updateMany({
        where: {
          id: {
            in: queuedRecipientIds,
          },
        },
        data: {
          status: "PENDING",
        },
      });

      await tx.whatsappCampaign.update({
        where: { id: campaign.id },
        data: {
          status: "FAILED",
        },
      });
    });

    throw error;
  }

  return {
    campaignId: campaign.id,
    queuedRecipients: campaign.recipients.length,
    scheduledAt: requestedScheduledAt,
    status: shouldSchedule ? "SCHEDULED" : "SENDING",
  };
}

export async function recomputeWhatsappCampaignStats(campaignId: string) {
  const [campaign, grouped] = await Promise.all([
    prisma.whatsappCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        status: true,
      },
    }),
    prisma.whatsappCampaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: true,
    }),
  ]);

  if (!campaign) return;

  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count]));
  const pending = (counts.PENDING || 0) + (counts.QUEUED || 0);

  const updates: {
    sentCount: number;
    deliveredCount: number;
    readCount: number;
    failedCount: number;
    blockedCount: number;
    unsubscribedCount: number;
    status?: "COMPLETED";
    completedAt?: Date;
  } = {
    sentCount: (counts.SENT || 0) + (counts.DELIVERED || 0) + (counts.READ || 0),
    deliveredCount: (counts.DELIVERED || 0) + (counts.READ || 0),
    readCount: counts.READ || 0,
    failedCount: counts.FAILED || 0,
    blockedCount: counts.BLOCKED || 0,
    unsubscribedCount: counts.UNSUBSCRIBED || 0,
  };

  if (
    pending === 0 &&
    ["SENDING", "SCHEDULED", "PAUSED"].includes(campaign.status)
  ) {
    updates.status = "COMPLETED";
    updates.completedAt = new Date();
  }

  await prisma.whatsappCampaign.update({
    where: { id: campaignId },
    data: updates,
  });
}
