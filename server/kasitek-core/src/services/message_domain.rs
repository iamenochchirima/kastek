use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};

use crate::error::AppError;

pub fn channel_capabilities(channel: &str) -> Value {
    match channel {
        "whatsapp" => json!({
            "version": 1,
            "text": true,
            "reply": true,
            "reaction": true,
            "attachments": { "image": true, "video": true, "audio": true, "document": true, "sticker": true },
            "providerDelete": true,
            "deliveryReceipts": true,
            "readReceipts": true,
        }),
        "facebook" | "instagram" => json!({
            "version": 1,
            "text": true,
            "reply": true,
            "reaction": false,
            "attachments": { "image": false, "video": false, "audio": false, "document": false, "sticker": false },
            "providerDelete": false,
            "deliveryReceipts": true,
            "readReceipts": true,
        }),
        _ => json!({
            "version": 1,
            "text": false,
            "reply": false,
            "reaction": false,
            "attachments": { "image": false, "video": false, "audio": false, "document": false, "sticker": false },
            "providerDelete": false,
            "deliveryReceipts": false,
            "readReceipts": false,
        }),
    }
}

#[derive(Debug, FromRow)]
struct MessageTimelineRow {
    id: String,
    #[sqlx(rename = "conversation_id")]
    conversation_id: String,
    sender: String,
    content: String,
    #[sqlx(rename = "content_type")]
    content_type: String,
    #[sqlx(rename = "whatsapp_message_id")]
    whatsapp_message_id: Option<String>,
    #[sqlx(rename = "whatsapp_status")]
    whatsapp_status: Option<String>,
    #[sqlx(rename = "provider_message_id")]
    provider_message_id: Option<String>,
    #[sqlx(rename = "provider_status")]
    provider_status: Option<String>,
    #[sqlx(rename = "error_code")]
    error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    error_message: Option<String>,
    #[sqlx(rename = "edited_at")]
    edited_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "deleted_at")]
    deleted_at: Option<DateTime<Utc>>,
    timestamp: DateTime<Utc>,
    attachments: Value,
    reference: Option<Value>,
    reactions: Value,
}

pub async fn list_timeline_messages(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Vec<Value>, AppError> {
    let rows = sqlx::query_as::<_, MessageTimelineRow>(
        r#"
        SELECT
            m.id,
            m."conversationId" AS conversation_id,
            m.sender,
            m.content,
            m."contentType" AS content_type,
            m."whatsappMessageId" AS whatsapp_message_id,
            m."whatsappStatus" AS whatsapp_status,
            m."providerMessageId" AS provider_message_id,
            m."providerStatus" AS provider_status,
            m."errorCode" AS error_code,
            m."errorMessage" AS error_message,
            m."editedAt" AT TIME ZONE 'UTC' AS edited_at,
            m."deletedAt" AT TIME ZONE 'UTC' AS deleted_at,
            m.timestamp AT TIME ZONE 'UTC' AS timestamp,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', attachment.id,
                    'kind', attachment.kind,
                    'providerMediaId', attachment."providerMediaId",
                    'mimeType', attachment."mimeType",
                    'fileName', attachment."fileName",
                    'byteSize', attachment."byteSize",
                    'checksum', attachment.checksum,
                    'width', attachment.width,
                    'height', attachment.height,
                    'durationMs', attachment."durationMs",
                    'downloadStatus', attachment."downloadStatus",
                    'scanStatus', attachment."scanStatus",
                    'metadata', attachment.metadata
                ) ORDER BY attachment."createdAt" ASC)
                FROM "MessageAttachment" attachment
                WHERE attachment."messageId" = m.id
            ), '[]'::jsonb) AS attachments,
            (
                SELECT jsonb_build_object(
                    'messageId', reference."referencedMessageId",
                    'providerMessageId', reference."referencedProviderMessageId",
                    'kind', reference.kind,
                    'previewText', reference."previewText",
                    'previewKind', reference."previewKind"
                )
                FROM "MessageReference" reference
                WHERE reference."messageId" = m.id
            ) AS reference,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', reaction.id,
                    'emoji', reaction.emoji,
                    'actorIdentifier', reaction."actorIdentifier",
                    'active', reaction.active,
                    'occurredAt', reaction."occurredAt"
                ) ORDER BY reaction."occurredAt" ASC)
                FROM "MessageReaction" reaction
                WHERE reaction."messageId" = m.id
                  AND reaction.active = true
            ), '[]'::jsonb) AS reactions
        FROM "Message" m
        WHERE m."conversationId" = $1
        ORDER BY m.timestamp ASC
        "#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|message| {
            let provider_message_id = message
                .provider_message_id
                .clone()
                .or(message.whatsapp_message_id.clone());
            let status = message
                .provider_status
                .clone()
                .or(message.whatsapp_status.clone());
            json!({
                "id": message.id,
                "conversationId": message.conversation_id,
                "sender": message.sender,
                "content": message.content,
                "text": message.content,
                "contentType": message.content_type,
                "time": message.timestamp,
                "timestamp": message.timestamp,
                "status": status,
                "providerMessageId": provider_message_id,
                "whatsappMessageId": message.whatsapp_message_id,
                "errorCode": message.error_code,
                "errorMessage": message.error_message,
                "editedAt": message.edited_at,
                "deletedAt": message.deleted_at,
                "attachments": message.attachments,
                "reference": message.reference,
                "reactions": message.reactions,
                "canReply": provider_message_id.is_some() && message.deleted_at.is_none(),
                "canReact": false,
            })
        })
        .collect())
}

