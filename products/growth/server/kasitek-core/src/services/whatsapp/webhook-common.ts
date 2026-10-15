import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import { transaction } from "../../db.js";
import { ApiError } from "../../error.js";
import { ensureWhatsappCustomer } from "../customers.js";
import { enqueueConversationLifecycle } from "../../analytics/inbox.js";
import { listTimelineMessages } from "../inbox/message-domain.js";
import { parseConversationIdentifier } from "./inbox-read.js";
import { WEBHOOK_COMMON_SQL as sql } from "./webhook-common-sql.js";
import type { Row } from "./types.js";
export interface WebhookRealtimeOptions {
  publishEvent: (orgId: string, event: unknown) => Promise<void>;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}
export async function findOrCreateConversation(
  pool: Pool,
  org: string,
  connection: string,
  phone: string,
  customerName: string | null,
): Promise<[string, number, Date, string]> {
  const identifier = `wa:${connection}:${phone}`,
    customer = await ensureWhatsappCustomer(
      pool,
      org,
      phone,
      customerName,
      null,
    );
  return transaction(pool, async (tx) => {
    const prior = (
      await tx.query({
        text: sql.find_or_create_conversation[0],
        values: [org, identifier],
        rowMode: "array",
      })
    ).rows[0];
    if (prior) {
      await tx.query(sql.find_or_create_conversation[1], [
        customerName,
        org,
        prior[0],
        connection,
        customer,
      ]);
      return [prior[0], prior[1], prior[2], customer];
    }
    const id = createId(),
      now = new Date();
    await tx.query(sql.find_or_create_conversation[2], [
      id,
      org,
      identifier,
      customerName,
      now,
      connection,
      customer,
    ]);
    await enqueueConversationLifecycle(
      tx,
      org,
      id,
      "whatsapp",
      "opened",
      "active",
      "customer",
      now,
    );
    return [id, 0, now, customer];
  });
}
export async function loadConversationById(
  pool: Pool,
  id: string,
): Promise<Row | null> {
  return (
    (await pool.query(sql.load_conversation_by_id[0], [id])).rows[0] ?? null
  );
}
export async function loadMessageById(
  pool: Pool,
  id: string,
): Promise<Row | null> {
  return (await pool.query(sql.load_message_by_id[0], [id])).rows[0] ?? null;
}
async function orgId(pool: Pool, id: string): Promise<string | null> {
  return (
    (await pool.query(sql.conversation_org_id[0], [id])).rows[0]?.orgId ?? null
  );
}
async function publish(
  options: WebhookRealtimeOptions,
  org: string,
  event: unknown,
): Promise<void> {
  await options.publishEvent(org, event).catch(() => {
    options.logger?.warn(
      { event: "operation.failed", operation: "whatsapp.realtime_publish" },
      "WhatsApp realtime event publish failed",
    );
  });
}
async function projection(pool: Pool, conversation: Row): Promise<Row> {
  const parsed = parseConversationIdentifier(conversation.customer_identifier),
    connection = parsed?.connectionId ?? "",
    phone = parsed?.phone ?? conversation.customer_identifier,
    label = connection
      ? ((await pool.query(sql.publish_conversation_updated[0], [connection]))
          .rows[0]?.coalesce ?? null)
      : null;
  return {
    customerName: conversation.customer_name,
    phone,
    connectionId: connection || null,
    connectionLabel: label,
    lastMessageAt: conversation.last_message_at,
    unreadCount: conversation.unread_count,
  };
}
export async function publishConversationUpdated(
  pool: Pool,
  _user: string,
  id: string,
  options: WebhookRealtimeOptions,
): Promise<void> {
  const conversation = await loadConversationById(pool, id);
  if (!conversation) return;
  const org = await orgId(pool, id);
  if (!org) return;
  await publish(options, org, {
    type: "conversation.updated",
    conversationId: id,
    conversation: {
      id,
      ...(await projection(pool, conversation)),
      starred: conversation.starred,
    },
  });
}
export async function publishMessageCreated(
  pool: Pool,
  _user: string,
  id: string,
  options: WebhookRealtimeOptions,
): Promise<void> {
  const message = await loadMessageById(pool, id);
  if (!message) return;
  const conversation = await loadConversationById(
    pool,
    message.conversation_id,
  );
  if (!conversation)
    throw new ApiError(404, "not_found", "Conversation not found");
  const org = await orgId(pool, conversation.id);
  if (!org) return;
  const structured = (await listTimelineMessages(pool, conversation.id)).find(
    (row) => row.id === id,
  );
  if (!structured) return;
  structured.canReact =
    typeof structured.providerMessageId === "string" &&
    !!structured.providerMessageId &&
    structured.deletedAt === null;
  await publish(options, org, {
    type: "message.created",
    conversationId: conversation.id,
    conversation: await projection(pool, conversation),
    message: structured,
  });
}
export async function publishMessageUpdated(
  pool: Pool,
  _user: string,
  conversation: string,
  id: string,
  status: string,
  errorCode: string | null,
  errorMessage: string | null,
  options: WebhookRealtimeOptions,
): Promise<void> {
  const org = await orgId(pool, conversation).catch(() => null);
  if (!org) return;
  await publish(options, org, {
    type: "message.updated",
    conversationId: conversation,
    message: { id, whatsappStatus: status, errorCode, errorMessage },
  });
}
export async function publishMessageSendFailed(
  pool: Pool,
  _user: string,
  conversation: string,
  error: string,
  text: string | null,
  options: WebhookRealtimeOptions,
): Promise<void> {
  const org = await orgId(pool, conversation).catch(() => null);
  if (!org) return;
  await publish(options, org, {
    type: "message.send_failed",
    conversationId: conversation,
    error,
    text,
  });
}
