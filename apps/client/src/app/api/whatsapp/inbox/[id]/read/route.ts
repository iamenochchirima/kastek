import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { markWhatsappMessageAsRead } from "@/lib/whatsapp/meta-api";
import { publishWhatsappRealtimeEvent } from "@/lib/whatsapp/realtime";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: { id: true },
    });

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        channel: "whatsapp",
        OR: connections.map((connection) => ({
          customerIdentifier: {
            startsWith: `wa:${connection.id}:`,
          },
        })),
      },
      select: {
        id: true,
        customerIdentifier: true,
        customerName: true,
        lastMessageAt: true,
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: 0,
        lastReadAt: new Date(),
      },
      select: {
        id: true,
        customerName: true,
        customerIdentifier: true,
        lastMessageAt: true,
        unreadCount: true,
      },
    });

    const parsed = parseWhatsappConversationIdentifier(updated.customerIdentifier);
    const connectionId = parsed?.connectionId || null;

    if (connectionId) {
      const [connection, unreadInboundMessages] = await Promise.all([
        prisma.whatsappConnection.findFirst({
          where: {
            id: connectionId,
            userId,
          },
          select: {
            phoneNumberId: true,
            accessTokenEncrypted: true,
          },
        }),
        prisma.message.findMany({
          where: {
            conversationId: updated.id,
            sender: "customer",
            whatsappMessageId: {
              not: null,
            },
            OR: [
              { whatsappStatus: null },
              { whatsappStatus: { not: "READ" } },
            ],
          },
          select: {
            id: true,
            whatsappMessageId: true,
          },
          orderBy: {
            timestamp: "asc",
          },
        }),
      ]);

      if (connection && unreadInboundMessages.length > 0) {
        const accessToken = decryptSecret(connection.accessTokenEncrypted);

        const results = await Promise.allSettled(
          unreadInboundMessages.map((message) =>
            markWhatsappMessageAsRead({
              phoneNumberId: connection.phoneNumberId,
              accessToken,
              messageId: message.whatsappMessageId as string,
            })
          )
        );

        const successfulMessageIds = unreadInboundMessages
          .filter((_, index) => results[index]?.status === "fulfilled")
          .map((message) => message.id);

        if (successfulMessageIds.length > 0) {
          await prisma.message.updateMany({
            where: {
              id: {
                in: successfulMessageIds,
              },
            },
            data: {
              whatsappStatus: "READ",
            },
          });
        }
      }
    }

    await publishWhatsappRealtimeEvent(userId, {
      type: "conversation.updated",
      conversationId: updated.id,
      conversation: {
        id: updated.id,
        customerName: updated.customerName,
        phone: parsed?.phone || updated.customerIdentifier,
        lastMessageAt: updated.lastMessageAt.toISOString(),
        unreadCount: updated.unreadCount,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark conversation as read";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
