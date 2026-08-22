//! Authenticated, idempotent batch ingestion for customer analytics.
//!
//! The API accepts source outbox records, never raw domain writes. Each record gets its own
//! transaction so one malformed event cannot block an otherwise valid batch. Facts, scope
//! receipts, source cursors, and observation health are committed together.

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{types::Json, PgPool, Postgres, Row, Transaction};

use crate::{
    config::{hex_sha256, AnalyticsConfig, IngestionCredential},
    records::{canonical_payload_sha256, validate_sha256_hex, RecordCategory, ScopeBinding},
    registry::{validate_envelope, validate_registered_contract},
};

pub const INGESTION_PATH: &str = "/internal/ingest/v1/batch";
pub const MAX_BATCH_RECORDS: usize = 500;
pub const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct IngestionAuthenticator {
    credentials: Vec<IngestionCredential>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedProducer {
    pub source_service: String,
    pub producer_id: String,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AuthenticationError {
    MissingBearer,
    InvalidBearer,
}

impl IngestionAuthenticator {
    pub fn from_config(config: &AnalyticsConfig) -> Self {
        Self {
            credentials: config.ingestion_credentials.clone(),
        }
    }

    pub fn new(credentials: Vec<IngestionCredential>) -> Self {
        Self { credentials }
    }

    pub fn authenticate(
        &self,
        request: &HttpRequest,
    ) -> Result<AuthenticatedProducer, AuthenticationError> {
        let value = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthenticationError::MissingBearer)?;
        let token = value
            .strip_prefix("Bearer ")
            .filter(|token| !token.trim().is_empty())
            .ok_or(AuthenticationError::InvalidBearer)?;
        let digest = hex_sha256(token.trim().as_bytes());
        self.credentials
            .iter()
            .find(|credential| constant_time_equal(&credential.token_sha256, &digest))
            .map(|credential| AuthenticatedProducer {
                source_service: credential.source_service.clone(),
                producer_id: credential.producer_id.clone(),
            })
            .ok_or(AuthenticationError::InvalidBearer)
    }
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for (left, right) in left.bytes().zip(right.bytes()) {
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngestionBatchRequest {
    pub records: Vec<IngestionRecord>,
    #[serde(default)]
    pub backfill_job_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IngestionRecord {
    pub producer_id: String,
    pub source_stream_key: String,
    pub source_sequence: i64,
    pub record_category: RecordCategory,
    pub record_id: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: String,
    pub scope_external_id: String,
    pub payload_hash: String,
    pub envelope: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcknowledgementStatus {
    Accepted,
    Duplicate,
    Rejected,
    Retryable,
}

#[derive(Clone, Debug, Serialize)]
pub struct IngestionAcknowledgement {
    pub record_id: String,
    pub source_sequence: i64,
    pub status: AcknowledgementStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IngestionBatchResponse {
    pub accepted_count: usize,
    pub duplicate_count: usize,
    pub rejected_count: usize,
    pub retryable_count: usize,
    pub acknowledgements: Vec<IngestionAcknowledgement>,
}

#[derive(Clone, Debug)]
pub(crate) enum FailureClass {
    Permanent,
    Retryable,
    IdentityConflict,
    Privacy,
}

impl FailureClass {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Permanent => "permanent",
            Self::Retryable => "retryable",
            Self::IdentityConflict => "identity_conflict",
            Self::Privacy => "privacy",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ValidationFailure {
    pub(crate) code: &'static str,
    pub(crate) class: FailureClass,
}

#[derive(Clone, Debug)]
struct ValidatedRecord {
    payload: ValidatedPayload,
    occurred_at: DateTime<Utc>,
    origin: String,
    correlation_id: Option<String>,
    causation_id: Option<String>,
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug)]
enum ValidatedPayload {
    Event {
        event_type: String,
        subject_type: String,
        subject_id: String,
        attributes: Value,
    },
    Observation {
        provider: String,
        provider_account_ref: Option<String>,
        connection_ref: Option<String>,
        metric_key: String,
        numeric_value: f64,
        unit: String,
        reporting_window_start: DateTime<Utc>,
        reporting_window_end: DateTime<Utc>,
        observed_at: DateTime<Utc>,
        synchronization_run_id: String,
        dimensions: Value,
        source_evidence: Value,
    },
    ScopeDefinition {
        parent_scope_external_id: Option<String>,
        reporting_timezone: String,
        status: String,
        source_version: i64,
    },
}

#[derive(Clone, Debug)]
struct ProducerPermission {
    source_service: String,
    active: bool,
    permitted_record_categories: Value,
    permitted_scope_kinds: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct GapRange {
    start: i64,
    end: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct ScopeResolution {
    pub(crate) binding: ScopeBinding,
}

#[derive(Clone, Debug)]
struct ExistingIdentity {
    record_category: RecordCategory,
    record_id: String,
    payload_hash: String,
}

pub async fn handler(
    request: HttpRequest,
    body: web::Json<IngestionBatchRequest>,
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
    if body.records.is_empty() || body.records.len() > MAX_BATCH_RECORDS {
        return HttpResponse::BadRequest().json(json!({
            "error": "invalid_batch_size",
            "max_records": MAX_BATCH_RECORDS
        }));
    }

    let response = ingest_batch(pool.get_ref(), &authenticated, body.into_inner()).await;
    HttpResponse::Ok().json(response)
}

pub async fn ingest_batch(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    batch: IngestionBatchRequest,
) -> IngestionBatchResponse {
    let mut acknowledgements = Vec::with_capacity(batch.records.len());
    for record in batch.records {
        acknowledgements.push(
            ingest_record(
                pool,
                authenticated,
                batch.backfill_job_id.as_deref(),
                record,
            )
            .await,
        );
    }
    let accepted_count = acknowledgements
        .iter()
        .filter(|ack| matches!(ack.status, AcknowledgementStatus::Accepted))
        .count();
    let duplicate_count = acknowledgements
        .iter()
        .filter(|ack| matches!(ack.status, AcknowledgementStatus::Duplicate))
        .count();
    let rejected_count = acknowledgements
        .iter()
        .filter(|ack| matches!(ack.status, AcknowledgementStatus::Rejected))
        .count();
    let retryable_count = acknowledgements
        .iter()
        .filter(|ack| matches!(ack.status, AcknowledgementStatus::Retryable))
        .count();
    IngestionBatchResponse {
        accepted_count,
        duplicate_count,
        rejected_count,
        retryable_count,
        acknowledgements,
    }
}

async fn ingest_record(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    backfill_job_id: Option<&str>,
    record: IngestionRecord,
) -> IngestionAcknowledgement {
    let record_id = record.record_id.clone();
    let source_sequence = record.source_sequence;
    let rejected = |code: &'static str| IngestionAcknowledgement {
        record_id: record_id.clone(),
        source_sequence,
        status: AcknowledgementStatus::Rejected,
        error_code: Some(code.to_string()),
    };

    if record.producer_id != authenticated.producer_id {
        return rejected("producer_not_authorized");
    }
    if record.source_sequence <= 0
        || record.source_stream_key.trim().is_empty()
        || record.record_id.trim().is_empty()
        || record.contract_name.trim().is_empty()
        || record.schema_version <= 0
    {
        return rejected("invalid_record_identity");
    }
    if serde_json::to_vec(&record)
        .map(|bytes| bytes.len() > MAX_RECORD_BYTES)
        .unwrap_or(true)
    {
        return rejected("record_too_large");
    }

    let validation = validate_record(&record, authenticated);
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
    };
    let producer = match load_producer(&mut transaction, &record.producer_id).await {
        Ok(Some(producer)) => producer,
        Ok(None) => return rejected("producer_not_registered"),
        Err(_) => {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
    };
    if !producer.active || producer.source_service != authenticated.source_service {
        return rejected("producer_not_authorized");
    }

    let validated = match validation {
        Ok(validated) => validated,
        Err(failure) => {
            let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
            if transaction.commit().await.is_err() {
                return retryable(record_id, source_sequence, "analytics_unavailable");
            }
            return rejected(failure.code);
        }
    };

    if !json_array_contains(
        &producer.permitted_record_categories,
        record.record_category.as_str(),
    ) {
        let failure = ValidationFailure {
            code: "record_category_not_permitted",
            class: FailureClass::Permanent,
        };
        let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
        let _ = transaction.commit().await;
        return rejected(failure.code);
    }
    if !json_array_contains(&producer.permitted_scope_kinds, &record.scope_kind) {
        let failure = ValidationFailure {
            code: "scope_kind_not_permitted",
            class: FailureClass::Permanent,
        };
        let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
        let _ = transaction.commit().await;
        return rejected(failure.code);
    }

    if let Some(job_id) = backfill_job_id {
        if let Err(failure) = validate_backfill_job(&mut transaction, job_id, authenticated).await {
            let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
            let _ = transaction.commit().await;
            return rejected(failure.code);
        }
    }

    let existing = match find_existing_identity(&mut transaction, &record).await {
        Ok(existing) => existing,
        Err(_) => {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
    };
    if let Some(existing) = existing {
        if existing.record_category == record.record_category
            && existing.record_id == record.record_id
            && existing.payload_hash == record.payload_hash
        {
            if update_cursor(&mut transaction, authenticated, &record)
                .await
                .is_err()
            {
                return retryable(record_id, source_sequence, "analytics_unavailable");
            }
            if transaction.commit().await.is_err() {
                return retryable(record_id, source_sequence, "analytics_unavailable");
            }
            return IngestionAcknowledgement {
                record_id,
                source_sequence,
                status: AcknowledgementStatus::Duplicate,
                error_code: None,
            };
        }
        let failure = ValidationFailure {
            code: "identity_conflict",
            class: FailureClass::IdentityConflict,
        };
        let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
        let _ = transaction.commit().await;
        return rejected(failure.code);
    }

    if let ValidatedPayload::ScopeDefinition {
        parent_scope_external_id,
        reporting_timezone,
        status,
        source_version,
    } = &validated.payload
    {
        match apply_scope_definition(
            &mut transaction,
            authenticated,
            &record,
            parent_scope_external_id.as_deref(),
            reporting_timezone,
            status,
            *source_version,
        )
        .await
        {
            Ok(()) => {}
            Err(failure) => {
                let _ =
                    record_failure(&mut transaction, &record, authenticated, &failure, None).await;
                let _ = transaction.commit().await;
                if matches!(failure.class, FailureClass::Retryable) {
                    return retryable(record_id, source_sequence, failure.code);
                }
                return rejected(failure.code);
            }
        }
        if update_cursor(&mut transaction, authenticated, &record)
            .await
            .is_err()
        {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
        if let Some(job_id) = backfill_job_id {
            if update_backfill_count(&mut transaction, job_id, true)
                .await
                .is_err()
            {
                return retryable(record_id, source_sequence, "analytics_unavailable");
            }
        }
        if transaction.commit().await.is_err() {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
        return IngestionAcknowledgement {
            record_id,
            source_sequence,
            status: AcknowledgementStatus::Accepted,
            error_code: None,
        };
    }

    let resolution = match resolve_scope(
        &mut transaction,
        authenticated,
        record.scope_kind.as_str(),
        record.scope_external_id.as_str(),
    )
    .await
    {
        Ok(resolution) => resolution,
        Err(failure) => {
            let _ = record_failure(&mut transaction, &record, authenticated, &failure, None).await;
            let _ = transaction.commit().await;
            if matches!(failure.class, FailureClass::Retryable) {
                return retryable(record_id, source_sequence, failure.code);
            }
            return rejected(failure.code);
        }
    };

    let result = match &validated.payload {
        ValidatedPayload::Event {
            event_type,
            subject_type,
            subject_id,
            attributes,
        } => {
            sqlx::query(
                r#"INSERT INTO analytics.analytics_event (
                    producer_id, source_service, source_domain, source_stream_key, source_sequence,
                    event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
                    subject_type, subject_id, occurred_at, origin, source_record_id, correlation_id,
                    causation_id, idempotency_key, attributes, payload_hash, backfilled
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$6,$15,$16,$17,$18,$19,$20)"#,
            )
            .bind(&record.producer_id)
            .bind(&authenticated.source_service)
            .bind(record_source_domain(&record))
            .bind(&record.source_stream_key)
            .bind(record.source_sequence)
            .bind(&record.record_id)
            .bind(event_type)
            .bind(record.schema_version)
            .bind(resolution.binding.reporting_scope_id)
            .bind(resolution.binding.root_scope_id)
            .bind(subject_type)
            .bind(subject_id)
            .bind(validated.occurred_at)
            .bind(&validated.origin)
            .bind(&validated.correlation_id)
            .bind(&validated.causation_id)
            .bind(&validated.idempotency_key)
            .bind(attributes)
            .bind(&record.payload_hash)
            .bind(backfill_job_id.is_some())
            .execute(&mut *transaction)
            .await
        }
        ValidatedPayload::Observation {
            provider,
            provider_account_ref,
            connection_ref,
            metric_key,
            numeric_value,
            unit,
            reporting_window_start,
            reporting_window_end,
            observed_at,
            synchronization_run_id,
            dimensions,
            source_evidence,
        } => {
            let result = sqlx::query(
                r#"INSERT INTO analytics.analytics_metric_observation (
                    producer_id, source_service, source_domain, source_stream_key, source_sequence,
                    observation_id, schema_version, reporting_scope_id, root_scope_id, provider,
                    provider_account_ref, connection_ref, metric_key, numeric_value, unit,
                    reporting_window_start, reporting_window_end, observed_at, synchronization_run_id,
                    subject_type, subject_id, dimensions, source_evidence, payload_hash, backfilled
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL,NULL,$20,$21,$22,$23)"#,
            )
            .bind(&record.producer_id)
            .bind(&authenticated.source_service)
            .bind(record_source_domain(&record))
            .bind(&record.source_stream_key)
            .bind(record.source_sequence)
            .bind(&record.record_id)
            .bind(record.schema_version)
            .bind(resolution.binding.reporting_scope_id)
            .bind(resolution.binding.root_scope_id)
            .bind(provider)
            .bind(provider_account_ref)
            .bind(connection_ref)
            .bind(metric_key)
            .bind(numeric_value)
            .bind(unit)
            .bind(reporting_window_start)
            .bind(reporting_window_end)
            .bind(observed_at)
            .bind(synchronization_run_id)
            .bind(dimensions)
            .bind(source_evidence)
            .bind(&record.payload_hash)
            .bind(backfill_job_id.is_some())
            .execute(&mut *transaction)
            .await;
            if result.is_ok()
                && update_observation_state(
                    &mut transaction,
                    authenticated,
                    &record,
                    &resolution.binding,
                    ObservationStateUpdate {
                        provider,
                        connection_ref: connection_ref.as_deref().unwrap_or(""),
                        metric_scope: metric_key,
                        observed_at: *observed_at,
                    },
                )
                .await
                .is_err()
            {
                return retryable(record_id, source_sequence, "analytics_unavailable");
            }
            result
        }
        ValidatedPayload::ScopeDefinition { .. } => unreachable!("scope definitions return above"),
    };

    if result.is_err() {
        return retryable(record_id, source_sequence, "analytics_unavailable");
    }
    if update_cursor(&mut transaction, authenticated, &record)
        .await
        .is_err()
    {
        return retryable(record_id, source_sequence, "analytics_unavailable");
    }
    if let Some(job_id) = backfill_job_id {
        if update_backfill_count(&mut transaction, job_id, true)
            .await
            .is_err()
        {
            return retryable(record_id, source_sequence, "analytics_unavailable");
        }
    }
    if transaction.commit().await.is_err() {
        return retryable(record_id, source_sequence, "analytics_unavailable");
    }
    IngestionAcknowledgement {
        record_id,
        source_sequence,
        status: AcknowledgementStatus::Accepted,
        error_code: None,
    }
}

fn retryable(
    record_id: String,
    source_sequence: i64,
    code: &'static str,
) -> IngestionAcknowledgement {
    IngestionAcknowledgement {
        record_id,
        source_sequence,
        status: AcknowledgementStatus::Retryable,
        error_code: Some(code.to_string()),
    }
}

fn record_source_domain(record: &IngestionRecord) -> String {
    record
        .envelope
        .get("source_domain")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn validate_record(
    record: &IngestionRecord,
    authenticated: &AuthenticatedProducer,
) -> Result<ValidatedRecord, ValidationFailure> {
    validate_sha256_hex(&record.payload_hash).map_err(|_| ValidationFailure {
        code: "invalid_payload_hash",
        class: FailureClass::Permanent,
    })?;
    validate_envelope(&record.envelope).map_err(|_| ValidationFailure {
        code: "invalid_envelope",
        class: FailureClass::Permanent,
    })?;
    let envelope = record.envelope.as_object().ok_or(ValidationFailure {
        code: "invalid_envelope",
        class: FailureClass::Permanent,
    })?;
    let text = |key: &'static str| {
        envelope
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(ValidationFailure {
                code: "invalid_envelope",
                class: FailureClass::Permanent,
            })
    };
    if text("source_service")? != authenticated.source_service
        || text("source_domain")? != record_source_domain(record)
        || text("type")? != record.contract_name
        || text("scope_kind")? != record.scope_kind
        || text("scope_external_id")? != record.scope_external_id
    {
        return Err(ValidationFailure {
            code: "envelope_identity_mismatch",
            class: FailureClass::IdentityConflict,
        });
    }
    let category = envelope
        .get("record_category")
        .and_then(Value::as_str)
        .and_then(parse_record_category)
        .ok_or(ValidationFailure {
            code: "invalid_record_category",
            class: FailureClass::Permanent,
        })?;
    if category != record.record_category || matches!(category, RecordCategory::Manifest) {
        return Err(ValidationFailure {
            code: "record_category_mismatch",
            class: FailureClass::IdentityConflict,
        });
    }
    if contract_version(&record.contract_name) != Some(record.schema_version) {
        return Err(ValidationFailure {
            code: "schema_version_mismatch",
            class: FailureClass::Permanent,
        });
    }
    let data = envelope.get("data").ok_or(ValidationFailure {
        code: "invalid_envelope",
        class: FailureClass::Permanent,
    })?;
    if !data.is_object() {
        return Err(ValidationFailure {
            code: "invalid_data",
            class: FailureClass::Permanent,
        });
    }
    if let Err(error) = canonical_payload_sha256(data) {
        let _ = error;
        return Err(ValidationFailure {
            code: "invalid_payload",
            class: FailureClass::Permanent,
        });
    }
    if canonical_payload_sha256(data).ok().as_deref() != Some(record.payload_hash.as_str()) {
        return Err(ValidationFailure {
            code: "payload_hash_mismatch",
            class: FailureClass::IdentityConflict,
        });
    }
    if contains_prohibited_field(data) {
        return Err(ValidationFailure {
            code: "prohibited_field",
            class: FailureClass::Privacy,
        });
    }
    if category == RecordCategory::Event {
        validate_registered_contract(&record.contract_name, data).map_err(|_| {
            ValidationFailure {
                code: "contract_invalid",
                class: FailureClass::Permanent,
            }
        })?;
    }
    let occurred_at = parse_time(envelope.get("time")).ok_or(ValidationFailure {
        code: "invalid_event_time",
        class: FailureClass::Permanent,
    })?;
    let origin = text("source")?.to_string();
    let correlation_id = optional_text(envelope, "correlation_id");
    let causation_id = optional_text(envelope, "causation_id");
    let idempotency_key = optional_text(envelope, "idempotency_key");
    let payload = match category {
        RecordCategory::Event => {
            let subject = text("subject")?;
            let (subject_type, subject_id) = subject
                .split_once(':')
                .or_else(|| subject.split_once('/'))
                .filter(|(kind, id)| !kind.is_empty() && !id.is_empty())
                .ok_or(ValidationFailure {
                    code: "invalid_subject",
                    class: FailureClass::Permanent,
                })?;
            ValidatedPayload::Event {
                event_type: record.contract_name.clone(),
                subject_type: subject_type.to_string(),
                subject_id: subject_id.to_string(),
                attributes: data.clone(),
            }
        }
        RecordCategory::Observation => ValidatedPayload::Observation {
            provider: required_data_text(data, "provider")?,
            provider_account_ref: optional_data_text(data, "provider_account_ref"),
            connection_ref: optional_data_text(data, "connection_ref"),
            metric_key: required_data_text(data, "metric_key")?,
            numeric_value: data
                .get("numeric_value")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or(ValidationFailure {
                    code: "invalid_numeric_value",
                    class: FailureClass::Permanent,
                })?,
            unit: required_data_text(data, "unit")?,
            reporting_window_start: required_data_time(data, "reporting_window_start")?,
            reporting_window_end: required_data_time(data, "reporting_window_end")?,
            observed_at: required_data_time(data, "observed_at")?,
            synchronization_run_id: required_data_text(data, "synchronization_run_id")?,
            dimensions: required_data_object(data, "dimensions")?,
            source_evidence: required_data_object(data, "source_evidence")?,
        },
        RecordCategory::ScopeDefinition => ValidatedPayload::ScopeDefinition {
            parent_scope_external_id: optional_data_text(data, "parent_scope_external_id"),
            reporting_timezone: required_data_text(data, "reporting_timezone")?,
            status: required_data_text(data, "status")?,
            source_version: data
                .get("source_version")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or(ValidationFailure {
                    code: "invalid_scope_version",
                    class: FailureClass::Permanent,
                })?,
        },
        RecordCategory::Manifest => {
            return Err(ValidationFailure {
                code: "manifest_not_supported",
                class: FailureClass::Permanent,
            })
        }
    };
    if let ValidatedPayload::Observation {
        metric_key,
        reporting_window_start,
        reporting_window_end,
        ..
    } = &payload
    {
        if !is_metric_key(metric_key) {
            return Err(ValidationFailure {
                code: "invalid_metric_key",
                class: FailureClass::Permanent,
            });
        }
        if reporting_window_end <= reporting_window_start {
            return Err(ValidationFailure {
                code: "invalid_observation_window",
                class: FailureClass::Permanent,
            });
        }
    }
    if let ValidatedPayload::ScopeDefinition { .. } = &payload {
        if required_data_text(data, "scope_kind").ok().as_deref()
            != Some(record.scope_kind.as_str())
            || required_data_text(data, "scope_external_id")
                .ok()
                .as_deref()
                != Some(record.scope_external_id.as_str())
        {
            return Err(ValidationFailure {
                code: "scope_definition_identity_mismatch",
                class: FailureClass::IdentityConflict,
            });
        }
    }
    Ok(ValidatedRecord {
        payload,
        occurred_at,
        origin,
        correlation_id,
        causation_id,
        idempotency_key,
    })
}

fn parse_record_category(value: &str) -> Option<RecordCategory> {
    match value {
        "event" => Some(RecordCategory::Event),
        "observation" => Some(RecordCategory::Observation),
        "scope_definition" => Some(RecordCategory::ScopeDefinition),
        "manifest" => Some(RecordCategory::Manifest),
        _ => None,
    }
}

fn contract_version(value: &str) -> Option<i32> {
    value.rsplit_once('@')?.1.parse().ok()
}

fn is_metric_key(value: &str) -> bool {
    value.len() >= 2
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && byte.is_ascii_lowercase())
                || (index > 0
                    && (byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || b"_.-".contains(&byte)))
        })
}

fn parse_time(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn optional_text(value: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn required_data_text(value: &Value, key: &'static str) -> Result<String, ValidationFailure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or(ValidationFailure {
            code: "invalid_observation",
            class: FailureClass::Permanent,
        })
}

fn optional_data_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn required_data_time(
    value: &Value,
    key: &'static str,
) -> Result<DateTime<Utc>, ValidationFailure> {
    parse_time(value.get(key)).ok_or(ValidationFailure {
        code: "invalid_observation_time",
        class: FailureClass::Permanent,
    })
}

fn required_data_object(value: &Value, key: &'static str) -> Result<Value, ValidationFailure> {
    value
        .get(key)
        .filter(|value| value.is_object())
        .cloned()
        .ok_or(ValidationFailure {
            code: "invalid_observation_object",
            class: FailureClass::Permanent,
        })
}

fn contains_prohibited_field(value: &Value) -> bool {
    const PROHIBITED: &[&str] = &[
        "prompt",
        "response",
        "phone_number",
        "email",
        "credential",
        "token",
        "access_token",
        "refresh_token",
    ];
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            PROHIBITED.contains(&key.as_str()) || contains_prohibited_field(value)
        }),
        Value::Array(values) => values.iter().any(contains_prohibited_field),
        _ => false,
    }
}

async fn load_producer(
    transaction: &mut Transaction<'_, Postgres>,
    producer_id: &str,
) -> Result<Option<ProducerPermission>, sqlx::Error> {
    let row = sqlx::query(
        r#"SELECT identity.source_service, producer.active,
                  producer.permitted_record_categories, producer.permitted_scope_kinds
           FROM analytics.producer AS producer
           JOIN analytics.service_identity AS identity
             ON identity.service_identity_id = producer.service_identity_id
           WHERE producer.producer_id = $1 AND identity.status = 'active'"#,
    )
    .bind(producer_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(|row| ProducerPermission {
        source_service: row.get("source_service"),
        active: row.get("active"),
        permitted_record_categories: row.get("permitted_record_categories"),
        permitted_scope_kinds: row.get("permitted_scope_kinds"),
    }))
}

fn json_array_contains(value: &Value, expected: &str) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
}

pub(crate) async fn resolve_scope(
    transaction: &mut Transaction<'_, Postgres>,
    _authenticated: &AuthenticatedProducer,
    scope_kind: &str,
    scope_external_id: &str,
) -> Result<ScopeResolution, ValidationFailure> {
    let row = sqlx::query(
        r#"SELECT scope.scope_id, scope.root_scope_id, scope.status
           FROM analytics.reporting_scope AS scope
           JOIN analytics.scope_kind_registry AS kind ON kind.scope_kind = scope.scope_kind
           WHERE scope.scope_kind = $1
             AND scope.external_source_id = $2"#,
    )
    .bind(scope_kind)
    .bind(scope_external_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ValidationFailure {
        code: "analytics_unavailable",
        class: FailureClass::Retryable,
    })?;
    let Some(row) = row else {
        return Err(ValidationFailure {
            code: "scope_not_ready",
            class: FailureClass::Retryable,
        });
    };
    let status: String = row.get("status");
    if status == "deleted" {
        return Err(ValidationFailure {
            code: "scope_unavailable",
            class: FailureClass::Permanent,
        });
    }
    Ok(ScopeResolution {
        binding: ScopeBinding {
            reporting_scope_id: row.get("scope_id"),
            root_scope_id: row.get("root_scope_id"),
        },
    })
}

async fn find_existing_identity(
    transaction: &mut Transaction<'_, Postgres>,
    record: &IngestionRecord,
) -> Result<Option<ExistingIdentity>, sqlx::Error> {
    let category = record.record_category.as_str();
    let row = sqlx::query(
        r#"SELECT record_category, record_id, payload_hash FROM (
             SELECT 'event'::TEXT AS record_category, event_id AS record_id, payload_hash
             FROM analytics.analytics_event
             WHERE producer_id = $1 AND source_stream_key = $2 AND (event_id = $3 OR source_sequence = $4)
             UNION ALL
             SELECT 'observation'::TEXT, observation_id, payload_hash
             FROM analytics.analytics_metric_observation
             WHERE producer_id = $1 AND source_stream_key = $2 AND (observation_id = $3 OR source_sequence = $4)
             UNION ALL
             SELECT 'scope_definition'::TEXT, record_id, payload_hash
             FROM analytics.analytics_scope_definition_receipt
             WHERE producer_id = $1 AND source_stream_key = $2 AND (record_id = $3 OR source_sequence = $4)
           ) identities
           ORDER BY CASE WHEN record_category = $5 THEN 0 ELSE 1 END
           LIMIT 1"#,
    )
    .bind(&record.producer_id)
    .bind(&record.source_stream_key)
    .bind(&record.record_id)
    .bind(record.source_sequence)
    .bind(category)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(|row| ExistingIdentity {
        record_category: parse_record_category(row.get::<String, _>("record_category").as_str())
            .expect("database record category is constrained"),
        record_id: row.get("record_id"),
        payload_hash: row.get("payload_hash"),
    }))
}

