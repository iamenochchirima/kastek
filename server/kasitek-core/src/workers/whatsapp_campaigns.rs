use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    let poll_interval_ms = std::env::var("WHATSAPP_MARKETING_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("WHATSAPP_MARKETING_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);

    loop {
        match crate::services::whatsapp::process_queued_campaign_recipients(&pool, batch_size).await
        {
            Ok(processed) if processed > 0 => {
                log::info!("[whatsapp-marketing-worker] processed={processed}")
            }
            Ok(_) => {}
            Err(error) => log::error!("[whatsapp-marketing-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
