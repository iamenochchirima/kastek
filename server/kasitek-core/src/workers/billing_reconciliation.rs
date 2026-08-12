use sqlx::PgPool;
use tokio::time::{sleep, Duration};

use crate::{config::AppConfig, services::billing_provider::BillingProvider};

pub async fn run(pool: PgPool, config: AppConfig) {
    let Some(secret) = config
        .paystack_secret_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        log::info!("billing reconciliation worker disabled: Paystack is not configured");
        return;
    };
    let provider =
        crate::services::paystack::PaystackProvider::new(secret, &config.paystack_api_base_url);
    log::info!(
        "billing reconciliation worker configured for Paystack {} mode",
        config.paystack_mode
    );
    let interval_seconds = std::env::var("PAYSTACK_RECONCILIATION_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300)
        .max(30);
    let batch_size = std::env::var("PAYSTACK_RECONCILIATION_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(100);

    loop {
        match crate::services::billing::reconcile_billing(&pool, &provider, batch_size).await {
            Ok(result) if result.checked > 0 || result.subscriptions_checked > 0 => {
                log::info!("[billing-reconciliation-worker] provider={} checkouts={} completed={} pending={} subscriptions={} updated={} failed={} open_issues={}", provider.name(), result.checked, result.completed, result.pending, result.subscriptions_checked, result.subscriptions_updated, result.failed, result.open_issues);
                if result.failed > 0 {
                    log::warn!(
                        "[billing-reconciliation-worker] {} checkout(s) require operator review",
                        result.failed
                    );
                }
            }
            Ok(_) => {}
            Err(error) => log::error!("[billing-reconciliation-worker] iteration failed: {error}"),
        }
        sleep(Duration::from_secs(interval_seconds)).await;
    }
}
