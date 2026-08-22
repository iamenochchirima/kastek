//! Standalone customer analytics service foundation.
//!
//! A-01 intentionally contains only process startup, configuration, health,
//! and shared service contracts. Event ingestion, analytics storage schema,
//! projections, and reporting are implemented by later execution packages.

pub mod app;
pub mod config;
pub mod contracts;
pub mod error;
pub mod health;
pub mod worker;

use std::time::Duration;

use sqlx::{postgres::PgPoolOptions, PgPool};

use crate::{config::AnalyticsConfig, error::AnalyticsError};

/// Creates a lazy pool so the service can start and expose a truthful
/// not-ready response while PostgreSQL is unavailable. The first database
/// operation still fails normally until the dependency is reachable.
pub fn create_pool(config: &AnalyticsConfig) -> Result<PgPool, AnalyticsError> {
    PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(Duration::from_millis(config.database_acquire_timeout_ms))
        .connect_lazy(&config.database_url)
        .map_err(AnalyticsError::Database)
}
