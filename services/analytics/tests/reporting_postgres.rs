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

fn connections_lifecycle_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
    occurred_at: chrono::DateTime<Utc>,
) -> IngestionRecord {
    let data = json!({
        "connection_id": "ext-connections-reporting",
        "provider": "WHATSAPP",
        "action": "connected",
        "status": "CONNECTED",
        "credential_status": "ACTIVE",
        "health_status": "HEALTHY",
        "webhook_status": "ACTIVE",
        "occurred_at": occurred_at,
    });
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Event,
        record_id: record_id.to_string(),
        contract_name: "connection.lifecycle@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).expect("Connections event payload hash"),
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{sequence:012}"),
            "source": "kasitek://core",
            "type": "connection.lifecycle@1",
            "subject": "connection:ext-connections-reporting",
            "time": occurred_at,
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/events/connections/lifecycle/v1.schema.json",
            "source_service": "core",
            "source_domain": "connections",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("connections-reporting:{record_id}"),
            "data": data,
        }),
    }
}

fn connections_event_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
    contract_name: &str,
    data: serde_json::Value,
    occurred_at: chrono::DateTime<Utc>,
) -> IngestionRecord {
    let schema_name = match contract_name {
        "connection.lifecycle@1" => "lifecycle",
        "connection.health_check@1" => "health_check",
        "connection.capability.lifecycle@1" => "capability_lifecycle",
        "connection.sync_attempt@1" => "sync_attempt",
        "connection.rate_limit@1" => "rate_limit",
        "connection.incident.lifecycle@1" => "incident_lifecycle",
        _ => panic!("unsupported Connections fixture contract: {contract_name}"),
    };
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Event,
        record_id: record_id.to_string(),
        contract_name: contract_name.to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).expect("Connections fixture payload hash"),
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{sequence:012}"),
            "source": "kasitek://core",
            "type": contract_name,
            "subject": "connection:ext-connections-reporting-all",
            "time": occurred_at,
            "datacontenttype": "application/json",
            "dataschema": format!("https://kasitek.co.za/analytics/contracts/events/connections/{schema_name}/v1.schema.json"),
            "source_service": "core",
            "source_domain": "connections",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("connections-reporting-all:{record_id}"),
            "data": data,
        }),
    }
}

