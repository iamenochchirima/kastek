import { prisma } from "./client";
import {
  NotificationChannel,
  NotificationFrequency,
  NotificationRecipientType,
  NotificationSeverity,
  NotificationStatus,
  NotificationScopeType,
  Prisma,
} from "./generated/client";

const EMAIL_DEFAULT_EVENT_TYPES = new Set([
  "message.failed_to_send",
  "template.approved",
  "campaign.completed",
  "campaign.failed",
  "campaign.high_failure_rate",
  "template.rejected",
  "template.disabled",
  "connection.health_failed",
  "quote_request.created",
  "outreach.reply_received",
]);

export type NotificationRecipientInput = {
  recipientType: NotificationRecipientType;
  recipientId: string;
};

export type PublishNotificationEventInput = {
  scopeType: NotificationScopeType;
  scopeId: string;
  eventType: string;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  entityType?: string;
  entityId?: string;
  actorType?: string;
  actorId?: string;
  payload?: Prisma.InputJsonValue;
  dedupeKey?: string;
  dedupeWindowMinutes?: number;
  recipients: NotificationRecipientInput[];
};

type NotificationListOptions = {
  channel?: NotificationChannel;
  unreadOnly?: boolean;
  limit?: number;
};

export type PendingEmailNotification = Prisma.NotificationGetPayload<{
  include: {
    event: true;
    deliveryLogs: true;
  };
}> & {
  recipientEmail: string | null;
  recipientName: string | null;
};

function isMissingNotificationsTable(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2021"
  );
}

function uniqueRecipients(recipients: NotificationRecipientInput[]) {
  return Array.from(
    recipients.reduce((map, recipient) => {
      map.set(`${recipient.recipientType}:${recipient.recipientId}`, recipient);
      return map;
    }, new Map<string, NotificationRecipientInput>()).values()
  );
}

async function resolveChannelPreference(input: {
  recipientType: NotificationRecipientType;
  recipientId: string;
  eventType: string;
  channel: NotificationChannel;
}) {
  let preferences:
    | Awaited<ReturnType<typeof prisma.notificationPreference.findMany>>
    | [] = [];

  try {
    preferences = await prisma.notificationPreference.findMany({
      where: {
        recipientType: input.recipientType,
        recipientId: input.recipientId,
        channel: input.channel,
        eventType: {
          in: [input.eventType, "*"],
        },
      },
    });
  } catch (error) {
    if (!isMissingNotificationsTable(error)) {
      throw error;
    }
  }

  const exact = preferences.find((preference) => preference.eventType === input.eventType);
  const fallback = preferences.find((preference) => preference.eventType === "*");
  const preference = exact || fallback;

  if (preference) {
    return preference.enabled && preference.frequency !== NotificationFrequency.MUTE;
  }

  if (input.channel === NotificationChannel.IN_APP) {
    return true;
  }

  return EMAIL_DEFAULT_EVENT_TYPES.has(input.eventType);
}

