use sqlx::PgPool;

use crate::contracts::SERVICE_NAME;

/// Keeps the worker process alive until its projection and reconciliation
/// loops are added by later execution packages.
pub async fn run(_pool: PgPool) -> Result<(), std::io::Error> {
    log::info!(
        "service={} process=analytics-worker status=started projection_workers=disabled",
        SERVICE_NAME
    );
    tokio::signal::ctrl_c().await?;
    log::info!(
        "service={} process=analytics-worker status=stopping",
        SERVICE_NAME
    );
    Ok(())
}
