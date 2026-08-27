use std::{collections::BTreeSet, env, net::TcpListener, time::Duration as StdDuration};

use actix_web::{web, App, HttpServer};
use analytics_producer::{
    publish_outbox_once, AnalyticsIngestionClient, AnalyticsPublisherSettings, RetryPolicy,
};
use analytics_reporting::{AnalyticsReportingClient, ReportingGrantInput, ReportingGrantIssuer};
use chrono::Utc;
use jwt_simple::prelude::ES256KeyPair;
use kasitek_analytics::{
    app,
    config::{AnalyticsConfig, IngestionCredential, ReportingResolverCredential},
    contracts::ProcessKind,
    ingestion::IngestionAuthenticator,
    metrics::{MetricsAccess, ProcessMetrics},
    registry::load_registry,
    reporting::{ReportingAuthenticator, ReportingCache},
    rollout::{RolloutAuthenticator, RolloutDecisionCache},
    scope_resolution::ScopeResolverAuthenticator,
};
use kasitek_core::analytics::enqueue_organization_scope_definition;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};

const PRODUCER_ID: &str = "core-customer-analytics";
const SOURCE_SERVICE: &str = "core";
const INGESTION_TOKEN: &str = "core-scope-system-e2e-token";
const RESOLVER_TOKEN: &str = "core-scope-system-e2e-resolver-token";

fn required_url(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required for this ignored E2E"))
}

fn token_sha256(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn analytics_config(database_url: String, reporting_public_key: String) -> AnalyticsConfig {
    AnalyticsConfig {
        environment: "test".to_string(),
        api_host: "127.0.0.1".to_string(),
        api_port: 0,
        database_url,
        redis_url: env::var("ANALYTICS_REDIS_URL").ok(),
        metrics_token: None,
        rollout_admin_producers: Vec::new(),
        reporting_public_key: Some(reporting_public_key),
        reporting_public_keys_json: None,
        reporting_issuers: vec!["kasitek-core".to_string()],
        reporting_audience: "kasitek-analytics-reporting".to_string(),
        reporting_resolver_credentials: vec![ReportingResolverCredential {
            source_service: SOURCE_SERVICE.to_string(),
            token_sha256: token_sha256(RESOLVER_TOKEN),
        }],
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
    let scope_resolver_access = web::Data::new(ScopeResolverAuthenticator::new(
        config.reporting_resolver_credentials.clone(),
    ));
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
            .app_data(scope_resolver_access.clone())
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

#[tokio::test]
#[ignore = "requires clean Core and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn core_organization_scope_outbox_publisher_resolver_and_catalog_work_end_to_end() {
    let core_pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&required_url("DATABASE_URL"))
        .await
        .expect("Core PostgreSQL should be reachable");
    let key_pair = ES256KeyPair::generate();
    let private_key = key_pair.to_pem().expect("reporting private key");
    let public_key = key_pair
        .public_key()
        .to_pem()
        .expect("reporting public key");
    let analytics_config = analytics_config(required_url("ANALYTICS_DATABASE_URL"), public_key);
    let analytics_pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&analytics_config.database_url)
        .await
        .expect("Analytics PostgreSQL should be reachable");

    let unique_suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let organization_id = format!("core-scope-system-e2e-{unique_suffix}");
    let source_version = Utc::now().timestamp_millis().max(1);
    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let mut transaction = core_pool.begin().await.expect("Core transaction");
        enqueue_organization_scope_definition(
            &mut transaction,
            &organization_id,
            source_version,
            "UTC",
            "active",
        )
        .await
        .expect("Core organization scope should enqueue");
        transaction
            .commit()
            .await
            .expect("Core organization scope outbox should commit");

        let client = AnalyticsIngestionClient::new(
            endpoint.clone(),
            INGESTION_TOKEN,
            StdDuration::from_secs(10),
        )
        .expect("Core publisher client");
        let settings = AnalyticsPublisherSettings {
            endpoint: endpoint.clone(),
            token: INGESTION_TOKEN.to_string(),
            producer_id: PRODUCER_ID.to_string(),
            publisher_id: format!("core-scope-system-e2e-publisher-{unique_suffix}"),
            batch_size: 500,
            lease_duration: StdDuration::from_secs(30),
            request_timeout: StdDuration::from_secs(10),
            retry_policy: RetryPolicy {
                base_delay: StdDuration::from_millis(10),
                max_delay: StdDuration::from_secs(1),
                jitter_window: StdDuration::ZERO,
            },
        };
        publish_outbox_once(&core_pool, &client, &settings, Utc::now())
            .await
            .expect("Core publisher should deliver the scope definition");

        let reporting_client =
            AnalyticsReportingClient::new(endpoint, RESOLVER_TOKEN, StdDuration::from_secs(10))
                .expect("Core reporting client");
        let scope = reporting_client
            .resolve_scope(SOURCE_SERVICE, "core_organization", &organization_id)
            .await
            .expect("Core scope should resolve after ingestion");
        let issuer = ReportingGrantIssuer::from_pem(
            &private_key,
            "kasitek-core",
            "kasitek-analytics-reporting",
            None,
        )
        .expect("Core reporting grant issuer");
        let grant = issuer
            .issue(ReportingGrantInput {
                principal_id: "core-scope-e2e-user".to_string(),
                scope_id: scope.scope_id,
                root_scope_id: scope.root_scope_id,
                descendant_mode: analytics_reporting::DescendantMode::None,
                permissions: BTreeSet::from(["analytics:read".to_string()]),
                metric_keys: Vec::new(),
                dimension_keys: Vec::new(),
                correlation_id: Some("core-scope-system-e2e".to_string()),
            })
            .expect("Core reporting grant");
        let direct_access = ReportingAuthenticator::from_config(&analytics_config)
            .expect("Core reporting authenticator");
        let direct_request = actix_web::test::TestRequest::default()
            .insert_header(("Authorization", format!("Bearer {grant}")))
            .to_http_request();
        assert!(
            direct_access.authenticate(&direct_request).is_ok(),
            "the generated Core grant must be accepted by the Analytics verifier"
        );
        let catalog = reporting_client
            .catalog(&grant, scope.scope_id)
            .await
            .expect("Core reporting catalog should be available");
        assert!(
            catalog.get("metrics").is_some(),
            "catalog response: {catalog}"
        );
        assert_eq!(scope.external_source_id, organization_id);

        let stored_scope: (String, String, String) = sqlx::query_as(
            r#"SELECT scope_kind, owning_source_service, reporting_timezone
               FROM analytics.reporting_scope
               WHERE external_source_id = $1"#,
        )
        .bind(&organization_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("Core scope should be stored in Analytics");
        assert_eq!(
            stored_scope,
            (
                "core_organization".to_string(),
                "core".to_string(),
                "UTC".to_string()
            )
        );
    }
    .await;

    server_handle.stop(true).await;
    server_task
        .await
        .expect("Analytics API task should join")
        .expect("Analytics API should stop cleanly");
    result
}
