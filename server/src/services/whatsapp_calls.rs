use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::config::AppConfig;
use crate::db::models::{
    WhatsappCallActionRequest, WhatsappCallEventRow, WhatsappCallSessionRow,
    WhatsappCallSignalRequest,
};
use crate::error::AppError;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::realtime;

async fn list_call_rows(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<WhatsappCallSessionRow>, AppError> {
    sqlx::query_as::<_, WhatsappCallSessionRow>(
        r#"
        SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE s."userId" = $1
        ORDER BY COALESCE(s."startedAt", s."createdAt") DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn scoped_call_row(
    pool: &PgPool,
    user_id: &str,
    call_id: &str,
) -> Result<Option<WhatsappCallSessionRow>, AppError> {
    sqlx::query_as::<_, WhatsappCallSessionRow>(
        r#"
        SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE s.id = $1 AND s."userId" = $2
        LIMIT 1
        "#,
    )
    .bind(call_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn call_row_by_wa_call_id(
    pool: &PgPool,
    wa_call_id: &str,
) -> Result<Option<WhatsappCallSessionRow>, AppError> {
    sqlx::query_as::<_, WhatsappCallSessionRow>(
        r#"
        SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE s."waCallId" = $1
        LIMIT 1
        "#,
    )
    .bind(wa_call_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn call_event_rows(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<WhatsappCallEventRow>, AppError> {
    sqlx::query_as::<_, WhatsappCallEventRow>(
        r#"
        SELECT id,
               "sessionId" AS session_id,
               "eventType" AS event_type,
               status::text AS status,
               payload,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "WhatsappCallEvent"
        WHERE "sessionId" = $1
        ORDER BY "createdAt" ASC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn call_signal_rows(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<WhatsappCallEventRow>, AppError> {
    sqlx::query_as::<_, WhatsappCallEventRow>(
        r#"
        SELECT id,
               "sessionId" AS session_id,
               "eventType" AS event_type,
               status::text AS status,
               payload,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "WhatsappCallEvent"
        WHERE "sessionId" = $1
          AND "eventType" LIKE 'call.signal.%'
        ORDER BY "createdAt" ASC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn publish_call_event(user_id: &str, event: Value) {
    if let Err(error) = realtime::publish_whatsapp_event(user_id, &event).await {
        log::warn!("failed to publish whatsapp call realtime event: {}", error);
    }
}

async fn append_call_event(
    pool: &PgPool,
    session_id: &str,
    event_type: &str,
    status: Option<&str>,
    payload: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "WhatsappCallEvent" (id, "sessionId", "eventType", status, payload, "createdAt")
        VALUES ($1, $2, $3, CAST($4 AS "WhatsappCallStatus"), $5, NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(session_id)
    .bind(event_type)
    .bind(status)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

fn parse_ice_servers(config: &AppConfig) -> Value {
    config
        .whatsapp_call_ice_servers_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(|value| value.is_array())
        .unwrap_or_else(|| {
            json!([
                { "urls": ["stun:stun.l.google.com:19302"] }
            ])
        })
}

fn build_media_session_payload(config: &AppConfig, call: &WhatsappCallSessionRow) -> Value {
    json!({
        "provider": config.whatsapp_call_provider,
        "callId": call.id,
        "waCallId": call.wa_call_id,
        "conversationId": call.conversation_id,
        "roomName": format!("kasitek-wa-call-{}", call.id),
        "signalingUrl": config.whatsapp_call_signaling_url,
        "iceServers": parse_ice_servers(config),
        "agentRole": "agent",
        "canAccept": call.status == "RINGING",
        "canEnd": call.status == "ACTIVE" || call.status == "CONNECTING" || call.status == "RINGING",
    })
}

async fn notify_bridge(
    config: &AppConfig,
    endpoint: &str,
    payload: &Value,
) -> Result<Option<Value>, AppError> {
    let Some(base_url) = config
        .whatsapp_call_signaling_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    let client = reqwest::Client::new();
    let mut request = client.post(&url).json(payload);
    if let Some(token) = config
        .whatsapp_call_bridge_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("x-kasitek-call-bridge-token", token);
    }
    let response = request.send().await?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "Bridge request failed ({}): {}",
            status,
            body.get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(Some(body))
}

async fn dispatch_call_provider_action(
    config: &AppConfig,
    call: &WhatsappCallSessionRow,
    action: &str,
) -> Value {
    let payload = build_media_session_payload(config, call);
    let bridge_request = json!({
        "callId": call.id,
        "waCallId": call.wa_call_id,
        "action": action,
        "call": call,
        "mediaSession": payload,
    });

    let bridge_response = match notify_bridge(
        config,
        &format!("/calls/{}/actions", call.id),
        &bridge_request,
    )
    .await
    {
        Ok(body) => body,
        Err(error) => {
            log::warn!(
                "failed to notify call bridge about action action={} call_id={}: {}",
                action,
                call.id,
                error
            );
            None
        }
    };

    json!({
        "provider": config.whatsapp_call_provider,
        "action": action,
        "mediaSession": payload,
        "bridgeResponse": bridge_response,
    })
}

fn normalize_phone(raw: &str) -> String {
    raw.chars()
        .filter(|ch| ch.is_ascii_digit() || *ch == '+')
        .collect::<String>()
}

fn parse_timestamp(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let value = value?;
    if let Some(raw) = value.as_str() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
            return Some(parsed.with_timezone(&Utc));
        }
        if let Ok(seconds) = raw.parse::<i64>() {
            return Utc.timestamp_opt(seconds, 0).single();
        }
    }
    value
        .as_i64()
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
}

fn build_conversation_identifier(connection_id: &str, phone: &str) -> String {
    format!("wa:{connection_id}:{phone}")
}

async fn find_or_create_conversation(
    pool: &PgPool,
    connection_id: &str,
    phone: &str,
    customer_name: Option<&str>,
) -> Result<String, AppError> {
    let identifier = build_conversation_identifier(connection_id, phone);
    let existing = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "Conversation"
        WHERE channel = 'whatsapp' AND "customerIdentifier" = $1
        LIMIT 1
        "#,
    )
    .bind(&identifier)
    .fetch_optional(pool)
    .await?;

    if let Some(id) = existing {
        if let Some(name) = customer_name.filter(|value| !value.trim().is_empty()) {
            sqlx::query(r#"UPDATE "Conversation" SET "customerName" = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(name)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        return Ok(id);
    }

    let id = cuid2::create_id();
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO "Conversation" (
            id, channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "createdAt", "updatedAt"
        )
        VALUES ($1, 'whatsapp', $2, $3, 'active', $4, 0, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(&identifier)
    .bind(customer_name)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(id)
}

fn map_direction(call: &Value, business_phone: &str) -> String {
    if let Some(direction) = call.get("direction").and_then(|value| value.as_str()) {
        let upper = direction.trim().to_uppercase();
        if upper == "OUTBOUND" {
            return "OUTBOUND".to_string();
        }
        if upper == "INBOUND" {
            return "INBOUND".to_string();
        }
    }

    let from = normalize_phone(
        call.get("from")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
    );
    if !business_phone.is_empty() && from == business_phone {
        "OUTBOUND".to_string()
    } else {
        "INBOUND".to_string()
    }
}

fn map_status(call: &Value) -> String {
    let event = call
        .get("event")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let status = call
        .get("call_status")
        .or_else(|| call.get("status"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let reason = call
        .get("reason")
        .or_else(|| call.get("termination_reason"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if status.contains("active") || status.contains("answered") {
        return "ACTIVE".to_string();
    }
    if event == "accept" || event == "answer" {
        return "ACTIVE".to_string();
    }
    if event == "connect" || status.contains("ring") {
        return "RINGING".to_string();
    }
    if status.contains("connect") {
        return "CONNECTING".to_string();
    }
    if event == "terminate" || status.contains("end") || status.contains("terminat") {
        if reason.contains("reject") || reason.contains("declin") {
            return "REJECTED".to_string();
        }
        if reason.contains("miss") || reason.contains("timeout") || reason.contains("no_answer") {
            return "MISSED".to_string();
        }
        if reason.contains("fail") || reason.contains("error") {
            return "FAILED".to_string();
        }
        return "COMPLETED".to_string();
    }
    "RINGING".to_string()
}

pub async fn ingest_webhook_calls(
    pool: &PgPool,
    config: &AppConfig,
    value: &Value,
) -> Result<(), AppError> {
    let calls = value
        .get("calls")
        .and_then(|payload| payload.as_array())
        .cloned()
        .unwrap_or_default();

    if calls.is_empty() {
        return Ok(());
    }

    let phone_number_id = value
        .get("metadata")
        .and_then(|payload| payload.get("phone_number_id"))
        .and_then(|payload| payload.as_str());

    let Some(phone_number_id) = phone_number_id else {
        log::warn!("whatsapp call webhook received without metadata.phone_number_id");
        return Ok(());
    };

    let connection = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"
        SELECT id,
               "userId",
               "phoneNumberId",
               "phoneDisplayNumber"
        FROM "WhatsappConnection"
        WHERE "phoneNumberId" = $1
        LIMIT 1
        "#,
    )
    .bind(phone_number_id)
    .fetch_optional(pool)
    .await?;

    let Some((connection_id, user_id, connection_phone_number_id, connection_display_number)) =
        connection
    else {
        log::warn!(
            "whatsapp call webhook received for unknown phone_number_id={}",
            phone_number_id
        );
        return Ok(());
    };

    let business_phone = normalize_phone(
        connection_display_number
            .as_deref()
            .unwrap_or(connection_phone_number_id.as_str()),
    );

    for call in calls {
        let wa_call_id = call
            .get("id")
            .or_else(|| call.get("call_id"))
            .and_then(|payload| payload.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::BadRequest("Missing WhatsApp call id in webhook payload".to_string())
            })?;

        let direction = map_direction(&call, &business_phone);
        let from_phone = normalize_phone(
            call.get("from")
                .and_then(|payload| payload.as_str())
                .unwrap_or(""),
        );
        let to_phone = normalize_phone(
            call.get("to")
                .and_then(|payload| payload.as_str())
                .unwrap_or(""),
        );
        let customer_phone = if direction == "OUTBOUND" {
            to_phone.clone()
        } else {
            from_phone.clone()
        };
        let customer_name = call
            .get("customer")
            .and_then(|payload| payload.get("name"))
            .and_then(|payload| payload.as_str())
            .or_else(|| {
                value
                    .get("contacts")
                    .and_then(|payload| payload.as_array())
                    .and_then(|contacts| {
                        contacts.iter().find_map(|contact| {
                            let wa_id = contact.get("wa_id").and_then(|value| value.as_str());
                            if wa_id.is_some_and(|wa_id| normalize_phone(wa_id) == customer_phone) {
                                contact
                                    .get("profile")
                                    .and_then(|profile| profile.get("name"))
                                    .and_then(|value| value.as_str())
                            } else {
                                None
                            }
                        })
                    })
            });
        let status = map_status(&call);
        let started_at = parse_timestamp(call.get("timestamp"))
            .or_else(|| parse_timestamp(call.get("started_at")))
            .or_else(|| parse_timestamp(call.get("start_time")));
        let answered_at = parse_timestamp(call.get("answered_at")).or_else(|| {
            if status == "ACTIVE" {
                started_at.or_else(|| Some(Utc::now()))
            } else {
                None
            }
        });
        let ended_at = parse_timestamp(call.get("ended_at")).or_else(|| {
            if matches!(
                status.as_str(),
                "COMPLETED" | "REJECTED" | "MISSED" | "FAILED" | "CANCELLED"
            ) {
                Some(Utc::now())
            } else {
                None
            }
        });
        let duration_seconds = call
            .get("duration")
            .or_else(|| call.get("duration_seconds"))
            .and_then(|payload| payload.as_i64())
            .map(|value| value.max(0) as i32)
            .or_else(|| {
                answered_at
                    .zip(ended_at)
                    .map(|(answered, ended)| (ended - answered).num_seconds().max(0) as i32)
            });
        let error_code = call
            .get("error")
            .and_then(|payload| payload.get("code"))
            .and_then(|payload| payload.as_str())
            .map(ToString::to_string);
        let error_message = call
            .get("error")
            .and_then(|payload| {
                payload
                    .get("message")
                    .or_else(|| payload.get("title"))
                    .and_then(|value| value.as_str())
            })
            .map(ToString::to_string);
        let event_type = call
            .get("event")
            .and_then(|payload| payload.as_str())
            .map(|value| format!("call.webhook.{}", value.trim().to_lowercase()))
            .unwrap_or_else(|| "call.webhook.update".to_string());
        log::info!(
            "whatsapp call webhook received wa_call_id={} user_id={} connection_id={} event_type={} direction={} status={} from_phone={} to_phone={}",
            wa_call_id,
            user_id,
            connection_id,
            event_type,
            direction,
            status,
            from_phone,
            to_phone
        );
        let raw_payload = json!({
            "source": "whatsapp-webhook",
            "metadata": value.get("metadata").cloned().unwrap_or(Value::Null),
            "call": call.clone(),
        });

        let existing = call_row_by_wa_call_id(pool, wa_call_id).await?;
        let conversation_id = if let Some(existing) = existing.as_ref() {
            existing.conversation_id.clone()
        } else if customer_phone.is_empty() {
            None
        } else {
            Some(
                find_or_create_conversation(pool, &connection_id, &customer_phone, customer_name)
                    .await?,
            )
        };

        let session_id = if let Some(existing) = existing.as_ref() {
            let previous_status = existing.status.clone();
            sqlx::query(
                r#"
                UPDATE "WhatsappCallSession"
                SET "conversationId" = COALESCE($1, "conversationId"),
                    direction = CAST($2 AS "WhatsappCallDirection"),
                    status = CAST($3 AS "WhatsappCallStatus"),
                    "fromPhone" = $4,
                    "toPhone" = $5,
                    "startedAt" = COALESCE($6, "startedAt"),
                    "answeredAt" = COALESCE($7, "answeredAt"),
                    "endedAt" = COALESCE($8, "endedAt"),
                    "durationSeconds" = COALESCE($9, "durationSeconds"),
                    "errorCode" = COALESCE($10, "errorCode"),
                    "errorMessage" = COALESCE($11, "errorMessage"),
                    "rawPayload" = $12,
                    "updatedAt" = NOW()
                WHERE id = $13
                "#,
            )
            .bind(conversation_id.as_deref())
            .bind(&direction)
            .bind(&status)
            .bind(&from_phone)
            .bind(&to_phone)
            .bind(started_at)
            .bind(answered_at)
            .bind(ended_at)
            .bind(duration_seconds)
            .bind(error_code.as_deref())
            .bind(error_message.as_deref())
            .bind(raw_payload.clone())
            .bind(&existing.id)
            .execute(pool)
            .await?;
            log::info!(
                "whatsapp call session updated session_id={} wa_call_id={} user_id={} previous_status={} next_status={}",
                existing.id,
                wa_call_id,
                user_id,
                previous_status,
                status
            );
            existing.id.clone()
        } else {
            let session_id = cuid2::create_id();
            sqlx::query(
                r#"
                INSERT INTO "WhatsappCallSession" (
                    id, "userId", "connectionId", "conversationId", direction, status, "waCallId",
                    "fromPhone", "toPhone", "rawPayload", "startedAt", "answeredAt", "endedAt",
                    "durationSeconds", "errorCode", "errorMessage", "createdAt", "updatedAt"
                )
                VALUES (
                    $1, $2, $3, $4, CAST($5 AS "WhatsappCallDirection"), CAST($6 AS "WhatsappCallStatus"), $7,
                    $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
                )
                "#,
            )
            .bind(&session_id)
            .bind(&user_id)
            .bind(&connection_id)
            .bind(conversation_id.as_deref())
            .bind(&direction)
            .bind(&status)
            .bind(wa_call_id)
            .bind(&from_phone)
            .bind(&to_phone)
            .bind(raw_payload.clone())
            .bind(started_at)
            .bind(answered_at)
            .bind(ended_at)
            .bind(duration_seconds)
            .bind(error_code.as_deref())
            .bind(error_message.as_deref())
            .execute(pool)
            .await?;
            log::info!(
                "whatsapp call session created session_id={} wa_call_id={} user_id={} status={} conversation_id={:?}",
                session_id,
                wa_call_id,
                user_id,
                status,
                conversation_id
            );
            session_id
        };

        append_call_event(pool, &session_id, &event_type, Some(&status), call.clone()).await?;

        let call_row = scoped_call_row(pool, &user_id, &session_id)
            .await?
            .ok_or_else(|| {
                AppError::Internal("Updated call session could not be loaded".to_string())
            })?;
        let event_name = if existing.is_some() {
            "call.updated"
        } else {
            "call.created"
        };

        publish_call_event(
            &user_id,
            json!({
                "type": event_name,
                "callId": call_row.id,
                "call": call_row,
            }),
        )
        .await;

        if existing.is_none() && direction == "INBOUND" && status == "RINGING" {
            let caller_label = customer_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(customer_phone.as_str());
            if let Err(error) = send_push_notification_to_user(
                pool,
                config,
                &user_id,
                PushNotificationPayload {
                    title: "Incoming WhatsApp call".to_string(),
                    body: if caller_label.is_empty() {
                        "Open KasiTek to answer".to_string()
                    } else {
                        format!("{caller_label} is calling you")
                    },
                    url: if let Some(conversation_id) = call_row.conversation_id.as_deref() {
                        format!("/inbox?conversation={conversation_id}")
                    } else {
                        "/inbox".to_string()
                    },
                    tag: Some(format!("call:{}", call_row.id)),
                },
            )
            .await
            {
                log::warn!(
                    "failed to send push notification for incoming whatsapp call call_id={} user_id={}: {}",
                    call_row.id,
                    user_id,
                    error
                );
            }
        }
    }

    Ok(())
}

pub async fn list_calls(pool: &PgPool, user_id: &str) -> Result<Value, AppError> {
    let calls = list_call_rows(pool, user_id).await?;
    Ok(json!({ "calls": calls }))
}

pub async fn call_summary(pool: &PgPool, user_id: &str, days: i64) -> Result<Value, AppError> {
    let days = days.clamp(1, 90);
    let interval_expression = format!("{} days", days);
    let totals = sqlx::query(
        r#"
        SELECT COUNT(*)::bigint AS total_calls,
               COUNT(*) FILTER (WHERE direction = 'INBOUND'::"WhatsappCallDirection")::bigint AS inbound_calls,
               COUNT(*) FILTER (WHERE direction = 'OUTBOUND'::"WhatsappCallDirection")::bigint AS outbound_calls,
               COUNT(*) FILTER (WHERE status = 'RINGING'::"WhatsappCallStatus")::bigint AS ringing_calls,
               COUNT(*) FILTER (WHERE status = 'ACTIVE'::"WhatsappCallStatus")::bigint AS active_calls,
               COUNT(*) FILTER (WHERE status = 'COMPLETED'::"WhatsappCallStatus")::bigint AS completed_calls,
               COUNT(*) FILTER (WHERE status = 'MISSED'::"WhatsappCallStatus")::bigint AS missed_calls,
               COUNT(*) FILTER (WHERE status = 'FAILED'::"WhatsappCallStatus")::bigint AS failed_calls,
               COUNT(*) FILTER (WHERE status = 'REJECTED'::"WhatsappCallStatus")::bigint AS rejected_calls,
               COUNT(*) FILTER (WHERE "createdAt" >= NOW() - CAST($2 AS interval))::bigint AS recent_calls
        FROM "WhatsappCallSession"
        WHERE "userId" = $1
        "#,
    )
    .bind(user_id)
    .bind(&interval_expression)
    .fetch_one(pool)
    .await?;

    let recent_by_day = sqlx::query(
        r#"
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
               COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE direction = 'INBOUND'::"WhatsappCallDirection")::bigint AS inbound,
               COUNT(*) FILTER (WHERE status = 'MISSED'::"WhatsappCallStatus")::bigint AS missed,
               COUNT(*) FILTER (WHERE status = 'COMPLETED'::"WhatsappCallStatus")::bigint AS completed
        FROM "WhatsappCallSession"
        WHERE "userId" = $1
          AND "createdAt" >= NOW() - CAST($2 AS interval)
        GROUP BY 1
        ORDER BY 1 DESC
        "#,
    )
    .bind(user_id)
    .bind(&interval_expression)
    .fetch_all(pool)
    .await?;

    let trend = recent_by_day
        .into_iter()
        .map(|row| {
            json!({
                "day": row.get::<String, _>("day"),
                "total": row.get::<i64, _>("total"),
                "inbound": row.get::<i64, _>("inbound"),
                "missed": row.get::<i64, _>("missed"),
                "completed": row.get::<i64, _>("completed"),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "days": days,
        "summary": {
            "totalCalls": totals.get::<i64, _>("total_calls"),
            "inboundCalls": totals.get::<i64, _>("inbound_calls"),
            "outboundCalls": totals.get::<i64, _>("outbound_calls"),
            "ringingCalls": totals.get::<i64, _>("ringing_calls"),
            "activeCalls": totals.get::<i64, _>("active_calls"),
            "completedCalls": totals.get::<i64, _>("completed_calls"),
            "missedCalls": totals.get::<i64, _>("missed_calls"),
            "failedCalls": totals.get::<i64, _>("failed_calls"),
            "rejectedCalls": totals.get::<i64, _>("rejected_calls"),
            "recentCalls": totals.get::<i64, _>("recent_calls"),
        },
        "trend": trend,
    }))
}

pub async fn get_call(pool: &PgPool, user_id: &str, call_id: &str) -> Result<Value, AppError> {
    let call = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".to_string()))?;
    let events = call_event_rows(pool, &call.id).await?;
    Ok(json!({ "call": call, "events": events }))
}

pub async fn get_call_media_session(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    call_id: &str,
) -> Result<Value, AppError> {
    let call = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".to_string()))?;

    Ok(json!({
        "call": call,
        "mediaSession": build_media_session_payload(config, &call),
    }))
}

pub async fn list_call_signals(
    pool: &PgPool,
    user_id: &str,
    call_id: &str,
) -> Result<Value, AppError> {
    let call = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".to_string()))?;
    let signals = call_signal_rows(pool, &call.id).await?;
    Ok(json!({
        "call": call,
        "signals": signals,
    }))
}

pub async fn post_call_signal(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    call_id: &str,
    input: &WhatsappCallSignalRequest,
) -> Result<Value, AppError> {
    let kind = input
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Signal kind is required".to_string()))?
        .to_lowercase();
    let existing = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".to_string()))?;
    let source = input
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent-ui");
    let signal_payload = json!({
        "kind": kind,
        "source": source,
        "payload": input.payload.clone().unwrap_or(Value::Null),
    });
    let event_type = format!("call.signal.{kind}");

    append_call_event(
        pool,
        &existing.id,
        &event_type,
        Some(&existing.status),
        signal_payload.clone(),
    )
    .await?;

    publish_call_event(
        user_id,
        json!({
            "type": "call.signal",
            "callId": existing.id,
            "kind": kind,
            "source": source,
            "signal": input.payload.clone().unwrap_or(Value::Null),
            "call": existing,
        }),
    )
    .await;

    let media_session = build_media_session_payload(config, &existing);
    let bridge_endpoint = format!("/calls/{}/signals", existing.id);
    let bridge_request = json!({
        "callId": existing.id,
        "waCallId": existing.wa_call_id,
        "kind": kind,
        "source": source,
        "signal": input.payload.clone().unwrap_or(Value::Null),
        "call": existing,
        "mediaSession": media_session,
    });
    let bridge_response = notify_bridge(config, &bridge_endpoint, &bridge_request);
    let bridge_response = match bridge_response.await {
        Ok(body) => body,
        Err(error) => {
            log::warn!(
                "failed to notify call bridge about signal kind={} call_id={}: {}",
                kind,
                call_id,
                error
            );
            None
        }
    };

    Ok(json!({
        "ok": true,
        "callId": call_id,
        "kind": kind,
        "bridgeResponse": bridge_response,
    }))
}

pub async fn apply_call_action(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    call_id: &str,
    input: &WhatsappCallActionRequest,
) -> Result<Value, AppError> {
    let action = input
        .action
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Call action is required".to_string()))?;

    let existing = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".to_string()))?;

    let now = Utc::now();
    let (next_status, answered_at, ended_at, duration_seconds, event_type) = match action {
        "accept" => (
            "ACTIVE",
            Some(existing.answered_at.unwrap_or(now)),
            None,
            None,
            "call.accepted",
        ),
        "reject" => (
            "REJECTED",
            existing.answered_at,
            Some(now),
            Some(0),
            "call.rejected",
        ),
        "end" => {
            let answered = existing.answered_at;
            let duration = answered.map(|started| (now - started).num_seconds().max(0) as i32);
            (
                if answered.is_some() {
                    "COMPLETED"
                } else {
                    "CANCELLED"
                },
                answered,
                Some(now),
                duration,
                "call.ended",
            )
        }
        _ => {
            return Err(AppError::BadRequest(
                "Unsupported call action. Use accept, reject, or end".to_string(),
            ))
        }
    };

    sqlx::query(
        r#"
        UPDATE "WhatsappCallSession"
        SET status = CAST($1 AS "WhatsappCallStatus"),
            "answeredAt" = $2,
            "endedAt" = $3,
            "durationSeconds" = COALESCE($4, "durationSeconds"),
            "updatedAt" = NOW()
        WHERE id = $5 AND "userId" = $6
        "#,
    )
    .bind(next_status)
    .bind(answered_at)
    .bind(ended_at)
    .bind(duration_seconds)
    .bind(call_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    append_call_event(
        pool,
        call_id,
        event_type,
        Some(next_status),
        json!({
            "action": action,
            "appliedAt": now,
        }),
    )
    .await?;

    let call = scoped_call_row(pool, user_id, call_id)
        .await?
        .ok_or_else(|| {
            AppError::Internal("Updated call session could not be loaded".to_string())
        })?;
    let provider_result = dispatch_call_provider_action(config, &call, action).await;

    publish_call_event(
        user_id,
        json!({
            "type": "call.updated",
            "callId": call.id,
            "call": call,
            "action": action,
            "provider": provider_result.get("provider").cloned().unwrap_or(Value::Null),
        }),
    )
    .await;

    Ok(json!({
        "call": call,
        "providerAction": provider_result,
    }))
}
