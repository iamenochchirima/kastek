use std::env;

use chrono::Utc;
use kasitek_core::analytics::campaigns::{
    enqueue_recipient_blocked, enqueue_recipient_delivered, enqueue_recipient_failed,
    enqueue_recipient_read, enqueue_recipient_sent, enqueue_recipient_suppressed,
    enqueue_recipient_unsubscribed,
};
use sqlx::{postgres::PgPoolOptions, Row};

#[tokio::test]
#[ignore = "requires a Core PostgreSQL database with the analytics outbox migration"]
async fn campaign_delivery_facts_are_transactional_and_privacy_safe() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut transaction = pool.begin().await.expect("transaction should start");

    enqueue_recipient_sent(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-sent",
        "whatsapp",
        "meta",
        Utc::now(),
    )
    .await
    .expect("sent fact should enqueue");
    enqueue_recipient_delivered(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-delivered",
        "whatsapp",
        "meta",
        Utc::now(),
    )
    .await
    .expect("delivered fact should enqueue");
    enqueue_recipient_read(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-delivered",
        "whatsapp",
        "meta",
        Utc::now(),
    )
    .await
    .expect("read fact should enqueue");
    enqueue_recipient_failed(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-failed",
        "whatsapp",
        "meta",
        "provider_rejected",
        Utc::now(),
    )
    .await
    .expect("failed fact should enqueue");
    enqueue_recipient_blocked(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-blocked",
        "whatsapp",
        "meta",
        "provider_blocked",
        Utc::now(),
    )
    .await
    .expect("blocked fact should enqueue");
    enqueue_recipient_suppressed(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-suppressed",
        "whatsapp",
        "meta",
        "contact_excluded",
        Utc::now(),
    )
    .await
    .expect("suppressed fact should enqueue");
    enqueue_recipient_unsubscribed(
        &mut transaction,
        "org_campaigns_a",
        "campaign-analytics",
        "recipient-unsubscribed",
        "whatsapp",
        "meta",
        "keyword",
        Utc::now(),
    )
    .await
    .expect("unsubscribed fact should enqueue");

    let rows = sqlx::query(
        r#"
        SELECT record_id, envelope
        FROM analytics_outbox
        WHERE source_domain = 'campaigns'
          AND record_id LIKE 'campaign-recipient:campaign-analytics:%'
        ORDER BY record_id
        "#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("campaign facts should be visible before commit");
    assert_eq!(rows.len(), 7);
    for row in rows {
        let record_id: String = row.try_get("record_id").unwrap();
        let envelope: serde_json::Value = row.try_get("envelope").unwrap();
        let data = envelope
            .get("data")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert_eq!(
            data.get("channel").and_then(|value| value.as_str()),
            Some("whatsapp")
        );
        assert_eq!(
            data.get("provider").and_then(|value| value.as_str()),
            Some("meta")
        );
        assert!(
            record_id.ends_with(":sent")
                || record_id.ends_with(":delivered")
                || record_id.ends_with(":read")
                || record_id.ends_with(":failed")
                || record_id.ends_with(":blocked")
                || record_id.ends_with(":suppressed")
                || record_id.ends_with(":unsubscribed")
        );
        if record_id.ends_with(":failed") {
            assert_eq!(
                data.get("failure_class").and_then(|value| value.as_str()),
                Some("provider_rejected")
            );
        } else if record_id.ends_with(":blocked") {
            assert_eq!(
                data.get("block_class").and_then(|value| value.as_str()),
                Some("provider_blocked")
            );
        } else if record_id.ends_with(":suppressed") {
            assert_eq!(
                data.get("suppression_class")
                    .and_then(|value| value.as_str()),
                Some("contact_excluded")
            );
        } else if record_id.ends_with(":unsubscribed") {
            assert_eq!(
                data.get("unsubscribe_source")
                    .and_then(|value| value.as_str()),
                Some("keyword")
            );
        } else {
            assert!(data.get("failure_class").is_none());
            assert!(data.get("block_class").is_none());
        }
        for prohibited in [
            "phone_number",
            "email",
            "message_body",
            "credential",
            "token",
            "provider_payload",
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