fn handoff_event_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
    action: &str,
    status: &str,
    conversation_state: &str,
    actor_type: &str,
    resolution_code: Option<&str>,
    occurred_at: chrono::DateTime<Utc>,
) -> IngestionRecord {
    let mut data = json!({
        "handoff_id": "handoff-reporting-1",
        "conversation_id": "conversation-reporting-1",
        "installation_id": "installation-reporting-1",
        "agent_definition_id": "agent-reporting-1",
        "agent_version_id": "version-reporting-1",
        "agent_audience": "customer_service",
        "run_id": "run-reporting-1",
        "channel_type": "whatsapp",
        "action": action,
        "status": status,
        "reason": "customer_requested",
        "priority": "urgent",
        "actor_type": actor_type,
        "conversation_state": conversation_state,
        "occurred_at": occurred_at,
    });
    if let Some(value) = resolution_code {
        data["resolution_code"] = json!(value);
    }
    IngestionRecord {
        producer_id: "agent-platform-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Event,
        record_id: record_id.to_string(),
        contract_name: "agent.handoff.lifecycle@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).expect("handoff event payload hash"),
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{sequence:012}"),
            "source": "kasitek://agent-platform",
            "type": "agent.handoff.lifecycle@1",
            "subject": "handoff:handoff-reporting-1",
            "time": occurred_at,
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/events/agent/handoff_lifecycle/v1.schema.json",
            "source_service": "agent-platform",
            "source_domain": "agents",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("handoff-reporting:{record_id}"),
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

    for (metric_key, value_sum, coverage_sources) in [
        (
            "campaign.recipients.delivered",
            1.0_f64,
            json!(["campaign.recipient.delivered@1"]),
        ),
        (
            "campaign.recipients.read",
            1.0_f64,
            json!(["campaign.recipient.read@1"]),
        ),
        (
            "campaign.recipients.failed",
            1.0_f64,
            json!(["campaign.recipient.failed@1"]),
        ),
        (
            "campaign.recipients.blocked",
            1.0_f64,
            json!(["campaign.recipient.blocked@1"]),
        ),
        (
            "campaign.recipients.suppressed",
            1.0_f64,
            json!(["campaign.recipient.suppressed@1"]),
        ),
        (
            "campaign.recipients.unsubscribed",
            1.0_f64,
            json!(["campaign.recipient.unsubscribed@1"]),
        ),
    ] {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_rollup (
                 generation_id, projection_name, projection_version, metric_key, metric_version,
                 target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
                 timezone_name, timezone_revision, dimensions, value_count, value_sum,
                 source_high_watermark, coverage
               ) VALUES ($1,$2,$3,$4,1,$5,$5,$5,'day',$6,$7,'UTC',1,
                         '{}'::jsonb,1,$8,10,$9)"#,
        )
        .bind(generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(metric_key)
        .bind(scope_id)
        .bind(bucket_start)
        .bind(bucket_end)
        .bind(value_sum)
        .bind(json!({
            "source_fact_count": 1,
            "coverage_state": "observed",
            "required_sources": coverage_sources
        }))
        .execute(&mut **transaction)
        .await
        .expect("delivered count rollup");
    }
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             timezone_name, timezone_revision, dimensions, value_count, value_sum,
             numerator, denominator, source_high_watermark, coverage
           ) VALUES ($1,$2,$3,'campaign.delivery_rate',1,$4,$4,$4,'day',$5,$6,'UTC',1,
                     '{}'::jsonb,1,0.5,1,2,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start)
    .bind(bucket_end)
    .bind(json!({
        "source_fact_count": 2,
        "coverage_state": "observed",
        "required_sources": [
            "campaign.recipient.sent@1",
            "campaign.recipient.delivered@1"
        ]
    }))
    .execute(&mut **transaction)
    .await
    .expect("delivery rate rollup");

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
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_contribution (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
             bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
             deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
             coverage
           ) VALUES ($1,$2,$3,'campaign.recipients.delivered',1,'event',14,$4,$4,$4,
                     $5,$6,'UTC',1,'{}'::jsonb,'recipient-1','campaign.delivered',1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start + Duration::hours(12))
    .bind(bucket_start + Duration::hours(13))
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.delivered@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("delivered contribution");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_contribution (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
             bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
             deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
             coverage
           ) VALUES ($1,$2,$3,'campaign.recipients.read',1,'event',15,$4,$4,$4,
                     $5,$6,'UTC',1,'{}'::jsonb,'recipient-1','campaign.read',1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start + Duration::hours(12))
    .bind(bucket_start + Duration::hours(13))
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.read@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("read contribution");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_contribution (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
             bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
             deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
             coverage
           ) VALUES ($1,$2,$3,'campaign.recipients.failed',1,'event',16,$4,$4,$4,
                     $5,$6,'UTC',1,'{"failure_class":"provider_rejected"}'::jsonb,
                     'recipient-2','campaign.failed',1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start + Duration::hours(12))
    .bind(bucket_start + Duration::hours(13))
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.failed@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("failed contribution");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_contribution (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
             bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
             deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
             coverage
           ) VALUES ($1,$2,$3,'campaign.recipients.blocked',1,'event',17,$4,$4,$4,
                     $5,$6,'UTC',1,'{"block_class":"provider_blocked"}'::jsonb,
                     'recipient-3','campaign.blocked',1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start + Duration::hours(12))
    .bind(bucket_start + Duration::hours(13))
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.blocked@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("blocked contribution");
    for (metric_key, storage_id, dimensions, deduplication_key, builder_name, source, value_sum) in [
        (
            "campaign.recipients.suppressed",
            18_i64,
            r#"{"suppression_class":"contact_excluded"}"#,
            "recipient-4",
            "campaign.suppressed",
            "campaign.recipient.suppressed@1",
            1.0_f64,
        ),
        (
            "campaign.recipients.unsubscribed",
            19_i64,
            r#"{"unsubscribe_source":"keyword"}"#,
            "recipient-5",
            "campaign.unsubscribed",
            "campaign.recipient.unsubscribed@1",
            1.0_f64,
        ),
    ] {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_contribution (
                 generation_id, projection_name, projection_version, metric_key, metric_version,
                 source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
                 bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
                 deduplication_key, builder_name, value_count, value_sum, source_high_watermark,
                 coverage
               ) VALUES ($1,$2,$3,$4,1,'event',$5,$6,$6,$6,
                         $7,$8,'UTC',1,$9::jsonb,$10,$11,1,$12,10,$13)"#,
        )
        .bind(generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(metric_key)
        .bind(storage_id)
        .bind(scope_id)
        .bind(bucket_start + Duration::hours(12))
        .bind(bucket_start + Duration::hours(13))
        .bind(dimensions)
        .bind(deduplication_key)
        .bind(builder_name)
        .bind(value_sum)
        .bind(json!({
            "source_fact_count": 1,
            "coverage_state": "observed",
            "required_sources": [source]
        }))
        .execute(&mut **transaction)
        .await
        .expect("campaign lifecycle contribution");
    }
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             timezone_name, timezone_revision, dimensions, value_count, value_sum,
             source_high_watermark, coverage
           ) VALUES ($1,$2,$3,'campaign.delivery_delay_ms',1,$4,$4,$4,'day',$5,$6,'UTC',1,
                     '{"timing_kind":"send_to_delivered"}'::jsonb,1,4200,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start)
    .bind(bucket_end)
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.timing@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("timing rollup");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             timezone_name, timezone_revision, dimensions, value_count, value_sum,
             source_high_watermark, coverage
           ) VALUES ($1,$2,$3,'campaign.recipients.retried',1,$4,$4,$4,'day',$5,$6,'UTC',1,
                     '{"retry_reason":"manual"}'::jsonb,1,1,10,$7)"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(bucket_start)
    .bind(bucket_end)
    .bind(json!({
        "source_fact_count": 1,
        "coverage_state": "observed",
        "required_sources": ["campaign.recipient.retry@1"]
    }))
    .execute(&mut **transaction)
    .await
    .expect("retry rollup");

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
    let delivery_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec![
                "campaign.recipients.delivered@1".to_string(),
                "campaign.recipients.read@1".to_string(),
                "campaign.recipients.failed@1".to_string(),
                "campaign.recipients.blocked@1".to_string(),
                "campaign.recipients.suppressed@1".to_string(),
                "campaign.recipients.unsubscribed@1".to_string(),
                "campaign.delivery_delay_ms@1".to_string(),
                "campaign.recipients.retried@1".to_string(),
                "campaign.delivery_rate@1".to_string(),
            ],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("Campaign delivery report response");
    assert_eq!(delivery_response.metrics.len(), 9);
    assert_eq!(delivery_response.metrics[0].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[1].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[2].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[3].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[4].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[5].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[6].series[0].value, Some(4200.0));
    assert_eq!(delivery_response.metrics[7].series[0].value, Some(1.0));
    assert_eq!(delivery_response.metrics[8].series[0].value, Some(0.5));
    assert_eq!(
        delivery_response.metrics[0].coverage.required_sources,
        vec!["campaign.recipient.delivered@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[1].coverage.required_sources,
        vec!["campaign.recipient.read@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[2].coverage.required_sources,
        vec!["campaign.recipient.failed@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[3].coverage.required_sources,
        vec!["campaign.recipient.blocked@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[4].coverage.required_sources,
        vec!["campaign.recipient.suppressed@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[5].coverage.required_sources,
        vec!["campaign.recipient.unsubscribed@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[6].coverage.required_sources,
        vec!["campaign.recipient.timing@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[7].coverage.required_sources,
        vec!["campaign.recipient.retry@1".to_string()]
    );
    assert_eq!(
        delivery_response.metrics[8].coverage.required_sources,
        vec![
            "campaign.recipient.sent@1".to_string(),
            "campaign.recipient.delivered@1".to_string()
        ]
    );
    for metric in &delivery_response.metrics {
        assert_eq!(metric.availability.state, "available");
        assert_eq!(metric.coverage.state, "available");
        assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
    }
    let failure_dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.recipients.failed@1".to_string()],
            breakdowns: vec!["failure_class".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("failure dimension report response");
    assert_eq!(
        failure_dimension_response.metrics[0]
            .coverage
            .dimension_state,
        "available"
    );
    assert_eq!(
        failure_dimension_response.metrics[0].series[0]
            .dimensions
            .get("failure_class")
            .and_then(|value| value.as_str()),
        Some("provider_rejected")
    );
    let blocked_dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.recipients.blocked@1".to_string()],
            breakdowns: vec!["block_class".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("blocked dimension report response");
    assert_eq!(
        blocked_dimension_response.metrics[0]
            .coverage
            .dimension_state,
        "available"
    );
    assert_eq!(
        blocked_dimension_response.metrics[0].series[0]
            .dimensions
            .get("block_class")
            .and_then(|value| value.as_str()),
        Some("provider_blocked")
    );
    let suppressed_dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.recipients.suppressed@1".to_string()],
            breakdowns: vec!["suppression_class".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("suppressed dimension report response");
    assert_eq!(
        suppressed_dimension_response.metrics[0].series[0]
            .dimensions
            .get("suppression_class")
            .and_then(|value| value.as_str()),
        Some("contact_excluded")
    );
    let unsubscribed_dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.recipients.unsubscribed@1".to_string()],
            breakdowns: vec!["unsubscribe_source".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("unsubscribed dimension report response");
    assert_eq!(
        unsubscribed_dimension_response.metrics[0].series[0]
            .dimensions
            .get("unsubscribe_source")
            .and_then(|value| value.as_str()),
        Some("keyword")
    );
    let timing_dimension_response = execute_report(
        &mut transaction,
        &registry,
        &grant,
        &authorized,
        &ReportQueryRequest {
            metrics: vec!["campaign.delivery_delay_ms@1".to_string()],
            breakdowns: vec!["timing_kind".to_string()],
            comparison: None,
            ..request.clone()
        },
    )
    .await
    .expect("timing dimension report response");
    assert_eq!(
        timing_dimension_response.metrics[0].series[0]
            .dimensions
            .get("timing_kind")
            .and_then(|value| value.as_str()),
        Some("send_to_delivered")
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

#[tokio::test]
async fn connections_backfill_projects_and_reports_with_lifecycle_dimensions() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("connections-reporting-org-{suffix}");
    let stream = format!("organization:{scope_external_id}:connections");
    let record_id = format!("connections-reporting-lifecycle-{suffix}");
    let backfill_job_id = format!("connections-reporting-backfill-{suffix}");
    let grant_id = format!("connections-reporting-grant-{suffix}");
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .expect("Connections reporting scope");
    let range_start = Utc.with_ymd_and_hms(2026, 8, 24, 12, 0, 0).unwrap();
    let range_end = range_start + Duration::hours(1);
    let event_time = range_start + Duration::minutes(15);
    let grant_time = Utc::now().with_nanosecond(0).expect("grant timestamp");
    let grant = ReportingGrant {
        grant_id: grant_id.clone(),
        issuer: "kasitek-core".to_string(),
        audience: "kasitek-analytics-reporting".to_string(),
        principal_type: PrincipalType::User,
        principal_id: "connections-reporting-user".to_string(),
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
        correlation_id: Some("connections-reporting-e2e".to_string()),
        revoked_at: None,
    };

    let mut setup = pool.begin().await.expect("Connections reporting setup");
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
    .expect("Connections reporting grant");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','connections',$2,$2,$3,$4,'connection.lifecycle@1',
                     'source_reconstruction','running',1,'test','connections-reporting-e2e',
                     $5,NOW())"#,
    )
    .bind(&backfill_job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(&grant_id)
    .execute(&mut *setup)
    .await
    .expect("Connections source backfill job");
    setup.commit().await.expect("Connections setup commit");

    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![connections_lifecycle_record(
                &stream,
                &record_id,
                9_100_001,
                &scope_external_id,
                event_time,
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
            .expect("ingested Connections event");
    sqlx::query(
        "UPDATE analytics.analytics_projection_work SET priority = 1 WHERE min_source_storage_id = $1 AND max_source_storage_id = $1",
    )
    .bind(storage_id)
    .execute(&pool)
    .await
    .expect("prioritize Connections projection work");
    let mut projected = false;
    for _ in 0..32 {
        let _ = projections::process_once(&pool, &registry, "connections-reporting-e2e", 60)
            .await
            .expect("Connections projection pass");
        let contributions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM analytics.analytics_projection_contribution WHERE source_storage_id = $1 AND metric_key = 'connection.lifecycle_events'",
        )
        .bind(storage_id)
        .fetch_one(&pool)
        .await
        .expect("Connections projection contribution count");
        if contributions > 0 {
            projected = true;
            break;
        }
    }
    assert!(projected, "Connections event should reach the projection");

    let mut transaction = pool.begin().await.expect("Connections report transaction");
    let authorized = authorize_transaction(&mut transaction, &grant, scope_id)
        .await
        .expect("authorized Connections reporting scope");
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
            metrics: vec!["connection.lifecycle_events@1".to_string()],
            metric_set: None,
            breakdowns: vec!["provider".to_string(), "lifecycle_action".to_string()],
            filters: Default::default(),
            include_descendants: false,
            comparison: None,
        },
    )
    .await
    .expect("Connections report");
    let metric = &report.metrics[0];
    assert_eq!(metric.availability.state, "available");
    assert_eq!(metric.coverage.state, "available");
    assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
    assert_eq!(metric.coverage.window_start, Some(range_start));
    assert_eq!(metric.coverage.window_end, Some(range_end));
    assert_eq!(metric.coverage.complete_through, Some(range_end));
    assert_eq!(metric.coverage.dimension_state, "available");
    assert_eq!(metric.coverage.missing_dimension_points, 0);
    assert_eq!(
        metric.coverage.required_sources,
        vec!["connection.lifecycle@1"]
    );
    assert_eq!(metric.series.len(), 1);
    assert_eq!(metric.series[0].value, Some(1.0));
    assert_eq!(metric.series[0].dimensions["provider"], "WHATSAPP");
    assert_eq!(metric.series[0].dimensions["lifecycle_action"], "connected");
    transaction
        .rollback()
        .await
        .expect("rollback Connections report transaction");
}

#[tokio::test]
async fn all_connections_metrics_report_after_backfill_projection_completion() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("connections-all-reporting-org-{suffix}");
    let stream = format!("organization:{scope_external_id}:connections");
    let backfill_job_id = format!("connections-all-reporting-backfill-{suffix}");
    let grant_id = format!("connections-all-reporting-grant-{suffix}");
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'core', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .expect("all Connections reporting scope");
    let range_start = Utc.with_ymd_and_hms(2026, 8, 24, 14, 0, 0).unwrap();
    let range_end = range_start + Duration::hours(1);
    let grant_time = Utc::now().with_nanosecond(0).expect("grant timestamp");
    let grant = ReportingGrant {
        grant_id: grant_id.clone(),
        issuer: "kasitek-core".to_string(),
        audience: "kasitek-analytics-reporting".to_string(),
        principal_type: PrincipalType::User,
        principal_id: "connections-all-reporting-user".to_string(),
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
        correlation_id: Some("connections-all-reporting-e2e".to_string()),
        revoked_at: None,
    };

    let mut setup = pool.begin().await.expect("all Connections setup");
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
    .expect("all Connections reporting grant");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','connections',$2,$2,$3,$4,'connections.v1',
                     'source_reconstruction','running',6,'test','connections-all-reporting-e2e',
                     $5,NOW())"#,
    )
    .bind(&backfill_job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(&grant_id)
    .execute(&mut *setup)
    .await
    .expect("all Connections source backfill job");
    setup.commit().await.expect("all Connections setup commit");

    let event_specs = [
        (
            "connection.lifecycle@1",
            json!({
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "action": "connected",
                "status": "CONNECTED",
                "credential_status": "ACTIVE",
                "health_status": "HEALTHY",
                "webhook_status": "ACTIVE",
                "occurred_at": range_start,
            }),
        ),
        (
            "connection.health_check@1",
            json!({
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "status": "CONNECTED",
                "health_status": "HEALTHY",
                "credential_status": "ACTIVE",
                "webhook_status": "ACTIVE",
                "check_result": "healthy",
                "occurred_at": range_start + Duration::seconds(1),
            }),
        ),
        (
            "connection.capability.lifecycle@1",
            json!({
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "capability": "MESSAGING_INBOUND",
                "action": "enabled",
                "enabled": true,
                "occurred_at": range_start + Duration::seconds(2),
            }),
        ),
        (
            "connection.sync_attempt@1",
            json!({
                "attempt_id": "connections-all-attempt",
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "operation": "connection_refresh",
                "outcome": "succeeded",
                "failure_class": "none",
                "duration_ms": 120,
                "occurred_at": range_start + Duration::seconds(3),
            }),
        ),
        (
            "connection.rate_limit@1",
            json!({
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "operation": "connection_refresh",
                "rate_limit_scope": "provider",
                "retry_after_seconds": 30,
                "observed_at": range_start + Duration::seconds(4),
            }),
        ),
        (
            "connection.incident.lifecycle@1",
            json!({
                "connection_id": "ext-connections-reporting-all",
                "provider": "WHATSAPP",
                "incident_key": "connection_health",
                "action": "opened",
                "severity": "critical",
                "reason_code": "provider_health_failed",
                "occurred_at": range_start + Duration::seconds(5),
            }),
        ),
    ];
    let records = event_specs
        .iter()
        .enumerate()
        .map(|(index, (contract_name, data))| {
            connections_event_record(
                &stream,
                &format!("connections-all-reporting-{index}-{suffix}"),
                9_200_001 + index as i64,
                &scope_external_id,
                contract_name,
                data.clone(),
                range_start + Duration::seconds(index as i64),
            )
        })
        .collect::<Vec<_>>();
    let record_ids = records
        .iter()
        .map(|record| record.record_id.clone())
        .collect::<Vec<_>>();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records,
            backfill_job_id: Some(backfill_job_id),
        },
    )
    .await;
    assert_eq!(response.accepted_count, 6);
    assert_eq!(response.rejected_count, 0);

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_work
           SET priority = 1
           WHERE min_source_storage_id = (
                     SELECT MIN(storage_id) FROM analytics.analytics_event WHERE event_id = ANY($1)
                 )
             AND max_source_storage_id = (
                     SELECT MAX(storage_id) FROM analytics.analytics_event WHERE event_id = ANY($1)
                 )"#,
    )
    .bind(&record_ids)
    .execute(&pool)
    .await
    .expect("prioritize all Connections projection work");

    let mut projected = false;
    for _ in 0..32 {
        let _ = projections::process_once(&pool, &registry, "connections-all-reporting-e2e", 60)
            .await
            .expect("all Connections projection pass");
        let contribution_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM analytics.analytics_projection_contribution
               WHERE source_storage_id IN (
                   SELECT storage_id FROM analytics.analytics_event WHERE event_id = ANY($1)
               )"#,
        )
        .bind(&record_ids)
        .fetch_one(&pool)
        .await
        .expect("all Connections contribution count");
        if contribution_count >= 6 {
            projected = true;
            break;
        }
    }
    assert!(
        projected,
        "all Connections events should reach the projection"
    );

    let mut transaction = pool
        .begin()
        .await
        .expect("all Connections report transaction");
    let authorized = authorize_transaction(&mut transaction, &grant, scope_id)
        .await
        .expect("authorized all Connections reporting scope");
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
            metrics: vec![
                "connection.lifecycle_events@1".to_string(),
                "connection.health_checks@1".to_string(),
                "connection.capability_events@1".to_string(),
                "connection.sync_attempts@1".to_string(),
                "connection.rate_limit_encounters@1".to_string(),
                "connection.incidents@1".to_string(),
            ],
            metric_set: None,
            breakdowns: Vec::new(),
            filters: Default::default(),
            include_descendants: false,
            comparison: None,
        },
    )
    .await
    .expect("all Connections report");
    assert_eq!(report.metrics.len(), 6);
    let expected_sources = [
        "connection.lifecycle@1",
        "connection.health_check@1",
        "connection.capability.lifecycle@1",
        "connection.sync_attempt@1",
        "connection.rate_limit@1",
        "connection.incident.lifecycle@1",
    ];
    for (metric, expected_source) in report.metrics.iter().zip(expected_sources) {
        assert_eq!(metric.availability.state, "available", "{}", metric.key);
        assert_eq!(metric.coverage.state, "available", "{}", metric.key);
        assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
        assert_eq!(metric.coverage.window_start, Some(range_start));
        assert_eq!(metric.coverage.window_end, Some(range_end));
        assert_eq!(metric.coverage.complete_through, Some(range_end));
        assert_eq!(metric.coverage.required_sources, vec![expected_source]);
        assert_eq!(metric.series.len(), 1, "{}", metric.key);
        assert_eq!(metric.series[0].value, Some(1.0), "{}", metric.key);
    }
    transaction
        .rollback()
        .await
        .expect("rollback all Connections report transaction");
}

#[tokio::test]
async fn customer_handoff_lifecycle_projects_and_reports_with_safe_dimensions() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("handoff-reporting-org-{suffix}");
    let stream = format!("organization:{scope_external_id}:handoffs");
    let grant_id = format!("handoff-reporting-grant-{suffix}");
    let backfill_job_id = format!("handoff-reporting-backfill-{suffix}");
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization', 'agent-platform', $1, 'active', 'UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .expect("handoff reporting scope");
    let range_start = Utc.with_ymd_and_hms(2026, 8, 24, 12, 0, 0).unwrap();
    let range_end = range_start + Duration::hours(1);
    let grant_time = Utc::now().with_nanosecond(0).expect("grant timestamp");
    let grant = ReportingGrant {
        grant_id: grant_id.clone(),
        issuer: "kasitek-agent-platform".to_string(),
        audience: "kasitek-analytics-reporting".to_string(),
        principal_type: PrincipalType::User,
        principal_id: "handoff-reporting-user".to_string(),
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
        correlation_id: Some("handoff-reporting-e2e".to_string()),
        revoked_at: None,
    };

    let mut setup = pool.begin().await.expect("handoff reporting setup");
    sqlx::query(
        r#"INSERT INTO analytics.reporting_grant (
             grant_id, issuer_service_identity_id, audience, principal_type, principal_id,
             scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,
             permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,
             expires_at, correlation_id
           ) VALUES ($1,'agent-platform','kasitek-analytics-reporting','user',$2,$3,$3,'none',
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
    .expect("handoff reporting grant");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'agent-platform','agents',$2,$2,$3,$4,'agent.handoff.lifecycle@1',
                     'source_reconstruction','running',3,'test','handoff-reporting-e2e',
                     $5,NOW())"#,
    )
    .bind(&backfill_job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(&grant_id)
    .execute(&mut *setup)
    .await
    .expect("handoff source backfill job");
    setup.commit().await.expect("handoff setup commit");

    let records = [
        ("requested", "pending", "handoff_requested", "agent", None),
        ("first_human_response", "sent", "human_owned", "user", None),
        ("resolved", "resolved", "resolved", "user", Some("resolved")),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(index, (action, status, conversation_state, actor_type, resolution_code))| {
            handoff_event_record(
                &stream,
                &format!("handoff-reporting-{index}-{suffix}"),
                9_300_001 + index as i64,
                &scope_external_id,
                action,
                status,
                conversation_state,
                actor_type,
                resolution_code,
                range_start + Duration::seconds(index as i64 * 10),
            )
        },
    )
    .collect::<Vec<_>>();
    let record_ids = records
        .iter()
        .map(|record| record.record_id.clone())
        .collect::<Vec<_>>();
    let authenticated = AuthenticatedProducer {
        source_service: "agent-platform".to_string(),
        producer_id: "agent-platform-customer-analytics".to_string(),
    };
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records,
            backfill_job_id: Some(backfill_job_id),
        },
    )
    .await;
    assert_eq!(response.accepted_count, 3);
    assert_eq!(response.rejected_count, 0);

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_work
           SET priority = 1
           WHERE min_source_storage_id = (
                     SELECT MIN(storage_id) FROM analytics.analytics_event WHERE event_id = ANY($1)
                 )
             AND max_source_storage_id = (
                     SELECT MAX(storage_id) FROM analytics.analytics_event WHERE event_id = ANY($1)
                 )"#,
    )
    .bind(&record_ids)
    .execute(&pool)
    .await
    .expect("prioritize handoff projection work");
    let mut projected = false;
    for _ in 0..32 {
        let _ = projections::process_once(&pool, &registry, "handoff-reporting-e2e", 60)
            .await
            .expect("handoff projection pass");
        let contribution_count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM analytics.analytics_projection_contribution
               WHERE source_storage_id IN (
                   SELECT storage_id FROM analytics.analytics_event WHERE event_id = ANY($1)
               ) AND metric_key = 'agent.handoffs.lifecycle_events'"#,
        )
        .bind(&record_ids)
        .fetch_one(&pool)
        .await
        .expect("handoff contribution count");
        if contribution_count >= 3 {
            projected = true;
            break;
        }
    }
    assert!(
        projected,
        "handoff events should reach the Agent projection"
    );

    let mut transaction = pool.begin().await.expect("handoff report transaction");
    let authorized = authorize_transaction(&mut transaction, &grant, scope_id)
        .await
        .expect("authorized handoff reporting scope");
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
            metrics: vec!["agent.handoffs.lifecycle_events@1".to_string()],
            metric_set: None,
            breakdowns: vec![
                "agent_definition".to_string(),
                "handoff_conversation_state".to_string(),
            ],
            filters: Default::default(),
            include_descendants: false,
            comparison: None,
        },
    )
    .await
    .expect("handoff report");
    let metric = &report.metrics[0];
    assert_eq!(metric.availability.state, "available");
    assert_eq!(metric.coverage.state, "available");
    assert_eq!(metric.coverage.evidence_layer.as_deref(), Some("temporal"));
    assert_eq!(metric.coverage.window_start, Some(range_start));
    assert_eq!(metric.coverage.window_end, Some(range_end));
    assert_eq!(metric.coverage.complete_through, Some(range_end));
    assert_eq!(metric.coverage.dimension_state, "available");
    assert_eq!(metric.coverage.missing_dimension_points, 0);
    assert_eq!(
        metric.coverage.required_sources,
        vec!["agent.handoff.lifecycle@1"]
    );
    assert_eq!(metric.series.len(), 3);
    assert!(metric.series.iter().all(|series| {
        series.dimensions["agent_definition"] == "agent-reporting-1" && series.value == Some(1.0)
    }));
    transaction
        .rollback()
        .await
        .expect("rollback handoff report transaction");
}
