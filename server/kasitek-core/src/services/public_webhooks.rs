//! Signed outbound webhook subscriptions for the public API.
//!
//! The public API emits a small, durable request-completed event first. The
//! delivery table is the replay boundary: one event id is shared by every
//! subscribed destination and the `(subscription_id, event_id)` key makes
//! enqueueing idempotent.

use chrono::{DateTime, Utc};
use crypto_utils::{decrypt_with_aes256_gcm, encrypt_with_aes256_gcm};
use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{FromRow, PgPool};
use std::{net::IpAddr, time::Duration};

use crate::{config::AppConfig, error::AppError};

type HmacSha256 = Hmac<Sha256>;

pub const REQUEST_COMPLETED_EVENT: &str = "public_api.request.completed";
pub const CONTENT_POST_CREATED_EVENT: &str = "content.post.created";
pub const CONTENT_POST_UPDATED_EVENT: &str = "content.post.updated";
const MAX_EVENT_TYPES: usize = 8;
const MAX_DELIVERY_ATTEMPTS: i32 = 10;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubscriptionInput {
    pub url: String,
    pub event_types: Option<Vec<String>>,
    pub secret: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubscriptionInput {
    pub url: Option<String>,
    pub event_types: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRow {
    pub id: String,
    #[serde(skip_serializing)]
    pub org_id: String,
    pub url: String,
    pub event_types: Value,
    pub status: String,
    pub failure_count: i32,
    pub last_delivered_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub disabled_at: Option<DateTime<Utc>>,
    pub disabled_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRow {
    pub id: String,
    pub subscription_id: String,
    pub event_id: String,
    pub event_type: String,
    pub status: String,
    pub attempt_count: i32,
    pub next_attempt_at: DateTime<Utc>,
    pub last_status_code: Option<i32>,
    pub last_error: Option<String>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct DeliveryJob {
    id: String,
    subscription_id: String,
    event_id: String,
    event_type: String,
    payload: Value,
    attempt_count: i32,
    url: String,
    secret_ciphertext: String,
}

fn encryption_key() -> Result<String, AppError> {
    std::env::var("PUBLIC_WEBHOOK_ENCRYPTION_KEY")
        .or_else(|_| std::env::var("SOCIAL_TOKEN_ENCRYPTION_KEY"))
        .or_else(|_| std::env::var("WHATSAPP_TOKEN_ENCRYPTION_KEY"))
        .map_err(|_| {
            AppError::Internal(
                "PUBLIC_WEBHOOK_ENCRYPTION_KEY or an existing token encryption key is required"
                    .to_string(),
            )
        })
}

fn encrypt_secret(secret: &str) -> Result<String, AppError> {
    encrypt_with_aes256_gcm(&encryption_key()?, secret)
        .map_err(|error| AppError::Internal(format!("Failed to encrypt webhook secret: {error}")))
}

fn decrypt_secret(ciphertext: &str) -> Result<String, AppError> {
    decrypt_with_aes256_gcm(&encryption_key()?, ciphertext)
        .map_err(|error| AppError::Internal(format!("Failed to decrypt webhook secret: {error}")))
}

fn generate_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("whsec_{}", hex::encode(bytes))
}

pub fn supported_event_types(event_types: Option<Vec<String>>) -> Result<Vec<String>, AppError> {
    let event_types = event_types.unwrap_or_else(|| vec![REQUEST_COMPLETED_EVENT.to_string()]);
    if event_types.is_empty() || event_types.len() > MAX_EVENT_TYPES {
        return Err(AppError::BadRequest(format!(
            "eventTypes must contain between 1 and {MAX_EVENT_TYPES} events"
        )));
    }
    let mut normalized = Vec::with_capacity(event_types.len());
    for event_type in event_types {
        let event_type = event_type.trim();
        if !matches!(
            event_type,
            REQUEST_COMPLETED_EVENT | CONTENT_POST_CREATED_EVENT | CONTENT_POST_UPDATED_EVENT
        ) {
            return Err(AppError::BadRequest(format!(
                "unsupported webhook event type: {event_type}"
            )));
        }
        if !normalized.iter().any(|value| value == event_type) {
            normalized.push(event_type.to_string());
        }
    }
    Ok(normalized)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified())
        }
        IpAddr::V6(ip) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}

/// Validate destination URLs at subscription time, including a DNS check to
/// reject obvious SSRF destinations. Local loopback is available only for a
/// non-production environment so an operator can test end to end locally.
pub async fn validate_destination_url(value: &str, config: &AppConfig) -> Result<Url, AppError> {
    let url = Url::parse(value)
        .map_err(|_| AppError::BadRequest("webhook url must be a valid URL".to_string()))?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("webhook url must include a host".to_string()))?;
    let local_allowed = !config.environment.eq_ignore_ascii_case("production")
        && matches!(url.scheme(), "http" | "https")
        && (host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost"));
    if (url.scheme() != "https" && !local_allowed)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::BadRequest(
            "webhook url must use public HTTPS (loopback HTTP is development-only)".to_string(),
        ));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !local_allowed && !is_public_ip(ip) {
            return Err(AppError::BadRequest(
                "webhook url host must resolve to a public address".to_string(),
            ));
        }
        return Ok(url);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| AppError::BadRequest("webhook url host could not be resolved".to_string()))?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || (!local_allowed && addresses.iter().any(|address| !is_public_ip(address.ip())))
    {
        return Err(AppError::BadRequest(
            "webhook url host must resolve to a public address".to_string(),
        ));
    }
    Ok(url)
}

