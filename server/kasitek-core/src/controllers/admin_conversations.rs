use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize)]
struct ConversationRow {
    id: String,
    channel: String,
    #[sqlx(rename = "customerIdentifier")]
    customer_identifier: String,
    #[sqlx(rename = "customerName")]
    customer_name: Option<String>,
    status: String,
    #[sqlx(rename = "lastMessageAt")]
    last_message_at: DateTime<Utc>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow, Serialize)]
struct MessageRow {
    id: String,
    #[sqlx(rename = "conversationId")]
    conversation_id: String,
    role: String,
    content: String,
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    channel: Option<String>,
    search: Option<String>,
}

pub async fn list_conversations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ListQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let conversations = sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier", "customerName", status,
               "lastMessageAt", "createdAt"
        FROM "Conversation"
        ORDER BY "lastMessageAt" DESC
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let filtered: Vec<&ConversationRow> = conversations
        .iter()
        .filter(|c| {
            let channel_ok = query.channel.as_deref().map(|ch| c.channel == ch).unwrap_or(true);
            let search_ok = query.search.as_deref().map(|q| {
                let q = q.to_lowercase();
                c.customer_identifier.to_lowercase().contains(&q)
                    || c.customer_name.as_deref().unwrap_or("").to_lowercase().contains(&q)
            }).unwrap_or(true);
            channel_ok && search_ok
        })
        .collect();

    Ok(HttpResponse::Ok().json(filtered))
}

pub async fn get_conversation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let conversation = sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier", "customerName", status,
               "lastMessageAt", "createdAt"
        FROM "Conversation"
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("conversation not found".to_string()))?;

    let messages = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId", role, content, timestamp
        FROM "Message"
        WHERE "conversationId" = $1
        ORDER BY timestamp ASC
        "#,
    )
    .bind(&id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "conversation": conversation,
        "messages": messages,
    })))
}
