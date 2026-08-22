use std::{env, time::Duration};

use analytics_producer::{
    publish_outbox_once, AnalyticsIngestionClient, AnalyticsPublisherSettings, RetryPolicy,
};
use chrono::Utc;
use sqlx::PgPool;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4300";
const DEFAULT_PRODUCER_ID: &str = "core-customer-analytics";
const DEFAULT_PUBLISHER_ID: &str = "core-analytics-publisher";

pub async fn run(pool: PgPool) {
    let Some(settings) = settings_from_env() else {
        log::warn!(
            "[analytics-publisher] disabled; set ANALYTICS_CORE_INGESTION_TOKEN to enable Core publication"
        );
        return;
    };
    let client = match AnalyticsIngestionClient::new(
        settings.endpoint.clone(),
        settings.token.clone(),
        settings.request_timeout,
    ) {
        Ok(client) => client,
        Err(error) => {
            log::error!("[analytics-publisher] invalid transport configuration: {error}");
            return;
        }
    };
    log::info!(
        "[analytics-publisher] started producer_id={} endpoint={} batch_size={}",
        settings.producer_id,
        settings.endpoint,
        settings.batch_size
    );
    loop {
        match publish_outbox_once(&pool, &client, &settings, Utc::now()).await {
            Ok(stats) if stats.claimed > 0 || stats.leases_released > 0 => log::info!(
                "[analytics-publisher] claimed={} delivered={} retryable={} quarantined={} leases_released={}",
                stats.claimed,
                stats.delivered,
                stats.retryable,
                stats.quarantined,
                stats.leases_released
            ),
            Ok(_) => {}
            Err(error) => log::error!("[analytics-publisher] iteration failed: {error}"),
        }
        tokio::time::sleep(poll_interval()).await;
    }
}

fn settings_from_env() -> Option<AnalyticsPublisherSettings> {
    let token = env::var("ANALYTICS_CORE_INGESTION_TOKEN")
        .ok()
        .or_else(|| env::var("ANALYTICS_INGESTION_TOKEN").ok())
        .filter(|value| !value.trim().is_empty())?;
    Some(AnalyticsPublisherSettings {
        endpoint: env::var("ANALYTICS_INGESTION_URL")
            .unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string()),
        token,
        producer_id: env_string("ANALYTICS_CORE_PRODUCER_ID", DEFAULT_PRODUCER_ID),
        publisher_id: env_string("ANALYTICS_CORE_PUBLISHER_ID", DEFAULT_PUBLISHER_ID),
        batch_size: env_i64("ANALYTICS_PUBLISHER_BATCH_SIZE", 100).clamp(1, 500),
        lease_duration: Duration::from_millis(env_u64(
            "ANALYTICS_PUBLISHER_LEASE_DURATION_MS",
            30_000,
        )),
        request_timeout: Duration::from_millis(env_u64(
            "ANALYTICS_PUBLISHER_REQUEST_TIMEOUT_MS",
            10_000,
        )),
        retry_policy: RetryPolicy {
            base_delay: Duration::from_millis(env_u64(
                "ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS",
                2_000,
            )),
            max_delay: Duration::from_millis(env_u64(
                "ANALYTICS_PUBLISHER_RETRY_MAX_DELAY_MS",
                300_000,
            )),
            jitter_window: Duration::from_millis(env_u64(
                "ANALYTICS_PUBLISHER_RETRY_JITTER_MS",
                2_000,
            )),
        },
    })
}

fn poll_interval() -> Duration {
    Duration::from_millis(env_u64("ANALYTICS_PUBLISHER_POLL_INTERVAL_MS", 1_000))
}

fn env_string(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_i64(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &u64| *value > 0)
        .unwrap_or(default)
}
