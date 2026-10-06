export const LIST_NOTIFICATIONS_0 = `SELECT
            n.id, n."eventId", n."recipientType", n."recipientId",
            n.channel, n.status,
            n."readAt" AT TIME ZONE 'UTC' AS "readAt",
            n."sentAt" AT TIME ZONE 'UTC' AS "sentAt",
            n."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            e.title, e.message, e."eventType", e.severity,
            e."entityType", e."entityId", e.payload
        FROM "Notification" n
        JOIN "NotificationEvent" e ON e.id = n."eventId"
        {where_clause}
        ORDER BY n."createdAt" DESC
        LIMIT {limit}`;

export const UNREAD_COUNT_0 = `SELECT COUNT(*)
        FROM "Notification"
        WHERE "recipientType" = 'ADMIN'
          AND "recipientId" = $1
          AND "readAt" IS NULL`;

export const MARK_NOTIFICATION_READ_0 = `WITH updated AS (
            UPDATE "Notification"
            SET "readAt" = NOW(), "updatedAt" = NOW()
            WHERE id = $1
              AND "recipientType" = 'ADMIN'
              AND "recipientId" = $2
              AND "readAt" IS NULL
            RETURNING id
        )
        SELECT COUNT(*) FROM updated`;

export const MARK_ALL_READ_0 = `WITH updated AS (
            UPDATE "Notification"
            SET "readAt" = NOW(), "updatedAt" = NOW()
            WHERE "recipientType" = 'ADMIN'
              AND "recipientId" = $1
              AND "readAt" IS NULL
            RETURNING id
        )
        SELECT COUNT(*) FROM updated`;
