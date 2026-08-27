//! Authenticated source-outbox delivery to the standalone Analytics API.
//!
//! This module owns only transport orchestration. Domain code still writes the outbox inside its
//! transaction, and the source worker later claims rows, sends an at-least-once batch, and applies
//! each acknowledgement under the row lease. A transport or Analytics outage therefore leaves the
//! committed source fact pending for a later attempt.

use std::{collections::HashMap, time::Duration};

use chrono::{DateTime, Utc};
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    apply_delivery_outcome, claim_outbox_batch, release_expired_leases, DeliveryOutcome, OutboxRow,
    ProducerError, RetryPolicy, MAX_OUTBOX_BATCH_SIZE,
};

const INGESTION_PATH: &str = "/internal/ingest/v1/batch";
const RECONCILIATION_PATH: &str = "/internal/reconciliation/v1/summary";
pub const BACKFILL_WORK_PATH: &str = "/internal/backfill/v1/work";
pub const MAX_RECONCILIATION_STREAMS: i64 = 500;

#[derive(Clone)]
pub struct AnalyticsPublisherSettings {
    pub endpoint: String,
    pub token: String,
    pub producer_id: String,
    pub publisher_id: String,
    pub batch_size: i64,
    pub lease_duration: Duration,
    pub request_timeout: Duration,
    pub retry_policy: RetryPolicy,
}

