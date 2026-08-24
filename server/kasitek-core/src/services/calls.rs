use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::Sha256;
use sqlx::PgPool;
use std::collections::BTreeMap;

use crate::analytics;
use crate::config::AppConfig;
use crate::db::models::{CommunicationCallRow, VoiceConnectionCreateRequest};
use crate::error::AppError;

const TWILIO_PROVIDER: &str = "TWILIO";
type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, sqlx::FromRow)]
struct TwilioConnectionRow {
    id: String,
    #[sqlx(rename = "org_id")]
    org_id: String,
    #[sqlx(rename = "phone_number")]
    phone_number: String,
}

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
            "configured": config.twilio_voice_configured() && config.twilio_browser_configured(),
            "inboundConfigured": config.twilio_voice_configured(),
            "browserConfigured": config.twilio_browser_configured(),
            "requiredEnvironment": [
                "TWILIO_ACCOUNT_SID",
                "TWILIO_AUTH_TOKEN",
                "TWILIO_API_KEY_SID",
                "TWILIO_API_KEY_SECRET",
                "TWILIO_TWIML_APP_SID",
                "TWILIO_VOICE_WEBHOOK_URL",
                "TWILIO_BROWSER_TWIML_URL"
            ]
        }]
    })
}

pub fn create_twilio_browser_token(
    config: &AppConfig,
    org_id: &str,
    user_id: &str,
) -> Result<Value, AppError> {
    let account_sid = required_config(&config.twilio_account_sid, "TWILIO_ACCOUNT_SID")?;
    let api_key_sid = required_config(&config.twilio_api_key_sid, "TWILIO_API_KEY_SID")?;
    let api_key_secret = required_config(&config.twilio_api_key_secret, "TWILIO_API_KEY_SECRET")?;
    let twiml_app_sid = required_config(&config.twilio_twiml_app_sid, "TWILIO_TWIML_APP_SID")?;
    required_config(&config.twilio_browser_twiml_url, "TWILIO_BROWSER_TWIML_URL")?;

    let identity = twilio_identity(org_id, user_id);
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + 3600;
    let header = json!({ "typ": "JWT", "alg": "HS256", "cty": "twilio-fpa;v=1" });
    let claims = json!({
        "jti": format!("{}-{}", api_key_sid, cuid2::create_id()),
        "iss": api_key_sid,
        "sub": account_sid,
        "iat": now,
        "nbf": now,
        "exp": expires_at,
        "grants": {
            "identity": identity,
            "voice": {
                "incoming": { "allow": true },
                "outgoing": { "application_sid": twiml_app_sid }
            }
        }
    });
    let encoded_header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|error| {
        AppError::Internal(format!("Unable to encode Twilio token header: {error}"))
    })?);
    let encoded_claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|error| {
        AppError::Internal(format!("Unable to encode Twilio token claims: {error}"))
    })?);
    let signing_input = format!("{encoded_header}.{encoded_claims}");
    let mut mac = HmacSha256::new_from_slice(api_key_secret.as_bytes())
        .map_err(|_| AppError::Internal("Unable to sign Twilio access token".to_string()))?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(json!({
        "token": format!("{signing_input}.{signature}"),
        "identity": identity,
        "expiresAt": expires_at
    }))
}

pub fn verify_twilio_webhook(
    config: &AppConfig,
    path: &str,
    payload: &BTreeMap<String, String>,
    signature: Option<&str>,
) -> Result<(), AppError> {
    let token = config
        .twilio_auth_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Unauthorized)?;
    let base_url = twilio_webhook_base_url_for(config, path).ok_or(AppError::Unauthorized)?;
    let signature = signature.ok_or(AppError::Unauthorized)?;

    let mut signed_payload = format!("{}{}", base_url.trim_end_matches('/'), path);
    for (key, value) in payload {
        signed_payload.push_str(key);
        signed_payload.push_str(value);
    }

    let received = BASE64
        .decode(signature)
        .map_err(|_| AppError::Unauthorized)?;
    let mut mac = HmacSha1::new_from_slice(token.as_bytes())
        .map_err(|_| AppError::Internal("Unable to verify Twilio signature".to_string()))?;
    mac.update(signed_payload.as_bytes());
    mac.verify_slice(&received)
        .map_err(|_| AppError::Unauthorized)
}

