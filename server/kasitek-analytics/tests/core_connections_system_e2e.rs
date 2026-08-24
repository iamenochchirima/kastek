use std::{collections::HashSet, env, net::TcpListener, time::Duration as StdDuration};

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
    registry::load_registry,
    reporting::{ReportingAuthenticator, ReportingCache},
    rollout::{RolloutAuthenticator, RolloutDecisionCache},
};
use kasitek_core::analytics::connections::{
    enqueue_capability_lifecycle, enqueue_health_check, enqueue_incident_lifecycle,
    enqueue_lifecycle, enqueue_manifest, enqueue_rate_limit, enqueue_sync_attempt,
};
use kasitek_core::workers::analytics_backfill::process_connections_source_reconstruction;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

const PRODUCER_ID: &str = "core-customer-analytics";
const SOURCE_SERVICE: &str = "core";
const INGESTION_TOKEN: &str = "core-connections-system-e2e-token";

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
        redis_url: env::var("ANALYTICS_REDIS_URL").ok(),
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
    .map(|row| row.get("scope_id"))
    .expect("Connections E2E reporting scope")
}

#[tokio::test]
#[ignore = "requires clean Core and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn core_connections_outbox_publisher_and_analytics_ingestion_work_end_to_end() {
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
    let organization_id = format!("core-connections-system-e2e-{unique_suffix}");
    let connection_id = format!("ext-connections-system-e2e-{unique_suffix}");
    let stream_key = format!("organization:{organization_id}:connections");
    create_scope(&analytics_pool, &organization_id).await;

    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let occurred_at = Utc::now();
        let health_at = occurred_at + Duration::seconds(1);
        let capability_at = occurred_at + Duration::seconds(2);
        let sync_at = occurred_at + Duration::seconds(3);
        let rate_limit_at = occurred_at + Duration::seconds(4);
        let incident_at = occurred_at + Duration::seconds(5);
        let manifest_at = occurred_at + Duration::seconds(6);
        let mut transaction = core_pool.begin().await.expect("Core transaction");

        enqueue_lifecycle(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "connected",
            "CONNECTED",
            "ACTIVE",
            "HEALTHY",
            "ACTIVE",
            occurred_at,
        )
        .await
        .expect("connection lifecycle should enqueue");
        enqueue_health_check(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "CONNECTED",
            "HEALTHY",
            "ACTIVE",
            "ACTIVE",
            true,
            health_at,
        )
        .await
        .expect("connection health should enqueue");
        enqueue_capability_lifecycle(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "MESSAGING_INBOUND",
            true,
            capability_at,
        )
        .await
        .expect("connection capability should enqueue");
        enqueue_sync_attempt(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            &format!("attempt-{unique_suffix}"),
            "connection_refresh",
            "succeeded",
            "none",
            120,
            sync_at,
        )
        .await
        .expect("connection sync attempt should enqueue");
        enqueue_rate_limit(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "connection_refresh",
            "provider",
            Some(30),
            rate_limit_at,
        )
        .await
        .expect("connection rate limit should enqueue");
        enqueue_incident_lifecycle(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "connection_health",
            "opened",
            "critical",
            "provider_health_failed",
            incident_at,
        )
        .await
        .expect("connection incident should enqueue");
        enqueue_manifest(&mut transaction, &organization_id, 1, manifest_at)
            .await
            .expect("connection manifest should enqueue");
        transaction
            .commit()
            .await
            .expect("Core mutation and outbox should commit together");

        let client = AnalyticsIngestionClient::new(
            endpoint.clone(),
            INGESTION_TOKEN,
            StdDuration::from_secs(10),
        )
        .expect("publisher client");
        let publisher_id = format!("core-connections-system-e2e-publisher-{unique_suffix}");
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
            .expect("Core publisher should deliver Connections to Analytics");
        assert!(
            stats.delivered >= 7,
            "expected six facts and one manifest delivered: {stats:?}"
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
        .expect("Core Connections delivery state");
        assert_eq!(delivered, 7);

        let manifest_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM analytics.analytics_source_manifest
               WHERE source_service = 'core' AND source_stream_key = $1"#,
        )
        .bind(&stream_key)
        .fetch_one(&analytics_pool)
        .await
        .expect("Analytics Connections source manifest");
        assert_eq!(manifest_count, 1);

        let rows = sqlx::query(
            r#"SELECT event_type, source_service, source_record_id, attributes, backfilled
               FROM analytics.analytics_event
               WHERE source_service = 'core' AND source_stream_key = $1
               ORDER BY source_record_id"#,
        )
        .bind(&stream_key)
        .fetch_all(&analytics_pool)
        .await
        .expect("Analytics Connections facts");
        assert_eq!(rows.len(), 6);

        let expected_event_types = HashSet::from([
            "connection.lifecycle@1".to_string(),
            "connection.health_check@1".to_string(),
            "connection.capability.lifecycle@1".to_string(),
            "connection.sync_attempt@1".to_string(),
            "connection.rate_limit@1".to_string(),
            "connection.incident.lifecycle@1".to_string(),
        ]);
        let actual_event_types = rows
            .iter()
            .map(|row| row.get::<String, _>("event_type"))
            .collect::<HashSet<_>>();
        assert_eq!(actual_event_types, expected_event_types);

        for row in rows {
            let source_service: String = row.get("source_service");
            let source_record_id: String = row.get("source_record_id");
            let attributes: Value = row.get("attributes");
            let backfilled: bool = row.get("backfilled");
            assert_eq!(source_service, SOURCE_SERVICE);
            assert!(!backfilled);
            assert!(!source_record_id.is_empty());
            for prohibited in [
                "external_account_id",
                "display_name",
                "handle",
                "metadata",
                "credential",
                "token",
                "provider_payload",
                "raw_error",
            ] {
                assert!(
                    attributes.get(prohibited).is_none(),
                    "unexpected {prohibited}"
                );
            }
        }
    }
    .await;

    server_handle.stop(true).await;
    server_task
        .await
        .expect("analytics API task should join")
        .expect("analytics API should stop cleanly");
    result
}

