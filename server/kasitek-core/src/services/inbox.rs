use actix_web::HttpResponse;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{FromRow, PgPool};
use std::collections::HashSet;

use crate::config::AppConfig;
use crate::db::models::{ConversationRow, WhatsappSendMessageRequest};
use crate::error::AppError;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::{customers, message_domain, realtime, social, whatsapp};

const META_GRAPH_BASE: &str = "https://graph.facebook.com/v23.0";
const INSTAGRAM_GRAPH_BASE: &str = "https://graph.instagram.com/v23.0";
const META_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024;

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
    content: String,
    #[sqlx(rename = "provider_message_id")]
    provider_message_id: Option<String>,
    #[sqlx(rename = "provider_status")]
    provider_status: Option<String>,
    #[sqlx(rename = "error_code")]
    error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Debug, FromRow)]
struct MetaChannelRow {
    id: String,
    #[sqlx(rename = "external_connection_id")]
    external_connection_id: String,
    #[sqlx(rename = "user_id")]
    user_id: String,
    #[sqlx(rename = "org_id")]
    org_id: Option<String>,
    platform: String,
    #[sqlx(rename = "external_account_id")]
    external_account_id: Option<String>,
    #[sqlx(rename = "access_token")]
    access_token: Option<String>,
    metadata: Option<Value>,
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
    let mut app_secrets = Vec::new();
    if let Ok(secret) = std::env::var("AUTH_META_APP_SECRET") {
        if !secret.trim().is_empty() {
            app_secrets.push(secret);
        }
    }
    if let Ok(secret) = std::env::var("AUTH_INSTAGRAM_APP_SECRET") {
        if !secret.trim().is_empty() && !app_secrets.iter().any(|value| value == &secret) {
            app_secrets.push(secret);
        }
    }
    if app_secrets.is_empty() {
        return Err(AppError::Forbidden(
            "Meta webhook secret is not configured".to_string(),
        ));
    }

    if app_secrets
        .iter()
        .any(|secret| verify_meta_signature(secret, signature_header, body).is_ok())
    {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Invalid Meta webhook signature".to_string(),
        ))
    }
}

fn verify_meta_signature(
    app_secret: &str,
    signature_header: Option<&str>,
    body: &[u8],
) -> Result<(), AppError> {
    let signature = signature_header
        .and_then(|value| value.strip_prefix("sha256="))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Forbidden("Missing Meta webhook signature".to_string()))?;

    let mut mac = HmacSha256::new_from_slice(app_secret.as_bytes())
        .map_err(|_| AppError::Internal("Failed to initialize webhook signature".to_string()))?;
    mac.update(body);
    let signature_bytes = hex::decode(signature)
        .map_err(|_| AppError::Forbidden("Invalid Meta webhook signature".to_string()))?;
    mac.verify_slice(&signature_bytes)
        .map_err(|_| AppError::Forbidden("Invalid Meta webhook signature".to_string()))
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
        JOIN "ExternalConnection" connection
          ON connection.id = c."externalConnectionId"
         AND connection."orgId" = c."orgId"
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

    let mapped = message_domain::list_timeline_messages(pool, &conversation.id).await?;

    Ok(json!({
        "messages": mapped,
        "capabilities": message_domain::channel_capabilities(&conversation.channel),
    }))
}

