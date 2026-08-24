use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    let poll_interval_ms = std::env::var("SOCIAL_INSIGHTS_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(15 * 60 * 1_000);
    let batch_size = std::env::var("SOCIAL_INSIGHTS_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);

    loop {
        match crate::services::social_insights::sync_all_social_post_insights(&pool, batch_size)
            .await
        {
            Ok(synced) if synced > 0 => {
                log::info!("[social-insights-worker] synced_jobs={synced}")
            }
            Ok(_) => {}
            Err(error) => log::error!("[social-insights-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
