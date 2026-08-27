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
    observability::init_with_service(&config.log_filter, "kasitek-analytics-worker");
    let _telemetry_guard = observability::ShutdownGuard;
    let registry = kasitek_analytics::registry::load_registry()?;
    observability::tracing::info!(
        event = "service.startup",
        service = "kasitek-analytics",
        process = "analytics-worker",
        phase = "registry_loaded",
        registry_sha256 = %registry.sha256,
        metrics_registry_version = %registry.metrics_registry_version,
        "analytics registry loaded"
    );
    let pool = create_pool(&config)?;
    worker::run(pool, registry)
        .await
        .map_err(AnalyticsError::Bind)
}
