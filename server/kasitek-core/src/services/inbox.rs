use actix_web::HttpResponse;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::collections::HashSet;

use crate::analytics;
use crate::config::AppConfig;
use crate::db::models::{ConversationRow, WhatsappSendMessageRequest};
use crate::error::AppError;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::{
    agent_platform, customers, message_domain, realtime, social, whatsapp, whatsapp_inbox,
};

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
struct MetaMessageAnalyticsRow {
    id: String,
    #[sqlx(rename = "conversation_id")]
    conversation_id: String,
    channel: String,
    sender: String,
    #[sqlx(rename = "message_type")]
    message_type: Option<String>,
    #[sqlx(rename = "provider_metadata")]
    provider_metadata: Option<Value>,
    #[sqlx(rename = "org_id")]
    org_id: Option<String>,
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

/// Return a bounded newest-first conversation projection for integration
/// callers. The product inbox keeps its full projection; Agent callers get a
/// safe limit and explicit truncation metadata.
pub async fn list_inbox_conversations_bounded(
    pool: &PgPool,
    org_id: &str,
    limit: usize,
) -> Result<Value, AppError> {
    let mut payload = list_inbox_conversations(pool, org_id).await?;
    let object = payload.as_object_mut().ok_or_else(|| {
        AppError::Internal("Inbox conversation projection is invalid".to_string())
    })?;
    let conversations = object
        .get_mut("conversations")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            AppError::Internal("Inbox conversation projection is invalid".to_string())
        })?;
    let total = conversations.len();
    conversations.truncate(limit);
    object.insert("total".to_string(), json!(total));
    object.insert("hasMore".to_string(), json!(total > limit));
    Ok(payload)
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

pub async fn list_conversation_messages_bounded(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    limit: usize,
) -> Result<Value, AppError> {
    let mut payload = list_conversation_messages(pool, org_id, conversation_id).await?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("Inbox message projection is invalid".to_string()))?;
    let messages = object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::Internal("Inbox message projection is invalid".to_string()))?;
    let total = messages.len();
    if total > limit {
        let start = total - limit;
        *messages = messages.split_off(start);
    }
    object.insert("total".to_string(), json!(total));
    object.insert("hasMore".to_string(), json!(total > limit));
    Ok(payload)
}

fn meta_attachment_data(payload: &Value) -> Option<&Vec<Value>> {
    payload
        .pointer("/attachments/data")
        .or_else(|| payload.get("data"))
        .and_then(Value::as_array)
}

