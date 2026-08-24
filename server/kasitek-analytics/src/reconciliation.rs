//! Authenticated producer summaries used to reconcile source outboxes with Analytics.
//!
//! Analytics never connects to a producer database. A producer supplies its authoritative
//! outbox/delivery summary through this endpoint, and Analytics compares it with its own cursor,
//! immutable receipts, quarantine, and fact counts.

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Postgres, Row, Transaction};

use crate::{
    ingestion::{resolve_scope, AuthenticatedProducer, IngestionAuthenticator},
    projections,
    records::validate_sha256_hex,
};

pub const RECONCILIATION_PATH: &str = "/internal/reconciliation/v1/summary";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconciliationRequest {
    pub reconciliation_run_id: String,
    #[serde(default)]
    pub reconciliation_work_id: Option<i64>,
    pub producer_id: String,
    pub source_domain: String,
    pub source_stream_key: String,
    #[serde(default)]
    pub scope_kind: Option<String>,
    #[serde(default)]
    pub scope_external_id: Option<String>,
    #[serde(default)]
    pub source_highest_outbox_sequence: Option<i64>,
    #[serde(default)]
    pub source_highest_delivered_sequence: Option<i64>,
    #[serde(default)]
    pub authoritative_count: Option<i64>,
    #[serde(default)]
    pub authoritative_checksum: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReconciliationResponse {
    pub reconciliation_run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation_work_id: Option<i64>,
    pub reconciliation_status: String,
    pub analytics_highest_received_sequence: i64,
    pub analytics_highest_contiguous_sequence: i64,
    pub missing_sequence_ranges: serde_json::Value,
    pub unresolved_quarantine_count: i64,
    pub analytics_count: i64,
}

#[derive(Debug)]
pub enum ReconciliationError {
    BadRequest(&'static str),
    Unavailable,
}

pub async fn handler(
    request: HttpRequest,
    body: web::Json<ReconciliationRequest>,
    pool: web::Data<PgPool>,
    authenticator: web::Data<IngestionAuthenticator>,
) -> impl Responder {
    let authenticated = match authenticator.authenticate(&request) {
        Ok(authenticated) => authenticated,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
                .finish()
        }
    };
    match reconcile_stream(pool.get_ref(), &authenticated, body.into_inner()).await {
        Ok(response) => HttpResponse::Ok().json(response),
        Err(ReconciliationError::BadRequest(code)) => {
            HttpResponse::BadRequest().json(json!({ "error": code }))
        }
        Err(ReconciliationError::Unavailable) => {
            HttpResponse::ServiceUnavailable().json(json!({ "error": "analytics_unavailable" }))
        }
    }
}

pub async fn reconcile_stream(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    request: ReconciliationRequest,
) -> Result<ReconciliationResponse, ReconciliationError> {
    if request.producer_id != authenticated.producer_id
        || request.reconciliation_run_id.trim().is_empty()
        || request
            .reconciliation_work_id
            .is_some_and(|value| value <= 0)
        || request.source_domain.trim().is_empty()
        || request.source_stream_key.trim().is_empty()
        || request
            .source_highest_outbox_sequence
            .is_some_and(|value| value < 0)
        || request
            .source_highest_delivered_sequence
            .is_some_and(|value| value < 0)
        || request.authoritative_count.is_some_and(|value| value < 0)
    {
        return Err(ReconciliationError::BadRequest(
            "invalid_reconciliation_request",
        ));
    }
    if let Some(checksum) = request.authoritative_checksum.as_deref() {
        validate_sha256_hex(checksum)
            .map_err(|_| ReconciliationError::BadRequest("invalid_authoritative_checksum"))?;
    }
    if request.scope_kind.is_some() != request.scope_external_id.is_some() {
        return Err(ReconciliationError::BadRequest("incomplete_scope_binding"));
    }

    let mut transaction = pool
        .begin()
        .await
        .map_err(|_| ReconciliationError::Unavailable)?;
    let producer = sqlx::query(
        r#"SELECT identity.source_service, producer.active
           FROM analytics.producer AS producer
           JOIN analytics.service_identity AS identity
             ON identity.service_identity_id = producer.service_identity_id
           WHERE producer.producer_id = $1 AND identity.status = 'active'"#,
    )
    .bind(&request.producer_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ReconciliationError::Unavailable)?
    .ok_or(ReconciliationError::BadRequest("producer_not_registered"))?;
    let producer_source_service: String = producer.get("source_service");
    let producer_active: bool = producer.get("active");
    if !producer_active || producer_source_service != authenticated.source_service {
        return Err(ReconciliationError::BadRequest("producer_not_authorized"));
    }

    if let Some(work_id) = request.reconciliation_work_id {
        let work_authorized: bool = sqlx::query_scalar(
            r#"SELECT EXISTS (
                 SELECT 1
                 FROM analytics.analytics_reconciliation_work
                 WHERE work_id = $1 AND producer_id = $2 AND source_service = $3
                   AND source_stream_key = $4 AND work_status = 'leased'
                   AND lease_owner = $2 AND lease_expires_at > NOW()
               )"#,
        )
        .bind(work_id)
        .bind(&request.producer_id)
        .bind(&authenticated.source_service)
        .bind(&request.source_stream_key)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ReconciliationError::Unavailable)?;
        if !work_authorized {
            return Err(ReconciliationError::BadRequest(
                "reconciliation_work_not_authorized",
            ));
        }
    }

    let binding = match (&request.scope_kind, &request.scope_external_id) {
        (Some(scope_kind), Some(scope_external_id)) => Some(
            resolve_scope(
                &mut transaction,
                authenticated,
                scope_kind,
                scope_external_id,
            )
            .await
            .map_err(|failure| ReconciliationError::BadRequest(failure.code))?
            .binding,
        ),
        _ => None,
    };
    let cursor = sqlx::query(
        r#"SELECT highest_received_sequence, highest_contiguous_sequence, known_gap_ranges
           FROM analytics.analytics_source_cursor
           WHERE producer_id = $1 AND source_stream_key = $2
           FOR UPDATE"#,
    )
    .bind(&request.producer_id)
    .bind(&request.source_stream_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ReconciliationError::Unavailable)?;
    let (analytics_received, analytics_contiguous, mut missing_ranges) = cursor
        .map(|row| {
            (
                row.get::<i64, _>("highest_received_sequence"),
                row.get::<i64, _>("highest_contiguous_sequence"),
                row.get::<serde_json::Value, _>("known_gap_ranges"),
            )
        })
        .unwrap_or((0, 0, json!([])));
    append_tail_gap(
        &mut missing_ranges,
        analytics_received,
        request.source_highest_delivered_sequence,
    );

    let analytics_count = count_stream_facts(&mut transaction, &request)
        .await
        .map_err(|_| ReconciliationError::Unavailable)?;
    let unresolved_quarantine_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM analytics.analytics_ingestion_failure
           WHERE producer_id = $1 AND source_stream_key = $2 AND quarantine_status = 'quarantined'"#,
    )
    .bind(&request.producer_id)
    .bind(&request.source_stream_key)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ReconciliationError::Unavailable)?;
    let count_mismatch = request
        .authoritative_count
        .is_some_and(|authoritative| authoritative != analytics_count);
    let has_gap = missing_ranges
        .as_array()
        .is_some_and(|ranges| !ranges.is_empty());
    let reconciliation_status = if count_mismatch || has_gap || unresolved_quarantine_count > 0 {
        "mismatch"
    } else {
        "complete"
    };
    let safe_failure_code = if count_mismatch {
        Some("authoritative_count_mismatch")
    } else if has_gap {
        Some("source_sequence_gap")
    } else if unresolved_quarantine_count > 0 {
        Some("unresolved_quarantine")
    } else {
        None
    };
    let now = chrono::Utc::now();
    let run_inserted = sqlx::query(
        r#"INSERT INTO analytics.analytics_reconciliation_run (
             reconciliation_run_id, producer_id, source_service, source_domain, source_stream_key,
             reporting_scope_id, root_scope_id, source_highest_outbox_sequence,
             source_highest_delivered_sequence, analytics_highest_received_sequence,
             analytics_highest_contiguous_sequence, missing_sequence_ranges,
             unresolved_quarantine_count, authoritative_count, analytics_count,
             authoritative_checksum, reconciliation_status, safe_failure_code,
             started_at, completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
           ON CONFLICT (reconciliation_run_id) DO NOTHING"#,
    )
    .bind(&request.reconciliation_run_id)
    .bind(&request.producer_id)
    .bind(&authenticated.source_service)
    .bind(&request.source_domain)
    .bind(&request.source_stream_key)
    .bind(binding.as_ref().map(|binding| binding.reporting_scope_id))
    .bind(binding.as_ref().map(|binding| binding.root_scope_id))
    .bind(request.source_highest_outbox_sequence)
    .bind(request.source_highest_delivered_sequence)
    .bind(analytics_received)
    .bind(analytics_contiguous)
    .bind(&missing_ranges)
    .bind(unresolved_quarantine_count)
    .bind(request.authoritative_count)
    .bind(analytics_count)
    .bind(request.authoritative_checksum.as_deref())
    .bind(reconciliation_status)
    .bind(safe_failure_code)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ReconciliationError::Unavailable)?;
    if run_inserted.rows_affected() > 0 {
        if let (Some(binding), Some(window)) = (
            binding.as_ref(),
            reconciliation_fact_window(&mut transaction, &request)
                .await
                .map_err(|_| ReconciliationError::Unavailable)?,
        ) {
            insert_reconciliation_coverage_checkpoint(
                &mut transaction,
                ReconciliationCoverageInput {
                    request: &request,
                    authenticated,
                    binding,
                    window: &window,
                    reconciliation_status,
                    analytics_count,
                    observed_at: now,
                },
            )
            .await
            .map_err(|_| ReconciliationError::Unavailable)?;
        }
    }
    sqlx::query(
        "UPDATE analytics.analytics_source_cursor SET latest_reconciliation_at = NOW() WHERE producer_id = $1 AND source_stream_key = $2",
    )
    .bind(&request.producer_id)
    .bind(&request.source_stream_key)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ReconciliationError::Unavailable)?;
    if let Some(work_id) = request.reconciliation_work_id {
        sqlx::query(
            r#"UPDATE analytics.analytics_reconciliation_work
               SET work_status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
                   completed_at = NOW(), last_error_code = $2
               WHERE work_id = $1 AND work_status = 'leased' AND lease_owner = $3"#,
        )
        .bind(work_id)
        .bind(safe_failure_code)
        .bind(&authenticated.producer_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ReconciliationError::Unavailable)?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| ReconciliationError::Unavailable)?;
    if reconciliation_status == "mismatch" {
        if let Some(binding) = binding.as_ref() {
            projections::enqueue_reconciliation_repair(
                pool,
                &request.producer_id,
                &request.source_stream_key,
                binding.reporting_scope_id,
                binding.root_scope_id,
            )
            .await
            .map_err(|_| ReconciliationError::Unavailable)?;
        }
    }
    Ok(ReconciliationResponse {
        reconciliation_run_id: request.reconciliation_run_id,
        reconciliation_work_id: request.reconciliation_work_id,
        reconciliation_status: reconciliation_status.to_string(),
        analytics_highest_received_sequence: analytics_received,
        analytics_highest_contiguous_sequence: analytics_contiguous,
        missing_sequence_ranges: missing_ranges,
        unresolved_quarantine_count,
        analytics_count,
    })
}

