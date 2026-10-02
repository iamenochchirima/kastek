import { createId } from "@paralleldrive/cuid2";
import type { FastifyRequest } from "fastify";
import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import { apiJson } from "../../json.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import {
  enqueueMessageLifecycle,
  precedingCustomerResponseTimeMs,
} from "../../analytics/inbox.js";
import { bad, missing, getConnectionRowForOrg } from "./common.js";
import {
  scopedWhatsappConversation,
  parseConversationIdentifier,
  sanitizeFilename,
  previewText,
} from "./inbox-read.js";
import { uploadWhatsappMedia, sendMediaMessage } from "./inbox-provider.js";
import {
  createInboxDeliveryOptions,
  type InboxDeliveryOptions,
} from "./inbox-queue.js";
import {
  CREATE_ATTACHMENT_0,
  CREATE_REFERENCE_0,
} from "../inbox/message_domain-sql.js";
import * as sql from "./inbox-media-sql.js";

export interface WhatsappMediaUpload {
  bytes: Uint8Array;
  filename: string | null;
  mimeType: string | null;
  caption: string | null;
  replyToMessageId: string | null;
}
export function mediaKindFromUpload(
  filename: string | null,
  mimeType: string | null,
): string {
  const asciiLower = (value: string) =>
    value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const mime = asciiLower(mimeType ?? "");
  for (const kind of ["image", "video", "audio"])
    if (mime.startsWith(kind + "/")) return kind;
  const extension = asciiLower(filename?.split(".").at(-1) ?? "");
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) return "image";
  if (["mp4", "mov", "webm", "mkv"].includes(extension)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac"].includes(extension)) return "audio";
  return "document";
}
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}
export async function readWhatsappMultipart(
  request: FastifyRequest,
): Promise<WhatsappMediaUpload> {
  const upload: WhatsappMediaUpload = {
    bytes: Buffer.alloc(0),
    filename: null,
    mimeType: null,
    caption: null,
    replyToMessageId: null,
  };
  try {
    // Rust's Multipart has no service-owned size cap; do not inherit the logo cap.
    for await (const part of request.parts({
      limits: {
        fileSize: Infinity,
        fieldSize: Infinity,
        files: Infinity,
        fields: Infinity,
        parts: Infinity,
      },
    })) {
      let bytes: Uint8Array;
      if (part.type === "file") {
        bytes = await part.toBuffer();
        if (part.fieldname === "file") {
          upload.filename = sanitizeFilename(part.filename);
          upload.mimeType = part.mimetype.split(";")[0]!;
        }
      } else
        bytes = Buffer.isBuffer(part.value)
          ? part.value
          : Buffer.from(String(part.value));
      if (part.fieldname === "file") upload.bytes = bytes;
      else if (part.fieldname === "caption") {
        const value = utf8(bytes).trim();
        if (value) upload.caption = value;
      } else if (part.fieldname === "replyToMessageId") {
        const value = utf8(bytes).trim();
        if (value) upload.replyToMessageId = value;
      }
    }
  } catch {
    throw bad("Failed to read multipart payload");
  }
  return upload;
}
export async function sendConversationMedia(
  context: CoreContext,
  userId: string,
  orgId: string,
  id: string,
  upload: WhatsappMediaUpload,
  options: InboxDeliveryOptions = createInboxDeliveryOptions(context),
): Promise<Record<string, unknown>> {
  const { pool, config } = context;
  const conversation = await scopedWhatsappConversation(pool, orgId, id);
  if (!conversation) throw missing("Conversation not found");
  const parsed = parseConversationIdentifier(conversation.customer_identifier);
  if (!parsed) throw bad("Invalid conversation");
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    parsed.connectionId,
  );
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(config, connection.access_token_encrypted);
  if (!upload.bytes.byteLength)
    throw bad("Attachment file is required in form-data field: file");
  const filename =
      upload.filename || `attachment-${Math.floor(Date.now() / 1000)}.bin`,
    kind = mediaKindFromUpload(filename, upload.mimeType);
  const replyId = upload.replyToMessageId?.trim(),
    target = replyId
      ? (await pool.query(sql.MEDIA_DELIVERY_0, [replyId, id])).rows[0]
      : null;
  if (replyId && !target) throw missing("Reply target not found");
  if (target && target.whatsapp_message_id === null)
    throw bad(
      "This message cannot be replied to yet. Try again in a few seconds.",
    );
  const uploaded = await uploadWhatsappMedia(
    connection.phone_number_id,
    token,
    upload.bytes,
    filename,
    upload.mimeType,
    options,
  );
  const sent = await sendMediaMessage(
    connection.phone_number_id,
    token,
    parsed.phone,
    kind,
    uploaded.mediaId,
    upload.caption,
    filename,
    target?.whatsapp_message_id ?? null,
    options,
  );
  const messageId = createId(),
    now = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.MEDIA_DELIVERY_1, [
      messageId,
      id,
      upload.caption ?? "",
      sent.messageId,
      now,
    ]);
    await tx.query(sql.MEDIA_DELIVERY_2, [now, id]);
    const responseTime = await precedingCustomerResponseTimeMs(tx, id, now);
    await enqueueMessageLifecycle(
      tx,
      orgId,
      messageId,
      id,
      "whatsapp",
      "created",
      "outbound",
      "human",
      "media",
      "sent",
      responseTime,
      now,
    );
    const checksum =
      typeof uploaded.raw?.sha256 === "string" ? uploaded.raw.sha256 : null;
    // Keep attachment and reply projections atomic with their delivered message.
    await tx.query(CREATE_ATTACHMENT_0, [
      createId(),
      messageId,
      uploaded.mediaId,
      kind,
      upload.mimeType,
      filename,
      checksum,
      apiJson({ source: "whatsapp_upload" }),
    ]);
    if (target)
      await tx.query(CREATE_REFERENCE_0, [
        createId(),
        messageId,
        target.id,
        target.whatsapp_message_id,
        previewText(target.content, 180),
        "TEXT",
      ]);
  });
  await options.events.publishMessageCreated(pool, userId, messageId);
  await options.events.publishConversationUpdated(pool, userId, id);
  return {
    success: true,
    messageId,
    mediaId: uploaded.mediaId,
    status: "SENT",
  };
}
