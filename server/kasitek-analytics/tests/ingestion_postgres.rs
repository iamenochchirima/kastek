use std::{env, fs};

use chrono::Utc;
use kasitek_analytics::{
    ingestion::{
        ingest_batch, AcknowledgementStatus, AuthenticatedProducer, IngestionBatchRequest,
        IngestionRecord,
    },
    reconciliation::{reconcile_stream, ReconciliationRequest},
    records::canonical_payload_sha256,
};
use serde_json::json;
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

fn event_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
    data: serde_json::Value,
) -> IngestionRecord {
    let payload_hash = canonical_payload_sha256(&data).unwrap();
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Event,
        record_id: record_id.to_string(),
        contract_name: "campaign.recipient.sent@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash,
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{:012}", sequence),
            "source": "kasitek://core",
            "type": "campaign.recipient.sent@1",
            "subject": format!("recipient:{record_id}"),
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/events/campaign/recipient_sent/v1.schema.json",
            "source_service": "core",
            "source_domain": "campaigns",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("test:{record_id}:{sequence}"),
            "data": data,
        }),
    }
}

fn observation_record(
    stream: &str,
    record_id: &str,
    sequence: i64,
    scope_external_id: &str,
) -> IngestionRecord {
    let data = json!({
        "provider": "provider-a09",
        "metric_key": "campaign.recipients.sent",
        "numeric_value": 1,
        "unit": "count",
        "reporting_window_start": "2026-08-22T11:00:00Z",
        "reporting_window_end": "2026-08-22T12:00:00Z",
        "observed_at": "2026-08-22T12:00:00Z",
        "synchronization_run_id": "sync-a09",
        "dimensions": {"channel": "whatsapp"},
        "source_evidence": {"provider_request_id": "request-a09"}
    });
    let payload_hash = canonical_payload_sha256(&data).unwrap();
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Observation,
        record_id: record_id.to_string(),
        contract_name: "campaign.delivery.observation@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash,
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{:012}", sequence),
            "source": "kasitek://core",
            "type": "campaign.delivery.observation@1",
            "subject": "metric:campaign.recipients.sent",
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/observations/campaign/delivery/v1.schema.json",
            "source_service": "core",
            "source_domain": "campaigns",
            "record_category": "observation",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("test:{record_id}:{sequence}"),
            "data": data,
        }),
    }
}

fn scope_definition_record(
    stream: &str,
    record_id: &str,
    scope_external_id: &str,
) -> IngestionRecord {
    let data = json!({
        "scope_kind": "tenant_workspace",
        "scope_external_id": scope_external_id,
        "reporting_timezone": "Africa/Johannesburg",
        "status": "active",
        "source_version": 1
    });
    IngestionRecord {
        producer_id: "tenant-platform-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: 1,
        record_category: kasitek_analytics::records::RecordCategory::ScopeDefinition,
        record_id: record_id.to_string(),
        contract_name: "tenant.workspace.definition@1".to_string(),
        schema_version: 1,
        scope_kind: "tenant_workspace".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).unwrap(),
        envelope: json!({
            "specversion": "1.0",
            "id": "00000000-0000-4000-8000-000000000101",
            "source": "kasitek://tenant-platform",
            "type": "tenant.workspace.definition@1",
            "subject": format!("scope:{scope_external_id}"),
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/scopes/tenant_workspace/v1.schema.json",
            "source_service": "tenant-platform",
            "source_domain": "tenants",
            "record_category": "scope_definition",
            "scope_kind": "tenant_workspace",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("test:{record_id}"),
            "data": data,
        }),
    }
}

async fn pool() -> Option<PgPool> {
    let url = database_url()?;
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .ok()
}

