import { prisma } from "@/lib/prisma";
import { normalizeToE164 } from "@/lib/whatsapp/phone";
import { recomputeWhatsappCampaignStats } from "@/lib/whatsapp/campaign-service";
import { findOrCreateWhatsappConversation, parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { publishWhatsappRealtimeEvent } from "@/lib/whatsapp/realtime";
import { refreshTemplateFromWebhook } from "@/lib/whatsapp/template-service";
import type { WebhookStatusPayload } from "@/lib/whatsapp/types";
import {
  NotificationRecipientType,
  NotificationScopeType,
  NotificationSeverity,
  publishNotificationEvent,
} from "@kasiai/database";

const STOP_KEYWORDS = new Set([
  "stop",
  "unsubscribe",
  "cancel",
  "end",
  "optout",
  "opt-out",
]);

function mapMetaStatusToRecipientStatus(status?: string):
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "BLOCKED"
  | null {
  if (!status) return null;
  if (status === "sent") return "SENT";
  if (status === "delivered") return "DELIVERED";
  if (status === "read") return "READ";
  if (status === "failed") return "FAILED";
  return null;
}

function getErrorDetails(statusPayload: WebhookStatusPayload): {
  code?: string;
  message?: string;
  blocked: boolean;
} {
  const firstError = statusPayload.errors?.[0];
  const code = firstError?.code ? String(firstError.code) : undefined;
  const message = firstError?.message || firstError?.title;

  return {
    code,
    message,
    blocked: Boolean(
      code === "131026" || code === "131048" || message?.toLowerCase().includes("blocked")
    ),
  };
}

async function handleStatus(statusPayload: WebhookStatusPayload) {
  const messageId = statusPayload.id;
  if (!messageId) return;

  const normalized = mapMetaStatusToRecipientStatus(statusPayload.status);
  if (!normalized) return;

  const details = getErrorDetails(statusPayload);
  const nextStatus = normalized === "FAILED" && details.blocked ? "BLOCKED" : normalized;
  const timestamp = statusPayload.timestamp
    ? new Date(Number(statusPayload.timestamp) * 1000)
    : new Date();

  const recipient = await prisma.whatsappCampaignRecipient.findFirst({
    where: {
      waMessageId: messageId,
    },
    select: {
      id: true,
      campaignId: true,
      contactId: true,
      status: true,
      campaign: {
        select: {
          userId: true,
          connectionId: true,
          templateName: true,
        },
      },
      contact: {
        select: {
          phone: true,
        },
      },
    },
  });

  if (recipient) {
    if (recipient.status === nextStatus) return;

    await prisma.$transaction(async (tx) => {
      await tx.whatsappCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: nextStatus,
          deliveredAt: nextStatus === "DELIVERED" ? timestamp : undefined,
          readAt: nextStatus === "READ" ? timestamp : undefined,
          failedAt: ["FAILED", "BLOCKED"].includes(nextStatus) ? timestamp : undefined,
          errorCode: details.code || null,
          errorMessage: details.message || null,
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
          status: nextStatus,
          whatsappMessageId: messageId,
          responsePayload: statusPayload,
          errorCode: details.code || null,
          errorMessage: details.message || null,
        },
      });
    });

    await recomputeWhatsappCampaignStats(recipient.campaignId);
    return;
  }

  const inboxMessage = await prisma.message.findFirst({
    where: {
      whatsappMessageId: messageId,
      sender: "bot",
      conversation: {
        channel: "whatsapp",
      },
    },
    select: {
      id: true,
      conversationId: true,
      whatsappStatus: true,
      conversation: {
        select: {
          customerIdentifier: true,
        },
      },
    },
  });

  if (!inboxMessage || inboxMessage.whatsappStatus === nextStatus) return;

  const updatedMessage = await prisma.message.update({
    where: { id: inboxMessage.id },
    data: {
      whatsappStatus: nextStatus,
      errorCode: details.code || null,
      errorMessage: details.message || null,
    },
    select: {
      id: true,
      conversationId: true,
      conversation: {
        select: {
          customerIdentifier: true,
        },
      },
    },
  });

  const parsed = parseWhatsappConversationIdentifier(updatedMessage.conversation.customerIdentifier);
  if (!parsed) return;

  const connection = await prisma.whatsappConnection.findFirst({
    where: {
      id: parsed.connectionId,
    },
    select: {
      userId: true,
    },
  });

  if (!connection) return;

  await publishWhatsappRealtimeEvent(connection.userId, {
    type: "message.updated",
    conversationId: updatedMessage.conversationId,
    message: {
      id: updatedMessage.id,
      whatsappStatus: nextStatus,
      errorCode: details.code || null,
      errorMessage: details.message || null,
    },
  });
}