fn select_meta_attachment_url(
    payload: &Value,
    provider_media_id: Option<&str>,
    prefer_sticker: bool,
) -> Option<String> {
    let attachments = meta_attachment_data(payload)?;
    attachments
        .iter()
        .find(|attachment| {
            provider_media_id
                .map(|media_id| attachment.get("id").and_then(Value::as_str) == Some(media_id))
                .unwrap_or(false)
        })
        .or_else(|| {
            prefer_sticker
                .then(|| {
                    attachments
                        .iter()
                        .find(|attachment| meta_attachment_is_sticker(attachment, attachment))
                })
                .flatten()
        })
        .or_else(|| (prefer_sticker && attachments.len() == 1).then(|| &attachments[0]))
        .and_then(|attachment| {
            attachment
                .pointer("/image_data/url")
                .or_else(|| attachment.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

async fn fetch_meta_attachment_payload(
    request: reqwest::RequestBuilder,
    lookup: &str,
) -> Option<Value> {
    let response = match request.send().await {
        Ok(response) => response,
        Err(_error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "attachment.lookup",
                lookup = %lookup,
                error_type = "request",
                "Meta attachment lookup failed"
            );
            return None;
        }
    };
    let status = response.status();
    let payload = match response.json::<Value>().await {
        Ok(payload) => payload,
        Err(_error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "attachment.lookup",
                lookup = %lookup,
                status = status.as_u16(),
                error_type = "invalid_response",
                "Meta attachment lookup returned invalid JSON"
            );
            return None;
        }
    };
    if !status.is_success() {
        let code = payload.pointer("/error/code").and_then(Value::as_i64);
        let error_type = payload.pointer("/error/type").and_then(Value::as_str);
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "meta",
            operation = "attachment.lookup",
            lookup = %lookup,
            status = status.as_u16(),
            graph_code = ?code,
            graph_type = ?error_type,
            "Meta attachment lookup rejected"
        );
        return None;
    }
    Some(payload)
}

async fn resolve_meta_message_attachment_url(
    graph_base: &str,
    access_token: &str,
    message_provider_id: Option<&str>,
    provider_media_id: Option<&str>,
    prefer_sticker: bool,
) -> Option<String> {
    let message_provider_id = message_provider_id?;
    let client = reqwest::Client::new();

    // The documented message node includes an `attachments` connection. Keep
    // the field request deliberately small: asking for unsupported sticker
    // fields causes Graph to reject the whole request and forces us back to
    // Meta's flattened webhook JPEG.
    if let Some(payload) = fetch_meta_attachment_payload(
        client
            .get(format!("{graph_base}/{message_provider_id}"))
            .bearer_auth(access_token)
            .query(&[("fields", "attachments")]),
        "message_node",
    )
    .await
    {
        if let Some(url) = select_meta_attachment_url(&payload, provider_media_id, prefer_sticker) {
            return Some(url);
        }
        observability::tracing::info!(
            event = "provider.call.completed",
            provider = "meta",
            operation = "attachment.lookup",
            lookup = "message_node",
            result = "attachment_not_found",
            count = meta_attachment_data(&payload).map_or(0, Vec::len),
            "Meta attachment was not found on the message node"
        );
    }

    // Some Graph versions also expose attachments as an edge. This is a
    // compatibility fallback, still using only standard media fields.
    let payload = fetch_meta_attachment_payload(
        client
            .get(format!("{graph_base}/{message_provider_id}/attachments"))
            .bearer_auth(access_token)
            .query(&[("fields", "id,url,image_data")]),
        "attachment_edge",
    )
    .await?;
    select_meta_attachment_url(&payload, provider_media_id, prefer_sticker)
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
        .pointer("/image_data/url")
        .or_else(|| provider_payload.get("url"))
        .or_else(|| provider_payload.get("attachment_url"))
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
    let resolved_media = if let Some(url) = refreshed_sticker_url {
        Some((url, "graph_message_attachment"))
    } else if let Some(url) = media_url_from_payload {
        Some((url, "webhook_payload"))
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
                return Some((url, "graph_message_attachment"));
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
                .map(|url| (url.to_string(), "graph_media_node"))
        }
        .await
    };
    let (media_url, media_source) = resolved_media.ok_or_else(|| {
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
    if attachment_kind == "sticker" {
        observability::tracing::info!(
            event = "provider.call.completed",
            provider = "meta",
            operation = "attachment.download",
            kind = %attachment_kind,
            attachment_id = %attachment_id,
            provider_media_id = %provider_media_id.as_deref().unwrap_or("none"),
            source = %media_source,
            content_type = %content_type,
            bytes = bytes.len(),
            "Meta sticker attachment downloaded"
        );
    }
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
        .append_header(("X-KasiTek-Media-Source", media_source))
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
    let occurred_at = Utc::now();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO "Message" (
            id, "conversationId", sender, content, "contentType",
            "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'PROCESSING', $4, $5)
        "#,
    )
    .bind(&message_id)
    .bind(&meta_scope.id)
    .bind(text)
    .bind(json!({
        "provider": meta_scope.channel,
        "channelConnectionId": meta_scope.channel_connection_id,
        "replyToMessageId": input.reply_to_message_id,
        "_kasitek_inbox_responder_type": "human",
    }))
    .bind(occurred_at)
    .execute(&mut *transaction)
    .await?;
    let response_time_ms = analytics::inbox::preceding_customer_response_time_ms(
        &mut transaction,
        &meta_scope.id,
        occurred_at,
    )
    .await?;
    analytics::inbox::enqueue_message_lifecycle(
        &mut transaction,
        org_id,
        &message_id,
        &meta_scope.id,
        &meta_scope.channel,
        "created",
        "outbound",
        "human",
        "text",
        Some("processing"),
        response_time_ms,
        occurred_at,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
    })?;
    enqueue_meta_source_manifest(&mut transaction, org_id, occurred_at).await?;
    transaction.commit().await?;
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

    deliver_meta_text_message(
        pool,
        user_id,
        org_id,
        &meta_scope,
        &message_id,
        text,
        reply_to_provider_message_id.as_deref(),
    )
    .await
}

pub async fn retry_conversation_message(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    if conversation.channel == "whatsapp" {
        return Err(AppError::BadRequest(
            "Retry is currently available for Instagram and Messenger messages".to_string(),
        ));
    }

    let meta_scope = scoped_meta_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let mut transaction = pool.begin().await?;
    let message = sqlx::query_as::<_, InboxMessageRow>(
        r#"
        UPDATE "Message"
        SET "providerStatus" = 'PROCESSING',
            "errorCode" = NULL,
            "errorMessage" = NULL
        WHERE id = $1
          AND "conversationId" = $2
          AND sender = 'bot'
          AND "contentType" = 'TEXT'
          AND "providerStatus" = 'FAILED'
        RETURNING id, "conversationId" AS conversation_id, sender, content,
                  "whatsappMessageId" AS whatsapp_message_id,
                  "whatsappStatus" AS whatsapp_status,
                  "providerMessageId" AS provider_message_id,
                  "providerStatus" AS provider_status,
                  "errorCode" AS error_code,
                  "errorMessage" AS error_message,
                  timestamp AT TIME ZONE 'UTC' AS timestamp
        "#,
    )
    .bind(message_id)
    .bind(&meta_scope.id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| {
        AppError::Conflict("Only failed outgoing text messages can be retried".to_string())
    })?;
    let occurred_at = Utc::now();
    analytics::inbox::enqueue_message_lifecycle(
        &mut transaction,
        org_id,
        &message.id,
        &meta_scope.id,
        &meta_scope.channel,
        "retried",
        "outbound",
        "human",
        "text",
        Some("processing"),
        None,
        occurred_at,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
    })?;
    enqueue_meta_source_manifest(&mut transaction, org_id, occurred_at).await?;
    transaction.commit().await?;
    let reply_to_provider_message_id = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT "referencedProviderMessageId"
        FROM "MessageReference"
        WHERE "messageId" = $1
        LIMIT 1
        "#,
    )
    .bind(&message.id)
    .fetch_optional(pool)
    .await?
    .flatten();

    publish_message_updated(pool, &message.id).await?;
    deliver_meta_text_message(
        pool,
        user_id,
        org_id,
        &meta_scope,
        &message.id,
        &message.content,
        reply_to_provider_message_id.as_deref(),
    )
    .await
}

async fn deliver_meta_text_message(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    meta_scope: &MetaConversationScopeRow,
    message_id: &str,
    text: &str,
    reply_to_provider_message_id: Option<&str>,
) -> Result<Value, AppError> {
    let result = try_deliver_meta_text_message(
        pool,
        user_id,
        org_id,
        meta_scope,
        message_id,
        text,
        reply_to_provider_message_id,
    )
    .await;

    if let Err(error) = &result {
        let occurred_at = Utc::now();
        let mut transaction = pool.begin().await?;
        sqlx::query(
            r#"
            UPDATE "Message"
            SET "providerStatus" = 'FAILED',
                "errorCode" = 'META_SEND_FAILED',
                "errorMessage" = $1
            WHERE id = $2
            "#,
        )
        .bind(error.to_string())
        .bind(message_id)
        .execute(&mut *transaction)
        .await?;
        analytics::inbox::enqueue_message_lifecycle(
            &mut transaction,
            org_id,
            message_id,
            &meta_scope.id,
            &meta_scope.channel,
            "delivery_updated",
            "outbound",
            "human",
            "text",
            Some("failed"),
            None,
            occurred_at,
        )
        .await
        .map_err(|analytics_error| {
            AppError::Internal(format!(
                "Failed to queue Inbox analytics fact: {analytics_error}"
            ))
        })?;
        enqueue_meta_source_manifest(&mut transaction, org_id, occurred_at).await?;
        transaction.commit().await?;
        publish_message_updated(pool, message_id).await?;
    }

    result
}

