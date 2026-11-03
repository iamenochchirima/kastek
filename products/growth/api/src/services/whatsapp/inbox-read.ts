import type { Pool } from "pg";
import {
  missing,
  bad,
  getConnectionRowForOrg,
  type ProviderOptions,
} from "./common.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import type { ConversationRow, AttachmentDownload } from "../inbox/types.js";
import {
  channelCapabilities,
  listTimelineMessages,
} from "../inbox/message-domain.js";
import { downloadMediaBytes } from "./inbox-provider.js";
import * as sql from "./inbox-sql.js";

export async function scopedWhatsappConversation(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<ConversationRow | null> {
  return (
    (await pool.query<ConversationRow>(sql.SCOPED_CONVERSATION_0, [id, orgId]))
      .rows[0] ?? null
  );
}
export function parseConversationIdentifier(
  identifier: string,
): { connectionId: string; phone: string } | null {
  const parts = identifier.split(":");
  return parts[0] === "wa" && parts.length >= 3
    ? { connectionId: parts[1]!, phone: parts.slice(2).join(":") }
    : null;
}
export function sanitizeFilename(input: string): string {
  return [...input]
    .map((character) => (/^[A-Za-z0-9._-]$/.test(character) ? character : "_"))
    .join("");
}
export function previewText(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content);
  if (bytes.length <= maxBytes) return content;
  // The Rust byte slice panics inside a multibyte character. Keep its byte limit
  // while ending at a UTF-8 boundary so customer names/messages cannot crash reads.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "...";
}
export async function listInboxConversations(
  pool: Pool,
  orgId: string,
  capture?:(source:import("../inbox/types.js").InboxReadSource)=>void,
): Promise<Record<string, unknown>> {
  const query=capture?sql.LIST_INBOX_CONVERSATIONS_0.replace("last_message.content AS last_message_content", "last_message.content AS last_message_content, last_message.id AS access_message_id")
    .replace("SELECT m.content", "SELECT m.id, m.content"):sql.LIST_INBOX_CONVERSATIONS_0;
  const conversations = (
    await pool.query(query, [orgId])
  ).rows;
  if(capture)for(const row of conversations)capture({conversationId:row.id,messageId:row.access_message_id??null,connectionId:row.connection_id??null,connectionKind:"whatsapp"});
  return {
    conversations: conversations.map((row) => ({
      id: row.id,
      channel: row.channel,
      customerName: row.customer_name,
      phone: row.phone ?? row.customer_identifier,
      status: row.status,
      lastMessageAt: row.last_message_at,
      unreadCount: row.unread_count,
      starred: row.starred,
      connectionId: row.connection_id,
      connectionLabel: row.connection_label,
      lastMessage:
        row.last_message_content === null
          ? "No messages yet"
          : previewText(row.last_message_content, 180),
    })),
  };
}
export async function inboxUnreadCount(
  pool: Pool,
  orgId: string,
): Promise<Record<string, unknown>> {
  const count =
    (await pool.query(sql.INBOX_UNREAD_COUNT_0, [orgId])).rows[0]?.coalesce ??
    "0";
  return { unreadCount: BigInt(count) };
}
export async function listConversationMessages(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const conversation = await scopedWhatsappConversation(pool, orgId, id);
  if (!conversation) throw missing("Conversation not found");
  const messages = await listTimelineMessages(pool, conversation.id);
  for (const message of messages)
    message.canReact =
      typeof message.providerMessageId === "string" &&
      message.providerMessageId.length > 0 &&
      message.deletedAt === null;
  return { messages, capabilities: channelCapabilities("whatsapp") };
}
export async function downloadMessageAttachment(
  pool: Pool,
  orgId: string,
  messageId: string,
  attachmentId: string,
  options: ProviderOptions,
): Promise<AttachmentDownload> {
  const connectionIds = (
    await pool.query<{ id: string }>(sql.ORG_CONNECTION_IDS_0, [orgId])
  ).rows.map((row) => row.id);
  if (!connectionIds.length) throw missing("Media message not found");
  const attachment = (
    await pool.query(sql.DOWNLOAD_MESSAGE_ATTACHMENT_0, [
      messageId,
      attachmentId,
      connectionIds,
      orgId,
    ])
  ).rows[0];
  if (!attachment) throw missing("Media message not found");
  if (attachment.providerMediaId === null)
    throw bad("Message attachment is not available from WhatsApp");
  const identifier = (
    await pool.query(sql.DOWNLOAD_MESSAGE_ATTACHMENT_1, [
      attachment.conversationId,
    ])
  ).rows[0]?.customerIdentifier;
  const parsed =
    typeof identifier === "string"
      ? parseConversationIdentifier(identifier)
      : null;
  if (!parsed) throw bad("Invalid conversation");
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    parsed.connectionId,
  );
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(
    options.config,
    connection.access_token_encrypted,
  );
  const result = await downloadMediaBytes(
    token,
    attachment.providerMediaId,
    null,
    options,
  );
  const extension = attachment.mimeType?.split("/")[1] ?? "bin";
  return {
    ...result,
    fileName: sanitizeFilename(
      attachment.fileName ?? `whatsapp-media-${messageId}.${extension}`,
    ),
    cacheControl: "private, max-age=60",
  };
}
