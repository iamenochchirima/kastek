//! WhatsApp provider webhook boundary.
//!
//! Meta webhook normalization, delivery status transitions, inbound message
//! ingestion, pairing, unsubscribe handling, and provider call dispatch live
//! here while the stable `whatsapp::` export remains available.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    MessageRow, WhatsappCampaignRecipientRow, WhatsappCampaignRow, WhatsappConnectionRow,
};
use crate::error::AppError;
use crate::services::agent_platform::AgentPlatformClient;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::social::decrypt_social_secret;
use crate::services::{message_domain, whatsapp_calls};

use super::whatsapp::{
    find_or_create_conversation, load_conversation_by_id, normalize_phone,
    parse_conversation_identifier, preview_text, publish_campaign_updated,
    publish_conversation_updated, publish_message_created, publish_message_updated,
    recompute_campaign_stats, select_connection_sql, send_text_message,
};
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

struct IncomingWhatsappMedia {
    kind: String,
    media_id: String,
    mime_type: Option<String>,
    caption: Option<String>,
    filename: Option<String>,
    sha256: Option<String>,
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

async fn handle_status(pool: &PgPool, status_payload: &Value) -> Result<(), AppError> {
    let Some(message_id) = status_payload.get("id").and_then(|v| v.as_str()) else {
        return Ok(());
    };
    let next_status = match status_payload.get("status").and_then(|v| v.as_str()) {
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
    let (failure_code, failure_message) = if next_status == "FAILED" {
        parse_status_failure_details(status_payload)
    } else {
        (None, None)
    };
    log::info!(
        "[whatsapp-status] received message_id={} next_status={} timestamp={} code={:?} message={:?}",
        message_id,
        next_status,
        timestamp,
        failure_code,
        failure_message
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
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"),
                    "deliveredAt" = CASE WHEN $1 = 'DELIVERED' THEN $2 ELSE "deliveredAt" END,
                    "readAt" = CASE WHEN $1 = 'READ' THEN $2 ELSE "readAt" END,
                    "failedAt" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $2 ELSE "failedAt" END,
                    "errorCode" = CASE WHEN $1 = 'FAILED' THEN $3 ELSE "errorCode" END,
                    "errorMessage" = CASE WHEN $1 = 'FAILED' THEN $4 ELSE "errorMessage" END,
                    "updatedAt" = NOW()
                WHERE id = $5
                "#,
            )
            .bind(next_status)
            .bind(timestamp)
            .bind(failure_code.as_deref())
            .bind(failure_message.as_deref())
            .bind(&recipient.id)
            .execute(pool)
            .await?;
            if next_status == "FAILED" {
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
                                'FAILED'::"WhatsappRecipientStatus", $9, $10, $11, $12, NOW())
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
                    .bind(message_id)
                    .bind(status_payload)
                    .bind(failure_code.as_deref())
                    .bind(failure_message.as_deref())
                    .execute(pool)
                    .await?;

                    log::error!(
                        "[whatsapp-status] campaign delivery failed campaign_id={} recipient_id={} message_id={} code={:?} message={:?} payload={}",
                        campaign.id,
                        recipient.id,
                        message_id,
                        failure_code,
                        failure_message,
                        status_payload
                    );
                } else {
                    log::error!(
                        "[whatsapp-status] failed status for campaign recipient without campaign row recipient_id={} message_id={} code={:?} message={:?} payload={}",
                        recipient.id,
                        message_id,
                        failure_code,
                        failure_message,
                        status_payload
                    );
                }
            }
            log::info!(
                "[whatsapp-status] mapped to campaign recipient recipient_id={} campaign_id={} prior_status={} next_status={} wa_message_id={}",
                recipient.id,
                recipient.campaign_id,
                recipient.status,
                next_status,
                message_id
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
        return Ok(());
    }

    sqlx::query(
        r#"
        UPDATE "Message"
        SET "whatsappStatus" = $1
        WHERE "whatsappMessageId" = $2 AND sender = 'bot'
        "#,
    )
    .bind(next_status)
    .bind(message_id)
    .execute(pool)
    .await?;

    let rows = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "whatsappMessageId" = $1 AND sender = 'bot'
        "#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
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
        log::warn!(
            "ignoring WhatsApp webhook for connection without organisation: {}",
            connection.id
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
        let text = get_inbound_text(&message);
        let media = get_incoming_media(&message);

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
                        &normalized_phone,
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
                log::warn!("KasiAi WhatsApp pairing acknowledgement failed: {}", error);
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
        sqlx::query(
            r#"
            INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", timestamp)
            VALUES ($1, $2, 'customer', $3, $4, $5, NOW())
            "#,
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&content)
        .bind(if media.is_some() { "MEDIA" } else { "TEXT" })
        .bind(wa_message_id)
        .execute(pool)
        .await?;
        if let Some(media) = media {
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
        publish_message_created(pool, &connection.user_id, &message_id).await?;
        publish_conversation_updated(pool, &connection.user_id, &conversation_id).await?;
        if let (Some(inbound_text), Some(provider_message_id)) = (text.as_deref(), wa_message_id) {
            if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                let payload = json!({
                    "channelType": "whatsapp",
                    "channelKey": channel_key.clone(),
                    "provider": "meta-whatsapp",
                    "providerEventId": provider_message_id,
                    "providerMessageId": provider_message_id,
                    "externalIdentity": normalized_phone,
                    "externalConversationId": conversation_id,
                    "messageType": "text",
                    "content": { "text": inbound_text },
                    "displayName": profile_name,
                });
                log::info!(
                    "[whatsapp-agent] forwarding inbound message conversation_id={} channel_key={} provider_message_id={}",
                    conversation_id,
                    payload["channelKey"].as_str().unwrap_or("unknown"),
                    provider_message_id,
                );
                if let Err(error) = agent_client
                    .ingest_channel_message(org_id, &connection.user_id, payload)
                    .await
                {
                    log::warn!(
                        "[whatsapp-agent] inbound message was not accepted conversation_id={} channel_key={}: {}",
                        conversation_id,
                        channel_key,
                        error
                    );
                }
            } else {
                log::warn!(
                    "[whatsapp-agent] Agent Platform is not configured for inbound message conversation_id={} channel_key={}",
                    conversation_id,
                    channel_key,
                );
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
            log::warn!(
                "failed to send push notification for incoming whatsapp message conversation_id={} user_id={}: {}",
                conversation_id,
                connection.user_id,
                error
            );
        }

        if is_opt_out_message(text.as_deref()) {
            sqlx::query(r#"UPDATE "WhatsappContact" SET excluded = true, "optIn" = false, notes = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(format!("Unsubscribed via STOP keyword on {}", Utc::now().to_rfc3339()))
                .bind(&contact_id)
                .execute(pool)
                .await?;
            let campaign_ids = sqlx::query_scalar::<_, String>(
                r#"SELECT "campaignId" FROM "WhatsappCampaignRecipient" WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")"#,
            )
            .bind(&contact_id)
            .fetch_all(pool)
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
            .execute(pool)
            .await?;
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
    use super::{external_connection_routing_key, is_opt_out_message};

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
                                log::debug!(
                                    "WhatsApp status did not map to a KasiAi delivery message_id={}: {}",
                                    provider_message_id,
                                    error
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
