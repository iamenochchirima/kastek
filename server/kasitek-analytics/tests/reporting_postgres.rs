use std::{env, fs};

use actix_web::test as actix_test;
use chrono::{Duration, TimeZone, Timelike, Utc};
use jwt_simple::{
    algorithms::ECDSAP256KeyPairLike,
    prelude::{Claims, Duration as JwtDuration, ES256KeyPair},
};
use kasitek_analytics::{
    config::AnalyticsConfig,
    ingestion::{
        ingest_batch, AcknowledgementStatus, AuthenticatedProducer, IngestionBatchRequest,
        IngestionRecord,
    },
    projections::{self, DEFAULT_SHARD_KEY, PROJECTION_NAME, PROJECTION_VERSION},
    records::canonical_payload_sha256,
    registry::load_registry,
    reporting::{
        authorize_transaction, execute_report, ComparisonRequest, ReportQueryRequest,
        ReportingAuthenticator,
    },
    scope::{DescendantMode, PrincipalType, ReportingGrant},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::collections::BTreeSet;

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

fn reporting_config(public_key: String) -> AnalyticsConfig {
    let _ = dotenv::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/.env"));
    let mut config = AnalyticsConfig::from_env().expect("reporting test config");
    config.reporting_public_key = Some(public_key);
    config.reporting_public_keys_json = None;
    config
}

fn meta_message_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
) -> IngestionRecord {
    let data = json!({
        "message_id": record_id,
        "conversation_id": "meta-e2e-conversation",
        "channel": "facebook",
        "action": "created",
        "direction": "inbound",
        "responder_type": "customer",
        "message_type": "text",
        "delivery_status": null,
        "response_time_ms": null,
        "occurred_at": "2026-08-22T12:00:00Z"
    });
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Event,
        record_id: record_id.to_string(),
        contract_name: "conversation.message.lifecycle@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).expect("Meta event payload hash"),
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{:012}", sequence),
            "source": "kasitek://core",
            "type": "conversation.message.lifecycle@1",
            "subject": format!("message:{record_id}"),
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/events/inbox/conversation_message_lifecycle/v1.schema.json",
            "source_service": "core",
            "source_domain": "inbox",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("meta-e2e:{record_id}"),
            "data": data,
        }),
    }
}