async fn resolve_meta_message_attachment_url(
    graph_base: &str,
    access_token: &str,
    message_provider_id: Option<&str>,
    provider_media_id: Option<&str>,
    prefer_sticker: bool,
) -> Option<String> {
    let message_provider_id = message_provider_id?;
    let response = reqwest::Client::new()
        .get(format!("{graph_base}/{message_provider_id}/attachments"))
        .bearer_auth(access_token)
        .query(&[("fields", "id,url,image_data,render_as_sticker,sticker_id")])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    response
        .json::<Value>()
        .await
        .ok()?
        .get("data")
        .and_then(Value::as_array)
        .and_then(|attachments| {
            attachments
                .iter()
                .find(|attachment| {
                    provider_media_id
                        .map(|media_id| {
                            attachment.get("id").and_then(Value::as_str) == Some(media_id)
                        })
                        .unwrap_or(false)
                })
                .or_else(|| {
                    prefer_sticker
                        .then(|| {
                            attachments.iter().find(|attachment| {
                                attachment.get("render_as_sticker").and_then(Value::as_bool)
                                    == Some(true)
                                    || attachment.get("sticker_id").is_some()
                            })
                        })
                        .flatten()
                })
                .and_then(|attachment| {
                    attachment
                        .pointer("/image_data/url")
                        .or_else(|| attachment.get("url"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
}

pub async fn download_message_attachment(
    pool: &PgPool,
    org_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<HttpResponse, AppError> {
    let attachment = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Value,
            String,
            Option<String>,
            Option<Value>,
            Option<Value>,
        ),
    >(
        r#"
        SELECT
            c.channel,
            attachment.kind,
            attachment."providerMediaId",
            attachment."mimeType",
            attachment."fileName",
            attachment.metadata,
            channel.platform::text,
            channel."accessToken",
            channel.metadata,
            message."providerMetadata"
        FROM "MessageAttachment" attachment
        JOIN "Message" message ON message.id = attachment."messageId"
        JOIN "Conversation" c ON c.id = message."conversationId"
        JOIN "SocialChannelConnection" channel
          ON channel.id = split_part(c."customerIdentifier", ':', 2)
         AND channel."orgId" = c."orgId"
        WHERE attachment.id = $1
          AND message.id = $2
          AND c."orgId" = $3
          AND c.channel IN ('facebook', 'instagram')
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
        LIMIT 1
        "#,
    )
    .bind(attachment_id)
    .bind(message_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Attachment not found".to_string()))?;

    let (
        channel,
        attachment_kind,
        provider_media_id,
        mime_type,
        file_name,
        attachment_metadata,
        platform,
        encrypted_access_token,
        channel_metadata,
        message_metadata,
    ) = attachment;
    let encrypted_access_token = encrypted_access_token.ok_or_else(|| {
        AppError::BadRequest("Connected channel is missing an access token".to_string())
    })?;
    let access_token = social::decrypt_social_secret(&encrypted_access_token)?;
    let graph_base = if channel == "instagram"
        && channel_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("authMethod"))
            .and_then(Value::as_str)
            == Some("instagram_login")
    {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };

    let provider_payload = attachment_metadata
        .get("providerPayload")
        .cloned()
        .unwrap_or(Value::Null);
    let media_url_from_payload = provider_payload
        .get("url")
        .or_else(|| provider_payload.get("attachment_url"))
        .or_else(|| provider_payload.pointer("/image_data/url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let message_provider_id = message_metadata.as_ref().and_then(|metadata| {
        metadata
            .get("graphMessage")
            .or_else(|| metadata.get("event"))
            .and_then(|message| {
                message
                    .get("id")
                    .or_else(|| message.pointer("/message/mid"))
            })
            .and_then(Value::as_str)
    });

    // Webhook sticker URLs are frequently a 100px flattened thumbnail. Ask
    // Graph for the message attachment first so the inbox uses the best media
    // representation Meta makes available (usually image_data.url).
    let refreshed_sticker_url = if attachment_kind == "sticker" {
        resolve_meta_message_attachment_url(
            graph_base,
            &access_token,
            message_provider_id,
            provider_media_id.as_deref(),
            true,
        )
        .await
    } else {
        None
    };
    let media_url = if refreshed_sticker_url.is_some() {
        refreshed_sticker_url
    } else if media_url_from_payload.is_some() {
        media_url_from_payload
    } else {
        async {
            let media_id = provider_media_id.as_deref()?;

            // Graph represents outgoing stickers as an attachment with an
            // `image_data.url`. The sticker id itself is not a media node, so
            // retrieve the parent message attachments before trying the media
            // id as a Graph node.
            if let Some(url) = resolve_meta_message_attachment_url(
                graph_base,
                &access_token,
                message_provider_id,
                Some(media_id),
                false,
            )
            .await
            {
                return Some(url);
            }

            let response = reqwest::Client::new()
                .get(format!("{graph_base}/{media_id}"))
                .bearer_auth(&access_token)
                .query(&[("fields", "url")])
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            response
                .json::<Value>()
                .await
                .ok()?
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        .await
    }
    .ok_or_else(|| {
        AppError::BadRequest("Attachment download is not available from this channel".to_string())
    })?;

    let parsed_url = reqwest::Url::parse(&media_url).map_err(|_| {
        AppError::BadRequest("Provider returned an invalid attachment URL".to_string())
    })?;
    let host = parsed_url.host_str().unwrap_or_default();
    let trusted_host = host.ends_with("facebook.com")
        || host.ends_with("fbcdn.net")
        || host.ends_with("fbsbx.com")
        || host.ends_with("instagram.com")
        || host.ends_with("cdninstagram.com");
    if parsed_url.scheme() != "https" || !trusted_host {
        return Err(AppError::BadRequest(
            "Provider returned an untrusted attachment URL".to_string(),
        ));
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(AppError::from)?;
    // Meta returns a signed CDN URL for the actual media. Do not forward the
    // workspace access token to that CDN; it is only used for the Graph lookup.
    let response = client.get(parsed_url).send().await?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "Provider attachment download failed ({})",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > META_ATTACHMENT_MAX_BYTES)
    {
        return Err(AppError::BadRequest(
            "Attachment exceeds the 25 MB download limit".to_string(),
        ));
    }
    let response_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > META_ATTACHMENT_MAX_BYTES {
        return Err(AppError::BadRequest(
            "Attachment exceeds the 25 MB download limit".to_string(),
        ));
    }
    let content_type = response_content_type
        .or(mime_type)
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let extension = content_type.split('/').nth(1).unwrap_or("bin");
    let fallback_name = format!(
        "{}-attachment-{}.{}",
        platform.to_lowercase(),
        attachment_id,
        extension
    );
    let filename = sanitize_attachment_filename(file_name.as_deref().unwrap_or(&fallback_name));

    Ok(HttpResponse::Ok()
        .append_header(("Content-Type", content_type))
        .append_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
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

    let asset_id =
        meta_send_asset_id(meta_scope.external_account_id.as_deref()).ok_or_else(|| {
            AppError::BadRequest("Connected Meta channel is missing a target asset".to_string())
        })?;

    let reply_target = if let Some(reply_to_message_id) = input
        .reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(
            sqlx::query_as::<_, InboxMessageRow>(
                r#"
                SELECT id, "conversationId" AS conversation_id, sender, content,
                       "whatsappMessageId" AS whatsapp_message_id,
                       "whatsappStatus" AS whatsapp_status,
                       "providerMessageId" AS provider_message_id,
                       "providerStatus" AS provider_status,
                       "errorCode" AS error_code,
                       "errorMessage" AS error_message,
                       timestamp AT TIME ZONE 'UTC' AS timestamp
                FROM "Message"
                WHERE id = $1 AND "conversationId" = $2
                LIMIT 1
                "#,
            )
            .bind(reply_to_message_id)
            .bind(&meta_scope.id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Reply target not found".to_string()))?,
        )
    } else {
        None
    };
    let reply_to_provider_message_id = reply_target
        .as_ref()
        .and_then(|target| target.provider_message_id.as_deref())
        .map(str::to_string);
    if reply_target.is_some() && reply_to_provider_message_id.is_none() {
        return Err(AppError::BadRequest(
            "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
        ));
    }
    let message_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Message" (
            id, "conversationId", sender, content, "contentType",
            "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'PROCESSING', $4, NOW())
        "#,
    )
    .bind(&message_id)
    .bind(&meta_scope.id)
    .bind(text)
    .bind(json!({
        "provider": meta_scope.channel,
        "channelConnectionId": meta_scope.channel_connection_id,
        "replyToMessageId": input.reply_to_message_id,
    }))
    .execute(pool)
    .await?;
    if let Some(target) = reply_target.as_ref() {
        message_domain::create_reference(
            pool,
            &message_id,
            &target.id,
            reply_to_provider_message_id.as_deref(),
            Some(&preview_text(&target.content, 180)),
            Some("TEXT"),
        )
        .await?;
    }

    let uses_instagram_login = meta_scope
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let graph_base = if uses_instagram_login {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };
    let mut message_payload = json!({ "text": text });
    if let Some(reply_to_provider_message_id) = reply_to_provider_message_id.as_deref() {
        message_payload["reply_to"] = json!({ "mid": reply_to_provider_message_id });
    }
    let request_body = if uses_instagram_login {
        json!({
            "recipient": { "id": customer_id },
            "message": message_payload,
        })
    } else {
        json!({
            "recipient": { "id": customer_id },
            "messaging_type": "RESPONSE",
            "message": message_payload,
        })
    };

    let response: MetaSendMessageResponse = match fetch_meta_json(
        reqwest::Client::new()
            .post(format!("{graph_base}/{asset_id}/messages"))
            .bearer_auth(access_token)
            .json(&request_body),
        "Failed to send Meta message",
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            let error_message = error.to_string();
            sqlx::query(
                r#"
                UPDATE "Message"
                SET "providerStatus" = 'FAILED',
                    "errorCode" = 'META_SEND_FAILED',
                    "errorMessage" = $1
                WHERE id = $2
                "#,
            )
            .bind(&error_message)
            .bind(&message_id)
            .execute(pool)
            .await?;
            publish_message_updated(pool, &message_id).await?;
            return Err(error);
        }
    };

    sqlx::query(
        r#"
        UPDATE "Message"
        SET "providerMessageId" = $1,
            "providerStatus" = 'SENT',
            "errorCode" = NULL,
            "errorMessage" = NULL
        WHERE id = $2
        "#,
    )
    .bind(response.message_id.as_deref())
    .bind(&message_id)
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

    // Publish the first client-visible event only after Meta accepted the
    // message. This avoids a PROCESSING event racing the optimistic UI and a
    // later SENT event.
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
    if std::env::var("META_WEBHOOK_LOG_PAYLOADS")
        .ok()
        .is_some_and(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
    {
        log::info!("[meta-webhook] payload={payload}");
    }
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
        let entry_asset_id = entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let messaging_events = entry
            .get("messaging")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        for event in messaging_events {
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

            let asset_id = entry_asset_id.as_deref().unwrap_or(&recipient_id);
            if asset_id.is_empty() {
                continue;
            }

            let channel = resolve_meta_channel(pool, &object, asset_id).await?;
            let Some(channel) = channel else {
                log::warn!(
                    "ignoring Meta webhook with unresolved or ambiguous asset object={} asset_id={}",
                    object,
                    asset_id
                );
                continue;
            };
            let event_kind = if event.get("message").is_some() {
                "message"
            } else if event.get("reaction").is_some() {
                "reaction"
            } else if event.get("delivery").is_some() {
                "delivery"
            } else if event.get("read").is_some() {
                "read"
            } else {
                "unsupported"
            };
            log::info!(
                "[meta-webhook] event={} object={} channel_id={} asset_id={} sender_id={} recipient_id={}",
                event_kind,
                object,
                channel.id,
                asset_id,
                sender_id,
                recipient_id
            );

            if let Some(delivery) = event.get("delivery") {
                apply_meta_delivery_event(pool, &channel, &sender_id, delivery).await?;
                continue;
            }
            if let Some(read) = event.get("read") {
                apply_meta_read_event(pool, &channel, &sender_id, read).await?;
                continue;
            }
            if let Some(reaction) = event.get("reaction") {
                apply_meta_reaction_event(pool, &channel, &sender_id, reaction).await?;
                continue;
            }

            let message = match event.get("message") {
                Some(value) => value,
                None => continue,
            };
            let is_echo = meta_message_is_echo(message);
            let customer_id = if is_echo {
                recipient_id.as_str()
            } else {
                sender_id.as_str()
            };
            if customer_id.is_empty() {
                continue;
            }

            let content = meta_message_text(message);
            let attachments = meta_message_attachments(message);
            if content.is_empty() && attachments.is_empty() {
                continue;
            }

            let message_mid = message
                .get("mid")
                .and_then(|value| value.as_str())
                .map(str::to_string);

            let customer_name = resolve_meta_customer_name(pool, &channel, customer_id).await?;
            let (conversation_id, _) = find_or_create_meta_conversation(
                pool,
                &channel,
                customer_id,
                customer_name.as_deref(),
            )
            .await?;

            let reply_target =
                if let Some(reply_to_provider_message_id) = meta_reply_to_mid(message) {
                    if let Some(reply_target) = sqlx::query_as::<_, InboxMessageRow>(
                        r#"
                    SELECT id, "conversationId" AS conversation_id, sender, content,
                           "whatsappMessageId" AS whatsapp_message_id,
                           "whatsappStatus" AS whatsapp_status,
                           "providerMessageId" AS provider_message_id,
                           "providerStatus" AS provider_status,
                           "errorCode" AS error_code,
                           "errorMessage" AS error_message,
                           timestamp AT TIME ZONE 'UTC' AS timestamp
                    FROM "Message"
                    WHERE "conversationId" = $1 AND "providerMessageId" = $2
                    LIMIT 1
                    "#,
                    )
                    .bind(&conversation_id)
                    .bind(reply_to_provider_message_id)
                    .fetch_optional(pool)
                    .await?
                    {
                        Some((reply_target, reply_to_provider_message_id))
                    } else {
                        None
                    }
                } else {
                    None
                };

            let message_id = cuid2::create_id();
            let message_sender = if is_echo { "bot" } else { "customer" };
            let provider_status = if is_echo { "SENT" } else { "RECEIVED" };
            let inserted = sqlx::query_scalar::<_, String>(
                r#"
                INSERT INTO "Message" (
                    id, "conversationId", sender, content, "contentType",
                    "providerMessageId", "providerStatus", "providerMetadata", timestamp
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT ("conversationId", "providerMessageId") DO NOTHING
                RETURNING id
                "#,
            )
            .bind(&message_id)
            .bind(&conversation_id)
            .bind(message_sender)
            .bind(&content)
            .bind(if attachments.is_empty() {
                "TEXT"
            } else {
                "MEDIA"
            })
            .bind(message_mid.as_deref())
            .bind(provider_status)
            .bind(json!({
                "provider": channel.platform.to_lowercase(),
                "object": object,
                "isEcho": is_echo,
                "event": event,
            }))
            .fetch_optional(pool)
            .await?;

            if inserted.is_none() {
                continue;
            }
            for attachment in &attachments {
                message_domain::create_attachment(
                    pool,
                    &message_id,
                    attachment.provider_media_id.as_deref(),
                    &attachment.kind,
                    attachment.mime_type.as_deref(),
                    attachment.file_name.as_deref(),
                    None,
                    attachment.metadata.clone(),
                )
                .await?;
            }
            if let Some((target, provider_message_id)) = reply_target {
                message_domain::create_reference(
                    pool,
                    &message_id,
                    &target.id,
                    Some(&provider_message_id),
                    Some(&preview_text(&target.content, 180)),
                    Some("TEXT"),
                )
                .await?;
            }

            sqlx::query(
                r#"
                UPDATE "Conversation"
                SET "lastMessageAt" = NOW(), status = 'active',
                    "unreadCount" = "unreadCount" + $2, "updatedAt" = NOW()
                WHERE id = $1
                "#,
            )
            .bind(&conversation_id)
            .bind(if is_echo { 0 } else { 1 })
            .execute(pool)
            .await?;

            publish_message_created(pool, &channel.user_id, &message_id).await?;
            publish_conversation_updated(pool, &channel.user_id, &conversation_id).await?;

            if is_echo {
                continue;
            }

            let title = if channel.platform == "INSTAGRAM" {
                "New Instagram message"
            } else {
                "New Facebook message"
            };
            let sender_label = customer_name.as_deref().unwrap_or(&sender_id);
            let body = format!("{}: {}", sender_label, preview_text(&content, 120));
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
         AND scc.status = 'CONNECTED'::"SocialChannelStatus"
        JOIN "ExternalConnection" connection
          ON connection.id = c."externalConnectionId"
         AND connection."orgId" = $2
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
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
            channel.id,
            connection.id AS external_connection_id,
            channel."userId" AS user_id,
            channel."orgId" AS org_id,
            channel.platform::text AS platform,
            channel."displayName" AS display_name,
            channel."externalAccountId" AS external_account_id,
            channel."accessToken" AS access_token,
            channel.metadata
        FROM "SocialChannelConnection" channel
        JOIN "ExternalConnection" connection
          ON connection."orgId" = channel."orgId"
         AND connection."sourceType" = 'SOCIAL'
         AND connection."sourceId" = channel.id
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
        WHERE channel.platform = $1::"SocialPlatform"
          AND channel."externalAccountId" = $2
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
          AND channel."orgId" IS NOT NULL
        LIMIT 2
        "#,
    )
    .bind(primary_platform)
    .bind(recipient_id)
    .fetch_all(pool)
    .await?;
    if direct.len() == 1 {
        return Ok(direct.into_iter().next());
    }
    if direct.len() > 1 {
        return Ok(None);
    }

    let fallback = sqlx::query_as::<_, MetaChannelRow>(
        r#"
        SELECT
            channel.id,
            connection.id AS external_connection_id,
            channel."userId" AS user_id,
            channel."orgId" AS org_id,
            channel.platform::text AS platform,
            channel."displayName" AS display_name,
            channel."externalAccountId" AS external_account_id,
            channel."accessToken" AS access_token,
            channel.metadata
        FROM "SocialChannelConnection" channel
        JOIN "ExternalConnection" connection
          ON connection."orgId" = channel."orgId"
         AND connection."sourceType" = 'SOCIAL'
         AND connection."sourceId" = channel.id
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
        WHERE channel.platform = 'INSTAGRAM'::"SocialPlatform"
          AND COALESCE(channel.metadata->>'pageId', '') = $1
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
          AND channel."orgId" IS NOT NULL
        LIMIT 2
        "#,
    )
    .bind(recipient_id)
    .fetch_all(pool)
    .await?;
    if fallback.len() == 1 {
        Ok(fallback.into_iter().next())
    } else {
        Ok(None)
    }
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
    let canonical_customer_id = match channel.org_id.as_deref() {
        Some(org_id) => Some(
            customers::ensure_meta_customer(
                pool,
                org_id,
                channel_name,
                &channel.id,
                customer_id,
                customer_name,
            )
            .await?,
        ),
        None => None,
    };

    let id = cuid2::create_id();
    sqlx::query_as::<_, (String, i32)>(
        r#"
        INSERT INTO "Conversation" (
            id, channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "orgId", "externalConnectionId", "customerId",
            "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, 'active', NOW(), 0, $5,
            $6,
            $7, NOW(), NOW()
        )
        ON CONFLICT (channel, "customerIdentifier") DO UPDATE SET
            "customerName" = COALESCE(EXCLUDED."customerName", "Conversation"."customerName"),
            "customerId" = COALESCE("Conversation"."customerId", EXCLUDED."customerId"),
            "externalConnectionId" = COALESCE(
                "Conversation"."externalConnectionId",
                EXCLUDED."externalConnectionId"
            ),
            "updatedAt" = NOW()
        WHERE "Conversation"."orgId" = EXCLUDED."orgId"
        RETURNING id, "unreadCount"
        "#,
    )
    .bind(&id)
    .bind(channel_name)
    .bind(&identifier)
    .bind(customer_name)
    .bind(channel.org_id.as_deref())
    .bind(&channel.external_connection_id)
    .bind(canonical_customer_id.as_deref())
    .fetch_one(pool)
    .await
    .map_err(AppError::from)
}

async fn resolve_meta_customer_name(
    pool: &PgPool,
    channel: &MetaChannelRow,
    customer_id: &str,
) -> Result<Option<String>, AppError> {
    let identifier = build_meta_conversation_identifier(&channel.id, customer_id);
    let existing_name = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT "customerName"
        FROM "Conversation"
        WHERE channel = $1
          AND "customerIdentifier" = $2
          AND "orgId" = $3
        LIMIT 1
        "#,
    )
    .bind(if channel.platform == "INSTAGRAM" {
        "instagram"
    } else {
        "facebook"
    })
    .bind(&identifier)
    .bind(channel.org_id.as_deref())
    .fetch_optional(pool)
    .await?
    .flatten()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    if existing_name.is_some() {
        return Ok(existing_name);
    }

    let Some(encrypted_access_token) = channel.access_token.as_deref() else {
        return Ok(None);
    };
    let access_token = match social::decrypt_social_secret(encrypted_access_token) {
        Ok(token) => token,
        Err(error) => {
            log::warn!(
                "failed to decrypt Meta channel token while resolving sender profile channel_id={}: {}",
                channel.id,
                error
            );
            return Ok(None);
        }
    };

    let uses_instagram_login = channel
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let (graph_base, fields) = if uses_instagram_login {
        (INSTAGRAM_GRAPH_BASE, "name,username,profile_picture_url")
    } else if channel.platform == "INSTAGRAM" {
        (META_GRAPH_BASE, "name,username,profile_pic")
    } else {
        (META_GRAPH_BASE, "first_name,last_name,profile_pic")
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("failed to create Meta profile client: {error}");
            return Ok(None);
        }
    };
    let response = client
        .get(format!("{graph_base}/{customer_id}"))
        .query(&[("fields", fields)])
        .bearer_auth(access_token)
        .send()
        .await;
    let response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            log::warn!(
                "Meta sender profile lookup failed channel_id={} customer_id={} status={}",
                channel.id,
                customer_id,
                response.status()
            );
            return Ok(None);
        }
        Err(error) => {
            log::warn!(
                "Meta sender profile lookup failed channel_id={} customer_id={}: {}",
                channel.id,
                customer_id,
                error
            );
            return Ok(None);
        }
    };
    let profile = match response.json::<Value>().await {
        Ok(profile) => profile,
        Err(error) => {
            log::warn!(
                "failed to decode Meta sender profile channel_id={} customer_id={}: {}",
                channel.id,
                customer_id,
                error
            );
            return Ok(None);
        }
    };

    Ok(meta_profile_display_name(&profile))
}

async fn apply_meta_delivery_event(
    pool: &PgPool,
    channel: &MetaChannelRow,
    customer_id: &str,
    delivery: &Value,
) -> Result<(), AppError> {
    let Some(org_id) = channel.org_id.as_deref() else {
        return Ok(());
    };
    let message_ids = meta_delivery_message_ids(delivery);
    let watermark = meta_receipt_watermark(delivery);
    if message_ids.is_empty() && watermark.is_none() {
        return Ok(());
    }

    let mut updated_ids = std::collections::HashSet::new();
    if !message_ids.is_empty() {
        updated_ids.extend(
            sqlx::query_scalar::<_, String>(
                r#"
                UPDATE "Message" message
                SET "providerStatus" = 'DELIVERED', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation
                WHERE message."conversationId" = conversation.id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND message."providerMessageId" = ANY($3)
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED', 'DELIVERED')
                RETURNING message.id
                "#,
            )
            .bind(org_id)
            .bind(&channel.external_connection_id)
            .bind(&message_ids)
            .fetch_all(pool)
            .await?,
        );
    }

    if let Some(watermark) = watermark.filter(|_| !customer_id.is_empty()) {
        let channel_name = if channel.platform == "INSTAGRAM" {
            "instagram"
        } else {
            "facebook"
        };
        let identifier = build_meta_conversation_identifier(&channel.id, customer_id);
        updated_ids.extend(
            sqlx::query_scalar::<_, String>(
                r#"
                UPDATE "Message" message
                SET "providerStatus" = 'DELIVERED', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation
                WHERE message."conversationId" = conversation.id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND conversation.channel = $3
                  AND conversation."customerIdentifier" = $4
                  AND message.sender = 'bot'
                  AND message.timestamp <= to_timestamp($5::double precision / 1000.0)
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED', 'DELIVERED')
                RETURNING message.id
                "#,
            )
            .bind(org_id)
            .bind(&channel.external_connection_id)
            .bind(channel_name)
            .bind(identifier)
            .bind(watermark)
            .fetch_all(pool)
            .await?,
        );
    }

    for message_id in updated_ids {
        publish_message_updated(pool, &message_id).await?;
    }

    let known_message_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT message."providerMessageId"
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation."externalConnectionId" = $2
          AND message."providerMessageId" = ANY($3)
        "#,
    )
    .bind(org_id)
    .bind(&channel.external_connection_id)
    .bind(&message_ids)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect::<std::collections::HashSet<_>>();

    if channel.platform == "FACEBOOK" && !customer_id.is_empty() {
        for provider_message_id in message_ids
            .iter()
            .filter(|message_id| !known_message_ids.contains(*message_id))
        {
            if let Err(error) =
                sync_missing_meta_outbound_message(pool, channel, customer_id, provider_message_id)
                    .await
            {
                log::warn!(
                    "failed to sync missing Meta outbound message channel_id={} customer_id={} provider_message_id={}: {}",
                    channel.id,
                    customer_id,
                    provider_message_id,
                    error
                );
            }
        }
    }
    Ok(())
}

async fn sync_missing_meta_outbound_message(
    pool: &PgPool,
    channel: &MetaChannelRow,
    customer_id: &str,
    provider_message_id: &str,
) -> Result<(), AppError> {
    let encrypted_access_token = channel.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Connected Meta Page is missing an access token".to_string())
    })?;
    let access_token = social::decrypt_social_secret(encrypted_access_token)?;
    let graph_message: Value = fetch_meta_json(
        reqwest::Client::new()
            .get(format!("{META_GRAPH_BASE}/{provider_message_id}"))
            .query(&[("fields", "id,message,from,to,created_time,attachments")])
            .bearer_auth(access_token),
        "Failed to load outbound Meta message",
    )
    .await?;

    if let (Some(expected_page_id), Some(actual_sender_id)) = (
        channel.external_account_id.as_deref(),
        graph_message
            .get("from")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str),
    ) {
        if expected_page_id != actual_sender_id {
            return Ok(());
        }
    }

    let content = meta_graph_message_content(&graph_message);
    let attachments = meta_graph_message_attachments(&graph_message);
    if content.is_empty() && attachments.is_empty() {
        return Ok(());
    }
    let customer_name = meta_graph_message_recipient_name(&graph_message, customer_id)
        .or(resolve_meta_customer_name(pool, channel, customer_id).await?);
    let (conversation_id, _) =
        find_or_create_meta_conversation(pool, channel, customer_id, customer_name.as_deref())
            .await?;
    let timestamp = graph_message
        .get("created_time")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let message_id = cuid2::create_id();
    let inserted = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "Message" (
            id, "conversationId", sender, content, "contentType",
            "providerMessageId", "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, $4, $5, 'DELIVERED', $6, $7)
        ON CONFLICT ("conversationId", "providerMessageId") DO NOTHING
        RETURNING id
        "#,
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&content)
    .bind(if attachments.is_empty() {
        "TEXT"
    } else {
        "MEDIA"
    })
    .bind(provider_message_id)
    .bind(json!({
        "provider": "facebook",
        "source": "delivery_backfill",
        "graphMessage": graph_message,
    }))
    .bind(timestamp)
    .fetch_optional(pool)
    .await?;
    let Some(message_id) = inserted else {
        return Ok(());
    };
    for attachment in &attachments {
        message_domain::create_attachment(
            pool,
            &message_id,
            attachment.provider_media_id.as_deref(),
            &attachment.kind,
            attachment.mime_type.as_deref(),
            attachment.file_name.as_deref(),
            None,
            attachment.metadata.clone(),
        )
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", $2),
            status = 'active',
            "updatedAt" = NOW()
        WHERE id = $1
        "#,
    )
    .bind(&conversation_id)
    .bind(timestamp)
    .execute(pool)
    .await?;
    publish_message_created(pool, &channel.user_id, &message_id).await?;
    publish_conversation_updated(pool, &channel.user_id, &conversation_id).await?;
    Ok(())
}

