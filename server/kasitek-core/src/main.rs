use ::config::env_truthy;
use actix_cors::Cors;
use actix_web::{middleware::Logger, web, App, HttpServer};
use dotenv::dotenv;
use sqlx::postgres::PgPoolOptions;
use tokio::time::{sleep, Duration};

mod config;
mod controllers;
mod db;
mod error;
mod middleware;
mod routes;
mod services;

use config::AppConfig;

async fn run_social_worker(pool: sqlx::PgPool) {
    let poll_interval_ms = std::env::var("SOCIAL_PUBLISH_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10_000);
    let batch_size = std::env::var("SOCIAL_PUBLISH_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(10);

    loop {
        match services::social::process_due_social_publish_jobs(&pool, batch_size).await {
            Ok(processed) if processed > 0 => {
                log::info!("[social-publishing-worker] processed={}", processed);
            }
            Ok(_) => {}
            Err(error) => {
                log::error!("[social-publishing-worker] iteration failed: {}", error);
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}

async fn run_whatsapp_marketing_worker(pool: sqlx::PgPool) {
    let poll_interval_ms = std::env::var("WHATSAPP_MARKETING_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("WHATSAPP_MARKETING_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(25);

    loop {
        match services::whatsapp::process_queued_campaign_recipients(&pool, batch_size).await {
            Ok(processed) if processed > 0 => {
                log::info!("[whatsapp-marketing-worker] processed={}", processed);
            }
            Ok(_) => {}
            Err(error) => {
                log::error!("[whatsapp-marketing-worker] iteration failed: {}", error);
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}

async fn run_whatsapp_inbox_worker(pool: sqlx::PgPool) {
    let poll_interval_ms = std::env::var("WHATSAPP_INBOX_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    let batch_size = std::env::var("WHATSAPP_INBOX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(50);

    loop {
        match services::whatsapp::process_queued_inbox_messages(&pool, batch_size).await {
            Ok(processed) if processed > 0 => {
                log::info!("[whatsapp-inbox-worker] processed={}", processed);
            }
            Ok(_) => {}
            Err(error) => {
                log::error!("[whatsapp-inbox-worker] iteration failed: {}", error);
            }
        }
        sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}

async fn run_billing_reconciliation_worker(pool: sqlx::PgPool, config: AppConfig) {
    use services::billing_provider::BillingProvider;

    let Some(secret) = config
        .paystack_secret_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        log::info!("billing reconciliation worker disabled: Paystack is not configured");
        return;
    };
    let provider = services::paystack::PaystackProvider::new(secret, &config.paystack_api_base_url);
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
        match services::billing::reconcile_billing(&pool, &provider, batch_size).await {
            Ok(result) if result.checked > 0 || result.subscriptions_checked > 0 => {
                log::info!(
                    "[billing-reconciliation-worker] provider={} checkouts={} completed={} pending={} subscriptions={} updated={} failed={} open_issues={}",
                    provider.name(), result.checked, result.completed, result.pending,
                    result.subscriptions_checked, result.subscriptions_updated, result.failed,
                    result.open_issues
                );
                if result.failed > 0 {
                    log::warn!(
                        "[billing-reconciliation-worker] {} checkout(s) require operator review",
                        result.failed
                    );
                }
            }
            Ok(_) => {}
            Err(error) => {
                log::error!(
                    "[billing-reconciliation-worker] iteration failed: {}",
                    error
                );
            }
        }
        sleep(Duration::from_secs(interval_seconds)).await;
    }
}

fn env_flag(name: &str) -> bool {
    env_truthy(name)
}

fn background_workers_enabled_for_api() -> bool {
    !env_flag("KASITEK_DISABLE_BACKGROUND_WORKERS")
}

fn spawn_background_workers(pool: sqlx::PgPool, config: AppConfig) {
    log::info!("starting background workers in api server process");

    tokio::spawn(run_whatsapp_inbox_worker(pool.clone()));
    tokio::spawn(run_social_worker(pool.clone()));
    tokio::spawn(run_whatsapp_marketing_worker(pool.clone()));
    tokio::spawn(run_billing_reconciliation_worker(pool, config));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv().ok();
    observability::init("info");

    let config = AppConfig::from_env().expect("failed to load config");

    let db_pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to postgres");

    match std::env::var("KASITEK_PROCESS").ok().as_deref() {
        Some("social-publishing-worker") => {
            log::info!("starting social publishing worker");
            run_social_worker(db_pool).await;
            return Ok(());
        }
        Some("whatsapp-marketing-worker") => {
            log::info!("starting whatsapp marketing worker");
            run_whatsapp_marketing_worker(db_pool).await;
            return Ok(());
        }
        Some("whatsapp-inbox-worker") => {
            log::info!("starting whatsapp inbox worker");
            run_whatsapp_inbox_worker(db_pool).await;
            return Ok(());
        }
        Some("billing-reconciliation-worker") => {
            log::info!("starting billing reconciliation worker");
            run_billing_reconciliation_worker(db_pool, config).await;
            return Ok(());
        }
        Some("all-workers") => {
            log::info!("starting all workers");
            tokio::join!(
                run_whatsapp_inbox_worker(db_pool.clone()),
                run_social_worker(db_pool.clone()),
                run_whatsapp_marketing_worker(db_pool.clone()),
                run_billing_reconciliation_worker(db_pool.clone(), config.clone())
            );
            return Ok(());
        }
        _ => {}
    }

    let port = config.port;
    let frontend_origin = config.frontend_url.clone();

    if background_workers_enabled_for_api() {
        spawn_background_workers(db_pool.clone(), config.clone());
    } else {
        log::info!(
            "background workers disabled for api server process; queued jobs require a separate worker deployment"
        );
    }

    log::info!("starting kasitek server on port {}", port);

    HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin(&frontend_origin)
            .allowed_origin("http://localhost:3000")
            .allowed_origin("http://localhost:3001")
            .allowed_methods(vec!["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"])
            .allowed_headers(vec!["Content-Type", "Authorization"])
            .supports_credentials()
            .max_age(3600);

        App::new()
            .app_data(web::Data::new(db_pool.clone()))
            .app_data(web::Data::new(config.clone()))
            .wrap(cors)
            .wrap(Logger::default())
            .configure(routes::configure)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
