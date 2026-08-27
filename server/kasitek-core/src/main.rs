use ::config::{env_truthy, environment_allows_loopback_origins, is_loopback_origin};
use actix_cors::Cors;
use actix_web::{web, App, HttpServer};
use dotenv::{dotenv, from_path};
use kasitek_core::{
    bootstrap::{app::configure_app, state::AppState},
    config::AppConfig,
    workers,
};
use sqlx::postgres::PgPoolOptions;

fn env_flag(name: &str) -> bool {
    env_truthy(name)
}

fn background_workers_enabled_for_api() -> bool {
    !env_flag("KASITEK_DISABLE_BACKGROUND_WORKERS")
}

fn spawn_background_workers(pool: sqlx::PgPool, config: AppConfig) {
    observability::tracing::info!(
        event = "service.startup",
        component = "background_workers",
        process = "api",
        "background workers initialized"
    );

    tokio::spawn(observability::in_span(
        "worker",
        "whatsapp_inbox",
        workers::whatsapp_inbox::run(pool.clone()),
    ));
    tokio::spawn(observability::in_span(
        "worker",
        "social_publishing",
        workers::social_publishing::run(pool.clone()),
    ));
    tokio::spawn(observability::in_span(
        "worker",
        "social_insights",
        workers::social_insights::run(pool.clone()),
    ));
    tokio::spawn(observability::in_span(
        "worker",
        "whatsapp_campaigns",
        workers::whatsapp_campaigns::run(pool.clone()),
    ));
    tokio::spawn(observability::in_span(
        "worker",
        "public_webhooks",
        workers::public_webhooks::run(pool.clone()),
    ));
    tokio::spawn(observability::in_span(
        "worker",
        "billing_reconciliation",
        workers::billing_reconciliation::run(pool, config),
    ));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Always load this service's environment file, even when Cargo is launched
    // from the workspace root rather than `server/kasitek-core`.
    if from_path(format!("{}/.env", env!("CARGO_MANIFEST_DIR"))).is_err() {
        dotenv().ok();
    }
    observability::init_with_service("info", "kasitek-core");
    let _telemetry_guard = observability::ShutdownGuard;

    let config = AppConfig::from_env().expect("failed to load config");

    let db_pool = observability::result_span(
        "database",
        "postgres.connect",
        PgPoolOptions::new()
            .max_connections(config.database_max_connections)
            .connect(&config.database_url),
    )
    .await
    .expect("failed to connect to postgres");

    match std::env::var("KASITEK_PROCESS").ok().as_deref() {
        Some("social-publishing-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "social_publishing");
            observability::in_span(
                "worker",
                "social_publishing",
                workers::social_publishing::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("social-insights-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "social_insights");
            observability::in_span(
                "worker",
                "social_insights",
                workers::social_insights::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("whatsapp-marketing-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "whatsapp_campaigns");
            observability::in_span(
                "worker",
                "whatsapp_marketing",
                workers::whatsapp_campaigns::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("whatsapp-inbox-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "whatsapp_inbox");
            observability::in_span(
                "worker",
                "whatsapp_inbox",
                workers::whatsapp_inbox::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("billing-reconciliation-worker") => {
            observability::tracing::info!(
                event = "worker.started",
                worker = "billing_reconciliation"
            );
            observability::in_span(
                "worker",
                "billing_reconciliation",
                workers::billing_reconciliation::run(db_pool, config),
            )
            .await;
            return Ok(());
        }
        Some("analytics-publisher") => {
            observability::tracing::info!(event = "worker.started", worker = "analytics_publisher");
            tokio::join!(
                observability::in_span(
                    "worker",
                    "analytics_publisher",
                    workers::analytics_publisher::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "analytics_backfill",
                    workers::analytics_backfill::run(db_pool)
                )
            );
            return Ok(());
        }
        Some("analytics-backfill-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "analytics_backfill");
            observability::in_span(
                "worker",
                "analytics_backfill",
                workers::analytics_backfill::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("public-webhooks-worker") => {
            observability::tracing::info!(event = "worker.started", worker = "public_webhooks");
            observability::in_span(
                "worker",
                "public_webhooks",
                workers::public_webhooks::run(db_pool),
            )
            .await;
            return Ok(());
        }
        Some("all-workers") => {
            observability::tracing::info!(event = "worker.started", worker = "all");
            tokio::join!(
                observability::in_span(
                    "worker",
                    "whatsapp_inbox",
                    workers::whatsapp_inbox::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "social_publishing",
                    workers::social_publishing::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "social_insights",
                    workers::social_insights::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "whatsapp_campaigns",
                    workers::whatsapp_campaigns::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "public_webhooks",
                    workers::public_webhooks::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "billing_reconciliation",
                    workers::billing_reconciliation::run(db_pool.clone(), config.clone())
                ),
                observability::in_span(
                    "worker",
                    "analytics_publisher",
                    workers::analytics_publisher::run(db_pool.clone())
                ),
                observability::in_span(
                    "worker",
                    "analytics_backfill",
                    workers::analytics_backfill::run(db_pool.clone())
                )
            );
            return Ok(());
        }
        _ => {}
    }

    let port = config.port;
    let frontend_origin = config.frontend_url.clone();
    let allow_loopback_origins = environment_allows_loopback_origins(&config.environment);

    if background_workers_enabled_for_api() {
        spawn_background_workers(db_pool.clone(), config.clone());
    } else {
        observability::tracing::info!(
            event = "worker.disabled",
            process = "api",
            reason = "separate_worker_deployment_required",
            "background workers disabled"
        );
    }

    observability::tracing::info!(
        event = "service.startup",
        service = "kasitek-core",
        process = "api",
        port,
        "server starting"
    );

    HttpServer::new(move || {
        let mut cors = Cors::default()
            .allowed_origin(&frontend_origin)
            .allowed_methods(vec!["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"])
            .allowed_headers(vec!["Content-Type", "Authorization"])
            .supports_credentials()
            .max_age(3600);

        if allow_loopback_origins {
            cors = cors.allowed_origin_fn(|origin, _req_head| {
                origin.to_str().is_ok_and(is_loopback_origin)
            });
        }

        App::new()
            .app_data(web::Data::new(db_pool.clone()))
            .app_data(web::Data::new(config.clone()))
            .app_data(web::Data::new(AppState::new(
                db_pool.clone(),
                config.clone(),
            )))
            .wrap(cors)
            .wrap(observability::correlation_id())
            .wrap(observability::http_metrics())
            .wrap(observability::http_tracing_logger())
            .wrap(observability::http_logger())
            .configure(configure_app)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
