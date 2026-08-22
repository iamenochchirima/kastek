use actix_web::{web, App, HttpServer};
use kasitek_analytics::{
    app, config::AnalyticsConfig, contracts::ProcessKind, create_pool, error::AnalyticsError,
};

fn load_dotenv() {
    if dotenv::from_path(format!("{}/.env", env!("CARGO_MANIFEST_DIR"))).is_err() {
        dotenv::dotenv().ok();
    }
}

#[actix_web::main]
async fn main() -> Result<(), AnalyticsError> {
    load_dotenv();
    let config = AnalyticsConfig::from_env()?;
    observability::init(&config.log_filter);
    let pool = create_pool(&config)?;
    let bind_address = (config.api_host.clone(), config.api_port);

    log::info!(
        "service=kasitek-analytics process=analytics-api status=starting host={} port={}",
        config.api_host,
        config.api_port
    );

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(pool.clone()))
            .configure(|cfg| app::configure(cfg, ProcessKind::Api))
    })
    .bind(bind_address)?
    .run()
    .await
    .map_err(AnalyticsError::Bind)
}
