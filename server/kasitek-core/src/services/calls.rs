use serde_json::{json, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{CommunicationCallRow, VoiceConnectionCreateRequest};
use crate::error::AppError;

const TWILIO_PROVIDER: &str = "TWILIO";

pub async fn sync_whatsapp_calls(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", "conversationId", "whatsappSessionId",
            direction, status, "fromPhone", "toPhone", "agentLabel", "startedAt", "answeredAt", "endedAt",
            "durationSeconds", "errorCode", "errorMessage", "rawPayload", "createdAt", "updatedAt"
        )
        SELECT
            'call_' || session.id, $1, 'WHATSAPP', session."waCallId", external.id, session."conversationId", session.id,
            session.direction::text, session.status::text, session."fromPhone", session."toPhone", session."agentLabel",
            session."startedAt", session."answeredAt", session."endedAt", session."durationSeconds", session."errorCode",
            session."errorMessage", session."rawPayload", session."createdAt", session."updatedAt"
        FROM "WhatsappCallSession" session
        INNER JOIN "WhatsappConnection" connection ON connection.id = session."connectionId"
        LEFT JOIN "ExternalConnection" external
          ON external."orgId" = $1
         AND external."sourceType" = 'WHATSAPP'
         AND external."sourceId" = connection.id
        WHERE connection."orgId" = $1
        ON CONFLICT ("whatsappSessionId") DO UPDATE SET
            "providerCallId" = EXCLUDED."providerCallId",
            "connectionId" = EXCLUDED."connectionId",
            "conversationId" = EXCLUDED."conversationId",
            status = EXCLUDED.status,
            "agentLabel" = EXCLUDED."agentLabel",
            "startedAt" = EXCLUDED."startedAt",
            "answeredAt" = EXCLUDED."answeredAt",
            "endedAt" = EXCLUDED."endedAt",
            "durationSeconds" = EXCLUDED."durationSeconds",
            "errorCode" = EXCLUDED."errorCode",
            "errorMessage" = EXCLUDED."errorMessage",
            "rawPayload" = EXCLUDED."rawPayload",
            "updatedAt" = EXCLUDED."updatedAt"
        "#,
    )
    .bind(org_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_calls(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<CommunicationCallRow>, AppError> {
    sync_whatsapp_calls(pool, org_id).await?;
    sqlx::query_as::<_, CommunicationCallRow>(
        r#"
        SELECT call.id, call.provider, call."providerCallId" AS provider_call_id,
               call."connectionId" AS connection_id, call."conversationId" AS conversation_id,
               call.direction, call.status, call."fromPhone" AS from_phone, call."toPhone" AS to_phone,
               call."agentLabel" AS agent_label, call."startedAt" AT TIME ZONE 'UTC' AS started_at,
               call."answeredAt" AT TIME ZONE 'UTC' AS answered_at, call."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               call."durationSeconds" AS duration_seconds, call."errorCode" AS error_code,
               call."errorMessage" AS error_message, connection."displayName" AS connection_label,
               conversation."customerName" AS conversation_customer_name,
               call."createdAt" AT TIME ZONE 'UTC' AS created_at,
               call."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "CommunicationCall" call
        LEFT JOIN "ExternalConnection" connection ON connection.id = call."connectionId"
        LEFT JOIN "Conversation" conversation ON conversation.id = call."conversationId"
        WHERE call."orgId" = $1
        ORDER BY COALESCE(call."startedAt", call."createdAt") DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn call_summary(pool: &PgPool, org_id: &str, days: i64) -> Result<Value, AppError> {
    sync_whatsapp_calls(pool, org_id).await?;
    let days = days.clamp(1, 90);
    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        r#"
        SELECT COUNT(*)::bigint,
               COUNT(*) FILTER (WHERE direction = 'INBOUND')::bigint,
               COUNT(*) FILTER (WHERE direction = 'OUTBOUND')::bigint,
               COUNT(*) FILTER (WHERE status IN ('RINGING', 'CONNECTING', 'ACTIVE'))::bigint,
               COUNT(*) FILTER (WHERE status = 'MISSED')::bigint,
               COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint
        FROM "CommunicationCall"
        WHERE "orgId" = $1
          AND "createdAt" >= NOW() - ($2 * INTERVAL '1 day')
        "#,
    )
    .bind(org_id)
    .bind(days)
    .fetch_one(pool)
    .await?;

    Ok(json!({
        "days": days,
        "summary": {
            "totalCalls": row.0,
            "inboundCalls": row.1,
            "outboundCalls": row.2,
            "ringingCalls": row.3,
            "activeCalls": row.3,
            "completedCalls": row.5,
            "missedCalls": row.4,
            "failedCalls": 0,
            "rejectedCalls": 0,
            "recentCalls": row.0
        },
        "trend": []
    }))
}

pub fn provider_status(config: &AppConfig) -> Value {
    json!({
        "providers": [{
            "provider": TWILIO_PROVIDER,
            "configured": config.twilio_voice_configured(),
            "requiredEnvironment": [
                "TWILIO_ACCOUNT_SID",
                "TWILIO_AUTH_TOKEN",
                "TWILIO_TWIML_APP_SID",
                "TWILIO_VOICE_WEBHOOK_URL"
            ]
        }]
    })
}

pub async fn create_twilio_connection(
    pool: &PgPool,
    org_id: &str,
    request: &VoiceConnectionCreateRequest,
) -> Result<Value, AppError> {
    let phone_number = request
        .phone_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("A phone number is required".to_string()))?;
    let display_name = request
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(phone_number);
    let source_id = format!("twilio:{phone_number}");
    let id = format!("voice_{}", cuid2::create_id());

    let row = sqlx::query_as::<_, (String, String, String)>(
        r#"
        INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "externalAccountId", "displayName",
            status, "credentialStatus", "healthStatus", "webhookStatus", metadata, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', 'VOICE', $3, $4, $5, 'NOT_CONNECTED', 'MISSING', 'UNKNOWN', 'UNKNOWN',
                jsonb_build_object('phoneNumber', $4), NOW(), NOW())
        ON CONFLICT ("orgId", "sourceType", "sourceId") DO UPDATE SET
            "displayName" = EXCLUDED."displayName", "externalAccountId" = EXCLUDED."externalAccountId",
            metadata = EXCLUDED.metadata, "updatedAt" = NOW()
        RETURNING id, "displayName", "externalAccountId"
        "#,
    )
    .bind(id)
    .bind(org_id)
    .bind(source_id)
    .bind(phone_number)
    .bind(display_name)
    .fetch_one(pool)
    .await?;

    Ok(json!({
        "id": row.0,
        "provider": TWILIO_PROVIDER,
        "displayName": row.1,
        "phoneNumber": row.2,
        "status": "NOT_CONNECTED"
    }))
}