async fn try_deliver_meta_text_message(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    meta_scope: &MetaConversationScopeRow,
    message_id: &str,
    text: &str,
    reply_to_provider_message_id: Option<&str>,
) -> Result<Value, AppError> {
    let response = send_meta_text_message(meta_scope, text, reply_to_provider_message_id).await?;

    let occurred_at = Utc::now();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        WITH updated_message AS (
            UPDATE "Message"
            SET "providerMessageId" = $1,
                "providerStatus" = 'SENT',
                "errorCode" = NULL,
                "errorMessage" = NULL
            WHERE id = $2
            RETURNING 1
        )
        UPDATE "Conversation"
        SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW()
        WHERE id = $3
          AND EXISTS (SELECT 1 FROM updated_message)
        "#,
    )
    .bind(response.message_id.as_deref())
    .bind(message_id)
    .bind(&meta_scope.id)
    .execute(&mut *transaction)
    .await?;
    analytics::inbox::enqueue_message_lifecycle(
        &mut transaction,
        org_id,
        message_id,
        &meta_scope.id,
        &meta_scope.channel,
        "delivery_updated",
        "outbound",
        "human",
        "text",
        Some("sent"),
        None,
        occurred_at,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
    })?;
    enqueue_meta_source_manifest(&mut transaction, org_id, occurred_at).await?;
    transaction.commit().await?;

    // The HTTP response is the sender's immediate acknowledgement. Realtime
    // fan-out performs several read queries and must not hold that response
    // open after Meta has already accepted and delivered the message.
    let event_pool = pool.clone();
    let event_user_id = user_id.to_string();
    let event_message_id = message_id.to_string();
    let event_conversation_id = meta_scope.id.clone();
    tokio::spawn(async move {
        if let Err(error) =
            publish_message_created(&event_pool, &event_user_id, &event_message_id).await
        {
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "inbox.realtime_publish",
                provider = "meta",
                message_id = %event_message_id,
                error_type = %std::any::type_name_of_val(&error),
                "sent Meta message realtime publish failed"
            );
        }
        if let Err(error) =
            publish_conversation_updated(&event_pool, &event_user_id, &event_conversation_id).await
        {
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "inbox.realtime_publish",
                provider = "meta",
                conversation_id = %event_conversation_id,
                error_type = %std::any::type_name_of_val(&error),
                "Meta conversation realtime publish failed"
            );
        }
    });

    Ok(json!({
        "success": true,
        "messageId": message_id,
        "providerMessageId": response.message_id,
        "status": "SENT",
    }))
}

async fn send_meta_text_message(
    meta_scope: &MetaConversationScopeRow,
    text: &str,
    reply_to_provider_message_id: Option<&str>,
) -> Result<MetaSendMessageResponse, AppError> {
    let (_, customer_id) = parse_meta_conversation_identifier(&meta_scope.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid Meta conversation".to_string()))?;
    let encrypted_access_token = meta_scope.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Connected channel is missing an access token".to_string())
    })?;
    let access_token = social::decrypt_social_secret(encrypted_access_token)?;
    let uses_instagram_login = meta_scope
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let asset_id = meta_message_sender_asset_id(
        &meta_scope.channel,
        uses_instagram_login,
        meta_scope.external_account_id.as_deref(),
        meta_scope.metadata.as_ref(),
    )
    .ok_or_else(|| {
        let message = if meta_scope.channel == "instagram" && !uses_instagram_login {
            "Connected Instagram channel is missing its linked Facebook Page ID. Reconnect it through Meta."
        } else {
            "Connected Meta channel is missing a target asset"
        };
        AppError::BadRequest(message.to_string())
    })?;
    let graph_base = if uses_instagram_login {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };
    let mut message_payload = json!({ "text": text });
    if let Some(reply_to_provider_message_id) = reply_to_provider_message_id {
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

    fetch_meta_json(
        reqwest::Client::new()
            .post(format!("{graph_base}/{asset_id}/messages"))
            .bearer_auth(access_token)
            .json(&request_body),
        "Failed to send Meta message",
    )
    .await
}

/// Delivers an Agent Platform reply through the Core-owned Facebook or
/// Instagram connection. Provider credentials never leave Core.
pub async fn deliver_agent_meta_message(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    text: &str,
    idempotency_key: &str,
) -> Result<Value, AppError> {
    let idempotency_key = whatsapp_inbox::validate_agent_delivery_idempotency_key(idempotency_key)?;
    let meta_scope = scoped_meta_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Meta conversation not found".to_string()))?;
    if !matches!(meta_scope.channel.as_str(), "facebook" | "instagram") {
        return Err(AppError::BadRequest(
            "Agent delivery is not supported for this Meta conversation".to_string(),
        ));
    }

    if let Some((provider_message_id, provider_status)) =
        sqlx::query_as::<_, (Option<String>, Option<String>)>(
            r#"
        SELECT "providerMessageId", "providerStatus"
        FROM "Message"
        WHERE "conversationId" = $1
          AND "providerMetadata"->>'_kasitek_agent_idempotency_key' = $2
        ORDER BY timestamp DESC
        LIMIT 1
        "#,
        )
        .bind(&meta_scope.id)
        .bind(idempotency_key)
        .fetch_optional(pool)
        .await?
    {
        if provider_message_id.is_some() {
            return Ok(json!({
                "providerMessageId": provider_message_id,
                "status": "sent",
                "idempotentReplay": true,
            }));
        }
        return Ok(json!({
            "status": "unknown",
            "idempotentReplay": true,
            "providerStatus": provider_status,
        }));
    }

    let message_id = cuid2::create_id();
    let occurred_at = Utc::now();
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "providerStatus", "providerMetadata", timestamp)
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'SENDING', $4::jsonb, $5)
        "#,
    )
    .bind(&message_id)
    .bind(&meta_scope.id)
    .bind(text)
    .bind(json!({
        "_kasitek_agent_idempotency_key": idempotency_key,
        "_kasitek_responder_type": "agent",
    }))
    .bind(occurred_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1 AND "orgId" = $2"#,
    )
    .bind(&meta_scope.id)
    .bind(org_id)
    .execute(&mut *tx)
    .await?;
    let response_time_ms =
        analytics::inbox::preceding_customer_response_time_ms(&mut tx, &meta_scope.id, occurred_at)
            .await?;
    analytics::inbox::enqueue_message_lifecycle(
        &mut tx,
        org_id,
        &message_id,
        &meta_scope.id,
        &meta_scope.channel,
        "created",
        "outbound",
        "agent",
        "text",
        Some("sending"),
        response_time_ms,
        occurred_at,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
    })?;
    enqueue_meta_source_manifest(&mut tx, org_id, occurred_at).await?;
    tx.commit().await?;

    match send_meta_text_message(&meta_scope, text, None).await {
        Ok(response) => {
            let mut tx = pool.begin().await?;
            sqlx::query(
                r#"UPDATE "Message" SET "providerMessageId" = $1, "providerStatus" = 'SENT', "errorCode" = NULL, "errorMessage" = NULL WHERE id = $2 AND "conversationId" = $3"#,
            )
            .bind(response.message_id.as_deref())
            .bind(&message_id)
            .bind(&meta_scope.id)
            .execute(&mut *tx)
            .await?;
            analytics::inbox::enqueue_message_lifecycle(
                &mut tx,
                org_id,
                &message_id,
                &meta_scope.id,
                &meta_scope.channel,
                "delivery_updated",
                "outbound",
                "agent",
                "text",
                Some("sent"),
                None,
                Utc::now(),
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
            })?;
            enqueue_meta_source_manifest(&mut tx, org_id, Utc::now()).await?;
            tx.commit().await?;
            publish_message_updated(pool, &message_id).await?;
            publish_conversation_updated(pool, "agent-platform", &meta_scope.id).await?;
            Ok(json!({
                "providerMessageId": response.message_id,
                "status": "sent",
            }))
        }
        Err(error) => {
            let error_message = error.to_string();
            let error_code = if is_meta_authentication_failure(&error_message) {
                "AGENT_DELIVERY_AUTH_FAILED"
            } else {
                "AGENT_DELIVERY_FAILED"
            };
            let mut tx = pool.begin().await?;
            sqlx::query(
                r#"UPDATE "Message" SET "providerStatus" = 'FAILED', "errorCode" = $1, "errorMessage" = $2 WHERE id = $3 AND "conversationId" = $4"#,
            )
            .bind(error_code)
            .bind(&error_message)
            .bind(&message_id)
            .bind(&meta_scope.id)
            .execute(&mut *tx)
            .await?;
            analytics::inbox::enqueue_message_lifecycle(
                &mut tx,
                org_id,
                &message_id,
                &meta_scope.id,
                &meta_scope.channel,
                "delivery_updated",
                "outbound",
                "agent",
                "text",
                Some("failed"),
                None,
                Utc::now(),
            )
            .await
            .map_err(|analytics_error| {
                AppError::Internal(format!(
                    "Failed to queue Inbox analytics fact: {analytics_error}"
                ))
            })?;
            enqueue_meta_source_manifest(&mut tx, org_id, Utc::now()).await?;
            tx.commit().await?;
            publish_message_updated(pool, &message_id).await?;
            publish_conversation_updated(pool, "agent-platform", &meta_scope.id).await?;
            Err(error)
        }
    }
}

