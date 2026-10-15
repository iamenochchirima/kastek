import type { Pool } from 'pg';
import { apiJson } from '../../json.js';
import { createId } from '@paralleldrive/cuid2';
import * as sql from './message_domain-sql.js';
export function channelCapabilities(channel: string) {
  const whatsapp = channel === 'whatsapp',
    meta = channel === 'facebook' || channel === 'instagram',
    email = channel === 'email';
  return {
    version: 1,
    text: whatsapp || meta || email,
    reply: whatsapp || meta || email,
    reaction: whatsapp,
    attachments: {
      image: whatsapp,
      video: whatsapp,
      audio: whatsapp,
      document: whatsapp,
      sticker: whatsapp,
    },
    providerDelete: whatsapp,
    deliveryReceipts: whatsapp || meta,
    readReceipts: whatsapp || meta,
  };
}
export async function listTimelineMessages(
  pool: Pool,
  conversationId: string,
): Promise<Record<string, unknown>[]> {
  return (
    await pool.query(sql.LIST_TIMELINE_MESSAGES_0, [conversationId])
  ).rows.map((m) => {
    const providerMessageId = m.provider_message_id ?? m.whatsapp_message_id,
      status = m.provider_status ?? m.whatsapp_status;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      sender: m.sender,
      content: m.content,
      text: m.content,
      contentType: m.content_type,
      time: m.timestamp,
      timestamp: m.timestamp,
      status,
      providerMessageId,
      whatsappMessageId: m.whatsapp_message_id,
      errorCode: m.error_code,
      errorMessage: m.error_message,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      attachments: m.attachments,
      reference: m.reference,
      reactions: m.reactions,
      canReply: providerMessageId !== null && m.deleted_at === null,
      canReact: false,
    };
  });
}
export async function listActiveReactions(
  pool: Pool,
  messageId: string,
): Promise<unknown[]> {
  return (
    (await pool.query(sql.LIST_ACTIVE_REACTIONS_0, [messageId])).rows[0]
      ?.coalesce ?? []
  );
}
export async function createReference(
  pool: Pool,
  messageId: string,
  referencedMessageId: string,
  referencedProviderMessageId: string | null,
  previewText: string | null,
  previewKind: string | null,
) {
  await pool.query(sql.CREATE_REFERENCE_0, [
    createId(),
    messageId,
    referencedMessageId,
    referencedProviderMessageId,
    previewText,
    previewKind,
  ]);
}
export async function createAttachment(
  pool: Pool,
  messageId: string,
  providerMediaId: string | null,
  kind: string,
  mimeType: string | null,
  fileName: string | null,
  checksum: string | null,
  metadata: unknown,
) {
  await pool.query(sql.CREATE_ATTACHMENT_0, [
    createId(),
    messageId,
    providerMediaId,
    kind,
    mimeType,
    fileName,
    checksum,
    apiJson(metadata),
  ]);
}
export async function upsertReaction(
  pool: Pool,
  messageId: string,
  actorIdentifier: string,
  emoji: string | null,
  active: boolean,
  providerEventId: string | null,
  metadata: unknown,
) {
  await pool.query(sql.UPSERT_REACTION_0, [
    createId(),
    messageId,
    actorIdentifier,
    emoji,
    providerEventId,
    active,
    apiJson(metadata),
  ]);
}
export async function recordEvent(
  pool: Pool,
  conversationId: string,
  messageId: string | null,
  providerEventId: string | null,
  kind: string,
  metadata: unknown,
) {
  await pool.query(sql.RECORD_EVENT_0, [
    createId(),
    conversationId,
    messageId,
    providerEventId,
    kind,
    apiJson(metadata),
  ]);
}