fn append_tail_gap(
    ranges: &mut serde_json::Value,
    analytics_received: i64,
    delivered: Option<i64>,
) {
    let Some(delivered) = delivered else { return };
    if delivered <= analytics_received {
        return;
    }
    let Some(ranges) = ranges.as_array_mut() else {
        return;
    };
    ranges.push(json!({
        "start": analytics_received + 1,
        "end": delivered
    }));
}

async fn count_stream_facts(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ReconciliationRequest,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM (
             SELECT storage_id FROM analytics.analytics_event
             WHERE producer_id = $1 AND source_stream_key = $2
             UNION ALL
             SELECT storage_id FROM analytics.analytics_metric_observation
             WHERE producer_id = $1 AND source_stream_key = $2
             UNION ALL
             SELECT storage_id FROM analytics.analytics_scope_definition_receipt
             WHERE producer_id = $1 AND source_stream_key = $2
             UNION ALL
             SELECT manifest_id FROM analytics.analytics_source_manifest
             WHERE producer_id = $1 AND source_stream_key = $2
           ) records"#,
    )
    .bind(&request.producer_id)
    .bind(&request.source_stream_key)
    .fetch_one(&mut **transaction)
    .await
}

struct ReconciliationFactWindow {
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
}

async fn reconciliation_fact_window(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ReconciliationRequest,
) -> Result<Option<ReconciliationFactWindow>, sqlx::Error> {
    let row = sqlx::query(
        r#"SELECT MIN(window_start) AS window_start, MAX(window_end) AS window_end
           FROM (
             SELECT occurred_at AS window_start,
                    occurred_at + INTERVAL '1 microsecond' AS window_end
             FROM analytics.analytics_event
             WHERE producer_id = $1 AND source_domain = $3 AND source_stream_key = $2
             UNION ALL
             SELECT reporting_window_start AS window_start,
                    reporting_window_end AS window_end
             FROM analytics.analytics_metric_observation
             WHERE producer_id = $1 AND source_domain = $3 AND source_stream_key = $2
           ) facts"#,
    )
    .bind(&request.producer_id)
    .bind(&request.source_stream_key)
    .bind(&request.source_domain)
    .fetch_one(&mut **transaction)
    .await?;
    let window_start = row.get::<Option<DateTime<Utc>>, _>("window_start");
    let window_end = row.get::<Option<DateTime<Utc>>, _>("window_end");
    Ok(match (window_start, window_end) {
        (Some(window_start), Some(window_end)) if window_end > window_start => {
            Some(ReconciliationFactWindow {
                window_start,
                window_end,
            })
        }
        _ => None,
    })
}

