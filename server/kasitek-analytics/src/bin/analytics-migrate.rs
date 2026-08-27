use kasitek_analytics::{config::AnalyticsConfig, connect_pool, error::AnalyticsError, migrations};

fn load_dotenv() {
    if dotenv::from_path(format!("{}/.env", env!("CARGO_MANIFEST_DIR"))).is_err() {
        dotenv::dotenv().ok();
    }
}

#[tokio::main]
async fn main() -> Result<(), AnalyticsError> {
    load_dotenv();
    let config = AnalyticsConfig::from_env()?;
    observability::init_with_service(&config.log_filter, "kasitek-analytics-migrate");
    let _telemetry_guard = observability::ShutdownGuard;
    let registry = kasitek_analytics::registry::load_registry()?;
    observability::tracing::info!(
        event = "service.startup",
        service = "kasitek-analytics",
        process = "analytics-migrate",
        phase = "registry_loaded",
        registry_sha256 = %registry.sha256,
        metrics_registry_version = %registry.metrics_registry_version,
        "analytics registry loaded"
    );
    let pool = connect_pool(&config).await?;

    observability::tracing::info!(
        event = "migration.started",
        service = "kasitek-analytics",
        process = "analytics-migrate",
        environment = %config.environment,
        "analytics migration starting"
    );
    observability::result_span(
        "migration",
        "analytics.sqlx_migrate",
        migrations::run(&pool),
    )
    .await?;
    observability::tracing::info!(
        event = "migration.completed",
        service = "kasitek-analytics",
        process = "analytics-migrate",
        "analytics migration completed"
    );
    pool.close().await;
    Ok(())
}
