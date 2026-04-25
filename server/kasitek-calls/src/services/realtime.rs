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

pub fn build_whatsapp_user_channel(user_id: &str) -> String {
    format!("whatsapp:user:{user_id}")
}

async fn publish_json(channel: &str, event: &Value) -> Result<(), AppError> {
    let Some(client) = redis_client() else {
        log::warn!("[realtime] no redis client, skipping publish for {}", channel);
        return Ok(());
    };

    let payload = serde_json::to_string(event)
        .map_err(|_| AppError::Internal("Failed to encode realtime event".to_string()))?;
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| {
            log::error!("[realtime] failed to connect to redis for publish: {}", e);
            AppError::Internal("Failed to connect to realtime Redis".to_string())
        })?;
    let subscribers: i64 = conn.publish(channel, payload).await.map_err(|e| {
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

pub async fn publish_whatsapp_event(user_id: &str, event: &Value) -> Result<(), AppError> {
    publish_json(&build_whatsapp_user_channel(user_id), event).await
}
