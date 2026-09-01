//! WhatsApp provider webhook boundary.
//!
//! Meta webhook normalization, delivery status transitions, inbound message
//! ingestion, pairing, unsubscribe handling, and provider call dispatch live
//! here while the stable `whatsapp::` export remains available.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};

use crate::analytics;
use crate::config::AppConfig;
use crate::db::models::{WhatsappCampaignRecipientRow, WhatsappCampaignRow, WhatsappConnectionRow};
use crate::error::AppError;
use crate::services::agent_platform::AgentPlatformClient;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::social::decrypt_social_secret;
use crate::services::{content_media, message_domain, whatsapp_calls, whatsapp_inbox};

use super::whatsapp::{
    find_or_create_conversation, load_conversation_by_id, normalize_phone,
    parse_conversation_identifier, preview_text, publish_campaign_updated,
    publish_conversation_updated, publish_message_created, publish_message_updated,
    recompute_campaign_stats, select_connection_sql, send_text_message,
};

#[derive(Debug, FromRow)]
struct InboxMessageDeliveryRow {
    id: String,
    conversation_id: String,
    message_type: Option<String>,
    provider_metadata: Option<Value>,
    whatsapp_message_id: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}
fn get_inbound_text(message: &Value) -> Option<String> {
    message
        .get("text")
        .and_then(|v| v.get("body"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            message
                .get("button")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

fn get_inbound_approval_token(message: &Value) -> Option<&str> {
    message
        .get("interactive")
        .and_then(|value| value.get("button_reply"))
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("ka_approval_"))
}

fn approval_acknowledgement(response: &Value) -> &'static str {
    match (
        response.get("status").and_then(Value::as_str),
        response.get("decision").and_then(Value::as_str),
    ) {
        (Some("approval_already_signalled"), _) => "Already decided.",
        (Some("approval_signalled"), Some("rejected")) => "Denied.",
        (Some("approval_signalled"), Some("approved")) => "Approval received. Processing…",
        _ => "Approval received.",
    }
}

fn is_opt_out_message(text: Option<&str>) -> bool {
    text.map(|value| {
        ["stop", "unsubscribe", "cancel", "end", "optout", "opt-out"]
            .contains(&value.trim().to_ascii_lowercase().as_str())
    })
    .unwrap_or(false)
}

fn external_connection_routing_key(
    external_connection_id: Option<String>,
    whatsapp_connection_id: &str,
) -> String {
    external_connection_id.unwrap_or_else(|| format!("ext_{whatsapp_connection_id}"))
}

fn agent_external_identity(normalized_phone: &str) -> &str {
    normalized_phone
        .strip_prefix('+')
        .unwrap_or(normalized_phone)
}

fn add_optional_display_name(payload: &mut Value, profile_name: Option<&str>) {
    if let Some(display_name) = profile_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["displayName"] = json!(display_name);
    }
}

struct IncomingWhatsappMedia {
    kind: String,
    media_id: String,
    mime_type: Option<String>,
    caption: Option<String>,
    filename: Option<String>,
    sha256: Option<String>,
}

fn normalized_media_mime(value: Option<&str>) -> Option<String> {
    value
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

fn media_kind_from_mime(value: &str) -> Option<&'static str> {
    if value.starts_with("image/") {
        Some("image")
    } else if value.starts_with("video/") {
        Some("video")
    } else if value.starts_with("audio/") || value == "application/ogg" {
        Some("audio")
    } else {
        None
    }
}

fn media_mime_from_filename(value: Option<&str>) -> Option<&'static str> {
    let extension = value?.rsplit('.').next()?.trim().to_ascii_lowercase();
    match extension.as_str() {
        "gif" => Some("image/gif"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/m4a"),
        "mp3" => Some("audio/mpeg"),
        "ogg" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn agent_media_kind(media: &IncomingWhatsappMedia) -> Option<&'static str> {
    let declared_mime = normalized_media_mime(media.mime_type.as_deref());
    if let Some(mime) = declared_mime.as_deref() {
        if mime != "application/octet-stream" && mime != "binary/octet-stream" {
            return media_kind_from_mime(mime);
        }
    }
    media_mime_from_filename(media.filename.as_deref())
        .and_then(media_kind_from_mime)
        .or(match media.kind.as_str() {
            "image" | "sticker" => Some("image"),
            "video" => Some("video"),
            "audio" => Some("audio"),
            _ => None,
        })
}

fn agent_media_default_mime(kind: &str) -> &'static str {
    match kind {
        "video" => "video/mp4",
        "audio" => "audio/ogg",
        _ => "image/jpeg",
    }
}

fn agent_media_limit(kind: &str) -> usize {
    match kind {
        "video" => 512 * 1024 * 1024,
        "audio" => 25 * 1024 * 1024,
        _ => 20 * 1024 * 1024,
    }
}

fn agent_media_mime(media: &IncomingWhatsappMedia, downloaded_mime: &str, kind: &str) -> String {
    normalized_media_mime(Some(downloaded_mime))
        .filter(|value| media_kind_from_mime(value) == Some(kind))
        .or_else(|| {
            normalized_media_mime(media.mime_type.as_deref())
                .filter(|value| media_kind_from_mime(value) == Some(kind))
        })
        .or_else(|| {
            media_mime_from_filename(media.filename.as_deref())
                .filter(|value| media_kind_from_mime(value) == Some(kind))
                .map(str::to_string)
        })
        .unwrap_or_else(|| agent_media_default_mime(kind).to_string())
}

fn agent_media_failure_message(kind: &str) -> &'static str {
    match kind {
        "audio" => "I couldn't access that audio. Please try sending it again.",
        "video" => "I couldn't process that video. Please try sending it again.",
        _ => "I couldn't process that image. Please try sending it again.",
    }
}

fn agent_ingest_failure_message() -> &'static str {
    "I couldn't process that message right now. Please try again."
}

