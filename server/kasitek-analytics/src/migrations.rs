use sqlx::PgPool;

use crate::{contracts::SERVICE_NAME, error::AnalyticsError};

/// Stable application-wide advisory lock for the analytics release job.
///
/// The migration runner and the deployment system use this lock instead of
/// relying on application startup ordering. It is held on the same PostgreSQL
/// connection used by SQLx's migration runner.
pub const MIGRATION_LOCK_KEY: i64 = 7_482_031_945;
pub const FOUNDATION_MIGRATION_VERSION: i64 = 20260822000000;

// The embedded migrator is rebuilt whenever the analytics migration set changes, including
// generation lifecycle, shadow-pointer compatibility, maintenance orchestration, and projection
// builder control migrations.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn run(pool: &PgPool) -> Result<(), AnalyticsError> {
    let mut connection = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *connection)
        .await?;

    log::info!(
        "service={} process=analytics-migrate status=locked lock_key={}",
        SERVICE_NAME,
        MIGRATION_LOCK_KEY
    );

    let migration_result = MIGRATOR.run(&mut *connection).await;
    let unlock_result = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *connection)
        .await;

    if let Err(error) = unlock_result {
        return Err(AnalyticsError::Database(error));
    }

    migration_result.map_err(AnalyticsError::Migration)
}

#[cfg(test)]
mod tests {
    use super::MIGRATION_LOCK_KEY;

    #[test]
    fn migration_lock_key_is_stable_and_non_zero() {
        assert_ne!(MIGRATION_LOCK_KEY, 0);
    }
}