fn is_meta_authentication_failure(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("401 unauthorized")
        || normalized.contains("403 forbidden")
        || normalized.contains("invalid oauth access token")
        || normalized.contains("authentication")
}

async fn try_send_meta_mark_seen(meta_scope: &MetaConversationScopeRow) -> Result<(), AppError> {
    let (_, customer_id) = parse_meta_conversation_identifier(&meta_scope.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid Meta conversation".to_string()))?;
    let encrypted_access_token = meta_scope.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Connected channel is missing an access token".to_string())
    })?;
    let access_token = social::decrypt_social_secret(encrypted_access_token)?;
    let uses_instagram_login = meta_scope
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let asset_id = meta_message_sender_asset_id(
        &meta_scope.channel,
        uses_instagram_login,
        meta_scope.external_account_id.as_deref(),
        meta_scope.metadata.as_ref(),
    )
    .ok_or_else(|| {
        AppError::BadRequest("Connected Meta channel is missing a target asset".to_string())
    })?;
    let graph_base = if uses_instagram_login {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };

    let _: Value = fetch_meta_json(
        reqwest::Client::new()
            .post(format!("{graph_base}/{asset_id}/messages"))
            .bearer_auth(access_token)
            .json(&meta_mark_seen_payload(&customer_id)),
        "Failed to send Meta read receipt",
    )
    .await?;

    Ok(())
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

    let mut provider_receipt_sent = false;
    if matches!(conversation.channel.as_str(), "facebook" | "instagram") {
        match scoped_meta_conversation(pool, org_id, conversation_id).await? {
            Some(meta_scope) => match try_send_meta_mark_seen(&meta_scope).await {
                Ok(()) => provider_receipt_sent = true,
                Err(error) => {
                    observability::tracing::warn!(
                        event = "provider.call.failed",
                        provider = "meta",
                        operation = "read_receipt.send",
                        conversation_id = %conversation.id,
                        channel = %conversation.channel,
                        error_type = %std::any::type_name_of_val(&error),
                        "Meta read receipt failed"
                    );
                }
            },
            None => {
                observability::tracing::warn!(
                    event = "operation.failed",
                    operation = "read_receipt.resolve_channel",
                    provider = "meta",
                    conversation_id = %conversation.id,
                    channel = %conversation.channel,
                    reason = "channel_not_found",
                    "Meta channel could not be resolved for read receipt"
                );
            }
        }
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

    Ok(json!({
        "success": true,
        "conversationId": conversation.id,
        "providerReceiptSent": provider_receipt_sent,
    }))
}

