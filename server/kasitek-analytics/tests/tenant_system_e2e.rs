use std::{collections::BTreeSet, env, net::TcpListener, time::Duration as StdDuration};

use actix_web::{web, App, HttpServer};
use analytics_producer::{
    build_event, build_manifest, build_scope_definition, enqueue_outbox, publish_outbox_once,
    AnalyticsIngestionClient, AnalyticsPublisherSettings, EventInput, ManifestInput,
    ProducerConfig, RetryPolicy, ScopeDefinitionInput, ScopeKind,
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
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};

const PRODUCER_ID: &str = "tenant-platform-customer-analytics";
const SOURCE_SERVICE: &str = "tenant-platform";
const INGESTION_TOKEN: &str = "tenant-system-e2e-token";

fn required_url(names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| panic!("one of {names:?} is required for this ignored E2E"))
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
        reporting_issuers: vec!["kasitek-tenant-platform".to_string()],
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

async fn enqueue_record(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    record: analytics_producer::AnalyticsOutboxRecord,
) {
    enqueue_outbox(transaction, &record)
        .await
        .expect("Tenant analytics outbox enqueue");
}

#[tokio::test]
#[ignore = "requires clean Tenant and Analytics PostgreSQL databases; starts an in-process Analytics API"]
async fn tenant_mutation_outbox_publisher_projection_and_reporting_work_end_to_end() {
    let tenant_pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&required_url(&[
            "KASITEK_TENANTS_DATABASE_URL",
            "TENANT_DATABASE_URL",
        ]))
        .await
        .expect("Tenant PostgreSQL should be reachable");
    let analytics_config = analytics_config(required_url(&["ANALYTICS_DATABASE_URL"]));
    let analytics_pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&analytics_config.database_url)
        .await
        .expect("Analytics PostgreSQL should be reachable");

    let unique_suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let workspace_id = format!("tenant-system-e2e-workspace-{unique_suffix}");
    let client_id = format!("tenant-system-e2e-client-{unique_suffix}");
    let tenant_user_id = format!("tenant-system-e2e-user-{unique_suffix}");
    let source_config = ProducerConfig::tenant_platform();
    let reporting_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('tenant_workspace', 'tenant-platform', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(&workspace_id)
    .fetch_one(&analytics_pool)
    .await
    .expect("Tenant reporting workspace scope");

    let (endpoint, server_handle, server_task) =
        start_analytics_api(analytics_pool.clone(), &analytics_config);
    let result = async {
        let occurred_at = Utc::now();
        let stream_scopes = format!("workspace:{workspace_id}:scopes");
        let stream_clients = format!("workspace:{workspace_id}:clients");
        let stream_leads = format!("workspace:{workspace_id}:leads");
        let stream_assignments = format!("workspace:{workspace_id}:assignments");
        let mut transaction = tenant_pool.begin().await.expect("Tenant transaction");

        sqlx::query(
            r#"INSERT INTO workspaces (id, slug, display_name, status)
               VALUES ($1, $2, $3, 'active')"#,
        )
        .bind(&workspace_id)
        .bind(format!("tenant-e2e-{unique_suffix}"))
        .bind("Tenant E2E")
        .execute(&mut *transaction)
        .await
        .expect("Tenant workspace mutation");
        sqlx::query(
            r#"INSERT INTO tenant_clients (id, workspace_id, name, slug, status)
               VALUES ($1, $2, $3, $4, 'active')"#,
        )
        .bind(&client_id)
        .bind(&workspace_id)
        .bind("Tenant E2E Client")
        .bind(format!("client-e2e-{unique_suffix}"))
        .execute(&mut *transaction)
        .await
        .expect("Tenant client mutation");

        enqueue_record(
            &mut transaction,
            build_scope_definition(
                &source_config,
                ScopeDefinitionInput {
                    record_id: format!("tenant-scope:workspace:{workspace_id}:1"),
                    source_domain: "scopes".to_string(),
                    source_stream_key: stream_scopes.clone(),
                    contract_name: "tenant.scope.definition@1".to_string(),
                    schema_version: 1,
                    scope_kind: ScopeKind::TenantWorkspace,
                    scope_external_id: workspace_id.clone(),
                    parent_scope_external_id: None,
                    reporting_timezone: "UTC".to_string(),
                    status: "active".to_string(),
                    source_version: 1,
                    idempotency_key: None,
                },
            )
            .expect("Tenant workspace scope fact"),
        )
        .await;
        enqueue_record(
            &mut transaction,
            build_scope_definition(
                &source_config,
                ScopeDefinitionInput {
                    record_id: format!("tenant-scope:client:{client_id}:1"),
                    source_domain: "scopes".to_string(),
                    source_stream_key: stream_scopes,
                    contract_name: "tenant.scope.definition@1".to_string(),
                    schema_version: 1,
                    scope_kind: ScopeKind::TenantClient,
                    scope_external_id: client_id.clone(),
                    parent_scope_external_id: Some(workspace_id.clone()),
                    reporting_timezone: "UTC".to_string(),
                    status: "active".to_string(),
                    source_version: 1,
                    idempotency_key: None,
                },
            )
            .expect("Tenant client scope fact"),
        )
        .await;

        enqueue_record(
            &mut transaction,
            build_event(
                &source_config,
                EventInput {
                    record_id: format!("tenant-client:{client_id}:created"),
                    source_domain: "clients".to_string(),
                    source_stream_key: stream_clients.clone(),
                    contract_name: "tenant.client.lifecycle@1".to_string(),
                    schema_version: 1,
                    scope_kind: ScopeKind::TenantWorkspace,
                    scope_external_id: workspace_id.clone(),
                    subject_type: "tenant_client".to_string(),
                    subject_id: client_id.clone(),
                    occurred_at,
                    attributes: serde_json::json!({
                        "tenant_client_id": client_id,
                        "action": "created",
                        "status": "active",
                        "occurred_at": occurred_at,
                    }),
                    correlation_id: None,
                    causation_id: None,
                    idempotency_key: Some(format!("tenant-client:{client_id}:created")),
                },
            )
            .expect("Tenant client lifecycle fact"),
        )
        .await;
        enqueue_record(
            &mut transaction,
            build_event(
                &source_config,
                EventInput {
                    record_id: format!("tenant-lead:lead-{unique_suffix}:created"),
                    source_domain: "leads".to_string(),
                    source_stream_key: stream_leads.clone(),
                    contract_name: "tenant.lead.lifecycle@1".to_string(),
                    schema_version: 1,
                    scope_kind: ScopeKind::TenantClient,
                    scope_external_id: client_id.clone(),
                    subject_type: "tenant_lead".to_string(),
                    subject_id: format!("lead-{unique_suffix}"),
                    occurred_at,
                    attributes: serde_json::json!({
                        "lead_id": format!("lead-{unique_suffix}"),
                        "tenant_client_id": client_id,
                        "action": "created",
                        "status": "new",
                        "source": "web_chat",
                        "score_band": "medium",
                        "occurred_at": occurred_at,
                    }),
                    correlation_id: None,
                    causation_id: None,
                    idempotency_key: Some(format!("tenant-lead:{unique_suffix}:created")),
                },
            )
            .expect("Tenant lead lifecycle fact"),
        )
        .await;
        enqueue_record(
            &mut transaction,
            build_event(
                &source_config,
                EventInput {
                    record_id: format!("tenant-assignment:{unique_suffix}:history"),
                    source_domain: "assignments".to_string(),
                    source_stream_key: stream_assignments.clone(),
                    contract_name: "tenant.client.assignment@1".to_string(),
                    schema_version: 1,
                    scope_kind: ScopeKind::TenantWorkspace,
                    scope_external_id: workspace_id.clone(),
                    subject_type: "tenant_client_assignment".to_string(),
                    subject_id: format!("assignment-{unique_suffix}"),
                    occurred_at,
                    attributes: serde_json::json!({
                        "tenant_client_id": client_id,
                        "tenant_user_id": tenant_user_id,
                        "action": "assigned",
                        "status": "active",
                        "assignment_role": "member",
                        "occurred_at": occurred_at,
                    }),
                    correlation_id: None,
                    causation_id: None,
                    idempotency_key: Some(format!("tenant-assignment:{unique_suffix}:history")),
                },
            )
            .expect("Tenant assignment fact"),
        )
        .await;

        for (source_domain, source_stream_key, manifest_key, metric, contract) in [
            (
                "clients",
                stream_clients,
                "tenant.clients",
                "tenant.clients.lifecycle_events",
                "tenant.client.lifecycle@1",
            ),
            (
                "leads",
                stream_leads,
                "tenant.leads",
                "tenant.leads.lifecycle_events",
                "tenant.lead.lifecycle@1",
            ),
            (
                "assignments",
                stream_assignments,
                "tenant.assignments",
                "tenant.client.assignment_events",
                "tenant.client.assignment@1",
            ),
        ] {
            enqueue_record(
                &mut transaction,
                build_manifest(
                    &source_config,
                    ManifestInput {
                        record_id: format!("manifest:{source_stream_key}:{manifest_key}:1"),
                        source_domain: source_domain.to_string(),
                        source_stream_key,
                        contract_name: "source.manifest@1".to_string(),
                        schema_version: 1,
                        scope_kind: ScopeKind::TenantWorkspace,
                        scope_external_id: workspace_id.clone(),
                        manifest_key: manifest_key.to_string(),
                        manifest_version: 1,
                        provider: None,
                        connection_ref: None,
                        supported_contracts: vec![contract.to_string()],
                        supported_observation_contracts: Vec::new(),
                        supported_metrics: vec![metric.to_string()],
                        supported_dimensions: Vec::new(),
                        expected_refresh_seconds: 3_600,
                        reliable_coverage_start: None,
                        highest_authoritative_source_sequence: None,
                        approved_checkpoint_count: Some(1),
                        approved_checkpoint_hash: None,
                        last_successful_collection_at: Some(occurred_at),
                        last_attempted_collection_at: Some(occurred_at),
                        safe_failure_code: None,
                        next_expected_at: Some(occurred_at + Duration::hours(1)),
                        manifest_state: "active".to_string(),
                        generated_at: occurred_at,
                        idempotency_key: None,
                    },
                )
                .expect("Tenant source manifest"),
            )
            .await;
        }
        transaction
            .commit()
            .await
            .expect("Tenant mutation and outbox should commit together");

        let client = AnalyticsIngestionClient::new(
            endpoint.clone(),
            INGESTION_TOKEN,
            StdDuration::from_secs(10),
        )
        .expect("Tenant publisher client");
        let settings = AnalyticsPublisherSettings {
            endpoint,
            token: INGESTION_TOKEN.to_string(),
            producer_id: PRODUCER_ID.to_string(),
            publisher_id: format!("tenant-system-e2e-publisher-{unique_suffix}"),
            batch_size: 500,
            lease_duration: StdDuration::from_secs(30),
            request_timeout: StdDuration::from_secs(10),
            retry_policy: RetryPolicy {
                base_delay: StdDuration::from_millis(10),
                max_delay: StdDuration::from_secs(1),
                jitter_window: StdDuration::ZERO,
            },
        };
        let stats = publish_outbox_once(&tenant_pool, &client, &settings, Utc::now())
            .await
            .expect("Tenant publisher should deliver facts");
        assert_eq!(stats.delivered, 8, "unexpected Tenant delivery stats: {stats:?}");

        let event_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM analytics.analytics_event
               WHERE source_service = $1 AND source_stream_key = $2"#,
        )
        .bind(SOURCE_SERVICE)
        .bind(format!("workspace:{workspace_id}:leads"))
        .fetch_one(&analytics_pool)
        .await
        .expect("Tenant Analytics event count");
        assert_eq!(event_count, 1);
        let client_reporting_scope_id: i64 = sqlx::query_scalar(
            r#"SELECT scope_id
               FROM analytics.reporting_scope
               WHERE scope_kind = 'tenant_client' AND external_source_id = $1"#,
        )
        .bind(&client_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("Tenant client reporting scope");
        let privacy_attributes: Value = sqlx::query_scalar(
            r#"SELECT attributes FROM analytics.analytics_event
               WHERE source_service = $1 AND event_type = 'tenant.lead.lifecycle@1'"#,
        )
        .bind(SOURCE_SERVICE)
        .fetch_one(&analytics_pool)
        .await
        .expect("Tenant lead attributes");
        assert!(privacy_attributes.get("email").is_none());
        assert!(privacy_attributes.get("name").is_none());

        sqlx::query(
            r#"INSERT INTO analytics.analytics_coverage_checkpoint (
                 producer_id, source_service, source_domain, reporting_scope_id, root_scope_id,
                 coverage_layer, window_start, window_end, expected_count, included_count,
                 excluded_count, coverage_state, complete_through, projection_version, observed_at
               ) VALUES ($1, 'tenant-platform', 'tenants', $2, $3, 'temporal', $4, $5, 1, 1,
                         0, 'available', $5, 'tenants.v1', $6)"#,
        )
        .bind(PRODUCER_ID)
        .bind(client_reporting_scope_id)
        .bind(reporting_scope_id)
        .bind(occurred_at - Duration::seconds(2))
        .bind(occurred_at + Duration::seconds(2))
        .bind(Utc::now())
        .execute(&analytics_pool)
        .await
        .expect("Tenant temporal coverage checkpoint");

        let (min_storage_id, max_storage_id): (i64, i64) = sqlx::query_as(
            r#"SELECT MIN(storage_id), MAX(storage_id)
               FROM analytics.analytics_event
               WHERE source_service = $1"#,
        )
        .bind(SOURCE_SERVICE)
        .fetch_one(&analytics_pool)
        .await
        .expect("Tenant event storage bounds");
        let projection_work_id: i64 = sqlx::query_scalar(
            r#"INSERT INTO analytics.analytics_projection_work (
                 projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
                 source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
                 priority, work_status
               ) VALUES ($1,$2,'event',$3,$4,$5,$6,$7,$8,1,'pending')
               RETURNING work_id"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(client_reporting_scope_id)
        .bind(reporting_scope_id)
        .bind(occurred_at - Duration::seconds(1))
        .bind(occurred_at + Duration::seconds(1))
        .bind(min_storage_id)
        .bind(max_storage_id)
        .fetch_one(&analytics_pool)
        .await
        .expect("Tenant projection work");
        let registry = load_registry().expect("Tenant E2E registry");
        let mut projected = false;
        for _ in 0..64 {
            let _ = projections::process_once(
                &analytics_pool,
                &registry,
                "tenant-system-e2e-projection",
                60,
            )
            .await
            .expect("Tenant projection pass");
            let status: (String, String, Option<String>) = sqlx::query_as(
                r#"SELECT work.work_status, checkpoint.processing_status,
                          generation.generation_status
                   FROM analytics.analytics_projection_work AS work
                   JOIN analytics.analytics_projection_checkpoint AS checkpoint
                     ON checkpoint.projection_name = work.projection_name
                    AND checkpoint.projection_version = work.projection_version
                    AND checkpoint.reporting_scope_id = work.reporting_scope_id
                   LEFT JOIN analytics.analytics_projection_generation AS generation
                     ON generation.generation_id = checkpoint.generation_id
                   WHERE work.work_id = $1"#,
            )
            .bind(projection_work_id)
            .fetch_one(&analytics_pool)
            .await
            .expect("Tenant projection status");
            if status.0 == "completed"
                && status.1 == "idle"
                && status.2.as_deref() == Some("promoted")
            {
                projected = true;
                break;
            }
        }
        assert!(projected, "Tenant projection work did not complete");

        let grant_id = format!("tenant-reporting-grant-{unique_suffix}");
        let grant_time = Utc::now();
        sqlx::query(
            r#"INSERT INTO analytics.reporting_grant (
                 grant_id, issuer_service_identity_id, audience, principal_type, principal_id,
                 scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,
                 permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,
                 expires_at, correlation_id
               ) VALUES ($1,'tenant-platform','kasitek-analytics-reporting','user','tenant-e2e-user',
                         $2,$3,'none','[]'::jsonb,$4,'[]'::jsonb,'[]'::jsonb,'v1',$5,$5,$6,$7)"#,
        )
        .bind(&grant_id)
        .bind(client_reporting_scope_id)
        .bind(reporting_scope_id)
        .bind(serde_json::json!(["analytics:read"]))
        .bind(grant_time)
        .bind(grant_time + Duration::minutes(1))
        .bind("tenant-system-e2e")
        .execute(&analytics_pool)
        .await
        .expect("Tenant reporting grant");
        let grant = ReportingGrant {
            grant_id,
            issuer: "kasitek-tenant-platform".to_string(),
            audience: "kasitek-analytics-reporting".to_string(),
            principal_type: PrincipalType::User,
            principal_id: "tenant-e2e-user".to_string(),
            scope_id: client_reporting_scope_id,
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
            correlation_id: Some("tenant-system-e2e".to_string()),
            revoked_at: None,
        };
        let mut report_transaction = analytics_pool.begin().await.expect("Tenant report transaction");
        let authorized = authorize_transaction(
            &mut report_transaction,
            &grant,
            client_reporting_scope_id,
        )
        .await
        .expect("Tenant report authorization");
        let report = execute_report(
            &mut report_transaction,
            &registry,
            &grant,
            &authorized,
            &ReportQueryRequest {
                reporting_scope_id: client_reporting_scope_id,
                range_start: occurred_at - Duration::seconds(1),
                range_end: occurred_at + Duration::seconds(1),
                timezone: "UTC".to_string(),
                interval: Some("hour".to_string()),
                metrics: vec!["tenant.leads.lifecycle_events@1".to_string()],
                metric_set: None,
                breakdowns: vec!["lead_status".to_string()],
                filters: Default::default(),
                include_descendants: false,
                comparison: None,
            },
        )
        .await
        .expect("Tenant lead report");
        assert_eq!(report.metrics[0].availability.state, "available");
        assert_eq!(report.metrics[0].series.len(), 1);
        assert_eq!(report.metrics[0].series[0].value, Some(1.0));
        assert_eq!(report.metrics[0].series[0].dimensions["lead_status"], "new");
        report_transaction.rollback().await.expect("Tenant report rollback");
    }
    .await;

    server_handle.stop(true).await;
    server_task
        .await
        .expect("Analytics API task should join")
        .expect("Analytics API should stop cleanly");
    result
}
