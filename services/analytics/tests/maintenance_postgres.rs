use std::{env, fs};

use chrono::{Duration, Utc};
use kasitek_analytics::{
    ingestion::{
        ingest_batch_with_repair, AcknowledgementStatus, AuthenticatedProducer,
        IngestionBatchRequest, IngestionRecord, RepairContext,
    },
    maintenance::{
        claim_quarantine_release_work, claim_reconciliation_work, run_once, schedule_work,
    },
    projections,
    reconciliation::{reconcile_stream, ReconciliationRequest},
    records::{canonical_payload_sha256, RecordCategory},
    registry::load_registry,
};
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

async fn pool() -> Option<PgPool> {
    let url = database_url()?;
    PgPoolOptions::new()
        .max_connections(6)
        .connect(&url)
        .await
        .ok()
}

#[tokio::test]
async fn schedules_claims_and_completes_maintenance_work() {
    let Some(pool) = pool().await else { return };
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let authenticated = AuthenticatedProducer {
        source_service: "core".to_string(),
        producer_id: "core-customer-analytics".to_string(),
    };
    let stream = format!("maintenance:{suffix}");
    let work_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_reconciliation_work (
             producer_id, source_service, source_domain, source_stream_key,
             schedule_key, reason, priority
           ) VALUES ($1,$2,'maintenance',$3,$4,'manual',1)
           RETURNING work_id"#,
    )
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .bind(&stream)
    .bind(format!("maintenance:{suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();

    schedule_work(&pool).await.unwrap();
    let reconciliation_work = claim_reconciliation_work(&pool, &authenticated, 60)
        .await
        .unwrap()
        .expect("reconciliation work");
    assert_eq!(reconciliation_work.work_id, work_id);
    assert_eq!(reconciliation_work.source_stream_key, stream);

    let reconciliation = reconcile_stream(
        &pool,
        &authenticated,
        ReconciliationRequest {
            reconciliation_run_id: format!("maintenance-reconciliation-{suffix}"),
            reconciliation_work_id: Some(work_id),
            producer_id: authenticated.producer_id.clone(),
            source_domain: "maintenance".to_string(),
            source_stream_key: reconciliation_work.source_stream_key.clone(),
            scope_kind: None,
            scope_external_id: None,
            source_highest_outbox_sequence: Some(0),
            source_highest_delivered_sequence: Some(0),
            authoritative_count: Some(0),
            authoritative_checksum: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(reconciliation.reconciliation_status, "complete");
    let reconciliation_status: String = sqlx::query_scalar(
        "SELECT work_status FROM analytics.analytics_reconciliation_work WHERE work_id = $1",
    )
    .bind(work_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reconciliation_status, "completed");

    let failure_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_ingestion_failure (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             record_category, record_identity, schema_version, payload_hash, failure_class,
             safe_error_code, safe_error_summary, quarantine_status
           ) VALUES ($1,$2,'maintenance',$3,1,'event',$4,1,NULL,'permanent',
                     'contract_invalid','repair required','quarantined')
           RETURNING failure_id"#,
    )
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .bind(&reconciliation_work.source_stream_key)
    .bind(format!("failed-record-{suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    schedule_work(&pool).await.unwrap();
    let mut quarantine_work = None;
    for _ in 0..32 {
        let Some(candidate) = claim_quarantine_release_work(&pool, &authenticated, 60)
            .await
            .unwrap()
        else {
            break;
        };
        if candidate.failure_id == failure_id {
            quarantine_work = Some(candidate);
            break;
        }
    }
    let quarantine_work = quarantine_work.expect("quarantine work");
    assert_eq!(quarantine_work.failure_id, failure_id);
    assert_eq!(quarantine_work.safe_error_code, "contract_invalid");
    assert_eq!(quarantine_work.record_category, "event");

    let scope_external_id = format!("maintenance-scope-{suffix}");
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

    let repair_stream = format!("maintenance-repair:{suffix}");
    let repair_record_id = format!("repair-record-{suffix}");
    let repair_data = serde_json::json!({
        "campaign_id": "maintenance-campaign",
        "recipient_id": "maintenance-recipient",
        "channel": "whatsapp",
        "occurred_at": "2026-08-22T12:00:00Z",
        "status": "sent"
    });
    let repair_record = IngestionRecord {
        producer_id: authenticated.producer_id.clone(),
        source_stream_key: repair_stream.clone(),
        source_sequence: 7,
        record_category: RecordCategory::Event,
        record_id: repair_record_id.clone(),
        contract_name: "campaign.recipient.sent@1".to_string(),
        schema_version: 1,
        scope_kind: "core_organization".to_string(),
        scope_external_id: scope_external_id.clone(),
        payload_hash: canonical_payload_sha256(&repair_data).unwrap(),
        envelope: serde_json::json!({
            "specversion": "1.0",
            "id": format!("00000000-0000-4000-8000-{suffix:012}"),
            "source": "kasitek://core",
            "type": "campaign.recipient.sent@1",
            "subject": format!("recipient:{repair_record_id}"),
            "time": "2026-08-22T12:00:00Z",
            "datacontenttype": "application/json",
            "dataschema": "https://kasitek.co.za/analytics/contracts/events/campaign/recipient_sent/v1.schema.json",
            "source_service": "core",
            "source_domain": "campaigns",
            "record_category": "event",
            "scope_kind": "core_organization",
            "scope_external_id": scope_external_id,
            "idempotency_key": format!("maintenance:{repair_record_id}"),
            "data": repair_data,
        }),
    };
    let repair_failure_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_ingestion_failure (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             record_category, record_identity, reporting_scope_id, root_scope_id, schema_version,
             payload_hash, failure_class, safe_error_code, safe_error_summary, quarantine_status
           ) VALUES ($1,$2,'campaigns',$3,7,'event',$4,$5,$5,1,NULL,'permanent',
                     'contract_invalid','repair required','quarantined')
           RETURNING failure_id"#,
    )
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .bind(&repair_stream)
    .bind(&repair_record_id)
    .bind(scope_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    schedule_work(&pool).await.unwrap();
    let mut repair_work_id = None;
    for _ in 0..32 {
        let Some(candidate) = claim_quarantine_release_work(&pool, &authenticated, 60)
            .await
            .unwrap()
        else {
            break;
        };
        if candidate.failure_id == repair_failure_id {
            repair_work_id = Some(candidate.work_id);
            break;
        }
    }
    let repair_work_id = repair_work_id.expect("repair quarantine work");
    let repaired = ingest_batch_with_repair(
        &pool,
        &authenticated,
        IngestionBatchRequest {
            records: vec![repair_record],
            backfill_job_id: None,
        },
        Some(RepairContext {
            failure_id: repair_failure_id,
            transform_version: "campaign-recipient-sent-v1".to_string(),
        }),
    )
    .await;
    assert!(matches!(
        repaired.acknowledgements[0].status,
        AcknowledgementStatus::Accepted
    ));
    let release_state = sqlx::query(
        r#"SELECT failure.quarantine_status, failure.repair_transform_version,
                  work.work_status
           FROM analytics.analytics_ingestion_failure AS failure
           JOIN analytics.analytics_quarantine_release_work AS work
             ON work.failure_id = failure.failure_id
           WHERE failure.failure_id = $1 AND work.work_id = $2"#,
    )
    .bind(repair_failure_id)
    .bind(repair_work_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        release_state.get::<String, _>("quarantine_status"),
        "released"
    );
    assert_eq!(
        release_state.get::<String, _>("repair_transform_version"),
        "campaign-recipient-sent-v1"
    );
    assert_eq!(release_state.get::<String, _>("work_status"), "released");

    let mismatch = reconcile_stream(
        &pool,
        &authenticated,
        ReconciliationRequest {
            reconciliation_run_id: format!("maintenance-mismatch-{suffix}"),
            reconciliation_work_id: None,
            producer_id: authenticated.producer_id.clone(),
            source_domain: "campaigns".to_string(),
            source_stream_key: repair_stream.clone(),
            scope_kind: Some("core_organization".to_string()),
            scope_external_id: Some(scope_external_id.clone()),
            source_highest_outbox_sequence: Some(7),
            source_highest_delivered_sequence: Some(7),
            authoritative_count: Some(0),
            authoritative_checksum: None,
        },
    )
    .await
    .expect("mismatch reconciliation");
    assert_eq!(mismatch.reconciliation_status, "mismatch");
    let repair_reason: String = sqlx::query_scalar(
        r#"SELECT repair_reason
           FROM analytics.analytics_projection_work
           WHERE reporting_scope_id = $1 AND fact_kind = 'event'
             AND repair_reason = 'reconciliation_mismatch'
           ORDER BY work_id DESC
           LIMIT 1"#,
    )
    .bind(scope_id)
    .fetch_one(&pool)
    .await
    .expect("reconciliation projection repair");
    assert_eq!(repair_reason, "reconciliation_mismatch");

    let backfill_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(format!("maintenance-backfill-scope-{suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let job_id = format!("maintenance-backfill-{suffix}");
    let range_start = Utc::now() - Duration::hours(1);
    let range_end = Utc::now() + Duration::hours(1);
    sqlx::query(
        r#"INSERT INTO analytics.analytics_backfill_job (
             job_id, source_service, source_domain, reporting_scope_id, root_scope_id,
             requested_range_start, requested_range_end, contract_version, projection_version,
             method, job_status, requesting_actor_type, requesting_actor_id, authorization_grant_id
           ) VALUES ($1,'core','maintenance',$2,$2,$3,$4,'maintenance@1','1',
                     'projection_rebuild','queued','test','maintenance-test','grant-test')"#,
    )
    .bind(&job_id)
    .bind(backfill_scope_id)
    .bind(range_start)
    .bind(range_end)
    .execute(&pool)
    .await
    .unwrap();

    let registry = load_registry().unwrap();
    let mut completed = false;
    for _ in 0..5 {
        run_once(&pool, &registry, "maintenance-test", 60)
            .await
            .unwrap();
        let _ = projections::process_once(&pool, &registry, "maintenance-test", 60)
            .await
            .unwrap();
        let status: String = sqlx::query_scalar(
            "SELECT job_status FROM analytics.analytics_backfill_job WHERE job_id = $1",
        )
        .bind(&job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        if status == "completed" {
            completed = true;
            break;
        }
    }
    assert!(completed);
    let job = sqlx::query(
        "SELECT job_status, checkpoint FROM analytics.analytics_backfill_job WHERE job_id = $1",
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(job.get::<String, _>("job_status"), "completed");
    assert!(job
        .get::<serde_json::Value, _>("checkpoint")
        .get("generation_id")
        .and_then(|value| value.as_i64())
        .is_some());
}
