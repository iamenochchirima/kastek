use sqlx::PgPool;

use crate::{contracts::SERVICE_NAME, registry::RegistrySnapshot};

/// Runs the analytics worker's durable projection loop.
pub async fn run(pool: PgPool, registry: RegistrySnapshot) -> Result<(), std::io::Error> {
    log::info!(
        "service={} process=analytics-worker status=starting projection_workers=enabled",
        SERVICE_NAME
    );
    crate::projections::run(pool, registry).await
}
