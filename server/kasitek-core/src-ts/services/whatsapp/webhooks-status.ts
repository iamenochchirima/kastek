import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import { transaction } from "../../db.js";
import { canonicalJson } from "@kasitek/server-support/json";
import * as analytics from "../../analytics/campaigns.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import { recordEvent } from "../inbox/message-domain.js";
import { recomputeCampaignStats, publishCampaignUpdated } from "./campaigns.js";
import {
  loadConversationById,
  publishMessageUpdated,
} from "./webhook-common.js";
import { parseConversationIdentifier } from "./inbox-read.js";
import {
  obj,
  str,
  parseStatusFailureDetails,
  isBlockedFailure,
  parseStatusPricingDetails,
} from "./webhook-normalization.js";
import { WEBHOOK_SQL as sql } from "./webhooks-sql.js";
import type { MarketingOptions } from "./common.js";
export function providerTimestamp(value: unknown): Date {
  if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    try {
      const secs = BigInt(value);
      if (secs >= -9223372036854775808n && secs <= 9223372036854775807n) {
        const time = new Date(Number(secs * 1000n));
        if (Number.isFinite(time.getTime())) return time;
      }
    } catch {}
  }
  return new Date();
}
function nanos(value: Date | string): bigint {
  const date = value instanceof Date ? value : new Date(value),
    fraction = date.toISOString().match(/\.(\d+)/)?.[1] ?? "";
  return (
    BigInt(date.getTime()) * 1000000n + BigInt(fraction.slice(3).padEnd(6, "0"))
  );
}
function durationMs(time: Date, previous: Date | string): bigint {
  const ms = (nanos(time) - nanos(previous)) / 1000000n;
  return ms < 0n ? 0n : ms;
}
export async function handleStatus(
  pool: Pool,
  payload: unknown,
  options: MarketingOptions,
): Promise<void> {
  const status = obj(payload),
    messageId = str(status.id);
  if (messageId === null) return;
  const mapped: Record<string, string> = {
      sent: "SENT",
      delivered: "DELIVERED",
      read: "READ",
      failed: "FAILED",
    },
    provider = mapped[str(status.status) ?? ""];
  if (!provider) return;
  const time = providerTimestamp(status.timestamp),
    [code, message] =
      provider === "FAILED" ? parseStatusFailureDetails(status) : [null, null],
    next =
      provider === "FAILED" && isBlockedFailure(code, message)
        ? "BLOCKED"
        : provider,
    pricing = parseStatusPricingDetails(status);
  const recipient = (await pool.query(sql.handle_status[0], [messageId]))
    .rows[0];
  if (recipient) {
    if (recipient.status !== next) {
      await transaction(pool, async (tx) => {
        await tx.query(sql.handle_status[1], [
          next,
          time,
          code,
          message,
          recipient.id,
        ]);
        if (["DELIVERED", "READ", "FAILED", "BLOCKED"].includes(next)) {
          const org = (
            await tx.query(sql.handle_status[2], [recipient.campaign_id])
          ).rows[0].orgId;
          const args = [
            org,
            recipient.campaign_id,
            recipient.id,
            "whatsapp",
            "meta",
          ] as const;
          if (next === "DELIVERED")
            await analytics.enqueueRecipientDelivered(tx, ...args, time);
          if (next === "READ")
            await analytics.enqueueRecipientRead(tx, ...args, time);
          if (next === "FAILED")
            await analytics.enqueueRecipientFailed(
              tx,
              ...args,
              "provider_rejected",
              time,
            );
          if (next === "BLOCKED")
            await analytics.enqueueRecipientBlocked(
              tx,
              ...args,
              "provider_blocked",
              time,
            );
          if (next === "DELIVERED" && recipient.sent_at)
            await analytics.enqueueRecipientTiming(
              tx,
              ...args,
              "send_to_delivered",
              durationMs(time, recipient.sent_at),
              time,
            );
          if (next === "READ") {
            if (recipient.sent_at)
              await analytics.enqueueRecipientTiming(
                tx,
                ...args,
                "send_to_read",
                durationMs(time, recipient.sent_at),
                time,
              );
            if (recipient.delivered_at)
              await analytics.enqueueRecipientTiming(
                tx,
                ...args,
                "delivered_to_read",
                durationMs(time, recipient.delivered_at),
                time,
              );
          }
        }
      });
      if (["FAILED", "BLOCKED"].includes(next)) {
        const campaign = (
          await pool.query(sql.handle_status[3], [recipient.campaign_id])
        ).rows[0];
        if (campaign)
          await pool.query(sql.handle_status[4], [
            createId(),
            campaign.user_id,
            campaign.connection_id,
            campaign.id,
            recipient.id,
            recipient.contact_id,
            recipient.snapshot_phone ?? "",
            campaign.template_name,
            next,
            messageId,
            canonicalJson(status),
            code,
            message,
          ]);
      }
      await recomputeCampaignStats(pool, recipient.campaign_id);
      const user = (
        await pool.query(sql.handle_status[5], [recipient.campaign_id])
      ).rows[0]?.userId;
      if (user)
        await publishCampaignUpdated(
          pool,
          user,
          recipient.campaign_id,
          options,
        );
    }
    if (pricing)
      await transaction(pool, async (tx) => {
        const org = (
          await tx.query(sql.handle_status[6], [recipient.campaign_id])
        ).rows[0].orgId;
        await tx.query(sql.handle_status[7], [
          pricing.billable,
          pricing.category,
          pricing.model,
          pricing.pricingType,
          recipient.campaign_id,
          recipient.id,
          messageId,
        ]);
        await analytics.enqueueRecipientPricing(
          tx,
          org,
          recipient.campaign_id,
          recipient.id,
          "whatsapp",
          "meta",
          pricing.billable,
          pricing.category,
          pricing.model,
          pricing.pricingType,
          time,
        );
      });
    return;
  }
  const rows = await transaction(pool, async (tx) => {
    const rows = (await tx.query(sql.handle_status[8], [next, messageId])).rows;
    for (const row of rows) {
      const metadata = obj(row.provider_metadata),
        responder =
          typeof metadata._kasitek_agent_idempotency_key === "string" &&
          metadata._kasitek_agent_idempotency_key
            ? "agent"
            : metadata._kasitek_inbox_message_kind === "template"
              ? "system"
              : "human",
        type = (row.message_type ?? "text").toLowerCase(),
        org = (await tx.query(sql.handle_status[9], [row.conversation_id]))
          .rows[0].orgId;
      await enqueueMessageLifecycle(
        tx,
        org,
        row.id,
        row.conversation_id,
        "whatsapp",
        "delivery_updated",
        "outbound",
        responder,
        type,
        next.toLowerCase(),
        null,
        time,
      );
    }
    return rows;
  });
  for (const row of rows) {
    await recordEvent(
      pool,
      row.conversation_id,
      row.id,
      row.whatsapp_message_id == null
        ? null
        : `whatsapp:status:${row.whatsapp_message_id}:${next}`,
      `STATUS_${next}`,
      { provider: "whatsapp", status: next },
    );
    const conversation = await loadConversationById(pool, row.conversation_id);
    if (conversation) {
      const identifier = parseConversationIdentifier(
        conversation.customer_identifier,
      );
      if (identifier) {
        const user = (
          await pool.query(sql.handle_status[10], [identifier.connectionId])
        ).rows[0]?.userId;
        if (user)
          await publishMessageUpdated(
            pool,
            user,
            row.conversation_id,
            row.id,
            next,
            row.error_code,
            row.error_message,
            options,
          );
      }
    }
  }
}
