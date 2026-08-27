use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
    observability::tracing::info!(
        event = "worker.started",
        worker = "public_webhooks",
        "worker started"
    );
    let poll_interval_ms = std::env::var("PUBLIC_WEBHOOK_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    let batch_size = std::env::var("PUBLIC_WEBHOOK_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);
    // Redirects are disabled so a destination that passed the public-host
    // check cannot bounce the worker into a private network address later.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("public webhook HTTP client must build");

    loop {
        match observability::result_span(
            "worker",
            "public_webhooks.process_batch",
            crate::services::public_webhooks::process_due_deliveries(&pool, &client, batch_size),
        )
        .await
        {
            Ok(processed) if processed > 0 => {
                observability::tracing::info!(
                    event = "queue.item.completed",
                    worker = "public_webhooks",
                    items = processed,
                    "worker batch completed"
                )
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "public_webhooks", error_type = %std::any::type_name_of_val(&error), "worker batch failed")
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
