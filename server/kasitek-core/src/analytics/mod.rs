//! Core's transactional Analytics producer boundary.
//!
//! Domain commands should call these helpers with their existing transaction. The helper does not
//! perform network I/O; the source outbox is the durability boundary and a later publisher sends
//! leased rows to the private Analytics ingestion API.

use analytics_producer::{
    build_event, build_observation, build_scope_definition, enqueue_outbox, AnalyticsOutboxRecord,
    EnqueueResult, EventInput, ObservationInput, ProducerConfig, ProducerError,
    ScopeDefinitionInput,
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
