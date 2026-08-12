use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    let poll_interval_ms = std::env::var("WHATSAPP_INBOX_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    let batch_size = std::env::var("WHATSAPP_INBOX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(50);

    loop {
        match crate::services::whatsapp::process_queued_inbox_messages(&pool, batch_size).await {
            Ok(processed) if processed > 0 => {
                log::info!("[whatsapp-inbox-worker] processed={processed}")
            }
            Ok(_) => {}
            Err(error) => log::error!("[whatsapp-inbox-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
