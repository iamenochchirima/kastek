use sqlx::PgPool;
use tokio::time::{sleep, Duration};

pub async fn run(pool: PgPool) {
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
        match crate::services::public_webhooks::process_due_deliveries(&pool, &client, batch_size)
            .await
        {
            Ok(processed) if processed > 0 => {
                log::info!("[public-webhooks-worker] processed={processed}")
            }
            Ok(_) => {}
            Err(error) => log::error!("[public-webhooks-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}