async function handleIncomingMessage(value: Record<string, unknown>) {
  const metadata = value.metadata as { phone_number_id?: string } | undefined;
  const messages = (value.messages as Array<Record<string, unknown>> | undefined) || [];
  const contacts = (value.contacts as Array<Record<string, unknown>> | undefined) || [];

  if (!metadata?.phone_number_id || !messages.length) return;

  const connection = await prisma.whatsappConnection.findUnique({
    where: {
      phoneNumberId: metadata.phone_number_id,
    },
    select: {
      id: true,
      userId: true,
    },
  });

  if (!connection) return;

  for (const message of messages) {
    const from = String(message.from || "");
    const textBody =
      (message.text as { body?: string } | undefined)?.body ||
      String((message.button as { text?: string } | undefined)?.text || "");

    const normalizedPhone = normalizeToE164(from);
    if (!normalizedPhone || !textBody) continue;

    const matchingContact = contacts.find((contact) => String(contact.wa_id || "") === from);
    const profileName =
      ((matchingContact?.profile as { name?: string } | undefined)?.name || "").trim() || null;

    const conversation = await findOrCreateWhatsappConversation({
      connectionId: connection.id,
      phone: normalizedPhone,
      customerName: profileName,
    });

    const customerContact = await prisma.whatsappContact.upsert({
      where: {
        userId_phone: {
          userId: connection.userId,
          phone: normalizedPhone,
        },
      },
      update: {
        fullName: profileName || undefined,
      },
      create: {
        userId: connection.userId,
        phone: normalizedPhone,
        fullName: profileName,
        optIn: false,
        excluded: false,
      },
      select: {
        id: true,
      },
    });

    const persisted = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          sender: "customer",
          content: textBody,
          whatsappMessageId:
            typeof message.id === "string" && message.id.trim() ? message.id : undefined,
        },
      });

      const updatedConversation = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: created.timestamp,
          status: "active",
          unreadCount: {
            increment: 1,
          },
        },
      });

      return {
        message: created,
        conversation: updatedConversation,
      };
    });

    await publishWhatsappRealtimeEvent(connection.userId, {
      type: "message.created",
      conversationId: conversation.id,
      conversation: {
        customerName: profileName,
      },
      message: {
        id: persisted.message.id,
        sender: "customer",
        content: persisted.message.content,
        timestamp: persisted.message.timestamp.toISOString(),
        whatsappStatus: undefined,
      },
    });

    await publishWhatsappRealtimeEvent(connection.userId, {
      type: "conversation.updated",
      conversationId: conversation.id,
      conversation: {
        id: conversation.id,
        customerName: profileName,
        phone: normalizedPhone,
        lastMessageAt: persisted.conversation.lastMessageAt.toISOString(),
        unreadCount: persisted.conversation.unreadCount,
      },
    });

    await publishNotificationEvent({
      scopeType: NotificationScopeType.USER,
      scopeId: connection.userId,
      eventType: "message.received",
      title: "New WhatsApp message",
      message: `${
        profileName || normalizedPhone
      } sent a new message to one of your connected WhatsApp numbers.`,
      severity: NotificationSeverity.INFO,
      entityType: "conversation",
      entityId: conversation.id,
      actorType: "contact",
      actorId: customerContact.id,
      payload: {
        conversationId: conversation.id,
        contactId: customerContact.id,
        phone: normalizedPhone,
        preview: textBody.slice(0, 280),
      },
      dedupeKey: `message.received:${persisted.message.id}`,
      recipients: [
        {
          recipientType: NotificationRecipientType.USER,
          recipientId: connection.userId,
        },
      ],
    });

    const keyword = textBody.trim().toLowerCase();
    if (!STOP_KEYWORDS.has(keyword)) continue;

    const pendingRecipients = await prisma.whatsappCampaignRecipient.findMany({
      where: {
        contactId: customerContact.id,
        status: {
          in: ["PENDING", "QUEUED"],
        },
      },
      select: {
        campaignId: true,
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.whatsappContact.update({
        where: { id: customerContact.id },
        data: {
          excluded: true,
          optIn: false,
          notes: `Unsubscribed via STOP keyword on ${new Date().toISOString()}`,
        },
      });

      await tx.whatsappCampaignRecipient.updateMany({
        where: {
          contactId: customerContact.id,
          status: {
            in: ["PENDING", "QUEUED"],
          },
        },
        data: {
          status: "UNSUBSCRIBED",
          errorCode: "unsubscribed",
          errorMessage: "Contact unsubscribed via inbound keyword",
        },
      });
    });

    for (const recipient of pendingRecipients) {
      await recomputeWhatsappCampaignStats(recipient.campaignId);
    }
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function handleTemplateWebhook(field: string | undefined, value: Record<string, unknown>) {
  if (
    !field ||
    ![
      "message_template_status_update",
      "message_template_quality_update",
      "message_template_components_update",
    ].includes(field)
  ) {
    return;
  }

  const event = (value.event as Record<string, unknown> | undefined) || value;
  const metadata = value.metadata as { phone_number_id?: string } | undefined;

  await refreshTemplateFromWebhook({
    connectionPhoneNumberId: metadata?.phone_number_id || getString(value.phone_number_id),
    templateName:
      getString(event.message_template_name) ||
      getString(event.template_name) ||
      getString(event.name) ||
      getString(value.message_template_name) ||
      getString(value.template_name) ||
      getString(value.name),
    language:
      getString(event.message_template_language) ||
      getString(event.language) ||
      getString(value.message_template_language) ||
      getString(value.language),
    status:
      getString(event.message_template_status) ||
      getString(event.status) ||
      getString(value.message_template_status) ||
      getString(value.status) ||
      field,
    event: field,
  });
}

export async function processWhatsappWebhookChange(input: {
  field?: string;
  value: Record<string, unknown>;
}) {
  const statuses = (input.value.statuses as WebhookStatusPayload[] | undefined) || [];
  for (const statusPayload of statuses) {
    await handleStatus(statusPayload);
  }

  await handleTemplateWebhook(input.field, input.value);
  await handleIncomingMessage(input.value);
}