async fn acknowledge_agent_ingest_failure(
    connection: &WhatsappConnectionRow,
    recipient_phone: &str,
    provider_message_id: Option<&str>,
    reason: &str,
) {
    let access_token = match decrypt_social_secret(&connection.access_token_encrypted) {
        Ok(access_token) => access_token,
        Err(error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "whatsapp",
                operation = "channel.ingest.failure_acknowledge",
                connection_id = %connection.id,
                reason = "access_token_unavailable",
                error_type = %std::any::type_name_of_val(&error),
                "WhatsApp could not acknowledge an Agent Platform failure"
            );
            return;
        }
    };

    if let Err(error) = send_text_message(
        &connection.phone_number_id,
        &access_token,
        recipient_phone,
        agent_ingest_failure_message(),
        provider_message_id,
    )
    .await
    {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "whatsapp",
            operation = "channel.ingest.failure_acknowledge",
            connection_id = %connection.id,
            reason,
            error_type = %std::any::type_name_of_val(&error),
            "WhatsApp Agent Platform failure acknowledgement failed"
        );
    }
}

fn get_incoming_media(message: &Value) -> Option<IncomingWhatsappMedia> {
    for kind in ["image", "video", "audio", "document", "sticker"] {
        if let Some(media) = message.get(kind) {
            if let Some(media_id) = media.get("id").and_then(|v| v.as_str()) {
                return Some(IncomingWhatsappMedia {
                    kind: kind.to_string(),
                    media_id: media_id.to_string(),
                    mime_type: media
                        .get("mime_type")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    caption: media
                        .get("caption")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    filename: media
                        .get("filename")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    sha256: media
                        .get("sha256")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                });
            }
        }
    }
    None
}

fn parse_status_failure_details(status_payload: &Value) -> (Option<String>, Option<String>) {
    let Some(error) = status_payload
        .get("errors")
        .and_then(|value| value.as_array())
        .and_then(|errors| errors.first())
    else {
        return (None, None);
    };

    let code = error
        .get("code")
        .and_then(|value| value.as_i64())
        .map(|value| value.to_string())
        .or_else(|| {
            error
                .get("code")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });

    let message = [
        error.get("title").and_then(|value| value.as_str()),
        error.get("message").and_then(|value| value.as_str()),
        error
            .get("error_data")
            .and_then(|value| value.get("details"))
            .and_then(|value| value.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" | ");

    let message = if message.is_empty() {
        None
    } else {
        Some(message)
    };

    (code, message)
}

fn is_blocked_failure(code: Option<&str>, message: Option<&str>) -> bool {
    matches!(code, Some("131026") | Some("131048"))
        || message
            .map(|value| value.to_ascii_lowercase().contains("blocked"))
            .unwrap_or(false)
}

#[derive(Debug, Clone)]
struct WhatsappPricingDetails {
    billable: bool,
    category: String,
    model: Option<String>,
    pricing_type: Option<String>,
}

fn bounded_provider_value(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return None;
    }
    Some(value.to_string())
}

fn parse_status_pricing_details(status_payload: &Value) -> Option<WhatsappPricingDetails> {
    let pricing = status_payload.get("pricing")?.as_object()?;
    Some(WhatsappPricingDetails {
        billable: pricing.get("billable")?.as_bool()?,
        category: bounded_provider_value(pricing.get("category"))?,
        model: bounded_provider_value(pricing.get("pricing_model")),
        pricing_type: bounded_provider_value(pricing.get("type")),
    })
}

