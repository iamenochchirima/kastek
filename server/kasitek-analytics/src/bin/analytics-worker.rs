use kasitek_analytics::{config::AnalyticsConfig, create_pool, error::AnalyticsError, worker};

fn load_dotenv() {
    if dotenv::from_path(format!("{}/.env", env!("CARGO_MANIFEST_DIR"))).is_err() {
        dotenv::dotenv().ok();
    }
}

#[tokio::main]
async fn main() -> Result<(), AnalyticsError> {
    load_dotenv();
    let config = AnalyticsConfig::from_env()?;
    observability::init(&config.log_filter);
    let registry = kasitek_analytics::registry::load_registry()?;
    log::info!(
        "service=kasitek-analytics process=analytics-worker status=registry_loaded registry_sha256={} metrics_registry_version={}",
        registry.sha256,
        registry.metrics_registry_version
    );
    let pool = create_pool(&config)?;
    worker::run(pool, registry)
        .await
        .map_err(AnalyticsError::Bind)
}
