use ::config::{environment_allows_loopback_origins, is_loopback_origin};
use actix_cors::Cors;
use actix_web::{middleware::Logger, web, App, HttpServer};
use dotenv::dotenv;
use sqlx::postgres::PgPoolOptions;

mod config;
mod controllers;
mod db;
mod error;
mod middleware;
mod routes;
mod services;

use config::AppConfig;

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

    let port = config.port;
    let frontend_origin = config.frontend_url.clone();
    let allow_loopback_origins = environment_allows_loopback_origins(&config.environment);

    log::info!("starting kasitek-calls service on port {}", port);

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
            .wrap(cors)
            .wrap(Logger::default())
            .configure(routes::configure)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
