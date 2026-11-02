import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import type { CoreConfig } from "../../config.js";
import { transaction } from "../../db.js";
import { sendPushNotificationToUser } from "../notifications.js";
import { createAttachment } from "../inbox/message-domain.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import { enqueueRecipientUnsubscribed } from "../../analytics/campaigns.js";
import {
  normalizePhone,
  selectConnectionSql,
  type MarketingOptions,
} from "./common.js";
import { recomputeCampaignStats, publishCampaignUpdated } from "./campaigns.js";
import { previewText } from "./inbox-read.js";
import {
  findOrCreateConversation,
  publishMessageCreated,
  publishConversationUpdated,
} from "./webhook-common.js";
import * as normalize from "./webhook-normalization.js";
import { handleStatus } from "./webhooks-status.js";
import { WEBHOOK_SQL as sql } from "./webhooks-sql.js";
import type { Row } from "./types.js";
export interface WhatsappWebhookOptions extends MarketingOptions {
  ingestCalls: (
    pool: Pool,
    config: CoreConfig,
    value: unknown,
  ) => Promise<void>;
  sendPush?: typeof sendPushNotificationToUser;
}
const { obj, str, arr } = normalize;
function warn(
  options: WhatsappWebhookOptions,
  operation: string,
  error?: unknown,
): void {
  options.logger?.warn(
    {
      event: "operation.failed",
      operation,
      ...(error instanceof Error ? { error_type: error.name } : {}),
    },
    "WhatsApp webhook operation failed",
  );
}
export async function handleIncomingMessages(
  pool: Pool,
  config: CoreConfig,
  value: unknown,
  options: WhatsappWebhookOptions,
): Promise<void> {
  const input = obj(value),
    phoneId = str(obj(input.metadata).phone_number_id);
  if (phoneId === null) return;
  const connection = (
    await pool.query(
      `${selectConnectionSql} WHERE "phoneNumberId"=$1 LIMIT 1`,
      [phoneId],
    )
  ).rows[0];
  if (!connection) return;
  const org = connection.org_id;
  if (org == null) {
    warn(options, "webhook.resolve_organization");
    return;
  }
  const contacts = arr(input.contacts);
  for (const raw of arr(input.messages)) {
    const message = obj(raw),
      from = str(message.from) ?? "";
    if (!from.trim()) continue;
    const phone = normalizePhone(from, config);
    if (!phone) continue;
    const text = normalize.inboundText(message),
      media = normalize.incomingMedia(message),
      providerId = str(message.id);
    if (text === null && media === null) continue;
    const profile = str(
        obj(obj(contacts.find((value) => obj(value).wa_id === from)).profile)
          .name,
      ),
      [conversation, unread, _last, customer] = await findOrCreateConversation(
        pool,
        org,
        connection.id,
        phone,
        profile,
      );
    let contact = (
      await pool.query(sql.handle_incoming_messages[1], [org, phone])
    ).rows[0]?.id;
    if (contact)
      await pool.query(sql.handle_incoming_messages[2], [profile, contact]);
    else {
      contact = createId();
      await pool.query(sql.handle_incoming_messages[3], [
        contact,
        connection.user_id,
        org,
        phone,
        profile,
      ]);
    }
    await pool.query(sql.handle_incoming_messages[4], [customer, contact, org]);
    const content = text ?? media?.caption ?? "",
      messageId = createId(),
      occurred = new Date();
    await transaction(pool, async (tx) => {
      await tx.query(sql.handle_incoming_messages[5], [
        messageId,
        conversation,
        content,
        media ? "MEDIA" : "TEXT",
        providerId,
        occurred,
      ]);
      await tx.query(sql.handle_incoming_messages[6], [unread, conversation]);
      await enqueueMessageLifecycle(
        tx,
        org,
        messageId,
        conversation,
        "whatsapp",
        "created",
        "inbound",
        "customer",
        media ? "media" : "text",
        null,
        null,
        occurred,
      );
    });
    if (media)
      await createAttachment(
        pool,
        messageId,
        media.mediaId,
        media.kind,
        media.mimeType,
        media.filename,
        media.sha256,
        { source: "whatsapp_webhook" },
      );
    await publishMessageCreated(pool, connection.user_id, messageId, options);
    await publishConversationUpdated(
      pool,
      connection.user_id,
      conversation,
      options,
    );
    await (options.sendPush ?? sendPushNotificationToUser)(
      { pool, config },
      connection.user_id,
      {
        title: "New WhatsApp message",
        body: `${profile?.trim() ? profile : phone}: ${previewText(content, 120)}`,
        url: "/inbox",
        tag: `conversation:${conversation}`,
      },
    ).catch((error) => warn(options, "push_notification.send", error));
    if (normalize.isOptOutMessage(text)) {
      const now = new Date();
      const recipients = await transaction(pool, async (tx) => {
        await tx.query(sql.handle_incoming_messages[7], [
          `Unsubscribed via STOP keyword on ${new Date().toISOString().replace("Z", "+00:00")}`,
          contact,
        ]);
        const rows = (
          await tx.query(sql.handle_incoming_messages[8], [contact])
        ).rows;
        await tx.query(sql.handle_incoming_messages[9], [contact]);
        for (const row of rows)
          await enqueueRecipientUnsubscribed(
            tx,
            org,
            row.campaignId,
            row.id,
            "whatsapp",
            "meta",
            "keyword",
            now,
          );
        return rows;
      });
      for (const campaign of new Set(
        recipients.map((row) => row.campaignId as string),
      )) {
        await recomputeCampaignStats(pool, campaign);
        const user = (
          await pool.query(sql.handle_incoming_messages[10], [campaign])
        ).rows[0]?.userId;
        if (user) await publishCampaignUpdated(pool, user, campaign, options);
      }
    }
  }
}
export async function processWebhookPayload(
  pool: Pool,
  config: CoreConfig,
  payload: unknown,
  options: WhatsappWebhookOptions,
): Promise<void> {
  for (const rawEntry of arr(obj(payload).entry))
    for (const rawChange of arr(obj(rawEntry).changes)) {
      const value = obj(rawChange).value;
      for (const rawStatus of arr(obj(value).statuses)) {
        await handleStatus(pool, rawStatus, options);

      }
      await options.ingestCalls(pool, config, value);
      await handleIncomingMessages(pool, config, value, options);
    }
}