async fn apply_meta_read_event(
    pool: &PgPool,
    channel: &MetaChannelRow,
    customer_id: &str,
    read: &Value,
) -> Result<(), AppError> {
    let Some(org_id) = channel.org_id.as_deref() else {
        return Ok(());
    };
    let Some(watermark) = meta_receipt_watermark(read) else {
        return Ok(());
    };
    if customer_id.is_empty() {
        return Ok(());
    }
    let channel_name = if channel.platform == "INSTAGRAM" {
        "instagram"
    } else {
        "facebook"
    };
    let identifier = build_meta_conversation_identifier(&channel.id, customer_id);
    let updated_ids = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "Message" message
        SET "providerStatus" = 'READ', "errorCode" = NULL, "errorMessage" = NULL
        FROM "Conversation" conversation
        WHERE message."conversationId" = conversation.id
          AND conversation."orgId" = $1
          AND conversation."externalConnectionId" = $2
          AND conversation.channel = $3
          AND conversation."customerIdentifier" = $4
          AND message.sender = 'bot'
          AND message.timestamp <= to_timestamp($5::double precision / 1000.0)
          AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED')
        RETURNING message.id
        "#,
    )
    .bind(org_id)
    .bind(&channel.external_connection_id)
    .bind(channel_name)
    .bind(identifier)
    .bind(watermark)
    .fetch_all(pool)
    .await?;
    for message_id in updated_ids {
        publish_message_updated(pool, &message_id).await?;
    }
    Ok(())
}

