import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import type { CoreConfig } from "../../config.js";
import { transaction } from "../../db.js";
import { AgentPlatformClient } from "../agent-platform/client.js";
import { sendPushNotificationToUser } from "../notifications.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { uploadContentMediaBytes } from "../social/media.js";
import { createAttachment } from "../inbox/message-domain.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import { enqueueRecipientUnsubscribed } from "../../analytics/campaigns.js";
import {
  normalizePhone,
  selectConnectionSql,
  type MarketingOptions,
} from "./common.js";
import { recomputeCampaignStats, publishCampaignUpdated } from "./campaigns.js";
import { sendTextMessage, downloadMediaBytes } from "./inbox-provider.js";
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
  client?: (
    config: CoreConfig,
  ) => Pick<
    AgentPlatformClient,
    | "decideChannelApproval"
    | "consumeChannelPairing"
    | "ingestChannelMessage"
    | "updateChannelDeliveryStatus"
  >;
  download?: typeof downloadMediaBytes;
  upload?: typeof uploadContentMediaBytes;
  sendPush?: typeof sendPushNotificationToUser;
}
const { obj, str, arr } = normalize;
function agent(config: CoreConfig, options: WhatsappWebhookOptions) {
  return options.client?.(config) ?? new AgentPlatformClient(config);
}
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
async function acknowledgeFailure(
  connection: Row,
  phone: string,
  providerId: string | null,
  options: WhatsappWebhookOptions,
): Promise<void> {
  try {
    const token = decryptSocialSecret(
      options.config,
      connection.access_token_encrypted,
    );
    await sendTextMessage(
      connection.phone_number_id,
      token,
      phone,
      normalize.INGEST_FAILURE_MESSAGE,
      providerId,
      options,
    );
  } catch (error) {
    warn(options, "channel.ingest.failure_acknowledge", error);
  }
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
  const external = (
      await pool.query(sql.handle_incoming_messages[0], [org, connection.id])
    ).rows[0]?.id,
    channelKey = external ?? `ext_${connection.id}`,
    contacts = arr(input.contacts);
  for (const raw of arr(input.messages)) {
    const message = obj(raw),
      from = str(message.from) ?? "";
    if (!from.trim()) continue;
    const phone = normalizePhone(from, config);
    if (!phone) continue;
    const identity = phone.startsWith("+") ? phone.slice(1) : phone,
      text = normalize.inboundText(message),
      media = normalize.incomingMedia(message),
      approval = normalize.inboundApprovalToken(message),
      providerId = str(message.id);
    if (approval) {
      let response: unknown = null;
      let decided = false;
      try {
        response = await agent(config, options).decideChannelApproval(
          org,
          connection.user_id,
          {
            token: approval,
            channelType: "whatsapp",
            externalIdentity: identity,
          },
        );
        decided = true;
      } catch (error) {
        warn(options, "whatsapp.approval.decide", error);
      }
      const token = decryptSocialSecret(
        config,
        connection.access_token_encrypted,
      );
      await sendTextMessage(
        connection.phone_number_id,
        token,
        phone,
        !decided
          ? "Approval could not be processed. Try again."
          : normalize.approvalAcknowledgement(response),
        providerId,
        options,
      ).catch((error) => warn(options, "approval.acknowledge", error));
      continue;
    }
    const pairing = text?.trim();
    if (
      pairing?.startsWith("kasiai_pair_") &&
      !/\p{White_Space}/u.test(pairing)
    ) {
      let paired = false;
      try {
        await agent(config, options).consumeChannelPairing(
          org,
          connection.user_id,
          pairing,
          identity,
        );
        paired = true;
      } catch {}
      const token = decryptSocialSecret(
        config,
        connection.access_token_encrypted,
      );
      await sendTextMessage(
        connection.phone_number_id,
        token,
        phone,
        paired
          ? "WhatsApp is now connected to your KasiAi conversation."
          : "That KasiAi pairing code is invalid or expired. Create a new code in KasiTek and try again.",
        providerId,
        options,
      ).catch((error) => warn(options, "pairing.acknowledge", error));
      continue;
    }
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
    let agentMedia: {
      asset: Awaited<ReturnType<typeof uploadContentMediaBytes>>;
      mime: string;
    } | null = null;
    if (media && providerId !== null) {
      const kind = normalize.agentMediaKind(media);
      if (kind === null) {
        const token = decryptSocialSecret(
          config,
          connection.access_token_encrypted,
        );
        await sendTextMessage(
          connection.phone_number_id,
          token,
          phone,
          "I can process image, video, and audio attachments. Please send the file in one of those formats.",
          providerId,
          options,
        ).catch(() => {});
        continue;
      }
      const token = decryptSocialSecret(
        config,
        connection.access_token_encrypted,
      );
      try {
        const downloaded = await (options.download ?? downloadMediaBytes)(
            token,
            media.mediaId,
            normalize.agentMediaLimit(kind),
            options,
          ),
          mime = normalize.agentMediaMime(media, downloaded.contentType, kind),
          asset = await (options.upload ?? uploadContentMediaBytes)(
            pool,
            config,
            connection.user_id,
            org,
            {
              fileName: media.filename,
              mimeType: mime,
              bytes: Buffer.from(downloaded.bytes),
              source: "whatsapp",
              sourceKey: `whatsapp:${connection.id}:${providerId}:${media.mediaId}`,
            },
          );
        agentMedia = { asset, mime };
      } catch (error) {
        warn(options, "whatsapp.media.store", error);
      }
      if (agentMedia === null) {
        await sendTextMessage(
          connection.phone_number_id,
          token,
          phone,
          normalize.mediaFailureMessage(kind),
          providerId,
          options,
        ).catch((error) => warn(options, "media.failure_acknowledge", error));
        continue;
      }
    }
    if (providerId !== null) {
      let body: Row;
      if (agentMedia) {
        body = {
          assetId: agentMedia.asset.id,
          attachmentId: media?.mediaId ?? null,
          mimeType: agentMedia.mime,
          fileName: media?.filename ?? null,
          mediaKind: agentMedia.asset.kind,
          text: content,
        };
        if (media && normalize.agentMediaKind(media) === "audio")
          body.transcription = { status: "queued", provider: "elevenlabs" };
      } else if (media === null) body = { text: content };
      else continue;
      const payload: Row = {
        channelType: "whatsapp",
        channelKey,
        provider: "meta-whatsapp",
        providerEventId: providerId,
        providerMessageId: providerId,
        externalIdentity: identity,
        externalConversationId: conversation,
        messageType: agentMedia ? "attachment" : "text",
        content: body,
      };
      if (profile?.trim()) payload.displayName = profile.trim();
      try {
        await agent(config, options).ingestChannelMessage(
          org,
          connection.user_id,
          payload,
        );
      } catch (error) {
        warn(options, "channel.ingest", error);
        await acknowledgeFailure(connection, phone, providerId, options);
      }
    }
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
        const phone = str(obj(obj(value).metadata).phone_number_id),
          status = obj(rawStatus),
          message = str(status.id),
          providerStatus = str(status.status);
        if (phone !== null && message !== null && providerStatus !== null) {
          const scope = (
            await pool.query(sql.process_webhook_payload[0], [phone])
          ).rows[0];
          if (scope) {
            try {
              const next = ["sent", "delivered", "read", "failed"].includes(
                  providerStatus.toLowerCase(),
                )
                  ? providerStatus.toLowerCase()
                  : "unknown",
                [code, error] = normalize.parseStatusFailureDetails(status);
              await agent(config, options).updateChannelDeliveryStatus(
                scope.orgId,
                scope.userId,
                {
                  providerMessageId: message,
                  status: next,
                  ...(next === "failed"
                    ? { error: { code, message: error } }
                    : {}),
                },
              );
            } catch {}
          }
        }
      }
      await options.ingestCalls(pool, config, value);
      await handleIncomingMessages(pool, config, value, options);
    }
}
