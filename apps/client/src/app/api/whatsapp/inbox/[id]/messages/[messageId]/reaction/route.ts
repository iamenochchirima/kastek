import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { encodeStoredWhatsappReaction } from "@/lib/whatsapp/message-content";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { sendReactionMessage } from "@/lib/whatsapp/meta-api";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId, messageId } = await params;
    const body = (await req.json().catch(() => ({}))) as { emoji?: string; remove?: boolean };
    const remove = body.remove === true;
    const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";

    if (!remove && !emoji) {
      return NextResponse.json({ error: "Emoji is required" }, { status: 400 });
    }

    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: { id: true, phoneNumberId: true, accessTokenEncrypted: true },
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
        customerIdentifier: true,
      },
    });

    if (!conversation) {
      console.error("[dashboard2 reaction debug] conversation not found", {
        conversationId,
        messageId,
        userId,
      });
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const targetMessage = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId: conversation.id,
      },
      select: {
        id: true,
        whatsappMessageId: true,
      },
    });

    if (!targetMessage?.whatsappMessageId) {
      console.error("[dashboard2 reaction debug] target missing whatsappMessageId", {
        conversationId,
        messageId,
        targetMessageId: targetMessage?.id || null,
      });
      return NextResponse.json(
        { error: "Target message is not available for reactions yet" },
        { status: 400 }
      );
    }

    const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
    if (!parsed) {
      console.error("[dashboard2 reaction debug] invalid conversation identifier", {
        conversationId,
        messageId,
        customerIdentifier: conversation.customerIdentifier,
      });
      return NextResponse.json({ error: "Invalid conversation identifier" }, { status: 400 });
    }

    const connection = connections.find((item) => item.id === parsed.connectionId);
    if (!connection) {
      console.error("[dashboard2 reaction debug] connection not found", {
        conversationId,
        messageId,
        connectionId: parsed.connectionId,
        userId,
      });
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const accessToken = decryptSecret(connection.accessTokenEncrypted);
    await sendReactionMessage({
      phoneNumberId: connection.phoneNumberId,
      accessToken,
      recipientPhone: parsed.phone,
      messageId: targetMessage.whatsappMessageId,
      emoji: remove ? "" : emoji,
    });

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "bot",
        content: encodeStoredWhatsappReaction({
          version: 1,
          emoji: remove ? "" : emoji,
          targetWhatsappMessageId: targetMessage.whatsappMessageId,
          targetMessageId: targetMessage.id,
          actorIdentifier: `bot:${connection.id}`,
        }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[dashboard2 reaction debug] route failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : "Failed to send reaction";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
