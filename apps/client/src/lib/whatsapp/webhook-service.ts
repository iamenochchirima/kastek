import { prisma } from "@/lib/prisma";
import { normalizeToE164 } from "@/lib/whatsapp/phone";
import { recomputeWhatsappCampaignStats } from "@/lib/whatsapp/campaign-service";
import { findOrCreateWhatsappConversation, parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import {
  encodeStoredWhatsappReaction,
  encodeStoredWhatsappReplyEnvelope,
  encodeStoredWhatsappMedia,
  getWhatsappMessageDisplayText,
  getWhatsappMessagePreview,
  type StoredWhatsappMedia,
} from "@/lib/whatsapp/message-content";
import { publishWhatsappRealtimeEvent } from "@/lib/whatsapp/realtime";
import { refreshTemplateFromWebhook } from "@/lib/whatsapp/template-service";
import type { WebhookStatusPayload } from "@/lib/whatsapp/types";
import type { Prisma } from "@kasitek/database";
import {
  NotificationRecipientType,
  NotificationScopeType,
  NotificationSeverity,
  publishNotificationEvent,
} from "@kasitek/database";
const WEBHOOK_DEBUG = process.env.WHATSAPP_WEBHOOK_DEBUG === "1";

function debugWebhookLog(stage: string, payload: Record<string, unknown>) {
  if (!WEBHOOK_DEBUG) return;
  console.info(`[whatsapp:webhook:${stage}]`, payload);
}

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

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return null;
}

function getPricingDetails(statusPayload: WebhookStatusPayload): {
  conversationId: string | null;
  conversationOrigin: string | null;
  conversationExpiresAt: Date | null;
  pricingBillable: boolean | null;
  pricingCategory: string | null;
  pricingModel: string | null;
  pricingType: string | null;
} {
  const expirationTimestamp = statusPayload.conversation?.expiration_timestamp;
  const expirationEpoch = expirationTimestamp ? Number(expirationTimestamp) : Number.NaN;

  return {
    conversationId: statusPayload.conversation?.id || null,
    conversationOrigin: statusPayload.conversation?.origin?.type || null,
    conversationExpiresAt: Number.isFinite(expirationEpoch)
      ? new Date(expirationEpoch * 1000)
      : null,
    pricingBillable: parseBoolean(statusPayload.pricing?.billable),
    pricingCategory: statusPayload.pricing?.category || null,
    pricingModel: statusPayload.pricing?.pricing_model || null,
    pricingType: statusPayload.pricing?.type || null,
  };
}

