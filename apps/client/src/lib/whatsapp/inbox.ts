import { prisma } from "@/lib/prisma";

const WHATSAPP_IDENTIFIER_PREFIX = "wa";

export function buildWhatsappConversationIdentifier(connectionId: string, phone: string) {
  return `${WHATSAPP_IDENTIFIER_PREFIX}:${connectionId}:${phone}`;
}

export function parseWhatsappConversationIdentifier(identifier: string) {
  const [prefix, connectionId, ...rest] = identifier.split(":");
  if (prefix !== WHATSAPP_IDENTIFIER_PREFIX || !connectionId || rest.length === 0) {
    return null;
  }

  return {
    connectionId,
    phone: rest.join(":"),
  };
}

export async function findOrCreateWhatsappConversation(input: {
  connectionId: string;
  phone: string;
  customerName?: string | null;
}) {
  const customerIdentifier = buildWhatsappConversationIdentifier(input.connectionId, input.phone);

  const existing = await prisma.conversation.findUnique({
    where: {
      channel_customerIdentifier: {
        channel: "whatsapp",
        customerIdentifier,
      },
    },
  });

  if (existing) {
    if (input.customerName && existing.customerName !== input.customerName) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: {
          customerName: input.customerName,
        },
      });
    }

    return existing;
  }

  return prisma.conversation.create({
    data: {
      channel: "whatsapp",
      customerIdentifier,
      customerName: input.customerName || null,
      status: "active",
    },
  });
}
