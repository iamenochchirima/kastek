use std::{env, fs};

use chrono::{Duration, Utc};
use kasitek_analytics::{
    ingestion::AuthenticatedProducer,
    rollout::{
        evaluate_transaction, upsert_transaction, EvaluationContext, RolloutControlKind,
        RolloutMutationRequest, RolloutTarget, TargetKind,
    },
};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

fn database_url() -> Option<String> {
    if let Ok(value) = env::var("ANALYTICS_DATABASE_URL") {
        return Some(value);
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/.env");
    fs::read_to_string(path).ok().and_then(|contents| {
        contents.lines().find_map(|line| {
            line.strip_prefix("ANALYTICS_DATABASE_URL=")
                .map(str::to_string)
        })
    })
}

async fn pool() -> Option<PgPool> {
    let url = database_url()?;
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .ok()
}

fn mutation(
    control_key: &str,
    target: RolloutTarget,
    enabled: bool,
    expires_at: Option<chrono::DateTime<Utc>>,
) -> RolloutMutationRequest {
    RolloutMutationRequest {
        control_key: control_key.to_string(),
        control_kind: RolloutControlKind::Rollout,
        target,
        enabled,
        percentage_basis_points: None,
        reason: "analytics rollout integration test".to_string(),
        issue_ref: Some("TEST-A12".to_string()),
        expires_at,
        remove: false,
    }
}

#[tokio::test]
async fn rollout_registry_is_revisioned_audited_and_fail_closed() {
    let Some(pool) = pool().await else { return };
    let mut transaction = pool.begin().await.expect("rollout transaction");
    let actor = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "a12-rollout-test".to_string(),
    };
    let now = Utc::now();
    let initial_registry_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM analytics.analytics_rollout_registry WHERE registry_name = 'default'",
    )
    .fetch_one(&mut *transaction)
    .await
    .expect("initial registry revision");
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', 'a12-rollout-test', 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .fetch_one(&mut *transaction)
    .await
    .expect("test scope");

    let global = upsert_transaction(
        &mut transaction,
        &actor,
        mutation(
            "ui",
            RolloutTarget {
                kind: TargetKind::Global,
                key: "global".to_string(),
            },
            true,
            None,
        ),
        now,
        Some("a12-global"),
    )
    .await
    .expect("global control");
    assert_eq!(global.revision, 1);
    assert_eq!(global.registry_revision, initial_registry_revision + 1);

    let scoped = upsert_transaction(
        &mut transaction,
        &actor,
        mutation(
            "ui",
            RolloutTarget {
                kind: TargetKind::ReportingScope,
                key: scope_id.to_string(),
            },
            false,
            None,
        ),
        now,
        Some("a12-scope"),
    )
    .await
    .expect("scope control");
    assert_eq!(scoped.revision, 1);
    assert_eq!(scoped.registry_revision, initial_registry_revision + 2);

    let scoped_decision = evaluate_transaction(
        &mut transaction,
        "ui",
        RolloutControlKind::Rollout,
        &EvaluationContext {
            reporting_scope_id: Some(scope_id),
            ..EvaluationContext::default()
        },
        now,
    )
    .await
    .expect("scoped decision");
    assert!(!scoped_decision.allowed);
    assert_eq!(scoped_decision.revision, Some(1));
    assert_eq!(
        scoped_decision.registry_revision,
        initial_registry_revision + 2
    );

    let global_decision = evaluate_transaction(
        &mut transaction,
        "ui",
        RolloutControlKind::Rollout,
        &EvaluationContext::default(),
        now,
    )
    .await
    .expect("global decision");
    assert!(global_decision.allowed);
    assert_eq!(
        global_decision.matched_target_kind,
        Some(TargetKind::Global)
    );

    let expired = upsert_transaction(
        &mut transaction,
        &actor,
        mutation(
            "alerts",
            RolloutTarget {
                kind: TargetKind::Global,
                key: "global".to_string(),
            },
            true,
            Some(now + Duration::seconds(1)),
        ),
        now,
        None,
    )
    .await
    .expect("expiring control");
    assert_eq!(expired.revision, 1);
    assert_eq!(expired.registry_revision, initial_registry_revision + 3);
    let expired_decision = evaluate_transaction(
        &mut transaction,
        "alerts",
        RolloutControlKind::Rollout,
        &EvaluationContext::default(),
        now + Duration::seconds(2),
    )
    .await
    .expect("expired decision");
    assert!(!expired_decision.allowed);
    assert!(expired_decision.defaulted);
    assert_eq!(
        expired_decision.registry_revision,
        initial_registry_revision + 3
    );

    let audit_rows = sqlx::query(
        r#"SELECT chain_sequence, previous_record_hash, record_hash
           FROM analytics.analytics_audit_record
           WHERE chain_name = 'analytics.rollout_controls'
           ORDER BY chain_sequence DESC
           LIMIT 3"#,
    )
    .fetch_all(&mut *transaction)
    .await
    .expect("audit rows");
    assert_eq!(audit_rows.len(), 3);
    assert!(audit_rows[0].get::<String, _>("record_hash").len() == 64);
    assert_eq!(
        audit_rows[0].get::<Option<String>, _>("previous_record_hash"),
        Some(audit_rows[1].get::<String, _>("record_hash"))
    );
    assert_eq!(
        audit_rows[0].get::<i64, _>("chain_sequence"),
        audit_rows[1].get::<i64, _>("chain_sequence") + 1
    );

    transaction
        .rollback()
        .await
        .expect("rollback test fixtures");
}
