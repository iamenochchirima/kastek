import type { Pool } from 'pg';
import { ApiError } from '../../error.js';
import * as sql from './conversations-sql.js';
import { rowView } from './rows.js';
import { supportAllows } from './support-access.js';
import { bad, missing, type ObjectValue } from './common.js';
const denied = (message: string): never => {
  throw new ApiError(403, 'forbidden', message);
};
export async function listConversations(
  pool: Pool,
  adminId: string,
  query: ObjectValue,
) {
  const org =
    typeof query.organizationId === 'string' ? query.organizationId.trim() : '';
  if (!org) bad('organizationId is required for support access');
  if (!(await supportAllows(pool, adminId, org, 'organization', null)))
    denied('An active organization-scoped support grant is required');
  return (await pool.query(sql.LIST_CONVERSATIONS_0, [org])).rows
    .filter(
      (row) =>
        (query.channel == null || row.channel === query.channel) &&
        (query.search == null ||
          String(row.customerIdentifier)
            .toLowerCase()
            .includes(String(query.search).toLowerCase()) ||
          String(row.customerName ?? '')
            .toLowerCase()
            .includes(String(query.search).toLowerCase())),
    )
    .map((row) => rowView('conversations.ConversationRow', row));
}
export async function getConversation(pool: Pool, adminId: string, id: string) {
  const row =
    (await pool.query(sql.GET_CONVERSATION_0, [id])).rows[0] ??
    missing('conversation not found');
  if (row.orgId == null) denied('Conversation has no organization scope');
  const allowed =
    (await supportAllows(pool, adminId, row.orgId, 'conversation', id)) ||
    (row.customerId != null &&
      (await supportAllows(
        pool,
        adminId,
        row.orgId,
        'customer',
        row.customerId,
      )));
  if (!allowed)
    denied('An active support grant is required for this conversation');
  const messages = (await pool.query(sql.GET_CONVERSATION_1, [id])).rows;
  return {
    conversation: rowView('conversations.ConversationRow', row),
    messages: messages.map((row) => rowView('conversations.MessageRow', row)),
  };
}