pub async fn record_twilio_webhook(
    pool: &PgPool,
    payload: &BTreeMap<String, String>,
) -> Result<Option<Value>, AppError> {
    let call_sid = payload
        .get("CallSid")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Twilio webhook is missing CallSid".to_string()))?;
    let provider_call_id = payload
        .get("ParentCallSid")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(call_sid);
    let to_phone = payload
        .get("To")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Twilio webhook is missing To".to_string()))?;
    let from_phone = payload
        .get("From")
        .cloned()
        .unwrap_or_else(|| "Unknown caller".to_string());

    let connection = sqlx::query_as::<_, TwilioConnectionRow>(
        r#"
        SELECT id, "orgId" AS org_id, "externalAccountId" AS phone_number
        FROM "ExternalConnection"
        WHERE provider = 'TWILIO'
          AND "sourceType" = 'VOICE'
          AND regexp_replace(COALESCE("externalAccountId", ''), '[^0-9]', '', 'g')
              = regexp_replace($1, '[^0-9]', '', 'g')
        LIMIT 1
        "#,
    )
    .bind(to_phone)
    .fetch_optional(pool)
    .await?;
    let Some(connection) = connection else {
        log::warn!("received Twilio call for an unregistered number");
        return Ok(None);
    };

    let direction = match payload.get("Direction").map(String::as_str) {
        Some(value) if value.to_ascii_lowercase().starts_with("outbound") => "OUTBOUND",
        _ => "INBOUND",
    };
    let status = normalize_twilio_status(payload.get("CallStatus").map(String::as_str));
    let duration_seconds = payload
        .get("CallDuration")
        .and_then(|value| value.parse::<i32>().ok());
    let raw_payload = serde_json::to_value(payload)
        .map_err(|error| AppError::Internal(format!("Unable to encode Twilio webhook: {error}")))?;

    let call = sqlx::query_as::<_, (String,)>(
        r#"
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", direction, status,
            "fromPhone", "toPhone", "startedAt", "endedAt", "durationSeconds", "rawPayload",
            "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', $3, $4, $5, $6, $7, $8,
                NOW(), CASE WHEN $6 IN ('COMPLETED', 'MISSED', 'FAILED', 'CANCELLED') THEN NOW() ELSE NULL END,
                $9, $10, NOW(), NOW())
        ON CONFLICT (provider, "providerCallId") DO UPDATE SET
            status = EXCLUDED.status,
            direction = EXCLUDED.direction,
            "fromPhone" = EXCLUDED."fromPhone",
            "toPhone" = EXCLUDED."toPhone",
            "endedAt" = CASE WHEN EXCLUDED.status IN ('COMPLETED', 'MISSED', 'FAILED', 'CANCELLED')
                THEN NOW() ELSE "CommunicationCall"."endedAt" END,
            "durationSeconds" = COALESCE(EXCLUDED."durationSeconds", "CommunicationCall"."durationSeconds"),
            "rawPayload" = EXCLUDED."rawPayload",
            "updatedAt" = NOW()
        RETURNING id
        "#,
    )
    .bind(format!("call_twilio_{}", cuid2::create_id()))
    .bind(&connection.org_id)
    .bind(provider_call_id)
    .bind(&connection.id)
    .bind(direction)
    .bind(status)
    .bind(&from_phone)
    .bind(to_phone)
    .bind(duration_seconds)
    .bind(raw_payload)
    .fetch_one(pool)
    .await?;

    Ok(Some(
        json!({ "callId": call.0, "orgId": connection.org_id, "status": status }),
    ))
}

