use base64::{engine::general_purpose::STANDARD, Engine as _};
use sqlx::PgPool;

use crate::db::models::{NotificationInboxItem, NotificationInboxResponse, NotificationInboxRow};
use crate::error::AppError;

fn encode_cursor(created_at: chrono::DateTime<chrono::Utc>, event_id: &str) -> String {
    STANDARD.encode(format!("{}|{}", created_at.to_rfc3339(), event_id))
}

fn decode_cursor(cursor: Option<String>) -> Option<(chrono::DateTime<chrono::Utc>, String)> {
    let cursor = cursor?;
    let raw = STANDARD.decode(cursor).ok()?;
    let raw = String::from_utf8(raw).ok()?;
    let separator = raw.rfind('|')?;
    let timestamp = chrono::DateTime::parse_from_rfc3339(&raw[..separator]).ok()?;
    Some((
        timestamp.with_timezone(&chrono::Utc),
        raw[separator + 1..].to_string(),
    ))
}

pub async fn list_notification_inbox(
    pool: &PgPool,
    user_id: &str,
    limit: i64,
    cursor: Option<String>,
) -> Result<NotificationInboxResponse, AppError> {
    let limit = limit.clamp(1, 100);
    let cursor = decode_cursor(cursor);

    let rows = sqlx::query_as::<_, NotificationInboxRow>(
        r#"
        SELECT
            n.id AS notification_id,
            e.id AS event_id,
            e."createdAt" AS created_at,
            e."eventType" AS event_type,
            e.title,
            e.message,
            e.severity::text AS severity,
            e."entityType" AS entity_type,
            e."entityId" AS entity_id,
            e.payload,
            n.status::text AS status,
            n."readAt" AS read_at,
            email_status.email_delivery_status,
            email_status.email_delivery_error
        FROM "NotificationEvent" e
        JOIN "Notification" n
          ON n."eventId" = e.id
         AND n."recipientType" = 'USER'::"NotificationRecipientType"
         AND n."recipientId" = $1
         AND n.channel = 'IN_APP'::"NotificationChannel"
        LEFT JOIN LATERAL (
            SELECT
                email_n.status::text AS email_delivery_status,
                COALESCE(log."errorMessage", email_n."errorMessage") AS email_delivery_error
            FROM "Notification" email_n
            LEFT JOIN LATERAL (
                SELECT "errorMessage"
                FROM "NotificationDeliveryLog"
                WHERE "notificationId" = email_n.id
                ORDER BY "createdAt" DESC
                LIMIT 1
            ) log ON TRUE
            WHERE email_n."eventId" = e.id
              AND email_n."recipientType" = 'USER'::"NotificationRecipientType"
              AND email_n."recipientId" = $1
              AND email_n.channel = 'EMAIL'::"NotificationChannel"
            LIMIT 1
        ) email_status ON TRUE
        WHERE e."eventType" <> 'message.received'
          AND (
            $2::timestamptz IS NULL
            OR e."createdAt" < $2
            OR (e."createdAt" = $2 AND e.id < COALESCE($3, ''))
          )
        ORDER BY e."createdAt" DESC, e.id DESC
        LIMIT $4
        "#,
    )
    .bind(user_id)
    .bind(cursor.as_ref().map(|value| value.0))
    .bind(cursor.as_ref().map(|value| value.1.as_str()))
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;

    let unread_count = get_unread_notification_count(pool, user_id).await?;

    let has_more = rows.len() as i64 > limit;
    let visible_rows = if has_more {
        rows[..limit as usize].to_vec()
    } else {
        rows
    };

    let next_cursor = visible_rows
        .last()
        .filter(|_| has_more)
        .map(|row| encode_cursor(row.created_at, &row.event_id));

    Ok(NotificationInboxResponse {
        items: visible_rows
            .into_iter()
            .map(NotificationInboxItem::from)
            .collect(),
        next_cursor,
        unread_count,
    })
}

pub async fn get_unread_notification_count(pool: &PgPool, user_id: &str) -> Result<i64, AppError> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM "Notification" n
        JOIN "NotificationEvent" e ON e.id = n."eventId"
        WHERE n."recipientType" = 'USER'::"NotificationRecipientType"
          AND n."recipientId" = $1
          AND n.channel = 'IN_APP'::"NotificationChannel"
          AND n."readAt" IS NULL
          AND n.status NOT IN ('DISMISSED'::"NotificationStatus", 'FAILED'::"NotificationStatus")
          AND e."eventType" <> 'message.received'
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(count)
}

pub async fn mark_notification_read(
    pool: &PgPool,
    user_id: &str,
    notification_id: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "Notification"
        SET "readAt" = NOW(), status = 'READ'::"NotificationStatus", "updatedAt" = NOW()
        WHERE id = $1
          AND "recipientType" = 'USER'::"NotificationRecipientType"
          AND "recipientId" = $2
          AND channel = 'IN_APP'::"NotificationChannel"
          AND "readAt" IS NULL
        "#,
    )
    .bind(notification_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

pub async fn mark_all_notifications_read(pool: &PgPool, user_id: &str) -> Result<u64, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "Notification"
        SET "readAt" = NOW(), status = 'READ'::"NotificationStatus", "updatedAt" = NOW()
        WHERE "recipientType" = 'USER'::"NotificationRecipientType"
          AND "recipientId" = $1
          AND channel = 'IN_APP'::"NotificationChannel"
          AND "readAt" IS NULL
          AND status NOT IN ('DISMISSED'::"NotificationStatus", 'FAILED'::"NotificationStatus")
        "#,
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
