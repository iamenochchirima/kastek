//! Core Campaign analytics facts.
//!
//! Campaign facts contain only stable campaign/recipient references and bounded delivery
//! dimensions. Callers must enqueue them through the transaction that persists the authoritative
//! recipient transition; the Core publisher later delivers the durable outbox row to Analytics.

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{Postgres, Transaction};

use analytics_producer::{EnqueueResult, EventInput, ScopeKind};

use super::enqueue_event;

const SOURCE_DOMAIN: &str = "campaigns";

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