export async function publishNotificationEvent(input: PublishNotificationEventInput) {
  const recipients = uniqueRecipients(input.recipients);

  if (recipients.length === 0) {
    throw new Error("At least one notification recipient is required");
  }

  if (input.dedupeKey && input.dedupeWindowMinutes && input.dedupeWindowMinutes > 0) {
    const dedupeSince = new Date(Date.now() - input.dedupeWindowMinutes * 60 * 1000);
    let existing = null;

    try {
      existing = await prisma.notificationEvent.findFirst({
        where: {
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          dedupeKey: input.dedupeKey,
          createdAt: {
            gte: dedupeSince,
          },
        },
        include: {
          notifications: true,
        },
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      if (!isMissingNotificationsTable(error)) {
        throw error;
      }
    }

    if (existing) {
      return existing;
    }
  }

  const enabledChannelsByRecipient = await Promise.all(
    recipients.map(async (recipient) => {
      const [inAppEnabled, emailEnabled] = await Promise.all([
        resolveChannelPreference({
          ...recipient,
          eventType: input.eventType,
          channel: NotificationChannel.IN_APP,
        }),
        resolveChannelPreference({
          ...recipient,
          eventType: input.eventType,
          channel: NotificationChannel.EMAIL,
        }),
      ]);

      return {
        recipient,
        channels: [
          ...(inAppEnabled ? [NotificationChannel.IN_APP] : []),
          ...(emailEnabled ? [NotificationChannel.EMAIL] : []),
        ],
      };
    })
  );

  try {
    return await prisma.notificationEvent.create({
      data: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        eventType: input.eventType,
        title: input.title,
        message: input.message,
        severity: input.severity || NotificationSeverity.INFO,
        entityType: input.entityType,
        entityId: input.entityId,
        actorType: input.actorType,
        actorId: input.actorId,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        notifications: {
          create: enabledChannelsByRecipient.flatMap(({ recipient, channels }) =>
            channels.map((channel) => ({
              recipientType: recipient.recipientType,
              recipientId: recipient.recipientId,
              channel,
              status:
                channel === NotificationChannel.IN_APP
                  ? NotificationStatus.SENT
                  : NotificationStatus.PENDING,
              sentAt: channel === NotificationChannel.IN_APP ? new Date() : null,
            }))
          ),
        },
      },
      include: {
        notifications: true,
      },
    });
  } catch (error) {
    if (!isMissingNotificationsTable(error)) {
      throw error;
    }

    return null;
  }
}

export async function listNotifications(
  recipientType: NotificationRecipientType,
  recipientId: string,
  options: NotificationListOptions = {}
) {
  return prisma.notification.findMany({
    where: {
      recipientType,
      recipientId,
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.unreadOnly
        ? {
            readAt: null,
            status: {
              notIn: [NotificationStatus.DISMISSED, NotificationStatus.FAILED],
            },
          }
        : {}),
    },
    include: {
      event: true,
      deliveryLogs: {
        orderBy: { createdAt: "desc" },
        take: 3,
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit || 20,
  });
}

export async function getUnreadNotificationCount(
  recipientType: NotificationRecipientType,
  recipientId: string
) {
  return prisma.notification.count({
    where: {
      recipientType,
      recipientId,
      channel: NotificationChannel.IN_APP,
      readAt: null,
      status: {
        notIn: [NotificationStatus.DISMISSED, NotificationStatus.FAILED],
      },
    },
  });
}

export async function markNotificationAsRead(
  recipientType: NotificationRecipientType,
  recipientId: string,
  notificationId: string
) {
  return prisma.notification.updateMany({
    where: {
      id: notificationId,
      recipientType,
      recipientId,
      channel: NotificationChannel.IN_APP,
      readAt: null,
    },
    data: {
      readAt: new Date(),
      status: NotificationStatus.READ,
    },
  });
}

export async function markAllNotificationsAsRead(
  recipientType: NotificationRecipientType,
  recipientId: string
) {
  return prisma.notification.updateMany({
    where: {
      recipientType,
      recipientId,
      channel: NotificationChannel.IN_APP,
      readAt: null,
      status: {
        notIn: [NotificationStatus.DISMISSED, NotificationStatus.FAILED],
      },
    },
    data: {
      readAt: new Date(),
      status: NotificationStatus.READ,
    },
  });
}

export async function listPendingEmailNotifications(limit = 20): Promise<PendingEmailNotification[]> {
  const notifications = await prisma.notification.findMany({
    where: {
      channel: NotificationChannel.EMAIL,
      status: NotificationStatus.PENDING,
    },
    include: {
      event: true,
      deliveryLogs: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const userIds = notifications
    .filter((notification) => notification.recipientType === NotificationRecipientType.USER)
    .map((notification) => notification.recipientId);
  const adminIds = notifications
    .filter((notification) => notification.recipientType === NotificationRecipientType.ADMIN)
    .map((notification) => notification.recipientId);

  const [users, admins] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : Promise.resolve([]),
    adminIds.length > 0
      ? prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, email: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const recipients = new Map(
    [
      ...users.map((user) => [`USER:${user.id}`, { email: user.email, name: user.name }] as const),
      ...admins.map((admin) => [`ADMIN:${admin.id}`, { email: admin.email, name: admin.name }] as const),
    ]
  );

  return notifications.map((notification) => {
    const recipient = recipients.get(`${notification.recipientType}:${notification.recipientId}`);
    return {
      ...notification,
      recipientEmail: recipient?.email || null,
      recipientName: recipient?.name || null,
    };
  });
}

export async function markNotificationEmailSent(input: {
  notificationId: string;
  provider: string;
  providerMessageId?: string | null;
  responsePayload?: Prisma.InputJsonValue;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.notification.update({
      where: { id: input.notificationId },
      data: {
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        failedAt: null,
        errorMessage: null,
      },
    });

    await tx.notificationDeliveryLog.create({
      data: {
        notificationId: input.notificationId,
        provider: input.provider,
        providerMessageId: input.providerMessageId || null,
        status: NotificationStatus.SENT,
        responsePayload: input.responsePayload,
      },
    });
  });
}

export async function markNotificationEmailFailed(input: {
  notificationId: string;
  provider: string;
  errorMessage: string;
  responsePayload?: Prisma.InputJsonValue;
}) {
  return prisma.$transaction(async (tx) => {
    const existingAttempts = await tx.notificationDeliveryLog.count({
      where: { notificationId: input.notificationId },
    });

    await tx.notification.update({
      where: { id: input.notificationId },
      data: {
        status: NotificationStatus.FAILED,
        failedAt: new Date(),
        errorMessage: input.errorMessage,
      },
    });

    await tx.notificationDeliveryLog.create({
      data: {
        notificationId: input.notificationId,
        provider: input.provider,
        attempt: existingAttempts + 1,
        status: NotificationStatus.FAILED,
        responsePayload: input.responsePayload,
        errorMessage: input.errorMessage,
      },
    });
  });
}
