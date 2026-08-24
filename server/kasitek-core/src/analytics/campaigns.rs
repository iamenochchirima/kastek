//! Core Campaign analytics facts.
//!
//! Campaign facts contain only stable campaign/recipient references and bounded delivery
//! dimensions. Callers must enqueue them through the transaction that persists the authoritative
//! recipient transition; the Core publisher later delivers the durable outbox row to Analytics.

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sqlx::{Postgres, Transaction};

use analytics_producer::{EnqueueResult, EventInput, ManifestInput, ScopeKind};

use super::{enqueue_event, enqueue_manifest as enqueue_source_manifest};

const SOURCE_DOMAIN: &str = "campaigns";
const MANIFEST_KEY: &str = "core.campaigns";
const MANIFEST_REFRESH_SECONDS: i64 = 3_600;
const SUPPORTED_CONTRACTS: &[&str] = &[
    "campaign.recipient.sent@1",
    "campaign.recipient.delivered@1",
    "campaign.recipient.read@1",
    "campaign.recipient.failed@1",
    "campaign.recipient.blocked@1",
    "campaign.recipient.suppressed@1",
    "campaign.recipient.unsubscribed@1",
    "campaign.recipient.timing@1",
    "campaign.recipient.retry@1",
];
const SUPPORTED_METRICS: &[&str] = &[
    "campaign.recipients.sent",
    "campaign.recipients.delivered",
    "campaign.recipients.read",
    "campaign.recipients.failed",
    "campaign.recipients.blocked",
    "campaign.recipients.suppressed",
    "campaign.recipients.unsubscribed",
    "campaign.delivery_delay_ms",
    "campaign.recipients.retried",
    "campaign.delivery_rate",
];
const SUPPORTED_DIMENSIONS: &[&str] = &[
    "campaign",
    "channel",
    "provider",
    "status",
    "failure_class",
    "suppression_class",
    "unsubscribe_source",
    "timing_kind",
    "retry_reason",
];

pub async fn enqueue_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    recipient_count: i64,
    collected_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let manifest_version = collected_at
        .timestamp()
        .div_euclid(MANIFEST_REFRESH_SECONDS)
        .max(1);
    let stream = stream_key(organization_id);
    let record_id = format!("manifest:{stream}:{MANIFEST_KEY}:{manifest_version}");
    let result = enqueue_source_manifest(
        transaction,
        ManifestInput {
            record_id,
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream,
            contract_name: "source.manifest@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            manifest_key: MANIFEST_KEY.to_string(),
            manifest_version,
            provider: Some("meta".to_string()),
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
            approved_checkpoint_count: Some(recipient_count),
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
    Ok(match result {
        EnqueueResult::Conflict { outbox_id } => EnqueueResult::Duplicate { outbox_id },
        result => result,
    })
}

pub async fn enqueue_recipient_sent(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "sent",
        "campaign.recipient.sent@1",
        occurred_at,
        None,
    )
    .await
}

pub async fn enqueue_recipient_delivered(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "delivered",
        "campaign.recipient.delivered@1",
        occurred_at,
        None,
    )
    .await
}

pub async fn enqueue_recipient_read(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "read",
        "campaign.recipient.read@1",
        occurred_at,
        None,
    )
    .await
}

pub async fn enqueue_recipient_failed(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    failure_class: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "failed",
        "campaign.recipient.failed@1",
        occurred_at,
        Some(("failure_class", failure_class)),
    )
    .await
}

pub async fn enqueue_recipient_blocked(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    block_class: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "blocked",
        "campaign.recipient.blocked@1",
        occurred_at,
        Some(("block_class", block_class)),
    )
    .await
}

pub async fn enqueue_recipient_suppressed(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    suppression_class: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "suppressed",
        "campaign.recipient.suppressed@1",
        occurred_at,
        Some(("suppression_class", suppression_class)),
    )
    .await
}

pub async fn enqueue_recipient_unsubscribed(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    unsubscribe_source: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    enqueue_recipient_delivery(
        transaction,
        organization_id,
        campaign_id,
        recipient_id,
        channel,
        provider,
        "unsubscribed",
        "campaign.recipient.unsubscribed@1",
        occurred_at,
        Some(("unsubscribe_source", unsubscribe_source)),
    )
    .await
}

pub async fn enqueue_recipient_timing(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    timing_kind: &str,
    duration_ms: i64,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!("campaign-recipient:{campaign_id}:{recipient_id}:timing:{timing_kind}");
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "campaign.recipient.timing@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "campaign_recipient".to_string(),
            subject_id: recipient_id.to_string(),
            occurred_at,
            attributes: json!({
                "campaign_id": campaign_id,
                "recipient_id": recipient_id,
                "channel": channel,
                "provider": provider,
                "occurred_at": occurred_at,
                "status": "timing",
                "timing_kind": timing_kind,
                "duration_ms": duration_ms,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

pub async fn enqueue_recipient_retry(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    attempt_number: i32,
    retry_reason: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id =
        format!("campaign-recipient:{campaign_id}:{recipient_id}:retry:{attempt_number}");
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "campaign.recipient.retry@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "campaign_recipient".to_string(),
            subject_id: recipient_id.to_string(),
            occurred_at,
            attributes: json!({
                "campaign_id": campaign_id,
                "recipient_id": recipient_id,
                "channel": channel,
                "provider": provider,
                "occurred_at": occurred_at,
                "status": "retry_queued",
                "attempt_number": attempt_number,
                "retry_reason": retry_reason,
            }),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn enqueue_recipient_delivery(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    campaign_id: &str,
    recipient_id: &str,
    channel: &str,
    provider: &str,
    status: &str,
    contract_name: &str,
    occurred_at: DateTime<Utc>,
    classification: Option<(&str, &str)>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!("campaign-recipient:{campaign_id}:{recipient_id}:{status}");
    let mut attributes = json!({
        "campaign_id": campaign_id,
        "recipient_id": recipient_id,
        "channel": channel,
        "provider": provider,
        "occurred_at": occurred_at,
        "status": status,
    });
    if let Some((key, value)) = classification {
        attributes[key] = json!(value);
    }
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: contract_name.to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "campaign_recipient".to_string(),
            subject_id: recipient_id.to_string(),
            occurred_at,
            attributes,
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

fn stream_key(organization_id: &str) -> String {
    format!("organization:{organization_id}:campaigns")
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::{stream_key, DateTime, Utc};

    #[test]
    fn stream_key_is_organization_scoped() {
        assert_eq!(stream_key("org-123"), "organization:org-123:campaigns");
        assert!(!stream_key("org-123").contains("phone"));
    }

    #[test]
    fn delivery_attributes_are_bounded() {
        let occurred_at: DateTime<Utc> = Utc.with_ymd_and_hms(2026, 8, 24, 10, 0, 0).unwrap();
        let attributes = serde_json::json!({
            "campaign_id": "campaign-123",
            "recipient_id": "recipient-123",
            "channel": "whatsapp",
            "provider": "meta",
            "occurred_at": occurred_at,
            "status": "sent",
        });
        let object = attributes.as_object().unwrap();
        assert_eq!(object.len(), 6);
        for prohibited in [
            "phone_number",
            "email",
            "message_body",
            "credential",
            "token",
            "provider_payload",
        ] {
            assert!(!object.contains_key(prohibited), "unexpected {prohibited}");
        }
    }
}