impl AnalyticsPublisherSettings {
    pub fn validate(&self) -> Result<(), PublisherError> {
        if self.endpoint.trim().is_empty()
            || self.token.trim().is_empty()
            || self.producer_id.trim().is_empty()
            || self.publisher_id.trim().is_empty()
            || !(1..=MAX_OUTBOX_BATCH_SIZE).contains(&self.batch_size)
            || self.lease_duration.is_zero()
            || self.request_timeout.is_zero()
        {
            return Err(PublisherError::InvalidConfiguration);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct AnalyticsIngestionClient {
    client: reqwest::Client,
    endpoint: String,
    token: String,
}

impl AnalyticsIngestionClient {
    pub fn new(
        endpoint: impl Into<String>,
        token: impl Into<String>,
        request_timeout: Duration,
    ) -> Result<Self, PublisherError> {
        let endpoint = endpoint.into().trim_end_matches('/').to_string();
        let token = token.into();
        if endpoint.trim().is_empty() || token.trim().is_empty() || request_timeout.is_zero() {
            return Err(PublisherError::InvalidConfiguration);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(request_timeout)
            .build()
            .map_err(|_| PublisherError::ClientBuild)?;
        Ok(Self {
            client,
            endpoint,
            token,
        })
    }

    async fn send_batch(
        &self,
        producer_id: &str,
        rows: &[OutboxRow],
    ) -> Result<IngestionBatchResponse, TransportError> {
        let request = IngestionBatchRequest {
            records: rows
                .iter()
                .map(|row| IngestionRecord {
                    producer_id: producer_id.to_string(),
                    source_stream_key: row.source_stream_key.clone(),
                    source_sequence: row.source_sequence,
                    record_category: row.record_category.clone(),
                    record_id: row.record_id.clone(),
                    contract_name: row.contract_name.clone(),
                    schema_version: row.schema_version,
                    scope_kind: row.scope_kind.clone(),
                    scope_external_id: row.scope_external_id.clone(),
                    payload_hash: row.payload_hash.clone(),
                    envelope: row.envelope.clone(),
                })
                .collect(),
            backfill_job_id: None,
        };
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "ingest.batch",
            || async {
                let mut trace_headers = header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.client
                    .post(format!("{}{}", self.endpoint, INGESTION_PATH))
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .headers(trace_headers)
                    .json(&request)
                    .send()
                    .await
            },
        )
        .await
        .map_err(|_| TransportError::Retryable("analytics.transport_unavailable"))?;

        let status = response.status();
        if !status.is_success() {
            return Err(classify_http_status(status));
        }
        response
            .json::<IngestionBatchResponse>()
            .await
            .map_err(|_| TransportError::Retryable("analytics.invalid_response"))
    }

    async fn send_reconciliation(
        &self,
        request: &ReconciliationRequest,
    ) -> Result<ReconciliationResponse, PublisherError> {
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "reconciliation.summary",
            || async {
                let mut trace_headers = header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.client
                    .post(format!("{}{}", self.endpoint, RECONCILIATION_PATH))
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .headers(trace_headers)
                    .json(request)
                    .send()
                    .await
            },
        )
        .await
        .map_err(|_| {
            PublisherError::Reconciliation("analytics.transport_unavailable".to_string())
        })?;

        let status = response.status();
        if !status.is_success() {
            return Err(PublisherError::Reconciliation(
                match classify_http_status(status) {
                    TransportError::Retryable(code) => code.to_string(),
                    TransportError::Permanent(code) => code,
                },
            ));
        }
        response
            .json::<ReconciliationResponse>()
            .await
            .map_err(|_| PublisherError::Reconciliation("analytics.invalid_response".to_string()))
    }

    /// Claim source-owned historical reconstruction work from Analytics.
    ///
    /// The bearer credential identifies the producer and source service. No producer identity is
    /// accepted in the request body, so a source worker can only receive work authorized for its
    /// own source boundary.
    pub async fn claim_source_backfill_work(
        &self,
    ) -> Result<Option<SourceBackfillWork>, PublisherError> {
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "backfill.claim",
            || async {
                let mut trace_headers = header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.client
                    .get(format!("{}{}", self.endpoint, BACKFILL_WORK_PATH))
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .headers(trace_headers)
                    .send()
                    .await
            },
        )
        .await
        .map_err(|_| PublisherError::Backfill("analytics.transport_unavailable".to_string()))?;

        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let status = response.status();
        if !status.is_success() {
            return Err(PublisherError::Backfill(transport_error_code(
                classify_http_status(status),
            )));
        }
        response
            .json::<SourceBackfillWork>()
            .await
            .map(Some)
            .map_err(|_| PublisherError::Backfill("analytics.invalid_response".to_string()))
    }

    /// Send reconstructed source facts through the normal authenticated ingestion validator.
    ///
    /// Backfill records are explicitly tagged with the leased job. Analytics uses that tag to
    /// update job progress while keeping these records out of the live source sequence cursor.
    pub async fn send_backfill_batch(
        &self,
        producer_id: &str,
        job_id: &str,
        records: &[BackfillRecord],
    ) -> Result<BackfillBatchResponse, PublisherError> {
        if producer_id.trim().is_empty()
            || job_id.trim().is_empty()
            || records.is_empty()
            || records.len() > MAX_OUTBOX_BATCH_SIZE as usize
            || records.iter().any(|record| {
                record.source_sequence != backfill_source_sequence(&record.record.record_id)
            })
        {
            return Err(PublisherError::InvalidConfiguration);
        }

        let request = IngestionBatchRequest {
            records: records
                .iter()
                .map(|record| ingestion_record(producer_id, &record.record, record.source_sequence))
                .collect(),
            backfill_job_id: Some(job_id.to_string()),
        };
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "ingest.backfill",
            || async {
                let mut trace_headers = header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.client
                    .post(format!("{}{}", self.endpoint, INGESTION_PATH))
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .headers(trace_headers)
                    .json(&request)
                    .send()
                    .await
            },
        )
        .await
        .map_err(|_| PublisherError::Backfill("analytics.transport_unavailable".to_string()))?;

        let status = response.status();
        if !status.is_success() {
            return Err(PublisherError::Backfill(transport_error_code(
                classify_http_status(status),
            )));
        }
        let response = response
            .json::<BackfillBatchResponse>()
            .await
            .map_err(|_| PublisherError::Backfill("analytics.invalid_response".to_string()))?;
        validate_backfill_response(records, response)
    }
}

/// Return a stable positive sequence for a reconstructed record.
///
/// Live source sequences are allocated by the source outbox. Backfill records do not participate
/// in that cursor, so they use a deterministic record-identity namespace instead. This keeps a
/// retry, or a later overlapping backfill job, idempotent without reusing page-local sequences.
pub fn backfill_source_sequence(record_id: &str) -> i64 {
    let digest = Sha256::digest(format!("kasitek.analytics.backfill:{record_id}").as_bytes());
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    let sequence = u64::from_be_bytes(bytes) & i64::MAX as u64;
    i64::try_from(sequence.max(1)).expect("masked backfill sequence fits in i64")
}

