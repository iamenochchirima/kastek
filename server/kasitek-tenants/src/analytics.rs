//! Tenant Platform's transactional Analytics producer boundary.
//!
//! Domain commands should call these helpers with their existing transaction. The helper does not
//! perform network I/O; the source outbox is the durability boundary and a later publisher sends
//! leased rows to the private Analytics ingestion API.

use analytics_producer::{
    build_event, build_manifest, build_observation, build_scope_definition, enqueue_outbox,
    AnalyticsOutboxRecord, EnqueueResult, EventInput, ManifestInput, ObservationInput,
    ProducerConfig, ProducerError, ScopeDefinitionInput,
};
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{Postgres, Transaction};

pub use analytics_producer::{
    apply_delivery_outcome, claim_outbox_batch, release_expired_leases, AnalyticsEnvelope,
    DeliveryOutcome, OutboxRow, RetryPolicy, ScopeKind,
};

pub fn producer_config() -> ProducerConfig {
    ProducerConfig::tenant_platform()
}

pub async fn enqueue_record(
    transaction: &mut Transaction<'_, Postgres>,
    record: &AnalyticsOutboxRecord,
) -> Result<EnqueueResult, ProducerError> {
    enqueue_outbox(transaction, record).await
}

pub async fn enqueue_event(
    transaction: &mut Transaction<'_, Postgres>,
    input: EventInput,
) -> Result<EnqueueResult, ProducerError> {
    let record = build_event(&producer_config(), input)?;
    enqueue_record(transaction, &record).await
}

pub async fn enqueue_observation(
    transaction: &mut Transaction<'_, Postgres>,
    input: ObservationInput,
) -> Result<EnqueueResult, ProducerError> {
    let record = build_observation(&producer_config(), input)?;
    enqueue_record(transaction, &record).await
}

pub async fn enqueue_scope_definition(
    transaction: &mut Transaction<'_, Postgres>,
    input: ScopeDefinitionInput,
) -> Result<EnqueueResult, ProducerError> {
    let record = build_scope_definition(&producer_config(), input)?;
    enqueue_record(transaction, &record).await
}

pub async fn enqueue_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    input: ManifestInput,
) -> Result<EnqueueResult, ProducerError> {
    let record = build_manifest(&producer_config(), input)?;
    enqueue_record(transaction, &record).await
}

pub async fn enqueue_workspace_scope_definition(
    transaction: &mut Transaction<'_, Postgres>,
    workspace_id: &str,
    source_version: i64,
) -> Result<EnqueueResult, ProducerError> {
    enqueue_scope_definition(
        transaction,
        ScopeDefinitionInput {
            record_id: format!("tenant-scope:workspace:{workspace_id}:{source_version}"),
            source_domain: "scopes".to_string(),
            source_stream_key: format!("workspace:{workspace_id}:scopes"),
            contract_name: "tenant.scope.definition@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::TenantWorkspace,
            scope_external_id: workspace_id.to_string(),
            parent_scope_external_id: None,
            reporting_timezone: "UTC".to_string(),
            status: "active".to_string(),
            source_version,
            idempotency_key: Some(format!(
                "tenant-scope:workspace:{workspace_id}:{source_version}"
            )),
        },
    )
    .await
}

pub async fn enqueue_client_scope_definition(
    transaction: &mut Transaction<'_, Postgres>,
    workspace_id: &str,
    tenant_client_id: &str,
    source_version: i64,
) -> Result<EnqueueResult, ProducerError> {
    enqueue_scope_definition(
        transaction,
        ScopeDefinitionInput {
            record_id: format!("tenant-scope:client:{tenant_client_id}:{source_version}"),
            source_domain: "scopes".to_string(),
            source_stream_key: format!("workspace:{workspace_id}:scopes"),
            contract_name: "tenant.scope.definition@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::TenantClient,
            scope_external_id: tenant_client_id.to_string(),
            parent_scope_external_id: Some(workspace_id.to_string()),
            reporting_timezone: "UTC".to_string(),
            status: "active".to_string(),
            source_version,
            idempotency_key: Some(format!(
                "tenant-scope:client:{tenant_client_id}:{source_version}"
            )),
        },
    )
    .await
}

pub async fn enqueue_lead_created(
    transaction: &mut Transaction<'_, Postgres>,
    workspace_id: &str,
    tenant_client_id: &str,
    lead_id: &str,
    source: &str,
    score_band: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, ProducerError> {
    enqueue_event(
        transaction,
        EventInput {
            record_id: format!("tenant-lead:{lead_id}:created"),
            source_domain: "leads".to_string(),
            source_stream_key: format!("workspace:{workspace_id}:leads"),
            contract_name: "tenant.lead.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::TenantClient,
            scope_external_id: tenant_client_id.to_string(),
            subject_type: "tenant_lead".to_string(),
            subject_id: lead_id.to_string(),
            occurred_at,
            attributes: json!({
                "lead_id": lead_id,
                "tenant_client_id": tenant_client_id,
                "action": "created",
                "status": "new",
                "source": source,
                "score_band": score_band,
                "occurred_at": occurred_at,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(format!("tenant-lead:{lead_id}:created")),
        },
    )
    .await
}
