use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "social_insights",
        "worker started"
    );
    let poll_interval_ms = std::env::var("SOCIAL_INSIGHTS_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(15 * 60 * 1_000);
    let batch_size = std::env::var("SOCIAL_INSIGHTS_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);

    loop {
        match observability::result_span(
            "worker",
            "social_insights.process_batch",
            crate::services::social_insights::sync_all_social_post_insights(&pool, batch_size),
        )
        .await
        {
            Ok(synced) if synced > 0 => {
                observability::tracing::info!(
                    event = "queue.item.completed",
                    worker = "social_insights",
                    items = synced,
                    "worker batch completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "social_insights", error_type = %std::any::type_name_of_val(&error), "worker batch failed")
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
