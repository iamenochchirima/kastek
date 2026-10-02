import { createId } from "@paralleldrive/cuid2";
import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import { apiJson } from "../../json.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import {
  enqueueMessageLifecycle,
  precedingCustomerResponseTimeMs,
} from "../../analytics/inbox.js";
import { readContentMediaBytes } from "../social/media.js";
import { recordSourceHealth } from "../connections.js";
import { missing, bad, getConnectionRowForOrg } from "./common.js";
import {
  scopedWhatsappConversation,
  parseConversationIdentifier,
} from "./inbox-read.js";
import {
  extractMarkdownImages,
  formatWhatsappText,
  validateAgentDeliveryIdempotencyKey,
  isProviderAuthenticationFailure,
} from "./inbox-formatting.js";
import {
  uploadWhatsappMedia,
  sendMediaMessage,
  sendMediaLinkMessage,
  sendTextMessage,
  sendReplyButtonMessage,
  type WhatsappReplyButton,
} from "./inbox-provider.js";
import {
  deliveryErrorText,
  createInboxDeliveryOptions,
  type InboxDeliveryOptions,
} from "./inbox-queue.js";
import * as sql from "./inbox-agent-sql.js";
import type { WhatsappConnectionRow } from "./types.js";

export interface AgentMediaAttachment {
  assetId: string;
  kind: string;
  mimeType?: string | null;
  fileName?: string | null;
  altText?: string | null;
  caption?: string | null;
  disposition?: string | null;
}
type Claim =
  | { kind: "replay"; result: Record<string, unknown> }
  | { kind: "deliver"; connection: WhatsappConnectionRow; token: string };
