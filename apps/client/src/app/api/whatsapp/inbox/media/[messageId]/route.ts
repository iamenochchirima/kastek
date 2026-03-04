import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { parseStoredWhatsappMedia } from "@/lib/whatsapp/message-content";
import { downloadWhatsappMedia } from "@/lib/whatsapp/meta-api";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const MEDIA_DEBUG = process.env.WHATSAPP_WEBHOOK_DEBUG === "1";

function sanitizeFilename(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messageId } = await params;
    if (MEDIA_DEBUG) {
      console.info("[whatsapp:media] request", { messageId, userId });
    }
    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: { id: true },
    });

    if (connections.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversation: {
          channel: "whatsapp",
          OR: connections.map((connection) => ({
            customerIdentifier: {
              startsWith: `wa:${connection.id}:`,
            },
          })),
        },
      },
      select: {
        id: true,
        content: true,
        conversation: {
          select: {
            customerIdentifier: true,
          },
        },
      },
    });

    if (!message) {
      if (MEDIA_DEBUG) {
        console.warn("[whatsapp:media] message not found", { messageId, userId });
      }
      return NextResponse.json({ error: "Media message not found" }, { status: 404 });
    }

    const media = parseStoredWhatsappMedia(message.content);
    if (!media) {
      if (MEDIA_DEBUG) {
        console.warn("[whatsapp:media] not media payload", { messageId });
      }
      return NextResponse.json({ error: "Message does not contain media" }, { status: 400 });
    }

    const parsedConversation = parseWhatsappConversationIdentifier(
      message.conversation.customerIdentifier
    );
    if (!parsedConversation?.connectionId) {
      if (MEDIA_DEBUG) {
        console.warn("[whatsapp:media] invalid conversation identifier", { messageId });
      }
      return NextResponse.json({ error: "Invalid conversation" }, { status: 400 });
    }

    const connection = await prisma.whatsappConnection.findFirst({
      where: {
        id: parsedConversation.connectionId,
        userId,
      },
      select: {
        accessTokenEncrypted: true,
      },
    });

    if (!connection) {
      if (MEDIA_DEBUG) {
        console.warn("[whatsapp:media] connection not found", {
          messageId,
          connectionId: parsedConversation.connectionId,
          userId,
        });
      }
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const accessToken = decryptSecret(connection.accessTokenEncrypted);
    const file = await downloadWhatsappMedia({
      mediaId: media.mediaId,
      accessToken,
    });

    const extension = media.mimeType?.split("/")[1] || "bin";
    const fallbackName = `whatsapp-${media.kind}-${message.id}.${extension}`;
    const filename = sanitizeFilename(media.filename || fallbackName);

    return new NextResponse(file.bytes, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    console.error("[whatsapp:media] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : "Failed to load media";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