struct ReconciliationCoverageInput<'a> {
    request: &'a ReconciliationRequest,
    authenticated: &'a AuthenticatedProducer,
    binding: &'a crate::records::ScopeBinding,
    window: &'a ReconciliationFactWindow,
    reconciliation_status: &'a str,
    analytics_count: i64,
    observed_at: DateTime<Utc>,
}

async fn insert_reconciliation_coverage_checkpoint(
    transaction: &mut Transaction<'_, Postgres>,
    coverage: ReconciliationCoverageInput<'_>,
) -> Result<(), sqlx::Error> {
    let expected_count = coverage.request.authoritative_count;
    let included_count = expected_count
        .map(|expected| expected.min(coverage.analytics_count))
        .unwrap_or(coverage.analytics_count);
    let excluded_count = expected_count
        .map(|expected| expected.saturating_sub(coverage.analytics_count))
        .unwrap_or(0);
    let coverage_state = match coverage.reconciliation_status {
        "complete" => "available",
        "mismatch" => "partial",
        _ => "unknown",
    };
    let complete_through =
        (coverage.reconciliation_status == "complete").then_some(coverage.window.window_end);

    sqlx::query(
        r#"INSERT INTO analytics.analytics_coverage_checkpoint (
                producer_id, source_service, source_domain, reporting_scope_id, root_scope_id,
                coverage_layer, dimension_key, window_start, window_end,
                expected_count, included_count, excluded_count, coverage_state,
                complete_through, projection_version, source_manifest_id,
                reconciliation_run_id, observed_at
            ) VALUES ($1,$2,$3,$4,$5,'reconciliation',NULL,$6,$7,$8,$9,$10,$11,$12,NULL,NULL,$13,$14)"#,
    )
    .bind(&coverage.request.producer_id)
    .bind(&coverage.authenticated.source_service)
    .bind(&coverage.request.source_domain)
    .bind(coverage.binding.reporting_scope_id)
    .bind(coverage.binding.root_scope_id)
    .bind(coverage.window.window_start)
    .bind(coverage.window.window_end)
    .bind(expected_count)
    .bind(included_count)
    .bind(excluded_count)
    .bind(coverage_state)
    .bind(complete_through)
    .bind(&coverage.request.reconciliation_run_id)
    .bind(coverage.observed_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
