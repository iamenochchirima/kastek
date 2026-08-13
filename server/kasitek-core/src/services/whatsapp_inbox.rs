//! WhatsApp inbox transport and delivery-worker boundary.
//!
//! Agent message delivery, queued inbox sends, conversations, media, reactions,
//! and organization-scoped inbox reads live here while the stable `whatsapp::`
//! exports remain available to existing callers.

use actix_multipart::Multipart;
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashSet;

use crate::db::models::{
    ConversationUpdateRequest, InboxConversationListRow, MessageRow, WhatsappReactionRequest,
    WhatsappSendMessageRequest, WhatsappStartConversationRequest, WhatsappTemplateRow,
};
use crate::error::AppError;
use crate::services::message_domain;
use crate::services::realtime;
use crate::services::social::decrypt_social_secret;

use super::whatsapp::{
    display_text, find_or_create_conversation, get_connection_row_for_org, load_conversation_by_id,
    media_kind_from_upload, normalize_phone, org_connection_ids, parse_conversation_identifier,
    preview_text, publish_conversation_updated, publish_message_created,
    publish_message_send_failed, publish_message_updated, sanitize_filename, scoped_conversation,
    send_marketing_template, send_text_message, whatsapp_http_client, PendingInboxMessageRow,
    GRAPH_BASE,
};
pub async fn deliver_agent_message(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    text: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp conversation not found".to_string()))?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid WhatsApp conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (provider_message_id, _) = send_text_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        text,
        None,
    )
    .await?;
    Ok(json!({
        "providerMessageId": provider_message_id,
        "status": "sent",
    }))
}

async fn upload_whatsapp_media(
    phone_number_id: &str,
    access_token: &str,
    bytes: Vec<u8>,
    filename: &str,
    mime_type: Option<&str>,
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/media");
    let part = {
        let base = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        match mime_type.filter(|value| !value.trim().is_empty()) {
            Some(value) => base
                .mime_str(value)
                .map_err(|_| AppError::BadRequest("Attachment mime type is invalid".to_string()))?,
            None => base,
        }
    };
    let form = reqwest::multipart::Form::new()
        .text("messaging_product", "whatsapp")
        .part("file", part);

    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .multipart(form)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API media upload failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }

    let media_id = raw
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            AppError::Internal("WhatsApp media upload did not return a media id".to_string())
        })?;

    Ok((media_id.to_string(), raw))
}

async fn send_media_message(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    kind: &str,
    media_id: &str,
    caption: Option<&str>,
    filename: Option<&str>,
    context_message_id: Option<&str>,
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let media_payload = match kind {
        "image" => json!({ "id": media_id, "caption": caption }),
        "video" => json!({ "id": media_id, "caption": caption }),
        "audio" => json!({ "id": media_id }),
        _ => json!({ "id": media_id, "caption": caption, "filename": filename }),
    };
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": kind,
        kind: media_payload,
        "context": context_message_id.map(|id| json!({"message_id": id}))
    });

    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API media send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }

    let message_id = raw
        .get("messages")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::Internal(
                "WhatsApp Cloud API media send did not return a message id".to_string(),
            )
        })?;
    Ok((message_id.to_string(), raw))
}

