use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "social_publishing",
        "worker started"
    );
    let poll_interval_ms = std::env::var("SOCIAL_PUBLISH_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10_000);
    let batch_size = std::env::var("SOCIAL_PUBLISH_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(10);

    loop {
        match observability::result_span(
            "worker",
            "social_publishing.process_batch",
            crate::services::social::process_due_social_publish_jobs(&pool, batch_size),
        )
        .await
        {
            Ok(processed) if processed > 0 => {
                observability::tracing::info!(
                    event = "queue.item.completed",
                    worker = "social_publishing",
                    items = processed,
                    "worker batch completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "social_publishing", error_type = %std::any::type_name_of_val(&error), "worker batch failed")
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