async fn apply_meta_reaction_event(
    pool: &PgPool,
    channel: &MetaChannelRow,
    actor_identifier: &str,
    reaction: &Value,
) -> Result<(), AppError> {
    let Some(org_id) = channel.org_id.as_deref() else {
        return Ok(());
    };
    let target_provider_message_id = reaction
        .get("mid")
        .or_else(|| reaction.get("message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Meta reaction is missing a message ID".to_string()))?;
    let actor_identifier = actor_identifier.trim();
    if actor_identifier.is_empty() {
        return Ok(());
    }
    let action = reaction
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("react")
        .trim()
        .to_ascii_lowercase();
    let active = action != "unreact" && action != "remove";
    let emoji = reaction
        .get("reaction")
        .or_else(|| reaction.get("emoji"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let channel_name = if channel.platform == "INSTAGRAM" {
        "instagram"
    } else {
        "facebook"
    };

    let target = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT message.id, message."conversationId"
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation."externalConnectionId" = $2
          AND conversation.channel = $3
          AND message."providerMessageId" = $4
        ORDER BY message.timestamp DESC
        LIMIT 1
        "#,
    )
    .bind(org_id)
    .bind(&channel.external_connection_id)
    .bind(channel_name)
    .bind(target_provider_message_id)
    .fetch_optional(pool)
    .await?;
    let Some((message_id, conversation_id)) = target else {
        log::info!(
            "[meta-webhook] reaction target not found channel_id={} provider_message_id={}",
            channel.id,
            target_provider_message_id
        );
        return Ok(());
    };

    let event_id = reaction
        .get("id")
        .or_else(|| reaction.get("event_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "meta:reaction:{}:{}:{}:{}",
                target_provider_message_id,
                actor_identifier,
                action,
                reaction
                    .get("timestamp")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
            )
        });
    message_domain::upsert_reaction(
        pool,
        &message_id,
        actor_identifier,
        if active { emoji } else { None },
        active,
        Some(&event_id),
        json!({ "provider": "meta", "payload": reaction }),
    )
    .await?;
    message_domain::record_event(
        pool,
        &conversation_id,
        Some(&message_id),
        Some(&event_id),
        if active {
            "REACTION_ADDED"
        } else {
            "REACTION_REMOVED"
        },
        json!({ "provider": "meta", "actor": actor_identifier, "emoji": emoji, "action": action }),
    )
    .await?;
    publish_message_reactions_updated(pool, &conversation_id, &message_id).await
}

