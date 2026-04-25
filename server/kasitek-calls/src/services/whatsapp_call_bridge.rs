use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{WhatsappCallBridgeEventRequest, WhatsappCallSessionRow};
use crate::error::AppError;
use crate::services::realtime;

async fn scoped_call_row_by_id(
    pool: &PgPool,
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
        WHERE s.id = $1
        LIMIT 1
        "#,
    )
    .bind(call_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn scoped_call_row_by_wa_call_id(
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

async fn publish_call_event(user_id: &str, event: Value) {
    if let Err(error) = realtime::publish_whatsapp_event(user_id, &event).await {
        log::warn!(
            "failed to publish whatsapp bridge realtime event: {}",
            error
        );
    }
}

fn bridge_source(input: &WhatsappCallBridgeEventRequest) -> &str {
    input
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("bridge")
}

fn normalized_status(value: Option<&str>) -> Option<&'static str> {
    match value.map(|item| item.trim().to_uppercase()) {
        Some(value) if value == "RINGING" => Some("RINGING"),
        Some(value) if value == "CONNECTING" => Some("CONNECTING"),
        Some(value) if value == "ACTIVE" => Some("ACTIVE"),
        Some(value) if value == "COMPLETED" => Some("COMPLETED"),
        Some(value) if value == "REJECTED" => Some("REJECTED"),
        Some(value) if value == "MISSED" => Some("MISSED"),
        Some(value) if value == "FAILED" => Some("FAILED"),
        Some(value) if value == "CANCELLED" => Some("CANCELLED"),
        _ => None,
    }
}

pub fn bridge_contract(config: &AppConfig) -> Value {
    json!({
        "provider": config.whatsapp_call_provider,
        "webhook": {
            "path": "/api/webhooks/whatsapp/calls/bridge",
            "authHeader": "x-kasitek-call-bridge-token",
            "expectsEnv": "WHATSAPP_CALL_BRIDGE_TOKEN",
        },
        "identifiers": {
            "preferred": ["callId", "waCallId"],
            "note": "At least one of callId or waCallId is required"
        },
        "supportedStatuses": [
            "RINGING", "CONNECTING", "ACTIVE", "COMPLETED",
            "REJECTED", "MISSED", "FAILED", "CANCELLED"
        ],
        "supportedSignalKinds": [
            "offer", "answer", "candidate", "bye"
        ],
        "examplePayload": {
            "callId": "call_session_id",
            "waCallId": "optional_provider_call_id",
            "eventType": "remote_answer",
            "status": "ACTIVE",
            "signalKind": "answer",
            "signalPayload": {
                "type": "answer",
                "sdp": "..."
            },
            "payload": {
                "provider": config.whatsapp_call_provider,
                "note": "raw provider payload"
            },
            "source": "bridge"
        }
    })
}

pub async fn ingest_bridge_event(
    pool: &PgPool,
    input: &WhatsappCallBridgeEventRequest,
) -> Result<Value, AppError> {
    let initial_call = if let Some(call_id) = input
        .call_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        scoped_call_row_by_id(pool, call_id).await?
    } else if let Some(wa_call_id) = input
        .wa_call_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        scoped_call_row_by_wa_call_id(pool, wa_call_id).await?
    } else {
        None
    }
    .ok_or_else(|| AppError::NotFound("Call session not found for bridge event".to_string()))?;

    let next_status = normalized_status(input.status.as_deref());
    if let Some(status) = next_status {
        let now = Utc::now();
        let answered_at = if status == "ACTIVE" {
            Some(initial_call.answered_at.unwrap_or(now))
        } else {
            initial_call.answered_at
        };
        let ended_at = if matches!(
            status,
            "COMPLETED" | "REJECTED" | "MISSED" | "FAILED" | "CANCELLED"
        ) {
            Some(initial_call.ended_at.unwrap_or(now))
        } else {
            initial_call.ended_at
        };
        let duration_seconds = answered_at
            .zip(ended_at)
            .map(|(answered, ended)| (ended - answered).num_seconds().max(0) as i32);

        sqlx::query(
            r#"
            UPDATE "WhatsappCallSession"
            SET status = CAST($1 AS "WhatsappCallStatus"),
                "answeredAt" = $2,
                "endedAt" = $3,
                "durationSeconds" = COALESCE($4, "durationSeconds"),
                "updatedAt" = NOW()
            WHERE id = $5
            "#,
        )
        .bind(status)
        .bind(answered_at)
        .bind(ended_at)
        .bind(duration_seconds)
        .bind(&initial_call.id)
        .execute(pool)
        .await?;
    }

    let call = scoped_call_row_by_id(pool, &initial_call.id)
        .await?
        .ok_or_else(|| AppError::Internal("Updated call session could not be reloaded".to_string()))?;

    let bridge_event_type = format!(
        "call.bridge.{}",
        input
            .event_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("update")
            .to_lowercase()
    );
    append_call_event(
        pool,
        &call.id,
        &bridge_event_type,
        Some(call.status.as_str()),
        json!({
            "source": bridge_source(input),
            "payload": input.payload.clone().unwrap_or(Value::Null),
            "signalKind": input.signal_kind,
            "signalPayload": input.signal_payload.clone().unwrap_or(Value::Null),
        }),
    )
    .await?;

    if let Some(kind) = input
        .signal_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let signal_event_type = format!("call.signal.{}", kind.to_lowercase());
        append_call_event(
            pool,
            &call.id,
            &signal_event_type,
            Some(call.status.as_str()),
            json!({
                "kind": kind,
                "source": bridge_source(input),
                "payload": input.signal_payload.clone().unwrap_or(Value::Null),
            }),
        )
        .await?;

        publish_call_event(
            &call.user_id,
            json!({
                "type": "call.signal",
                "callId": call.id,
                "kind": kind,
                "source": bridge_source(input),
                "signal": input.signal_payload.clone().unwrap_or(Value::Null),
                "call": {
                    "id": call.id,
                    "connectionId": call.connection_id,
                    "conversationId": call.conversation_id,
                    "direction": call.direction,
                    "status": call.status,
                    "fromPhone": call.from_phone,
                    "toPhone": call.to_phone,
                    "agentLabel": call.agent_label,
                    "connectionLabel": call.connection_label,
                    "conversationCustomerName": call.conversation_customer_name,
                    "startedAt": call.started_at,
                    "answeredAt": call.answered_at,
                    "endedAt": call.ended_at,
                },
            }),
        )
        .await;
    }

    if let Some(status) = next_status {
        publish_call_event(
            &call.user_id,
            json!({
                "type": "call.updated",
                "callId": call.id,
                "action": "bridge",
                "call": {
                    "id": call.id,
                    "connectionId": call.connection_id,
                    "conversationId": call.conversation_id,
                    "direction": call.direction,
                    "status": status,
                    "fromPhone": call.from_phone,
                    "toPhone": call.to_phone,
                    "agentLabel": call.agent_label,
                    "connectionLabel": call.connection_label,
                    "conversationCustomerName": call.conversation_customer_name,
                    "startedAt": call.started_at,
                    "answeredAt": call.answered_at,
                    "endedAt": call.ended_at,
                },
            }),
        )
        .await;
    }

    Ok(json!({
        "ok": true,
        "callId": call.id,
        "waCallId": call.wa_call_id,
        "updatedStatus": next_status,
    }))
}