pub async fn create_subscription(
    pool: &PgPool,
    organization_id: &str,
    input: CreateSubscriptionInput,
    config: &AppConfig,
) -> Result<(SubscriptionRow, String), AppError> {
    let url = validate_destination_url(&input.url, config).await?;
    let event_types = supported_event_types(input.event_types)?;
    let secret = input.secret.unwrap_or_else(generate_secret);
    if secret.trim().len() < 32 || secret.len() > 512 {
        return Err(AppError::BadRequest(
            "webhook secret must be between 32 and 512 characters".to_string(),
        ));
    }
    let id = cuid2::create_id();
    let ciphertext = encrypt_secret(&secret)?;
    let row = sqlx::query_as::<_, SubscriptionRow>(
        r#"
        INSERT INTO "PublicApiWebhookSubscription"
            ("id", "orgId", "url", "secretCiphertext", "eventTypes", "status")
        VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
        RETURNING "id", "orgId", "url", "eventTypes", "status", "failureCount",
                  "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",
                  "createdAt", "updatedAt"
        "#,
    )
    .bind(&id)
    .bind(organization_id)
    .bind(url.as_str())
    .bind(ciphertext)
    .bind(json!(event_types))
    .fetch_one(pool)
    .await?;
    Ok((row, secret))
}

pub async fn list_subscriptions(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<SubscriptionRow>, AppError> {
    Ok(sqlx::query_as::<_, SubscriptionRow>(
        r#"
        SELECT "id", "orgId", "url", "eventTypes", "status", "failureCount",
               "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",
               "createdAt", "updatedAt"
        FROM "PublicApiWebhookSubscription"
        WHERE "orgId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 100
        "#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await?)
}

pub async fn update_subscription(
    pool: &PgPool,
    organization_id: &str,
    subscription_id: &str,
    input: UpdateSubscriptionInput,
    config: &AppConfig,
) -> Result<SubscriptionRow, AppError> {
    let current = sqlx::query_as::<_, (String, Value)>(
        r#"SELECT "url", "eventTypes" FROM "PublicApiWebhookSubscription" WHERE "id" = $1 AND "orgId" = $2"#,
    )
    .bind(subscription_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Webhook subscription not found".to_string()))?;
    let url = match input.url {
        Some(url) => validate_destination_url(&url, config).await?.to_string(),
        None => current.0,
    };
    let event_types = match input.event_types {
        Some(values) => supported_event_types(Some(values))?,
        None => current
            .1
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
    };
    let enabled = input.enabled;
    let row = sqlx::query_as::<_, SubscriptionRow>(
        r#"
        UPDATE "PublicApiWebhookSubscription"
        SET "url" = $3,
            "eventTypes" = $4,
            "status" = CASE WHEN $5::boolean IS NULL THEN "status"
                             WHEN $5::boolean THEN 'ACTIVE' ELSE 'DISABLED' END,
            "disabledAt" = CASE WHEN $5::boolean IS NULL THEN "disabledAt"
                                 WHEN $5::boolean THEN NULL ELSE NOW() END,
            "disabledReason" = CASE WHEN $5::boolean IS NULL THEN "disabledReason"
                                     WHEN $5::boolean THEN NULL ELSE 'disabled_by_consumer' END,
            "updatedAt" = NOW()
        WHERE "id" = $1 AND "orgId" = $2
        RETURNING "id", "orgId", "url", "eventTypes", "status", "failureCount",
                  "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",
                  "createdAt", "updatedAt"
        "#,
    )
    .bind(subscription_id)
    .bind(organization_id)
    .bind(url)
    .bind(json!(event_types))
    .bind(enabled)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Webhook subscription not found".to_string()))?;
    Ok(row)
}

pub async fn delete_subscription(
    pool: &PgPool,
    organization_id: &str,
    subscription_id: &str,
) -> Result<(), AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "PublicApiWebhookSubscription"
        SET "status" = 'DISABLED', "disabledAt" = NOW(),
            "disabledReason" = 'deleted_by_consumer', "updatedAt" = NOW()
        WHERE "id" = $1 AND "orgId" = $2
        "#,
    )
    .bind(subscription_id)
    .bind(organization_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Webhook subscription not found".to_string(),
        ));
    }
    Ok(())
}

