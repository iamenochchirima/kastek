import type { Pool } from 'pg';
import * as sql from './notifications-sql.js';
import { rowView } from './rows.js';
import { missing, type ObjectValue } from './common.js';
export async function listNotifications(
  pool: Pool,
  adminId: string,
  query: ObjectValue,
) {
  const args: unknown[] = [adminId],
    conditions = [`n."recipientType" = 'ADMIN'`, `n."recipientId" = $1`];
  if (query.unreadOnly === true || query.unreadOnly === 'true')
    conditions.push('n."readAt" IS NULL');
  if (typeof query.channel === 'string' && query.channel) {
    args.push(query.channel);
    conditions.push(`n.channel = $${args.length}`);
  }
  args.push(Math.max(1, Math.min(100, Number(query.limit ?? 20))));
  const text = sql.LIST_NOTIFICATIONS_0.replace(
    '{where_clause}',
    `WHERE ${conditions.join(' AND ')}`,
  ).replace('{limit}', `$${args.length}`);
  return {
    notifications: (await pool.query(text, args)).rows.map((row) =>
      rowView('notifications.NotificationRow', row),
    ),
  };
}
export async function unreadNotifications(pool: Pool, adminId: string) {
  return {
    unreadCount: BigInt(
      (await pool.query(sql.UNREAD_COUNT_0, [adminId])).rows[0]!.count,
    ),
  };
}
export async function readNotification(
  pool: Pool,
  adminId: string,
  id: string,
) {
  const updated = BigInt(
    (await pool.query(sql.MARK_NOTIFICATION_READ_0, [id, adminId])).rows[0]!
      .count,
  );
  if (updated === 0n) missing('notification not found');
  return { updated };
}
export async function readAllNotifications(pool: Pool, adminId: string) {
  return {
    updated: BigInt(
      (await pool.query(sql.MARK_ALL_READ_0, [adminId])).rows[0]!.count,
    ),
  };
}
