import { createId } from "@paralleldrive/cuid2";
import type { CoreContext } from "../../context.js";
import { transaction } from "../../db.js";
import { apiJson } from "../../json.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { enqueueMessageLifecycle } from "../../analytics/inbox.js";
import {
  bad,
  missing,
  normalizePhone,
  getConnectionRowForOrg,
} from "./common.js";
import { sendMarketingTemplate } from "./campaigns.js";
import { findOrCreateConversation } from "./webhook-common.js";
import {
  createInboxDeliveryOptions,
  type InboxDeliveryOptions,
} from "./inbox-queue.js";
import type { WhatsappTemplateRow } from "./types.js";
import * as sql from "./inbox-start-sql.js";

export interface StartConversationInput {
  connectionId?: string | null;
  templateId?: string | null;
  phone?: string | null;
  customerName?: string | null;
  bodyParameters?: string[] | null;
}
export async function startInboxConversation(
  context: CoreContext,
  userId: string,
  orgId: string,
  input: StartConversationInput,
  options: InboxDeliveryOptions = createInboxDeliveryOptions(context),
): Promise<Record<string, unknown>> {
  const { pool, config } = context,
    connectionId = input.connectionId ?? "",
    templateId = input.templateId ?? "",
    phone = normalizePhone(input.phone ?? "", config);
  if (!connectionId || !templateId || !phone)
    throw bad("Connection, template, and recipient phone are required");
  const connection = await getConnectionRowForOrg(pool, orgId, connectionId);
  if (!connection) throw missing("WhatsApp connection not found");
  const template = (
    await pool.query<WhatsappTemplateRow>(sql.START_CONVERSATION_0, [
      templateId,
      orgId,
    ])
  ).rows[0];
  if (!template) throw missing("Approved template not found");
  if (
    template.connection_id !== null &&
    template.connection_id !== connection.id
  )
    throw bad("Selected template does not belong to this WhatsApp connection");
  const parameters = input.bodyParameters ?? [];
  if (parameters.length !== template.variables_count)
    throw bad(
      `This template expects ${template.variables_count} variable${template.variables_count === 1 ? "" : "s"}.`,
    );
  const token = decryptSocialSecret(config, connection.access_token_encrypted);
  const [providerId] = await sendMarketingTemplate(
    connection.phone_number_id,
    token,
    phone,
    template.template_name,
    template.language,
    parameters,
    options,
  );
  const [conversationId, , , customerId] = await findOrCreateConversation(
    pool,
    orgId,
    connection.id,
    phone,
    input.customerName ?? null,
  );
  let contactId = (await pool.query(sql.START_CONVERSATION_1, [orgId, phone]))
    .rows[0]?.id as string | undefined;
  if (!contactId) {
    contactId = createId();
    await pool.query(sql.START_CONVERSATION_2, [
      contactId,
      userId,
      orgId,
      phone,
      input.customerName ?? null,
    ]);
  }
  await pool.query(sql.START_CONVERSATION_3, [customerId, contactId, orgId]);
  const storedId = createId(),
    now = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.START_CONVERSATION_4, [
      storedId,
      conversationId,
      template.body ?? "Template message sent.",
      providerId,
      apiJson({ _kasitek_inbox_message_kind: "template" }),
      now,
    ]);
    await tx.query(sql.START_CONVERSATION_5, [
      now,
      input.customerName ?? null,
      conversationId,
    ]);
    await enqueueMessageLifecycle(
      tx,
      orgId,
      storedId,
      conversationId,
      "whatsapp",
      "created",
      "outbound",
      "system",
      "template",
      "sent",
      null,
      now,
    );
  });
  // Realtime looks up a local Message ID. The Rust source passed the provider
  // ID here and consequently never published the newly stored template.
  await options.events.publishMessageCreated(pool, userId, storedId);
  await options.events.publishConversationUpdated(pool, userId, conversationId);
  return {
    success: true,
    conversationId,
    messageId: providerId,
    category: template.category,
    contactId,
  };
}
