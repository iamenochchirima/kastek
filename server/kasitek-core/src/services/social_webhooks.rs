use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::AppError;

use super::social::required_env;

type HmacSha256 = Hmac<Sha256>;

const TIKTOK_WEBHOOK_MAX_AGE_SECONDS: i64 = 300;

pub fn verify_tiktok_webhook_signature(
    signature_header: Option<&str>,
    body: &[u8],
) -> Result<(), AppError> {
    let secret = required_env("AUTH_TIKTOK_CLIENT_SECRET")?;
    let max_age = std::env::var("TIKTOK_WEBHOOK_MAX_AGE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(TIKTOK_WEBHOOK_MAX_AGE_SECONDS)
        .clamp(30, 3600);
    verify_tiktok_webhook_signature_at(
        signature_header,
        body,
        &secret,
        Utc::now().timestamp(),
        max_age,
    )
}

fn verify_tiktok_webhook_signature_at(
    signature_header: Option<&str>,
    body: &[u8],
    secret: &str,
    now_timestamp: i64,
    max_age: i64,
) -> Result<(), AppError> {
    let header = signature_header.ok_or(AppError::Unauthorized)?;
    let mut timestamp = None;
    let mut signature = None;
    for item in header.split(',') {
        let Some((key, value)) = item.trim().split_once('=') else {
            continue;
        };
        match key.trim() {
            "t" => timestamp = value.trim().parse::<i64>().ok(),
            "s" => signature = Some(value.trim()),
            _ => {}
        }
    }
    let timestamp = timestamp.ok_or(AppError::Unauthorized)?;
    if (now_timestamp - timestamp).abs() > max_age {
        return Err(AppError::Unauthorized);
    }
    let received = hex::decode(signature.ok_or(AppError::Unauthorized)?)
        .map_err(|_| AppError::Unauthorized)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Internal("Invalid TikTok client secret".to_string()))?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    mac.verify_slice(&received)
        .map_err(|_| AppError::Unauthorized)
}

pub fn parse_tiktok_webhook_envelope(body: &[u8]) -> Result<Value, AppError> {
    let payload: Value = serde_json::from_slice(body)
        .map_err(|_| AppError::BadRequest("Invalid TikTok webhook payload".to_string()))?;
    let expected_key = required_env("AUTH_TIKTOK_CLIENT_KEY")?;
    let client_key = payload
        .get("client_key")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("TikTok webhook is missing client_key".to_string()))?;
    if client_key != expected_key {
        return Err(AppError::Forbidden(
            "TikTok webhook client key mismatch".to_string(),
        ));
    }
    if payload.get("event").and_then(Value::as_str).is_none() {
        return Err(AppError::BadRequest(
            "TikTok webhook is missing event".to_string(),
        ));
    }
    Ok(payload)
}

pub async fn record_tiktok_webhook_event(
    pool: &PgPool,
    payload: &Value,
    body: &[u8],
) -> Result<bool, AppError> {
    let event_key = hex::encode(Sha256::digest(body));
    let event_type = payload
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let external_account_id = payload.get("user_openid").and_then(Value::as_str);
    let result = sqlx::query(
        r#"
        INSERT INTO "SocialWebhookEvent" (id, provider, "eventKey", "eventType", "externalAccountId", payload, status, attempts, "nextAttemptAt", "receivedAt", "createdAt", "updatedAt")
        VALUES ($1, 'TIKTOK', $2, $3, $4, $5, 'RECEIVED', 0, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (provider, "eventKey") DO NOTHING
    "#,
    )
    .bind(cuid2::create_id())
    .bind(event_key)
    .bind(event_type)
    .bind(external_account_id)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::{verify_tiktok_webhook_signature_at, HmacSha256};
    use hmac::Mac;

    fn tiktok_signature(timestamp: i64, body: &[u8], secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);
        format!(
            "t={timestamp},s={}",
            hex::encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn tiktok_webhook_signature_verifies_the_raw_body() {
        let secret = "test-tiktok-secret";
        let timestamp = 1_700_000_000;
        let body = br#"{\"event\":\"post.publish.complete\"}"#;
        let signature = tiktok_signature(timestamp, body, secret);

        assert!(verify_tiktok_webhook_signature_at(
            Some(&signature),
            body,
            secret,
            timestamp + 60,
            300,
        )
        .is_ok());
        assert!(verify_tiktok_webhook_signature_at(
            Some(&signature),
            br#"{\"event\":\"post.publish.failed\"}"#,
            secret,
            timestamp + 60,
            300,
        )
        .is_err());
    }

    #[test]
    fn tiktok_webhook_signature_rejects_stale_events() {
        let secret = "test-tiktok-secret";
        let timestamp = 1_700_000_000;
        let body = br#"{}"#;
        let signature = tiktok_signature(timestamp, body, secret);

        assert!(verify_tiktok_webhook_signature_at(
            Some(&signature),
            body,
            secret,
            timestamp + 301,
            300,
        )
        .is_err());
    }
}