#[derive(Debug, Error)]
pub enum PublisherError {
    #[error("invalid analytics publisher configuration")]
    InvalidConfiguration,
    #[error("analytics HTTP client could not be built")]
    ClientBuild,
    #[error("analytics reconciliation request failed: {0}")]
    Reconciliation(String),
    #[error("analytics source backfill request failed: {0}")]
    Backfill(String),
    #[error(transparent)]
    Producer(#[from] ProducerError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconciliationCursor {
    pub source_stream_key: String,
    pub source_domain: String,
    pub scope_kind: String,
    pub scope_external_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxReconciliationSummary {
    pub cursor: ReconciliationCursor,
    pub source_domain: String,
    pub source_stream_key: String,
    pub scope_kind: String,
    pub scope_external_id: String,
    pub source_highest_outbox_sequence: i64,
    pub source_highest_delivered_sequence: Option<i64>,
    pub authoritative_count: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReconciliationRequest {
    pub reconciliation_run_id: String,
    pub producer_id: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub scope_kind: String,
    pub scope_external_id: String,
    pub source_highest_outbox_sequence: i64,
    pub source_highest_delivered_sequence: Option<i64>,
    pub authoritative_count: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ReconciliationResponse {
    pub reconciliation_run_id: String,
    pub reconciliation_status: String,
    pub analytics_highest_received_sequence: i64,
    pub analytics_highest_contiguous_sequence: i64,
    pub missing_sequence_ranges: Value,
    pub unresolved_quarantine_count: i64,
    pub analytics_count: i64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReconciliationStats {
    pub attempted: usize,
    pub complete: usize,
    pub mismatched: usize,
    pub next_cursor: Option<ReconciliationCursor>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PublishStats {
    pub leases_released: u64,
    pub claimed: usize,
    pub delivered: usize,
    pub retryable: usize,
    pub quarantined: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceBackfillWork {
    pub job_id: String,
    pub source_service: String,
    pub source_domain: String,
    pub reporting_scope_id: i64,
    pub root_scope_id: i64,
    pub scope_external_id: String,
    pub requested_range_start: DateTime<Utc>,
    pub requested_range_end: DateTime<Utc>,
    pub contract_version: String,
    pub projection_version: Option<String>,
    pub method: String,
    pub job_status: String,
    pub checkpoint: Value,
    pub remaining_count: Option<i64>,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct BackfillRecord {
    pub source_sequence: i64,
    pub record: crate::AnalyticsOutboxRecord,
}

#[derive(Debug)]
enum TransportError {
    Retryable(&'static str),
    Permanent(String),
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct IngestionBatchRequest {
    records: Vec<IngestionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backfill_job_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct IngestionRecord {
    producer_id: String,
    source_stream_key: String,
    source_sequence: i64,
    record_category: String,
    record_id: String,
    contract_name: String,
    schema_version: i32,
    scope_kind: String,
    scope_external_id: String,
    payload_hash: String,
    envelope: Value,
}

#[derive(Debug, Deserialize)]
struct IngestionBatchResponse {
    #[allow(dead_code)]
    accepted_count: usize,
    #[allow(dead_code)]
    duplicate_count: usize,
    #[allow(dead_code)]
    rejected_count: usize,
    #[allow(dead_code)]
    retryable_count: usize,
    acknowledgements: Vec<IngestionAcknowledgement>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackfillBatchResponse {
    pub accepted_count: usize,
    pub duplicate_count: usize,
    pub rejected_count: usize,
    pub retryable_count: usize,
    pub acknowledgements: Vec<BackfillAcknowledgement>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackfillAcknowledgement {
    pub record_id: String,
    pub source_sequence: i64,
    pub status: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IngestionAcknowledgement {
    record_id: String,
    source_sequence: i64,
    status: String,
    error_code: Option<String>,
}

pub async fn publish_outbox_once(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    settings: &AnalyticsPublisherSettings,
    now: DateTime<Utc>,
) -> Result<PublishStats, PublisherError> {
    observability::result_span(
        "worker",
        "analytics_outbox.publish_batch",
        publish_outbox_once_inner(pool, client, settings, now),
    )
    .await
}

async fn publish_outbox_once_inner(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    settings: &AnalyticsPublisherSettings,
    now: DateTime<Utc>,
) -> Result<PublishStats, PublisherError> {
    settings.validate()?;
    let leases_released = release_expired_leases(pool, now, settings.batch_size).await?;
    let rows = claim_outbox_batch(
        pool,
        &settings.publisher_id,
        settings.batch_size,
        now,
        settings.lease_duration,
    )
    .await?;
    if rows.is_empty() {
        return Ok(PublishStats {
            leases_released,
            ..PublishStats::default()
        });
    }

    if let Some(oldest) = rows.iter().map(|row| row.created_at).min() {
        if let Ok(age) = now.signed_duration_since(oldest).to_std() {
            observability::record_queue_age("analytics.outbox", age);
        }
    }

    let outcomes = match client.send_batch(&settings.producer_id, &rows).await {
        Ok(response) => response_outcomes(&rows, response, now, settings.retry_policy),
        Err(error) => transport_outcomes(&rows, error, now, settings.retry_policy),
    };

    let mut stats = PublishStats {
        leases_released,
        claimed: rows.len(),
        ..PublishStats::default()
    };
    for (row, outcome) in rows.iter().zip(outcomes) {
        match &outcome {
            DeliveryOutcome::Accepted | DeliveryOutcome::Duplicate => stats.delivered += 1,
            DeliveryOutcome::Retryable { .. } => stats.retryable += 1,
            DeliveryOutcome::Quarantined { .. } => stats.quarantined += 1,
        }
        apply_delivery_outcome(pool, &row.outbox_id, &settings.publisher_id, outcome).await?;
    }
    if stats.retryable > 0 {
        observability::record_retry(
            "worker",
            "analytics_outbox.delivery",
            stats.retryable as u64,
        );
    }
    Ok(stats)
}

/// Reconcile a bounded set of source streams without transferring envelopes or payloads.
///
/// The source outbox is authoritative for transport counts and sequence watermarks. Analytics
/// owns the comparison and repair decision; producers only publish the summary for each stream.
pub async fn reconcile_outbox_once(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    producer_id: &str,
    source_service: &str,
    after: Option<&ReconciliationCursor>,
    max_streams: i64,
) -> Result<ReconciliationStats, PublisherError> {
    observability::result_span(
        "worker",
        "analytics_outbox.reconcile",
        reconcile_outbox_once_inner(
            pool,
            client,
            producer_id,
            source_service,
            after,
            max_streams,
        ),
    )
    .await
}

async fn reconcile_outbox_once_inner(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    producer_id: &str,
    source_service: &str,
    after: Option<&ReconciliationCursor>,
    max_streams: i64,
) -> Result<ReconciliationStats, PublisherError> {
    if producer_id.trim().is_empty()
        || source_service.trim().is_empty()
        || !(1..=MAX_RECONCILIATION_STREAMS).contains(&max_streams)
    {
        return Err(PublisherError::InvalidConfiguration);
    }

    let summaries =
        list_outbox_reconciliation_summaries(pool, source_service, after, max_streams).await?;
    let mut stats = ReconciliationStats::default();
    for summary in summaries {
        let request = ReconciliationRequest {
            reconciliation_run_id: Uuid::new_v4().to_string(),
            producer_id: producer_id.to_string(),
            source_domain: summary.source_domain,
            source_stream_key: summary.source_stream_key,
            scope_kind: summary.scope_kind,
            scope_external_id: summary.scope_external_id,
            source_highest_outbox_sequence: summary.source_highest_outbox_sequence,
            source_highest_delivered_sequence: summary.source_highest_delivered_sequence,
            authoritative_count: summary.authoritative_count,
        };
        let response = client.send_reconciliation(&request).await?;
        stats.attempted += 1;
        if response.reconciliation_status == "mismatch" {
            stats.mismatched += 1;
        } else {
            stats.complete += 1;
        }
        stats.next_cursor = Some(summary.cursor);
    }
    Ok(stats)
}

pub async fn list_outbox_reconciliation_summaries(
    pool: &PgPool,
    source_service: &str,
    after: Option<&ReconciliationCursor>,
    max_streams: i64,
) -> Result<Vec<OutboxReconciliationSummary>, PublisherError> {
    if source_service.trim().is_empty() || !(1..=MAX_RECONCILIATION_STREAMS).contains(&max_streams)
    {
        return Err(PublisherError::InvalidConfiguration);
    }
    let rows = sqlx::query(
        r#"SELECT source_domain,
                  source_stream_key,
                  scope_kind,
                  scope_external_id,
                  MAX(source_sequence) AS source_highest_outbox_sequence,
                  MAX(source_sequence) FILTER (WHERE delivery_status = 'delivered')
                    AS source_highest_delivered_sequence,
                  COUNT(*)::bigint AS authoritative_count
           FROM analytics_outbox
           WHERE source_service = $1
           GROUP BY source_domain, source_stream_key, scope_kind, scope_external_id
           ORDER BY (
               $2::text IS NULL OR
               (source_stream_key, source_domain, scope_kind, scope_external_id) >
               ($2::text, $3::text, $4::text, $5::text)
           ) DESC,
           source_stream_key, source_domain, scope_kind, scope_external_id
           LIMIT $6"#,
    )
    .bind(source_service)
    .bind(after.map(|cursor| cursor.source_stream_key.as_str()))
    .bind(after.map(|cursor| cursor.source_domain.as_str()))
    .bind(after.map(|cursor| cursor.scope_kind.as_str()))
    .bind(after.map(|cursor| cursor.scope_external_id.as_str()))
    .bind(max_streams)
    .fetch_all(pool)
    .await
    .map_err(|error| PublisherError::Producer(error.into()))?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let source_stream_key: String = row.get("source_stream_key");
            let source_domain: String = row.get("source_domain");
            let scope_kind: String = row.get("scope_kind");
            let scope_external_id: String = row.get("scope_external_id");
            OutboxReconciliationSummary {
                cursor: ReconciliationCursor {
                    source_stream_key: source_stream_key.clone(),
                    source_domain: source_domain.clone(),
                    scope_kind: scope_kind.clone(),
                    scope_external_id: scope_external_id.clone(),
                },
                source_domain,
                source_stream_key,
                scope_kind,
                scope_external_id,
                source_highest_outbox_sequence: row.get("source_highest_outbox_sequence"),
                source_highest_delivered_sequence: row.get("source_highest_delivered_sequence"),
                authoritative_count: row.get("authoritative_count"),
            }
        })
        .collect())
}

fn response_outcomes(
    rows: &[OutboxRow],
    response: IngestionBatchResponse,
    now: DateTime<Utc>,
    retry_policy: RetryPolicy,
) -> Vec<DeliveryOutcome> {
    let mut acknowledgements = HashMap::with_capacity(response.acknowledgements.len());
    let mut valid = response.acknowledgements.len() == rows.len();
    for acknowledgement in response.acknowledgements {
        if acknowledgements
            .insert(acknowledgement.source_sequence, acknowledgement)
            .is_some()
        {
            valid = false;
        }
    }
    if !valid {
        return rows
            .iter()
            .map(|row| retry_for(row, now, retry_policy, "analytics.invalid_acknowledgement"))
            .collect();
    }

    rows.iter()
        .map(|row| {
            let Some(acknowledgement) = acknowledgements.remove(&row.source_sequence) else {
                return retry_for(row, now, retry_policy, "analytics.missing_acknowledgement");
            };
            if acknowledgement.record_id != row.record_id {
                return retry_for(row, now, retry_policy, "analytics.acknowledgement_mismatch");
            }
            match acknowledgement.status.as_str() {
                "accepted" => DeliveryOutcome::Accepted,
                "duplicate" => DeliveryOutcome::Duplicate,
                "retryable" => retry_for(
                    row,
                    now,
                    retry_policy,
                    &safe_error_code(
                        acknowledgement.error_code.as_deref(),
                        "analytics.retryable_rejection",
                    ),
                ),
                "rejected" => DeliveryOutcome::Quarantined {
                    error_code: safe_error_code(
                        acknowledgement.error_code.as_deref(),
                        "analytics.rejected",
                    ),
                },
                _ => retry_for(row, now, retry_policy, "analytics.invalid_acknowledgement"),
            }
        })
        .collect()
}

fn transport_outcomes(
    rows: &[OutboxRow],
    error: TransportError,
    now: DateTime<Utc>,
    retry_policy: RetryPolicy,
) -> Vec<DeliveryOutcome> {
    match error {
        TransportError::Retryable(code) => rows
            .iter()
            .map(|row| retry_for(row, now, retry_policy, code))
            .collect(),
        TransportError::Permanent(code) => rows
            .iter()
            .map(|_| DeliveryOutcome::Quarantined {
                error_code: safe_error_code(Some(&code), "analytics.http_rejected"),
            })
            .collect(),
    }
}

fn retry_for(
    row: &OutboxRow,
    now: DateTime<Utc>,
    retry_policy: RetryPolicy,
    error_code: &str,
) -> DeliveryOutcome {
    DeliveryOutcome::Retryable {
        error_code: safe_error_code(Some(error_code), "analytics.retryable"),
        retry_at: retry_policy.next_retry_at(now, row.attempt_count, &row.outbox_id),
    }
}

fn safe_error_code(value: Option<&str>, fallback: &str) -> String {
    let value = value.unwrap_or(fallback);
    if value.len() <= 128
        && !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn classify_http_status(status: StatusCode) -> TransportError {
    if status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
        || status == StatusCode::UNAUTHORIZED
        || status == StatusCode::FORBIDDEN
    {
        return TransportError::Retryable("analytics.http_unavailable");
    }
    TransportError::Permanent(format!("analytics.http_{}", status.as_u16()))
}

fn transport_error_code(error: TransportError) -> String {
    match error {
        TransportError::Retryable(code) => code.to_string(),
        TransportError::Permanent(code) => code,
    }
}

fn ingestion_record(
    producer_id: &str,
    record: &crate::AnalyticsOutboxRecord,
    source_sequence: i64,
) -> IngestionRecord {
    IngestionRecord {
        producer_id: producer_id.to_string(),
        source_stream_key: record.source_stream_key.clone(),
        source_sequence,
        record_category: record.record_category.as_str().to_string(),
        record_id: record.record_id.clone(),
        contract_name: record.contract_name.clone(),
        schema_version: record.schema_version,
        scope_kind: record.scope_kind.as_str().to_string(),
        scope_external_id: record.scope_external_id.clone(),
        payload_hash: record.payload_hash.clone(),
        envelope: record.envelope.clone(),
    }
}

fn validate_backfill_response(
    records: &[BackfillRecord],
    response: BackfillBatchResponse,
) -> Result<BackfillBatchResponse, PublisherError> {
    if response.acknowledgements.len() != records.len() {
        return Err(PublisherError::Backfill(
            "analytics.invalid_acknowledgement".to_string(),
        ));
    }
    let expected = records
        .iter()
        .map(|record| (record.source_sequence, record.record.record_id.as_str()))
        .collect::<HashMap<_, _>>();
    if expected.len() != records.len() {
        return Err(PublisherError::InvalidConfiguration);
    }
    let mut seen = HashMap::with_capacity(response.acknowledgements.len());
    let mut counts = [0_usize; 4];
    for acknowledgement in &response.acknowledgements {
        let Some(expected_record_id) = expected.get(&acknowledgement.source_sequence) else {
            return Err(PublisherError::Backfill(
                "analytics.invalid_acknowledgement".to_string(),
            ));
        };
        if *expected_record_id != acknowledgement.record_id
            || seen.insert(acknowledgement.source_sequence, ()).is_some()
        {
            return Err(PublisherError::Backfill(
                "analytics.invalid_acknowledgement".to_string(),
            ));
        }
        let index = match acknowledgement.status.as_str() {
            "accepted" => 0,
            "duplicate" => 1,
            "rejected" => 2,
            "retryable" => 3,
            _ => {
                return Err(PublisherError::Backfill(
                    "analytics.invalid_acknowledgement".to_string(),
                ));
            }
        };
        counts[index] += 1;
    }
    if counts
        != [
            response.accepted_count,
            response.duplicate_count,
            response.rejected_count,
            response.retryable_count,
        ]
    {
        return Err(PublisherError::Backfill(
            "analytics.invalid_acknowledgement".to_string(),
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use serde_json::json;

    fn row(sequence: i64, record_id: &str) -> OutboxRow {
        OutboxRow {
            outbox_id: format!("outbox-{sequence}"),
            source_sequence: sequence,
            source_service: "core".to_string(),
            source_domain: "organizations".to_string(),
            source_stream_key: "organization:org-1".to_string(),
            record_category: "event".to_string(),
            record_id: record_id.to_string(),
            contract_name: "core.organization.created@1".to_string(),
            schema_version: 1,
            scope_kind: "core_organization".to_string(),
            scope_external_id: "org-1".to_string(),
            idempotency_key: record_id.to_string(),
            envelope: json!({"id": record_id}),
            payload_hash: "hash".to_string(),
            delivery_status: "leased".to_string(),
            attempt_count: 1,
            next_attempt_at: Utc::now(),
            created_at: Utc::now(),
            lease_owner: Some("publisher".to_string()),
            lease_expires_at: Some(Utc::now()),
        }
    }

    fn backfill_record(record_id: &str) -> BackfillRecord {
        BackfillRecord {
            source_sequence: backfill_source_sequence(record_id),
            record: crate::AnalyticsOutboxRecord {
                outbox_id: format!("backfill-{record_id}"),
                source_service: "core".to_string(),
                source_domain: "inbox".to_string(),
                source_stream_key: "organization:org-1:inbox".to_string(),
                record_category: crate::RecordCategory::Event,
                record_id: record_id.to_string(),
                contract_name: "conversation.message.lifecycle@1".to_string(),
                schema_version: 1,
                scope_kind: crate::ScopeKind::CoreOrganization,
                scope_external_id: "org-1".to_string(),
                idempotency_key: record_id.to_string(),
                envelope: json!({"id": record_id}),
                payload_hash: "hash".to_string(),
            },
        }
    }

    #[test]
    fn response_acknowledgements_are_matched_by_source_sequence() {
        let rows = vec![row(2, "record-2"), row(1, "record-1")];
        let response = IngestionBatchResponse {
            accepted_count: 1,
            duplicate_count: 1,
            rejected_count: 0,
            retryable_count: 0,
            acknowledgements: vec![
                IngestionAcknowledgement {
                    record_id: "record-1".to_string(),
                    source_sequence: 1,
                    status: "duplicate".to_string(),
                    error_code: None,
                },
                IngestionAcknowledgement {
                    record_id: "record-2".to_string(),
                    source_sequence: 2,
                    status: "accepted".to_string(),
                    error_code: None,
                },
            ],
        };
        let outcomes = response_outcomes(&rows, response, Utc::now(), RetryPolicy::default());
        assert_eq!(
            outcomes,
            vec![DeliveryOutcome::Accepted, DeliveryOutcome::Duplicate]
        );
    }

    #[test]
    fn malformed_or_missing_acknowledgements_are_retryable() {
        let rows = vec![row(1, "record-1")];
        let response = IngestionBatchResponse {
            accepted_count: 0,
            duplicate_count: 0,
            rejected_count: 0,
            retryable_count: 0,
            acknowledgements: Vec::new(),
        };
        let outcomes = response_outcomes(&rows, response, Utc::now(), RetryPolicy::default());
        assert!(matches!(outcomes[0], DeliveryOutcome::Retryable { .. }));
    }

    #[test]
    fn backfill_source_sequences_are_stable_and_positive() {
        let first = backfill_source_sequence("record-1");
        assert!(first > 0);
        assert_eq!(first, backfill_source_sequence("record-1"));
        assert_ne!(first, backfill_source_sequence("record-2"));
    }

    #[test]
    fn api_auth_and_availability_failures_are_retryable() {
        assert!(matches!(
            classify_http_status(StatusCode::UNAUTHORIZED),
            TransportError::Retryable(_)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::SERVICE_UNAVAILABLE),
            TransportError::Retryable(_)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::UNPROCESSABLE_ENTITY),
            TransportError::Permanent(_)
        ));
    }

    #[tokio::test]
    async fn client_posts_the_authenticated_batch_wire_contract() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (body_start, content_length) = loop {
                let read = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let body_start = index + 4;
                    let headers = String::from_utf8_lossy(&request[..index]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_string)
                        })
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if request.len() >= body_start + content_length {
                        break (body_start, content_length);
                    }
                }
            };
            let headers = String::from_utf8_lossy(&request[..body_start]);
            assert!(headers.starts_with("POST /internal/ingest/v1/batch HTTP/1.1"));
            assert!(headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: bearer test-token")));
            let body: Value =
                serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
            assert_eq!(body["records"][0]["producer_id"], "core-customer-analytics");
            assert_eq!(body["records"][0]["source_sequence"], 7);
            assert!(body.get("backfill_job_id").is_none());
            let response_body = r#"{"accepted_count":1,"duplicate_count":0,"rejected_count":0,"retryable_count":0,"acknowledgements":[{"record_id":"record-1","source_sequence":7,"status":"accepted"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client = AnalyticsIngestionClient::new(
            format!("http://{}", address),
            "test-token",
            Duration::from_secs(2),
        )
        .unwrap();
        let response = client
            .send_batch("core-customer-analytics", &[row(7, "record-1")])
            .await
            .unwrap();
        assert_eq!(response.acknowledgements.len(), 1);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn client_claims_authenticated_source_backfill_work() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&request);
            assert!(headers.starts_with("GET /internal/backfill/v1/work HTTP/1.1"));
            assert!(headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: bearer test-token")));
            let response_body = r#"{"job_id":"job-1","source_service":"core","source_domain":"inbox","reporting_scope_id":4,"root_scope_id":4,"scope_external_id":"org-1","requested_range_start":"2025-01-01T00:00:00Z","requested_range_end":"2025-02-01T00:00:00Z","contract_version":"inbox.meta@1","projection_version":"meta.v1","method":"source_reconstruction","job_status":"running","checkpoint":{},"remaining_count":12,"lease_expires_at":"2025-02-01T00:05:00Z"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client = AnalyticsIngestionClient::new(
            format!("http://{}", address),
            "test-token",
            Duration::from_secs(2),
        )
        .unwrap();
        let work = client.claim_source_backfill_work().await.unwrap().unwrap();
        assert_eq!(work.job_id, "job-1");
        assert_eq!(work.scope_external_id, "org-1");
        assert_eq!(work.remaining_count, Some(12));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn client_posts_authenticated_backfill_batch_with_job_identity() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (body_start, content_length) = loop {
                let read = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let body_start = index + 4;
                    let headers = String::from_utf8_lossy(&request[..index]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_string)
                        })
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if request.len() >= body_start + content_length {
                        break (body_start, content_length);
                    }
                }
            };
            let headers = String::from_utf8_lossy(&request[..body_start]);
            assert!(headers.starts_with("POST /internal/ingest/v1/batch HTTP/1.1"));
            assert!(headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: bearer test-token")));
            let body: Value =
                serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
            assert_eq!(body["backfill_job_id"], "job-1");
            assert_eq!(
                body["records"][0]["source_sequence"],
                backfill_source_sequence("backfill-record-1")
            );
            assert_eq!(body["records"][0]["record_id"], "backfill-record-1");
            let response_body = format!(
                r#"{{"accepted_count":1,"duplicate_count":0,"rejected_count":0,"retryable_count":0,"acknowledgements":[{{"record_id":"backfill-record-1","source_sequence":{},"status":"accepted"}}]}}"#,
                backfill_source_sequence("backfill-record-1")
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client = AnalyticsIngestionClient::new(
            format!("http://{}", address),
            "test-token",
            Duration::from_secs(2),
        )
        .unwrap();
        let response = client
            .send_backfill_batch(
                "core-customer-analytics",
                "job-1",
                &[backfill_record("backfill-record-1")],
            )
            .await
            .unwrap();
        assert_eq!(response.accepted_count, 1);
        assert_eq!(response.acknowledgements[0].status, "accepted");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn client_posts_the_authenticated_reconciliation_wire_contract() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (body_start, content_length) = loop {
                let read = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let body_start = index + 4;
                    let headers = String::from_utf8_lossy(&request[..index]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_string)
                        })
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if request.len() >= body_start + content_length {
                        break (body_start, content_length);
                    }
                }
            };
            let headers = String::from_utf8_lossy(&request[..body_start]);
            assert!(headers.starts_with("POST /internal/reconciliation/v1/summary HTTP/1.1"));
            assert!(headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: bearer test-token")));
            let body: Value =
                serde_json::from_slice(&request[body_start..body_start + content_length]).unwrap();
            assert_eq!(body["producer_id"], "core-customer-analytics");
            assert_eq!(body["source_domain"], "inbox");
            assert_eq!(body["source_stream_key"], "organization:org-1:inbox");
            assert_eq!(body["scope_kind"], "core_organization");
            assert_eq!(body["scope_external_id"], "org-1");
            assert_eq!(body["source_highest_outbox_sequence"], 12);
            assert_eq!(body["authoritative_count"], 4);
            let response_body = r#"{"reconciliation_run_id":"run-1","reconciliation_status":"complete","analytics_highest_received_sequence":12,"analytics_highest_contiguous_sequence":12,"missing_sequence_ranges":[],"unresolved_quarantine_count":0,"analytics_count":4}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client = AnalyticsIngestionClient::new(
            format!("http://{}", address),
            "test-token",
            Duration::from_secs(2),
        )
        .unwrap();
        let response = client
            .send_reconciliation(&ReconciliationRequest {
                reconciliation_run_id: "run-1".to_string(),
                producer_id: "core-customer-analytics".to_string(),
                source_domain: "inbox".to_string(),
                source_stream_key: "organization:org-1:inbox".to_string(),
                scope_kind: "core_organization".to_string(),
                scope_external_id: "org-1".to_string(),
                source_highest_outbox_sequence: 12,
                source_highest_delivered_sequence: Some(12),
                authoritative_count: 4,
            })
            .await
            .unwrap();
        assert_eq!(response.reconciliation_status, "complete");
        assert_eq!(response.analytics_count, 4);
        server.await.unwrap();
    }
}
