use std::{collections::BTreeSet, env, net::TcpListener, time::Duration as StdDuration};

use actix_web::{web, App, HttpServer};
use analytics_producer::{
    publish_outbox_once, AnalyticsIngestionClient, AnalyticsPublisherSettings, RetryPolicy,
};
use chrono::{Duration, Utc};
use kasitek_analytics::{
    app,
    config::{AnalyticsConfig, IngestionCredential},
    contracts::ProcessKind,
    ingestion::IngestionAuthenticator,
    metrics::{MetricsAccess, ProcessMetrics},
    projections::{self, PROJECTION_NAME, PROJECTION_VERSION},
    registry::load_registry,
    reporting::{
        authorize_transaction, execute_report, ReportQueryRequest, ReportingAuthenticator,
        ReportingCache,
    },
    rollout::{RolloutAuthenticator, RolloutDecisionCache},
    scope::{DescendantMode, PrincipalType, ReportingGrant},
};
use kasitek_core::analytics::campaigns::{
    enqueue_manifest, enqueue_recipient_blocked, enqueue_recipient_delivered,
    enqueue_recipient_failed, enqueue_recipient_pricing, enqueue_recipient_read,
    enqueue_recipient_retry, enqueue_recipient_sent, enqueue_recipient_suppressed,
    enqueue_recipient_timing, enqueue_recipient_unsubscribed,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

const PRODUCER_ID: &str = "core-customer-analytics";
const SOURCE_SERVICE: &str = "core";
const INGESTION_TOKEN: &str = "core-campaigns-system-e2e-token";

fn required_url(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required for this ignored E2E"))
}

fn token_sha256(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn analytics_config(database_url: String) -> AnalyticsConfig {
    AnalyticsConfig {
        environment: "test".to_string(),
        api_host: "127.0.0.1".to_string(),
        api_port: 0,
        database_url,
        redis_url: None,
        metrics_token: None,
        rollout_admin_producers: Vec::new(),
        reporting_public_key: None,
        reporting_public_keys_json: None,
        reporting_issuers: vec!["kasitek-core".to_string()],
        reporting_audience: "kasitek-analytics-reporting".to_string(),
        ingestion_credentials: vec![IngestionCredential {
            source_service: SOURCE_SERVICE.to_string(),
            producer_id: PRODUCER_ID.to_string(),
            token_sha256: token_sha256(INGESTION_TOKEN),
        }],
        database_max_connections: 8,
        database_acquire_timeout_ms: 5_000,
        database_connect_timeout_ms: 5_000,
        log_filter: "warn".to_string(),
    }
}

fn start_analytics_api(
    pool: PgPool,
    config: &AnalyticsConfig,
) -> (
    String,
    actix_web::dev::ServerHandle,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let registry = load_registry().expect("analytics registry");
    let registry_access = web::Data::new(registry);
    let metrics = web::Data::new(ProcessMetrics::default());
    let metrics_access = web::Data::new(MetricsAccess::from_config(config));
    let ingestion_access = web::Data::new(IngestionAuthenticator::from_config(config));
    let reporting_access = web::Data::new(
        ReportingAuthenticator::from_config(config).expect("reporting authenticator"),
    );
    let reporting_cache = web::Data::new(ReportingCache::from_config(config));
    let rollout_access = web::Data::new(RolloutAuthenticator::from_config(config));
    let rollout_cache = web::Data::new(RolloutDecisionCache::from_config(config));

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("analytics test listener");
    listener
        .set_nonblocking(true)
        .expect("analytics listener should be nonblocking");
    let address = listener.local_addr().expect("analytics listener address");
    let server = HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(pool.clone()))
            .app_data(metrics.clone())
            .app_data(metrics_access.clone())
            .app_data(ingestion_access.clone())
            .app_data(reporting_access.clone())
            .app_data(reporting_cache.clone())
            .app_data(rollout_access.clone())
            .app_data(rollout_cache.clone())
            .app_data(registry_access.clone())
            .app_data(web::JsonConfig::default().limit(8 * 1024 * 1024))
            .configure(|cfg| app::configure(cfg, ProcessKind::Api))
    })
    .listen(listener)
    .expect("analytics API should bind")
    .run();
    let handle = server.handle();
    let task = tokio::spawn(server);
    (format!("http://{address}"), handle, task)
}

