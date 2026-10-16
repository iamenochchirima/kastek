import { createId } from '@paralleldrive/cuid2';
import type { Pool } from 'pg';

/** Website and early-access lifecycle notifications retain the original ADMIN recipient boundary. */
export async function publishAdminNotification(pool: Pool, eventType: string, title: string, message: string,
  entityType: string, entityId: string, payload: unknown, dedupeKey: string): Promise<void> {
  const admins = (await pool.query<{ id: string }>('SELECT id FROM "AdminUser"')).rows;
  if (!admins.length) return;
  const existing = await pool.query(`SELECT id FROM "NotificationEvent"
    WHERE "scopeType"='ADMIN'::"NotificationScopeType" AND "scopeId"='global' AND "dedupeKey"=$1 LIMIT 1`, [dedupeKey]);
  if (existing.rows.length) return;
  const eventId = createId();
  await pool.query(`INSERT INTO "NotificationEvent"(id,"scopeType","scopeId","eventType",title,message,severity,
    "entityType","entityId",payload,"dedupeKey","createdAt")
    VALUES($1,'ADMIN'::"NotificationScopeType",'global',$2,$3,$4,'SUCCESS'::"NotificationSeverity",$5,$6,$7,$8,NOW())`,
  [eventId, eventType, title, message, entityType, entityId, payload, dedupeKey]);
  for (const admin of admins) {
    await pool.query(`INSERT INTO "Notification"(id,"eventId","recipientType","recipientId",channel,status,"sentAt","createdAt","updatedAt")
      VALUES($1,$2,'ADMIN'::"NotificationRecipientType",$3,'IN_APP'::"NotificationChannel",'SENT'::"NotificationStatus",NOW(),NOW(),NOW())`,
    [createId(), eventId, admin.id]);
  }
}