pub async fn list_deliveries(
    pool: &PgPool,
    organization_id: &str,
    subscription_id: Option<&str>,
) -> Result<Vec<DeliveryRow>, AppError> {
    if let Some(subscription_id) = subscription_id {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                SELECT 1 FROM "PublicApiWebhookSubscription"
                WHERE "id" = $1 AND "orgId" = $2
            )"#,
        )
        .bind(subscription_id)
        .bind(organization_id)
        .fetch_one(pool)
        .await?;
        if !exists {
            return Err(AppError::NotFound(
                "Webhook subscription not found".to_string(),
            ));
        }
    }
    Ok(sqlx::query_as::<_, DeliveryRow>(
        r#"
        SELECT d."id", d."subscriptionId", d."eventId", d."eventType", d."status",
               d."attemptCount", d."nextAttemptAt", d."lastStatusCode", d."lastError",
               d."deliveredAt", d."createdAt", d."updatedAt"
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE s."orgId" = $1 AND ($2::text IS NULL OR d."subscriptionId" = $2)
        ORDER BY d."createdAt" DESC
        LIMIT 100
        "#,
    )
    .bind(organization_id)
    .bind(subscription_id)
    .fetch_all(pool)
    .await?)
}

/// Queue one request-completed event for every matching active subscription.
/// The insert is idempotent even when middleware is retried after a response.
pub async fn enqueue_request_event(
    pool: &PgPool,
    audit_id: &str,
    status_code: u16,
) -> Result<(), AppError> {
    let audit = sqlx::query_as::<_, (String, String, String, Option<String>, String, String, Option<String>)>(
        r#"SELECT "orgId", "route", "method", "action", "principalType", "principalId", "correlationId"
           FROM "PublicApiRequest" WHERE "id" = $1"#,
    )
    .bind(audit_id)
    .fetch_optional(pool)
    .await?;
    let Some((
        organization_id,
        route,
        method,
        action,
        principal_type,
        principal_id,
        correlation_id,
    )) = audit
    else {
        return Ok(());
    };
    enqueue_event(
        pool,
        &organization_id,
        REQUEST_COMPLETED_EVENT,
        json!({
            "requestId": audit_id,
            "route": route,
            "method": method,
            "action": action,
            "statusCode": status_code,
            "principalType": principal_type,
            "principalId": principal_id,
            "correlationId": correlation_id,
        }),
    )
    .await
}

/// Queue an organization-scoped domain event for every active subscription.
/// Callers pass a redacted data projection; provider credentials and raw
/// upstream payloads never enter the public webhook envelope.
pub async fn enqueue_domain_event(
    pool: &PgPool,
    organization_id: &str,
    event_type: &str,
    data: Value,
) -> Result<(), AppError> {
    if !matches!(
        event_type,
        CONTENT_POST_CREATED_EVENT | CONTENT_POST_UPDATED_EVENT
    ) {
        return Err(AppError::BadRequest(
            "unsupported public webhook event type".to_string(),
        ));
    }
    enqueue_event(pool, organization_id, event_type, data).await
}

