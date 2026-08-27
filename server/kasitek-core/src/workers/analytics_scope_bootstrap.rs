use chrono::{DateTime, Utc};
use sqlx::PgPool;

/// Queue a durable scope definition for every existing Core organization that
/// predates transactional scope publication.
///
/// The check is against the Core outbox, not the Analytics database. This keeps
/// the repair safe to rerun and preserves the outbox as the only source-to-
/// Analytics boundary.
pub async fn enqueue_missing_scope_definitions(pool: &PgPool) -> Result<usize, String> {
    let organizations: Vec<(String, DateTime<Utc>, String)> = sqlx::query_as(
        r#"SELECT id, "createdAt" AT TIME ZONE 'UTC' AS created_at, "reportingTimezone"
           FROM "Organization"
           ORDER BY id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| {
        format!("failed to list Core organizations for Analytics bootstrap: {error}")
    })?;

    let mut queued = 0;
    for (organization_id, created_at, reporting_timezone) in organizations {
        let mut transaction = pool
            .begin()
            .await
            .map_err(|error| format!("failed to start Analytics bootstrap transaction: {error}"))?;
        let already_queued: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(
                 SELECT 1
                 FROM analytics_outbox
                 WHERE source_service = 'core'
                   AND record_category = 'scope_definition'
                   AND scope_kind = 'core_organization'
                   AND scope_external_id = $1
               )"#,
        )
        .bind(&organization_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("failed to inspect Core Analytics outbox: {error}"))?;

        if !already_queued {
            crate::analytics::enqueue_organization_scope_definition(
                &mut transaction,
                &organization_id,
                created_at.timestamp_millis().max(1),
                &reporting_timezone,
                "active",
            )
            .await
            .map_err(|error| {
                format!("failed to queue organization {organization_id} scope: {error}")
            })?;
            queued += 1;
        }

        transaction.commit().await.map_err(|error| {
            format!("failed to commit Analytics bootstrap transaction: {error}")
        })?;
    }

    Ok(queued)
}
