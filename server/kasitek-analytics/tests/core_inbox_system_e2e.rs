use std::{env, net::TcpListener, time::Duration as StdDuration};

use actix_web::{web, App, HttpServer};
use analytics_producer::{
    publish_outbox_once, AnalyticsIngestionClient, AnalyticsPublisherSettings, RetryPolicy,
};
use chrono::Utc;
use kasitek_analytics::{
    app,
    config::{AnalyticsConfig, IngestionCredential, ReportingResolverCredential},
    contracts::ProcessKind,
    ingestion::IngestionAuthenticator,
    metrics::{MetricsAccess, ProcessMetrics},
    registry::load_registry,
    reporting::{ReportingAuthenticator, ReportingCache},
    rollout::{RolloutAuthenticator, RolloutDecisionCache},
};
use kasitek_core::analytics::inbox::{enqueue_conversation_lifecycle, enqueue_message_lifecycle};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

const PRODUCER_ID: &str = "core-customer-analytics";
const SOURCE_SERVICE: &str = "core";
const INGESTION_TOKEN: &str = "core-system-e2e-token";

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
        reporting_resolver_credentials: Vec::<ReportingResolverCredential>::new(),
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

async fn create_scope(pool: &PgPool, external_id: &str) {
    sqlx::query(
        r#"INSERT INTO analytics.reporting_scope (
               scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')"#,
    )
    .bind(external_id)
    .execute(pool)
    .await
    .expect("E2E reporting scope");
}

#[tokio::test]
#[ignore = "requires clean Core and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn core_inbox_outbox_publisher_and_analytics_ingestion_work_end_to_end() {
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
    let organization_id = format!("core-system-e2e-{unique_suffix}");
    let conversation_id = format!("conversation-system-e2e-{unique_suffix}");
    let message_id = format!("message-system-e2e-{unique_suffix}");
    create_scope(&analytics_pool, &organization_id).await;

    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let conversation_at = Utc::now();
        let message_at = conversation_at + chrono::Duration::milliseconds(1);
        let mut transaction = core_pool.begin().await.expect("Core transaction");
        enqueue_conversation_lifecycle(
            &mut transaction,
            &organization_id,
            &conversation_id,
            "facebook",
            "opened",
            "active",
            "customer",
            conversation_at,
        )
        .await
        .expect("Core conversation mutation should enqueue its fact");
        enqueue_message_lifecycle(
            &mut transaction,
            &organization_id,
            &message_id,
            &conversation_id,
            "facebook",
            "created",
            "inbound",
            "customer",
            "text",
            Some("received"),
            None,
            message_at,
        )
        .await
        .expect("Core message mutation should enqueue its fact");
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
        let publisher_id = format!("core-system-e2e-publisher-{unique_suffix}");
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
            .expect("Core publisher should deliver to Analytics");
        assert!(
            stats.delivered >= 2,
            "expected both E2E facts delivered: {stats:?}"
        );

        let delivered: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM analytics_outbox
               WHERE source_service = 'core'
                 AND record_id IN ($1, $2)
                 AND delivery_status = 'delivered'"#,
        )
        .bind(format!(
            "conversation:{conversation_id}:opened:{}",
            conversation_at.timestamp_millis()
        ))
        .bind(format!(
            "message:{message_id}:created:{}",
            message_at.timestamp_millis()
        ))
        .fetch_one(&core_pool)
        .await
        .expect("Core delivery state");
        assert_eq!(delivered, 2);

        let rows = sqlx::query(
            r#"SELECT event_type, source_service, source_record_id, attributes, backfilled
               FROM analytics.analytics_event
               WHERE source_service = 'core'
                 AND source_record_id IN ($1, $2)
               ORDER BY source_record_id"#,
        )
        .bind(format!(
            "conversation:{conversation_id}:opened:{}",
            conversation_at.timestamp_millis()
        ))
        .bind(format!(
            "message:{message_id}:created:{}",
            message_at.timestamp_millis()
        ))
        .fetch_all(&analytics_pool)
        .await
        .expect("Analytics facts");
        assert_eq!(rows.len(), 2);
        for row in rows {
            let event_type: String = row.get("event_type");
            let source_service: String = row.get("source_service");
            let source_record_id: String = row.get("source_record_id");
            let attributes: Value = row.get("attributes");
            let backfilled: bool = row.get("backfilled");
            assert_eq!(source_service, SOURCE_SERVICE);
            assert!(!backfilled);
            assert!(event_type.ends_with("@1"));
            assert!(!source_record_id.is_empty());
            for prohibited in [
                "content",
                "customer_identifier",
                "provider_message_id",
                "provider_payload",
                "token",
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
