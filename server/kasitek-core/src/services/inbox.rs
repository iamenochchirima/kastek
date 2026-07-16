use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{FromRow, PgPool};

use crate::config::AppConfig;
use crate::db::models::{ConversationRow, WhatsappSendMessageRequest};
use crate::error::AppError;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::{realtime, social, whatsapp};

const META_GRAPH_BASE: &str = "https://graph.facebook.com/v23.0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, FromRow)]
struct MetaInboxConversationRow {
    id: String,
    channel: String,
    #[sqlx(rename = "customer_identifier")]
    customer_identifier: String,
    #[sqlx(rename = "customer_name")]
    customer_name: Option<String>,
    status: String,
    #[sqlx(rename = "last_message_at")]
    last_message_at: chrono::DateTime<Utc>,
    #[sqlx(rename = "last_read_at")]
    last_read_at: Option<chrono::DateTime<Utc>>,
    #[sqlx(rename = "unread_count")]
    unread_count: i32,
    #[sqlx(rename = "channel_connection_id")]
    channel_connection_id: String,
    #[sqlx(rename = "channel_label")]
    channel_label: String,
    #[sqlx(rename = "last_message_content")]
    last_message_content: Option<String>,
}

#[derive(Debug, FromRow)]
struct InboxMessageRow {
    id: String,
    #[sqlx(rename = "conversation_id")]
    conversation_id: String,
    sender: String,
    content: String,
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
    timestamp: chrono::DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct MetaChannelRow {
    id: String,
    #[sqlx(rename = "user_id")]
    user_id: String,
    #[sqlx(rename = "org_id")]
    org_id: Option<String>,
    platform: String,
}

#[derive(Debug, FromRow)]
struct MetaConversationScopeRow {
    id: String,
    channel: String,
    #[sqlx(rename = "customer_identifier")]
    customer_identifier: String,
    #[sqlx(rename = "channel_connection_id")]
    channel_connection_id: String,
    #[sqlx(rename = "external_account_id")]
    external_account_id: Option<String>,
    #[sqlx(rename = "access_token")]
    access_token: Option<String>,
    metadata: Option<Value>,
}

#[derive(Debug, serde::Deserialize)]
struct MetaSendMessageResponse {
    #[serde(rename = "message_id")]
    message_id: Option<String>,
}

pub fn verify_meta_webhook_request(
    query: &std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    let mode = query.get("hub.mode").cloned().unwrap_or_default();
    let token = query.get("hub.verify_token").cloned().unwrap_or_default();
    let challenge = query.get("hub.challenge").cloned().unwrap_or_default();

    if mode != "subscribe" || challenge.is_empty() {
        return Err(AppError::BadRequest(
            "Invalid verification request".to_string(),
        ));
    }

    let expected = std::env::var("META_WEBHOOK_VERIFY_TOKEN")
        .or_else(|_| std::env::var("AUTH_META_WEBHOOK_VERIFY_TOKEN"))
        .unwrap_or_default();

    if expected.is_empty() || token != expected {
        return Err(AppError::Forbidden("Invalid verify token".to_string()));
    }

    Ok(challenge)
}

pub fn verify_meta_webhook_signature(
    signature_header: Option<&str>,
    body: &[u8],
) -> Result<(), AppError> {
    let app_secret = std::env::var("AUTH_META_APP_SECRET")
        .map_err(|_| AppError::Forbidden("Meta webhook secret is not configured".to_string()))?;
    let signature = signature_header
        .and_then(|value| value.strip_prefix("sha256="))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Forbidden("Missing Meta webhook signature".to_string()))?;

    let mut mac = HmacSha256::new_from_slice(app_secret.as_bytes())
        .map_err(|_| AppError::Internal("Failed to initialize webhook signature".to_string()))?;
    mac.update(body);
    let expected = hex::encode(mac.finalize().into_bytes());

    if expected != signature {
        return Err(AppError::Forbidden(
            "Invalid Meta webhook signature".to_string(),
        ));
    }

    Ok(())
}