async fn claim_queued_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    message_id: Option<&str>,
) -> Result<Option<PendingInboxMessageRow>, AppError> {
    let row = if let Some(message_id) = message_id {
        sqlx::query_as::<_, PendingInboxMessageRow>(
            r#"
            SELECT
                m.id,
                m."conversationId" AS conversation_id,
                wc."userId" AS user_id,
                c."customerIdentifier" AS customer_identifier,
                wc."phoneNumberId" AS phone_number_id,
                wc."accessTokenEncrypted" AS access_token_encrypted,
                m.content
            FROM "Message" m
            INNER JOIN "Conversation" c ON c.id = m."conversationId"
            INNER JOIN "WhatsappConnection" wc
                ON c.channel = 'whatsapp'
               AND c."customerIdentifier" LIKE ('wa:' || wc.id || ':%')
            WHERE m.id = $1
              AND m.sender = 'bot'
              AND m."whatsappMessageId" IS NULL
              AND COALESCE(m."whatsappStatus", 'QUEUED') = 'QUEUED'
            FOR UPDATE OF m SKIP LOCKED
            "#,
        )
        .bind(message_id)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        sqlx::query_as::<_, PendingInboxMessageRow>(
            r#"
            SELECT
                m.id,
                m."conversationId" AS conversation_id,
                wc."userId" AS user_id,
                c."customerIdentifier" AS customer_identifier,
                wc."phoneNumberId" AS phone_number_id,
                wc."accessTokenEncrypted" AS access_token_encrypted,
                m.content
            FROM "Message" m
            INNER JOIN "Conversation" c ON c.id = m."conversationId"
            INNER JOIN "WhatsappConnection" wc
                ON c.channel = 'whatsapp'
               AND c."customerIdentifier" LIKE ('wa:' || wc.id || ':%')
            WHERE m.sender = 'bot'
              AND m."whatsappMessageId" IS NULL
              AND COALESCE(m."whatsappStatus", 'QUEUED') = 'QUEUED'
            ORDER BY m.timestamp ASC
            FOR UPDATE OF m SKIP LOCKED
            LIMIT 1
            "#,
        )
        .fetch_optional(&mut **tx)
        .await?
    };

    let Some(row) = row else {
        return Ok(None);
    };

    sqlx::query(
        r#"
        UPDATE "Message"
        SET "whatsappStatus" = 'PROCESSING', "errorCode" = NULL, "errorMessage" = NULL
        WHERE id = $1
        "#,
    )
    .bind(&row.id)
    .execute(&mut **tx)
    .await?;

    Ok(Some(row))
}

async fn process_claimed_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job: PendingInboxMessageRow,
) -> Result<(String, String, String, Option<String>), AppError> {
    let (_, phone) = parse_conversation_identifier(&job.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation identifier".to_string()))?;
    let access_token = decrypt_social_secret(&job.access_token_encrypted)?;
    let reply_to_whatsapp_message_id = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT COALESCE(reference."referencedProviderMessageId", target."whatsappMessageId")
        FROM "MessageReference" reference
        LEFT JOIN "Message" target ON target.id = reference."referencedMessageId"
        WHERE reference."messageId" = $1
        LIMIT 1
        "#,
    )
    .bind(&job.id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    log::info!(
        "[whatsapp-inbox-worker] sending queued message message_id={} conversation_id={} phone_number_id={} recipient_phone={} reply_to={:?}",
        job.id,
        job.conversation_id,
        job.phone_number_id,
        phone,
        reply_to_whatsapp_message_id
    );
    let (whatsapp_message_id, _) = send_text_message(
        &job.phone_number_id,
        &access_token,
        &phone,
        &job.content,
        reply_to_whatsapp_message_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE "Message"
        SET
            "whatsappMessageId" = $2,
            "whatsappStatus" = 'SENT',
            "errorCode" = NULL,
            "errorMessage" = NULL
        WHERE id = $1
        "#,
    )
    .bind(&job.id)
    .bind(&whatsapp_message_id)
    .execute(&mut **tx)
    .await?;

    Ok((
        job.user_id,
        job.conversation_id,
        job.id,
        Some(whatsapp_message_id),
    ))
}

async fn fail_claimed_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    message_id: &str,
    error: &AppError,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "Message"
        SET
            "whatsappStatus" = 'FAILED',
            "errorCode" = 'SEND_FAILED',
            "errorMessage" = $2
        WHERE id = $1
        "#,
    )
    .bind(message_id)
    .bind(error.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn process_single_queued_inbox_message(
    pool: &PgPool,
    explicit_message_id: Option<&str>,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let Some(job) = claim_queued_inbox_message(&mut tx, explicit_message_id).await? else {
        tx.rollback().await?;
        return Ok(false);
    };

    let message_id = job.id.clone();
    let conversation_id = job.conversation_id.clone();
    let user_id = job.user_id.clone();
    let text = display_text(&job.content);
    log::info!(
        "[whatsapp-inbox-worker] claimed queued message message_id={} conversation_id={} explicit={:?}",
        message_id,
        conversation_id,
        explicit_message_id
    );

    match process_claimed_inbox_message(&mut tx, job).await {
        Ok((_user_id, _conversation_id, _message_id, _whatsapp_message_id)) => {
            tx.commit().await?;
            log::info!(
                "[whatsapp-inbox-worker] completed queued message message_id={} conversation_id={}",
                message_id,
                conversation_id
            );
            publish_message_updated(
                pool,
                &user_id,
                &conversation_id,
                &message_id,
                "SENT",
                None,
                None,
            )
            .await;
            publish_conversation_updated(pool, &user_id, &conversation_id).await?;
            Ok(true)
        }
        Err(error) => {
            fail_claimed_inbox_message(&mut tx, &message_id, &error).await?;
            tx.commit().await?;
            log::error!(
                "[whatsapp-inbox-worker] failed queued message message_id={} conversation_id={} error={}",
                message_id,
                conversation_id,
                error
            );
            publish_message_updated(
                pool,
                &user_id,
                &conversation_id,
                &message_id,
                "FAILED",
                Some("SEND_FAILED"),
                Some(&error.to_string()),
            )
            .await;
            publish_message_send_failed(
                pool,
                &user_id,
                &conversation_id,
                &error.to_string(),
                Some(&text),
            )
            .await;
            Ok(true)
        }
    }
}

pub async fn process_queued_inbox_messages(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    if limit <= 0 {
        return Ok(0);
    }

    let max_items = limit as usize;
    let mut processed = 0_i64;
    let mut seen = HashSet::new();

    for message_id in realtime::drain_whatsapp_inbox_queue(max_items).await? {
        if !seen.insert(message_id.clone()) {
            continue;
        }
        if process_single_queued_inbox_message(pool, Some(&message_id)).await? {
            processed += 1;
            if processed >= limit {
                return Ok(processed);
            }
        }
    }

    while processed < limit {
        if !process_single_queued_inbox_message(pool, None).await? {
            break;
        }
        processed += 1;
    }

    Ok(processed)
}

async fn send_reaction_message(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    target_message_id: &str,
    emoji: &str,
) -> Result<Value, AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": "reaction",
        "reaction": {
            "message_id": target_message_id,
            "emoji": emoji,
        }
    });
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp reaction send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(raw)
}

