//! Standalone customer analytics service foundation.
//!
//! A-01 through A-09 contain process startup, storage foundations, registries,
//! scope authorization, immutable facts, source controls, authenticated
//! ingestion, and replay/reconciliation control foundations.

pub mod app;
pub mod authorization;
pub mod config;
pub mod contracts;
pub mod error;
pub mod generated_registry;
pub mod health;
pub mod ingestion;
pub mod metrics;
pub mod migrations;
pub mod reconciliation;
pub mod records;
pub mod registry;
pub mod scope;
pub mod worker;

use std::time::Duration;

use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions},
    PgPool,
};

use crate::{config::AnalyticsConfig, error::AnalyticsError};

/// Creates a lazy pool so the service can start and expose a truthful
/// not-ready response while PostgreSQL is unavailable. The first database
/// operation still fails normally until the dependency is reachable.
pub fn create_pool(config: &AnalyticsConfig) -> Result<PgPool, AnalyticsError> {
    pool_options(config)
        .connect_lazy(&config.database_url)
        .map_err(AnalyticsError::Database)
}

/// Connects eagerly for release jobs that must fail before deployment when the
/// dedicated analytics database is unavailable.
pub async fn connect_pool(config: &AnalyticsConfig) -> Result<PgPool, AnalyticsError> {
    let connection_options = connection_options(config)?;
    tokio::time::timeout(
        Duration::from_millis(config.database_connect_timeout_ms),
        pool_options(config).connect_with(connection_options),
    )
    .await
    .map_err(|_| AnalyticsError::DatabaseConnectTimeout {
        timeout_ms: config.database_connect_timeout_ms,
    })?
    .map_err(AnalyticsError::Database)
}

fn connection_options(config: &AnalyticsConfig) -> Result<PgConnectOptions, AnalyticsError> {
    config
        .database_url
        .parse::<PgConnectOptions>()
        .map_err(AnalyticsError::Database)
}

fn pool_options(config: &AnalyticsConfig) -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(Duration::from_millis(config.database_acquire_timeout_ms))
}
