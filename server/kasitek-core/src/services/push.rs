use serde::Serialize;
use sqlx::FromRow;
use sqlx::PgPool;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushMessageBuilder, URL_SAFE_NO_PAD,
};

use crate::config::AppConfig;
use crate::db::models::WebPushSubscriptionRequest;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct PushNotificationPayload {
    pub title: String,
    pub body: String,
    pub url: String,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
struct StoredPushSubscription {
    endpoint: String,
    p256dh: String,
    auth: String,
}

fn normalize_string(value: Option<&str>, field: &str) -> Result<String, AppError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("Missing {field}")))
}

pub async fn get_push_subscription_status(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
) -> Result<(bool, i64), AppError> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM "PushSubscription"
        WHERE "userId" = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok((config.web_push_configured(), count))
}

pub async fn save_push_subscription(
    pool: &PgPool,
    user_id: &str,
    subscription: WebPushSubscriptionRequest,
    user_agent: Option<&str>,
) -> Result<(), AppError> {
    let endpoint = normalize_string(subscription.endpoint.as_deref(), "subscription endpoint")?;
    let keys = subscription
        .keys
        .ok_or_else(|| AppError::BadRequest("Missing subscription keys".to_string()))?;
    let p256dh = normalize_string(keys.p256dh.as_deref(), "subscription p256dh key")?;
    let auth = normalize_string(keys.auth.as_deref(), "subscription auth key")?;

    sqlx::query(
        r#"
        INSERT INTO "PushSubscription" (
            id, "userId", endpoint, p256dh, auth, "expirationTime", "userAgent", "lastUsedAt", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
        ON CONFLICT (endpoint)
        DO UPDATE SET
            "userId" = EXCLUDED."userId",
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            "expirationTime" = EXCLUDED."expirationTime",
            "userAgent" = EXCLUDED."userAgent",
            "lastUsedAt" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(endpoint)
    .bind(p256dh)
    .bind(auth)
    .bind(subscription.expiration_time)
    .bind(user_agent)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_push_subscription(
    pool: &PgPool,
    user_id: &str,
    endpoint: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query(
        r#"
        DELETE FROM "PushSubscription"
        WHERE "userId" = $1
          AND endpoint = $2
        "#,
    )
    .bind(user_id)
    .bind(endpoint)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

async fn list_subscriptions_for_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<StoredPushSubscription>, AppError> {
    sqlx::query_as::<_, StoredPushSubscription>(
        r#"
        SELECT endpoint, p256dh, auth
        FROM "PushSubscription"
        WHERE "userId" = $1
        ORDER BY "updatedAt" DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn delete_stale_push_subscription(pool: &PgPool, endpoint: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        DELETE FROM "PushSubscription"
        WHERE endpoint = $1
        "#,
    )
    .bind(endpoint)
    .execute(pool)
    .await?;

    Ok(())
}

async fn touch_push_subscription(pool: &PgPool, endpoint: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "PushSubscription"
        SET "lastUsedAt" = NOW(), "updatedAt" = NOW()
        WHERE endpoint = $1
        "#,
    )
    .bind(endpoint)
    .execute(pool)
    .await?;

    Ok(())
}

async fn send_web_push(
    config: &AppConfig,
    subscription: &StoredPushSubscription,
    payload: &PushNotificationPayload,
) -> Result<(), AppError> {
    let vapid_private_key = config
        .web_push_vapid_private_key
        .as_deref()
        .ok_or_else(|| {
            AppError::Internal("WEB_PUSH_VAPID_PRIVATE_KEY is not configured".to_string())
        })?;

    let subscription_info = SubscriptionInfo::new(
        subscription.endpoint.clone(),
        subscription.p256dh.clone(),
        subscription.auth.clone(),
    );
    let mut builder = WebPushMessageBuilder::new(&subscription_info);

    let payload_json = serde_json::to_vec(payload).map_err(|error| {
        AppError::Internal(format!("Failed to serialize web push payload: {error}"))
    })?;
    builder.set_payload(ContentEncoding::Aes128Gcm, &payload_json);

    let mut signature_builder =
        VapidSignatureBuilder::from_base64(vapid_private_key, URL_SAFE_NO_PAD, &subscription_info)
            .map_err(|error| AppError::Internal(format!("Invalid VAPID configuration: {error}")))?;
    signature_builder.add_claim("sub", config.web_push_subject.clone());
    let signature = signature_builder
        .build()
        .map_err(|error| AppError::Internal(format!("Failed to build VAPID signature: {error}")))?;
    builder.set_vapid_signature(signature);

    let client = IsahcWebPushClient::new().map_err(|error| {
        AppError::Internal(format!("Failed to initialize web push client: {error}"))
    })?;
    client
        .send(builder.build().map_err(|error| {
            AppError::Internal(format!("Failed to finalize web push message: {error}"))
        })?)
        .await
        .map_err(|error| AppError::Internal(format!("Web push send failed: {error}")))?;

    Ok(())
}

pub async fn send_push_notification_to_user(
    pool: &PgPool,
    config: &AppConfig,
    user_id: &str,
    payload: PushNotificationPayload,
) -> Result<usize, AppError> {
    if !config.web_push_configured() {
        return Ok(0);
    }

    let subscriptions = list_subscriptions_for_user(pool, user_id).await?;
    let mut delivered = 0usize;

    for subscription in subscriptions {
        match send_web_push(config, &subscription, &payload).await {
            Ok(()) => {
                delivered += 1;
                if let Err(error) = touch_push_subscription(pool, &subscription.endpoint).await {
                    log::warn!(
                        "failed to update push subscription lastUsedAt endpoint={}: {}",
                        subscription.endpoint,
                        error
                    );
                }
            }
            Err(error) => {
                let message = error.to_string();
                let stale_subscription = message.contains("410")
                    || message.contains("404")
                    || message.contains("unsubscribed")
                    || message.contains("invalid subscription");
                if stale_subscription {
                    if let Err(delete_error) =
                        delete_stale_push_subscription(pool, &subscription.endpoint).await
                    {
                        log::warn!(
                            "failed to delete stale push subscription endpoint={}: {}",
                            subscription.endpoint,
                            delete_error
                        );
                    }
                }
                log::warn!(
                    "failed to send web push to user_id={} endpoint={}: {}",
                    user_id,
                    subscription.endpoint,
                    message
                );
            }
        }
    }

    Ok(delivered)
}