pub async fn list_inbox_conversations(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let mut conversations = whatsapp::list_inbox_conversations(pool, org_id)
        .await?
        .get("conversations")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let meta_rows = sqlx::query_as::<_, MetaInboxConversationRow>(
        r#"
        SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c."unreadCount" AS unread_count,
            scc.id AS channel_connection_id,
            scc."displayName" AS channel_label,
            last_message.content AS last_message_content
        FROM "Conversation" c
        JOIN "SocialChannelConnection" scc
          ON scc.id = split_part(c."customerIdentifier", ':', 2)
        LEFT JOIN LATERAL (
            SELECT m.content
            FROM "Message" m
            WHERE m."conversationId" = c.id
            ORDER BY m.timestamp DESC
            LIMIT 1
        ) last_message ON true
        WHERE c.channel IN ('facebook', 'instagram')
          AND c."orgId" = $1
          AND scc."orgId" = $1
          AND c."customerIdentifier" LIKE 'meta:%'
        ORDER BY c."lastMessageAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    for row in meta_rows {
        let customer_handle = parse_meta_conversation_identifier(&row.customer_identifier)
            .map(|(_, customer_id)| customer_id)
            .unwrap_or_else(|| row.customer_identifier.clone());
        conversations.push(json!({
            "id": row.id,
            "channel": row.channel,
            "customerName": row.customer_name,
            "phone": customer_handle,
            "status": row.status,
            "lastMessageAt": row.last_message_at,
            "lastReadAt": row.last_read_at,
            "unreadCount": row.unread_count,
            "starred": false,
            "connectionId": row.channel_connection_id,
            "connectionLabel": row.channel_label,
            "lastMessage": row.last_message_content.unwrap_or_else(|| "No messages yet".to_string()),
        }));
    }

    conversations.sort_by(|left, right| {
        let left_time = left
            .get("lastMessageAt")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let right_time = right
            .get("lastMessageAt")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        right_time.cmp(left_time)
    });

    Ok(json!({ "conversations": conversations }))
}

pub async fn list_conversation_messages(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    if conversation.channel == "whatsapp" {
        return whatsapp::list_conversation_messages(pool, org_id, conversation_id).await;
    }

    let messages = sqlx::query_as::<_, InboxMessageRow>(
        r#"
        SELECT
            id,
            "conversationId" AS conversation_id,
            sender,
            content,
            "whatsappMessageId" AS whatsapp_message_id,
            "whatsappStatus" AS whatsapp_status,
            "providerMessageId" AS provider_message_id,
            "providerStatus" AS provider_status,
            "errorCode" AS error_code,
            "errorMessage" AS error_message,
            timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "conversationId" = $1
        ORDER BY timestamp ASC
        "#,
    )
    .bind(&conversation.id)
    .fetch_all(pool)
    .await?;

    let mapped = messages
        .into_iter()
        .map(|message| {
            json!({
                "id": message.id,
                "conversationId": message.conversation_id,
                "sender": message.sender,
                "content": message.content,
                "text": message.content,
                "time": message.timestamp,
                "timestamp": message.timestamp,
                "status": message.provider_status.or(message.whatsapp_status),
                "providerMessageId": message.provider_message_id.or(message.whatsapp_message_id),
                "errorCode": message.error_code,
                "errorMessage": message.error_message,
                "canReply": true,
                "canReact": false,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "messages": mapped }))
}

pub async fn send_conversation_message(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    input: WhatsappSendMessageRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    if conversation.channel == "whatsapp" {
        return whatsapp::send_conversation_message(pool, user_id, org_id, conversation_id, input)
            .await;
    }

    let text = input
        .text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Reply text is required".to_string()))?;

    let meta_scope = scoped_meta_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let (_, customer_id) = parse_meta_conversation_identifier(&meta_scope.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid Meta conversation".to_string()))?;

    let encrypted_access_token = meta_scope.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Connected channel is missing an access token".to_string())
    })?;
    let access_token = social::decrypt_social_secret(encrypted_access_token)?;

    let asset_id = meta_send_asset_id(&meta_scope).ok_or_else(|| {
        AppError::BadRequest("Connected Meta channel is missing a target asset".to_string())
    })?;

    let response: MetaSendMessageResponse = fetch_meta_json(
        reqwest::Client::new()
            .post(format!("{META_GRAPH_BASE}/{asset_id}/messages"))
            .bearer_auth(access_token)
            .json(&json!({
                "recipient": { "id": customer_id },
                "messaging_type": "RESPONSE",
                "message": { "text": text },
            })),
        "Failed to send Meta message",
    )
    .await?;

    let message_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Message" (
            id, "conversationId", sender, content,
            "providerMessageId", "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, $4, 'SENT', $5, NOW())
        "#,
    )
    .bind(&message_id)
    .bind(&meta_scope.id)
    .bind(text)
    .bind(response.message_id.as_deref())
    .bind(json!({
        "provider": meta_scope.channel,
        "channelConnectionId": meta_scope.channel_connection_id,
        "replyToMessageId": input.reply_to_message_id,
    }))
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE "Conversation"
        SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW()
        WHERE id = $1
        "#,
    )
    .bind(&meta_scope.id)
    .execute(pool)
    .await?;

    publish_message_created(pool, user_id, &message_id).await?;
    publish_conversation_updated(pool, user_id, &meta_scope.id).await?;

    Ok(json!({
        "success": true,
        "messageId": message_id,
        "providerMessageId": response.message_id,
        "status": "SENT",
    }))
}