#[tokio::test]
async fn ingests_idempotently_tracks_cursor_and_reconciles_source_summary() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_id = format!("a09-org-{suffix}");
    let stream = format!("core:{scope_id}");
    let run_id = format!("a09-reconciliation-{suffix}");
    let scope: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    let data = json!({
        "campaign_id": "campaign-a09",
        "recipient_id": "recipient-a09",
        "channel": "whatsapp",
        "occurred_at": "2026-08-22T12:00:00Z",
        "status": "sent"
    });
    let record_id = format!("event-a09-{suffix}");
    let record = event_record(&stream, &record_id, 1, &scope_id, data.clone());
    let accepted = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record.clone()],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        accepted.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));

    let observation = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![observation_record(
                &stream,
                &format!("observation-a09-{suffix}"),
                2,
                &scope_id,
            )],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        observation.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    let source_state = sqlx::query(
        "SELECT availability_state, metric_scope, latest_source_sequence FROM analytics.analytics_source_state WHERE producer_id = $1 AND source_stream_key = $2",
    )
    .bind(&authenticated.producer_id)
    .bind(&stream)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        source_state.get::<String, _>("availability_state"),
        "available"
    );
    assert_eq!(
        source_state.get::<String, _>("metric_scope"),
        "campaign.recipients.sent"
    );
    assert_eq!(source_state.get::<i64, _>("latest_source_sequence"), 2);

    let duplicate = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record.clone()],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        duplicate.acknowledgements[0].status,
        AcknowledgementStatus::Duplicate
    ));

    let mut conflict = record.clone();
    conflict.envelope["data"]["channel"] = json!("email");
    conflict.payload_hash = canonical_payload_sha256(&conflict.envelope["data"]).unwrap();
    let conflict_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![conflict],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        conflict_response.acknowledgements[0].status,
        AcknowledgementStatus::Rejected
    ));
    assert_eq!(
        conflict_response.acknowledgements[0].error_code.as_deref(),
        Some("identity_conflict")
    );

    let cursor = sqlx::query(
        "SELECT highest_received_sequence, highest_contiguous_sequence, known_gap_ranges FROM analytics.analytics_source_cursor WHERE producer_id = $1 AND source_stream_key = $2",
    )
    .bind(&authenticated.producer_id)
    .bind(&stream)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cursor.get::<i64, _>("highest_received_sequence"), 2);
    assert_eq!(cursor.get::<i64, _>("highest_contiguous_sequence"), 2);
    assert_eq!(
        cursor.get::<serde_json::Value, _>("known_gap_ranges"),
        json!([])
    );

    let reconciliation = reconcile_stream(
        &pool,
        &authenticated,
        ReconciliationRequest {
            reconciliation_run_id: run_id.clone(),
            reconciliation_work_id: None,
            producer_id: authenticated.producer_id.clone(),
            source_domain: "campaigns".to_string(),
            source_stream_key: stream.clone(),
            scope_kind: None,
            scope_external_id: None,
            source_highest_outbox_sequence: Some(2),
            source_highest_delivered_sequence: Some(2),
            authoritative_count: Some(2),
            authoritative_checksum: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(reconciliation.analytics_count, 2);
    assert_eq!(reconciliation.reconciliation_status, "mismatch");
    assert_eq!(reconciliation.unresolved_quarantine_count, 1);

    // The fact, quarantine, reconciliation, and scope rows are immutable evidence by design.
    // The test uses a unique scope and stream on every run instead of deleting that evidence.
    assert!(scope > 0);
}

#[tokio::test]
async fn scope_definition_ingestion_creates_a_receipt_and_is_idempotent() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("a09-workspace-{suffix}");
    let stream = format!("tenant:{scope_external_id}");
    let record_id = format!("scope-record-{suffix}");
    let authenticated = AuthenticatedProducer {
        source_service: "tenant-platform".to_string(),
        producer_id: "tenant-platform-customer-analytics".to_string(),
    };
    let record = scope_definition_record(&stream, &record_id, &scope_external_id);
    let accepted = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record.clone()],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        accepted.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    let scope = sqlx::query(
        "SELECT scope_kind, owning_source_service, reporting_timezone FROM analytics.reporting_scope WHERE external_source_id = $1",
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(scope.get::<String, _>("scope_kind"), "tenant_workspace");
    assert_eq!(
        scope.get::<String, _>("owning_source_service"),
        "tenant-platform"
    );
    assert_eq!(
        scope.get::<String, _>("reporting_timezone"),
        "Africa/Johannesburg"
    );
    let receipt_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM analytics.analytics_scope_definition_receipt WHERE producer_id = $1 AND record_id = $2",
    )
    .bind(&authenticated.producer_id)
    .bind(&record_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(receipt_count, 1);
    let duplicate = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        duplicate.acknowledgements[0].status,
        AcknowledgementStatus::Duplicate
    ));
}
