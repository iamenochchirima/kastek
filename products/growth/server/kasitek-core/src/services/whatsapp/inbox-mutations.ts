import { createId } from "@paralleldrive/cuid2";
import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import {
  enqueueMessageLifecycle,
  enqueueConversationLifecycle,
  precedingCustomerResponseTimeMs,
} from "../../analytics/inbox.js";
import { enqueueWhatsappInboxMessage } from "../realtime.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import type { SendMessageInput } from "../inbox/types.js";
import { bad, missing, getConnectionRowForOrg } from "./common.js";
import {
  scopedWhatsappConversation,
  parseConversationIdentifier,
  previewText,
} from "./inbox-read.js";
import { markMessageReadApi } from "./inbox-provider.js";
import type { InboxDeliveryOptions } from "./inbox-queue.js";
import * as sql from "./inbox-delivery-sql.js";
import { CREATE_REFERENCE_0 } from "../inbox/message_domain-sql.js";

export async function updateConversation(
  context: CoreContext,
  userId: string,
  orgId: string,
  id: string,
  input: { starred?: boolean | null },
  options: InboxDeliveryOptions,
): Promise<Record<string, unknown>> {
  if (!(await scopedWhatsappConversation(context.pool, orgId, id)))
    throw missing("Conversation not found");
  if (input.starred !== undefined && input.starred !== null)
    await context.pool.query(
      'UPDATE "Conversation" SET starred=$1,"updatedAt"=NOW() WHERE id=$2',
      [input.starred, id],
    );
  await options.events.publishConversationUpdated(context.pool, userId, id);
  const refreshed = await scopedWhatsappConversation(context.pool, orgId, id);
  if (!refreshed) throw missing("Conversation not found");
  return { success: true, conversationId: id, starred: refreshed.starred };
}
export async function deleteConversation(
  context: CoreContext,
  orgId: string,
  id: string,
): Promise<Record<string, unknown>> {
  if (!(await scopedWhatsappConversation(context.pool, orgId, id)))
    throw missing("Conversation not found");
  await transaction(context.pool, async (tx) => {
    await tx.query('DELETE FROM "Message" WHERE "conversationId"=$1', [id]);
    const deleted = await tx.query(
      'DELETE FROM "Conversation" WHERE id=$1 AND "orgId"=$2',
      [id, orgId],
    );
    if (!deleted.rowCount) throw missing("Conversation not found");
    await enqueueConversationLifecycle(
      tx,
      orgId,
      id,
      "whatsapp",
      "deleted",
      "deleted",
      "human",
      new Date(),
    );
  });
  return { success: true, conversationId: id, deleted: true };
}

export async function sendConversationMessage(
  context: CoreContext,
  userId: string,
  orgId: string,
  id: string,
  input: SendMessageInput,
  options: InboxDeliveryOptions,
): Promise<Record<string, unknown>> {
  const { pool } = context;
  const conversation = await scopedWhatsappConversation(pool, orgId, id);
  if (!conversation) throw missing("Conversation not found");
  const text = input.text?.trim();
  if (!text) throw bad("Reply text or media file is required");
  if (!parseConversationIdentifier(conversation.customer_identifier))
    throw bad("Invalid conversation");
  const replyId = input.replyToMessageId?.trim();
  const target = replyId
    ? (await pool.query(sql.SEND_CONVERSATION_MESSAGE_0, [replyId, id])).rows[0]
    : null;
  if (replyId && !target) throw missing("Reply target not found");
  if (target && target.whatsapp_message_id === null)
    throw bad(
      "This message cannot be replied to yet. Try again in a few seconds.",
    );
  const messageId = createId(),
    occurredAt = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.SEND_CONVERSATION_MESSAGE_1, [messageId, id, text]);
    await tx.query(sql.SEND_CONVERSATION_MESSAGE_2, [occurredAt, id]);
    const responseTime = await precedingCustomerResponseTimeMs(
      tx,
      id,
      occurredAt,
    );
    await enqueueMessageLifecycle(
      tx,
      orgId,
      messageId,
      id,
      "whatsapp",
      "created",
      "outbound",
      "human",
      "text",
      "queued",
      responseTime,
      occurredAt,
    );
    // Publish reply context atomically with the queued message. The original
    // post-commit reference insert allowed the poller to send without its reply.
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
  options.logger?.info({
    event: "queue.item.claimed",
    worker: "whatsapp_inbox",
    operation: "message.queue",
    message_id: messageId,
    conversation_id: id,
    user_id: userId,
    has_reply: !!replyId,
  });
  await options.events.publishMessageCreated(pool, userId, messageId);
  await options.events.publishConversationUpdated(pool, userId, id);
  try {
    await enqueueWhatsappInboxMessage(context, messageId);
  } catch (error) {
    options.logger?.warn({
      event: "operation.failed",
      operation: "whatsapp_inbox.enqueue",
      message_id: messageId,
      error_type: error instanceof Error ? error.name : "unknown",
    });
  }
  return { success: true, queued: true, messageId };
}
export async function markConversationRead(
  context: CoreContext,
  userId: string,
  orgId: string,
  id: string,
  options: InboxDeliveryOptions,
): Promise<Record<string, unknown>> {
  const { pool } = context;
  const conversation = await scopedWhatsappConversation(pool, orgId, id);
  if (!conversation) throw missing("Conversation not found");
  await pool.query(sql.MARK_CONVERSATION_READ_0, [id]);
  const parsed = parseConversationIdentifier(conversation.customer_identifier);
  if (!parsed) throw bad("Invalid conversation");
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    parsed.connectionId,
  );
  const unread = (await pool.query(sql.MARK_CONVERSATION_READ_1, [id])).rows;
  if (connection) {
    let token: string | null = null;
    try {
      token = decryptSocialSecret(
        options.config,
        connection.access_token_encrypted,
      );
    } catch (error) {
      options.logger?.warn({
        event: "operation.failed",
        operation: "whatsapp.read_receipt.decrypt_token",
        conversation_id: id,
        error_type: error instanceof Error ? error.name : "unknown",
      });
    }
    if (token !== null)
      for (const message of unread) {
        try {
          await markMessageReadApi(
            connection.phone_number_id,
            token,
            message.whatsapp_message_id,
            options,
          );
        } catch {
          // Provider receipt failure does not prevent the local user marking read.
        }
      }
  }
  if (unread.length)
    await pool.query(sql.MARK_CONVERSATION_READ_2, [
      unread.map((message) => message.id),
    ]);
  await options.events.publishConversationUpdated(pool, userId, id);
  return { success: true };
}