async fn update_cursor(
    transaction: &mut Transaction<'_, Postgres>,
    authenticated: &AuthenticatedProducer,
    record: &IngestionRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO analytics.analytics_source_cursor (
             producer_id, source_service, source_domain, source_stream_key
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (producer_id, source_stream_key) DO NOTHING"#,
    )
    .bind(&record.producer_id)
    .bind(&authenticated.source_service)
    .bind(record_source_domain(record))
    .bind(&record.source_stream_key)
    .execute(&mut **transaction)
    .await?;
    let row = sqlx::query(
        r#"SELECT highest_received_sequence, highest_contiguous_sequence, known_gap_ranges
           FROM analytics.analytics_source_cursor
           WHERE producer_id = $1 AND source_stream_key = $2
           FOR UPDATE"#,
    )
    .bind(&record.producer_id)
    .bind(&record.source_stream_key)
    .fetch_one(&mut **transaction)
    .await?;
    let received: i64 = row.get("highest_received_sequence");
    let contiguous: i64 = row.get("highest_contiguous_sequence");
    let ranges_value: Json<Value> = row
        .try_get("known_gap_ranges")
        .unwrap_or_else(|_| Json(Value::Array(Vec::new())));
    let ranges: Vec<GapRange> = serde_json::from_value(ranges_value.0).unwrap_or_default();
    let (received, contiguous, ranges) =
        advance_cursor(received, contiguous, ranges, record.source_sequence);
    sqlx::query(
        r#"UPDATE analytics.analytics_source_cursor
           SET highest_received_sequence = $3,
               highest_contiguous_sequence = $4,
               known_gap_ranges = $5,
               latest_acceptance_at = NOW()
           WHERE producer_id = $1 AND source_stream_key = $2"#,
    )
    .bind(&record.producer_id)
    .bind(&record.source_stream_key)
    .bind(received)
    .bind(contiguous)
    .bind(json!(ranges))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn advance_cursor(
    mut highest_received: i64,
    _highest_contiguous: i64,
    mut ranges: Vec<GapRange>,
    sequence: i64,
) -> (i64, i64, Vec<GapRange>) {
    if sequence > highest_received {
        if sequence > highest_received + 1 {
            ranges.push(GapRange {
                start: highest_received + 1,
                end: sequence - 1,
            });
        }
        highest_received = sequence;
    }
    ranges = subtract_sequence(ranges, sequence);
    ranges = merge_ranges(ranges);
    let highest_contiguous = ranges
        .first()
        .map(|range| range.start.saturating_sub(1))
        .unwrap_or(highest_received);
    (highest_received, highest_contiguous, ranges)
}

fn subtract_sequence(ranges: Vec<GapRange>, sequence: i64) -> Vec<GapRange> {
    let mut output = Vec::with_capacity(ranges.len() + 1);
    for range in ranges {
        if sequence < range.start || sequence > range.end {
            output.push(range);
            continue;
        }
        if range.start < sequence {
            output.push(GapRange {
                start: range.start,
                end: sequence - 1,
            });
        }
        if sequence < range.end {
            output.push(GapRange {
                start: sequence + 1,
                end: range.end,
            });
        }
    }
    output
}

fn merge_ranges(mut ranges: Vec<GapRange>) -> Vec<GapRange> {
    ranges.retain(|range| range.start <= range.end);
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<GapRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end.saturating_add(1) {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

struct ObservationStateUpdate<'a> {
    provider: &'a str,
    connection_ref: &'a str,
    metric_scope: &'a str,
    observed_at: DateTime<Utc>,
}

async fn update_observation_state(
    transaction: &mut Transaction<'_, Postgres>,
    authenticated: &AuthenticatedProducer,
    record: &IngestionRecord,
    binding: &ScopeBinding,
    state: ObservationStateUpdate<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO analytics.analytics_source_state (
             producer_id, source_service, source_domain, source_stream_key,
             reporting_scope_id, root_scope_id, provider, connection_ref, metric_scope,
             availability_state, latest_source_timestamp, last_successful_sync_at,
             latest_source_sequence, safe_failure_code
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'available',$10,NOW(),$11,NULL)
           ON CONFLICT (producer_id, source_stream_key, reporting_scope_id, metric_scope)
           DO UPDATE SET provider = EXCLUDED.provider,
                         connection_ref = EXCLUDED.connection_ref,
                         availability_state = 'available',
                         latest_source_timestamp = GREATEST(
                             COALESCE(analytics.analytics_source_state.latest_source_timestamp, EXCLUDED.latest_source_timestamp),
                             EXCLUDED.latest_source_timestamp
                         ),
                         last_successful_sync_at = NOW(),
                         latest_source_sequence = GREATEST(
                             COALESCE(analytics.analytics_source_state.latest_source_sequence, 0),
                             EXCLUDED.latest_source_sequence
                         ),
                         safe_failure_code = NULL"#,
    )
    .bind(&record.producer_id)
    .bind(&authenticated.source_service)
    .bind(record_source_domain(record))
    .bind(&record.source_stream_key)
    .bind(binding.reporting_scope_id)
    .bind(binding.root_scope_id)
    .bind(state.provider)
    .bind(state.connection_ref)
    .bind(state.metric_scope)
    .bind(state.observed_at)
    .bind(record.source_sequence)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn apply_scope_definition(
    transaction: &mut Transaction<'_, Postgres>,
    authenticated: &AuthenticatedProducer,
    record: &IngestionRecord,
    parent_scope_external_id: Option<&str>,
    reporting_timezone: &str,
    status: &str,
    source_version: i64,
) -> Result<(), ValidationFailure> {
    let kind = sqlx::query(
        "SELECT owner_source_service, parent_scope_kind, active FROM analytics.scope_kind_registry WHERE scope_kind = $1",
    )
    .bind(&record.scope_kind)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| {
        ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable }
    })?
    .ok_or(ValidationFailure { code: "scope_kind_unknown", class: FailureClass::Permanent })?;
    let owner: String = kind.get("owner_source_service");
    let parent_kind: Option<String> = kind.get("parent_scope_kind");
    let active: bool = kind.get("active");
    if !active || owner != authenticated.source_service {
        return Err(ValidationFailure {
            code: "scope_owner_not_authorized",
            class: FailureClass::Permanent,
        });
    }
    let parent_scope_id = match (parent_kind, parent_scope_external_id) {
        (None, None) => None,
        (Some(parent_kind), Some(parent_external_id)) => {
            let parent = sqlx::query(
                "SELECT scope_id FROM analytics.reporting_scope WHERE owning_source_service = $1 AND scope_kind = $2 AND external_source_id = $3 AND status <> 'deleted'",
            )
            .bind(&owner)
            .bind(parent_kind)
            .bind(parent_external_id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| {
                ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable }
            })?;
            Some(
                parent
                    .ok_or(ValidationFailure {
                        code: "scope_not_ready",
                        class: FailureClass::Retryable,
                    })?
                    .get::<i64, _>("scope_id"),
            )
        }
        _ => {
            return Err(ValidationFailure {
                code: "scope_parent_invalid",
                class: FailureClass::Permanent,
            })
        }
    };
    let existing = sqlx::query(
        "SELECT scope_id, parent_scope_id, source_version FROM analytics.reporting_scope WHERE owning_source_service = $1 AND scope_kind = $2 AND external_source_id = $3 FOR UPDATE",
    )
    .bind(&owner)
    .bind(&record.scope_kind)
    .bind(&record.scope_external_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| {
        ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable }
    })?;
    if let Some(existing) = existing {
        let current_parent: Option<i64> = existing.get("parent_scope_id");
        let current_version: i64 = existing.get("source_version");
        if current_parent != parent_scope_id {
            return Err(ValidationFailure {
                code: "scope_reparent_required",
                class: FailureClass::Permanent,
            });
        }
        if source_version > current_version {
            sqlx::query(
                "UPDATE analytics.reporting_scope SET status = $1, reporting_timezone = $2, source_version = $3 WHERE scope_id = $4",
            )
            .bind(status)
            .bind(reporting_timezone)
            .bind(source_version)
            .bind(existing.get::<i64, _>("scope_id"))
            .execute(&mut **transaction)
            .await
            .map_err(|_| {
                ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable }
            })?;
        }
    } else {
        sqlx::query(
            "INSERT INTO analytics.reporting_scope (scope_kind, owning_source_service, external_source_id, parent_scope_id, status, reporting_timezone, source_version) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(&record.scope_kind)
        .bind(&owner)
        .bind(&record.scope_external_id)
        .bind(parent_scope_id)
        .bind(status)
        .bind(reporting_timezone)
        .bind(source_version)
        .execute(&mut **transaction)
        .await
        .map_err(|_| {
            ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable }
        })?;
    }
    sqlx::query(
        r#"INSERT INTO analytics.analytics_scope_definition_receipt (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             record_id, contract_name, schema_version, scope_kind, scope_external_id,
             source_version, payload_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)"#,
    )
    .bind(&record.producer_id)
    .bind(&authenticated.source_service)
    .bind(record_source_domain(record))
    .bind(&record.source_stream_key)
    .bind(record.source_sequence)
    .bind(&record.record_id)
    .bind(&record.contract_name)
    .bind(record.schema_version)
    .bind(&record.scope_kind)
    .bind(&record.scope_external_id)
    .bind(source_version)
    .bind(&record.payload_hash)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ValidationFailure {
        code: "analytics_unavailable",
        class: FailureClass::Retryable,
    })?;
    Ok(())
}

