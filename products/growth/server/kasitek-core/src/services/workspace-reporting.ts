import type { Pool } from 'pg';
import * as sql from './workspace-reporting-sql.js';

interface StatusRow { status: string; count: string | bigint | number }
const count = (value: string | bigint | number): bigint => BigInt(value);
const buckets = (rows: StatusRow[]) => rows.map((row) => ({ status: row.status, count: count(row.count) }));
const total = (rows: StatusRow[]) => rows.reduce((sum, row) => sum + count(row.count), 0n);

/** Aggregate report for the private Agents boundary. Never calls Agents or reads user-specific data. */
export async function agentWorkspaceReport(pool: Pool, organizationId: string) {
  const scalar = async (query: string): Promise<bigint> => {
    const result = await pool.query<{ count: string | bigint | number }>(query, [organizationId]);
    // COUNT always returns one row. Missing rows indicate a database contract failure.
    if (!result.rows[0]) throw new Error('Workspace count query returned no row');
    return count(result.rows[0].count);
  };
  const statuses = async (query: string) => (await pool.query<StatusRow>(query, [organizationId])).rows;
  const [connections, postCount, contactCount, optedIn, excluded, conversationCount,
    unreadConversationCount, bookings, campaigns, templates] = await Promise.all([
    statuses(sql.CONNECTION_STATUS_SQL), scalar(sql.CONTENT_POST_COUNT_SQL),
    scalar(sql.CONTACT_COUNT_SQL), scalar(sql.OPTED_IN_CONTACT_COUNT_SQL),
    scalar(sql.EXCLUDED_CONTACT_COUNT_SQL), scalar(sql.CONVERSATION_COUNT_SQL),
    scalar(sql.UNREAD_CONVERSATION_COUNT_SQL), statuses(sql.BOOKING_STATUS_SQL),
    statuses(sql.CAMPAIGN_STATUS_SQL), statuses(sql.TEMPLATE_STATUS_SQL),
  ]);
  return {
    organizationId,
    connections: { total: total(connections), byStatus: buckets(connections) },
    content: { postCount },
    contacts: { total: contactCount, optedIn, excluded },
    inbox: { conversationCount, unreadConversationCount },
    bookings: { total: total(bookings), byStatus: buckets(bookings) },
    campaigns: { total: total(campaigns), byStatus: buckets(campaigns) },
    templates: { total: total(templates), byStatus: buckets(templates) },
  };
}
