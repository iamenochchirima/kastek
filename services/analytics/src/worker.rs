use sqlx::PgPool;

use crate::{contracts::SERVICE_NAME, registry::RegistrySnapshot};

/// Runs the analytics worker's durable projection, reconciliation, and backfill loops.
pub async fn run(pool: PgPool, registry: RegistrySnapshot) -> Result<(), std::io::Error> {
    observability::tracing::info!(
        event = "worker.started",
        service = SERVICE_NAME,
        process = "analytics-worker",
        worker = "projections",
        "analytics projection workers starting"
    );
    crate::projections::run(pool, registry).await
}
