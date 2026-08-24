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

fn manifest_record(
    stream: &str,
    manifest_key: &str,
    sequence: i64,
    scope_external_id: &str,
) -> IngestionRecord {
    let data = json!({
        "manifest_key": manifest_key,
        "manifest_version": 1,
        "provider": "meta",
        "connection_ref": "connection-a09",
        "supported_contracts": ["campaign.recipient.sent@1"],
        "supported_observation_contracts": ["campaign.delivery.observation@1"],
        "supported_metrics": ["campaign.recipients.sent"],
        "supported_dimensions": ["channel"],
        "expected_refresh_seconds": 300,
        "reliable_coverage_start": null,
        "highest_authoritative_source_sequence": 12,
        "approved_checkpoint_count": 3,
        "approved_checkpoint_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "last_successful_collection_at": "2026-08-22T12:00:00Z",
        "last_attempted_collection_at": "2026-08-22T12:00:00Z",
        "safe_failure_code": null,
        "next_expected_at": "2026-08-22T12:05:00Z",
        "manifest_state": "active",
        "generated_at": "2026-08-22T12:00:00Z"
    });
    IngestionRecord {
        producer_id: "core-customer-analytics".to_string(),
        source_stream_key: stream.to_string(),
        source_sequence: sequence,
        record_category: kasitek_analytics::records::RecordCategory::Manifest,
        record_id: format!("manifest:{stream}:{manifest_key}:1"),
        contract_name: "source.manifest@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.to_string(),
        payload_hash: canonical_payload_sha256(&data).unwrap(),
        envelope: json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{:012}", sequence + 1000),
            "source": "kasitek://core",
            "type": "source.manifest@1",
            "subject": format!("manifest:{manifest_key}"),
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/manifests/source.manifest/v1.schema.json",
            "source_service": "core",
            "source_domain": "connections",
            "record_category": "manifest",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("test:{manifest_key}:1"),
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
    let manifest_key = format!("connections-a09-{suffix}");
    let manifest = manifest_record(&stream, &manifest_key, 3, &scope_id);
    let manifest_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![manifest.clone()],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        manifest_response.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_source_manifest WHERE producer_id = $1 AND manifest_key = $2",
        )
        .bind(&authenticated.producer_id)
        .bind(&manifest_key)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let manifest_row = sqlx::query(
        "SELECT manifest_id, reliable_coverage_start FROM analytics.analytics_source_manifest WHERE producer_id = $1 AND manifest_key = $2",
    )
    .bind(&authenticated.producer_id)
    .bind(&manifest_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    let manifest_id = manifest_row.get::<i64, _>("manifest_id");
    assert!(manifest_row
        .get::<Option<chrono::DateTime<Utc>>, _>("reliable_coverage_start")
        .is_none());
    let coverage = sqlx::query(
        "SELECT source_manifest_id, coverage_layer, source_domain, window_start, window_end, expected_count, included_count, excluded_count, coverage_state, complete_through, projection_version FROM analytics.analytics_coverage_checkpoint WHERE source_manifest_id = $1",
    )
    .bind(manifest_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(coverage.get::<i64, _>("source_manifest_id"), manifest_id);
    assert_eq!(coverage.get::<String, _>("coverage_layer"), "source");
    assert_eq!(coverage.get::<String, _>("source_domain"), "connections");
    assert_eq!(
        coverage.get::<chrono::DateTime<Utc>, _>("window_start"),
        "2026-08-22T12:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert_eq!(
        coverage.get::<chrono::DateTime<Utc>, _>("window_end"),
        "2026-08-22T12:05:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert_eq!(coverage.get::<Option<i64>, _>("expected_count"), Some(3));
    assert_eq!(coverage.get::<i64, _>("included_count"), 3);
    assert_eq!(coverage.get::<i64, _>("excluded_count"), 0);
    assert_eq!(coverage.get::<String, _>("coverage_state"), "available");
    assert!(coverage
        .get::<Option<chrono::DateTime<Utc>>, _>("complete_through")
        .is_none());
    assert!(coverage
        .get::<Option<String>, _>("projection_version")
        .is_none());
    let coverage_payload: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(checkpoint) FROM analytics.analytics_coverage_checkpoint AS checkpoint WHERE source_manifest_id = $1",
    )
    .bind(manifest_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(coverage_payload.get("connection_ref").is_none());
    assert!(coverage_payload.get("approved_checkpoint_hash").is_none());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE source_manifest_id = $1",
        )
        .bind(manifest_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let manifest_duplicate = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![manifest],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        manifest_duplicate.acknowledgements[0].status,
        AcknowledgementStatus::Duplicate
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE source_manifest_id = $1",
        )
        .bind(manifest_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
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
    assert_eq!(cursor.get::<i64, _>("highest_received_sequence"), 3);
    assert_eq!(cursor.get::<i64, _>("highest_contiguous_sequence"), 3);
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
            scope_kind: Some("core_organization".to_string()),
            scope_external_id: Some(scope_id.clone()),
            source_highest_outbox_sequence: Some(3),
            source_highest_delivered_sequence: Some(3),
            authoritative_count: Some(3),
            authoritative_checksum: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(reconciliation.analytics_count, 3);
    assert_eq!(reconciliation.reconciliation_status, "mismatch");
    assert_eq!(reconciliation.unresolved_quarantine_count, 1);
    let mismatch_coverage = sqlx::query(
        "SELECT reconciliation_run_id, coverage_layer, window_start, window_end, expected_count, included_count, excluded_count, coverage_state, complete_through FROM analytics.analytics_coverage_checkpoint WHERE reconciliation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        mismatch_coverage.get::<String, _>("reconciliation_run_id"),
        run_id
    );
    assert_eq!(
        mismatch_coverage.get::<String, _>("coverage_layer"),
        "reconciliation"
    );
    assert_eq!(
        mismatch_coverage.get::<chrono::DateTime<Utc>, _>("window_start"),
        "2026-08-22T11:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert_eq!(
        mismatch_coverage.get::<chrono::DateTime<Utc>, _>("window_end"),
        "2026-08-22T12:00:00.000001Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap()
    );
    assert_eq!(
        mismatch_coverage.get::<Option<i64>, _>("expected_count"),
        Some(3)
    );
    assert_eq!(mismatch_coverage.get::<i64, _>("included_count"), 3);
    assert_eq!(mismatch_coverage.get::<i64, _>("excluded_count"), 0);
    assert_eq!(
        mismatch_coverage.get::<String, _>("coverage_state"),
        "partial"
    );
    assert!(mismatch_coverage
        .get::<Option<chrono::DateTime<Utc>>, _>("complete_through")
        .is_none());
    let mismatch_payload: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(checkpoint) FROM analytics.analytics_coverage_checkpoint AS checkpoint WHERE reconciliation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(mismatch_payload.get("attributes").is_none());
    assert!(mismatch_payload.get("connection_ref").is_none());

    let clean_stream = format!("a09-clean-reconciliation:{scope_id}");
    let clean_record_id = format!("clean-reconciliation-event-{suffix}");
    let clean_record = event_record(
        &clean_stream,
        &clean_record_id,
        1,
        &scope_id,
        json!({
            "campaign_id": "clean-campaign-a09",
            "recipient_id": "clean-recipient-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    let clean_ingestion = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![clean_record],
            backfill_job_id: None,
        },
    )
    .await;
    assert!(matches!(
        clean_ingestion.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    let clean_run_id = format!("a09-clean-reconciliation-{suffix}");
    let clean_request = ReconciliationRequest {
        reconciliation_run_id: clean_run_id.clone(),
        reconciliation_work_id: None,
        producer_id: authenticated.producer_id.clone(),
        source_domain: "campaigns".to_string(),
        source_stream_key: clean_stream,
        scope_kind: Some("core_organization".to_string()),
        scope_external_id: Some(scope_id.clone()),
        source_highest_outbox_sequence: Some(1),
        source_highest_delivered_sequence: Some(1),
        authoritative_count: Some(1),
        authoritative_checksum: None,
    };
    let clean_reconciliation = reconcile_stream(&pool, &authenticated, clean_request.clone())
        .await
        .unwrap();
    assert_eq!(clean_reconciliation.reconciliation_status, "complete");
    let clean_coverage = sqlx::query(
        "SELECT coverage_state, expected_count, included_count, excluded_count, complete_through FROM analytics.analytics_coverage_checkpoint WHERE reconciliation_run_id = $1",
    )
    .bind(&clean_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        clean_coverage.get::<String, _>("coverage_state"),
        "available"
    );
    assert_eq!(
        clean_coverage.get::<Option<i64>, _>("expected_count"),
        Some(1)
    );
    assert_eq!(clean_coverage.get::<i64, _>("included_count"), 1);
    assert_eq!(clean_coverage.get::<i64, _>("excluded_count"), 0);
    assert_eq!(
        clean_coverage.get::<Option<chrono::DateTime<Utc>>, _>("complete_through"),
        Some(
            "2026-08-22T12:00:00.000001Z"
                .parse::<chrono::DateTime<Utc>>()
                .unwrap()
        )
    );
    let clean_duplicate = reconcile_stream(&pool, &authenticated, clean_request)
        .await
        .unwrap();
    assert_eq!(clean_duplicate.reconciliation_status, "complete");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE reconciliation_run_id = $1",
        )
        .bind(&clean_run_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let empty_run_id = format!("a09-empty-reconciliation-{suffix}");
    let empty_stream = format!("a09-empty-reconciliation:{scope_id}");
    let empty_reconciliation = reconcile_stream(
        &pool,
        &authenticated,
        ReconciliationRequest {
            reconciliation_run_id: empty_run_id.clone(),
            reconciliation_work_id: None,
            producer_id: authenticated.producer_id.clone(),
            source_domain: "campaigns".to_string(),
            source_stream_key: empty_stream,
            scope_kind: Some("core_organization".to_string()),
            scope_external_id: Some(scope_id.clone()),
            source_highest_outbox_sequence: Some(0),
            source_highest_delivered_sequence: Some(0),
            authoritative_count: Some(0),
            authoritative_checksum: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(empty_reconciliation.reconciliation_status, "complete");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE reconciliation_run_id = $1",
        )
        .bind(empty_run_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );

    // The fact, quarantine, reconciliation, and scope rows are immutable evidence by design.
    // The test uses a unique scope and stream on every run instead of deleting that evidence.
    assert!(scope > 0);
}

#[tokio::test]
async fn source_backfill_completion_persists_temporal_coverage_and_replay_does_not() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("a09-backfill-org-{suffix}");
    let stream = format!("core:backfill:{scope_external_id}");
    let source_reconstruction_job_id = format!("a09-source-reconstruction-{suffix}");
    let fact_replay_job_id = format!("a09-fact-replay-{suffix}");
    let range_start = "2026-08-22T11:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let range_end = "2026-08-22T13:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    for (job_id, method) in [
        (&source_reconstruction_job_id, "source_reconstruction"),
        (&fact_replay_job_id, "fact_replay"),
    ] {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_backfill_job (
                 job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
                 requested_range_start, requested_range_end, contract_version, method,
                 job_status, remaining_count, requesting_actor_type, requesting_actor_id,
                 authorization_grant_id, started_at
               ) VALUES ($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',$5,
                         'running',1,'test','analytics-postgres-test',$6,NOW())"#,
        )
        .bind(job_id)
        .bind(scope_id)
        .bind(range_start)
        .bind(range_end)
        .bind(method)
        .bind(format!("grant-{job_id}"))
        .execute(&pool)
        .await
        .unwrap();
    }

    let source_record = event_record(
        &stream,
        &format!("backfill-source-event-{suffix}"),
        1,
        &scope_external_id,
        json!({
            "campaign_id": "campaign-backfill-a09",
            "recipient_id": "recipient-backfill-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    let source_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![source_record.clone()],
            backfill_job_id: Some(source_reconstruction_job_id.clone()),
        },
    )
    .await;
    assert!(matches!(
        source_response.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));

    let job = sqlx::query(
        "SELECT job_status, scanned_count, accepted_count, rejected_count, remaining_count FROM analytics.analytics_backfill_job WHERE job_id = $1",
    )
    .bind(&source_reconstruction_job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(job.get::<String, _>("job_status"), "completed");
    assert_eq!(job.get::<i64, _>("scanned_count"), 1);
    assert_eq!(job.get::<i64, _>("accepted_count"), 1);
    assert_eq!(job.get::<i64, _>("rejected_count"), 0);
    assert_eq!(job.get::<Option<i64>, _>("remaining_count"), Some(0));

    let coverage = sqlx::query(
        "SELECT producer_id, source_service, source_domain, reporting_scope_id, root_scope_id, coverage_layer, window_start, window_end, expected_count, included_count, excluded_count, coverage_state, complete_through, source_manifest_id, reconciliation_run_id FROM analytics.analytics_coverage_checkpoint WHERE backfill_job_id = $1",
    )
    .bind(&source_reconstruction_job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        coverage.get::<String, _>("producer_id"),
        authenticated.producer_id
    );
    assert_eq!(
        coverage.get::<String, _>("source_service"),
        authenticated.source_service
    );
    assert_eq!(coverage.get::<String, _>("source_domain"), "campaigns");
    assert_eq!(coverage.get::<i64, _>("reporting_scope_id"), scope_id);
    assert_eq!(coverage.get::<i64, _>("root_scope_id"), scope_id);
    assert_eq!(coverage.get::<String, _>("coverage_layer"), "temporal");
    assert_eq!(
        coverage.get::<chrono::DateTime<Utc>, _>("window_start"),
        range_start
    );
    assert_eq!(
        coverage.get::<chrono::DateTime<Utc>, _>("window_end"),
        range_end
    );
    assert_eq!(coverage.get::<Option<i64>, _>("expected_count"), Some(1));
    assert_eq!(coverage.get::<i64, _>("included_count"), 1);
    assert_eq!(coverage.get::<i64, _>("excluded_count"), 0);
    assert_eq!(coverage.get::<String, _>("coverage_state"), "available");
    assert_eq!(
        coverage.get::<Option<chrono::DateTime<Utc>>, _>("complete_through"),
        Some(range_end)
    );
    assert!(coverage
        .get::<Option<i64>, _>("source_manifest_id")
        .is_none());
    assert!(coverage
        .get::<Option<String>, _>("reconciliation_run_id")
        .is_none());

    let coverage_payload: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(checkpoint) FROM analytics.analytics_coverage_checkpoint AS checkpoint WHERE backfill_job_id = $1",
    )
    .bind(&source_reconstruction_job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(coverage_payload.get("connection_ref").is_none());
    assert!(coverage_payload.get("provider_account_ref").is_none());

    let duplicate_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![source_record],
            backfill_job_id: Some(source_reconstruction_job_id.clone()),
        },
    )
    .await;
    assert!(matches!(
        duplicate_response.acknowledgements[0].status,
        AcknowledgementStatus::Duplicate
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE backfill_job_id = $1",
        )
        .bind(&source_reconstruction_job_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );

    let replay_record = event_record(
        &stream,
        &format!("backfill-replay-event-{suffix}"),
        2,
        &scope_external_id,
        json!({
            "campaign_id": "campaign-backfill-a09",
            "recipient_id": "recipient-replay-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    let replay_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![replay_record],
            backfill_job_id: Some(fact_replay_job_id.clone()),
        },
    )
    .await;
    assert!(matches!(
        replay_response.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics.analytics_coverage_checkpoint WHERE backfill_job_id = $1",
        )
        .bind(&fact_replay_job_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn rejected_source_backfill_record_persists_partial_temporal_coverage() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let job_scope_external_id = format!("a09-rejected-backfill-org-{suffix}");
    let deleted_scope_external_id = format!("a09-deleted-backfill-org-{suffix}");
    let stream = format!("core:rejected-backfill:{suffix}");
    let job_id = format!("a09-rejected-source-reconstruction-{suffix}");
    let range_start = "2026-08-22T11:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let range_end = "2026-08-22T13:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let job_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(&job_scope_external_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'deleted','UTC')"#,
    )
    .bind(&deleted_scope_external_id)
    .execute(&pool)
    .await
    .unwrap();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',
                     'source_reconstruction','running',1,'test','analytics-postgres-test',$5,NOW())"#,
    )
    .bind(&job_id)
    .bind(job_scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(format!("grant-{job_id}"))
    .execute(&pool)
    .await
    .unwrap();

    let record = event_record(
        &stream,
        &format!("backfill-rejected-event-{suffix}"),
        1,
        &deleted_scope_external_id,
        json!({
            "campaign_id": "campaign-rejected-backfill-a09",
            "recipient_id": "recipient-rejected-backfill-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record],
            backfill_job_id: Some(job_id.clone()),
        },
    )
    .await;
    assert!(matches!(
        response.acknowledgements[0].status,
        AcknowledgementStatus::Rejected
    ));
    assert_eq!(
        response.acknowledgements[0].error_code.as_deref(),
        Some("scope_unavailable")
    );

    let job = sqlx::query(
        "SELECT job_status, scanned_count, accepted_count, rejected_count, remaining_count FROM analytics.analytics_backfill_job WHERE job_id = $1",
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(job.get::<String, _>("job_status"), "completed");
    assert_eq!(job.get::<i64, _>("scanned_count"), 1);
    assert_eq!(job.get::<i64, _>("accepted_count"), 0);
    assert_eq!(job.get::<i64, _>("rejected_count"), 1);
    assert_eq!(job.get::<Option<i64>, _>("remaining_count"), Some(0));

    let coverage = sqlx::query(
        "SELECT expected_count, included_count, excluded_count, coverage_state, complete_through FROM analytics.analytics_coverage_checkpoint WHERE backfill_job_id = $1",
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(coverage.get::<Option<i64>, _>("expected_count"), Some(1));
    assert_eq!(coverage.get::<i64, _>("included_count"), 0);
    assert_eq!(coverage.get::<i64, _>("excluded_count"), 1);
    assert_eq!(coverage.get::<String, _>("coverage_state"), "partial");
    assert!(coverage
        .get::<Option<chrono::DateTime<Utc>>, _>("complete_through")
        .is_none());
}

#[tokio::test]
async fn structurally_invalid_source_backfill_record_is_safely_quarantined_and_counted() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_external_id = format!("a09-structural-backfill-org-{suffix}");
    let stream = format!("core:structural-backfill:{suffix}");
    let job_id = format!("a09-structural-source-reconstruction-{suffix}");
    let range_start = "2026-08-22T11:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let range_end = "2026-08-22T13:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(&scope_external_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',
                     'source_reconstruction','running',1,'test','analytics-postgres-test',$5,NOW())"#,
    )
    .bind(&job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(format!("grant-{job_id}"))
    .execute(&pool)
    .await
    .unwrap();

    let mut record = event_record(
        &stream,
        "structurally-invalid-record",
        0,
        &scope_external_id,
        json!({
            "campaign_id": "campaign-structural-backfill-a09",
            "recipient_id": "recipient-structural-backfill-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    record.source_stream_key = String::new();
    record.record_id = String::new();
    record.contract_name = String::new();
    record.schema_version = 0;
    let response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![record],
            backfill_job_id: Some(job_id.clone()),
        },
    )
    .await;
    assert!(matches!(
        response.acknowledgements[0].status,
        AcknowledgementStatus::Rejected
    ));
    assert_eq!(
        response.acknowledgements[0].error_code.as_deref(),
        Some("invalid_record_identity")
    );

    let job = sqlx::query(
        "SELECT job_status, scanned_count, accepted_count, rejected_count, remaining_count FROM analytics.analytics_backfill_job WHERE job_id = $1",
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(job.get::<String, _>("job_status"), "completed");
    assert_eq!(job.get::<i64, _>("scanned_count"), 1);
    assert_eq!(job.get::<i64, _>("accepted_count"), 0);
    assert_eq!(job.get::<i64, _>("rejected_count"), 1);
    assert_eq!(job.get::<Option<i64>, _>("remaining_count"), Some(0));

    let failure = sqlx::query(
        "SELECT source_domain, source_stream_key, source_sequence, record_identity, schema_version, payload_hash FROM analytics.analytics_ingestion_failure WHERE producer_id = $1 AND safe_error_code = 'invalid_record_identity' AND source_stream_key LIKE 'invalid:%' ORDER BY failure_id DESC LIMIT 1",
    )
    .bind(&authenticated.producer_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(failure.get::<String, _>("source_domain"), "campaigns");
    assert!(failure
        .get::<String, _>("source_stream_key")
        .starts_with("invalid:"));
    assert_eq!(failure.get::<Option<i64>, _>("source_sequence"), Some(0));
    assert!(failure
        .get::<String, _>("record_identity")
        .starts_with("invalid:"));
    assert!(failure.get::<Option<i32>, _>("schema_version").is_none());
    assert!(failure.get::<Option<String>, _>("payload_hash").is_some());

    let coverage = sqlx::query(
        "SELECT included_count, excluded_count, coverage_state, complete_through FROM analytics.analytics_coverage_checkpoint WHERE backfill_job_id = $1",
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(coverage.get::<i64, _>("included_count"), 0);
    assert_eq!(coverage.get::<i64, _>("excluded_count"), 1);
    assert_eq!(coverage.get::<String, _>("coverage_state"), "partial");
    assert!(coverage
        .get::<Option<chrono::DateTime<Utc>>, _>("complete_through")
        .is_none());

    let mismatch_job_id = format!("a09-structural-mismatch-{suffix}");
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, method,
             job_status, remaining_count, requesting_actor_type, requesting_actor_id,
             authorization_grant_id, started_at
           ) VALUES ($1,'core','campaigns',$2,$2,$3,$4,'campaign.recipient.sent@1',
                     'source_reconstruction','running',1,'test','analytics-postgres-test',$5,NOW())"#,
    )
    .bind(&mismatch_job_id)
    .bind(scope_id)
    .bind(range_start)
    .bind(range_end)
    .bind(format!("grant-{mismatch_job_id}"))
    .execute(&pool)
    .await
    .unwrap();
    let mut mismatched_record = event_record(
        &stream,
        "producer-mismatch-record",
        0,
        &scope_external_id,
        json!({
            "campaign_id": "campaign-structural-backfill-a09",
            "recipient_id": "recipient-producer-mismatch-a09",
            "channel": "whatsapp",
            "occurred_at": "2026-08-22T12:00:00Z",
            "status": "sent"
        }),
    );
    mismatched_record.producer_id = "another-producer".to_string();
    let mismatch_response = ingest_batch(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![mismatched_record],
            backfill_job_id: Some(mismatch_job_id.clone()),
        },
    )
    .await;
    assert_eq!(
        mismatch_response.acknowledgements[0].error_code.as_deref(),
        Some("producer_not_authorized")
    );
    let mismatch_job = sqlx::query(
        "SELECT job_status, scanned_count, rejected_count FROM analytics.analytics_backfill_job WHERE job_id = $1",
    )
    .bind(&mismatch_job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mismatch_job.get::<String, _>("job_status"), "running");
    assert_eq!(mismatch_job.get::<i64, _>("scanned_count"), 0);
    assert_eq!(mismatch_job.get::<i64, _>("rejected_count"), 0);
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
