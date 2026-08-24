use std::env;

use chrono::TimeZone;
use kasitek_core::analytics::connections::{
    enqueue_capability_lifecycle, enqueue_health_check, enqueue_incident_lifecycle,
    enqueue_lifecycle, enqueue_manifest, enqueue_rate_limit, enqueue_sync_attempt,
};
use sqlx::{postgres::PgPoolOptions, Row};

#[tokio::test]
#[ignore = "requires a Core PostgreSQL database with the analytics outbox migration"]
async fn connection_facts_are_transactional_and_privacy_safe() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut transaction = pool.begin().await.expect("transaction should start");

    enqueue_lifecycle(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "connected",
        "CONNECTED",
        "ACTIVE",
        "HEALTHY",
        "UNKNOWN",
        chrono::Utc::now(),
    )
    .await
    .expect("connection lifecycle fact should enqueue");
    enqueue_health_check(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "CONNECTED",
        "HEALTHY",
        "ACTIVE",
        "HEALTHY",
        true,
        chrono::Utc::now(),
    )
    .await
    .expect("connection health fact should enqueue");
    enqueue_capability_lifecycle(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "MESSAGING_INBOUND",
        true,
        chrono::Utc::now(),
    )
    .await
    .expect("connection capability fact should enqueue");
    enqueue_sync_attempt(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "sync-attempt-123",
        "connection_refresh",
        "succeeded",
        "none",
        284,
        chrono::Utc::now(),
    )
    .await
    .expect("connection synchronization fact should enqueue");
    enqueue_rate_limit(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "connection_refresh",
        "provider",
        None,
        chrono::Utc::now(),
    )
    .await
    .expect("connection rate-limit fact should enqueue");
    enqueue_incident_lifecycle(
        &mut transaction,
        "org_connections_a",
        "ext_analytics-connection",
        "WHATSAPP",
        "connection_health",
        "opened",
        "critical",
        "provider_health_failed",
        chrono::Utc::now(),
    )
    .await
    .expect("connection incident fact should enqueue");
    let first_manifest_at = chrono::Utc
        .with_ymd_and_hms(2026, 8, 24, 10, 12, 0)
        .unwrap();
    enqueue_manifest(&mut transaction, "org_connections_a", 4, first_manifest_at)
        .await
        .expect("connection source manifest should enqueue");
    enqueue_manifest(
        &mut transaction,
        "org_connections_a",
        5,
        first_manifest_at + chrono::Duration::minutes(5),
    )
    .await
    .expect("same-window source manifest should coalesce");

    let rows = sqlx::query(
        r#"
        SELECT envelope
        FROM analytics_outbox
        WHERE source_domain = 'connections'
          AND record_id LIKE 'connection:ext_analytics-connection:%'
        ORDER BY record_id
        "#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("facts should be visible before commit");
    assert_eq!(rows.len(), 6);
    for row in rows {
        let envelope: serde_json::Value = row.try_get("envelope").unwrap();
        let data = envelope
            .get("data")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        for prohibited in [
            "display_name",
            "handle",
            "external_account_id",
            "metadata",
            "last_error",
            "provider_payload",
            "credential",
            "token",
        ] {
            assert!(!data.contains_key(prohibited), "unexpected {prohibited}");
        }
        assert_eq!(
            data.get("connection_id").and_then(|value| value.as_str()),
            Some("ext_analytics-connection")
        );
    }

    let manifest_rows = sqlx::query(
        r#"
        SELECT envelope
        FROM analytics_outbox
        WHERE source_domain = 'connections'
          AND record_category = 'manifest'
          AND record_id LIKE 'manifest:organization:org_connections_a:connections:%'
        "#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("manifest should be visible before commit");
    assert_eq!(manifest_rows.len(), 1);
    let manifest: serde_json::Value = manifest_rows[0].try_get("envelope").unwrap();
    let manifest_data = manifest
        .get("data")
        .and_then(serde_json::Value::as_object)
        .unwrap();
    assert_eq!(
        manifest_data
            .get("approved_checkpoint_count")
            .and_then(serde_json::Value::as_i64),
        Some(4)
    );
    assert!(manifest_data
        .get("reliable_coverage_start")
        .is_some_and(serde_json::Value::is_null));
    assert_eq!(
        manifest_data
            .get("manifest_state")
            .and_then(serde_json::Value::as_str),
        Some("active")
    );
    for prohibited in [
        "display_name",
        "handle",
        "external_account_id",
        "metadata",
        "last_error",
        "provider_payload",
        "credential",
        "token",
    ] {
        assert!(
            !manifest_data.contains_key(prohibited),
            "unexpected {prohibited}"
        );
    }

    transaction
        .rollback()
        .await
        .expect("test transaction should roll back");
    pool.close().await;
}
