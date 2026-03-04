import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId, messageId } = await params;
    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: { id: true },
    });

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        channel: "whatsapp",
        OR: connections.map((connection) => ({
          customerIdentifier: {
            startsWith: `wa:${connection.id}:`,
          },
        })),
      },
      select: {
        id: true,
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const deleted = await prisma.message.deleteMany({
      where: {
        id: messageId,
        conversationId: conversation.id,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const latestMessage = await prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
      },
      select: {
        timestamp: true,
      },
      orderBy: {
        timestamp: "desc",
      },
    });

    if (latestMessage?.timestamp) {
      await prisma.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessageAt: latestMessage.timestamp,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete message";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
