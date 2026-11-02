import type { Pool } from "pg";
import { ApiError } from "../../error.js";
import * as sql from "./conversations-sql.js";
import { rowView } from "./rows.js";
import { supportAllows, auditSupportRead } from "./support-access.js";
import { bad, missing, transaction, type ObjectValue } from "./common.js";
const denied = (message: string): never => {
  throw new ApiError(403, "forbidden", message);
};
export async function listConversations(
  pool: Pool,
  adminId: string,
  query: ObjectValue,
) {
  return transaction(pool, async (tx) => {
    const org =
      typeof query.organizationId === "string"
        ? query.organizationId.trim()
        : "";
    if (!org) bad("organizationId is required for support access");
    if (!(await supportAllows(tx, adminId, org, "organization", null)))
      denied("An active organization-scoped support grant is required");
    await auditSupportRead(tx, adminId, org, "organization", null);
    return (await tx.query(sql.LIST_CONVERSATIONS_0, [org])).rows
      .filter(
        (row) =>
          (query.channel == null || row.channel === query.channel) &&
          (query.search == null ||
            String(row.customerIdentifier)
              .toLowerCase()
              .includes(String(query.search).toLowerCase()) ||
            String(row.customerName ?? "")
              .toLowerCase()
              .includes(String(query.search).toLowerCase())),
      )
      .map((row) => rowView("conversations.ConversationRow", row));
  });
}
export async function getConversation(pool: Pool, adminId: string, id: string) {
  return transaction(pool, async (tx) => {
    const row =
      (await tx.query(sql.GET_CONVERSATION_0, [id])).rows[0] ??
      missing("conversation not found");
    if (row.orgId == null) denied("Conversation has no organization scope");
    const allowed =
      (await supportAllows(tx, adminId, row.orgId, "conversation", id)) ||
      (row.customerId != null &&
        (await supportAllows(
          tx,
          adminId,
          row.orgId,
          "customer",
          row.customerId,
        )));
    if (!allowed)
      denied("An active support grant is required for this conversation");
    if (await supportAllows(tx, adminId, row.orgId, "conversation", id))
      await auditSupportRead(tx, adminId, row.orgId, "conversation", id);
    else
      await auditSupportRead(
        tx,
        adminId,
        row.orgId,
        "customer",
        row.customerId,
      );
    const messages = (await tx.query(sql.GET_CONVERSATION_1, [id])).rows;
    return {
      conversation: rowView("conversations.ConversationRow", row),
      messages: messages.map((row) => rowView("conversations.MessageRow", row)),
    };
  });
}
