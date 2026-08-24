use std::env;

use kasitek_core::analytics::connections::{
    enqueue_capability_lifecycle, enqueue_health_check, enqueue_lifecycle, enqueue_sync_attempt,
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
    assert_eq!(rows.len(), 4);
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

    transaction
        .rollback()
        .await
        .expect("test transaction should roll back");
    pool.close().await;
}