function getInboundText(message: Record<string, unknown>) {
  const textBody = (message.text as { body?: string } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody;

  const buttonText = (message.button as { text?: string } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText;

  const interactive = message.interactive as
    | {
        button_reply?: { title?: string };
        list_reply?: { title?: string; description?: string };
      }
    | undefined;

  const interactiveTitle = interactive?.button_reply?.title || interactive?.list_reply?.title;
  if (typeof interactiveTitle === "string" && interactiveTitle.trim()) return interactiveTitle;

  const interactiveDescription = interactive?.list_reply?.description;
  if (typeof interactiveDescription === "string" && interactiveDescription.trim()) {
    return interactiveDescription;
  }

  return "";
}

function getInboundMedia(message: Record<string, unknown>): StoredWhatsappMedia | null {
  const messageType = typeof message.type === "string" ? message.type : "";
  if (["image", "video", "audio", "document", "sticker"].includes(messageType)) {
    const mediaPayload = message[messageType] as
      | {
          id?: string;
          mime_type?: string;
          caption?: string;
          filename?: string;
          sha256?: string;
        }
      | undefined;

    if (mediaPayload?.id) {
      return {
        version: 1,
        kind: messageType as StoredWhatsappMedia["kind"],
        mediaId: mediaPayload.id,
        mimeType: mediaPayload.mime_type || null,
        caption: mediaPayload.caption || null,
        filename: mediaPayload.filename || null,
        sha256: mediaPayload.sha256 || null,
      };
    }
  }

  const image = message.image as
    | { id?: string; mime_type?: string; caption?: string; sha256?: string }
    | undefined;
  if (image?.id) {
    return {
      version: 1,
      kind: "image",
      mediaId: image.id,
      mimeType: image.mime_type || null,
      caption: image.caption || null,
      sha256: image.sha256 || null,
    };
  }

  const video = message.video as
    | { id?: string; mime_type?: string; caption?: string; sha256?: string }
    | undefined;
  if (video?.id) {
    return {
      version: 1,
      kind: "video",
      mediaId: video.id,
      mimeType: video.mime_type || null,
      caption: video.caption || null,
      sha256: video.sha256 || null,
    };
  }

  const audio = message.audio as { id?: string; mime_type?: string; sha256?: string } | undefined;
  if (audio?.id) {
    return {
      version: 1,
      kind: "audio",
      mediaId: audio.id,
      mimeType: audio.mime_type || null,
      sha256: audio.sha256 || null,
    };
  }

  const document = message.document as
    | { id?: string; mime_type?: string; filename?: string; caption?: string; sha256?: string }
    | undefined;
  if (document?.id) {
    return {
      version: 1,
      kind: "document",
      mediaId: document.id,
      mimeType: document.mime_type || null,
      filename: document.filename || null,
      caption: document.caption || null,
      sha256: document.sha256 || null,
    };
  }

  const sticker = message.sticker as { id?: string; mime_type?: string; sha256?: string } | undefined;
  if (sticker?.id) {
    return {
      version: 1,
      kind: "sticker",
      mediaId: sticker.id,
      mimeType: sticker.mime_type || null,
      sha256: sticker.sha256 || null,
    };
  }

  return null;
}

function getInboundReaction(message: Record<string, unknown>) {
  const reaction = message.reaction as { message_id?: string; id?: string; emoji?: string } | undefined;
  const emoji = typeof reaction?.emoji === "string" ? reaction.emoji : "";
  const targetWhatsappMessageId =
    (typeof reaction?.message_id === "string" && reaction.message_id.trim()
      ? reaction.message_id.trim()
      : typeof reaction?.id === "string" && reaction.id.trim()
        ? reaction.id.trim()
        : null);

  if (!targetWhatsappMessageId) return null;
  return {
    emoji,
    targetWhatsappMessageId,
  };
}

async function handleStatus(statusPayload: WebhookStatusPayload) {
  const messageId = statusPayload.id;
  if (!messageId) return;

  const normalized = mapMetaStatusToRecipientStatus(statusPayload.status);
  if (!normalized) return;

  const details = getErrorDetails(statusPayload);
  const pricing = getPricingDetails(statusPayload);
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
          whatsappConversationId: pricing.conversationId,
          whatsappConversationOrigin: pricing.conversationOrigin,
          whatsappConversationExpires: pricing.conversationExpiresAt,
          whatsappPricingBillable: pricing.pricingBillable,
          whatsappPricingCategory: pricing.pricingCategory,
          whatsappPricingModel: pricing.pricingModel,
          whatsappPricingType: pricing.pricingType,
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
      whatsappConversationId: pricing.conversationId,
      whatsappConversationOrigin: pricing.conversationOrigin,
      whatsappConversationExpires: pricing.conversationExpiresAt,
      whatsappPricingBillable: pricing.pricingBillable,
      whatsappPricingCategory: pricing.pricingCategory,
      whatsappPricingModel: pricing.pricingModel,
      whatsappPricingType: pricing.pricingType,
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
      id: true,
      userId: true,
    },
  });

  if (!connection) return;

  await prisma.whatsappSendEvent.create({
    data: {
      userId: connection.userId,
      connectionId: connection.id,
      phone: parsed.phone,
      templateName: "__INBOX__",
      status: nextStatus,
      whatsappMessageId: messageId,
      whatsappConversationId: pricing.conversationId,
      whatsappConversationOrigin: pricing.conversationOrigin,
      whatsappConversationExpires: pricing.conversationExpiresAt,
      whatsappPricingBillable: pricing.pricingBillable,
      whatsappPricingCategory: pricing.pricingCategory,
      whatsappPricingModel: pricing.pricingModel,
      whatsappPricingType: pricing.pricingType,
      responsePayload: statusPayload as unknown as Prisma.InputJsonValue,
      errorCode: details.code || null,
      errorMessage: details.message || null,
    },
  });

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

  debugWebhookLog("incoming:received", {
    phoneNumberId: metadata?.phone_number_id || null,
    messageCount: messages.length,
    contactCount: contacts.length,
    valueKeys: Object.keys(value),
  });

  if (!metadata?.phone_number_id || !messages.length) {
    debugWebhookLog("incoming:skipped", {
      reason: !metadata?.phone_number_id ? "missing_phone_number_id" : "no_messages",
    });
    return;
  }

  const connection = await prisma.whatsappConnection.findUnique({
    where: {
      phoneNumberId: metadata.phone_number_id,
    },
    select: {
      id: true,
      userId: true,
    },
  });

  if (!connection) {
    debugWebhookLog("incoming:skipped", {
      reason: "connection_not_found",
      phoneNumberId: metadata.phone_number_id,
    });
    return;
  }

  debugWebhookLog("incoming:connection", {
    connectionId: connection.id,
    userId: connection.userId,
    phoneNumberId: metadata.phone_number_id,
  });

  for (const [index, message] of messages.entries()) {
    const from = String(message.from || "");
    const messageType = typeof message.type === "string" ? message.type : "unknown";
    const inboundText = getInboundText(message);
    const inboundMedia = getInboundMedia(message);
    const inboundReaction = getInboundReaction(message);

    const normalizedPhone = normalizeToE164(from);
    debugWebhookLog("incoming:message", {
      index,
      messageType,
      from,
      normalizedPhone: normalizedPhone || null,
      hasInboundText: Boolean(inboundText),
      hasInboundMedia: Boolean(inboundMedia),
      hasInboundReaction: Boolean(inboundReaction),
      whatsappMessageId:
        typeof message.id === "string" && message.id.trim() ? message.id : null,
      messageKeys: Object.keys(message),
    });

    if (!normalizedPhone || (!inboundText && !inboundMedia && !inboundReaction)) {
      console.warn("[whatsapp:webhook] inbound message skipped", {
        hasPhone: Boolean(normalizedPhone),
        hasContent: Boolean(inboundText || inboundMedia || inboundReaction),
        messageType,
        messageKeys: Object.keys(message),
      });
      continue;
    }

    try {
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

      const contextMessageId =
        ((message.context as { id?: string } | undefined)?.id || "").trim() || null;

      const referencedMessage = contextMessageId
        ? await prisma.message.findFirst({
            where: {
              conversationId: conversation.id,
              whatsappMessageId: contextMessageId,
            },
            select: {
              id: true,
              content: true,
            },
          })
        : null;

      const reactionTargetMessage = inboundReaction?.targetWhatsappMessageId
        ? await prisma.message.findFirst({
            where: {
              conversationId: conversation.id,
              whatsappMessageId: inboundReaction.targetWhatsappMessageId,
            },
            select: {
              id: true,
            },
          })
        : null;

      const storedContent =
        inboundText ||
        (inboundReaction
          ? encodeStoredWhatsappReaction({
              version: 1,
              emoji: inboundReaction.emoji,
              targetWhatsappMessageId: inboundReaction.targetWhatsappMessageId,
              targetMessageId: reactionTargetMessage?.id || null,
              actorIdentifier: normalizedPhone || from || null,
            })
          : "") ||
        (inboundMedia ? encodeStoredWhatsappMedia(inboundMedia) : "") ||
        (messageType && messageType !== "unknown" ? `Unsupported message type: ${messageType}` : "");

      const persistedContent =
        contextMessageId && referencedMessage
          ? encodeStoredWhatsappReplyEnvelope({
              version: 1,
              replyToMessageId: referencedMessage.id,
              replyPreview: getWhatsappMessageDisplayText(referencedMessage.content).slice(0, 180),
              content: storedContent,
            })
          : storedContent;

      const persisted = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId: conversation.id,
            sender: "customer",
            content: persistedContent,
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

      debugWebhookLog("incoming:persisted", {
        index,
        conversationId: conversation.id,
        messageId: persisted.message.id,
        unreadCount: persisted.conversation.unreadCount,
        messageType,
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
          preview: getWhatsappMessagePreview(storedContent, 280),
        },
        dedupeKey: `message.received:${persisted.message.id}`,
        recipients: [
          {
            recipientType: NotificationRecipientType.USER,
            recipientId: connection.userId,
          },
        ],
      });

      const keyword = inboundText.trim().toLowerCase();
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
    } catch (error) {
      console.error("[whatsapp:webhook] failed processing inbound message", {
        index,
        messageType,
        from,
        normalizedPhone: normalizedPhone || null,
        error: error instanceof Error ? error.message : String(error),
      });
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
  debugWebhookLog("change:received", {
    field: input.field || "unknown",
    valueKeys: Object.keys(input.value || {}),
    messageCount: Array.isArray((input.value as { messages?: unknown }).messages)
      ? ((input.value as { messages: unknown[] }).messages || []).length
      : 0,
    statusCount: Array.isArray((input.value as { statuses?: unknown }).statuses)
      ? ((input.value as { statuses: unknown[] }).statuses || []).length
      : 0,
  });

  const statuses = (input.value.statuses as WebhookStatusPayload[] | undefined) || [];
  for (const [index, statusPayload] of statuses.entries()) {
    try {
      await handleStatus(statusPayload);
    } catch (error) {
      console.error("[whatsapp:webhook] failed processing status payload", {
        index,
        statusId: statusPayload.id || null,
        status: statusPayload.status || null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  await handleTemplateWebhook(input.field, input.value);
  await handleIncomingMessage(input.value);

  debugWebhookLog("change:done", {
    field: input.field || "unknown",
  });
}
