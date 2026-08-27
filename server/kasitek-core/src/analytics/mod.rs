//! Core's transactional Analytics producer boundary.
//!
//! Domain commands should call these helpers with their existing transaction. The helper does not
//! perform network I/O; the source outbox is the durability boundary and a later publisher sends
//! leased rows to the private Analytics ingestion API.

pub mod campaigns;
pub mod connections;
pub mod inbox;

use analytics_producer::{
    build_event, build_manifest, build_observation, build_scope_definition, enqueue_outbox,
    AnalyticsOutboxRecord, EnqueueResult, EventInput, ManifestInput, ObservationInput,
    ProducerConfig, ProducerError, ScopeDefinitionInput,
};
use sqlx::{Postgres, Transaction};

pub use analytics_producer::{
    apply_delivery_outcome, claim_outbox_batch, release_expired_leases, AnalyticsEnvelope,
    DeliveryOutcome, OutboxRow, RetryPolicy, ScopeKind,
};

pub fn producer_config() -> ProducerConfig {
    ProducerConfig::core()
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

/// Publish the Core organization scope that owns customer-facing Analytics data.
///
/// This must be called in the same transaction as the organization mutation. The
/// publisher will deliver the durable outbox row to Analytics after the commit.
pub async fn enqueue_organization_scope_definition(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    source_version: i64,
    reporting_timezone: &str,
    status: &str,
) -> Result<EnqueueResult, ProducerError> {
    let record_id = format!("core-scope:organization:{organization_id}:{source_version}");
    enqueue_scope_definition(
        transaction,
        ScopeDefinitionInput {
            record_id: record_id.clone(),
            source_domain: "scopes".to_string(),
            source_stream_key: format!("organization:{organization_id}:scopes"),
            contract_name: "core.scope.definition@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            parent_scope_external_id: None,
            reporting_timezone: reporting_timezone.to_string(),
            status: status.to_string(),
            source_version,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

pub async fn enqueue_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    input: ManifestInput,
) -> Result<EnqueueResult, ProducerError> {
    let record = build_manifest(&producer_config(), input)?;
    enqueue_record(transaction, &record).await
}
