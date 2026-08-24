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
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!("campaign-recipient:{campaign_id}:{recipient_id}:{status}");
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
            attributes: json!({
                "campaign_id": campaign_id,
                "recipient_id": recipient_id,
                "channel": channel,
                "provider": provider,
                "occurred_at": occurred_at,
                "status": status,
            }),
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