pub async fn list_active_reactions(pool: &PgPool, message_id: &str) -> Result<Value, AppError> {
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', reaction.id,
            'emoji', reaction.emoji,
            'actorIdentifier', reaction."actorIdentifier",
            'active', reaction.active,
            'occurredAt', reaction."occurredAt"
        ) ORDER BY reaction."occurredAt" ASC), '[]'::jsonb)
        FROM "MessageReaction" reaction
        WHERE reaction."messageId" = $1
          AND reaction.active = true
        "#,
    )
    .bind(message_id)
    .fetch_one(pool)
    .await
    .map_err(AppError::from)
}

pub async fn create_reference(
    pool: &PgPool,
    message_id: &str,
    referenced_message_id: &str,
    referenced_provider_message_id: Option<&str>,
    preview_text: Option<&str>,
    preview_kind: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "MessageReference" (
            id, "messageId", "referencedMessageId", "referencedProviderMessageId",
            kind, "previewText", "previewKind", "createdAt"
        ) VALUES ($1, $2, $3, $4, 'REPLY', $5, $6, NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(message_id)
    .bind(referenced_message_id)
    .bind(referenced_provider_message_id)
    .bind(preview_text)
    .bind(preview_kind)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn create_attachment(
    pool: &PgPool,
    message_id: &str,
    provider_media_id: Option<&str>,
    kind: &str,
    mime_type: Option<&str>,
    file_name: Option<&str>,
    checksum: Option<&str>,
    metadata: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "MessageAttachment" (
            id, "messageId", "providerMediaId", kind, "mimeType", "fileName", checksum,
            "downloadStatus", "scanStatus", metadata, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROVIDER_AVAILABLE', 'NOT_SCANNED', $8, NOW(), NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(message_id)
    .bind(provider_media_id)
    .bind(kind)
    .bind(mime_type)
    .bind(file_name)
    .bind(checksum)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn upsert_reaction(
    pool: &PgPool,
    message_id: &str,
    actor_identifier: &str,
    emoji: Option<&str>,
    active: bool,
    provider_event_id: Option<&str>,
    metadata: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "MessageReaction" (
            id, "messageId", "actorIdentifier", emoji, "providerEventId", active,
            "occurredAt", metadata, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW(), NOW())
        ON CONFLICT ("messageId", "actorIdentifier") DO UPDATE SET
            emoji = EXCLUDED.emoji,
            "providerEventId" = EXCLUDED."providerEventId",
            active = EXCLUDED.active,
            "occurredAt" = EXCLUDED."occurredAt",
            metadata = EXCLUDED.metadata,
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(message_id)
    .bind(actor_identifier)
    .bind(emoji)
    .bind(provider_event_id)
    .bind(active)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_event(
    pool: &PgPool,
    conversation_id: &str,
    message_id: Option<&str>,
    provider_event_id: Option<&str>,
    kind: &str,
    metadata: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "MessageEvent" (
            id, "conversationId", "messageId", "providerEventId", kind, metadata,
            "occurredAt", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT ("conversationId", "providerEventId") DO NOTHING
        "#,
    )
    .bind(cuid2::create_id())
    .bind(conversation_id)
    .bind(message_id)
    .bind(provider_event_id)
    .bind(kind)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::channel_capabilities;

    #[test]
    fn capabilities_do_not_claim_unimplemented_meta_actions() {
        let capabilities = channel_capabilities("instagram");
        assert_eq!(capabilities["text"], true);
        assert_eq!(capabilities["reply"], true);
        assert_eq!(capabilities["reaction"], false);
        assert_eq!(capabilities["attachments"]["image"], false);
    }

    #[test]
    fn whatsapp_capabilities_expose_the_supported_rich_actions() {
        let capabilities = channel_capabilities("whatsapp");
        assert_eq!(capabilities["reaction"], true);
        assert_eq!(capabilities["attachments"]["document"], true);
    }
}
