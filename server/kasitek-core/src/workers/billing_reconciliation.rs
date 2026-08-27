use sqlx::PgPool;
use tokio::time::{sleep, Duration};

use crate::{config::AppConfig, services::billing_provider::BillingProvider};

pub async fn run(pool: PgPool, config: AppConfig) {
    let Some(secret) = config
        .paystack_secret_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        observability::tracing::info!(
            event = "worker.disabled",
            worker = "billing_reconciliation",
            reason = "paystack_not_configured",
            "worker disabled"
        );
        return;
    };
    let provider =
        crate::services::paystack::PaystackProvider::new(secret, &config.paystack_api_base_url);
    observability::tracing::info!(event = "worker.started", worker = "billing_reconciliation", provider = %provider.name(), "worker started");
    observability::tracing::info!(
        event = "worker.started",
        worker = "billing_reconciliation",
        provider = %provider.name(),
        mode = %config.paystack_mode,
        "billing reconciliation provider configured"
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
        match observability::result_span(
            "worker",
            "billing_reconciliation.process_batch",
            crate::services::billing::reconcile_billing(
                &pool,
                &provider,
                batch_size,
                crate::services::referrals::ReferralRewardConfig::from_config(&config),
            ),
        )
        .await
        {
            Ok(result) if result.checked > 0 || result.subscriptions_checked > 0 => {
                observability::tracing::info!(event = "queue.item.completed", worker = "billing_reconciliation", provider = %provider.name(), items = result.checked, completed = result.completed, pending = result.pending, retries = result.webhook_retries, "billing reconciliation batch completed");
                if result.webhook_retries > 0 {
                    observability::record_retry(
                        "worker",
                        "billing_reconciliation.webhook",
                        result.webhook_retries as u64,
                    );
                }
                if result.failed > 0 {
                    observability::tracing::warn!(
                        event = "operation.terminal.failure",
                        worker = "billing_reconciliation",
                        items = result.failed,
                        "billing reconciliation requires operator review"
                    );
                }
            }
            Ok(_) => {}
            Err(error) => {
                observability::tracing::error!(event = "queue.item.failed", worker = "billing_reconciliation", error_type = %std::any::type_name_of_val(&error), "billing reconciliation batch failed")
            }
        }
        sleep(Duration::from_secs(interval_seconds)).await;
    }
}
