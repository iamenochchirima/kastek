import type { Pool, PoolClient } from "pg";
import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import { ApiError } from "../../error.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import { drainWhatsappInboxQueue, publishInboxEvent } from "../realtime.js";
import * as realtimeEvents from "./webhook-common.js";
import { parseConversationIdentifier } from "./inbox-read.js";
import { sendTextMessage } from "./inbox-provider.js";
import { bad, type ProviderOptions } from "./common.js";
import * as sql from "./inbox-delivery-sql.js";

export interface InboxDeliveryEvents {
  publishConversationUpdated(
    pool: Pool,
    userId: string,
    conversationId: string,
  ): Promise<void>;
  publishMessageCreated(
    pool: Pool,
    userId: string,
    messageId: string,
  ): Promise<void>;
  publishMessageUpdated(
    pool: Pool,
    userId: string,
    conversationId: string,
    messageId: string,
    status: string,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void>;
  publishMessageSendFailed(
    pool: Pool,
    userId: string,
    conversationId: string,
    error: string,
    text: string | null,
  ): Promise<void>;
}
export interface InboxDeliveryOptions extends ProviderOptions {
  events: InboxDeliveryEvents;
  logger?: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
    error(fields: Record<string, unknown>): void;
  };
}
export function createInboxDeliveryOptions(
  context: CoreContext,
  provider: Omit<ProviderOptions, "config"> = {},
): InboxDeliveryOptions {
  const realtime = {
    publishEvent: (orgId: string, event: unknown) =>
      publishInboxEvent(context, orgId, event),
  };
  return {
    config: context.config,
    ...provider,
    events: {
      publishConversationUpdated: (pool, userId, id) =>
        realtimeEvents.publishConversationUpdated(pool, userId, id, realtime),
      publishMessageCreated: (pool, userId, id) =>
        realtimeEvents.publishMessageCreated(pool, userId, id, realtime),
      publishMessageUpdated: (
        pool,
        userId,
        conversation,
        id,
        status,
        code,
        error,
      ) =>
        realtimeEvents.publishMessageUpdated(
          pool,
          userId,
          conversation,
          id,
          status,
          code,
          error,
          realtime,
        ),
      publishMessageSendFailed: (pool, userId, conversation, error, text) =>
        realtimeEvents.publishMessageSendFailed(
          pool,
          userId,
          conversation,
          error,
          text,
          realtime,
        ),
    },
  };
}
interface PendingMessage {
  id: string;
  conversation_id: string;
  org_id: string;
  user_id: string;
  responder_type: string;
  customer_identifier: string;
  phone_number_id: string;
  access_token_encrypted: string;
  content: string;
}
export function deliveryErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    // Rust Display uses human-readable variant labels, persisted in Message.errorMessage.
    const labels: Record<string, string> = {
      bad_request: "bad request",
      not_found: "not found",
      internal_error: "internal",
      gateway_timeout: "gateway timeout",
      rate_limited: "too many requests",
      conflict: "conflict",
    };
    return `${labels[error.code] ?? error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown error";
}
async function claim(
  tx: PoolClient,
  messageId: string | null,
): Promise<PendingMessage | null> {
  const row = (
    await tx.query<PendingMessage>(
      messageId === null
        ? sql.CLAIM_QUEUED_INBOX_MESSAGE_1
        : sql.CLAIM_QUEUED_INBOX_MESSAGE_0,
      messageId === null ? [] : [messageId],
    )
  ).rows[0];
  if (!row) return null;
  await tx.query(sql.CLAIM_QUEUED_INBOX_MESSAGE_2, [row.id]);
  return row;
}
async function deliver(
  tx: PoolClient,
  job: PendingMessage,
  options: InboxDeliveryOptions,
): Promise<void> {
  const parsed = parseConversationIdentifier(job.customer_identifier);
  if (!parsed) throw bad("Invalid conversation identifier");
  const token = decryptSocialSecret(options.config, job.access_token_encrypted);
  const reply =
    (await tx.query(sql.PROCESS_CLAIMED_INBOX_MESSAGE_0, [job.id])).rows[0]
      ?.coalesce ?? null;
  const result = await sendTextMessage(
    job.phone_number_id,
    token,
    parsed.phone,
    job.content,
    reply,
    options,
  );
  await tx.query(sql.PROCESS_CLAIMED_INBOX_MESSAGE_1, [
    job.id,
    result.messageId,
  ]);
  await enqueueMessageLifecycle(
    tx,
    job.org_id,
    job.id,
    job.conversation_id,
    "whatsapp",
    "delivery_updated",
    "outbound",
    job.responder_type,
    "text",
    "sent",
    null,
    new Date(),
  );
}
export async function processSingleQueuedInboxMessage(
  pool: Pool,
  messageId: string | null,
  options: InboxDeliveryOptions,
): Promise<boolean> {
  // Keep the source transaction/row lock across the provider request, so another
  // worker cannot send the same queued row concurrently.
  const result = await transaction(pool, async (tx) => {
    const job = await claim(tx, messageId);
    if (!job) return null;
    options.logger?.info({
      event: "queue.item.claimed",
      worker: "whatsapp_inbox",
      message_id: job.id,
      conversation_id: job.conversation_id,
      explicit: messageId,
    });
    try {
      await deliver(tx, job, options);
      return { job, error: null };
    } catch (error) {
      const message = deliveryErrorText(error);
      await tx.query(sql.FAIL_CLAIMED_INBOX_MESSAGE_0, [job.id, message]);
      await enqueueMessageLifecycle(
        tx,
        job.org_id,
        job.id,
        job.conversation_id,
        "whatsapp",
        "delivery_updated",
        "outbound",
        job.responder_type,
        "text",
        "failed",
        null,
        new Date(),
      );
      return { job, error: message };
    }
  });
  if (!result) return false;
  const { job, error } = result;
  if (error === null) {
    options.logger?.info({
      event: "queue.item.completed",
      worker: "whatsapp_inbox",
      message_id: job.id,
      conversation_id: job.conversation_id,
    });
    await options.events.publishMessageUpdated(
      pool,
      job.user_id,
      job.conversation_id,
      job.id,
      "SENT",
      null,
      null,
    );
    await options.events.publishConversationUpdated(
      pool,
      job.user_id,
      job.conversation_id,
    );
  } else {
    options.logger?.error({
      event: "queue.item.failed",
      worker: "whatsapp_inbox",
      message_id: job.id,
      conversation_id: job.conversation_id,
    });
    await options.events.publishMessageUpdated(
      pool,
      job.user_id,
      job.conversation_id,
      job.id,
      "FAILED",
      "SEND_FAILED",
      error,
    );
    await options.events.publishMessageSendFailed(
      pool,
      job.user_id,
      job.conversation_id,
      error,
      job.content,
    );
  }
  return true;
}
export async function processQueuedInboxMessages(
  context: CoreContext,
  limit: number,
  options: InboxDeliveryOptions,
): Promise<number> {
  if (limit <= 0) return 0;
  let processed = 0;
  const seen = new Set<string>();
  for (const id of await drainWhatsappInboxQueue(context, limit)) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (await processSingleQueuedInboxMessage(context.pool, id, options)) {
      if (++processed >= limit) return processed;
    }
  }
  while (
    processed < limit &&
    (await processSingleQueuedInboxMessage(context.pool, null, options))
  )
    processed++;
  return processed;
}
