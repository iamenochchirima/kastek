//! Core Connections analytics facts.
//!
//! Only stable internal references and bounded state values cross the analytics boundary. Provider
//! identifiers, display fields, credentials, metadata, and raw health errors remain in Core.

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sqlx::{Postgres, Transaction};

use analytics_producer::{EnqueueResult, EventInput, ManifestInput, ScopeKind};

use super::{enqueue_event, enqueue_manifest as enqueue_source_manifest};

const SOURCE_DOMAIN: &str = "connections";
const MANIFEST_KEY: &str = "core.connections";
const MANIFEST_REFRESH_SECONDS: i64 = 3_600;
const SUPPORTED_CONTRACTS: &[&str] = &[
    "connection.lifecycle@1",
    "connection.health_check@1",
    "connection.capability.lifecycle@1",
    "connection.sync_attempt@1",
    "connection.rate_limit@1",
    "connection.incident.lifecycle@1",
];
const SUPPORTED_METRICS: &[&str] = &[
    "connection.lifecycle_events",
    "connection.health_checks",
    "connection.capability_events",
    "connection.sync_attempts",
    "connection.rate_limit_encounters",
    "connection.incidents",
];
const SUPPORTED_DIMENSIONS: &[&str] = &[
    "provider",
    "lifecycle_action",
    "status",
    "connection_health_status",
    "connection_credential_status",
    "connection_webhook_status",
    "capability",
    "connection_sync_operation",
    "outcome",
    "failure_class",
    "rate_limit_scope",
    "incident_severity",
    "incident_reason_code",
];

/// Enqueue one organization-scoped Connections capability/coverage manifest per observed refresh
/// window. This is evidence from a successful synchronization, not an independent scheduler.
///
/// The current ExternalConnection row count is an authoritative source checkpoint for the
/// organization's current connection population. It is deliberately not presented as a reliable
/// historical coverage boundary: the event history still needs a domain backfill and Analytics
/// reconciliation before that boundary can be set.
pub async fn enqueue_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_count: i64,
    collected_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let manifest_version = manifest_version(collected_at);
    let source_stream_key = stream_key(organization_id);
    let record_id = format!("manifest:{source_stream_key}:{MANIFEST_KEY}:{manifest_version}");
    let result = enqueue_source_manifest(
        transaction,
        ManifestInput {
            record_id,
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key,
            contract_name: "source.manifest@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            manifest_key: MANIFEST_KEY.to_string(),
            manifest_version,
            provider: None,
            connection_ref: None,
            supported_contracts: SUPPORTED_CONTRACTS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            supported_observation_contracts: Vec::new(),
            supported_metrics: SUPPORTED_METRICS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            supported_dimensions: SUPPORTED_DIMENSIONS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            expected_refresh_seconds: MANIFEST_REFRESH_SECONDS,
            reliable_coverage_start: None,
            highest_authoritative_source_sequence: None,
            approved_checkpoint_count: Some(connection_count),
            approved_checkpoint_hash: None,
            last_successful_collection_at: Some(collected_at),
            last_attempted_collection_at: Some(collected_at),
            safe_failure_code: None,
            next_expected_at: Some(collected_at + Duration::seconds(MANIFEST_REFRESH_SECONDS)),
            manifest_state: "active".to_string(),
            generated_at: collected_at,
            idempotency_key: None,
        },
    )
    .await?;

    // A refresh can be requested more than once in the same hourly window. The source manifest is
    // immutable, so the first successful observation wins that window; a concurrent writer's
    // same-window identity conflict is an intentional coalescing duplicate, not a failed sync.
    Ok(match result {
        EnqueueResult::Conflict { outbox_id } => EnqueueResult::Duplicate { outbox_id },
        result => result,
    })
}

