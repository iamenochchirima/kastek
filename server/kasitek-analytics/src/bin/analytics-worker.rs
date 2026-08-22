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
    let pool = create_pool(&config)?;
    worker::run(pool).await.map_err(AnalyticsError::Bind)
}