async fn insert_fixture(
    transaction: &mut Transaction<'_, Postgres>,
    registry_sha256: &str,
) -> (i64, i64) {
    let external_id = format!(
        "reporting-postgres-test-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(external_id)
    .fetch_one(&mut **transaction)
    .await
    .expect("reporting scope");

    let generation_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_generation (
             projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
             generation_number, generation_status, source_high_watermark, metric_registry_sha256,
             coverage_summary, validation_summary, created_by_type, created_by_id,
             validated_at, promoted_at
           ) VALUES ($1,$2,$3,$3,$4,1,'promoted',10,$5,'{}'::jsonb,'{}'::jsonb,
                     'test','reporting-postgres',NOW(),NOW())
           RETURNING generation_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .bind(registry_sha256)
    .fetch_one(&mut **transaction)
    .await
    .expect("projection generation");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
             generation_id, processing_status, last_processed_storage_id
           ) VALUES ($1,$2,$3,$3,$4,$5,'idle',10)"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await
    .expect("projection checkpoint");

    let bucket_start = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
    let bucket_end = bucket_start + Duration::days(1);
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             timezone_name, timezone_revision, dimensions, value_count, value_sum,
             source_high_watermark, coverage
           ) VALUES ($1,$2,$3,'agent.runs.completed',1,$4,$4,$4,'day',$5,$6,'UTC',1,
                     '{}'::jsonb,3,3,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start)
    .bind(bucket_end)
    .bind(json!({
        "source_fact_count": 3,
        "coverage_state": "observed",
        "required_sources": ["agent.run.completed@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("count rollup");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             timezone_name, timezone_revision, dimensions, value_count, value_sum,
             source_high_watermark, coverage
           ) VALUES ($1,$2,$3,'agent.runs.completed',1,$4,$4,$4,'day',$5,$6,'UTC',1,
                     '{}'::jsonb,1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start - Duration::days(1))
    .bind(bucket_start)
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["agent.run.completed@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("previous count rollup");

    for (storage_id, deduplication_key) in [
        (11_i64, "recipient-1"),
        (12, "recipient-1"),
        (13, "recipient-2"),
    ] {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_contribution (
                 generation_id, projection_name, projection_version, metric_key, metric_version,
                 source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
                 bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
                 deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
                 coverage
               ) VALUES ($1,$2,$3,'campaign.recipients.sent',1,'event',$4,$5,$5,$5,
                         $6,$7,'UTC',1,'{}'::jsonb,$8,'campaign.sent',1,1,10,$9)"#,
        )
        .bind(generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(storage_id)
        .bind(scope_id)
        .bind(bucket_start + Duration::hours(12))
        .bind(bucket_start + Duration::hours(13))
        .bind(deduplication_key)
        .bind(json!({
            "source_fact_count": 1,
            "coverage_state": "observed",
            "required_sources": ["campaign.recipient.sent@1"]
        }))
        .execute(&mut **transaction)
        .await
        .expect("distinct contribution");
    }

    (scope_id, generation_id)
}

async fn insert_grant(
    transaction: &mut Transaction<'_, Postgres>,
    scope_id: i64,
    now: chrono::DateTime<Utc>,
) -> String {
    let grant_id = format!(
        "reporting-grant-{}",
        now.timestamp_nanos_opt().unwrap_or_default()
    );
    sqlx::query(
        r#"INSERT INTO analytics.reporting_grant (
             grant_id, issuer_service_identity_id, audience, principal_type, principal_id,
             scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,
             permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,
             expires_at, correlation_id
           ) VALUES ($1,'core','kasitek-analytics-reporting','user','reporting-test-user',
                     $2,$2,'none','[]'::jsonb,$3,'[]'::jsonb,'[]'::jsonb,'v1',$4,$4,$5,'test')"#,
    )
    .bind(&grant_id)
    .bind(scope_id)
    .bind(json!(["analytics:read"]))
    .bind(now)
    .bind(now + Duration::seconds(60))
    .execute(&mut **transaction)
    .await
    .expect("reporting grant");
    grant_id
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TestGrantClaims {
    principal_type: PrincipalType,
    scope_id: i64,
    root_scope_id: i64,
    descendant_mode: DescendantMode,
    explicit_descendant_scope_ids: Vec<i64>,
    permissions: BTreeSet<String>,
    metric_keys: Vec<String>,
    dimension_keys: Vec<String>,
    policy_version: String,
    correlation_id: Option<String>,
}

#[tokio::test]
async fn signed_reporting_query_reads_promoted_rollups_and_deduplicates_contributions() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let pair = ES256KeyPair::generate();
    let public_key = pair.public_key().to_pem().expect("public key");
    let config = reporting_config(public_key);
    let access = ReportingAuthenticator::from_config(&config).expect("reporting authenticator");
    let mut transaction = pool.begin().await.expect("transaction");
    let (scope_id, _generation_id) = insert_fixture(&mut transaction, &registry.sha256).await;
    let now = Utc::now().with_nanosecond(0).expect("whole second");
    let grant_id = insert_grant(&mut transaction, scope_id, now).await;
    let claims = Claims::with_custom_claims(
        TestGrantClaims {
            principal_type: PrincipalType::User,
            scope_id,
            root_scope_id: scope_id,
            descendant_mode: DescendantMode::None,
            explicit_descendant_scope_ids: Vec::new(),
            permissions: BTreeSet::from(["analytics:read".to_string()]),
            metric_keys: Vec::new(),
            dimension_keys: Vec::new(),
            policy_version: "v1".to_string(),
            correlation_id: Some("test".to_string()),
        },
        JwtDuration::from_secs(60),
    )
    .with_issuer("kasitek-core")
    .with_audience("kasitek-analytics-reporting")
    .with_subject("reporting-test-user")
    .with_jwt_id(&grant_id);
    let token = pair.sign(claims).expect("signed grant");
    let auth_request = actix_test::TestRequest::default()
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_http_request();
    let grant = access
        .authenticate(&auth_request)
        .expect("authenticated grant");
    let request = ReportQueryRequest {
        reporting_scope_id: scope_id,
        range_start: Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap(),
        range_end: Utc.with_ymd_and_hms(2026, 8, 2, 0, 0, 0).unwrap(),
        timezone: "UTC".to_string(),
        interval: Some("day".to_string()),
        metrics: vec![
            "agent.runs.completed@1".to_string(),
            "campaign.recipients.sent@1".to_string(),
        ],
        metric_set: None,
        breakdowns: Vec::new(),
        filters: Default::default(),
        include_descendants: false,
        comparison: Some(ComparisonRequest {
            kind: "previous_period".to_string(),
        }),
    };
    let coverage_start = request.range_start;
    let coverage_end = request.range_end;
    for domain in ["agents", "campaigns"] {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_coverage_checkpoint (
                 producer_id, source_service, source_domain, reporting_scope_id, root_scope_id,
                 coverage_layer, window_start, window_end, included_count, coverage_state,
                 complete_through, observed_at
               ) VALUES ('core-customer-analytics','core',$1,$2,$2,'temporal',$3,$4,1,
                         'available',$4,NOW())"#,
        )
        .bind(domain)
        .bind(scope_id)
        .bind(coverage_start)
        .bind(coverage_end)
        .execute(&mut *transaction)
        .await
        .expect("temporal coverage checkpoint");
    }
    let authorized = authorize_transaction(&mut transaction, &grant, scope_id)
        .await
        .expect("authorized scope");
    let response = execute_report(&mut transaction, &registry, &grant, &authorized, &request)
        .await
        .expect("report response");
    assert_eq!(response.generation_id, Some(_generation_id));
    assert_eq!(response.metrics.len(), 2);
    assert_eq!(response.metrics[0].series[0].value, Some(3.0));
    assert_eq!(response.metrics[1].series[0].value, Some(2.0));
    for metric in &response.metrics {
        assert_eq!(metric.availability.state, "available");
        assert_eq!(metric.coverage.state, "available");
        assert_eq!(metric.coverage.projection_state, "available");
        assert_eq!(metric.coverage.projection_source_state, "available");
        assert_eq!(metric.coverage.dimension_state, "not_requested");
        assert_eq!(metric.coverage.missing_dimension_points, 0);
        assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
        assert_eq!(metric.coverage.window_start, Some(coverage_start));
        assert_eq!(metric.coverage.window_end, Some(coverage_end));
        assert_eq!(metric.coverage.complete_through, Some(coverage_end));
    }
    assert_eq!(
        response.metrics[0].coverage.required_sources,
        vec!["agent.run.completed@1".to_string()]
    );
    assert_eq!(
        response.metrics[1].coverage.required_sources,
        vec!["campaign.recipient.sent@1".to_string()]
    );
    let dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.recipients.sent@1".to_string()],
            breakdowns: vec!["channel".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("dimension report response");
    let dimension_metric = dimension_response
        .metrics
        .first()
        .expect("dimension metric");
    assert_eq!(dimension_metric.coverage.dimension_state, "partial");
    assert_eq!(dimension_metric.coverage.missing_dimension_points, 1);
    assert_eq!(
        dimension_metric.coverage.projection_source_state,
        "available"
    );
    let comparison = response.comparison.expect("comparison response");
    assert_eq!(comparison.kind, "previous_period");
    assert_eq!(comparison.range_end, request.range_start);
    assert_eq!(
        comparison.range_end - comparison.range_start,
        Duration::days(1)
    );
    assert_eq!(comparison.metrics[0].series[0].value, Some(1.0));

    let backfill_job_id = format!(
        "reporting-backfill-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',
                     'source_reconstruction','running',1,'test','reporting-postgres',
                     'reporting-backfill-grant',NOW())"#,
    )
    .bind(&backfill_job_id)
    .bind(scope_id)
    .bind(coverage_start)
    .bind(coverage_end)
    .execute(&mut *transaction)
    .await
    .expect("active backfill job");
    let backfilling_response =
        execute_report(&mut transaction, &registry, &grant, &authorized, &request)
            .await
            .expect("backfilling report response");
    let campaign_metric = backfilling_response
        .metrics
        .iter()
        .find(|metric| metric.key == "campaign.recipients.sent")
        .expect("campaign metric");
    assert_eq!(campaign_metric.availability.state, "backfilling");
    assert_eq!(campaign_metric.coverage.state, "backfilling");
    assert_eq!(
        campaign_metric.coverage.evidence_layer.as_deref(),
        Some("backfill")
    );
    transaction.rollback().await.expect("rollback test fixture");
}

#[tokio::test]
async fn meta_inbox_backfill_projects_and_reports_with_message_dimensions() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("a09-meta-reporting-org-{suffix}");
    let stream = format!("organization:{scope_external_id}:inbox");
    let record_id = format!("meta-reporting-message-{suffix}");
    let backfill_job_id = format!("a09-meta-reporting-backfill-{suffix}");
    let grant_id = format!("a09-meta-reporting-grant-{suffix}");
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .expect("Meta reporting scope");
    let range_start = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();
    let range_end = range_start + Duration::hours(1);
    let grant_time = Utc::now().with_nanosecond(0).expect("grant timestamp");
    let grant = ReportingGrant {
        grant_id: grant_id.clone(),
        issuer: "kasitek-core".to_string(),
        audience: "kasitek-analytics-reporting".to_string(),
        principal_type: PrincipalType::User,
        principal_id: "meta-reporting-user".to_string(),
        scope_id,
        root_scope_id: scope_id,
        descendant_mode: DescendantMode::None,
        explicit_descendant_scope_ids: Vec::new(),
        permissions: BTreeSet::from(["analytics:read".to_string()]),
        metric_keys: Vec::new(),
        dimension_keys: Vec::new(),
        policy_version: "v1".to_string(),
        issued_at: grant_time,
        not_before: grant_time,
        expires_at: grant_time + Duration::seconds(60),
        correlation_id: Some("meta-inbox-e2e".to_string()),
        revoked_at: None,
    };
    let mut setup = pool.begin().await.expect("setup transaction");
    sqlx::query(
        r#"INSERT INTO analytics.reporting_grant (
             grant_id, issuer_service_identity_id, audience, principal_type, principal_id,
             scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,
             permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,
             expires_at, correlation_id
           ) VALUES ($1,'core','kasitek-analytics-reporting','user',$2,$3,$3,'none',
                     '[]'::jsonb,$4,'[]'::jsonb,'[]'::jsonb,'v1',$5,$5,$6,$7)"#,
    )
    .bind(&grant_id)
    .bind(&grant.principal_id)
    .bind(scope_id)
    .bind(json!(["analytics:read"]))
    .bind(grant_time)
    .bind(grant.expires_at)
    .bind(grant.correlation_id.as_deref())
    .execute(&mut *setup)
    .await
    .expect("reporting grant");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','inbox',$2,$2,$3,$4,'conversation.message.lifecycle@1',
                     'source_reconstruction','running',1,'test','meta-inbox-e2e',$5,NOW())"#,
    )
    .bind(&backfill_job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(&grant_id)
    .execute(&mut *setup)
    .await
    .expect("Meta source backfill job");
    setup.commit().await.expect("setup commit");

    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![meta_message_record(
                &stream,
                &record_id,
                9_000_001,
                &scope_external_id,
            )],
            backfill_job_id: Some(backfill_job_id),
        },
    )
    .await;
    assert!(matches!(
        response.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));

    let storage_id: i64 =
        sqlx::query_scalar("SELECT storage_id FROM analytics.analytics_event WHERE event_id = $1")
            .bind(&record_id)
            .fetch_one(&pool)
            .await
            .expect("ingested Meta event");
    sqlx::query(
        "UPDATE analytics.analytics_projection_work SET priority = 1 WHERE min_source_storage_id = $1 AND max_source_storage_id = $1",
    )
    .bind(storage_id)
    .execute(&pool)
    .await
    .expect("prioritize Meta projection work");
    let mut projected = false;
    for _ in 0..32 {
        let _ = projections::process_once(&pool, &registry, "meta-inbox-e2e", 60)
            .await
            .expect("projection pass");
        let contributions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM analytics.analytics_projection_contribution WHERE source_storage_id = $1 AND metric_key = 'conversation.message.lifecycle_events'",
        )
        .bind(storage_id)
        .fetch_one(&pool)
        .await
        .expect("Meta projection contribution count");
        if contributions > 0 {
            projected = true;
            break;
        }
    }
    assert!(projected, "Meta event should reach the Inbox projection");

    let mut transaction = pool.begin().await.expect("report transaction");
    let authorized = authorize_transaction(&mut transaction, &grant, scope_id)
        .await
        .expect("authorized reporting scope");
    let report = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            reporting_scope_id: scope_id,
            range_start,
            range_end,
            timezone: "UTC".to_string(),
            interval: Some("hour".to_string()),
            metrics: vec!["conversation.message.lifecycle_events@1".to_string()],
            metric_set: None,
            breakdowns: vec!["message_direction".to_string(), "message_type".to_string()],
            filters: Default::default(),
            include_descendants: false,
            comparison: None,
        },
    )
    .await
    .expect("Meta report");
    let metric = &report.metrics[0];
    assert_eq!(metric.availability.state, "available");
    assert_eq!(metric.coverage.state, "available");
    assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
    assert_eq!(metric.coverage.window_start, Some(range_start));
    assert_eq!(metric.coverage.window_end, Some(range_end));
    assert_eq!(metric.coverage.complete_through, Some(range_end));
    assert_eq!(metric.coverage.dimension_state, "available");
    assert_eq!(metric.coverage.missing_dimension_points, 0);
    assert_eq!(metric.series.len(), 1);
    assert_eq!(metric.series[0].value, Some(1.0));
    assert_eq!(metric.series[0].dimensions["message_direction"], "inbound");
    assert_eq!(metric.series[0].dimensions["message_type"], "text");
    transaction
        .rollback()
        .await
        .expect("rollback report transaction");
}
