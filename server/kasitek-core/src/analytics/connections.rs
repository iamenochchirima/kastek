//! Core Connections analytics facts.
//!
//! Only stable internal references and bounded state values cross the analytics boundary. Provider
//! identifiers, display fields, credentials, metadata, and raw health errors remain in Core.

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{Postgres, Transaction};

use analytics_producer::{EnqueueResult, EventInput, ScopeKind};

use super::enqueue_event;

const SOURCE_DOMAIN: &str = "connections";

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
    use super::{lifecycle_action, stream_key};

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
}
