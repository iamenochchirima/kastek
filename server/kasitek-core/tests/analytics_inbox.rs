use std::env;

use kasitek_core::analytics::inbox::{
    enqueue_conversation_lifecycle, enqueue_manifest, enqueue_message_lifecycle,
};
use sqlx::{postgres::PgPoolOptions, Row};

#[tokio::test]
#[ignore = "requires a Core PostgreSQL database with the analytics outbox migration"]
async fn inbox_fact_is_written_to_the_same_transaction_and_stays_private() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut transaction = pool.begin().await.expect("transaction should start");

    enqueue_conversation_lifecycle(
        &mut transaction,
        "org_meta_a",
        "analytics-test-conversation",
        "whatsapp",
        "opened",
        "active",
        "customer",
        chrono::Utc::now(),
    )
    .await
    .expect("conversation fact should enqueue");
    enqueue_message_lifecycle(
        &mut transaction,
        "org_meta_a",
        "analytics-test-message",
        "analytics-test-conversation",
        "whatsapp",
        "created",
        "inbound",
        "customer",
        "text",
        None,
        None,
        chrono::Utc::now(),
    )
    .await
    .expect("message fact should enqueue");
    let manifest_at = chrono::Utc::now();
    enqueue_manifest(&mut transaction, "org_meta_a", 1, manifest_at)
        .await
        .expect("Meta source manifest should enqueue");
    enqueue_manifest(
        &mut transaction,
        "org_meta_a",
        2,
        manifest_at + chrono::Duration::minutes(5),
    )
    .await
    .expect("same-window Meta source manifest should coalesce");

    let rows = sqlx::query(
        r#"
        SELECT envelope
        FROM analytics_outbox
        WHERE source_domain = 'inbox'
          AND (record_id LIKE 'conversation:analytics-test-conversation:opened:%'
               OR record_id LIKE 'message:analytics-test-message:created:%')
        ORDER BY record_id
        "#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("facts should be visible before commit");
    assert_eq!(rows.len(), 2);
    for row in rows {
        let envelope: serde_json::Value = row.try_get("envelope").unwrap();
        let data = envelope
            .get("data")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        for prohibited in [
            "content",
            "message_body",
            "customer_identifier",
            "phone_number",
            "email",
            "provider_message_id",
            "credential",
            "token",
        ] {
            assert!(!data.contains_key(prohibited), "unexpected {prohibited}");
        }
    }

    let manifest_rows = sqlx::query(
        r#"
        SELECT envelope
        FROM analytics_outbox
        WHERE source_domain = 'inbox'
          AND record_category = 'manifest'
          AND record_id LIKE 'manifest:organization:org_meta_a:inbox:core.inbox.meta:%'
        "#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("Meta source manifest should be visible before commit");
    assert_eq!(manifest_rows.len(), 1);
    let manifest: serde_json::Value = manifest_rows[0].try_get("envelope").unwrap();
    let manifest_data = manifest
        .get("data")
        .and_then(serde_json::Value::as_object)
        .unwrap();
    assert_eq!(
        manifest_data
            .get("provider")
            .and_then(serde_json::Value::as_str),
        Some("meta")
    );
    assert_eq!(
        manifest_data
            .get("approved_checkpoint_count")
            .and_then(serde_json::Value::as_i64),
        Some(1)
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
        "content",
        "customer_identifier",
        "provider_message_id",
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