async fn record_failure(
    transaction: &mut Transaction<'_, Postgres>,
    record: &IngestionRecord,
    authenticated: &AuthenticatedProducer,
    failure: &ValidationFailure,
    binding: Option<&ScopeBinding>,
) -> Result<(), sqlx::Error> {
    let updated = sqlx::query(
        r#"UPDATE analytics.analytics_ingestion_failure
           SET attempt_count = attempt_count + 1, last_seen_at = NOW()
           WHERE producer_id = $1 AND record_category = $2 AND record_identity = $3
             AND payload_hash IS NOT DISTINCT FROM $4 AND safe_error_code = $5
             AND quarantine_status = 'quarantined'"#,
    )
    .bind(&record.producer_id)
    .bind(record.record_category.as_str())
    .bind(&record.record_id)
    .bind(
        validate_sha256_hex(&record.payload_hash)
            .ok()
            .map(|_| record.payload_hash.as_str()),
    )
    .bind(failure.code)
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() > 0 {
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO analytics.analytics_ingestion_failure (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             record_category, record_identity, reporting_scope_id, root_scope_id, schema_version,
             payload_hash, failure_class, safe_error_code, safe_error_summary, quarantine_status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'quarantined')"#,
    )
    .bind(&record.producer_id)
    .bind(&authenticated.source_service)
    .bind(record_source_domain(record))
    .bind(&record.source_stream_key)
    .bind(record.source_sequence)
    .bind(record.record_category.as_str())
    .bind(&record.record_id)
    .bind(binding.map(|binding| binding.reporting_scope_id))
    .bind(binding.map(|binding| binding.root_scope_id))
    .bind(record.schema_version)
    .bind(
        validate_sha256_hex(&record.payload_hash)
            .ok()
            .map(|_| record.payload_hash.as_str()),
    )
    .bind(failure.class.as_str())
    .bind(failure.code)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn validate_backfill_job(
    transaction: &mut Transaction<'_, Postgres>,
    job_id: &str,
    authenticated: &AuthenticatedProducer,
) -> Result<(), ValidationFailure> {
    let row = sqlx::query(
        "SELECT source_service, job_status FROM analytics.analytics_backfill_job WHERE job_id = $1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ValidationFailure { code: "analytics_unavailable", class: FailureClass::Retryable })?
    .ok_or(ValidationFailure { code: "backfill_not_authorized", class: FailureClass::Permanent })?;
    let source_service: String = row.get("source_service");
    let job_status: String = row.get("job_status");
    if source_service != authenticated.source_service || job_status != "running" {
        return Err(ValidationFailure {
            code: "backfill_not_authorized",
            class: FailureClass::Permanent,
        });
    }
    Ok(())
}

async fn update_backfill_count(
    transaction: &mut Transaction<'_, Postgres>,
    job_id: &str,
    accepted: bool,
) -> Result<(), sqlx::Error> {
    let column = if accepted {
        "accepted_count"
    } else {
        "rejected_count"
    };
    let query = format!(
        "UPDATE analytics.analytics_backfill_job SET scanned_count = scanned_count + 1, {column} = {column} + 1, remaining_count = CASE WHEN remaining_count IS NULL THEN NULL ELSE GREATEST(remaining_count - 1, 0) END WHERE job_id = $1"
    );
    sqlx::query(&query)
        .bind(job_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

impl RecordCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Observation => "observation",
            Self::ScopeDefinition => "scope_definition",
            Self::Manifest => "manifest",
        }
    }
}

#[cfg(test)]
mod tests {
    use actix_web::test as actix_test;

    use crate::config::IngestionCredential;

    use super::{
        advance_cursor, merge_ranges, subtract_sequence, GapRange, IngestionAuthenticator,
    };

    #[test]
    fn bearer_authentication_derives_the_registered_source_identity() {
        let authenticator = IngestionAuthenticator::new(vec![IngestionCredential {
            source_service: "core".to_string(),
            producer_id: "core-customer-analytics".to_string(),
            token_sha256: crate::config::hex_sha256(b"core-secret"),
        }]);
        let request = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer core-secret"))
            .to_http_request();
        assert_eq!(
            authenticator.authenticate(&request).unwrap().source_service,
            "core"
        );
        let spoofed = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer wrong"))
            .to_http_request();
        assert!(authenticator.authenticate(&spoofed).is_err());
    }

    #[test]
    fn cursor_tracks_out_of_order_sequences_and_closes_gaps() {
        let state = advance_cursor(0, 0, Vec::new(), 3);
        assert_eq!(state.0, 3);
        assert_eq!(state.1, 0);
        assert_eq!(state.2[0].start, 1);
        assert_eq!(state.2[0].end, 2);

        let state = advance_cursor(state.0, state.1, state.2, 1);
        assert_eq!(state.1, 1);
        let state = advance_cursor(state.0, state.1, state.2, 2);
        assert_eq!(state.1, 3);
        assert!(state.2.is_empty());
    }

    #[test]
    fn gap_ranges_are_merged_and_split_without_losing_missing_sequences() {
        let merged = merge_ranges(vec![
            GapRange { start: 4, end: 6 },
            GapRange { start: 1, end: 2 },
            GapRange { start: 3, end: 3 },
        ]);
        assert_eq!(merged, vec![GapRange { start: 1, end: 6 }]);
        assert_eq!(
            subtract_sequence(merged, 3),
            vec![GapRange { start: 1, end: 2 }, GapRange { start: 4, end: 6 }]
        );
    }
}