pub async fn process_meta_webhook_payload(
    pool: &PgPool,
    config: &AppConfig,
    payload: Value,
) -> Result<(), AppError> {
    observability::tracing::info!(
        event = "provider.webhook.received",
        provider = "meta",
        operation = "webhook.process",
        "Meta webhook payload received"
    );
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
                observability::tracing::warn!(
                    event = "provider.call.failed",
                    provider = "meta",
                    operation = "webhook.resolve_channel",
                    object = %object,
                    asset_id = %asset_id,
                    reason = "channel_not_found",
                    "Meta webhook ignored because its channel could not be resolved"
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
            observability::tracing::info!(
                event = "provider.call.completed",
                provider = "meta",
                operation = "webhook.receive",
                event_kind = %event_kind,
                object = %object,
                channel_id = %channel.id,
                asset_id = %asset_id,
                sender_id = %sender_id,
                recipient_id = %recipient_id,
                "Meta webhook event received"
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
            let (conversation_id, _, _) = find_or_create_meta_conversation(
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
            let occurred_at = Utc::now();
            let mut transaction = pool.begin().await?;
            let inserted = sqlx::query_scalar::<_, String>(
                r#"
                INSERT INTO "Message" (
                    id, "conversationId", sender, content, "contentType",
                    "providerMessageId", "providerStatus", "providerMetadata", timestamp
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
                "_kasitek_inbox_responder_type": if is_echo { "human" } else { "customer" },
            }))
            .bind(occurred_at)
            .fetch_optional(&mut *transaction)
            .await?;

            if inserted.is_none() {
                transaction.rollback().await?;
                continue;
            }
            analytics::inbox::enqueue_message_lifecycle(
                &mut transaction,
                channel.org_id.as_deref().unwrap_or_default(),
                &message_id,
                &conversation_id,
                if channel.platform == "INSTAGRAM" {
                    "instagram"
                } else {
                    "facebook"
                },
                "created",
                if is_echo { "outbound" } else { "inbound" },
                if is_echo { "human" } else { "customer" },
                if attachments.is_empty() {
                    "text"
                } else {
                    "media"
                },
                Some(&provider_status.to_ascii_lowercase()),
                None,
                occurred_at,
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
            })?;
            sqlx::query(
                r#"
                UPDATE "Conversation"
                SET "lastMessageAt" = $1,
                    status = 'active',
                    "unreadCount" = "unreadCount" + $2, "updatedAt" = NOW()
                WHERE id = $3
                "#,
            )
            .bind(occurred_at)
            .bind(if is_echo { 0 } else { 1 })
            .bind(&conversation_id)
            .execute(&mut *transaction)
            .await?;
            enqueue_meta_source_manifest(
                &mut transaction,
                channel.org_id.as_deref().unwrap_or_default(),
                occurred_at,
            )
            .await?;
            transaction.commit().await?;
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

            publish_message_created(pool, &channel.user_id, &message_id).await?;
            publish_conversation_updated(pool, &channel.user_id, &conversation_id).await?;

            if is_echo {
                continue;
            }

            if !content.is_empty() {
                if let Err(error) = forward_meta_message_to_agent(
                    config,
                    &channel,
                    &conversation_id,
                    &sender_id,
                    customer_name.as_deref(),
                    &object,
                    message_mid.as_deref(),
                    event.get("timestamp").and_then(Value::as_i64),
                    &content,
                )
                .await
                {
                    // Inbox persistence is authoritative for provider webhooks. An
                    // unavailable Agent Platform must not make Meta retry an event
                    // that Core has already stored.
                    observability::tracing::warn!(
                        event = "operation.failed",
                        operation = "agent_platform.meta_ingest",
                        provider = "meta",
                        channel = %channel.platform,
                        conversation_id = %conversation_id,
                        error_type = %std::any::type_name_of_val(&error),
                        "Meta message was stored but could not be forwarded to Agent Platform"
                    );
                }
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
                observability::tracing::warn!(
                    event = "operation.failed",
                    operation = "push_notification.send",
                    provider = "meta",
                    conversation_id = %conversation_id,
                    user_id = %channel.user_id,
                    error_type = %std::any::type_name_of_val(&error),
                    "push notification for Meta message failed"
                );
            }
        }
    }

    Ok(())
}

async fn forward_meta_message_to_agent(
    config: &AppConfig,
    channel: &MetaChannelRow,
    conversation_id: &str,
    sender_id: &str,
    display_name: Option<&str>,
    object: &str,
    provider_message_id: Option<&str>,
    timestamp: Option<i64>,
    text: &str,
) -> Result<(), AppError> {
    let client = agent_platform::AgentPlatformClient::from_config(config)?;
    let channel_type = if channel.platform == "INSTAGRAM" {
        "instagram"
    } else {
        "facebook"
    };
    let message_id = provider_message_id
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "meta:{object}:{}:{sender_id}:{}",
                channel.id,
                timestamp.unwrap_or_default()
            )
        });
    let mut payload = json!({
        "channelType": channel_type,
        "channelKey": channel.external_connection_id.clone(),
        "provider": "meta",
        "providerEventId": message_id.clone(),
        "providerMessageId": message_id,
        "externalIdentity": sender_id,
        "externalConversationId": conversation_id,
        "messageType": "text",
        "content": { "text": text },
        "occurredAt": Utc::now().to_rfc3339(),
    });
    if let Some(display_name) = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["displayName"] = json!(display_name);
    }
    client
        .ingest_channel_message(
            channel.org_id.as_deref().unwrap_or_default(),
            &channel.user_id,
            payload,
        )
        .await?;
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
          AND (
              channel."externalAccountId" = $2
              OR (
                  $1 = 'INSTAGRAM'
                  AND (
                      channel.metadata->>'instagramAccountId' = $2
                      OR channel.metadata->>'instagramUserId' = $2
                      OR channel.metadata->>'instagramAppScopedId' = $2
                  )
              )
          )
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
) -> Result<(String, i32, bool), AppError> {
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
    let mut transaction = pool.begin().await?;
    let (conversation_id, unread_count, created) = sqlx::query_as::<_, (String, i32, bool)>(
        r#"
        INSERT INTO "Conversation" (
            id, channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "orgId", "externalConnectionId", "customerId",
            "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, NOW(), 0, $6,
            $7,
            $8, NOW(), NOW()
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
        RETURNING id, "unreadCount", (xmax = 0) AS created
        "#,
    )
    .bind(&id)
    .bind(channel_name)
    .bind(&identifier)
    .bind(customer_name)
    .bind("active")
    .bind(channel.org_id.as_deref())
    .bind(&channel.external_connection_id)
    .bind(canonical_customer_id.as_deref())
    .fetch_one(&mut *transaction)
    .await?;
    if created {
        analytics::inbox::enqueue_conversation_lifecycle(
            &mut transaction,
            channel.org_id.as_deref().unwrap_or_default(),
            &conversation_id,
            channel_name,
            "opened",
            "active",
            "customer",
            Utc::now(),
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
        })?;
    }
    transaction.commit().await?;
    Ok((conversation_id, unread_count, created))
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
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "sender_profile.decrypt_token",
                provider = "meta",
                channel_id = %channel.id,
                error_type = %std::any::type_name_of_val(&error),
                "Meta sender profile token decryption failed"
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
    let (graph_base, fields) = meta_customer_profile_query(uses_instagram_login, &channel.platform);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "sender_profile.client",
                provider = "meta",
                error_type = %std::any::type_name_of_val(&error),
                "Meta sender profile client creation failed"
            );
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
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "sender_profile.lookup",
                channel_id = %channel.id,
                customer_id = %customer_id,
                status = response.status().as_u16(),
                "Meta sender profile lookup rejected"
            );
            return Ok(None);
        }
        Err(error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "sender_profile.lookup",
                channel_id = %channel.id,
                customer_id = %customer_id,
                error_type = %std::any::type_name_of_val(&error),
                "Meta sender profile lookup failed"
            );
            return Ok(None);
        }
    };
    let profile = match response.json::<Value>().await {
        Ok(profile) => profile,
        Err(error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "sender_profile.decode",
                channel_id = %channel.id,
                customer_id = %customer_id,
                error_type = %std::any::type_name_of_val(&error),
                "Meta sender profile response decode failed"
            );
            return Ok(None);
        }
    };

    Ok(meta_profile_display_name(&profile))
}