pub async fn mark_conversation_read(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    if conversation.channel == "whatsapp" {
        return whatsapp::mark_conversation_read(pool, user_id, org_id, conversation_id).await;
    }

    sqlx::query(
        r#"
        UPDATE "Conversation"
        SET "unreadCount" = 0, "lastReadAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1
        "#,
    )
    .bind(&conversation.id)
    .execute(pool)
    .await?;

    publish_conversation_updated(pool, user_id, &conversation.id).await?;

    Ok(json!({ "success": true, "conversationId": conversation.id }))
}

pub async fn process_meta_webhook_payload(
    pool: &PgPool,
    config: &AppConfig,
    payload: Value,
) -> Result<(), AppError> {
    let object = payload
        .get("object")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let entries = payload
        .get("entry")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    for entry in entries {
        let messaging_events = entry
            .get("messaging")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        for event in messaging_events {
            if event
                .get("message")
                .and_then(|message| message.get("is_echo"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                continue;
            }

            let message = match event.get("message") {
                Some(value) => value,
                None => continue,
            };

            let sender_id = event
                .get("sender")
                .and_then(|value| value.get("id"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let recipient_id = event
                .get("recipient")
                .and_then(|value| value.get("id"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if sender_id.is_empty() || recipient_id.is_empty() {
                continue;
            }

            let channel = resolve_meta_channel(pool, &object, &recipient_id)
                .await?
                .or_else(|| if object == "page" { None } else { None });
            let Some(channel) = channel else {
                continue;
            };

            let content = meta_message_content(message);
            if content.is_empty() {
                continue;
            }

            let message_mid = message
                .get("mid")
                .and_then(|value| value.as_str())
                .map(str::to_string);

            let (conversation_id, unread_count) =
                find_or_create_meta_conversation(pool, &channel, &sender_id, None).await?;

            let message_id = cuid2::create_id();
            sqlx::query(
                r#"
                INSERT INTO "Message" (
                    id, "conversationId", sender, content,
                    "providerMessageId", "providerStatus", "providerMetadata", timestamp
                )
                VALUES ($1, $2, 'customer', $3, $4, 'RECEIVED', $5, NOW())
                "#,
            )
            .bind(&message_id)
            .bind(&conversation_id)
            .bind(&content)
            .bind(message_mid.as_deref())
            .bind(json!({
                "provider": channel.platform.to_lowercase(),
                "object": object,
                "event": event,
            }))
            .execute(pool)
            .await?;

            sqlx::query(
                r#"
                UPDATE "Conversation"
                SET "lastMessageAt" = NOW(), status = 'active', "unreadCount" = $1 + 1, "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(unread_count)
            .bind(&conversation_id)
            .execute(pool)
            .await?;

            publish_message_created(pool, &channel.user_id, &message_id).await?;
            publish_conversation_updated(pool, &channel.user_id, &conversation_id).await?;

            let title = if channel.platform == "INSTAGRAM" {
                "New Instagram message"
            } else {
                "New Facebook message"
            };
            let body = format!("{}: {}", sender_id, preview_text(&content, 120));
            if let Err(error) = send_push_notification_to_user(
                pool,
                config,
                &channel.user_id,
                PushNotificationPayload {
                    title: title.to_string(),
                    body,
                    url: "/inbox".to_string(),
                    tag: Some(format!("conversation:{conversation_id}")),
                },
            )
            .await
            {
                log::warn!(
                    "failed to send push notification for incoming meta message conversation_id={} user_id={}: {}",
                    conversation_id,
                    channel.user_id,
                    error
                );
            }
        }
    }

    Ok(())
}

async fn scoped_conversation(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Option<ConversationRow>, AppError> {
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c.starred,
            c."unreadCount" AS unread_count,
            c."createdAt" AT TIME ZONE 'UTC' AS created_at,
            c."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation" c
        WHERE c.id = $1
          AND c."orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn scoped_meta_conversation(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Option<MetaConversationScopeRow>, AppError> {
    sqlx::query_as::<_, MetaConversationScopeRow>(
        r#"
        SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c."unreadCount" AS unread_count,
            scc.id AS channel_connection_id,
            scc."displayName" AS channel_label,
            scc.platform::text AS platform,
            scc."externalAccountId" AS external_account_id,
            scc."accessToken" AS access_token,
            scc.metadata
        FROM "Conversation" c
        JOIN "SocialChannelConnection" scc
          ON scc.id = split_part(c."customerIdentifier", ':', 2)
         AND scc."orgId" = $2
        WHERE c.id = $1
          AND c."orgId" = $2
          AND c.channel IN ('facebook', 'instagram')
          AND c."customerIdentifier" LIKE 'meta:%'
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn resolve_meta_channel(
    pool: &PgPool,
    object: &str,
    recipient_id: &str,
) -> Result<Option<MetaChannelRow>, AppError> {
    let primary_platform = if object == "instagram" {
        "INSTAGRAM"
    } else {
        "FACEBOOK"
    };

    let direct = sqlx::query_as::<_, MetaChannelRow>(
        r#"
        SELECT
            id,
            "userId" AS user_id,
            "orgId" AS org_id,
            platform::text AS platform,
            "displayName" AS display_name,
            "externalAccountId" AS external_account_id,
            "accessToken" AS access_token,
            metadata
        FROM "SocialChannelConnection"
        WHERE platform = $1::"SocialPlatform"
          AND "externalAccountId" = $2
        LIMIT 1
        "#,
    )
    .bind(primary_platform)
    .bind(recipient_id)
    .fetch_optional(pool)
    .await?;
    if direct.is_some() {
        return Ok(direct);
    }

    sqlx::query_as::<_, MetaChannelRow>(
        r#"
        SELECT
            id,
            "userId" AS user_id,
            "orgId" AS org_id,
            platform::text AS platform,
            "displayName" AS display_name,
            "externalAccountId" AS external_account_id,
            "accessToken" AS access_token,
            metadata
        FROM "SocialChannelConnection"
        WHERE platform = 'INSTAGRAM'::"SocialPlatform"
          AND COALESCE(metadata->>'pageId', '') = $1
        LIMIT 1
        "#,
    )
    .bind(recipient_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn find_or_create_meta_conversation(
    pool: &PgPool,
    channel: &MetaChannelRow,
    customer_id: &str,
    customer_name: Option<&str>,
) -> Result<(String, i32), AppError> {
    let channel_name = if channel.platform == "INSTAGRAM" {
        "instagram"
    } else {
        "facebook"
    };
    let identifier = build_meta_conversation_identifier(&channel.id, customer_id);

    let existing = sqlx::query_as::<_, (String, i32)>(
        r#"
        SELECT id, "unreadCount"
        FROM "Conversation"
        WHERE channel = $1 AND "customerIdentifier" = $2
        LIMIT 1
        "#,
    )
    .bind(channel_name)
    .bind(&identifier)
    .fetch_optional(pool)
    .await?;

    if let Some((id, unread_count)) = existing {
        if let Some(name) = customer_name {
            sqlx::query(r#"UPDATE "Conversation" SET "customerName" = COALESCE($1, "customerName"), "updatedAt" = NOW() WHERE id = $2"#)
                .bind(name)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        return Ok((id, unread_count));
    }

    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Conversation" (
            id, channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "orgId", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, 'active', NOW(), 0, $5, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(channel_name)
    .bind(&identifier)
    .bind(customer_name)
    .bind(channel.org_id.as_deref())
    .execute(pool)
    .await?;

    Ok((id, 0))
}

async fn publish_conversation_updated(
    pool: &PgPool,
    user_id: &str,
    conversation_id: &str,
) -> Result<(), AppError> {
    let Some(conversation) = scoped_conversation(pool, user_id, conversation_id).await? else {
        return Ok(());
    };
    let (connection_id, connection_label, handle) =
        conversation_channel_context(pool, &conversation).await?;

    publish_event_best_effort(
        user_id,
        json!({
            "type": "conversation.updated",
            "conversationId": conversation.id,
            "conversation": {
                "id": conversation.id,
                "channel": conversation.channel,
                "customerName": conversation.customer_name,
                "phone": handle,
                "connectionId": connection_id,
                "connectionLabel": connection_label,
                "lastMessageAt": conversation.last_message_at,
                "unreadCount": conversation.unread_count,
                "starred": conversation.starred,
            }
        }),
    )
    .await;

    Ok(())
}

async fn publish_message_created(
    pool: &PgPool,
    user_id: &str,
    message_id: &str,
) -> Result<(), AppError> {
    let Some(message) = sqlx::query_as::<_, InboxMessageRow>(
        r#"
        SELECT
            id,
            "conversationId" AS conversation_id,
            sender,
            content,
            "whatsappMessageId" AS whatsapp_message_id,
            "whatsappStatus" AS whatsapp_status,
            "providerMessageId" AS provider_message_id,
            "providerStatus" AS provider_status,
            "errorCode" AS error_code,
            "errorMessage" AS error_message,
            timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(());
    };

    let Some(conversation) = scoped_conversation(pool, user_id, &message.conversation_id).await?
    else {
        return Ok(());
    };
    let (connection_id, connection_label, handle) =
        conversation_channel_context(pool, &conversation).await?;

    publish_event_best_effort(
        user_id,
        json!({
            "type": "message.created",
            "conversationId": conversation.id,
            "conversation": {
                "channel": conversation.channel,
                "customerName": conversation.customer_name,
                "phone": handle,
                "connectionId": connection_id,
                "connectionLabel": connection_label,
                "unreadCount": conversation.unread_count,
                "lastMessageAt": conversation.last_message_at,
            },
            "message": {
                "id": message.id,
                "sender": message.sender,
                "content": message.content,
                "timestamp": message.timestamp,
                "whatsappStatus": message.whatsapp_status,
                "providerStatus": message.provider_status,
                "providerMessageId": message.provider_message_id,
            }
        }),
    )
    .await;

    Ok(())
}

async fn conversation_channel_context(
    pool: &PgPool,
    conversation: &ConversationRow,
) -> Result<(Option<String>, Option<String>, String), AppError> {
    match conversation.channel.as_str() {
        "whatsapp" => {
            let parts: Vec<_> = conversation.customer_identifier.split(':').collect();
            let connection_id = parts.get(1).map(|value| value.to_string());
            let handle = parts
                .get(2..)
                .map(|values| values.join(":"))
                .unwrap_or_else(|| conversation.customer_identifier.clone());
            let connection_label = if let Some(connection_id) = connection_id.as_deref() {
                sqlx::query_scalar::<_, Option<String>>(
                    r#"SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
                )
                .bind(connection_id)
                .fetch_optional(pool)
                .await?
                .flatten()
            } else {
                None
            };
            Ok((connection_id, connection_label, handle))
        }
        "facebook" | "instagram" => {
            let (channel_connection_id, customer_id) =
                parse_meta_conversation_identifier(&conversation.customer_identifier)
                    .unwrap_or_else(|| (String::new(), conversation.customer_identifier.clone()));
            let channel_label = if channel_connection_id.is_empty() {
                None
            } else {
                sqlx::query_scalar::<_, Option<String>>(
                    r#"SELECT "displayName" FROM "SocialChannelConnection" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&channel_connection_id)
                .fetch_optional(pool)
                .await?
                .flatten()
            };
            Ok((Some(channel_connection_id), channel_label, customer_id))
        }
        _ => Ok((None, None, conversation.customer_identifier.clone())),
    }
}

async fn publish_event_best_effort(user_id: &str, event: Value) {
    if let Err(error) = realtime::publish_inbox_event(user_id, &event).await {
        log::warn!("failed to publish inbox realtime event: {}", error);
    }
}

fn build_meta_conversation_identifier(channel_connection_id: &str, customer_id: &str) -> String {
    format!("meta:{channel_connection_id}:{customer_id}")
}

fn parse_meta_conversation_identifier(identifier: &str) -> Option<(String, String)> {
    let parts: Vec<_> = identifier.split(':').collect();
    if parts.len() < 3 || parts[0] != "meta" {
        return None;
    }
    Some((parts[1].to_string(), parts[2..].join(":")))
}

fn preview_text(content: &str, limit: usize) -> String {
    let trimmed = content.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let shortened = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    format!("{shortened}…")
}

fn meta_message_content(message: &Value) -> String {
    if let Some(text) = message.get("text").and_then(|value| value.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let attachment_type = message
        .get("attachments")
        .and_then(|value| value.as_array())
        .and_then(|attachments| attachments.first())
        .and_then(|attachment| attachment.get("type"))
        .and_then(|value| value.as_str())
        .unwrap_or("attachment");

    format!("[{} attachment]", attachment_type)
}

fn meta_send_asset_id(scope: &MetaConversationScopeRow) -> Option<String> {
    if scope.channel == "instagram" {
        scope
            .metadata
            .as_ref()
            .and_then(|value| value.get("pageId"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .or_else(|| scope.external_account_id.clone())
    } else {
        scope.external_account_id.clone()
    }
}

async fn fetch_meta_json<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
    failure_message: &str,
) -> Result<T, AppError> {
    let response = request.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        let provider_message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.get("error").cloned())
            .and_then(|value| value.get("message").cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{failure_message} ({status})"));
        return Err(AppError::BadRequest(provider_message));
    }

    serde_json::from_str(&body)
        .map_err(|_| AppError::Internal("Failed to decode Meta response".to_string()))
}