function replay(
  prior: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (
    prior?.provider_message_id !== null &&
    prior?.provider_message_id !== undefined
  )
    return {
      providerMessageId: prior.provider_message_id,
      status: "sent",
      idempotentReplay: true,
    };
  if (prior && String(prior.status ?? "").toUpperCase() !== "FAILED")
    return {
      status: "unknown",
      idempotentReplay: true,
      providerStatus: prior.status ?? "",
    };
  return null;
}
function storedMedia(
  media: readonly AgentMediaAttachment[],
): Record<string, unknown>[] {
  // serde includes absent Option fields as explicit null when writing metadata.
  return media.map((item) => ({
    assetId: item.assetId,
    kind: item.kind,
    mimeType: item.mimeType ?? null,
    fileName: item.fileName ?? null,
    altText: item.altText ?? null,
    caption: item.caption ?? null,
    disposition: item.disposition ?? null,
  }));
}
export async function deliverAgentMessage(
  context: CoreContext,
  orgId: string,
  conversationId: string,
  text: string,
  key: string,
  media: readonly AgentMediaAttachment[],
  buttons: readonly WhatsappReplyButton[],
  options: InboxDeliveryOptions = createInboxDeliveryOptions(context),
): Promise<Record<string, unknown>> {
  const { pool, config } = context;
  key = validateAgentDeliveryIdempotencyKey(key);
  const conversation = await scopedWhatsappConversation(
    pool,
    orgId,
    conversationId,
  );
  if (!conversation) throw missing("WhatsApp conversation not found");
  const parsed = parseConversationIdentifier(conversation.customer_identifier);
  if (!parsed) throw bad("Invalid WhatsApp conversation");
  const messageId = createId(),
    now = new Date(),
    messageType = media.length ? "attachment" : "text";
  const existing = replay(
    (await pool.query(sql.AGENT_DELIVERY_0, [conversationId, key])).rows[0],
  );
  if (existing) return existing;
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    parsed.connectionId,
  );
  if (!connection) throw missing("WhatsApp connection not found");
  const token = decryptSocialSecret(config, connection.access_token_encrypted);
  // Serialize each durable claim before provider effects. A concurrent request
  // sees SENDING and returns unknown instead of sending a duplicate.
  const claim = await transaction<Claim>(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `whatsapp-agent:${conversationId}:${key}`,
    ]);
    const prior = (await tx.query(sql.AGENT_DELIVERY_0, [conversationId, key]))
      .rows[0];
    const result = replay(prior);
    if (result) return { kind: "replay", result };
    await tx.query(sql.AGENT_DELIVERY_1, [
      messageId,
      conversationId,
      text,
      apiJson({
        _kasitek_agent_idempotency_key: key,
        _kasitek_agent_media: storedMedia(media),
      }),
      now,
    ]);
    await tx.query(sql.AGENT_DELIVERY_2, [conversationId, orgId]);
    const responseTime = await precedingCustomerResponseTimeMs(
      tx,
      conversationId,
      now,
    );
    await enqueueMessageLifecycle(
      tx,
      orgId,
      messageId,
      conversationId,
      "whatsapp",
      "created",
      "outbound",
      "agent",
      messageType,
      "sending",
      responseTime,
      now,
    );
    return { kind: "deliver", connection, token };
  });
  if (claim.kind === "replay") return claim.result;
  const extracted = extractMarkdownImages(text),
    rendered = formatWhatsappText(extracted.text);
  type Sent = { messageId: string; raw: Record<string, unknown> | null };
  let sent: Sent;
  if (!buttons.length && (extracted.images.length || media.length)) {
    // Preserve unknown-outcome behavior after partial media effects. Throwing
    // here retains SENDING, so retries cannot duplicate an already-sent image.
    let last: Sent | null = null;
    for (const item of media) {
      if (!["image", "video", "audio"].includes(item.kind)) continue;
      const stored = await readContentMediaBytes(
        pool,
        config,
        orgId,
        item.assetId,
      );
      const filename = item.fileName?.trim() ? item.fileName : "attachment";
      const upload = await uploadWhatsappMedia(
        connection.phone_number_id,
        token,
        stored.bytes,
        filename,
        stored.mime_type,
        options,
      );
      const caption =
        (item.caption ??
          (!last && [...rendered].length <= 1024 ? rendered : null)) ||
        null;
      last = await sendMediaMessage(
        connection.phone_number_id,
        token,
        parsed.phone,
        item.kind,
        upload.mediaId,
        caption,
        filename,
        null,
        options,
      );
    }
    for (let index = 0; index < extracted.images.length; index++) {
      const caption =
        index === 0 && [...rendered].length <= 1024 && rendered
          ? rendered
          : null;
      last = await sendMediaLinkMessage(
        connection.phone_number_id,
        token,
        parsed.phone,
        extracted.images[index]!,
        caption,
        null,
        options,
      );
    }
    if (rendered && ([...rendered].length > 1024 || !last))
      last = await sendTextMessage(
        connection.phone_number_id,
        token,
        parsed.phone,
        rendered,
        null,
        options,
      );
    if (!last) throw bad("WhatsApp has no compatible media or text to deliver");
    sent = last;
  } else {
    try {
      sent = buttons.length
        ? await sendReplyButtonMessage(
            connection.phone_number_id,
            token,
            parsed.phone,
            rendered,
            buttons,
            null,
            options,
          )
        : await sendTextMessage(
            connection.phone_number_id,
            token,
            parsed.phone,
            rendered,
            null,
            options,
          );
    } catch (error) {
      const message = deliveryErrorText(error),
        authFailed = isProviderAuthenticationFailure(message),
        code = authFailed
          ? "AGENT_DELIVERY_AUTH_FAILED"
          : "AGENT_DELIVERY_FAILED";
      await transaction(pool, async (tx) => {
        await tx.query(sql.AGENT_DELIVERY_4, [
          code,
          message,
          messageId,
          conversationId,
        ]);
        await enqueueMessageLifecycle(
          tx,
          orgId,
          messageId,
          conversationId,
          "whatsapp",
          "delivery_updated",
          "outbound",
          "agent",
          messageType,
          "failed",
          null,
          new Date(),
        );
      });
      if (authFailed)
        try {
          await recordSourceHealth(
            pool,
            orgId,
            "WHATSAPP",
            parsed.connectionId,
            false,
            null,
            message,
          );
        } catch (healthError) {
          options.logger?.warn({
            event: "dependency.unavailable",
            operation: "whatsapp.delivery.health_record",
            connection_id: parsed.connectionId,
            error_type:
              healthError instanceof Error ? healthError.name : "unknown",
          });
        }
      await options.events.publishMessageUpdated(
        pool,
        "agent-platform",
        conversationId,
        messageId,
        "FAILED",
        code,
        message,
      );
      await options.events.publishMessageSendFailed(
        pool,
        "agent-platform",
        conversationId,
        message,
        text,
      );
      throw error;
    }
  }
  await transaction(pool, async (tx) => {
    await tx.query(sql.AGENT_DELIVERY_3, [
      sent.messageId,
      messageId,
      conversationId,
    ]);
    await enqueueMessageLifecycle(
      tx,
      orgId,
      messageId,
      conversationId,
      "whatsapp",
      "delivery_updated",
      "outbound",
      "agent",
      messageType,
      "sent",
      null,
      new Date(),
    );
  });
  return { providerMessageId: sent.messageId, status: "sent" };
}
