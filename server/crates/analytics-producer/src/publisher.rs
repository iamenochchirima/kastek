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
use sqlx::PgPool;
use thiserror::Error;

use crate::{
    apply_delivery_outcome, claim_outbox_batch, release_expired_leases, DeliveryOutcome, OutboxRow,
    ProducerError, RetryPolicy, MAX_OUTBOX_BATCH_SIZE,
};

const INGESTION_PATH: &str = "/internal/ingest/v1/batch";

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
        };
        let response = self
            .client
            .post(format!("{}{}", self.endpoint, INGESTION_PATH))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .json(&request)
            .send()
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
}

#[derive(Debug, Error)]
pub enum PublisherError {
    #[error("invalid analytics publisher configuration")]
    InvalidConfiguration,
    #[error("analytics HTTP client could not be built")]
    ClientBuild,
    #[error(transparent)]
    Producer(#[from] ProducerError),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PublishStats {
    pub leases_released: u64,
    pub claimed: usize,
    pub delivered: usize,
    pub retryable: usize,
    pub quarantined: usize,
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
    Ok(stats)
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
            lease_owner: Some("publisher".to_string()),
            lease_expires_at: Some(Utc::now()),
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
}