async fn publish_message_reactions_updated(
    pool: &PgPool,
    conversation_id: &str,
    message_id: &str,
) -> Result<(), AppError> {
    let Some(org_id) = conversation_org_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let reactions = message_domain::list_active_reactions(pool, message_id).await?;
    publish_event_best_effort(
        &org_id,
        json!({
            "type": "message.reactions_updated",
            "conversationId": conversation_id,
            "message": { "id": message_id, "reactions": reactions },
        }),
    )
    .await;
    Ok(())
}

async fn publish_message_updated(pool: &PgPool, message_id: &str) -> Result<(), AppError> {
    let Some(message) = sqlx::query_as::<_, InboxMessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content,
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
    let Some(org_id) = conversation_org_id(pool, &message.conversation_id).await? else {
        return Ok(());
    };
    if let Some(status) = message.provider_status.as_deref() {
        message_domain::record_event(
            pool,
            &message.conversation_id,
            Some(&message.id),
            message
                .provider_message_id
                .as_deref()
                .map(|provider_id| format!("meta:status:{provider_id}:{status}"))
                .as_deref(),
            &format!("STATUS_{status}"),
            json!({ "provider": "meta", "status": status }),
        )
        .await?;
    }

    publish_event_best_effort(
        &org_id,
        json!({
            "type": "message.updated",
            "conversationId": message.conversation_id,
            "message": {
                "id": message.id,
                "providerStatus": message.provider_status,
                "providerMessageId": message.provider_message_id,
                "errorCode": message.error_code,
                "errorMessage": message.error_message,
            }
        }),
    )
    .await;
    Ok(())
}

