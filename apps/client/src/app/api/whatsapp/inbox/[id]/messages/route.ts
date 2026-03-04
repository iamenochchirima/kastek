import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getWhatsappInboxSendQueue } from "@/lib/whatsapp/queue";

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

    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: {
        id: true,
      },
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
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const queue = getWhatsappInboxSendQueue();
    await queue.add("send-service-message", {
      conversationId: conversation.id,
      userId,
      text,
    });

    return NextResponse.json({
      success: true,
      queued: true,
    }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send reply";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
