use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "whatsapp_campaigns",
        "worker started"
    );
    let poll_interval_ms = std::env::var("WHATSAPP_MARKETING_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("WHATSAPP_MARKETING_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);

    loop {
        match observability::result_span(
            "worker",
            "whatsapp_campaigns.process_batch",
            crate::services::whatsapp::process_queued_campaign_recipients(&pool, batch_size),
        )
        .await
        {
            Ok(processed) if processed > 0 => {
                observability::tracing::info!(
                    event = "queue.item.completed",
                    worker = "whatsapp_campaigns",
                    items = processed,
                    "worker batch completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "whatsapp_campaigns", error_type = %std::any::type_name_of_val(&error), "worker batch failed")
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