async fn enqueue_event(
    pool: &PgPool,
    organization_id: &str,
    event_type: &str,
    data: Value,
) -> Result<(), AppError> {
    let subscriptions = sqlx::query_scalar::<_, String>(
        r#"SELECT "id" FROM "PublicApiWebhookSubscription"
           WHERE "orgId" = $1 AND "status" = 'ACTIVE'
             AND "eventTypes" @> $2::jsonb"#,
    )
    .bind(organization_id)
    .bind(json!([event_type]))
    .fetch_all(pool)
    .await?;
    if subscriptions.is_empty() {
        return Ok(());
    }
    let event_id = stable_event_id(event_type, &data);
    let payload = json!({
        "id": event_id,
        "type": event_type,
        "occurredAt": Utc::now().to_rfc3339(),
        "data": data,
    });
    for subscription_id in subscriptions {
        sqlx::query(
            r#"
            INSERT INTO "PublicApiWebhookDelivery"
                ("id", "subscriptionId", "eventId", "eventType", "payload", "status")
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
            ON CONFLICT ("subscriptionId", "eventId") DO NOTHING
            "#,
        )
        .bind(cuid2::create_id())
        .bind(subscription_id)
        .bind(&event_id)
        .bind(event_type)
        .bind(&payload)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn stable_event_id(event_type: &str, data: &Value) -> String {
    let key = data
        .get("requestId")
        .or_else(|| data.get("postId"))
        .and_then(Value::as_str);
    key.map(|key| format!("{event_type}:{key}"))
        .unwrap_or_else(|| cuid2::create_id())
}

fn signature(secret: &str, timestamp: i64, body: &[u8]) -> Result<String, AppError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Internal("Invalid webhook signing secret".to_string()))?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Ok(format!("v1={}", hex::encode(mac.finalize().into_bytes())))
}