async fn load_meta_message_analytics_rows(
    transaction: &mut Transaction<'_, Postgres>,
    message_ids: &HashSet<String>,
) -> Result<Vec<MetaMessageAnalyticsRow>, AppError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = message_ids.iter().cloned().collect::<Vec<_>>();
    sqlx::query_as::<_, MetaMessageAnalyticsRow>(
        r#"
        SELECT message.id,
               message."conversationId" AS conversation_id,
               conversation.channel,
               message.sender,
               message."contentType"::text AS message_type,
               message."providerMetadata" AS provider_metadata,
               conversation."orgId" AS org_id
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE message.id = ANY($1)
        "#,
    )
    .bind(&ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(AppError::from)
}

fn meta_message_responder_type(message: &MetaMessageAnalyticsRow) -> &'static str {
    if message.sender == "customer" {
        "customer"
    } else if message
        .provider_metadata
        .as_ref()
        .and_then(|value| value.get("_kasitek_agent_idempotency_key"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        "agent"
    } else if message
        .provider_metadata
        .as_ref()
        .and_then(|value| value.get("_kasitek_inbox_message_kind"))
        .and_then(Value::as_str)
        == Some("template")
    {
        "system"
    } else {
        "human"
    }
}

async fn enqueue_meta_message_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    message_ids: &HashSet<String>,
    action: &str,
    delivery_status: Option<&str>,
    occurred_at: chrono::DateTime<Utc>,
) -> Result<(), AppError> {
    let mut organization_id = None;
    for message in load_meta_message_analytics_rows(transaction, message_ids).await? {
        let Some(org_id) = message.org_id.as_deref() else {
            continue;
        };
        organization_id = Some(org_id.to_string());
        let direction = if message.sender == "customer" {
            "inbound"
        } else {
            "outbound"
        };
        let message_type = message
            .message_type
            .as_deref()
            .unwrap_or("TEXT")
            .to_ascii_lowercase();
        analytics::inbox::enqueue_message_lifecycle(
            transaction,
            org_id,
            &message.id,
            &message.conversation_id,
            &message.channel,
            action,
            direction,
            meta_message_responder_type(&message),
            &message_type,
            delivery_status,
            None,
            occurred_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
        })?;
    }
    if let Some(organization_id) = organization_id {
        enqueue_meta_source_manifest(transaction, &organization_id, occurred_at).await?;
    }
    Ok(())
}

async fn enqueue_meta_source_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    collected_at: chrono::DateTime<Utc>,
) -> Result<(), AppError> {
    if organization_id.trim().is_empty() {
        return Ok(());
    }
    let message_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)::bigint
        FROM "Message" message
        JOIN "Conversation" conversation
          ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation.channel IN ('facebook', 'instagram')
        "#,
    )
    .bind(organization_id)
    .fetch_one(&mut **transaction)
    .await?;
    analytics::inbox::enqueue_manifest(transaction, organization_id, message_count, collected_at)
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Meta Inbox source manifest: {error}"
            ))
        })?;
    Ok(())
}

fn meta_customer_profile_query(
    uses_instagram_login: bool,
    platform: &str,
) -> (&'static str, &'static str) {
    if uses_instagram_login {
        // Instagram Login's IGSID profile endpoint rejects profile_picture_url.
        // A failed field makes Meta reject the complete lookup, including the name.
        (INSTAGRAM_GRAPH_BASE, "name,username")
    } else if platform == "INSTAGRAM" {
        (META_GRAPH_BASE, "name,username,profile_pic")
    } else {
        (META_GRAPH_BASE, "first_name,last_name,profile_pic")
    }
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

    let mut transaction = pool.begin().await?;
    let mut updated_ids = HashSet::new();
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
            .fetch_all(&mut *transaction)
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
            .fetch_all(&mut *transaction)
            .await?,
        );
    }

    enqueue_meta_message_lifecycle(
        &mut transaction,
        &updated_ids,
        "delivery_updated",
        Some("delivered"),
        Utc::now(),
    )
    .await?;
    transaction.commit().await?;

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
                observability::tracing::warn!(
                    event = "operation.failed",
                    operation = "message.sync_missing_outbound",
                    provider = "meta",
                    channel_id = %channel.id,
                    customer_id = %customer_id,
                    provider_message_id = %provider_message_id,
                    error_type = %std::any::type_name_of_val(&error),
                    "missing Meta outbound message sync failed"
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
    let (conversation_id, _, _) =
        find_or_create_meta_conversation(pool, channel, customer_id, customer_name.as_deref())
            .await?;
    let timestamp = graph_message
        .get("created_time")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let message_id = cuid2::create_id();
    let mut transaction = pool.begin().await?;
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
        "provider": channel.platform.to_lowercase(),
        "source": "delivery_backfill",
        "_kasitek_inbox_responder_type": "human",
        "graphMessage": graph_message,
    }))
    .bind(timestamp)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(message_id) = inserted else {
        transaction.rollback().await?;
        return Ok(());
    };
    analytics::inbox::enqueue_message_lifecycle(
        &mut transaction,
        channel.org_id.as_deref().unwrap_or_default(),
        &message_id,
        &conversation_id,
        if channel.platform == "INSTAGRAM" {
            "instagram"
        } else {
            "facebook"
        },
        "created",
        "outbound",
        "human",
        if attachments.is_empty() {
            "text"
        } else {
            "media"
        },
        Some("delivered"),
        None,
        timestamp,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
    })?;
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
    .execute(&mut *transaction)
    .await?;
    enqueue_meta_source_manifest(
        &mut transaction,
        channel.org_id.as_deref().unwrap_or_default(),
        timestamp,
    )
    .await?;
    transaction.commit().await?;
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
    let message_ids = meta_read_message_ids(read);
    let watermark = meta_receipt_watermark(read);
    if message_ids.is_empty() && watermark.is_none() {
        return Ok(());
    }

    let mut transaction = pool.begin().await?;
    let mut updated_ids = HashSet::new();
    if !message_ids.is_empty() {
        updated_ids.extend(
            sqlx::query_scalar::<_, String>(
                r#"
                WITH receipt_targets AS (
                    SELECT source."conversationId" AS conversation_id,
                           MAX(source.timestamp) AS read_through
                    FROM "Message" source
                    JOIN "Conversation" source_conversation
                      ON source_conversation.id = source."conversationId"
                    WHERE source_conversation."orgId" = $1
                      AND source_conversation."externalConnectionId" = $2
                      AND source."providerMessageId" = ANY($3)
                    GROUP BY source."conversationId"
                )
                UPDATE "Message" message
                SET "providerStatus" = 'READ', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation, receipt_targets target
                WHERE message."conversationId" = conversation.id
                  AND message."conversationId" = target.conversation_id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND message.sender = 'bot'
                  AND message.timestamp <= target.read_through
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED')
                RETURNING message.id
                "#,
            )
            .bind(org_id)
            .bind(&channel.external_connection_id)
            .bind(&message_ids)
            .fetch_all(&mut *transaction)
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
            .fetch_all(&mut *transaction)
            .await?,
        );
    }

    enqueue_meta_message_lifecycle(
        &mut transaction,
        &updated_ids,
        "delivery_updated",
        Some("read"),
        Utc::now(),
    )
    .await?;
    transaction.commit().await?;

    if updated_ids.is_empty() {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "meta",
            operation = "read_receipt.apply",
            channel_id = %channel.id,
            platform = %channel.platform,
            matched = 0,
            "Meta read receipt matched no outbound message"
        );
    } else {
        observability::tracing::info!(
            event = "provider.call.completed",
            provider = "meta",
            operation = "read_receipt.apply",
            channel_id = %channel.id,
            platform = %channel.platform,
            matched = updated_ids.len(),
            "Meta read receipt applied"
        );
    }
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
        observability::tracing::info!(
            event = "provider.call.completed",
            provider = "meta",
            operation = "reaction.apply",
            channel_id = %channel.id,
            provider_message_id = %target_provider_message_id,
            result = "target_not_found",
            "Meta reaction target not found"
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
        observability::tracing::warn!(
            event = "operation.failed",
            operation = "inbox.realtime_publish",
            error_type = %std::any::type_name_of_val(&error),
            "inbox realtime event publish failed"
        );
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

fn meta_value_identifier(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn meta_attachment_is_sticker(attachment: &Value, payload: &Value) -> bool {
    attachment
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("sticker"))
        || attachment.get("render_as_sticker").and_then(Value::as_bool) == Some(true)
        || payload.get("render_as_sticker").and_then(Value::as_bool) == Some(true)
        || attachment
            .get("sticker_id")
            .is_some_and(|value| !value.is_null())
        || payload
            .get("sticker_id")
            .is_some_and(|value| !value.is_null())
        || attachment
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("sticker_"))
        || payload
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("sticker_"))
}

