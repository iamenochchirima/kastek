use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize)]
struct NotificationRow {
    id: String,
    #[sqlx(rename = "eventId")]
    event_id: String,
    #[sqlx(rename = "recipientType")]
    recipient_type: String,
    #[sqlx(rename = "recipientId")]
    recipient_id: String,
    channel: String,
    status: String,
    #[sqlx(rename = "readAt")]
    read_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "sentAt")]
    sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    // Event fields (joined)
    title: String,
    message: String,
    #[sqlx(rename = "eventType")]
    event_type: String,
    severity: String,
    #[sqlx(rename = "entityType")]
    entity_type: Option<String>,
    #[sqlx(rename = "entityId")]
    entity_id: Option<String>,
    payload: Option<Value>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ListQuery {
    #[serde(rename = "unreadOnly")]
    unread_only: Option<bool>,
    limit: Option<i64>,
    channel: Option<String>,
}

pub async fn list_notifications(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ListQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    let limit = query.limit.unwrap_or(20).min(100).max(1);

    let mut conditions = vec![
        r#"n."recipientType" = 'ADMIN'"#.to_string(),
        format!(r#"n."recipientId" = '{}'"#, admin.id),
    ];

    if query.unread_only == Some(true) {
        conditions.push(r#"n."readAt" IS NULL"#.to_string());
    }
    if let Some(ch) = &query.channel {
        if !ch.is_empty() {
            conditions.push(format!("n.channel = '{}'", ch.replace('\'', "''")));
        }
    }

    let where_clause = format!("WHERE {}", conditions.join(" AND "));

    let sql = format!(r#"
        SELECT
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
        LIMIT {limit}
    "#);

    let notifications = sqlx::query_as::<_, NotificationRow>(&sql)
        .fetch_all(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "notifications": notifications })))
}

pub async fn unread_count(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;

    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM "Notification"
        WHERE "recipientType" = 'ADMIN'
          AND "recipientId" = $1
          AND "readAt" IS NULL
        "#,
    )
    .bind(&admin.id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "unreadCount": count })))
}

pub async fn mark_notification_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let updated = sqlx::query_scalar::<_, i64>(
        r#"
        WITH updated AS (
            UPDATE "Notification"
            SET "readAt" = NOW(), "updatedAt" = NOW()
            WHERE id = $1
              AND "recipientType" = 'ADMIN'
              AND "recipientId" = $2
              AND "readAt" IS NULL
            RETURNING id
        )
        SELECT COUNT(*) FROM updated
        "#,
    )
    .bind(&id)
    .bind(&admin.id)
    .fetch_one(pool.get_ref())
    .await?;

    if updated == 0 {
        return Err(AppError::NotFound("notification not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": updated })))
}

pub async fn mark_all_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;

    let updated = sqlx::query_scalar::<_, i64>(
        r#"
        WITH updated AS (
            UPDATE "Notification"
            SET "readAt" = NOW(), "updatedAt" = NOW()
            WHERE "recipientType" = 'ADMIN'
              AND "recipientId" = $1
              AND "readAt" IS NULL
            RETURNING id
        )
        SELECT COUNT(*) FROM updated
        "#,
    )
    .bind(&admin.id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": updated })))
}
