use std::{env, fs};

use actix_web::test as actix_test;
use chrono::{Duration, TimeZone, Timelike, Utc};
use jwt_simple::{
    algorithms::ECDSAP256KeyPairLike,
    prelude::{Claims, Duration as JwtDuration, ES256KeyPair},
};
use kasitek_analytics::{
    config::AnalyticsConfig,
    projections::{DEFAULT_SHARD_KEY, PROJECTION_NAME, PROJECTION_VERSION},
    registry::load_registry,
    reporting::{
        authorize_transaction, execute_report, ComparisonRequest, ReportQueryRequest,
        ReportingAuthenticator,
    },
    scope::{DescendantMode, PrincipalType},
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
    .bind(json!({"source_fact_count": 3}))
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
    .bind(json!({"source_fact_count": 1}))
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
        .bind(json!({"source_fact_count": 1}))
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
    let comparison = response.comparison.expect("comparison response");
    assert_eq!(comparison.kind, "previous_period");
    assert_eq!(comparison.range_end, request.range_start);
    assert_eq!(
        comparison.range_end - comparison.range_start,
        Duration::days(1)
    );
    assert_eq!(comparison.metrics[0].series[0].value, Some(1.0));
    transaction.rollback().await.expect("rollback test fixture");
}