fn meta_sticker_id(attachment: &Value, payload: &Value) -> Option<String> {
    meta_value_identifier(
        payload
            .get("sticker_id")
            .or_else(|| attachment.get("sticker_id")),
    )
    .or_else(|| {
        payload
            .get("id")
            .or_else(|| attachment.get("id"))
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix("sticker_"))
            .map(str::to_string)
    })
}

fn meta_attachment_metadata(
    attachment: &Value,
    payload: Value,
    source: &str,
    is_sticker: bool,
) -> Value {
    let sticker_id = meta_sticker_id(attachment, &payload);
    let animation = is_sticker.then(|| {
        json!({
            "spriteUrl": payload
                .pointer("/sprite_image_2x/uri")
                .or_else(|| payload.pointer("/sprite_image/uri"))
                .or_else(|| attachment.pointer("/sprite_image_2x/uri"))
                .or_else(|| attachment.pointer("/sprite_image/uri")),
            "framesPerRow": payload
                .get("frames_per_row")
                .or_else(|| attachment.get("frames_per_row")),
            "framesPerColumn": payload
                .get("frames_per_column")
                .or_else(|| attachment.get("frames_per_column")),
            "frameCount": payload
                .get("frame_count")
                .or_else(|| attachment.get("frame_count")),
            "frameRate": payload
                .get("frame_rate")
                .or_else(|| attachment.get("frame_rate")),
        })
    });

    json!({
        "providerPayload": payload,
        "providerSource": source,
        "sticker": is_sticker.then(|| json!({
            "id": sticker_id,
            "renderAsSticker": true,
            "animation": animation,
        })),
    })
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
            let is_sticker = meta_attachment_is_sticker(attachment, &payload);
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
                provider_media_id: meta_value_identifier(
                    payload
                        .get("id")
                        .or_else(|| attachment.get("id"))
                        .or_else(|| payload.get("sticker_id"))
                        .or_else(|| attachment.get("sticker_id")),
                ),
                mime_type: payload
                    .get("mime_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                file_name: payload
                    .get("name")
                    .or_else(|| payload.get("filename"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata: meta_attachment_metadata(attachment, payload, "webhook", is_sticker),
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

fn meta_read_message_ids(read: &Value) -> Vec<String> {
    let mut message_ids = read
        .get("mids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(message_id) = read
        .get("mid")
        .or_else(|| read.get("message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        message_ids.push(message_id.to_string());
    }
    message_ids.sort();
    message_ids.dedup();
    message_ids
}

fn meta_receipt_watermark(receipt: &Value) -> Option<i64> {
    receipt.get("watermark").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.parse::<i64>().ok()))
    })
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
        .map(|attachment| {
            let payload = attachment.clone();
            let is_sticker = meta_attachment_is_sticker(attachment, &payload);
            MetaIncomingAttachment {
                kind: if is_sticker {
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
                metadata: meta_attachment_metadata(
                    attachment,
                    payload,
                    "graph_message",
                    is_sticker,
                ),
            }
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

fn meta_message_sender_asset_id(
    channel: &str,
    uses_instagram_login: bool,
    external_account_id: Option<&str>,
    metadata: Option<&Value>,
) -> Option<String> {
    if channel == "instagram" && !uses_instagram_login {
        return metadata
            .and_then(|value| value.get("pageId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }

    external_account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn meta_mark_seen_payload(customer_id: &str) -> Value {
    json!({
        "recipient": { "id": customer_id },
        "sender_action": "mark_seen",
    })
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
        build_meta_conversation_identifier, meta_customer_profile_query, meta_delivery_message_ids,
        meta_graph_message_attachments, meta_graph_message_content,
        meta_graph_message_recipient_name, meta_mark_seen_payload, meta_message_attachments,
        meta_message_is_echo, meta_message_responder_type, meta_message_sender_asset_id,
        meta_profile_display_name, meta_read_message_ids, meta_receipt_watermark,
        meta_reply_to_mid, normalize_attachment_kind, parse_meta_conversation_identifier,
        sanitize_attachment_filename, scoped_conversation, select_meta_attachment_url,
        verify_meta_signature, HmacSha256, MetaMessageAnalyticsRow,
    };
    use hmac::Mac;
    use serde_json::{json, Value};

    fn analytics_message(sender: &str, metadata: Value) -> MetaMessageAnalyticsRow {
        MetaMessageAnalyticsRow {
            id: "message-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            channel: "facebook".to_string(),
            sender: sender.to_string(),
            message_type: Some("TEXT".to_string()),
            provider_metadata: Some(metadata),
            org_id: Some("org-1".to_string()),
        }
    }

    #[test]
    fn meta_analytics_attribution_keeps_customer_human_agent_and_system_distinct() {
        assert_eq!(
            meta_message_responder_type(&analytics_message("customer", json!({}))),
            "customer"
        );
        assert_eq!(
            meta_message_responder_type(&analytics_message(
                "bot",
                json!({ "_kasitek_agent_idempotency_key": "run-1" })
            )),
            "agent"
        );
        assert_eq!(
            meta_message_responder_type(&analytics_message(
                "bot",
                json!({ "_kasitek_inbox_message_kind": "template" })
            )),
            "system"
        );
        assert_eq!(
            meta_message_responder_type(&analytics_message("bot", json!({}))),
            "human"
        );
    }

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
    fn direct_instagram_profile_query_only_requests_supported_sender_fields() {
        let (graph_base, fields) = meta_customer_profile_query(true, "INSTAGRAM");

        assert_eq!(graph_base, super::INSTAGRAM_GRAPH_BASE);
        assert_eq!(fields, "name,username");
        assert!(!fields.contains("profile_picture_url"));
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

        let string_watermark = json!({ "watermark": "1785260850401" });
        assert_eq!(
            meta_receipt_watermark(&string_watermark),
            Some(1_785_260_850_401_i64)
        );
    }

    #[test]
    fn instagram_seen_receipts_use_the_exact_message_id() {
        let receipt = json!({ "mid": "instagram-message-1" });
        assert_eq!(
            meta_read_message_ids(&receipt),
            vec!["instagram-message-1".to_string()]
        );

        let alternate_receipt = json!({
            "mids": ["message-2", "message-1", "message-2"],
            "message_id": "message-3"
        });
        assert_eq!(
            meta_read_message_ids(&alternate_receipt),
            vec![
                "message-1".to_string(),
                "message-2".to_string(),
                "message-3".to_string()
            ]
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
    fn message_node_attachment_lookup_prefers_full_image_data() {
        let payload = json!({
            "attachments": {
                "data": [{
                    "id": "sticker_42",
                    "url": "https://scontent.xx.fbcdn.net/thumbnail.jpg",
                    "image_data": {
                        "url": "https://scontent.xx.fbcdn.net/full-sticker.png"
                    }
                }]
            }
        });

        assert_eq!(
            select_meta_attachment_url(&payload, Some("sticker_42"), true).as_deref(),
            Some("https://scontent.xx.fbcdn.net/full-sticker.png")
        );
    }

    #[test]
    fn attachment_edge_lookup_supports_single_sticker_fallback() {
        let payload = json!({
            "data": [{
                "id": "opaque-provider-id",
                "url": "https://scontent.xx.fbcdn.net/full-sticker.png"
            }]
        });

        assert_eq!(
            select_meta_attachment_url(&payload, None, true).as_deref(),
            Some("https://scontent.xx.fbcdn.net/full-sticker.png")
        );
    }

    #[test]
    fn graph_sticker_ids_are_classified_without_render_flag() {
        let attachments = meta_graph_message_attachments(&json!({
            "attachments": {
                "data": [{
                    "id": "sticker_987654",
                    "mime_type": "image/png",
                    "image_data": { "url": "https://scontent.xx.fbcdn.net/sticker.png" }
                }]
            }
        }));

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "sticker");
        assert_eq!(
            attachments[0].metadata.pointer("/sticker/id"),
            Some(&json!("987654"))
        );
        assert_eq!(
            attachments[0].metadata.get("providerSource"),
            Some(&json!("graph_message"))
        );
    }

    #[test]
    fn webhook_numeric_sticker_ids_are_preserved_as_strings() {
        let attachments = meta_message_attachments(&json!({
            "attachments": [{
                "type": "image",
                "payload": {
                    "url": "https://scontent.xx.fbcdn.net/sticker.png",
                    "sticker_id": 123456789
                }
            }]
        }));

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "sticker");
        assert_eq!(
            attachments[0].provider_media_id.as_deref(),
            Some("123456789")
        );
        assert_eq!(
            attachments[0].metadata.pointer("/sticker/id"),
            Some(&json!("123456789"))
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
    fn page_linked_instagram_replies_target_the_linked_facebook_page() {
        assert_eq!(
            meta_message_sender_asset_id(
                "instagram",
                false,
                Some("instagram-account-id"),
                Some(&json!({ "pageId": "facebook-page-id" })),
            ),
            Some("facebook-page-id".to_string())
        );
    }

    #[test]
    fn direct_instagram_replies_target_the_instagram_account() {
        assert_eq!(
            meta_message_sender_asset_id(
                "instagram",
                true,
                Some("instagram-account-id"),
                Some(&json!({ "authMethod": "instagram_login" })),
            ),
            Some("instagram-account-id".to_string())
        );
    }

    #[test]
    fn facebook_replies_target_the_connected_page() {
        assert_eq!(
            meta_message_sender_asset_id(
                "facebook",
                false,
                Some("facebook-page-id"),
                Some(&json!({ "pageId": "different-page-id" })),
            ),
            Some("facebook-page-id".to_string())
        );
    }

    #[test]
    fn page_linked_instagram_requires_a_linked_page_id() {
        assert_eq!(
            meta_message_sender_asset_id(
                "instagram",
                false,
                Some("instagram-account-id"),
                Some(&json!({})),
            ),
            None
        );
    }

    #[test]
    fn meta_read_receipt_marks_the_customer_conversation_seen() {
        assert_eq!(
            meta_mark_seen_payload("customer-id"),
            json!({
                "recipient": { "id": "customer-id" },
                "sender_action": "mark_seen",
            })
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