pub async fn record_twilio_browser_call(
    pool: &PgPool,
    config: &AppConfig,
    payload: &BTreeMap<String, String>,
) -> Result<String, AppError> {
    let org_id =
        twilio_org_from_identity(payload.get("From").map(String::as_str).ok_or_else(|| {
            AppError::BadRequest("Twilio browser request is missing From".to_string())
        })?)?;
    let connection_id = payload
        .get("ConnectionId")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("Twilio browser request is missing ConnectionId".to_string())
        })?;
    let to_phone =
        validate_e164_phone(payload.get("To").map(String::as_str).ok_or_else(|| {
            AppError::BadRequest("Twilio browser request is missing To".to_string())
        })?)?;
    let call_sid = payload
        .get("CallSid")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("Twilio browser request is missing CallSid".to_string())
        })?;

    let connection = sqlx::query_as::<_, TwilioConnectionRow>(
        r#"
        SELECT id, "orgId" AS org_id, "externalAccountId" AS phone_number
        FROM "ExternalConnection"
        WHERE id = $1 AND "orgId" = $2 AND provider = 'TWILIO' AND "sourceType" = 'VOICE'
        LIMIT 1
        "#,
    )
    .bind(connection_id)
    .bind(&org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::Forbidden(
            "The selected calling number is not available in this workspace".to_string(),
        )
    })?;

    let raw_payload = serde_json::to_value(payload).map_err(|error| {
        AppError::Internal(format!("Unable to encode Twilio browser request: {error}"))
    })?;
    sqlx::query(
        r#"
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", direction, status,
            "fromPhone", "toPhone", "startedAt", "rawPayload", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', $3, $4, 'OUTBOUND', 'CONNECTING', $5, $6, NOW(), $7, NOW(), NOW())
        ON CONFLICT (provider, "providerCallId") DO UPDATE SET
            status = 'CONNECTING', "connectionId" = EXCLUDED."connectionId",
            "fromPhone" = EXCLUDED."fromPhone", "toPhone" = EXCLUDED."toPhone",
            "rawPayload" = EXCLUDED."rawPayload", "updatedAt" = NOW()
        "#,
    )
    .bind(format!("call_twilio_{}", cuid2::create_id()))
    .bind(&org_id)
    .bind(call_sid)
    .bind(&connection.id)
    .bind(&connection.phone_number)
    .bind(&to_phone)
    .bind(raw_payload)
    .execute(pool)
    .await?;

    twilio_browser_twiml(config, &connection.phone_number, &to_phone)
}

pub fn inbound_twiml(config: &AppConfig) -> String {
    if let Some(number) = config
        .twilio_inbound_fallback_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Dial answerOnBridge=\"true\">{}</Dial></Response>",
            xml_escape(number)
        );
    }

    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"busy\"/></Response>"
        .to_string()
}

fn normalize_twilio_status(status: Option<&str>) -> &'static str {
    match status.unwrap_or_default().to_ascii_lowercase().as_str() {
        "queued" | "ringing" => "RINGING",
        "initiated" | "in-progress" => "ACTIVE",
        "completed" => "COMPLETED",
        "busy" | "no-answer" => "MISSED",
        "failed" => "FAILED",
        "canceled" => "CANCELLED",
        _ => "RINGING",
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn twilio_identity(org_id: &str, user_id: &str) -> String {
    format!("kasitek_{org_id}_{user_id}")
}

fn twilio_org_from_identity(value: &str) -> Result<String, AppError> {
    let identity = value.strip_prefix("client:").unwrap_or(value);
    let encoded = identity
        .strip_prefix("kasitek_")
        .ok_or_else(|| AppError::Forbidden("Unknown Twilio browser identity".to_string()))?;
    let (org_id, user_id) = encoded
        .split_once('_')
        .ok_or_else(|| AppError::Forbidden("Invalid Twilio browser identity".to_string()))?;
    if org_id.is_empty() || user_id.is_empty() {
        return Err(AppError::Forbidden(
            "Invalid Twilio browser identity".to_string(),
        ));
    }
    Ok(org_id.to_string())
}

fn validate_e164_phone(value: &str) -> Result<String, AppError> {
    let number = value.trim();
    let digits = number.strip_prefix('+').unwrap_or_default();
    if !number.starts_with('+')
        || !(8..=15).contains(&digits.len())
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::BadRequest(
            "The destination phone number must use E.164 format".to_string(),
        ));
    }
    Ok(number.to_string())
}

