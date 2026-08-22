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
    observability::init(&config.log_filter);
    let pool = connect_pool(&config).await?;

    log::info!(
        "service=kasitek-analytics process=analytics-migrate status=starting environment={}",
        config.environment
    );
    migrations::run(&pool).await?;
    log::info!("service=kasitek-analytics process=analytics-migrate status=completed");
    pool.close().await;
    Ok(())
}
