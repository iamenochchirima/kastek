use std::{env, net::TcpListener, time::Duration as StdDuration};

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
use kasitek_core::analytics::campaigns::{
    enqueue_recipient_delivered, enqueue_recipient_read, enqueue_recipient_sent,
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

async fn create_scope(pool: &PgPool, external_id: &str) {
    sqlx::query(
        r#"INSERT INTO analytics.reporting_scope (
               scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')"#,
    )
    .bind(external_id)
    .execute(pool)
    .await
    .expect("Campaign E2E reporting scope");
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
    create_scope(&analytics_pool, &organization_id).await;

    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let sent_at = Utc::now();
        let delivered_at = sent_at + Duration::seconds(1);
        let read_at = delivered_at + Duration::seconds(1);
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
            stats.delivered >= 3,
            "expected three Campaign facts: {stats:?}"
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
        assert_eq!(delivered, 3);

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
        assert_eq!(rows.len(), 3);
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
                "campaign.recipient.delivered@1".to_string(),
                "campaign.recipient.read@1".to_string(),
                "campaign.recipient.sent@1".to_string()
            ]
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