async fn mark_message_read_api(
    phone_number_id: &str,
    access_token: &str,
    message_id: &str,
) -> Result<(), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(access_token)
        .json(&json!({
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id
        }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let raw: Value = response.json().await.unwrap_or(Value::Null);
        return Err(AppError::BadRequest(format!(
            "WhatsApp mark-as-read failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(())
}

async fn get_media_metadata(
    access_token: &str,
    media_id: &str,
) -> Result<(String, Option<String>), AppError> {
    let url = format!("{GRAPH_BASE}/{media_id}");
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp media lookup failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    let download_url = raw.get("url").and_then(|v| v.as_str()).ok_or_else(|| {
        AppError::Internal("WhatsApp media lookup did not return a download URL".to_string())
    })?;
    let mime_type = raw
        .get("mime_type")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    Ok((download_url.to_string(), mime_type))
}

async fn download_media_bytes(
    access_token: &str,
    media_id: &str,
) -> Result<(Vec<u8>, String), AppError> {
    let (download_url, mime_type) = get_media_metadata(access_token, media_id).await?;
    let response = reqwest::Client::new()
        .get(download_url)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(AppError::BadRequest(format!(
            "WhatsApp media download failed ({}): {}",
            status,
            if raw.is_empty() {
                "Unknown error"
            } else {
                &raw
            }
        )));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .or(mime_type)
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = response.bytes().await?.to_vec();
    Ok((bytes, content_type))
}

pub async fn list_inbox_conversations(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let conversations = sqlx::query_as::<_, InboxConversationListRow>(
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
            c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
            NULLIF(split_part(c."customerIdentifier", ':', 2), '') AS connection_id,
            NULLIF(substring(c."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'), '') AS phone,
            COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
            last_message.content AS last_message_content
        FROM "Conversation" c
        JOIN "WhatsappConnection" wc
          ON wc.id = split_part(c."customerIdentifier", ':', 2)
        LEFT JOIN LATERAL (
            SELECT m.content
            FROM "Message" m
            WHERE m."conversationId" = c.id
            ORDER BY m.timestamp DESC
            LIMIT 1
        ) last_message ON true
        WHERE c.channel = 'whatsapp'
          AND c."orgId" = $1
          AND c."customerIdentifier" LIKE 'wa:%'
        ORDER BY c."lastMessageAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    let mut result = Vec::with_capacity(conversations.len());
    for conversation in conversations {
        result.push(json!({
            "id": conversation.id,
            "channel": conversation.channel,
            "customerName": conversation.customer_name,
            "phone": conversation.phone.unwrap_or_else(|| conversation.customer_identifier.clone()),
            "status": conversation.status,
            "lastMessageAt": conversation.last_message_at,
            "unreadCount": conversation.unread_count,
            "starred": conversation.starred,
            "connectionId": conversation.connection_id,
            "connectionLabel": conversation.connection_label,
            "lastMessage": conversation.last_message_content
                .as_deref()
                .map(|content| preview_text(content, 180))
                .unwrap_or_else(|| "No messages yet".to_string()),
        }));
    }
    Ok(json!({ "conversations": result }))
}

pub async fn inbox_unread_count(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let count = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        SELECT COALESCE(SUM(c."unreadCount")::bigint, 0)
        FROM "Conversation" c
        JOIN "WhatsappConnection" wc
          ON wc.id = split_part(c."customerIdentifier", ':', 2)
        WHERE c.channel = 'whatsapp'
          AND c."orgId" = $1
          AND c."customerIdentifier" LIKE 'wa:%'
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?
    .unwrap_or(0);
    Ok(json!({ "unreadCount": count }))
}

pub async fn start_inbox_conversation(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    input: &WhatsappStartConversationRequest,
) -> Result<Value, AppError> {
    let connection_id = input.connection_id.as_deref().unwrap_or("");
    let template_id = input.template_id.as_deref().unwrap_or("");
    let normalized_phone = normalize_phone(input.phone.as_deref().unwrap_or(""));
    if connection_id.is_empty() || template_id.is_empty() || normalized_phone.is_empty() {
        return Err(AppError::BadRequest(
            "Connection, template, and recipient phone are required".to_string(),
        ));
    }
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AT TIME ZONE 'UTC' AS last_synced, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappTemplate"
        WHERE id = $1 AND "orgId" = $2 AND status = 'APPROVED'::"WhatsappTemplateStatus"
        LIMIT 1
        "#
    )
    .bind(template_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Approved template not found".to_string()))?;
    if template
        .connection_id
        .as_deref()
        .is_some_and(|id| id != connection.id)
    {
        return Err(AppError::BadRequest(
            "Selected template does not belong to this WhatsApp connection".to_string(),
        ));
    }
    let body_parameters = input.body_parameters.clone().unwrap_or_default();
    if body_parameters.len() as i32 != template.variables_count {
        return Err(AppError::BadRequest(format!(
            "This template expects {} variable{}.",
            template.variables_count,
            if template.variables_count == 1 {
                ""
            } else {
                "s"
            }
        )));
    }
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (message_id, _) = send_marketing_template(
        &connection.phone_number_id,
        &access_token,
        &normalized_phone,
        &template.template_name,
        &template.language,
        &body_parameters,
    )
    .await?;
    let (conversation_id, _, _, customer_id) = find_or_create_conversation(
        pool,
        org_id,
        &connection.id,
        &normalized_phone,
        input.customer_name.as_deref(),
    )
    .await?;
    let contact_id = if let Some(id) = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappContact" WHERE "orgId" = $1 AND phone = $2 LIMIT 1"#,
    )
    .bind(org_id)
    .bind(&normalized_phone)
    .fetch_optional(pool)
    .await?
    {
        id
    } else {
        let id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "WhatsappContact" (id, "userId", "orgId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, NOW(), NOW())"#,
        )
        .bind(&id)
        .bind(user_id)
        .bind(org_id)
        .bind(&normalized_phone)
        .bind(input.customer_name.as_deref())
        .execute(pool)
        .await?;
        id
    };
    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "customerId" = $1, "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(&customer_id)
    .bind(&contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;
    let rendered = template
        .body
        .clone()
        .unwrap_or_else(|| "Template message sent.".to_string());
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappMessageId", timestamp)
        VALUES ($1, $2, 'bot', $3, $4, NOW())
        "#
    )
    .bind(cuid2::create_id())
    .bind(&conversation_id)
    .bind(rendered)
    .bind(&message_id)
    .execute(pool)
    .await?;
    sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "customerName" = COALESCE($1, "customerName"), "updatedAt" = NOW() WHERE id = $2"#)
        .bind(input.customer_name.as_deref())
        .bind(&conversation_id)
        .execute(pool)
        .await?;
    publish_message_created(pool, user_id, &message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation_id).await?;
    Ok(json!({
        "success": true,
        "conversationId": conversation_id,
        "messageId": message_id,
        "category": template.category,
        "contactId": contact_id,
    }))
}

pub async fn list_conversation_messages(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let mut mapped = message_domain::list_timeline_messages(pool, &conversation.id).await?;
    for message in &mut mapped {
        let can_react = message
            .get("providerMessageId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
            && message.get("deletedAt").is_some_and(Value::is_null);
        if let Some(object) = message.as_object_mut() {
            object.insert("canReact".to_string(), json!(can_react));
        }
    }
    Ok(json!({
        "messages": mapped,
        "capabilities": message_domain::channel_capabilities("whatsapp"),
    }))
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
    let text = input
        .text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Reply text or media file is required".to_string()))?;
    parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let reply_target = if let Some(reply_to_message_id) = input
        .reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let reply_target = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
                   timestamp AT TIME ZONE 'UTC' AS timestamp
            FROM "Message"
            WHERE id = $1 AND "conversationId" = $2
            LIMIT 1
            "#
        )
        .bind(reply_to_message_id)
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Reply target not found".to_string()))?;
        let target_wa_id = reply_target.whatsapp_message_id.clone().ok_or_else(|| {
            AppError::BadRequest(
                "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
            )
        })?;
        Some((reply_target, target_wa_id))
    } else {
        None
    };
    let created_message_id = cuid2::create_id();
    log::info!(
        "[whatsapp-inbox-api] queueing message message_id={} conversation_id={} user_id={} has_reply={}",
        created_message_id,
        conversation.id,
        user_id,
        input.reply_to_message_id.as_deref().is_some_and(|value| !value.trim().is_empty())
    );
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'QUEUED', NOW())
        "#,
    )
    .bind(&created_message_id)
    .bind(&conversation.id)
    .bind(text)
    .execute(pool)
    .await?;
    if let Some((target, target_wa_id)) = reply_target {
        message_domain::create_reference(
            pool,
            &created_message_id,
            &target.id,
            Some(&target_wa_id),
            Some(&preview_text(&target.content, 180)),
            Some("TEXT"),
        )
        .await?;
    }
    sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    publish_message_created(pool, user_id, &created_message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation.id).await?;
    if let Err(error) = realtime::enqueue_whatsapp_inbox_message(&created_message_id).await {
        log::warn!(
            "failed to enqueue whatsapp inbox message {}: {}",
            created_message_id,
            error
        );
    }
    Ok(json!({ "success": true, "queued": true, "messageId": created_message_id }))
}

pub async fn send_conversation_media(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    mut payload: Multipart,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;

    let mut file_bytes = Vec::new();
    let mut filename: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut caption: Option<String> = None;
    let mut reply_to_message_id: Option<String> = None;

    while let Some(field) = payload.next().await {
        let mut field = field
            .map_err(|_| AppError::BadRequest("Failed to read multipart payload".to_string()))?;
        let Some(name) = field.name() else { continue };
        let name = name.to_string();
        if name == "file" {
            if let Some(disposition) = field.content_disposition() {
                filename = disposition.get_filename().map(sanitize_filename);
            }
            mime_type = field
                .content_type()
                .map(|value| value.essence_str().to_string());
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk
                .map_err(|_| AppError::BadRequest("Failed to read multipart field".to_string()))?;
            bytes.extend_from_slice(&chunk);
        }

        match name.as_str() {
            "file" => file_bytes = bytes,
            "caption" => {
                let value = String::from_utf8(bytes).unwrap_or_default();
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    caption = Some(trimmed);
                }
            }
            "replyToMessageId" => {
                let value = String::from_utf8(bytes).unwrap_or_default();
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    reply_to_message_id = Some(trimmed);
                }
            }
            _ => {}
        }
    }

    if file_bytes.is_empty() {
        return Err(AppError::BadRequest(
            "Attachment file is required in form-data field: file".to_string(),
        ));
    }

    let final_filename = filename
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("attachment-{}.bin", Utc::now().timestamp()));
    let media_kind = media_kind_from_upload(Some(&final_filename), mime_type.as_deref());

    let reply_target = if let Some(reply_target_message_id) = reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let reply_target = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
                   timestamp AT TIME ZONE 'UTC' AS timestamp
            FROM "Message"
            WHERE id = $1 AND "conversationId" = $2
            LIMIT 1
            "#,
        )
        .bind(reply_target_message_id)
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Reply target not found".to_string()))?;
        let target_wa_id = reply_target.whatsapp_message_id.clone().ok_or_else(|| {
            AppError::BadRequest(
                "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
            )
        })?;
        Some((reply_target, target_wa_id))
    } else {
        None
    };

    let (uploaded_media_id, upload_raw) = upload_whatsapp_media(
        &connection.phone_number_id,
        &access_token,
        file_bytes,
        &final_filename,
        mime_type.as_deref(),
    )
    .await?;
    let sha256 = upload_raw
        .get("sha256")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    let (whatsapp_message_id, _) = send_media_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        media_kind,
        &uploaded_media_id,
        caption.as_deref(),
        Some(&final_filename),
        reply_target
            .as_ref()
            .map(|(_, provider_id)| provider_id.as_str()),
    )
    .await?;

    let message_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, 'MEDIA', $4, 'SENT', NOW())
        "#,
    )
    .bind(&message_id)
    .bind(&conversation.id)
    .bind(caption.as_deref().unwrap_or_default())
    .bind(&whatsapp_message_id)
    .execute(pool)
    .await?;
    message_domain::create_attachment(
        pool,
        &message_id,
        Some(&uploaded_media_id),
        media_kind,
        mime_type.as_deref(),
        Some(&final_filename),
        sha256.as_deref(),
        json!({ "source": "whatsapp_upload" }),
    )
    .await?;
    if let Some((target, target_wa_id)) = reply_target {
        message_domain::create_reference(
            pool,
            &message_id,
            &target.id,
            Some(&target_wa_id),
            Some(&preview_text(&target.content, 180)),
            Some("TEXT"),
        )
        .await?;
    }
    sqlx::query(
        r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&conversation.id)
    .execute(pool)
    .await?;
    publish_message_created(pool, user_id, &message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation.id).await?;

    Ok(json!({
        "success": true,
        "messageId": message_id,
        "mediaId": uploaded_media_id,
        "status": "SENT"
    }))
}

