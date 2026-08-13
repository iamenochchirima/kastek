use std::sync::OnceLock;

use redis::AsyncCommands;
use serde_json::Value;

use crate::error::AppError;

static REDIS_CLIENT: OnceLock<Option<redis::Client>> = OnceLock::new();

fn redis_client() -> Option<&'static redis::Client> {
    REDIS_CLIENT
        .get_or_init(|| {
            std::env::var("REDIS_URL")
                .ok()
                .and_then(|url| redis::Client::open(url).ok())
        })
        .as_ref()
}

pub fn build_whatsapp_org_channel(org_id: &str) -> String {
    build_inbox_org_channel(org_id)
}

pub fn build_inbox_org_channel(org_id: &str) -> String {
    format!("whatsapp:org:{org_id}")
}

fn whatsapp_inbox_queue_key() -> &'static str {
    "whatsapp:inbox:outbound"
}

/// Atomically reserve a short-lived delegated-request identifier across every
/// core replica. Delegated agent requests are privileged service calls, so a
/// missing or unavailable shared replay store is an authentication failure,
/// not a best-effort condition.
pub async fn claim_delegation_replay(issuer: &str, jti: &str) -> Result<bool, AppError> {
    let Some(client) = redis_client() else {
        log::error!("[agent-delegation] REDIS_URL is required for delegation replay protection");
        return Err(AppError::Unauthorized);
    };
    let mut connection = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| {
            log::error!("[agent-delegation] failed to connect to Redis: {error}");
            AppError::Unauthorized
        })?;
    let key = format!("agents:delegation:{}:{jti}", issuer.trim());
    let claimed = redis::cmd("SET")
        .arg(key)
        .arg("1")
        .arg("NX")
        .arg("PX")
        .arg(120_000_u64)
        .query_async::<Option<String>>(&mut connection)
        .await
        .map_err(|error| {
            log::error!("[agent-delegation] failed to claim replay key: {error}");
            AppError::Unauthorized
        })?;
    Ok(claimed.is_some())
}

pub async fn publish_whatsapp_event(org_id: &str, event: &Value) -> Result<(), AppError> {
    publish_inbox_event(org_id, event).await
}

pub async fn publish_inbox_event(org_id: &str, event: &Value) -> Result<(), AppError> {
    let Some(client) = redis_client() else {
        log::warn!(
            "[realtime] no redis client, skipping publish for organisation {}",
            org_id
        );
        return Ok(());
    };
    let channel = build_inbox_org_channel(org_id);
    let payload = serde_json::to_string(event)
        .map_err(|_| AppError::Internal("Failed to encode realtime event".to_string()))?;
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| {
            log::error!("[realtime] failed to connect to redis for publish: {}", e);
            AppError::Internal("Failed to connect to realtime Redis".to_string())
        })?;
    let subscribers: i64 = conn.publish(&channel, payload).await.map_err(|e| {
        log::error!("[realtime] failed to publish to {}: {}", channel, e);
        AppError::Internal("Failed to publish realtime event".to_string())
    })?;
    log::info!(
        "[realtime] published to {} ({} subscribers)",
        channel,
        subscribers
    );
    Ok(())
}

pub async fn create_pubsub() -> Result<Option<redis::aio::PubSub>, AppError> {
    let Some(client) = redis_client() else {
        return Ok(None);
    };
    client
        .get_async_pubsub()
        .await
        .map(Some)
        .map_err(|_| AppError::Internal("Failed to connect to realtime Redis".to_string()))
}

pub async fn enqueue_whatsapp_inbox_message(message_id: &str) -> Result<(), AppError> {
    let Some(client) = redis_client() else {
        return Ok(());
    };
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| AppError::Internal("Failed to connect to realtime Redis".to_string()))?;
    let _: i64 = conn
        .lpush(whatsapp_inbox_queue_key(), message_id)
        .await
        .map_err(|_| AppError::Internal("Failed to enqueue inbox job".to_string()))?;
    Ok(())
}

pub async fn drain_whatsapp_inbox_queue(limit: usize) -> Result<Vec<String>, AppError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some(client) = redis_client() else {
        return Ok(Vec::new());
    };
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| AppError::Internal("Failed to connect to realtime Redis".to_string()))?;
    let mut ids = Vec::new();
    for _ in 0..limit {
        let next = redis::cmd("RPOP")
            .arg(whatsapp_inbox_queue_key())
            .query_async::<Option<String>>(&mut conn)
            .await
            .map_err(|_| AppError::Internal("Failed to drain inbox queue".to_string()))?;
        let Some(message_id) = next else {
            break;
        };
        ids.push(message_id);
    }
    Ok(ids)
}
