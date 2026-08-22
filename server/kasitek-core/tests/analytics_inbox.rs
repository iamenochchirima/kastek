use std::env;

use kasitek_core::analytics::inbox::{enqueue_conversation_lifecycle, enqueue_message_lifecycle};
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

    transaction
        .rollback()
        .await
        .expect("test transaction should roll back");
    pool.close().await;
}
