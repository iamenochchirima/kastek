import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import {
  parseWhatsappConversationIdentifier,
} from "@/lib/whatsapp/inbox";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = (await req.json()) as { text?: string };
    const text = body.text?.trim();

    if (!text) {
      return NextResponse.json({ error: "Reply text is required" }, { status: 400 });
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        channel: "whatsapp",
      },
      include: {
        messages: {
          orderBy: {
            timestamp: "desc",
          },
          take: 1,
        },
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid WhatsApp conversation identifier" }, { status: 400 });
    }

    const connection = await prisma.whatsappConnection.findFirst({
      where: {
        id: parsed.connectionId,
        userId,
      },
      select: {
        id: true,
        phoneNumberId: true,
        accessTokenEncrypted: true,
      },
    });

    if (!connection) {
      return NextResponse.json({ error: "WhatsApp connection not found" }, { status: 404 });
    }

    const accessToken = decryptSecret(connection.accessTokenEncrypted);
    const sendResult = await sendTextMessage({
      phoneNumberId: connection.phoneNumberId,
      accessToken,
      recipientPhone: parsed.phone,
      text,
    });

    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          sender: "bot",
          content: text,
        },
      });

      await tx.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessageAt: new Date(),
          status: "active",
        },
      });
    });

    return NextResponse.json({
      success: true,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send reply";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