#[tokio::test]
#[ignore = "requires clean Core and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn core_connections_source_reconstruction_reaches_temporal_completion() {
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
    let organization_id = format!("core-connections-backfill-e2e-{unique_suffix}");
    let connection_id = format!("ext-connections-backfill-e2e-{unique_suffix}");
    let job_id = format!("connections-backfill-e2e-{unique_suffix}");
    let scope_id = create_scope(&analytics_pool, &organization_id).await;
    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let occurred_at = Utc::now();
        let range_start = occurred_at - Duration::minutes(1);
        let range_end = occurred_at + Duration::minutes(1);
        let mut transaction = core_pool.begin().await.expect("Core transaction");
        enqueue_lifecycle(
            &mut transaction,
            &organization_id,
            &connection_id,
            "WHATSAPP",
            "connected",
            "CONNECTED",
            "ACTIVE",
            "HEALTHY",
            "ACTIVE",
            occurred_at,
        )
        .await
        .expect("Connections source fact should enqueue");
        transaction
            .commit()
            .await
            .expect("Connections source fact should commit");

        let source_record_id = format!(
            "connection:{connection_id}:lifecycle:connected:{}",
            occurred_at.timestamp_micros()
        );
        sqlx::query(
            r#"INSERT INTO analytics.analytics_backfill_job (
                   job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
                   requested_range_start, requested_range_end, contract_version,
                   projection_version, method, job_status, remaining_count,
                   requesting_actor_type, requesting_actor_id, authorization_grant_id
               ) VALUES ($1, 'core', 'connections', $2, $2, $3, $4, 'connections.v1',
                         'connections.v1', 'source_reconstruction', 'queued', 1,
                         'system', $1, $1)"#,
        )
        .bind(&job_id)
        .bind(scope_id)
        .bind(range_start)
        .bind(range_end)
        .execute(&analytics_pool)
        .await
        .expect("Connections source backfill job");

        let client =
            AnalyticsIngestionClient::new(endpoint, INGESTION_TOKEN, StdDuration::from_secs(10))
                .expect("publisher client");
        let work = client
            .claim_source_backfill_work()
            .await
            .expect("source backfill claim")
            .expect("Connections source backfill work");
        assert_eq!(work.job_id, job_id);
        assert_eq!(work.source_domain, "connections");
        assert_eq!(work.scope_external_id, organization_id);

        let stats =
            process_connections_source_reconstruction(&core_pool, &client, PRODUCER_ID, 1, &work)
                .await
                .expect("Connections source reconstruction");
        assert_eq!(stats.connection_records, 1);
        assert_eq!(stats.rejected_records, 0);

        let job = sqlx::query(
            r#"SELECT job_status, scanned_count, accepted_count, rejected_count, remaining_count
               FROM analytics.analytics_backfill_job WHERE job_id = $1"#,
        )
        .bind(&job_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("completed Connections source backfill job");
        assert_eq!(job.get::<String, _>("job_status"), "completed");
        assert_eq!(job.get::<i64, _>("scanned_count"), 1);
        assert_eq!(job.get::<i64, _>("accepted_count"), 1);
        assert_eq!(job.get::<i64, _>("rejected_count"), 0);
        assert_eq!(job.get::<i64, _>("remaining_count"), 0);

        let event = sqlx::query(
            r#"SELECT event_type, source_record_id, origin, backfilled
               FROM analytics.analytics_event
               WHERE source_record_id = $1"#,
        )
        .bind(&source_record_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("reconstructed Connections event");
        assert_eq!(
            event.get::<String, _>("event_type"),
            "connection.lifecycle@1"
        );
        assert_eq!(event.get::<String, _>("origin"), "kasitek://core");
        assert!(event.get::<bool, _>("backfilled"));

        let checkpoint = sqlx::query(
            r#"SELECT coverage_state, included_count, excluded_count, complete_through
               FROM analytics.analytics_coverage_checkpoint
               WHERE backfill_job_id = $1"#,
        )
        .bind(&job_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("Connections temporal coverage checkpoint");
        assert_eq!(checkpoint.get::<String, _>("coverage_state"), "available");
        assert_eq!(checkpoint.get::<i64, _>("included_count"), 1);
        assert_eq!(checkpoint.get::<i64, _>("excluded_count"), 0);
        assert_eq!(
            checkpoint
                .get::<chrono::DateTime<Utc>, _>("complete_through")
                .timestamp_micros(),
            range_end.timestamp_micros()
        );
    }
    .await;

    server_handle.stop(true).await;
    server_task
        .await
        .expect("analytics API task should join")
        .expect("analytics API should stop cleanly");
    result
}