pub async fn update_conversation(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    input: ConversationUpdateRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    if let Some(starred) = input.starred {
        sqlx::query(r#"UPDATE "Conversation" SET starred = $1, "updatedAt" = NOW() WHERE id = $2"#)
            .bind(starred)
            .bind(&conversation.id)
            .execute(pool)
            .await?;
    }

    publish_conversation_updated(pool, user_id, &conversation.id).await?;

    let refreshed = load_conversation_by_id(pool, &conversation.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    Ok(json!({
        "success": true,
        "conversationId": refreshed.id,
        "starred": refreshed.starred,
    }))
}

pub async fn delete_conversation(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    sqlx::query(r#"DELETE FROM "Message" WHERE "conversationId" = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    sqlx::query(r#"DELETE FROM "Conversation" WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;

    Ok(json!({
        "success": true,
        "conversationId": conversation.id,
        "deleted": true
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
    sqlx::query(r#"UPDATE "Conversation" SET "unreadCount" = 0, "lastReadAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id).await?;
    let unread_messages = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "conversationId" = $1 AND sender = 'customer' AND "whatsappMessageId" IS NOT NULL
          AND ("whatsappStatus" IS NULL OR "whatsappStatus" <> 'READ')
        ORDER BY timestamp ASC
        "#
    )
    .bind(&conversation.id)
    .fetch_all(pool)
    .await?;
    if let Some(connection) = connection {
        match decrypt_social_secret(&connection.access_token_encrypted) {
            Ok(access_token) => {
                for message in &unread_messages {
                    if let Some(wa_id) = message.whatsapp_message_id.as_deref() {
                        let _ = mark_message_read_api(
                            &connection.phone_number_id,
                            &access_token,
                            wa_id,
                        )
                        .await;
                    }
                }
            }
            Err(error) => {
                log::warn!(
                    "[whatsapp-inbox-api] failed to decrypt token while marking conversation {} read: {}",
                    conversation.id,
                    error
                );
            }
        }
    }
    let ids = unread_messages
        .into_iter()
        .map(|m| m.id)
        .collect::<Vec<_>>();
    if !ids.is_empty() {
        sqlx::query(r#"UPDATE "Message" SET "whatsappStatus" = 'READ' WHERE id = ANY($1)"#)
            .bind(&ids)
            .execute(pool)
            .await?;
    }
    publish_conversation_updated(pool, user_id, &conversation.id).await?;
    Ok(json!({ "success": true }))
}

pub async fn send_message_reaction(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    message_id: &str,
    input: WhatsappReactionRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let remove = input.remove.unwrap_or(false);
    let emoji = input.emoji.unwrap_or_default().trim().to_string();
    if !remove && emoji.is_empty() {
        return Err(AppError::BadRequest("Emoji is required".to_string()));
    }
    let target_message = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1 AND "conversationId" = $2
        LIMIT 1
        "#
    )
    .bind(message_id)
    .bind(&conversation.id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Target message not found".to_string()))?;
    let target_wa_id = target_message.whatsapp_message_id.clone().ok_or_else(|| {
        AppError::BadRequest("Target message is not available for reactions yet".to_string())
    })?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid conversation identifier".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let _ = send_reaction_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        &target_wa_id,
        if remove { "" } else { &emoji },
    )
    .await?;
    message_domain::upsert_reaction(
        pool,
        &target_message.id,
        &format!("workspace:{}", connection.id),
        if remove { None } else { Some(emoji.as_str()) },
        !remove,
        None,
        json!({
            "provider": "whatsapp",
            "targetProviderMessageId": target_wa_id,
            "source": "workspace",
        }),
    )
    .await?;
    message_domain::record_event(
        pool,
        &conversation.id,
        Some(&target_message.id),
        None,
        if remove {
            "REACTION_REMOVED"
        } else {
            "REACTION_ADDED"
        },
        json!({ "provider": "whatsapp", "emoji": if remove { "" } else { &emoji } }),
    )
    .await?;
    Ok(json!({ "success": true }))
}

pub async fn delete_conversation_message(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let result = sqlx::query(r#"DELETE FROM "Message" WHERE id = $1 AND "conversationId" = $2"#)
        .bind(message_id)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Message not found".to_string()));
    }
    if let Some(last_timestamp) = sqlx::query_scalar::<_, chrono::DateTime<Utc>>(
        r#"SELECT timestamp AT TIME ZONE 'UTC' FROM "Message" WHERE "conversationId" = $1 ORDER BY timestamp DESC LIMIT 1"#
    )
    .bind(&conversation.id)
    .fetch_optional(pool)
    .await? {
        sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = $1, "updatedAt" = NOW() WHERE id = $2"#)
            .bind(last_timestamp)
            .bind(&conversation.id)
            .execute(pool)
            .await?;
    }
    Ok(json!({ "success": true }))
}

pub async fn download_message_attachment(
    pool: &PgPool,
    org_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<actix_web::HttpResponse, AppError> {
    let connection_ids = org_connection_ids(pool, org_id).await?;
    if connection_ids.is_empty() {
        return Err(AppError::NotFound("Media message not found".to_string()));
    }
    let attachment = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>)>(
        r#"
        SELECT m."conversationId", attachment."providerMediaId", attachment."mimeType", attachment."fileName"
        FROM "Message" m
        JOIN "MessageAttachment" attachment ON attachment."messageId" = m.id
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE m.id = $1
          AND attachment.id = $2
          AND c.channel = 'whatsapp'
          AND EXISTS (
            SELECT 1 FROM unnest($3::text[]) AS connection_id
            WHERE c."customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        LIMIT 1
        "#
    )
    .bind(message_id)
    .bind(attachment_id)
    .bind(&connection_ids)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Media message not found".to_string()))?;
    let (message_conversation_id, media_id, mime_type, attachment_filename) = attachment;
    let media_id = media_id.ok_or_else(|| {
        AppError::BadRequest("Message attachment is not available from WhatsApp".to_string())
    })?;
    let conversation_identifier = sqlx::query_scalar::<_, String>(
        r#"SELECT "customerIdentifier" FROM "Conversation" WHERE id = $1"#,
    )
    .bind(&message_conversation_id)
    .fetch_one(pool)
    .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (bytes, content_type) = download_media_bytes(&access_token, &media_id).await?;
    let extension = mime_type
        .as_deref()
        .and_then(|v| v.split('/').nth(1))
        .unwrap_or("bin");
    let fallback_name = format!("whatsapp-media-{}.{}", message_id, extension);
    let filename = sanitize_filename(attachment_filename.as_deref().unwrap_or(&fallback_name));
    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", content_type))
        .append_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}
