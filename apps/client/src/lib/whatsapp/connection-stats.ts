import { prisma } from "@/lib/prisma";

export type WhatsappConnectionStats = {
  connectionId: string;
  sentLast24h: number;
  estimatedRemainingToday: number | null;
};

export async function getWhatsappConnectionStats(connectionIds: string[]) {
  if (!connectionIds.length) {
    return new Map<string, WhatsappConnectionStats>();
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [connections, recipientGroups] = await Promise.all([
    prisma.whatsappConnection.findMany({
      where: {
        id: {
          in: connectionIds,
        },
      },
      select: {
        id: true,
        dailyLimitEstimate: true,
      },
    }),
    prisma.whatsappCampaignRecipient.groupBy({
      by: ["campaignId"],
      where: {
        sentAt: {
          gte: since,
        },
        campaign: {
          connectionId: {
            in: connectionIds,
          },
        },
      },
      _count: true,
    }),
  ]);

  const campaignConnectionMap = new Map<string, string>();
  const campaigns = await prisma.whatsappCampaign.findMany({
    where: {
      id: {
        in: recipientGroups.map((group) => group.campaignId),
      },
    },
    select: {
      id: true,
      connectionId: true,
    },
  });

  for (const campaign of campaigns) {
    campaignConnectionMap.set(campaign.id, campaign.connectionId);
  }

  const sentByConnection = new Map<string, number>();
  for (const group of recipientGroups) {
    const connectionId = campaignConnectionMap.get(group.campaignId);
    if (!connectionId) continue;
    sentByConnection.set(connectionId, (sentByConnection.get(connectionId) || 0) + group._count);
  }

  return new Map(
    connections.map((connection) => {
      const sentLast24h = sentByConnection.get(connection.id) || 0;
      const estimatedRemainingToday =
        connection.dailyLimitEstimate === null
          ? null
          : Math.max(connection.dailyLimitEstimate - sentLast24h, 0);

      return [
        connection.id,
        {
          connectionId: connection.id,
          sentLast24h,
          estimatedRemainingToday,
        },
      ] satisfies [string, WhatsappConnectionStats];
    })
  );
}
