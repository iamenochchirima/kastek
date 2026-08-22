use std::env;

use analytics_producer::{
    apply_delivery_outcome, build_event, claim_outbox_batch, enqueue_outbox, DeliveryOutcome,
    EnqueueResult, EventInput, ProducerConfig, ScopeKind,
};
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
async fn enqueue_claim_retry_and_conflict_are_transactional() {
    let Some(database_url) = env::var("ANALYTICS_PRODUCER_TEST_DATABASE_URL").ok() else {
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("producer test database must be reachable");

    sqlx::query(
        "CREATE TEMP TABLE analytics_outbox (LIKE public.analytics_outbox INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT PRESERVE ROWS",
    )
    .execute(&pool)
    .await
    .expect("temporary outbox must be created");

    let record = build_event(
        &ProducerConfig::core(),
        EventInput {
            record_id: "a07-test-event".to_string(),
            source_domain: "campaigns".to_string(),
            source_stream_key: "core:test-org".to_string(),
            contract_name: "campaign.recipient_sent@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: "a07-test-org".to_string(),
            subject_type: "recipient".to_string(),
            subject_id: "recipient-1".to_string(),
            occurred_at: Utc::now(),
            attributes: json!({"count": 1}),
            correlation_id: None,
            causation_id: None,
            idempotency_key: None,
        },
    )
    .unwrap();

    let mut transaction = pool.begin().await.unwrap();
    assert!(matches!(
        enqueue_outbox(&mut transaction, &record).await.unwrap(),
        EnqueueResult::Inserted { .. }
    ));
    assert!(matches!(
        enqueue_outbox(&mut transaction, &record).await.unwrap(),
        EnqueueResult::Duplicate { .. }
    ));
    transaction.commit().await.unwrap();

    let conflict = build_event(
        &ProducerConfig::core(),
        EventInput {
            attributes: json!({"count": 2}),
            ..EventInput {
                record_id: "a07-test-event".to_string(),
                source_domain: "campaigns".to_string(),
                source_stream_key: "core:test-org".to_string(),
                contract_name: "campaign.recipient_sent@1".to_string(),
                schema_version: 1,
                scope_kind: ScopeKind::CoreOrganization,
                scope_external_id: "a07-test-org".to_string(),
                subject_type: "recipient".to_string(),
                subject_id: "recipient-1".to_string(),
                occurred_at: Utc::now(),
                attributes: json!({"count": 1}),
                correlation_id: None,
                causation_id: None,
                idempotency_key: None,
            }
        },
    )
    .unwrap();
    let mut transaction = pool.begin().await.unwrap();
    assert!(matches!(
        enqueue_outbox(&mut transaction, &conflict).await.unwrap(),
        EnqueueResult::Conflict { .. }
    ));
    transaction.rollback().await.unwrap();

    let now = Utc::now();
    let claimed = claim_outbox_batch(
        &pool,
        "a07-test-publisher",
        10,
        now,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt_count, 1);
    apply_delivery_outcome(
        &pool,
        &claimed[0].outbox_id,
        "a07-test-publisher",
        DeliveryOutcome::Retryable {
            error_code: "analytics.unavailable".to_string(),
            retry_at: now - Duration::seconds(1),
        },
    )
    .await
    .unwrap();

    let reclaimed = claim_outbox_batch(
        &pool,
        "a07-test-publisher-2",
        10,
        now + Duration::seconds(1),
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].attempt_count, 2);
    apply_delivery_outcome(
        &pool,
        &reclaimed[0].outbox_id,
        "a07-test-publisher-2",
        DeliveryOutcome::Accepted,
    )
    .await
    .unwrap();
    assert!(claim_outbox_batch(
        &pool,
        "a07-test-publisher-3",
        10,
        now,
        std::time::Duration::from_secs(30)
    )
    .await
    .unwrap()
    .is_empty());
}
