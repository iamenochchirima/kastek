use thiserror::Error;

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("analytics configuration failed: {0}")]
    Config(#[from] crate::config::ConfigError),
    #[error("analytics database setup failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("analytics database connection timed out after {timeout_ms}ms")]
    DatabaseConnectTimeout { timeout_ms: u64 },
    #[error("analytics database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("analytics registry validation failed: {0}")]
    Registry(#[from] crate::registry::RegistryError),
    #[error("analytics API failed to bind: {0}")]
    Bind(#[from] std::io::Error),
}