async fn create_scope(pool: &PgPool, external_id: &str) -> i64 {
    sqlx::query(
        r#"INSERT INTO analytics.reporting_scope (
               scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(external_id)
    .fetch_one(pool)
    .await
    .expect("Campaign E2E reporting scope")
    .get("scope_id")
}

#[tokio::test]
#[ignore = "requires clean Core and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn core_campaign_delivery_outbox_publisher_and_analytics_ingestion_work_end_to_end() {
    let core_pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&required_url("DATABASE_URL"))
        .await
        .expect("Core PostgreSQL should be reachable");
    let analytics_config = analytics_config(required_url("ANALYTICS_DATABASE_URL"));
    let analytics_pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&analytics_config.database_url)
        .await
        .expect("Analytics PostgreSQL should be reachable");

    let unique_suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let organization_id = format!("core-campaigns-system-e2e-{unique_suffix}");
    let campaign_id = format!("campaign-system-e2e-{unique_suffix}");
    let sent_recipient_id = format!("recipient-sent-system-e2e-{unique_suffix}");
    let delivered_recipient_id = format!("recipient-delivered-system-e2e-{unique_suffix}");
    let stream_key = format!("organization:{organization_id}:campaigns");
    let reporting_scope_id = create_scope(&analytics_pool, &organization_id).await;

    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let sent_at = Utc::now();
        let delivered_at = sent_at + Duration::seconds(1);
        let read_at = delivered_at + Duration::seconds(1);
        let failed_at = read_at + Duration::seconds(1);
        let blocked_at = failed_at + Duration::seconds(1);
        let suppressed_at = blocked_at + Duration::seconds(1);
        let unsubscribed_at = suppressed_at + Duration::seconds(1);
        let mut transaction = core_pool.begin().await.expect("Core transaction");
        enqueue_recipient_sent(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &sent_recipient_id,
            "whatsapp",
            "meta",
            sent_at,
        )
        .await
        .expect("Campaign sent fact should enqueue");
        enqueue_recipient_sent(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &sent_recipient_id,
            "whatsapp",
            "meta",
            sent_at,
        )
        .await
        .expect("identical Campaign sent fact should deduplicate");
        enqueue_recipient_delivered(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &delivered_recipient_id,
            "whatsapp",
            "meta",
            delivered_at,
        )
        .await
        .expect("Campaign delivered fact should enqueue");
        enqueue_recipient_read(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &delivered_recipient_id,
            "whatsapp",
            "meta",
            read_at,
        )
        .await
        .expect("Campaign read fact should enqueue");
        enqueue_recipient_failed(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &sent_recipient_id,
            "whatsapp",
            "meta",
            "provider_rejected",
            failed_at,
        )
        .await
        .expect("Campaign failed fact should enqueue");
        enqueue_recipient_blocked(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &delivered_recipient_id,
            "whatsapp",
            "meta",
            "provider_blocked",
            blocked_at,
        )
        .await
        .expect("Campaign blocked fact should enqueue");
        enqueue_recipient_suppressed(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &format!("recipient-suppressed-system-e2e-{unique_suffix}"),
            "whatsapp",
            "meta",
            "contact_excluded",
            suppressed_at,
        )
        .await
        .expect("Campaign suppressed fact should enqueue");
        enqueue_recipient_unsubscribed(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &format!("recipient-unsubscribed-system-e2e-{unique_suffix}"),
            "whatsapp",
            "meta",
            "keyword",
            unsubscribed_at,
        )
        .await
        .expect("Campaign unsubscribed fact should enqueue");
        enqueue_recipient_timing(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &delivered_recipient_id,
            "whatsapp",
            "meta",
            "send_to_delivered",
            4200,
            delivered_at,
        )
        .await
        .expect("Campaign timing fact should enqueue");
        enqueue_recipient_retry(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &format!("recipient-failed-system-e2e-{unique_suffix}"),
            "whatsapp",
            "meta",
            2,
            "manual",
            failed_at,
        )
        .await
        .expect("Campaign retry fact should enqueue");
        enqueue_recipient_pricing(
            &mut transaction,
            &organization_id,
            &campaign_id,
            &delivered_recipient_id,
            "whatsapp",
            "meta",
            true,
            "marketing",
            Some("CBP"),
            Some("regular"),
            delivered_at,
        )
        .await
        .expect("Campaign pricing fact should enqueue");
        enqueue_manifest(&mut transaction, &organization_id, 2, sent_at)
            .await
            .expect("Campaign source manifest should enqueue");
        transaction
            .commit()
            .await
            .expect("Campaign mutation and outbox should commit together");

        let client = AnalyticsIngestionClient::new(
            endpoint.clone(),
            INGESTION_TOKEN,
            StdDuration::from_secs(10),
        )
        .expect("publisher client");
        let publisher_id = format!("core-campaigns-system-e2e-publisher-{unique_suffix}");
        let settings = AnalyticsPublisherSettings {
            endpoint,
            token: INGESTION_TOKEN.to_string(),
            producer_id: PRODUCER_ID.to_string(),
            publisher_id,
            batch_size: 500,
            lease_duration: StdDuration::from_secs(30),
            request_timeout: StdDuration::from_secs(10),
            retry_policy: RetryPolicy {
                base_delay: StdDuration::from_millis(10),
                max_delay: StdDuration::from_secs(1),
                jitter_window: StdDuration::ZERO,
            },
        };
        let stats = publish_outbox_once(&core_pool, &client, &settings, Utc::now())
            .await
            .expect("Core publisher should deliver Campaign facts to Analytics");
        assert!(
            stats.delivered >= 11,
            "expected ten Campaign facts and one manifest: {stats:?}"
        );

        let delivered: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM analytics_outbox
               WHERE source_service = 'core'
                 AND source_stream_key = $1
                 AND delivery_status = 'delivered'"#,
        )
        .bind(&stream_key)
        .fetch_one(&core_pool)
        .await
        .expect("Core Campaign delivery state");
        assert_eq!(delivered, 11);

        let rows = sqlx::query(
            r#"SELECT event_type, source_service, source_record_id, attributes, backfilled
               FROM analytics.analytics_event
               WHERE source_service = 'core' AND source_stream_key = $1
               ORDER BY source_record_id"#,
        )
        .bind(&stream_key)
        .fetch_all(&analytics_pool)
        .await
        .expect("Analytics Campaign facts");
        assert_eq!(rows.len(), 10);
        let mut event_types = Vec::new();
        for row in rows {
            let event_type: String = row.get("event_type");
            let source_service: String = row.get("source_service");
            let source_record_id: String = row.get("source_record_id");
            let attributes: Value = row.get("attributes");
            let backfilled: bool = row.get("backfilled");
            assert_eq!(source_service, SOURCE_SERVICE);
            assert!(!backfilled);
            assert!(!source_record_id.is_empty());
            assert_eq!(
                attributes.get("channel").and_then(Value::as_str),
                Some("whatsapp")
            );
            assert_eq!(
                attributes.get("provider").and_then(Value::as_str),
                Some("meta")
            );
            if event_type == "campaign.recipient.failed@1" {
                assert_eq!(
                    attributes.get("failure_class").and_then(Value::as_str),
                    Some("provider_rejected")
                );
            }
            if event_type == "campaign.recipient.blocked@1" {
                assert_eq!(
                    attributes.get("block_class").and_then(Value::as_str),
                    Some("provider_blocked")
                );
            }
            if event_type == "campaign.recipient.suppressed@1" {
                assert_eq!(
                    attributes.get("suppression_class").and_then(Value::as_str),
                    Some("contact_excluded")
                );
            }
            if event_type == "campaign.recipient.unsubscribed@1" {
                assert_eq!(
                    attributes.get("unsubscribe_source").and_then(Value::as_str),
                    Some("keyword")
                );
            }
            if event_type == "campaign.recipient.timing@1" {
                assert_eq!(
                    attributes.get("timing_kind").and_then(Value::as_str),
                    Some("send_to_delivered")
                );
                assert_eq!(
                    attributes.get("duration_ms").and_then(Value::as_i64),
                    Some(4200)
                );
            }
            if event_type == "campaign.recipient.retry@1" {
                assert_eq!(
                    attributes.get("attempt_number").and_then(Value::as_i64),
                    Some(2)
                );
                assert_eq!(
                    attributes.get("retry_reason").and_then(Value::as_str),
                    Some("manual")
                );
            }
            if event_type == "campaign.recipient.pricing@1" {
                assert_eq!(attributes.get("billable").and_then(Value::as_bool), Some(true));
                assert_eq!(
                    attributes.get("pricing_category").and_then(Value::as_str),
                    Some("marketing")
                );
                assert_eq!(
                    attributes.get("pricing_model").and_then(Value::as_str),
                    Some("CBP")
                );
                assert_eq!(
                    attributes.get("pricing_type").and_then(Value::as_str),
                    Some("regular")
                );
            }
            for prohibited in [
                "phone_number",
                "email",
                "message_body",
                "credential",
                "token",
                "provider_payload",
            ] {
                assert!(
                    attributes.get(prohibited).is_none(),
                    "unexpected {prohibited}"
                );
            }
            event_types.push(event_type);
        }
        event_types.sort();
        assert_eq!(
            event_types,
            vec![
                "campaign.recipient.blocked@1".to_string(),
                "campaign.recipient.delivered@1".to_string(),
                "campaign.recipient.failed@1".to_string(),
                "campaign.recipient.pricing@1".to_string(),
                "campaign.recipient.read@1".to_string(),
                "campaign.recipient.retry@1".to_string(),
                "campaign.recipient.sent@1".to_string(),
                "campaign.recipient.suppressed@1".to_string(),
                "campaign.recipient.timing@1".to_string(),
                "campaign.recipient.unsubscribed@1".to_string()
            ]
        );

        let manifest_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM analytics.analytics_source_manifest
               WHERE source_service = 'core' AND source_stream_key = $1"#,
        )
        .bind(&stream_key)
        .fetch_one(&analytics_pool)
        .await
        .expect("Campaign source manifest");
        assert_eq!(manifest_count, 1);

        let (min_storage_id, max_storage_id): (i64, i64) = sqlx::query_as(
            r#"SELECT MIN(storage_id), MAX(storage_id)
               FROM analytics.analytics_event
               WHERE source_service = 'core' AND source_stream_key = $1"#,
        )
        .bind(&stream_key)
        .fetch_one(&analytics_pool)
        .await
        .expect("Campaign event storage bounds");
        let projection_work_id: i64 = sqlx::query_scalar(
            r#"INSERT INTO analytics.analytics_projection_work (
                 projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
                 source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
                 priority, work_status
               ) VALUES ($1,$2,'event',$3,$3,$4,$5,$6,$7,1,'pending')
               RETURNING work_id"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(reporting_scope_id)
        .bind(sent_at - Duration::seconds(1))
        .bind(unsubscribed_at + Duration::seconds(1))
        .bind(min_storage_id)
        .bind(max_storage_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("Campaign projection work");
        let registry = load_registry().expect("Campaign E2E registry");
        let mut projected = false;
        for _ in 0..16 {
            let _ = projections::process_once(
                &analytics_pool,
                &registry,
                "core-campaigns-system-e2e-projection",
                60,
            )
            .await
            .expect("Campaign projection pass");
            let status: String = sqlx::query_scalar(
                "SELECT work_status FROM analytics.analytics_projection_work WHERE work_id = $1",
            )
            .bind(projection_work_id)
            .fetch_one(&analytics_pool)
            .await
            .expect("Campaign projection status");
            if status == "completed" {
                projected = true;
                break;
            }
        }
        assert!(projected, "Campaign projection work did not complete");

        let grant_id = format!("campaign-reporting-grant-{unique_suffix}");
        let grant_time = Utc::now();
        sqlx::query(
            r#"INSERT INTO analytics.reporting_grant (
                 grant_id, issuer_service_identity_id, audience, principal_type, principal_id,
                 scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,
                 permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,
                 expires_at, correlation_id
               ) VALUES ($1,'core','kasitek-analytics-reporting','user','campaign-system-e2e-user',
                         $2,$2,'none','[]'::jsonb,$3,'[]'::jsonb,'[]'::jsonb,'v1',$4,$4,$5,$6)"#,
        )
        .bind(&grant_id)
        .bind(reporting_scope_id)
        .bind(serde_json::json!(["analytics:read"]))
        .bind(grant_time)
        .bind(grant_time + Duration::minutes(1))
        .bind("campaign-system-e2e")
        .execute(&analytics_pool)
        .await
        .expect("Campaign reporting grant");
        let grant = ReportingGrant {
            grant_id,
            issuer: "core".to_string(),
            audience: "kasitek-analytics-reporting".to_string(),
            principal_type: PrincipalType::User,
            principal_id: "campaign-system-e2e-user".to_string(),
            scope_id: reporting_scope_id,
            root_scope_id: reporting_scope_id,
            descendant_mode: DescendantMode::None,
            explicit_descendant_scope_ids: Vec::new(),
            permissions: BTreeSet::from(["analytics:read".to_string()]),
            metric_keys: Vec::new(),
            dimension_keys: Vec::new(),
            policy_version: "v1".to_string(),
            issued_at: grant_time,
            not_before: grant_time,
            expires_at: grant_time + Duration::minutes(1),
            correlation_id: Some("campaign-system-e2e".to_string()),
            revoked_at: None,
        };
        let mut report_transaction = analytics_pool
            .begin()
            .await
            .expect("Campaign report transaction");
        let authorized = authorize_transaction(
            &mut report_transaction,
            &grant,
            reporting_scope_id,
        )
        .await
        .expect("Campaign report authorization");
        let report = execute_report(
            &mut report_transaction,
            &registry,
            &grant,
            &authorized,
            &ReportQueryRequest {
                reporting_scope_id,
                range_start: sent_at - Duration::seconds(1),
                range_end: unsubscribed_at + Duration::seconds(1),
                timezone: "UTC".to_string(),
                interval: Some("hour".to_string()),
                metrics: vec!["campaign.recipients.pricing_recorded@1".to_string()],
                metric_set: None,
                breakdowns: vec!["pricing_category".to_string(), "pricing_billable".to_string()],
                filters: Default::default(),
                include_descendants: false,
                comparison: None,
            },
        )
        .await
        .expect("Campaign pricing report");
        let metric = &report.metrics[0];
        assert_eq!(metric.availability.state, "available");
        assert_eq!(metric.coverage.state, "available");
        assert_eq!(metric.series.len(), 1);
        assert_eq!(metric.series[0].value, Some(1.0));
        assert_eq!(metric.series[0].dimensions["pricing_category"], "marketing");
        assert_eq!(metric.series[0].dimensions["pricing_billable"], "billable");
        report_transaction
            .rollback()
            .await
            .expect("Campaign report rollback");
    }
    .await;

    server_handle.stop(true).await;
    server_task
        .await
        .expect("analytics API task should join")
        .expect("analytics API should stop cleanly");
    result
}
