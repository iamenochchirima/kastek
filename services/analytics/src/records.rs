use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const SHA256_HEX_LENGTH: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordCategory {
    Event,
    Observation,
    ScopeDefinition,
    Manifest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecordIdentity {
    pub producer_id: String,
    pub source_stream_key: String,
    pub record_category: RecordCategory,
    pub record_id: String,
    pub source_sequence: u64,
    pub payload_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScopeBinding {
    pub reporting_scope_id: i64,
    pub root_scope_id: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObservationWindow {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RecordValidationError {
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("{field} must be positive")]
    NonPositiveScope { field: &'static str },
    #[error("source sequence cannot exceed the signed 64-bit database range")]
    SourceSequenceOutOfRange,
    #[error("payload hash must be lowercase SHA-256 hex")]
    InvalidPayloadHash,
    #[error("payload hash does not match the canonical payload")]
    PayloadHashMismatch,
    #[error("observation window must end after it starts")]
    InvalidObservationWindow,
}

pub fn validate_record_identity(identity: &RecordIdentity) -> Result<(), RecordValidationError> {
    require_non_empty(&identity.producer_id, "producer_id")?;
    require_non_empty(&identity.source_stream_key, "source_stream_key")?;
    require_non_empty(&identity.record_id, "record_id")?;
    if identity.source_sequence > i64::MAX as u64 {
        return Err(RecordValidationError::SourceSequenceOutOfRange);
    }
    validate_sha256_hex(&identity.payload_hash)
}

pub fn validate_scope_binding(binding: &ScopeBinding) -> Result<(), RecordValidationError> {
    if binding.reporting_scope_id <= 0 {
        return Err(RecordValidationError::NonPositiveScope {
            field: "reporting_scope_id",
        });
    }
    if binding.root_scope_id <= 0 {
        return Err(RecordValidationError::NonPositiveScope {
            field: "root_scope_id",
        });
    }
    Ok(())
}

pub fn validate_observation_window(
    window: &ObservationWindow,
) -> Result<(), RecordValidationError> {
    if window.end <= window.start {
        return Err(RecordValidationError::InvalidObservationWindow);
    }
    Ok(())
}

pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&canonicalize(value))
}

pub fn canonical_payload_sha256(value: &Value) -> Result<String, serde_json::Error> {
    let bytes = canonical_json_bytes(value)?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn validate_payload_hash(
    value: &Value,
    expected_hash: &str,
) -> Result<(), RecordValidationError> {
    validate_sha256_hex(expected_hash)?;
    let actual_hash =
        canonical_payload_sha256(value).map_err(|_| RecordValidationError::PayloadHashMismatch)?;
    if actual_hash != expected_hash {
        return Err(RecordValidationError::PayloadHashMismatch);
    }
    Ok(())
}

pub fn validate_sha256_hex(value: &str) -> Result<(), RecordValidationError> {
    if value.len() != SHA256_HEX_LENGTH
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RecordValidationError::InvalidPayloadHash);
    }
    Ok(())
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), RecordValidationError> {
    if value.trim().is_empty() {
        return Err(RecordValidationError::EmptyField { field });
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::{
        canonical_payload_sha256, validate_observation_window, validate_payload_hash,
        validate_record_identity, validate_scope_binding, ObservationWindow, RecordCategory,
        RecordIdentity, RecordValidationError, ScopeBinding,
    };

    #[test]
    fn canonical_hash_is_independent_of_object_key_order() {
        let left = json!({"z": 1, "a": {"b": true, "a": false}});
        let right = json!({"a": {"a": false, "b": true}, "z": 1});
        assert_eq!(
            canonical_payload_sha256(&left).unwrap(),
            canonical_payload_sha256(&right).unwrap()
        );
    }

    #[test]
    fn validates_record_identity_and_payload_hash() {
        let payload = json!({"event": "completed", "count": 1});
        let hash = canonical_payload_sha256(&payload).unwrap();
        let identity = RecordIdentity {
            producer_id: "core-customer-analytics".to_string(),
            source_stream_key: "core:org-1".to_string(),
            record_category: RecordCategory::Event,
            record_id: "event-1".to_string(),
            source_sequence: 1,
            payload_hash: hash.clone(),
        };
        validate_record_identity(&identity).unwrap();
        validate_payload_hash(&payload, &hash).unwrap();
        assert_eq!(
            validate_payload_hash(&json!({"event": "failed"}), &hash).unwrap_err(),
            RecordValidationError::PayloadHashMismatch
        );
    }

    #[test]
    fn validates_scope_and_observation_boundaries() {
        validate_scope_binding(&ScopeBinding {
            reporting_scope_id: 2,
            root_scope_id: 1,
        })
        .unwrap();
        assert_eq!(
            validate_scope_binding(&ScopeBinding {
                reporting_scope_id: 0,
                root_scope_id: 1,
            })
            .unwrap_err(),
            RecordValidationError::NonPositiveScope {
                field: "reporting_scope_id"
            }
        );
        validate_observation_window(&ObservationWindow {
            start: Utc.timestamp_opt(0, 0).unwrap(),
            end: Utc.timestamp_opt(1, 0).unwrap(),
        })
        .unwrap();
    }
}
