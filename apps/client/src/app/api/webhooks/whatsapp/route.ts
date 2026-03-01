import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeToE164 } from "@/lib/whatsapp/phone";
import { recomputeWhatsappCampaignStats } from "@/lib/whatsapp/campaign-service";
import { findOrCreateWhatsappConversation } from "@/lib/whatsapp/inbox";
import type { WebhookStatusPayload } from "@/lib/whatsapp/types";

export const runtime = "nodejs";

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

  const blocked = Boolean(
    code === "131026" ||
      code === "131048" ||
      message?.toLowerCase().includes("blocked")
  );

  return {
    code,
    message,
    blocked,
  };
}

async function handleStatus(statusPayload: WebhookStatusPayload) {
  const messageId = statusPayload.id;
  if (!messageId) return;

  const normalized = mapMetaStatusToRecipientStatus(statusPayload.status);
  if (!normalized) return;

  const details = getErrorDetails(statusPayload);
  const nextStatus =
    normalized === "FAILED" && details.blocked ? "BLOCKED" : normalized;

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

  if (!recipient) return;
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

    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          sender: "customer",
          content: textBody,
        },
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          status: "active",
        },
      });
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  }

  if (token !== process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ error: "Invalid verify token" }, { status: 403 });
  }

  return new Response(challenge, { status: 200 });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      entry?: Array<{
        changes?: Array<{
          value?: Record<string, unknown>;
        }>;
      }>;
    };

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        const statuses = (value.statuses as WebhookStatusPayload[] | undefined) || [];
        for (const statusPayload of statuses) {
          await handleStatus(statusPayload);
        }

        await handleIncomingMessage(value);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("WhatsApp webhook processing error", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
