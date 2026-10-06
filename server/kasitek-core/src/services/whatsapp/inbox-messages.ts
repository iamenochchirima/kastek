import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import { recordEvent, upsertReaction } from "../inbox/message-domain.js";
import { bad, missing, getConnectionRowForOrg } from "./common.js";
import {
  scopedWhatsappConversation,
  parseConversationIdentifier,
} from "./inbox-read.js";
import { whatsappDeletedMessageResponderType } from "./inbox-formatting.js";
import { sendReactionMessage } from "./inbox-provider.js";
import {
  createInboxDeliveryOptions,
  type InboxDeliveryOptions,
} from "./inbox-queue.js";
import * as sql from "./inbox-message-sql.js";

export async function sendMessageReaction(
  context: CoreContext,
  orgId: string,
  id: string,
  messageId: string,
  input: { emoji?: string | null; remove?: boolean | null },
  options: InboxDeliveryOptions = createInboxDeliveryOptions(context),
): Promise<Record<string, unknown>> {
  const { pool, config } = context;
  const conversation = await scopedWhatsappConversation(pool, orgId, id);
  if (!conversation) throw missing("Conversation not found");
  const remove = input.remove ?? false,
    emoji = input.emoji?.trim() ?? "";
  if (!remove && !emoji) throw bad("Emoji is required");
  const message = (
    await pool.query(sql.SEND_MESSAGE_REACTION_0, [messageId, id])
  ).rows[0];
  if (!message) throw missing("Target message not found");
  if (message.whatsapp_message_id === null)
    throw bad("Target message is not available for reactions yet");
  const parsed = parseConversationIdentifier(conversation.customer_identifier);
  if (!parsed) throw bad("Invalid conversation identifier");
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    parsed.connectionId,
  );
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(config, connection.access_token_encrypted);
  await sendReactionMessage(
    connection.phone_number_id,
    token,
    parsed.phone,
    message.whatsapp_message_id,
    remove ? "" : emoji,
    options,
  );
  await upsertReaction(
    pool,
    messageId,
    `workspace:${connection.id}`,
    remove ? null : emoji,
    !remove,
    null,
    {
      provider: "whatsapp",
      targetProviderMessageId: message.whatsapp_message_id,
      source: "workspace",
    },
  );
  await recordEvent(
    pool,
    id,
    messageId,
    null,
    remove ? "REACTION_REMOVED" : "REACTION_ADDED",
    { provider: "whatsapp", emoji: remove ? "" : emoji },
  );
  return { success: true };
}
export async function deleteConversationMessage(
  context: CoreContext,
  orgId: string,
  id: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  const { pool } = context;
  if (!(await scopedWhatsappConversation(pool, orgId, id)))
    throw missing("Conversation not found");
  await transaction(pool, async (tx) => {
    const message = (
      await tx.query(sql.DELETE_CONVERSATION_MESSAGE_0, [messageId, id])
    ).rows[0];
    if (!message) throw missing("Message not found");
    const deleted = await tx.query(sql.DELETE_CONVERSATION_MESSAGE_1, [
      messageId,
      id,
    ]);
    if (!deleted.rowCount) throw missing("Message not found");
    const last = (await tx.query(sql.DELETE_CONVERSATION_MESSAGE_2, [id]))
      .rows[0];
    if (last)
      await tx.query(sql.DELETE_CONVERSATION_MESSAGE_3, [
        last.timezone instanceof Date
          ? last.timezone.toISOString()
          : last.timezone,
        id,
      ]);
    const responder = whatsappDeletedMessageResponderType(
      message.sender,
      message.providerMetadata,
    );
    const type = String(message.contentType ?? "TEXT").replace(/[A-Z]/g, (ch) =>
      ch.toLowerCase(),
    );
    await enqueueMessageLifecycle(
      tx,
      orgId,
      messageId,
      id,
      "whatsapp",
      "deleted",
      message.sender === "customer" ? "inbound" : "outbound",
      responder,
      type,
      null,
      null,
      new Date(),
    );
  });
  return { success: true };
}