async fn handle_status(pool: &PgPool, status_payload: &Value) -> Result<(), AppError> {
    let Some(message_id) = status_payload.get("id").and_then(|v| v.as_str()) else {
        return Ok(());
    };
    let provider_status = match status_payload.get("status").and_then(|v| v.as_str()) {
        Some("sent") => "SENT",
        Some("delivered") => "DELIVERED",
        Some("read") => "READ",
        Some("failed") => "FAILED",
        _ => return Ok(()),
    };
    let timestamp = status_payload
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(|secs| chrono::DateTime::<Utc>::from_timestamp(secs, 0))
        .unwrap_or_else(Utc::now);
    let (failure_code, failure_message) = if provider_status == "FAILED" {
        parse_status_failure_details(status_payload)
    } else {
        (None, None)
    };
    let pricing = parse_status_pricing_details(status_payload);
    let next_status = if provider_status == "FAILED"
        && is_blocked_failure(failure_code.as_deref(), failure_message.as_deref())
    {
        "BLOCKED"
    } else {
        provider_status
    };
    observability::tracing::info!(
        event = "provider.call.completed",
        provider = "whatsapp",
        operation = "message.status_webhook",
        message_id = %message_id,
        next_status = %next_status,
        timestamp = %timestamp,
        error_code = ?failure_code,
        "WhatsApp message status received"
    );

    if let Some(recipient) = sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
        r#"
        SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
               "snapshotPhone" AS snapshot_phone, "snapshotFullName" AS snapshot_full_name,
               "snapshotLocation" AS snapshot_location, "snapshotListLabel" AS snapshot_list_label,
               "snapshotMetadata" AS snapshot_metadata,
               "waMessageId" AS wa_message_id,
               "sentAt" AT TIME ZONE 'UTC' AS sent_at,
               "deliveredAt" AT TIME ZONE 'UTC' AS delivered_at,
               "readAt" AT TIME ZONE 'UTC' AS read_at,
               "failedAt" AT TIME ZONE 'UTC' AS failed_at,
               "attemptCount" AS attempt_count,
               "lastAttemptAt" AT TIME ZONE 'UTC' AS last_attempt_at,
               "errorCode" AS error_code,
               "errorMessage" AS error_message,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCampaignRecipient" WHERE "waMessageId" = $1 LIMIT 1
        "#,
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?
    {
        if recipient.status != next_status {
            let mut status_transaction = pool.begin().await?;
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"),
                    "deliveredAt" = CASE WHEN $1 = 'DELIVERED' THEN $2 ELSE "deliveredAt" END,
                    "readAt" = CASE WHEN $1 = 'READ' THEN $2 ELSE "readAt" END,
                    "failedAt" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $2 ELSE "failedAt" END,
                    "errorCode" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $3 ELSE "errorCode" END,
                    "errorMessage" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $4 ELSE "errorMessage" END,
                    "updatedAt" = NOW()
                WHERE id = $5
                "#,
            )
            .bind(next_status)
            .bind(timestamp)
            .bind(failure_code.as_deref())
            .bind(failure_message.as_deref())
            .bind(&recipient.id)
            .execute(&mut *status_transaction)
            .await?;
            if matches!(next_status, "DELIVERED" | "READ" | "FAILED" | "BLOCKED") {
                let organization_id = sqlx::query_scalar::<_, String>(
                    r#"SELECT "orgId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&recipient.campaign_id)
                .fetch_one(&mut *status_transaction)
                .await?;
                let result = match next_status {
                    "DELIVERED" => {
                        analytics::campaigns::enqueue_recipient_delivered(
                            &mut status_transaction,
                            &organization_id,
                            &recipient.campaign_id,
                            &recipient.id,
                            "whatsapp",
                            "meta",
                            timestamp,
                        )
                        .await
                    }
                    "READ" => {
                        analytics::campaigns::enqueue_recipient_read(
                            &mut status_transaction,
                            &organization_id,
                            &recipient.campaign_id,
                            &recipient.id,
                            "whatsapp",
                            "meta",
                            timestamp,
                        )
                        .await
                    }
                    "FAILED" => {
                        analytics::campaigns::enqueue_recipient_failed(
                            &mut status_transaction,
                            &organization_id,
                            &recipient.campaign_id,
                            &recipient.id,
                            "whatsapp",
                            "meta",
                            "provider_rejected",
                            timestamp,
                        )
                        .await
                    }
                    "BLOCKED" => {
                        analytics::campaigns::enqueue_recipient_blocked(
                            &mut status_transaction,
                            &organization_id,
                            &recipient.campaign_id,
                            &recipient.id,
                            "whatsapp",
                            "meta",
                            "provider_blocked",
                            timestamp,
                        )
                        .await
                    }
                    _ => unreachable!("status was checked before analytics publication"),
                };
                result.map_err(|error| {
                    AppError::Internal(format!("Failed to queue Campaign analytics fact: {error}"))
                })?;
                let timing_facts = match next_status {
                    "DELIVERED" => recipient.sent_at.map(|sent_at| {
                        vec![(
                            "send_to_delivered",
                            timestamp
                                .signed_duration_since(sent_at)
                                .num_milliseconds()
                                .max(0),
                        )]
                    }),
                    "READ" => {
                        let mut facts = Vec::new();
                        if let Some(sent_at) = recipient.sent_at {
                            facts.push((
                                "send_to_read",
                                timestamp
                                    .signed_duration_since(sent_at)
                                    .num_milliseconds()
                                    .max(0),
                            ));
                        }
                        if let Some(delivered_at) = recipient.delivered_at {
                            facts.push((
                                "delivered_to_read",
                                timestamp
                                    .signed_duration_since(delivered_at)
                                    .num_milliseconds()
                                    .max(0),
                            ));
                        }
                        Some(facts)
                    }
                    _ => None,
                };
                if let Some(timing_facts) = timing_facts {
                    for (timing_kind, duration_ms) in timing_facts {
                        analytics::campaigns::enqueue_recipient_timing(
                            &mut status_transaction,
                            &organization_id,
                            &recipient.campaign_id,
                            &recipient.id,
                            "whatsapp",
                            "meta",
                            timing_kind,
                            duration_ms,
                            timestamp,
                        )
                        .await
                        .map_err(|error| {
                            AppError::Internal(format!(
                                "Failed to queue Campaign timing analytics fact: {error}"
                            ))
                        })?;
                    }
                }
            }
            status_transaction.commit().await?;
            if matches!(next_status, "FAILED" | "BLOCKED") {
                let campaign = sqlx::query_as::<_, WhatsappCampaignRow>(
                    r#"
                    SELECT c.id, c."userId" AS user_id, c."orgId" AS org_id, c."connectionId" AS connection_id, c."templateId" AS template_id,
                           c.name, c.description, c."templateName" AS template_name, c."templateLanguage" AS template_language,
                           c."variableMappings" AS variable_mappings,
                           wt.header AS template_header, wt.body AS template_body, wt.footer AS template_footer, wt.buttons AS template_buttons,
                           c."listLabel" AS list_label, c."defaultBatchSize" AS default_batch_size, c.status::text AS status,
                           c."scheduledAt" AT TIME ZONE 'UTC' AS scheduled_at, c."launchedAt" AT TIME ZONE 'UTC' AS launched_at,
                           c."completedAt" AT TIME ZONE 'UTC' AS completed_at, c."totalRecipients" AS total_recipients,
                           c."sentCount" AS sent_count, c."deliveredCount" AS delivered_count, c."readCount" AS read_count,
                           c."failedCount" AS failed_count, c."blockedCount" AS blocked_count, c."unsubscribedCount" AS unsubscribed_count,
                           c."createdAt" AT TIME ZONE 'UTC' AS created_at, c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
                           COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
                           wt.status::text AS template_status
                    FROM "WhatsappCampaign" c
                    LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
                    LEFT JOIN "WhatsappTemplate" wt ON wt.id = c."templateId"
                    WHERE c.id = $1
                    LIMIT 1
                    "#,
                )
                .bind(&recipient.campaign_id)
                .fetch_optional(pool)
                .await?;

                if let Some(campaign) = campaign {
                    let phone = recipient.snapshot_phone.clone().unwrap_or_default();
                    sqlx::query(
                        r#"
                        INSERT INTO "WhatsappSendEvent" (
                            id, "userId", "connectionId", "campaignId", "recipientId", "contactId", phone, "templateName",
                            status, "whatsappMessageId", "responsePayload", "errorCode", "errorMessage", "createdAt"
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                                CAST($9 AS "WhatsappRecipientStatus"), $10, $11, $12, $13, NOW())
                        "#,
                    )
                    .bind(cuid2::create_id())
                    .bind(&campaign.user_id)
                    .bind(&campaign.connection_id)
                    .bind(&campaign.id)
                    .bind(&recipient.id)
                    .bind(&recipient.contact_id)
                    .bind(&phone)
                    .bind(&campaign.template_name)
                    .bind(next_status)
                    .bind(message_id)
                    .bind(status_payload)
                    .bind(failure_code.as_deref())
                    .bind(failure_message.as_deref())
                    .execute(pool)
                    .await?;

                    observability::tracing::error!(
                        event = "provider.call.failed",
                        provider = "whatsapp",
                        operation = "campaign.delivery_status",
                        campaign_id = %campaign.id,
                        recipient_id = %recipient.id,
                        message_id = %message_id,
                        error_code = ?failure_code,
                        outcome = %next_status,
                        "WhatsApp campaign delivery failed"
                    );
                } else {
                    observability::tracing::error!(
                        event = "provider.call.failed",
                        provider = "whatsapp",
                        operation = "campaign.delivery_status",
                        recipient_id = %recipient.id,
                        message_id = %message_id,
                        error_code = ?failure_code,
                        outcome = %next_status,
                        reason = "campaign_not_found",
                        "WhatsApp campaign delivery status had no campaign row"
                    );
                }
            }
            observability::tracing::info!(
                event = "provider.call.completed",
                provider = "whatsapp",
                operation = "campaign.delivery_status",
                recipient_id = %recipient.id,
                campaign_id = %recipient.campaign_id,
                previous_status = %recipient.status,
                next_status = %next_status,
                message_id = %message_id,
                "WhatsApp campaign delivery status applied"
            );
            recompute_campaign_stats(pool, &recipient.campaign_id).await?;
            if let Some(user_id) = sqlx::query_scalar::<_, String>(
                r#"SELECT "userId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
            )
            .bind(&recipient.campaign_id)
            .fetch_optional(pool)
            .await?
            {
                publish_campaign_updated(pool, &user_id, &recipient.campaign_id).await?;
            }
        }
        if let Some(pricing) = pricing {
            let mut pricing_transaction = pool.begin().await?;
            let organization_id = sqlx::query_scalar::<_, String>(
                r#"SELECT "orgId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
            )
            .bind(&recipient.campaign_id)
            .fetch_one(&mut *pricing_transaction)
            .await?;
            sqlx::query(
                r#"
                UPDATE "WhatsappSendEvent"
                SET "whatsappPricingBillable" = $1,
                    "whatsappPricingCategory" = $2,
                    "whatsappPricingModel" = $3,
                    "whatsappPricingType" = $4
                WHERE "campaignId" = $5 AND "recipientId" = $6 AND "whatsappMessageId" = $7
                "#,
            )
            .bind(pricing.billable)
            .bind(&pricing.category)
            .bind(pricing.model.as_deref())
            .bind(pricing.pricing_type.as_deref())
            .bind(&recipient.campaign_id)
            .bind(&recipient.id)
            .bind(message_id)
            .execute(&mut *pricing_transaction)
            .await?;
            analytics::campaigns::enqueue_recipient_pricing(
                &mut pricing_transaction,
                &organization_id,
                &recipient.campaign_id,
                &recipient.id,
                "whatsapp",
                "meta",
                pricing.billable,
                &pricing.category,
                pricing.model.as_deref(),
                pricing.pricing_type.as_deref(),
                timestamp,
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to queue Campaign pricing analytics fact: {error}"
                ))
            })?;
            pricing_transaction.commit().await?;
        }
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    let rows = sqlx::query_as::<_, InboxMessageDeliveryRow>(
        r#"
        UPDATE "Message" message
        SET "whatsappStatus" = $1
        FROM "Conversation" conversation
        WHERE message."conversationId" = conversation.id
          AND message."whatsappMessageId" = $2
          AND message.sender = 'bot'
          AND COALESCE(message."whatsappStatus", '') <> $1
        RETURNING message.id,
                  message."conversationId" AS conversation_id,
                  message."contentType"::text AS message_type,
                  message."providerMetadata" AS provider_metadata,
                  message."whatsappMessageId" AS whatsapp_message_id,
                  message."errorCode" AS error_code,
                  message."errorMessage" AS error_message
        "#,
    )
    .bind(next_status)
    .bind(message_id)
    .fetch_all(&mut *tx)
    .await?;
    for row in &rows {
        let responder_type = if row
            .provider_metadata
            .as_ref()
            .and_then(|value| value.get("_kasitek_agent_idempotency_key"))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            "agent"
        } else if row
            .provider_metadata
            .as_ref()
            .and_then(|value| value.get("_kasitek_inbox_message_kind"))
            .and_then(Value::as_str)
            == Some("template")
        {
            "system"
        } else {
            "human"
        };
        let message_type = row
            .message_type
            .as_deref()
            .unwrap_or("text")
            .to_ascii_lowercase();
        let delivery_status = next_status.to_ascii_lowercase();
        let org_id =
            sqlx::query_scalar::<_, String>(r#"SELECT "orgId" FROM "Conversation" WHERE id = $1"#)
                .bind(&row.conversation_id)
                .fetch_one(&mut *tx)
                .await?;
        analytics::inbox::enqueue_message_lifecycle(
            &mut tx,
            &org_id,
            &row.id,
            &row.conversation_id,
            "whatsapp",
            "delivery_updated",
            "outbound",
            responder_type,
            &message_type,
            Some(&delivery_status),
            None,
            timestamp,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
        })?;
    }
    tx.commit().await?;
    for row in rows {
        message_domain::record_event(
            pool,
            &row.conversation_id,
            Some(&row.id),
            row.whatsapp_message_id
                .as_deref()
                .map(|provider_id| format!("whatsapp:status:{provider_id}:{next_status}"))
                .as_deref(),
            &format!("STATUS_{next_status}"),
            json!({ "provider": "whatsapp", "status": next_status }),
        )
        .await?;
        if let Some(conversation) = load_conversation_by_id(pool, &row.conversation_id).await? {
            if let Some((connection_id, _)) =
                parse_conversation_identifier(&conversation.customer_identifier)
            {
                let user_id = sqlx::query_scalar::<_, String>(
                    r#"SELECT "userId" FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&connection_id)
                .fetch_optional(pool)
                .await?;
                if let Some(user_id) = user_id {
                    publish_message_updated(
                        pool,
                        &user_id,
                        &row.conversation_id,
                        &row.id,
                        next_status,
                        row.error_code.as_deref(),
                        row.error_message.as_deref(),
                    )
                    .await;
                }
            }
        }
    }
    Ok(())
}

