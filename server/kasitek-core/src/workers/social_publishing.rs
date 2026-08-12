use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    let poll_interval_ms = std::env::var("SOCIAL_PUBLISH_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10_000);
    let batch_size = std::env::var("SOCIAL_PUBLISH_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(10);

    loop {
        match crate::services::social::process_due_social_publish_jobs(&pool, batch_size).await {
            Ok(processed) if processed > 0 => {
                log::info!("[social-publishing-worker] processed={processed}")
            }
            Ok(_) => {}
            Err(error) => log::error!("[social-publishing-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
