use std::sync::OnceLock;
use std::time::Duration;

use redis::AsyncCommands;
use serde_json::Value;

use crate::error::AppError;

static REDIS_CLIENT: OnceLock<Option<redis::Client>> = OnceLock::new();
const DELEGATION_REPLAY_TTL: Duration = Duration::from_secs(125);

/// Shared, atomic replay guard for short-lived Agent Platform delegations.
/// Separate instances deliberately hold separate Redis clients so the same
/// behavior can be verified across core replicas and process restarts.
#[derive(Clone)]
pub struct DelegationReplayStore {
    client: redis::Client,
    ttl: Duration,
}

impl DelegationReplayStore {
    pub fn connect(redis_url: &str, ttl: Duration) -> Result<Self, AppError> {
        let client = redis::Client::open(redis_url).map_err(|error| {
            observability::tracing::error!(
                event = "dependency.unavailable",
                dependency = "redis",
                operation = "delegation_replay.connect",
                reason = "invalid_configuration",
                error_type = %std::any::type_name_of_val(&error),
                "delegation replay store configuration invalid"
            );
            AppError::Unauthorized
        })?;
        Ok(Self { client, ttl })
    }

    pub async fn claim(&self, issuer: &str, jti: &str) -> Result<bool, AppError> {
        let mut connection = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(|error| {
                observability::tracing::error!(
                    event = "dependency.unavailable",
                    dependency = "redis",
                    operation = "delegation_replay.connect",
                    error_type = %std::any::type_name_of_val(&error),
                    "delegation replay store unavailable"
                );
                AppError::Unauthorized
            })?;
        let key = format!("agents:delegation:{}:{jti}", issuer.trim());
        let ttl_ms = self.ttl.as_millis().clamp(1, u64::MAX as u128) as u64;
        let claimed = redis::cmd("SET")
            .arg(key)
            .arg("1")
            .arg("NX")
            .arg("PX")
            .arg(ttl_ms)
            .query_async::<Option<String>>(&mut connection)
            .await
            .map_err(|error| {
                observability::tracing::error!(
                    event = "dependency.unavailable",
                    dependency = "redis",
                    operation = "delegation_replay.claim",
                    error_type = %std::any::type_name_of_val(&error),
                    "delegation replay claim failed"
                );
                AppError::Unauthorized
            })?;
        Ok(claimed.is_some())
    }
}

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
        observability::tracing::error!(
            event = "dependency.unavailable",
            dependency = "redis",
            operation = "delegation_replay",
            reason = "missing_configuration",
            "delegation replay protection unavailable"
        );
        return Err(AppError::Unauthorized);
    };
    DelegationReplayStore {
        client: client.clone(),
        ttl: DELEGATION_REPLAY_TTL,
    }
    .claim(issuer, jti)
    .await
}

#[cfg(test)]
mod delegation_replay_tests {
    use super::DelegationReplayStore;
    use std::time::Duration;

    #[tokio::test]
    #[ignore = "requires REDIS_REPLAY_TEST_URL pointing to an isolated Redis instance"]
    async fn replay_store_is_shared_across_instances_and_expires() {
        let redis_url =
            std::env::var("REDIS_REPLAY_TEST_URL").expect("REDIS_REPLAY_TEST_URL is required");
        let first = DelegationReplayStore::connect(&redis_url, Duration::from_millis(75)).unwrap();
        let second = DelegationReplayStore::connect(&redis_url, Duration::from_millis(75)).unwrap();
        let jti = format!("test-{}", cuid2::create_id());
        assert!(first.claim("test-issuer", &jti).await.unwrap());
        assert!(!second.claim("test-issuer", &jti).await.unwrap());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(second.claim("test-issuer", &jti).await.unwrap());
    }
}

pub async fn publish_whatsapp_event(org_id: &str, event: &Value) -> Result<(), AppError> {
    publish_inbox_event(org_id, event).await
}

pub async fn publish_inbox_event(org_id: &str, event: &Value) -> Result<(), AppError> {
    let Some(client) = redis_client() else {
        observability::tracing::warn!(
            event = "dependency.unavailable",
            dependency = "redis",
            operation = "realtime.publish",
            organization_id = %org_id,
            reason = "missing_configuration",
            "realtime publish skipped"
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
            observability::tracing::error!(
                event = "dependency.unavailable",
                dependency = "redis",
                operation = "realtime.publish.connect",
                error_type = %std::any::type_name_of_val(&e),
                "realtime Redis unavailable"
            );
            AppError::Internal("Failed to connect to realtime Redis".to_string())
        })?;
    let subscribers: i64 = conn.publish(&channel, payload).await.map_err(|e| {
        observability::tracing::error!(
            event = "operation.failed",
            operation = "realtime.publish",
            organization_id = %org_id,
            error_type = %std::any::type_name_of_val(&e),
            "realtime event publish failed"
        );
        AppError::Internal("Failed to publish realtime event".to_string())
    })?;
    observability::tracing::info!(
        event = "provider.call.completed",
        provider = "redis",
        operation = "realtime.publish",
        organization_id = %org_id,
        subscribers,
        "realtime event published"
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
