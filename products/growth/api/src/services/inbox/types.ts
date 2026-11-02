import type { Pool } from 'pg';
import type { CoreConfig } from '../../config.js';
export type ObjectValue = Record<string, unknown>;
export interface SendMessageInput {
  text?: string | null;
  replyToMessageId?: string | null;
  [key: string]: unknown;
}
export interface WhatsappInboxPorts {
  listInboxConversations(pool: Pool, orgId: string): Promise<ObjectValue>;
  listConversationMessages(
    pool: Pool,
    orgId: string,
    id: string,
  ): Promise<ObjectValue>;
  sendConversationMessage(
    pool: Pool,
    userId: string,
    orgId: string,
    id: string,
    input: SendMessageInput,
  ): Promise<ObjectValue>;
  markConversationRead(
    pool: Pool,
    userId: string,
    orgId: string,
    id: string,
  ): Promise<ObjectValue>;
  downloadMessageAttachment(
    pool: Pool,
    orgId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload>;
}
export interface AttachmentDownload {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  cacheControl: string;
  mediaSource?: string;
}
export interface InboxOptions {
  config: CoreConfig;
  fetch?: typeof fetch;
  whatsapp: WhatsappInboxPorts;
  publishEvent?: (orgId: string, event: unknown) => Promise<void>;
}
export interface ConversationRow {
  id: string;
  channel: string;
  customer_identifier: string;
  customer_name: string | null;
  status: string;
  last_message_at: Date;
  last_read_at: Date | null;
  starred: boolean;
  unread_count: number;
  created_at: Date;
  updated_at: Date;
}
export interface MetaScope {
  id: string;
  channel: string;
  customer_identifier: string;
  channel_connection_id: string;
  external_account_id: string | null;
  access_token: string | null;
  metadata: ObjectValue | null;
}
export interface MetaChannel {
  id: string;
  external_connection_id: string;
  user_id: string;
  org_id: string | null;
  platform: string;
  external_account_id: string | null;
  access_token: string | null;
  metadata: ObjectValue | null;
}
export const obj = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
export const arr = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** serde Value lookups distinguish a missing property from an explicit null. */
export const firstPresent = (...values: unknown[]): unknown =>
  values.find((value) => value !== undefined);