fn manifest_version(collected_at: DateTime<Utc>) -> i64 {
    collected_at
        .timestamp()
        .div_euclid(MANIFEST_REFRESH_SECONDS)
        .max(1)
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    action: &str,
    status: &str,
    credential_status: &str,
    health_status: &str,
    webhook_status: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "connection:{connection_id}:lifecycle:{action}:{}",
        occurred_at.timestamp_micros()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at,
            attributes: json!({
                "connection_id": connection_id,
                "provider": provider,
                "action": action,
                "status": status,
                "credential_status": credential_status,
                "health_status": health_status,
                "webhook_status": webhook_status,
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_health_check(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    status: &str,
    health_status: &str,
    credential_status: &str,
    webhook_status: &str,
    healthy: bool,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "connection:{connection_id}:health:{}",
        occurred_at.timestamp_micros()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.health_check@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at,
            attributes: json!({
                "connection_id": connection_id,
                "provider": provider,
                "status": status,
                "health_status": health_status,
                "credential_status": credential_status,
                "webhook_status": webhook_status,
                "check_result": if healthy { "healthy" } else { "unhealthy" },
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_capability_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    capability: &str,
    enabled: bool,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let action = if enabled { "enabled" } else { "disabled" };
    let record_id = format!(
        "connection:{connection_id}:capability:{capability}:{action}:{}",
        occurred_at.timestamp_micros()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.capability.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at,
            attributes: json!({
                "connection_id": connection_id,
                "provider": provider,
                "capability": capability,
                "action": action,
                "enabled": enabled,
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_sync_attempt(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    attempt_id: &str,
    operation: &str,
    outcome: &str,
    failure_class: &str,
    duration_ms: i64,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!("connection:{connection_id}:sync:{attempt_id}");
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.sync_attempt@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at,
            attributes: json!({
                "attempt_id": attempt_id,
                "connection_id": connection_id,
                "provider": provider,
                "operation": operation,
                "outcome": outcome,
                "failure_class": failure_class,
                "duration_ms": duration_ms,
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_rate_limit(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    operation: &str,
    rate_limit_scope: &str,
    retry_after_seconds: Option<i64>,
    observed_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "connection:{connection_id}:rate-limit:{operation}:{}",
        observed_at.timestamp_micros()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.rate_limit@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at: observed_at,
            attributes: json!({
                "connection_id": connection_id,
                "provider": provider,
                "operation": operation,
                "rate_limit_scope": rate_limit_scope,
                "retry_after_seconds": retry_after_seconds,
                "observed_at": observed_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_incident_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    connection_id: &str,
    provider: &str,
    incident_key: &str,
    action: &str,
    severity: &str,
    reason_code: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "connection:{connection_id}:incident:{incident_key}:{action}:{}",
        occurred_at.timestamp_micros()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "connection.incident.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "connection".to_string(),
            subject_id: connection_id.to_string(),
            occurred_at,
            attributes: json!({
                "connection_id": connection_id,
                "provider": provider,
                "incident_key": incident_key,
                "action": action,
                "severity": severity,
                "reason_code": reason_code,
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

pub fn lifecycle_action(status: &str) -> &'static str {
    match status {
        "CONNECTED" => "connected",
        "DISCONNECTED" => "disconnected",
        "REVOKED" => "revoked",
        "NEEDS_ATTENTION" => "needs_attention",
        _ => "needs_attention",
    }
}

fn stream_key(organization_id: &str) -> String {
    format!("organization:{organization_id}:connections")
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone, Utc};

    use super::{lifecycle_action, manifest_version, stream_key};

    #[test]
    fn lifecycle_actions_are_bounded() {
        assert_eq!(lifecycle_action("CONNECTED"), "connected");
        assert_eq!(lifecycle_action("DISCONNECTED"), "disconnected");
        assert_eq!(lifecycle_action("REVOKED"), "revoked");
        assert_eq!(lifecycle_action("NEEDS_ATTENTION"), "needs_attention");
        assert_eq!(lifecycle_action("unexpected"), "needs_attention");
    }

    #[test]
    fn stream_key_is_organization_scoped() {
        assert_eq!(stream_key("org-123"), "organization:org-123:connections");
        assert!(!stream_key("org-123").contains("token"));
    }

    #[test]
    fn manifest_versions_coalesce_one_hour_and_advance_monotonically() {
        let start = Utc.with_ymd_and_hms(2026, 8, 24, 10, 12, 0).unwrap();
        assert_eq!(
            manifest_version(start),
            manifest_version(start + Duration::minutes(40))
        );
        assert_eq!(
            manifest_version(start) + 1,
            manifest_version(start + Duration::hours(1))
        );
    }
}
