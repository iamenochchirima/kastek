import type { CoreContext } from "../../context.js";
import type { WhatsappInboxPorts } from "../inbox/types.js";
import { createInboxDeliveryOptions } from "./inbox-queue.js";
import * as reads from "./inbox-read.js";
import * as mutations from "./inbox-mutations.js";

/** Bind the provider-neutral inbox to the actual WhatsApp transport and data. */
export function createWhatsappInboxPorts(
  context: CoreContext,
): WhatsappInboxPorts {
  const options = createInboxDeliveryOptions(context);
  return {
    listInboxConversations: reads.listInboxConversations,
    listConversationMessages: reads.listConversationMessages,
    sendConversationMessage: (pool, userId, orgId, id, input) =>
      mutations.sendConversationMessage(
        { ...context, pool },
        userId,
        orgId,
        id,
        input,
        options,
      ),
    markConversationRead: (pool, userId, orgId, id) =>
      mutations.markConversationRead(
        { ...context, pool },
        userId,
        orgId,
        id,
        options,
      ),
    downloadMessageAttachment: (pool, orgId, messageId, attachmentId) =>
      reads.downloadMessageAttachment(
        pool,
        orgId,
        messageId,
        attachmentId,
        options,
      ),
  };
}
export * from "./inbox-read.js";
export * from "./inbox-mutations.js";
export * from "./inbox-queue.js";
export * from "./inbox-media.js";
export * from "./inbox-messages.js";
export * from "./inbox-start.js";
