//! Shared Rust producer and source-outbox primitives for Core and Tenant Platform.
//!
//! This crate deliberately knows nothing about either service's domain schema. It builds the
//! repository-owned analytics envelope, validates producer-safe payloads, and provides the common
//! transactional outbox/lease operations. The Analytics HTTP transport is injected by a later
//! ingestion package.

use std::{collections::BTreeSet, time::Duration};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgRow, PgPool, Postgres, Row, Transaction};
use thiserror::Error;
use uuid::Uuid;

pub const CORE_SOURCE_SERVICE: &str = "core";
pub const TENANT_SOURCE_SERVICE: &str = "tenant-platform";
pub const MAX_OUTBOX_BATCH_SIZE: i64 = 500;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordCategory {
    Event,
    Observation,
    ScopeDefinition,
}

impl RecordCategory {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Observation => "observation",
            Self::ScopeDefinition => "scope_definition",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    CoreOrganization,
    TenantWorkspace,
    TenantClient,
}

impl ScopeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CoreOrganization => "core_organization",
            Self::TenantWorkspace => "tenant_workspace",
            Self::TenantClient => "tenant_client",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProducerConfig {
    pub source_service: String,
    pub source_namespace: String,
    pub source_origin: String,
}

impl ProducerConfig {
    pub fn core() -> Self {
        Self {
            source_service: CORE_SOURCE_SERVICE.to_string(),
            source_namespace: "core".to_string(),
            source_origin: "kasitek://core".to_string(),
        }
    }

