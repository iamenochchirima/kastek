use sqlx::PgPool;
use tokio::time::{sleep, Duration};

use crate::{config::AppConfig, services::email};

pub async fn run(pool: PgPool, config: AppConfig) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "email_inbox",
        "worker started"
    );
    let poll_interval_ms = std::env::var("EMAIL_INBOX_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000);
    let batch_size = std::env::var("EMAIL_INBOX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(10);

    loop {
        match observability::result_span(
            "worker",
            "email_inbox.process_batch",
            email::sync_all_connections(&pool, &config, batch_size),
        )
        .await
        {
            Ok(processed) if processed > 0 => observability::tracing::info!(
                event = "queue.item.completed",
                worker = "email_inbox",
                items = processed,
                "email Inbox sync batch completed"
            ),
            Ok(_) => {}
            Err(error) => observability::tracing::error!(
                event = "queue.item.failed",
                worker = "email_inbox",
                error_type = %std::any::type_name_of_val(&error),
                "email Inbox sync batch failed"
            ),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
