use ::config::{env_truthy, environment_allows_loopback_origins, is_loopback_origin};
use actix_cors::Cors;
use actix_web::{middleware::Logger, web, App, HttpServer};
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
    log::info!("starting background workers in api server process");

    tokio::spawn(workers::whatsapp_inbox::run(pool.clone()));
    tokio::spawn(workers::social_publishing::run(pool.clone()));
    tokio::spawn(workers::whatsapp_campaigns::run(pool.clone()));
    tokio::spawn(workers::public_webhooks::run(pool.clone()));
    tokio::spawn(workers::billing_reconciliation::run(pool, config));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Always load this service's environment file, even when Cargo is launched
    // from the workspace root rather than `server/kasitek-core`.
    if from_path(format!("{}/.env", env!("CARGO_MANIFEST_DIR"))).is_err() {
        dotenv().ok();
    }
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
            workers::social_publishing::run(db_pool).await;
            return Ok(());
        }
        Some("whatsapp-marketing-worker") => {
            log::info!("starting whatsapp marketing worker");
            workers::whatsapp_campaigns::run(db_pool).await;
            return Ok(());
        }
        Some("whatsapp-inbox-worker") => {
            log::info!("starting whatsapp inbox worker");
            workers::whatsapp_inbox::run(db_pool).await;
            return Ok(());
        }
        Some("billing-reconciliation-worker") => {
            log::info!("starting billing reconciliation worker");
            workers::billing_reconciliation::run(db_pool, config).await;
            return Ok(());
        }
        Some("public-webhooks-worker") => {
            log::info!("starting public webhooks worker");
            workers::public_webhooks::run(db_pool).await;
            return Ok(());
        }
        Some("all-workers") => {
            log::info!("starting all workers");
            tokio::join!(
                workers::whatsapp_inbox::run(db_pool.clone()),
                workers::social_publishing::run(db_pool.clone()),
                workers::whatsapp_campaigns::run(db_pool.clone()),
                workers::public_webhooks::run(db_pool.clone()),
                workers::billing_reconciliation::run(db_pool.clone(), config.clone())
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
        log::info!(
            "background workers disabled for api server process; queued jobs require a separate worker deployment"
        );
    }

    log::info!("starting kasitek server on port {}", port);

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
            .wrap(Logger::default())
            .configure(configure_app)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