    pub fn tenant_platform() -> Self {
        Self {
            source_service: TENANT_SOURCE_SERVICE.to_string(),
            source_namespace: "tenant-platform".to_string(),
            source_origin: "kasitek://tenant-platform".to_string(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct EventInput {
    pub record_id: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: ScopeKind,
    pub scope_external_id: String,
    pub subject_type: String,
    pub subject_id: String,
    pub occurred_at: DateTime<Utc>,
    pub attributes: Value,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ObservationInput {
    pub record_id: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: ScopeKind,
    pub scope_external_id: String,
    pub provider: String,
    pub provider_account_ref: Option<String>,
    pub connection_ref: Option<String>,
    pub metric_key: String,
    pub numeric_value: Value,
    pub unit: String,
    pub reporting_window_start: DateTime<Utc>,
    pub reporting_window_end: DateTime<Utc>,
    pub observed_at: DateTime<Utc>,
    pub synchronization_run_id: String,
    pub dimensions: Value,
    pub source_evidence: Value,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ScopeDefinitionInput {
    pub record_id: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: ScopeKind,
    pub scope_external_id: String,
    pub parent_scope_external_id: Option<String>,
    pub reporting_timezone: String,
    pub status: String,
    pub source_version: i64,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnalyticsEnvelope {
    pub specversion: String,
    pub id: String,
    pub source: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub subject: String,
    pub time: DateTime<Utc>,
    pub datacontenttype: String,
    pub dataschema: String,
    pub source_service: String,
    pub source_domain: String,
    pub record_category: RecordCategory,
    pub scope_kind: ScopeKind,
    pub scope_external_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub data: Value,
}

#[derive(Clone, Debug)]
pub struct AnalyticsOutboxRecord {
    pub outbox_id: String,
    pub source_service: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub record_category: RecordCategory,
    pub record_id: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: ScopeKind,
    pub scope_external_id: String,
    pub idempotency_key: String,
    pub envelope: Value,
    pub payload_hash: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProducerValidationError {
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("unsupported producer service {0}")]
    UnsupportedSourceService(String),
    #[error("schema version must be positive")]
    InvalidSchemaVersion,
    #[error("contract name must match the versioned analytics contract format")]
    InvalidContractName,
    #[error("analytics attributes must be a JSON object")]
    AttributesMustBeObject,
    #[error("analytics payload contains prohibited field {0}")]
    ProhibitedField(String),
    #[error("observation window must end after it starts")]
    InvalidObservationWindow,
    #[error("numeric observation value must be a JSON number")]
    InvalidNumericValue,
    #[error("source identity exceeds the database limit")]
    IdentityTooLong,
    #[error("payload serialization failed: {0}")]
    Serialization(String),
}

#[derive(Debug, Error)]
pub enum ProducerError {
    #[error(transparent)]
    Validation(#[from] ProducerValidationError),
    #[error("analytics outbox database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("outbox row {0} is not leased by this publisher")]
    LeaseOwnership(String),
    #[error("outbox batch size must be between 1 and {MAX_OUTBOX_BATCH_SIZE}")]
    InvalidBatchSize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnqueueResult {
    Inserted {
        outbox_id: String,
        source_sequence: i64,
    },
    Duplicate {
        outbox_id: String,
    },
    Conflict {
        outbox_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryOutcome {
    Accepted,
    Duplicate,
    Retryable {
        error_code: String,
        retry_at: DateTime<Utc>,
    },
    Quarantined {
        error_code: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxRow {
    pub outbox_id: String,
    pub source_sequence: i64,
    pub source_service: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub record_category: String,
    pub record_id: String,
    pub contract_name: String,
    pub schema_version: i32,
    pub scope_kind: String,
    pub scope_external_id: String,
    pub idempotency_key: String,
    pub envelope: Value,
    pub payload_hash: String,
    pub delivery_status: String,
    pub attempt_count: i32,
    pub next_attempt_at: DateTime<Utc>,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter_window: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_secs(2),
            max_delay: Duration::from_secs(300),
            jitter_window: Duration::from_secs(2),
        }
    }
}

impl RetryPolicy {
    pub fn next_retry_at(
        self,
        now: DateTime<Utc>,
        attempt: i32,
        stable_seed: &str,
    ) -> DateTime<Utc> {
        let exponent = attempt.saturating_sub(1).min(16) as u32;
        let exponential = self
            .base_delay
            .as_secs()
            .saturating_mul(2u64.saturating_pow(exponent));
        let capped = exponential.min(self.max_delay.as_secs());
        let jitter = if self.jitter_window.is_zero() {
            0
        } else {
            let digest = Sha256::digest(format!("{stable_seed}:{attempt}").as_bytes());
            let seed = u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 has eight bytes"));
            seed % (self.jitter_window.as_secs().saturating_add(1))
        };
        now + chrono::Duration::seconds(capped.saturating_add(jitter) as i64)
    }
}

pub fn build_event(
    config: &ProducerConfig,
    input: EventInput,
) -> Result<AnalyticsOutboxRecord, ProducerValidationError> {
    validate_common(
        config,
        &input.record_id,
        &input.source_domain,
        &input.source_stream_key,
        &input.contract_name,
        input.schema_version,
        input.scope_external_id.as_str(),
        &input.attributes,
    )?;
    require_subject(&input.subject_type, &input.subject_id)?;

    let envelope = AnalyticsEnvelope {
        specversion: "1.0".to_string(),
        id: Uuid::new_v4().to_string(),
        source: config.source_origin.clone(),
        event_type: input.contract_name.clone(),
        subject: format!("{}:{}", input.subject_type, input.subject_id),
        time: input.occurred_at,
        datacontenttype: "application/json".to_string(),
        dataschema: schema_uri(&input.contract_name, input.schema_version),
        source_service: config.source_service.clone(),
        source_domain: input.source_domain.clone(),
        record_category: RecordCategory::Event,
        scope_kind: input.scope_kind,
        scope_external_id: input.scope_external_id.clone(),
        correlation_id: input.correlation_id,
        causation_id: input.causation_id,
        idempotency_key: Some(
            input
                .idempotency_key
                .clone()
                .unwrap_or_else(|| input.record_id.clone()),
        ),
        data: input.attributes,
    };
    record_from_envelope(
        config,
        RecordCategory::Event,
        input.record_id,
        input.source_domain,
        input.source_stream_key,
        input.contract_name,
        input.schema_version,
        input.scope_kind,
        input.scope_external_id,
        envelope,
        input.idempotency_key,
    )
}

pub fn build_observation(
    config: &ProducerConfig,
    input: ObservationInput,
) -> Result<AnalyticsOutboxRecord, ProducerValidationError> {
    validate_common(
        config,
        &input.record_id,
        &input.source_domain,
        &input.source_stream_key,
        &input.contract_name,
        input.schema_version,
        input.scope_external_id.as_str(),
        &input.dimensions,
    )?;
    require_non_empty(&input.provider, "provider")?;
    require_non_empty(&input.metric_key, "metric_key")?;
    require_non_empty(&input.unit, "unit")?;
    require_non_empty(&input.synchronization_run_id, "synchronization_run_id")?;
    if !input.numeric_value.is_number() {
        return Err(ProducerValidationError::InvalidNumericValue);
    }
    if input.reporting_window_end <= input.reporting_window_start {
        return Err(ProducerValidationError::InvalidObservationWindow);
    }
    validate_object(&input.dimensions)?;
    validate_object(&input.source_evidence)?;
    reject_prohibited_fields(&input.source_evidence)?;

    let data = json!({
        "provider": input.provider,
        "provider_account_ref": input.provider_account_ref,
        "connection_ref": input.connection_ref,
        "metric_key": input.metric_key,
        "numeric_value": input.numeric_value,
        "unit": input.unit,
        "reporting_window_start": input.reporting_window_start,
        "reporting_window_end": input.reporting_window_end,
        "observed_at": input.observed_at,
        "synchronization_run_id": input.synchronization_run_id,
        "dimensions": input.dimensions,
        "source_evidence": input.source_evidence,
    });
    let envelope = AnalyticsEnvelope {
        specversion: "1.0".to_string(),
        id: Uuid::new_v4().to_string(),
        source: config.source_origin.clone(),
        event_type: input.contract_name.clone(),
        subject: format!("metric:{}", input.metric_key),
        time: input.observed_at,
        datacontenttype: "application/json".to_string(),
        dataschema: schema_uri(&input.contract_name, input.schema_version),
        source_service: config.source_service.clone(),
        source_domain: input.source_domain.clone(),
        record_category: RecordCategory::Observation,
        scope_kind: input.scope_kind,
        scope_external_id: input.scope_external_id.clone(),
        correlation_id: input.correlation_id,
        causation_id: None,
        idempotency_key: Some(
            input
                .idempotency_key
                .clone()
                .unwrap_or_else(|| input.record_id.clone()),
        ),
        data,
    };
    record_from_envelope(
        config,
        RecordCategory::Observation,
        input.record_id,
        input.source_domain,
        input.source_stream_key,
        input.contract_name,
        input.schema_version,
        input.scope_kind,
        input.scope_external_id,
        envelope,
        input.idempotency_key,
    )
}

pub fn build_scope_definition(
    config: &ProducerConfig,
    input: ScopeDefinitionInput,
) -> Result<AnalyticsOutboxRecord, ProducerValidationError> {
    let data = json!({
        "scope_kind": input.scope_kind,
        "scope_external_id": input.scope_external_id,
        "parent_scope_external_id": input.parent_scope_external_id,
        "reporting_timezone": input.reporting_timezone,
        "status": input.status,
        "source_version": input.source_version,
    });
    validate_common(
        config,
        &input.record_id,
        &input.source_domain,
        &input.source_stream_key,
        &input.contract_name,
        input.schema_version,
        &input.scope_external_id,
        &data,
    )?;
    require_non_empty(&input.reporting_timezone, "reporting_timezone")?;
    require_non_empty(&input.status, "status")?;
    if input.source_version <= 0 {
        return Err(ProducerValidationError::InvalidSchemaVersion);
    }
    let envelope = AnalyticsEnvelope {
        specversion: "1.0".to_string(),
        id: Uuid::new_v4().to_string(),
        source: config.source_origin.clone(),
        event_type: input.contract_name.clone(),
        subject: format!("scope:{}", input.scope_external_id),
        time: Utc::now(),
        datacontenttype: "application/json".to_string(),
        dataschema: schema_uri(&input.contract_name, input.schema_version),
        source_service: config.source_service.clone(),
        source_domain: input.source_domain.clone(),
        record_category: RecordCategory::ScopeDefinition,
        scope_kind: input.scope_kind,
        scope_external_id: input.scope_external_id.clone(),
        correlation_id: None,
        causation_id: None,
        idempotency_key: Some(
            input
                .idempotency_key
                .clone()
                .unwrap_or_else(|| input.record_id.clone()),
        ),
        data,
    };
    record_from_envelope(
        config,
        RecordCategory::ScopeDefinition,
        input.record_id,
        input.source_domain,
        input.source_stream_key,
        input.contract_name,
        input.schema_version,
        input.scope_kind,
        input.scope_external_id,
        envelope,
        input.idempotency_key,
    )
}

// The arguments map directly to the immutable outbox identity columns. Keeping them explicit
// makes it harder to accidentally omit a source or scope field when a new record builder is added.
#[allow(clippy::too_many_arguments)]
fn record_from_envelope(
    config: &ProducerConfig,
    category: RecordCategory,
    record_id: String,
    source_domain: String,
    source_stream_key: String,
    contract_name: String,
    schema_version: i32,
    scope_kind: ScopeKind,
    scope_external_id: String,
    envelope: AnalyticsEnvelope,
    idempotency_key: Option<String>,
) -> Result<AnalyticsOutboxRecord, ProducerValidationError> {
    let payload_hash = canonical_json_sha256(&envelope.data)?;
    let envelope_value = serde_json::to_value(envelope)
        .map_err(|error| ProducerValidationError::Serialization(error.to_string()))?;
    let idempotency_key = idempotency_key.unwrap_or_else(|| record_id.clone());
    let outbox_id = format!(
        "{}:{}:{}",
        config.source_service,
        category.as_str(),
        record_id
    );
    if outbox_id.len() > 512 {
        return Err(ProducerValidationError::IdentityTooLong);
    }
    Ok(AnalyticsOutboxRecord {
        outbox_id,
        source_service: config.source_service.clone(),
        source_domain,
        source_stream_key,
        record_category: category,
        record_id,
        contract_name,
        schema_version,
        scope_kind,
        scope_external_id,
        idempotency_key,
        envelope: envelope_value,
        payload_hash,
    })
}

#[allow(clippy::too_many_arguments)]
fn validate_common(
    config: &ProducerConfig,
    record_id: &str,
    source_domain: &str,
    source_stream_key: &str,
    contract_name: &str,
    schema_version: i32,
    scope_external_id: &str,
    payload: &Value,
) -> Result<(), ProducerValidationError> {
    if !matches!(
        config.source_service.as_str(),
        CORE_SOURCE_SERVICE | TENANT_SOURCE_SERVICE
    ) {
        return Err(ProducerValidationError::UnsupportedSourceService(
            config.source_service.clone(),
        ));
    }
    for (value, field) in [
        (record_id, "record_id"),
        (source_domain, "source_domain"),
        (source_stream_key, "source_stream_key"),
        (scope_external_id, "scope_external_id"),
    ] {
        require_non_empty(value, field)?;
    }
    if schema_version <= 0 {
        return Err(ProducerValidationError::InvalidSchemaVersion);
    }
    if !is_versioned_contract_name(contract_name) {
        return Err(ProducerValidationError::InvalidContractName);
    }
    validate_object(payload)?;
    reject_prohibited_fields(payload)?;
    if record_id.len() > 512 || source_stream_key.len() > 512 || scope_external_id.len() > 512 {
        return Err(ProducerValidationError::IdentityTooLong);
    }
    Ok(())
}

fn require_subject(subject_type: &str, subject_id: &str) -> Result<(), ProducerValidationError> {
    require_non_empty(subject_type, "subject_type")?;
    require_non_empty(subject_id, "subject_id")
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), ProducerValidationError> {
    if value.trim().is_empty() {
        return Err(ProducerValidationError::EmptyField { field });
    }
    Ok(())
}

fn validate_object(value: &Value) -> Result<(), ProducerValidationError> {
    if !value.is_object() {
        return Err(ProducerValidationError::AttributesMustBeObject);
    }
    Ok(())
}

fn is_versioned_contract_name(value: &str) -> bool {
    let Some((name, version)) = value.rsplit_once('@') else {
        return false;
    };
    !name.is_empty()
        && version.parse::<u32>().is_ok_and(|version| version > 0)
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && name.as_bytes()[0].is_ascii_lowercase()
}

fn schema_uri(contract_name: &str, schema_version: i32) -> String {
    format!(
        "https://kasitek.co.za/analytics/contracts/{}/v{}.schema.json",
        contract_name.replace('@', "/"),
        schema_version
    )
}

fn reject_prohibited_fields(value: &Value) -> Result<(), ProducerValidationError> {
    let prohibited = BTreeSet::from([
        "body",
        "content",
        "credential",
        "email",
        "password",
        "phone",
        "prompt",
        "raw_payload",
        "response",
        "secret",
        "token",
    ]);
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if prohibited.contains(key.to_ascii_lowercase().as_str()) {
                        return Err(ProducerValidationError::ProhibitedField(key.clone()));
                    }
                    stack.push(child);
                }
            }
            Value::Array(values) => stack.extend(values),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
    Ok(())
}

pub fn canonical_json_sha256(value: &Value) -> Result<String, ProducerValidationError> {
    let canonical = canonicalize(value);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|error| ProducerValidationError::Serialization(error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut canonical = Map::new();
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                canonical.insert(key.clone(), canonicalize(value));
            }
            Value::Object(canonical)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        value => value.clone(),
    }
}

pub async fn enqueue_outbox(
    transaction: &mut Transaction<'_, Postgres>,
    record: &AnalyticsOutboxRecord,
) -> Result<EnqueueResult, ProducerError> {
    let inserted = sqlx::query(
        r#"
        INSERT INTO analytics_outbox (
            outbox_id, source_service, source_domain, source_stream_key, record_category,
            record_id, contract_name, schema_version, scope_kind, scope_external_id,
            idempotency_key, envelope, payload_hash
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (source_service, record_category, record_id) DO NOTHING
        RETURNING outbox_id, source_sequence
        "#,
    )
    .bind(&record.outbox_id)
    .bind(&record.source_service)
    .bind(&record.source_domain)
    .bind(&record.source_stream_key)
    .bind(record.record_category.as_str())
    .bind(&record.record_id)
    .bind(&record.contract_name)
    .bind(record.schema_version)
    .bind(record.scope_kind.as_str())
    .bind(&record.scope_external_id)
    .bind(&record.idempotency_key)
    .bind(&record.envelope)
    .bind(&record.payload_hash)
    .fetch_optional(&mut **transaction)
    .await?;

    if let Some(row) = inserted {
        return Ok(EnqueueResult::Inserted {
            outbox_id: row.get("outbox_id"),
            source_sequence: row.get("source_sequence"),
        });
    }

    let existing = sqlx::query(
        "SELECT outbox_id, payload_hash FROM analytics_outbox WHERE source_service = $1 AND record_category = $2 AND record_id = $3",
    )
    .bind(&record.source_service)
    .bind(record.record_category.as_str())
    .bind(&record.record_id)
    .fetch_one(&mut **transaction)
    .await?;
    let outbox_id: String = existing.get("outbox_id");
    let payload_hash: String = existing.get("payload_hash");
    if payload_hash == record.payload_hash {
        Ok(EnqueueResult::Duplicate { outbox_id })
    } else {
        Ok(EnqueueResult::Conflict { outbox_id })
    }
}

pub async fn claim_outbox_batch(
    pool: &PgPool,
    publisher_id: &str,
    batch_size: i64,
    now: DateTime<Utc>,
    lease_duration: Duration,
) -> Result<Vec<OutboxRow>, ProducerError> {
    if publisher_id.trim().is_empty() || !(1..=MAX_OUTBOX_BATCH_SIZE).contains(&batch_size) {
        return Err(ProducerError::InvalidBatchSize);
    }
    let lease_expires_at = now
        + chrono::Duration::from_std(lease_duration)
            .map_err(|_| ProducerError::InvalidBatchSize)?;
    let rows = sqlx::query(
        r#"
        WITH claimable AS (
            SELECT outbox_id
            FROM analytics_outbox
            WHERE (
                (delivery_status = 'pending' AND next_attempt_at <= $1)
                OR (delivery_status = 'leased' AND lease_expires_at <= $1)
            )
            ORDER BY source_sequence
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        )
        UPDATE analytics_outbox AS outbox
        SET delivery_status = 'leased',
            attempt_count = outbox.attempt_count + 1,
            lease_owner = $3,
            lease_expires_at = $4,
            updated_at = $1
        FROM claimable
        WHERE outbox.outbox_id = claimable.outbox_id
        RETURNING outbox.*
        "#,
    )
    .bind(now)
    .bind(batch_size)
    .bind(publisher_id)
    .bind(lease_expires_at)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(outbox_row).collect()
}

pub async fn release_expired_leases(
    pool: &PgPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<u64, ProducerError> {
    if !(1..=MAX_OUTBOX_BATCH_SIZE).contains(&limit) {
        return Err(ProducerError::InvalidBatchSize);
    }
    let result = sqlx::query(
        r#"
        WITH expired AS (
            SELECT outbox_id
            FROM analytics_outbox
            WHERE delivery_status = 'leased' AND lease_expires_at <= $1
            ORDER BY source_sequence
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        )
        UPDATE analytics_outbox AS outbox
        SET delivery_status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
        FROM expired
        WHERE outbox.outbox_id = expired.outbox_id
        "#,
    )
    .bind(now)
    .bind(limit)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn apply_delivery_outcome(
    pool: &PgPool,
    outbox_id: &str,
    publisher_id: &str,
    outcome: DeliveryOutcome,
) -> Result<(), ProducerError> {
    let result = match outcome {
        DeliveryOutcome::Accepted | DeliveryOutcome::Duplicate => sqlx::query(
            "UPDATE analytics_outbox SET delivery_status = 'delivered', lease_owner = NULL, lease_expires_at = NULL, delivered_at = NOW(), updated_at = NOW() WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2",
        )
        .bind(outbox_id)
        .bind(publisher_id)
        .execute(pool)
        .await?,
        DeliveryOutcome::Retryable { error_code, retry_at } => sqlx::query(
            "UPDATE analytics_outbox SET delivery_status = 'pending', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = $3, last_error_code = $4, updated_at = NOW() WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2",
        )
        .bind(outbox_id)
        .bind(publisher_id)
        .bind(retry_at)
        .bind(error_code)
        .execute(pool)
        .await?,
        DeliveryOutcome::Quarantined { error_code } => sqlx::query(
            "UPDATE analytics_outbox SET delivery_status = 'quarantined', lease_owner = NULL, lease_expires_at = NULL, quarantined_at = NOW(), last_error_code = $3, updated_at = NOW() WHERE outbox_id = $1 AND delivery_status = 'leased' AND lease_owner = $2",
        )
        .bind(outbox_id)
        .bind(publisher_id)
        .bind(error_code)
        .execute(pool)
        .await?,
    };
    if result.rows_affected() == 0 {
        return Err(ProducerError::LeaseOwnership(outbox_id.to_string()));
    }
    Ok(())
}

fn outbox_row(row: PgRow) -> Result<OutboxRow, ProducerError> {
    Ok(OutboxRow {
        outbox_id: row.get("outbox_id"),
        source_sequence: row.get("source_sequence"),
        source_service: row.get("source_service"),
        source_domain: row.get("source_domain"),
        source_stream_key: row.get("source_stream_key"),
        record_category: row.get("record_category"),
        record_id: row.get("record_id"),
        contract_name: row.get("contract_name"),
        schema_version: row.get("schema_version"),
        scope_kind: row.get("scope_kind"),
        scope_external_id: row.get("scope_external_id"),
        idempotency_key: row.get("idempotency_key"),
        envelope: row.get("envelope"),
        payload_hash: row.get("payload_hash"),
        delivery_status: row.get("delivery_status"),
        attempt_count: row.get("attempt_count"),
        next_attempt_at: row.get("next_attempt_at"),
        lease_owner: row.get("lease_owner"),
        lease_expires_at: row.get("lease_expires_at"),
    })
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::{
        build_event, canonical_json_sha256, EventInput, ProducerConfig, ProducerValidationError,
        RetryPolicy, ScopeKind,
    };

    fn event(attributes: serde_json::Value) -> EventInput {
        EventInput {
            record_id: "event-1".to_string(),
            source_domain: "campaigns".to_string(),
            source_stream_key: "core:org-1".to_string(),
            contract_name: "campaign.recipient_sent@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: "org-1".to_string(),
            subject_type: "recipient".to_string(),
            subject_id: "recipient-1".to_string(),
            occurred_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            attributes,
            correlation_id: None,
            causation_id: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn builds_cloud_events_compatible_record_with_stable_payload_hash() {
        let record = build_event(&ProducerConfig::core(), event(json!({"count": 1}))).unwrap();
        assert_eq!(record.record_category.as_str(), "event");
        assert_eq!(
            record.payload_hash,
            canonical_json_sha256(&json!({"count": 1})).unwrap()
        );
        assert_eq!(record.envelope["specversion"], "1.0");
        assert!(record.envelope["id"].as_str().unwrap().len() > 20);
    }

    #[test]
    fn rejects_prohibited_customer_content_before_transaction() {
        let error =
            build_event(&ProducerConfig::core(), event(json!({"content": "secret"}))).unwrap_err();
        assert_eq!(
            error,
            ProducerValidationError::ProhibitedField("content".to_string())
        );
    }

    #[test]
    fn rejects_invalid_contract_and_observation_boundaries() {
        let mut invalid = event(json!({}));
        invalid.contract_name = "Campaign.Sent".to_string();
        assert_eq!(
            build_event(&ProducerConfig::core(), invalid).unwrap_err(),
            ProducerValidationError::InvalidContractName
        );
    }

    #[test]
    fn retry_backoff_is_capped_and_deterministically_jittered() {
        let policy = RetryPolicy::default();
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let first = policy.next_retry_at(now, 1, "outbox-1");
        let second = policy.next_retry_at(now, 1, "outbox-1");
        let late = policy.next_retry_at(now, 99, "outbox-1");
        assert_eq!(first, second);
        assert!(first > now);
        assert!(late <= now + chrono::Duration::seconds(302));
    }
}
