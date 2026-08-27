use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "whatsapp_inbox",
        "worker started"
    );
    let poll_interval_ms = std::env::var("WHATSAPP_INBOX_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    let batch_size = std::env::var("WHATSAPP_INBOX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(50);

    loop {
        match observability::result_span(
            "worker",
            "whatsapp_inbox.process_batch",
            crate::services::whatsapp::process_queued_inbox_messages(&pool, batch_size),
        )
        .await
        {
            Ok(processed) if processed > 0 => {
                observability::tracing::info!(
                    event = "queue.item.completed",
                    worker = "whatsapp_inbox",
                    items = processed,
                    "worker batch completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "whatsapp_inbox", error_type = %std::any::type_name_of_val(&error), "worker batch failed")
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
