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

pub async fn publish_whatsapp_event(user_id: &str, event: &Value) -> Result<(), AppError> {
    let Some(client) = redis_client() else {
        return Ok(());
    };
    let payload = serde_json::to_string(event)
        .map_err(|_| AppError::Internal("Failed to encode realtime event".to_string()))?;
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| AppError::Internal("Failed to connect to realtime Redis".to_string()))?;
    let _: i64 = conn
        .publish(build_whatsapp_user_channel(user_id), payload)
        .await
        .map_err(|_| AppError::Internal("Failed to publish realtime event".to_string()))?;
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