async fn handle_incoming_messages(
    pool: &PgPool,
    config: &AppConfig,
    value: &Value,
) -> Result<(), AppError> {
    let phone_number_id = value
        .get("metadata")
        .and_then(|v| v.get("phone_number_id"))
        .and_then(|v| v.as_str());
    let Some(phone_number_id) = phone_number_id else {
        return Ok(());
    };
    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!(
        "{} WHERE \"phoneNumberId\" = $1 LIMIT 1",
        select_connection_sql()
    ))
    .bind(phone_number_id)
    .fetch_optional(pool)
    .await?;
    let Some(connection) = connection else {
        return Ok(());
    };
    let Some(org_id) = connection.org_id.as_deref() else {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "whatsapp",
            operation = "webhook.resolve_organization",
            connection_id = %connection.id,
            reason = "organization_not_found",
            "WhatsApp webhook ignored for connection without organization"
        );
        return Ok(());
    };
    // The dashboard assigns agent channels using the workspace-facing
    // ExternalConnection id (ext_<WhatsappConnection id>). The webhook starts
    // with the provider record, so resolve that same id before forwarding the
    // event to Agent Platform. Keep the deterministic fallback for a webhook
    // that arrives before the connection projection has been synchronized.
    let channel_key = external_connection_routing_key(
        sqlx::query_scalar::<_, String>(
            r#"SELECT id
               FROM "ExternalConnection"
               WHERE "orgId" = $1 AND "sourceType" = 'WHATSAPP' AND "sourceId" = $2
               LIMIT 1"#,
        )
        .bind(org_id)
        .bind(&connection.id)
        .fetch_optional(pool)
        .await?,
        &connection.id,
    );
    let contacts = value
        .get("contacts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let messages = value
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for message in messages {
        let from = message.get("from").and_then(|v| v.as_str()).unwrap_or("");
        if from.trim().is_empty() {
            continue;
        }
        let normalized_phone = normalize_phone(from);
        if normalized_phone.is_empty() {
            continue;
        }
        let agent_identity = agent_external_identity(&normalized_phone);
        let text = get_inbound_text(&message);
        let media = get_incoming_media(&message);

        if let Some(approval_token) = get_inbound_approval_token(&message) {
            let decision_response = match AgentPlatformClient::from_config(config) {
                Ok(agent_client) => match agent_client
                    .decide_channel_approval(
                        org_id,
                        &connection.user_id,
                        json!({
                            "token": approval_token,
                            "channelType": "whatsapp",
                            "externalIdentity": agent_identity,
                        }),
                    )
                    .await
                {
                    Ok(response) => Some(response),
                    Err(error) => {
                        observability::tracing::warn!(
                            event = "operation.failed",
                            operation = "whatsapp.approval.decide",
                            error_type = %std::any::type_name_of_val(&error),
                            "WhatsApp approval decision failed"
                        );
                        None
                    }
                },
                Err(error) => {
                    observability::tracing::warn!(
                        event = "dependency.unavailable",
                        dependency = "agent_platform",
                        operation = "whatsapp.approval.decide",
                        error_type = %std::any::type_name_of_val(&error),
                        "WhatsApp approval client unavailable"
                    );
                    None
                }
            };
            let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
            let acknowledgement = decision_response
                .as_ref()
                .map(approval_acknowledgement)
                .unwrap_or("Approval could not be processed. Try again.");
            if let Err(error) = send_text_message(
                &connection.phone_number_id,
                &access_token,
                &normalized_phone,
                acknowledgement,
                message.get("id").and_then(Value::as_str),
            )
            .await
            {
                observability::tracing::warn!(
                    event = "provider.call.failed",
                    provider = "whatsapp",
                    operation = "approval.acknowledge",
                    error_type = %std::any::type_name_of_val(&error),
                    "WhatsApp approval acknowledgement failed"
                );
            }
            continue;
        }

        // Pairing must be checked before the known-contact filter. A new external
        // identity is expected to be absent from the provider contact list until
        // the one-time pairing code has been consumed.
        if let Some(pairing_token) = text.as_deref().map(str::trim).filter(|value| {
            value.starts_with("kasiai_pair_") && !value.chars().any(char::is_whitespace)
        }) {
            let paired = if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                agent_client
                    .consume_channel_pairing(
                        org_id,
                        &connection.user_id,
                        pairing_token,
                        agent_identity,
                    )
                    .await
                    .is_ok()
            } else {
                false
            };
            let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
            let acknowledgement = if paired {
                "WhatsApp is now connected to your KasiAi conversation."
            } else {
                "That KasiAi pairing code is invalid or expired. Create a new code in KasiTek and try again."
            };
            if let Err(error) = send_text_message(
                &connection.phone_number_id,
                &access_token,
                &normalized_phone,
                acknowledgement,
                message.get("id").and_then(Value::as_str),
            )
            .await
            {
                observability::tracing::warn!(
                    event = "provider.call.failed",
                    provider = "whatsapp",
                    operation = "pairing.acknowledge",
                    error_type = %std::any::type_name_of_val(&error),
                    "KasiAi WhatsApp pairing acknowledgement failed"
                );
            }
            // Pairing tokens are credentials. Never persist them in the business
            // Inbox or forward them into model-visible conversation history.
            continue;
        }
        if text.is_none() && media.is_none() {
            continue;
        }
        let profile_name = contacts
            .iter()
            .find(|contact| contact.get("wa_id").and_then(|v| v.as_str()) == Some(from))
            .and_then(|contact| contact.get("profile"))
            .and_then(|profile| profile.get("name"))
            .and_then(|v| v.as_str());
        let (conversation_id, unread_count, _last, customer_id) = find_or_create_conversation(
            pool,
            org_id,
            &connection.id,
            &normalized_phone,
            profile_name,
        )
        .await?;
        let contact_id = {
            let existing = sqlx::query_scalar::<_, String>(
                r#"SELECT id FROM "WhatsappContact" WHERE "orgId" = $1 AND phone = $2 LIMIT 1"#,
            )
            .bind(org_id)
            .bind(&normalized_phone)
            .fetch_optional(pool)
            .await?;
            match existing {
                Some(id) => {
                    sqlx::query(r#"UPDATE "WhatsappContact" SET "fullName" = COALESCE($1, "fullName"), "updatedAt" = NOW() WHERE id = $2"#)
                        .bind(profile_name)
                        .bind(&id)
                        .execute(pool)
                        .await?;
                    id
                }
                None => {
                    let id = cuid2::create_id();
                    sqlx::query(
                        r#"
                        INSERT INTO "WhatsappContact" (id, "userId", "orgId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
                        VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, NOW(), NOW())
                        "#,
                    )
                    .bind(&id)
                    .bind(&connection.user_id)
                    .bind(org_id)
                    .bind(&normalized_phone)
                    .bind(profile_name)
                    .execute(pool)
                    .await?;
                    id
                }
            }
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
        let content = text
            .clone()
            .or_else(|| media.as_ref().and_then(|value| value.caption.clone()))
            .unwrap_or_default();
        let message_id = cuid2::create_id();
        let wa_message_id = message.get("id").and_then(|v| v.as_str());
        let occurred_at = Utc::now();
        let mut tx = pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", timestamp)
            VALUES ($1, $2, 'customer', $3, $4, $5, $6)
            "#,
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&content)
        .bind(if media.is_some() { "MEDIA" } else { "TEXT" })
        .bind(wa_message_id)
        .bind(occurred_at)
        .execute(&mut *tx)
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
        .execute(&mut *tx)
        .await?;
        analytics::inbox::enqueue_message_lifecycle(
            &mut tx,
            org_id,
            &message_id,
            &conversation_id,
            "whatsapp",
            "created",
            "inbound",
            "customer",
            if media.is_some() { "media" } else { "text" },
            None,
            None,
            occurred_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to queue Inbox analytics fact: {error}"))
        })?;
        tx.commit().await?;
        if let Some(media) = media.as_ref() {
            message_domain::create_attachment(
                pool,
                &message_id,
                Some(&media.media_id),
                &media.kind,
                media.mime_type.as_deref(),
                media.filename.as_deref(),
                media.sha256.as_deref(),
                json!({ "source": "whatsapp_webhook" }),
            )
            .await?;
        }
        publish_message_created(pool, &connection.user_id, &message_id).await?;
        publish_conversation_updated(pool, &connection.user_id, &conversation_id).await?;
        let mut agent_media = None;
        if let (Some(media), Some(provider_message_id)) = (media.as_ref(), wa_message_id) {
            let Some(media_kind) = agent_media_kind(media) else {
                observability::tracing::warn!(
                    event = "operation.rejected",
                    provider = "whatsapp",
                    operation = "media.unsupported",
                    media_kind = %media.kind,
                    "WhatsApp inbound attachment type is not supported by the agent"
                );
                let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
                let _ = send_text_message(
                    &connection.phone_number_id,
                    &access_token,
                    &normalized_phone,
                    "I can process image, video, and audio attachments. Please send the file in one of those formats.",
                    Some(provider_message_id),
                )
                .await;
                continue;
            };
            let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
            match whatsapp_inbox::download_media_bytes(
                &access_token,
                &media.media_id,
                Some(agent_media_limit(media_kind)),
            )
            .await
            {
                Ok((bytes, downloaded_mime_type)) => {
                    let mime_type = agent_media_mime(media, &downloaded_mime_type, media_kind);
                    match content_media::upload_content_media_bytes(
                        pool,
                        config,
                        &connection.user_id,
                        org_id,
                        content_media::ContentMediaBytesUpload {
                            file_name: media.filename.clone(),
                            mime_type: mime_type.clone(),
                            bytes,
                            source: "whatsapp".to_string(),
                            source_key: Some(format!(
                                "whatsapp:{}:{}:{}",
                                connection.id, provider_message_id, media.media_id
                            )),
                        },
                    )
                    .await
                    {
                        Ok(asset) => {
                            observability::tracing::info!(
                                event = "operation.completed",
                                provider = "whatsapp",
                                operation = "media.store",
                                media_kind,
                                byte_size = asset.byte_size,
                                "WhatsApp inbound attachment stored"
                            );
                            agent_media = Some((asset, mime_type));
                        }
                        Err(error) => observability::tracing::warn!(
                            event = "operation.failed",
                            operation = "whatsapp.media.store",
                            media_kind,
                            error_type = %std::any::type_name_of_val(&error),
                            "WhatsApp inbound media storage failed"
                        ),
                    }
                }
                Err(error) => observability::tracing::warn!(
                    event = "provider.call.failed",
                    provider = "whatsapp",
                    operation = "media.download",
                    media_kind,
                    error_type = %std::any::type_name_of_val(&error),
                    "WhatsApp inbound media download failed"
                ),
            }
            if agent_media.is_none() {
                if let Err(error) = send_text_message(
                    &connection.phone_number_id,
                    &access_token,
                    &normalized_phone,
                    agent_media_failure_message(media_kind),
                    Some(provider_message_id),
                )
                .await
                {
                    observability::tracing::warn!(
                        event = "provider.call.failed",
                        provider = "whatsapp",
                        operation = "media.failure_acknowledge",
                        error_type = %std::any::type_name_of_val(&error),
                        "WhatsApp media failure acknowledgement failed"
                    );
                }
                // The media-specific acknowledgement is the terminal outcome for
                // this message. Do not also send the generic Agent Platform
                // failure response when the platform is unavailable.
                continue;
            }
        }
        if let Some(provider_message_id) = wa_message_id {
            if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                let (message_type, message_content) = match agent_media.as_ref() {
                    Some((asset, mime_type)) => {
                        let mut attachment = json!({
                            "assetId": asset.id,
                            "attachmentId": media.as_ref().map(|value| value.media_id.as_str()),
                            "mimeType": mime_type,
                            "fileName": media.as_ref().and_then(|value| value.filename.as_deref()),
                            "mediaKind": asset.kind,
                            "text": content.clone(),
                        });
                        if media.as_ref().and_then(agent_media_kind) == Some("audio") {
                            attachment["transcription"] =
                                json!({ "status": "queued", "provider": "elevenlabs" });
                        }
                        ("attachment", attachment)
                    }
                    None if media.is_none() => ("text", json!({ "text": content })),
                    None => continue,
                };
                let mut payload = json!({
                    "channelType": "whatsapp",
                    "channelKey": channel_key.clone(),
                    "provider": "meta-whatsapp",
                    "providerEventId": provider_message_id,
                    "providerMessageId": provider_message_id,
                    "externalIdentity": agent_identity,
                    "externalConversationId": conversation_id,
                    "messageType": message_type,
                    "content": message_content,
                });
                add_optional_display_name(&mut payload, profile_name);
                observability::tracing::info!(
                    event = "provider.call.started",
                    provider = "kasitek-agents",
                    operation = "channel.ingest",
                    conversation_id = %conversation_id,
                    channel_key = %payload["channelKey"].as_str().unwrap_or("unknown"),
                    provider_message_id = %provider_message_id,
                    "WhatsApp inbound message forwarding started"
                );
                let ingest_result = agent_client
                    .ingest_channel_message(org_id, &connection.user_id, payload)
                    .await;
                match ingest_result {
                    Ok(_) => observability::tracing::info!(
                        event = "provider.call.completed",
                        provider = "kasitek-agents",
                        operation = "channel.ingest",
                        conversation_id = %conversation_id,
                        channel_key = %channel_key,
                        provider_message_id = %provider_message_id,
                        "WhatsApp inbound message accepted by agent"
                    ),
                    Err(error) => {
                        observability::tracing::warn!(
                            event = "provider.call.failed",
                            provider = "kasitek-agents",
                            operation = "channel.ingest",
                            conversation_id = %conversation_id,
                            channel_key = %channel_key,
                            error_code = error.code(),
                            error_type = %std::any::type_name_of_val(&error),
                            "WhatsApp inbound message was not accepted"
                        );
                        acknowledge_agent_ingest_failure(
                            &connection,
                            &normalized_phone,
                            Some(provider_message_id),
                            error.code(),
                        )
                        .await;
                    }
                }
            } else {
                observability::tracing::warn!(
                    event = "dependency.unavailable",
                    dependency = "agent_platform",
                    operation = "channel.ingest",
                    conversation_id = %conversation_id,
                    channel_key = %channel_key,
                    reason = "missing_configuration",
                    "Agent Platform is not configured for inbound WhatsApp message"
                );
                acknowledge_agent_ingest_failure(
                    &connection,
                    &normalized_phone,
                    Some(provider_message_id),
                    "missing_configuration",
                )
                .await;
            }
        }
        if let Err(error) = send_push_notification_to_user(
            pool,
            config,
            &connection.user_id,
            PushNotificationPayload {
                title: "New WhatsApp message".to_string(),
                body: format!(
                    "{}: {}",
                    profile_name
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(normalized_phone.as_str()),
                    preview_text(&content, 120)
                ),
                url: "/inbox".to_string(),
                tag: Some(format!("conversation:{conversation_id}")),
            },
        )
        .await
        {
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "push_notification.send",
                provider = "whatsapp",
                conversation_id = %conversation_id,
                user_id = %connection.user_id,
                error_type = %std::any::type_name_of_val(&error),
                "push notification for incoming WhatsApp message failed"
            );
        }

        if is_opt_out_message(text.as_deref()) {
            let occurred_at = Utc::now();
            let mut transaction = pool.begin().await?;
            sqlx::query(r#"UPDATE "WhatsappContact" SET excluded = true, "optIn" = false, notes = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(format!("Unsubscribed via STOP keyword on {}", Utc::now().to_rfc3339()))
                .bind(&contact_id)
                .execute(&mut *transaction)
                .await?;
            let campaign_recipients = sqlx::query_as::<_, (String, String)>(
                r#"SELECT "campaignId", id FROM "WhatsappCampaignRecipient" WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")"#,
            )
            .bind(&contact_id)
            .fetch_all(&mut *transaction)
            .await?;
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = 'UNSUBSCRIBED'::"WhatsappRecipientStatus",
                    "errorCode" = 'unsubscribed',
                    "errorMessage" = 'Contact unsubscribed via inbound keyword',
                    "updatedAt" = NOW()
                WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")
                "#,
            )
            .bind(&contact_id)
            .execute(&mut *transaction)
            .await?;
            for (campaign_id, recipient_id) in &campaign_recipients {
                analytics::campaigns::enqueue_recipient_unsubscribed(
                    &mut transaction,
                    org_id,
                    campaign_id,
                    recipient_id,
                    "whatsapp",
                    "meta",
                    "keyword",
                    occurred_at,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to queue Campaign analytics fact: {error}"))
                })?;
            }
            transaction.commit().await?;
            let campaign_ids = campaign_recipients
                .into_iter()
                .map(|(campaign_id, _)| campaign_id)
                .collect::<std::collections::HashSet<_>>();
            for campaign_id in campaign_ids {
                recompute_campaign_stats(pool, &campaign_id).await?;
                if let Some(user_id) = sqlx::query_scalar::<_, String>(
                    r#"SELECT "userId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&campaign_id)
                .fetch_optional(pool)
                .await?
                {
                    publish_campaign_updated(pool, &user_id, &campaign_id).await?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        add_optional_display_name, agent_external_identity, agent_ingest_failure_message,
        agent_media_kind, agent_media_mime, approval_acknowledgement,
        external_connection_routing_key, get_inbound_approval_token, get_incoming_media,
        is_blocked_failure, is_opt_out_message, parse_status_pricing_details,
    };

    #[test]
    fn uses_digits_only_identity_for_agent_channel_routing() {
        assert_eq!(agent_external_identity("+263774266830"), "263774266830");
        assert_eq!(agent_external_identity("263774266830"), "263774266830");
    }

    #[test]
    fn omits_missing_or_blank_display_names_from_agent_payloads() {
        let mut payload = json!({ "content": { "text": "hello" } });
        add_optional_display_name(&mut payload, None);
        assert!(payload.get("displayName").is_none());

        add_optional_display_name(&mut payload, Some("  Enock Chirima  "));
        assert_eq!(payload["displayName"], "Enock Chirima");
    }

    #[test]
    fn uses_workspace_external_connection_id_for_agent_routing() {
        assert_eq!(
            external_connection_routing_key(Some("ext_whatsapp-1".to_string()), "whatsapp-1"),
            "ext_whatsapp-1"
        );
    }

    #[test]
    fn falls_back_to_the_deterministic_external_connection_id() {
        assert_eq!(
            external_connection_routing_key(None, "whatsapp-1"),
            "ext_whatsapp-1"
        );
    }

    #[test]
    fn accepts_image_documents_when_meta_omits_a_specific_mime_type() {
        let media = get_incoming_media(&json!({
            "document": {
                "id": "media-1",
                "filename": "announcement.JPG",
                "mime_type": "application/octet-stream"
            }
        }))
        .expect("incoming media");

        assert_eq!(agent_media_kind(&media), Some("image"));
        assert_eq!(
            agent_media_mime(&media, "application/octet-stream", "image"),
            "image/jpeg"
        );
    }

    #[test]
    fn supports_whatsapp_video_media_and_rejects_unreadable_documents() {
        let video = get_incoming_media(&json!({
            "video": { "id": "media-video", "mime_type": "video/mp4" }
        }))
        .expect("incoming video");
        assert_eq!(agent_media_kind(&video), Some("video"));

        let document = get_incoming_media(&json!({
            "document": { "id": "media-pdf", "mime_type": "application/pdf", "filename": "brief.pdf" }
        }))
        .expect("incoming document");
        assert_eq!(agent_media_kind(&document), None);
    }

    #[test]
    fn recognizes_case_insensitive_stop_keywords() {
        for keyword in [
            "STOP",
            "unsubscribe",
            " Cancel ",
            "end",
            "optout",
            "opt-out",
        ] {
            assert!(
                is_opt_out_message(Some(keyword)),
                "{keyword} should opt out"
            );
        }
    }

    #[test]
    fn ignores_empty_and_non_opt_out_messages() {
        assert!(!is_opt_out_message(None));
        assert!(!is_opt_out_message(Some("stop please")));
        assert!(!is_opt_out_message(Some("hello")));
    }

    #[test]
    fn classifies_only_bounded_provider_block_signals() {
        assert!(is_blocked_failure(Some("131026"), None));
        assert!(is_blocked_failure(None, Some("Recipient is blocked")));
        assert!(!is_blocked_failure(
            Some("131047"),
            Some("Temporary failure")
        ));
    }

    #[test]
    fn extracts_bounded_whatsapp_pricing_metadata() {
        let pricing = parse_status_pricing_details(&json!({
            "pricing": {
                "billable": true,
                "category": "marketing",
                "pricing_model": "CBP",
                "type": "regular"
            }
        }))
        .expect("pricing metadata");
        assert!(pricing.billable);
        assert_eq!(pricing.category, "marketing");
        assert_eq!(pricing.model.as_deref(), Some("CBP"));
        assert_eq!(pricing.pricing_type.as_deref(), Some("regular"));
    }

    #[test]
    fn rejects_unbounded_or_incomplete_whatsapp_pricing_metadata() {
        assert!(parse_status_pricing_details(&json!({
            "pricing": { "billable": true, "category": "marketing/category" }
        }))
        .is_none());
        assert!(parse_status_pricing_details(&json!({
            "pricing": { "category": "marketing" }
        }))
        .is_none());
    }

    #[test]
    fn extracts_only_approval_shaped_button_ids() {
        let token = "ka_approval_compact-token";
        assert_eq!(
            get_inbound_approval_token(&json!({
                "interactive": { "button_reply": { "id": token, "title": "Approve" } }
            })),
            Some(token)
        );
        assert_eq!(
            get_inbound_approval_token(&json!({
                "button": { "text": "Approve", "payload": "approve" }
            })),
            None
        );
    }

    #[test]
    fn reports_approval_progress_without_claiming_success() {
        assert_eq!(
            approval_acknowledgement(&json!({
                "status": "approval_signalled",
                "decision": "approved"
            })),
            "Approval received. Processing…"
        );
        assert_eq!(
            approval_acknowledgement(&json!({
                "status": "approval_signalled",
                "decision": "rejected"
            })),
            "Denied."
        );
        assert_eq!(
            approval_acknowledgement(&json!({ "status": "approval_already_signalled" })),
            "Already decided."
        );
    }

    #[test]
    fn provides_a_terminal_message_when_agent_ingest_is_rejected() {
        assert_eq!(
            agent_ingest_failure_message(),
            "I couldn't process that message right now. Please try again."
        );
    }
}

pub async fn process_webhook_payload(
    pool: &PgPool,
    config: &AppConfig,
    payload: Value,
) -> Result<(), AppError> {
    let entries = payload
        .get("entry")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in entries {
        let changes = entry
            .get("changes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for change in changes {
            let value = change.get("value").cloned().unwrap_or(Value::Null);
            let statuses = value
                .get("statuses")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for status in statuses {
                handle_status(pool, &status).await?;
                let phone_number_id = value
                    .get("metadata")
                    .and_then(|metadata| metadata.get("phone_number_id"))
                    .and_then(Value::as_str);
                let provider_message_id = status.get("id").and_then(Value::as_str);
                let provider_status = status.get("status").and_then(Value::as_str);
                if let (Some(phone_number_id), Some(provider_message_id), Some(provider_status)) =
                    (phone_number_id, provider_message_id, provider_status)
                {
                    let connection_scope = sqlx::query_as::<_, (String, String)>(
                        r#"SELECT "orgId", "userId" FROM "WhatsappConnection"
                           WHERE "phoneNumberId" = $1 AND "orgId" IS NOT NULL LIMIT 1"#,
                    )
                    .bind(phone_number_id)
                    .fetch_optional(pool)
                    .await?;
                    if let Some((org_id, user_id)) = connection_scope {
                        if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                            let normalized_status =
                                match provider_status.to_ascii_lowercase().as_str() {
                                    "sent" => "sent",
                                    "delivered" => "delivered",
                                    "read" => "read",
                                    "failed" => "failed",
                                    _ => "unknown",
                                };
                            let (failure_code, failure_message) =
                                parse_status_failure_details(&status);
                            let mut payload = json!({
                                "providerMessageId": provider_message_id,
                                "status": normalized_status,
                            });
                            if normalized_status == "failed" {
                                payload["error"] =
                                    json!({ "code": failure_code, "message": failure_message });
                            }
                            if let Err(error) = agent_client
                                .update_channel_delivery_status(&org_id, &user_id, payload)
                                .await
                            {
                                observability::tracing::debug!(
                                    event = "operation.failed",
                                    operation = "channel.delivery_status",
                                    provider = "kasitek-agents",
                                    message_id = %provider_message_id,
                                    error_type = %std::any::type_name_of_val(&error),
                                    reason = "message_not_mapped",
                                    "WhatsApp status did not map to a KasiAi delivery"
                                );
                            }
                        }
                    }
                }
            }
            whatsapp_calls::ingest_webhook_calls(pool, config, &value).await?;
            handle_incoming_messages(pool, config, &value).await?;
        }
    }
    Ok(())
}