fn twilio_webhook_base_url_for<'a>(config: &'a AppConfig, path: &str) -> Option<&'a str> {
    let webhook_url = if path.ends_with("/browser") || path.ends_with("/status") {
        config
            .twilio_browser_twiml_url
            .as_deref()
            .or(config.twilio_voice_webhook_url.as_deref())
    } else {
        config.twilio_voice_webhook_url.as_deref()
    };
    webhook_url
        .and_then(|url| url.split("/api/webhooks/twilio/").next())
        .filter(|value| !value.trim().is_empty())
}

fn twilio_browser_twiml(
    config: &AppConfig,
    from_phone: &str,
    to_phone: &str,
) -> Result<String, AppError> {
    let status_url = format!(
        "{}/api/webhooks/twilio/status",
        twilio_webhook_base_url_for(config, "/api/webhooks/twilio/browser")
            .ok_or_else(|| AppError::Internal(
                "Twilio webhook base URL is unavailable".to_string()
            ))?
            .trim_end_matches('/')
    );
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Dial callerId=\"{}\" answerOnBridge=\"true\" statusCallback=\"{}\" statusCallbackMethod=\"POST\"><Number>{}</Number></Dial></Response>",
        xml_escape(from_phone),
        xml_escape(&status_url),
        xml_escape(to_phone)
    ))
}

fn required_config<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str, AppError> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("{name} is not configured")))
}

#[cfg(test)]
mod tests {
    use super::{normalize_twilio_status, twilio_org_from_identity, validate_e164_phone};

    #[test]
    fn normalizes_twilio_call_statuses() {
        assert_eq!(normalize_twilio_status(Some("ringing")), "RINGING");
        assert_eq!(normalize_twilio_status(Some("in-progress")), "ACTIVE");
        assert_eq!(normalize_twilio_status(Some("completed")), "COMPLETED");
        assert_eq!(normalize_twilio_status(Some("no-answer")), "MISSED");
        assert_eq!(normalize_twilio_status(Some("failed")), "FAILED");
        assert_eq!(normalize_twilio_status(Some("canceled")), "CANCELLED");
    }

    #[test]
    fn accepts_only_scoped_browser_identities_and_e164_destinations() {
        assert_eq!(
            twilio_org_from_identity("client:kasitek_org123_user456").unwrap(),
            "org123"
        );
        assert!(twilio_org_from_identity("client:other_user").is_err());
        assert_eq!(validate_e164_phone("+27115550123").unwrap(), "+27115550123");
        assert!(validate_e164_phone("0712345678").is_err());
    }
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
    let mut tx = pool.begin().await?;
    let existing_id = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "ExternalConnection" WHERE "orgId" = $1 AND "sourceType" = 'VOICE' AND "sourceId" = $2 FOR UPDATE"#,
    )
    .bind(org_id)
    .bind(&source_id)
    .fetch_optional(&mut *tx)
    .await?;

    let row = sqlx::query_as::<_, (String, String, String, DateTime<Utc>)>(
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
        RETURNING id, "displayName", "externalAccountId", "updatedAt" AT TIME ZONE 'UTC'
        "#,
    )
    .bind(id)
    .bind(org_id)
    .bind(source_id)
    .bind(phone_number)
    .bind(display_name)
    .fetch_one(&mut *tx)
    .await?;

    if existing_id.is_none() {
        analytics::connections::enqueue_lifecycle(
            &mut tx,
            org_id,
            &row.0,
            TWILIO_PROVIDER,
            "created",
            "NOT_CONNECTED",
            "MISSING",
            "UNKNOWN",
            "UNKNOWN",
            row.3,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Connections analytics fact: {error}"
            ))
        })?;
    }
    tx.commit().await?;

    Ok(json!({
        "id": row.0,
        "provider": TWILIO_PROVIDER,
        "displayName": row.1,
        "phoneNumber": row.2,
        "status": "NOT_CONNECTED"
    }))
}