async fn publish_conversation_updated(
    pool: &PgPool,
    _user_id: &str,
    conversation_id: &str,
) -> Result<(), AppError> {
    let Some(conversation) = load_conversation_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let Some(org_id) = conversation_org_id(pool, &conversation.id).await? else {
        return Ok(());
    };
    let (connection_id, connection_label, handle) =
        conversation_channel_context(pool, &conversation).await?;

    publish_event_best_effort(
        &org_id,
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
    _user_id: &str,
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

    let Some(conversation) = load_conversation_by_id(pool, &message.conversation_id).await? else {
        return Ok(());
    };
    let Some(org_id) = conversation_org_id(pool, &conversation.id).await? else {
        return Ok(());
    };
    let message = message_domain::list_timeline_messages(pool, &conversation.id)
        .await?
        .into_iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(message_id));
    let Some(message) = message else {
        return Ok(());
    };
    let (connection_id, connection_label, handle) =
        conversation_channel_context(pool, &conversation).await?;

    publish_event_best_effort(
        &org_id,
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
            "message": message,
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

async fn conversation_org_id(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Option<String>, AppError> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT "orgId" FROM "Conversation" WHERE id = $1 AND "orgId" IS NOT NULL"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn load_conversation_by_id(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Option<ConversationRow>, AppError> {
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,
               status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
               starred,
               "unreadCount" AS unread_count,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation"
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn publish_event_best_effort(org_id: &str, event: Value) {
    if let Err(error) = realtime::publish_inbox_event(org_id, &event).await {
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

fn sanitize_attachment_filename(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "attachment.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_attachment_kind(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "image" | "image_share" => "image",
        "video" | "video_share" => "video",
        "audio" => "audio",
        "sticker" => "sticker",
        "file" | "document" | "fallback" => "document",
        _ => "file",
    }
}

struct MetaIncomingAttachment {
    kind: String,
    provider_media_id: Option<String>,
    mime_type: Option<String>,
    file_name: Option<String>,
    metadata: Value,
}

fn meta_message_text(message: &Value) -> String {
    if let Some(text) = message.get("text").and_then(|value| value.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    String::new()
}

fn meta_message_attachments(message: &Value) -> Vec<MetaIncomingAttachment> {
    let mut attachments: Vec<_> = message
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|attachment| {
            let payload = attachment.get("payload").cloned().unwrap_or(Value::Null);
            let is_sticker = payload.get("sticker_id").is_some()
                || attachment
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("sticker"));
            MetaIncomingAttachment {
                kind: if is_sticker {
                    "sticker"
                } else {
                    normalize_attachment_kind(
                        attachment
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("attachment"),
                    )
                }
                .to_string(),
                provider_media_id: payload
                    .get("id")
                    .or_else(|| attachment.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                mime_type: payload
                    .get("mime_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                file_name: payload
                    .get("name")
                    .or_else(|| payload.get("filename"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata: json!({ "providerPayload": payload }),
            }
        })
        .collect();

    // Messenger may emit an `image` representation and a `sticker`
    // representation for the same sticker in one webhook. Keep the sticker
    // variant only, otherwise the customer sees the same sticker twice.
    let sticker_urls: HashSet<String> = attachments
        .iter()
        .filter(|attachment| attachment.kind == "sticker")
        .filter_map(|attachment| {
            attachment
                .metadata
                .pointer("/providerPayload/url")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let mut retained_sticker_urls = HashSet::new();
    attachments.retain(|attachment| {
        if attachment.kind == "sticker" {
            return attachment
                .metadata
                .pointer("/providerPayload/url")
                .and_then(Value::as_str)
                .map(|url| retained_sticker_urls.insert(url.to_string()))
                .unwrap_or(true);
        }
        let attachment_url = attachment
            .metadata
            .pointer("/providerPayload/url")
            .and_then(Value::as_str);
        attachment_url.is_none_or(|url| !sticker_urls.contains(url))
    });
    attachments
}

fn meta_message_is_echo(message: &Value) -> bool {
    message
        .get("is_echo")
        .or_else(|| message.get("is_self"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn meta_reply_to_mid(message: &Value) -> Option<&str> {
    message
        .get("reply_to")
        .and_then(|value| value.get("mid"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn meta_delivery_message_ids(delivery: &Value) -> Vec<String> {
    delivery
        .get("mids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn meta_receipt_watermark(receipt: &Value) -> Option<i64> {
    receipt.get("watermark").and_then(Value::as_i64)
}

fn meta_graph_message_content(message: &Value) -> String {
    if let Some(text) = message
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return text.to_string();
    }

    String::new()
}

fn meta_graph_message_attachments(message: &Value) -> Vec<MetaIncomingAttachment> {
    message
        .get("attachments")
        .and_then(|value| value.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|attachment| MetaIncomingAttachment {
            kind: if attachment.get("render_as_sticker").and_then(Value::as_bool) == Some(true)
                || attachment.get("sticker_id").is_some()
            {
                "sticker"
            } else {
                normalize_attachment_kind(
                    attachment
                        .get("mime_type")
                        .and_then(Value::as_str)
                        .and_then(|mime_type| mime_type.split('/').next())
                        .unwrap_or("attachment"),
                )
            }
            .to_string(),
            provider_media_id: attachment
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string),
            mime_type: attachment
                .get("mime_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            file_name: attachment
                .get("name")
                .or_else(|| attachment.get("filename"))
                .and_then(Value::as_str)
                .map(str::to_string),
            metadata: json!({ "providerPayload": attachment }),
        })
        .collect()
}

fn meta_graph_message_recipient_name(message: &Value, customer_id: &str) -> Option<String> {
    message
        .get("to")
        .and_then(|value| value.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|recipient| recipient.get("id").and_then(Value::as_str) == Some(customer_id))
        .and_then(|recipient| recipient.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn meta_profile_display_name(profile: &Value) -> Option<String> {
    let direct_name = profile
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(name) = direct_name {
        return Some(name.to_string());
    }

    let full_name = [
        profile
            .get("first_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        profile
            .get("last_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if !full_name.is_empty() {
        return Some(full_name);
    }

    profile
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|username| format!("@{username}"))
}

fn meta_send_asset_id(external_account_id: Option<&str>) -> Option<String> {
    external_account_id.map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::{
        build_meta_conversation_identifier, meta_delivery_message_ids,
        meta_graph_message_attachments, meta_graph_message_content,
        meta_graph_message_recipient_name, meta_message_attachments, meta_message_is_echo,
        meta_profile_display_name, meta_receipt_watermark, meta_reply_to_mid, meta_send_asset_id,
        normalize_attachment_kind, parse_meta_conversation_identifier,
        sanitize_attachment_filename, scoped_conversation, verify_meta_signature, HmacSha256,
    };
    use hmac::Mac;
    use serde_json::json;

    #[test]
    fn meta_webhook_signature_must_match_the_raw_body() {
        let secret = "test-app-secret";
        let body = br#"{"object":"page","entry":[]}"#;
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("valid secret");
        mac.update(body);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_meta_signature(secret, Some(&signature), body).is_ok());
        assert!(verify_meta_signature(secret, Some(&signature), b"modified").is_err());
        assert!(verify_meta_signature(secret, None, body).is_err());
    }

    #[test]
    fn meta_profile_name_prefers_name_then_full_name_then_username() {
        assert_eq!(
            meta_profile_display_name(&json!({
                "name": "Ada Lovelace",
                "username": "ada"
            }))
            .as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(
            meta_profile_display_name(&json!({
                "first_name": "Grace",
                "last_name": "Hopper"
            }))
            .as_deref(),
            Some("Grace Hopper")
        );
        assert_eq!(
            meta_profile_display_name(&json!({ "username": "enoch" })).as_deref(),
            Some("@enoch")
        );
        assert_eq!(meta_profile_display_name(&json!({})), None);
    }

    #[test]
    fn meta_echo_and_self_messages_are_outbound() {
        assert!(meta_message_is_echo(&json!({ "is_echo": true })));
        assert!(meta_message_is_echo(&json!({ "is_self": true })));
        assert!(!meta_message_is_echo(&json!({ "text": "Hello" })));
    }

    #[test]
    fn meta_message_reply_context_uses_the_referenced_provider_message_id() {
        assert_eq!(
            meta_reply_to_mid(&json!({ "reply_to": { "mid": "mid.original" } })),
            Some("mid.original")
        );
        assert_eq!(
            meta_reply_to_mid(&json!({ "reply_to": { "mid": "   " } })),
            None
        );
        assert_eq!(meta_reply_to_mid(&json!({ "text": "No context" })), None);
    }

    #[test]
    fn graph_message_data_can_backfill_outbound_replies() {
        let message = json!({
            "message": "Reply from Business Suite",
            "to": {
                "data": [
                    { "id": "customer-1", "name": "Enoch Chirima" }
                ]
            }
        });
        assert_eq!(
            meta_graph_message_content(&message),
            "Reply from Business Suite"
        );
        assert_eq!(
            meta_graph_message_recipient_name(&message, "customer-1").as_deref(),
            Some("Enoch Chirima")
        );
        assert_eq!(
            meta_graph_message_recipient_name(&message, "other-customer"),
            None
        );
    }

    #[test]
    fn meta_delivery_receipts_support_message_ids_and_watermarks() {
        let receipt = json!({
            "mids": ["message-1", "message-2"],
            "watermark": 1_785_260_850_379_i64
        });
        assert_eq!(
            meta_delivery_message_ids(&receipt),
            vec!["message-1".to_string(), "message-2".to_string()]
        );
        assert_eq!(
            meta_receipt_watermark(&receipt),
            Some(1_785_260_850_379_i64)
        );

        let watermark_only = json!({ "watermark": 1_785_260_850_400_i64 });
        assert!(meta_delivery_message_ids(&watermark_only).is_empty());
        assert_eq!(
            meta_receipt_watermark(&watermark_only),
            Some(1_785_260_850_400_i64)
        );
    }

    #[test]
    fn meta_conversation_identifiers_keep_connection_and_customer_scope() {
        let identifier = build_meta_conversation_identifier("social_123", "customer:456");
        assert_eq!(
            parse_meta_conversation_identifier(&identifier),
            Some(("social_123".to_string(), "customer:456".to_string()))
        );
        assert_eq!(parse_meta_conversation_identifier("customer:456"), None);
    }

    #[test]
    fn inbound_attachments_are_structured() {
        let attachments = meta_message_attachments(&json!({
            "attachments": [{
                "type": "image",
                "payload": { "id": "media-123", "mime_type": "image/jpeg" }
            }]
        }));
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "image");
        assert_eq!(
            attachments[0].provider_media_id.as_deref(),
            Some("media-123")
        );
    }

    #[test]
    fn messenger_duplicate_image_and_sticker_payloads_keep_the_sticker() {
        let attachments = meta_message_attachments(&json!({
            "attachments": [
                {
                    "type": "image",
                    "payload": { "url": "https://scontent.xx.fbcdn.net/sticker.png", "sticker_id": 42 }
                },
                {
                    "type": "sticker",
                    "payload": { "url": "https://scontent.xx.fbcdn.net/sticker.png", "sticker_id": 42 }
                }
            ]
        }));
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "sticker");
    }

    #[test]
    fn graph_stickers_keep_image_data_for_media_retrieval() {
        let attachments = meta_graph_message_attachments(&json!({
            "attachments": {
                "data": [{
                    "id": "sticker_42",
                    "mime_type": "image/png",
                    "render_as_sticker": true,
                    "image_data": { "url": "https://scontent.xx.fbcdn.net/sticker.png" }
                }]
            }
        }));
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "sticker");
        assert_eq!(
            attachments[0]
                .metadata
                .pointer("/providerPayload/image_data/url"),
            Some(&json!("https://scontent.xx.fbcdn.net/sticker.png"))
        );
    }

    #[test]
    fn attachment_kinds_are_normalized_for_the_client_contract() {
        assert_eq!(normalize_attachment_kind("image_share"), "image");
        assert_eq!(normalize_attachment_kind("application"), "file");
        assert_eq!(normalize_attachment_kind("document"), "document");
    }

    #[test]
    fn attachment_filenames_are_safe_for_content_disposition() {
        assert_eq!(sanitize_attachment_filename("proof\".pdf"), "proof_.pdf");
        assert_eq!(sanitize_attachment_filename(""), "attachment.bin");
    }

    #[test]
    fn instagram_replies_target_the_connected_instagram_account() {
        assert_eq!(
            meta_send_asset_id(Some("instagram-account-id")),
            Some("instagram-account-id".to_string())
        );
    }

    #[tokio::test]
    #[ignore = "requires a seeded PostgreSQL database"]
    async fn conversation_reads_are_isolated_by_organization() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("database connection failed");

        assert!(
            scoped_conversation(&pool, "org_meta_a", "conversation_meta_a")
                .await
                .expect("organization A lookup failed")
                .is_some()
        );
        assert!(
            scoped_conversation(&pool, "org_meta_b", "conversation_meta_a")
                .await
                .expect("organization B lookup failed")
                .is_none()
        );
    }
}