async fn claim_delivery(pool: &PgPool) -> Result<Option<DeliveryJob>, AppError> {
    Ok(sqlx::query_as::<_, DeliveryJob>(
        r#"
        WITH candidate AS (
            SELECT d."id"
            FROM "PublicApiWebhookDelivery" d
            JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
            WHERE (d."status" = 'PENDING'
                   OR (d."status" = 'DELIVERING' AND d."updatedAt" < NOW() - INTERVAL '5 minutes'))
              AND d."nextAttemptAt" <= NOW() AND s."status" = 'ACTIVE'
            ORDER BY d."nextAttemptAt", d."createdAt"
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE "PublicApiWebhookDelivery" d
        SET "status" = 'DELIVERING', "attemptCount" = d."attemptCount" + 1, "updatedAt" = NOW()
        FROM candidate c
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."id" = c."id"
        RETURNING d."id", d."subscriptionId", d."eventId", d."eventType", d."payload",
                  d."attemptCount", s."url", s."secretCiphertext"
        "#,
    )
    .fetch_optional(pool)
    .await?)
}

fn retry_delay(attempt_count: i32) -> i64 {
    let exponent = attempt_count.saturating_sub(1).min(10) as u32;
    (30_i64.saturating_mul(2_i64.saturating_pow(exponent))).min(3600)
}

async fn record_delivery_result(
    pool: &PgPool,
    job: &DeliveryJob,
    status_code: Option<i32>,
    error: Option<String>,
) -> Result<(), AppError> {
    if status_code.is_some_and(|code| (200..300).contains(&code)) {
        sqlx::query(
            r#"UPDATE "PublicApiWebhookDelivery"
               SET "status" = 'DELIVERED', "deliveredAt" = NOW(), "lastStatusCode" = $2,
                   "lastError" = NULL, "updatedAt" = NOW() WHERE "id" = $1"#,
        )
        .bind(&job.id)
        .bind(status_code)
        .execute(pool)
        .await?;
        sqlx::query(
            r#"UPDATE "PublicApiWebhookSubscription"
               SET "failureCount" = 0, "lastDeliveredAt" = NOW(), "updatedAt" = NOW()
               WHERE "id" = $1"#,
        )
        .bind(&job.subscription_id)
        .execute(pool)
        .await?;
        return Ok(());
    }
    let should_disable = job.attempt_count >= MAX_DELIVERY_ATTEMPTS;
    let next_delay = retry_delay(job.attempt_count);
    let status = if should_disable { "FAILED" } else { "PENDING" };
    sqlx::query(
        r#"UPDATE "PublicApiWebhookDelivery"
           SET "status" = $2, "lastStatusCode" = $3, "lastError" = $4,
               "nextAttemptAt" = NOW() + ($5::bigint * INTERVAL '1 second'), "updatedAt" = NOW()
           WHERE "id" = $1"#,
    )
    .bind(&job.id)
    .bind(status)
    .bind(status_code)
    .bind(error.as_deref().unwrap_or("Webhook delivery failed"))
    .bind(next_delay)
    .execute(pool)
    .await?;
    sqlx::query(
        r#"UPDATE "PublicApiWebhookSubscription"
           SET "failureCount" = "failureCount" + 1, "lastFailureAt" = NOW(),
               "status" = CASE WHEN $2::boolean THEN 'DISABLED' ELSE "status" END,
               "disabledAt" = CASE WHEN $2::boolean THEN NOW() ELSE "disabledAt" END,
               "disabledReason" = CASE WHEN $2::boolean THEN 'delivery_attempt_limit' ELSE "disabledReason" END,
               "updatedAt" = NOW()
           WHERE "id" = $1"#,
    )
    .bind(&job.subscription_id)
    .bind(should_disable)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn process_due_deliveries(
    pool: &PgPool,
    client: &reqwest::Client,
    batch_size: i64,
) -> Result<usize, AppError> {
    let mut processed = 0_usize;
    for _ in 0..batch_size.max(1).min(100) {
        let Some(job) = claim_delivery(pool).await? else {
            break;
        };
        let body = serde_json::to_vec(&job.payload)
            .map_err(|_| AppError::Internal("Failed to serialize webhook payload".to_string()))?;
        let timestamp = Utc::now().timestamp();
        let result = match decrypt_secret(&job.secret_ciphertext)
            .and_then(|secret| signature(&secret, timestamp, &body))
        {
            Ok(signature) => client
                .post(&job.url)
                .timeout(Duration::from_secs(10))
                .header("content-type", "application/json")
                .header("user-agent", "Kasitek-Public-Webhooks/1")
                .header("x-kasitek-webhook-id", &job.event_id)
                .header("x-kasitek-webhook-event", &job.event_type)
                .header("x-kasitek-webhook-timestamp", timestamp.to_string())
                .header("x-kasitek-webhook-signature", signature)
                .body(body)
                .send()
                .await
                .map(|response| response.status().as_u16() as i32)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(status_code) if (200..300).contains(&status_code) => {
                record_delivery_result(pool, &job, Some(status_code), None).await?;
            }
            Ok(status_code) => {
                record_delivery_result(
                    pool,
                    &job,
                    Some(status_code),
                    Some(format!("Webhook endpoint returned HTTP {status_code}")),
                )
                .await?;
            }
            Err(error) => record_delivery_result(pool, &job, None, Some(error)).await?,
        }
        processed += 1;
    }
    Ok(processed)
}

#[cfg(test)]
mod tests {
    use super::{
        retry_delay, signature, stable_event_id, supported_event_types, CONTENT_POST_CREATED_EVENT,
        CONTENT_POST_UPDATED_EVENT, REQUEST_COMPLETED_EVENT,
    };

    #[test]
    fn only_documented_events_are_accepted() {
        assert_eq!(
            supported_event_types(None).unwrap(),
            vec![REQUEST_COMPLETED_EVENT]
        );
        assert!(supported_event_types(Some(vec![
            CONTENT_POST_CREATED_EVENT.to_string(),
            CONTENT_POST_UPDATED_EVENT.to_string(),
        ]))
        .is_ok());
        assert!(supported_event_types(Some(vec!["unknown".to_string()])).is_err());
    }

    #[test]
    fn signatures_bind_timestamp_and_body() {
        let first = signature("secret", 1_700_000_000, br#"{"id":"event-1"}"#).unwrap();
        let second = signature("secret", 1_700_000_001, br#"{"id":"event-1"}"#).unwrap();
        assert!(first.starts_with("v1=") && first.len() == 67);
        assert_ne!(first, second);
    }

    #[test]
    fn retries_back_off_and_cap() {
        assert_eq!(retry_delay(1), 30);
        assert_eq!(retry_delay(2), 60);
        assert_eq!(retry_delay(10), 7_680.min(3600));
    }

    #[test]
    fn event_ids_are_stable_for_replayed_domain_mutations() {
        let data = serde_json::json!({"postId": "post-1"});
        assert_eq!(
            stable_event_id(CONTENT_POST_CREATED_EVENT, &data),
            "content.post.created:post-1"
        );
    }
}
