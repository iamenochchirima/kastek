use thiserror::Error;

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("analytics configuration failed: {0}")]
    Config(#[from] crate::config::ConfigError),
    #[error("analytics database setup failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("analytics API failed to bind: {0}")]
    Bind(#[from] std::io::Error),
}
