import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { getWhatsappMessageDisplayText } from "@/lib/whatsapp/message-content";
import { uploadWhatsappMedia } from "@/lib/whatsapp/meta-api";
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
    const contentType = req.headers.get("content-type") || "";
    const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

    let text: string | undefined;
    let file: File | null = null;
    let replyToMessageId: string | undefined;

    if (isMultipart) {
      const formData = await req.formData();
      const textInput = String(formData.get("text") || "").trim();
      text = textInput || undefined;
      const upload = formData.get("file");
      file = upload instanceof File ? upload : null;
      replyToMessageId = String(formData.get("replyToMessageId") || "").trim() || undefined;
    } else {
      const body = (await req.json()) as { text?: string; replyToMessageId?: string };
      text = body.text?.trim() || undefined;
      replyToMessageId = body.replyToMessageId?.trim() || undefined;
    }

    if (!text && !file) {
      return NextResponse.json({ error: "Reply text or media file is required" }, { status: 400 });
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
        customerIdentifier: true,
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    let replyToWhatsappMessageId: string | undefined;
    let replyPreview: string | undefined;
    if (replyToMessageId) {
      const replyTarget = await prisma.message.findFirst({
        where: {
          id: replyToMessageId,
          conversationId: conversation.id,
        },
        select: {
          id: true,
          content: true,
          whatsappMessageId: true,
        },
      });

      if (!replyTarget) {
        return NextResponse.json({ error: "Reply target not found" }, { status: 404 });
      }

      if (!replyTarget.whatsappMessageId) {
        return NextResponse.json(
          { error: "This message cannot be replied to yet. Try again in a few seconds." },
          { status: 400 }
        );
      }

      replyToWhatsappMessageId = replyTarget.whatsappMessageId;
      replyPreview = getWhatsappMessageDisplayText(replyTarget.content).slice(0, 180);
    }

    let mediaPayload:
      | {
          kind: "image" | "video" | "audio" | "document";
          mediaId: string;
          mimeType?: string | null;
          caption?: string | null;
          filename?: string | null;
        }
      | undefined;

    if (file) {
      const parsedConversation = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
      if (!parsedConversation?.connectionId) {
        return NextResponse.json({ error: "Invalid conversation" }, { status: 400 });
      }

      const connection = await prisma.whatsappConnection.findFirst({
        where: {
          id: parsedConversation.connectionId,
          userId,
        },
        select: {
          phoneNumberId: true,
          accessTokenEncrypted: true,
        },
      });

      if (!connection) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }

      const maxBytes = 16 * 1024 * 1024;
      if (file.size > maxBytes) {
        return NextResponse.json({ error: "File is too large (max 16MB)" }, { status: 400 });
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const mimeType = file.type || "application/octet-stream";
      const lowered = mimeType.toLowerCase();
      const kind: "image" | "video" | "audio" | "document" = lowered.startsWith("image/")
        ? "image"
        : lowered.startsWith("video/")
          ? "video"
          : lowered.startsWith("audio/")
            ? "audio"
            : "document";

      const accessToken = decryptSecret(connection.accessTokenEncrypted);
      const upload = await uploadWhatsappMedia({
        phoneNumberId: connection.phoneNumberId,
        accessToken,
        bytes,
        filename: file.name || `upload-${Date.now()}`,
        mimeType,
      });

      mediaPayload = {
        kind,
        mediaId: upload.mediaId,
        mimeType,
        caption: text || null,
        filename: file.name || null,
      };
    }

    const queue = getWhatsappInboxSendQueue();
    await queue.add("send-service-message", {
      conversationId: conversation.id,
      userId,
      text,
      media: mediaPayload,
      replyToMessageId,
      replyPreview,
      replyToWhatsappMessageId,
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
