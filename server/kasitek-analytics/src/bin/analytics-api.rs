use actix_web::{web, App, HttpServer};
use kasitek_analytics::{
    app,
    config::AnalyticsConfig,
    contracts::ProcessKind,
    create_pool,
    error::AnalyticsError,
    ingestion::IngestionAuthenticator,
    metrics::{MetricsAccess, ProcessMetrics},
    reporting::{ReportingAuthenticator, ReportingCache},
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
    let registry = kasitek_analytics::registry::load_registry()?;
    let registry_access = web::Data::new(registry.clone());
    log::info!(
        "service=kasitek-analytics process=analytics-api status=registry_loaded registry_sha256={} metrics_registry_version={}",
        registry.sha256,
        registry.metrics_registry_version
    );
    let pool = create_pool(&config)?;
    let metrics = web::Data::new(ProcessMetrics::default());
    let metrics_access = web::Data::new(MetricsAccess::from_config(&config));
    let ingestion_access = web::Data::new(IngestionAuthenticator::from_config(&config));
    let reporting_access = web::Data::new(
        ReportingAuthenticator::from_config(&config).map_err(AnalyticsError::ReportingConfig)?,
    );
    let reporting_cache = web::Data::new(ReportingCache::from_config(&config));
    let bind_address = (config.api_host.clone(), config.api_port);

    log::info!(
        "service=kasitek-analytics process=analytics-api status=starting host={} port={}",
        config.api_host,
        config.api_port
    );

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(pool.clone()))
            .app_data(metrics.clone())
            .app_data(metrics_access.clone())
            .app_data(ingestion_access.clone())
            .app_data(reporting_access.clone())
            .app_data(reporting_cache.clone())
            .app_data(registry_access.clone())
            .app_data(
                web::JsonConfig::default().limit(kasitek_analytics::ingestion::MAX_BATCH_BYTES),
            )
            .wrap(observability::http_logger())
            .configure(|cfg| app::configure(cfg, ProcessKind::Api))
    })
    .bind(bind_address)?
    .run()
    .await
    .map_err(AnalyticsError::Bind)
}
