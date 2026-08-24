//! Core Inbox analytics facts.
//!
//! These builders contain only stable, aggregate-safe references. They must be called with the
//! same transaction that persists the Inbox mutation; publication is deliberately left to the
//! Core analytics publisher.

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};

use analytics_producer::{
    build_event, AnalyticsOutboxRecord, EnqueueResult, EventInput, ManifestInput, ProducerError,
    ScopeKind,
};

use super::{enqueue_event, enqueue_manifest as enqueue_source_manifest};

const SOURCE_DOMAIN: &str = "inbox";
const META_MANIFEST_KEY: &str = "core.inbox.meta";
const META_MANIFEST_REFRESH_SECONDS: i64 = 3_600;
const META_SUPPORTED_CONTRACTS: &[&str] = &[
    "conversation.lifecycle@1",
    "conversation.message.lifecycle@1",
];
const META_SUPPORTED_METRICS: &[&str] = &[
    "conversation.lifecycle_events",
    "conversation.message.lifecycle_events",
    "conversation.response_time_ms",
];
const META_SUPPORTED_DIMENSIONS: &[&str] = &[
    "conversation_channel",
    "lifecycle_action",
    "status",
    "message_action",
    "message_direction",
    "responder_type",
    "message_type",
    "message_delivery_status",
];

/// Enqueue an organization-scoped Meta Inbox source checkpoint.
///
/// The checkpoint describes the current persisted Meta message population observed by Core. It
/// is useful for source reconciliation, but it deliberately does not claim historical coverage:
/// `reliable_coverage_start` stays unset until an authenticated source reconstruction or approved
/// provider-history import has completed.
pub async fn enqueue_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    message_count: i64,
    collected_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let manifest_version = collected_at
        .timestamp()
        .div_euclid(META_MANIFEST_REFRESH_SECONDS)
        .max(1);
    let source_stream_key = stream_key(organization_id);
    let record_id = format!("manifest:{source_stream_key}:{META_MANIFEST_KEY}:{manifest_version}");
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
            manifest_key: META_MANIFEST_KEY.to_string(),
            manifest_version,
            provider: Some("meta".to_string()),
            connection_ref: None,
            supported_contracts: META_SUPPORTED_CONTRACTS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            supported_observation_contracts: Vec::new(),
            supported_metrics: META_SUPPORTED_METRICS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            supported_dimensions: META_SUPPORTED_DIMENSIONS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            expected_refresh_seconds: META_MANIFEST_REFRESH_SECONDS,
            reliable_coverage_start: None,
            highest_authoritative_source_sequence: None,
            approved_checkpoint_count: Some(message_count),
            approved_checkpoint_hash: None,
            last_successful_collection_at: Some(collected_at),
            last_attempted_collection_at: Some(collected_at),
            safe_failure_code: None,
            next_expected_at: Some(collected_at + Duration::seconds(META_MANIFEST_REFRESH_SECONDS)),
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

/// Build the deterministic baseline fact for a persisted Meta conversation.
///
/// Historical reconstruction uses the same event identity and attribute shape as live Core
/// mutations, but returns the record for the authenticated source-backfill transport instead of
/// writing the live outbox.
pub fn build_meta_conversation_backfill_record(
    organization_id: &str,
    conversation_id: &str,
    channel: &str,
    status: &str,
    occurred_at: DateTime<Utc>,
) -> Result<AnalyticsOutboxRecord, ProducerError> {
    let record_id = format!(
        "conversation:{conversation_id}:opened:{}",
        occurred_at.timestamp_millis()
    );
    Ok(build_event(
        &super::producer_config(),
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "conversation.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "conversation".to_string(),
            subject_id: conversation_id.to_string(),
            occurred_at,
            attributes: conversation_attributes(
                conversation_id,
                channel,
                "opened",
                status,
                "customer",
                occurred_at,
            ),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )?)
}

/// Build the deterministic baseline fact for a persisted Meta message.
pub fn build_meta_message_backfill_record(
    organization_id: &str,
    message_id: &str,
    conversation_id: &str,
    channel: &str,
    direction: &str,
    responder_type: &str,
    message_type: &str,
    occurred_at: DateTime<Utc>,
) -> Result<AnalyticsOutboxRecord, ProducerError> {
    let record_id = format!(
        "message:{message_id}:created:{}",
        occurred_at.timestamp_millis()
    );
    Ok(build_event(
        &super::producer_config(),
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "conversation.message.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "message".to_string(),
            subject_id: message_id.to_string(),
            occurred_at,
            attributes: message_attributes(
                message_id,
                conversation_id,
                channel,
                "created",
                direction,
                responder_type,
                message_type,
                None,
                None,
                occurred_at,
            ),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )?)
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_conversation_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    channel: &str,
    action: &str,
    status: &str,
    actor_type: &str,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "conversation:{conversation_id}:{action}:{}",
        occurred_at.timestamp_millis()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "conversation.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "conversation".to_string(),
            subject_id: conversation_id.to_string(),
            occurred_at,
            attributes: conversation_attributes(
                conversation_id,
                channel,
                action,
                status,
                actor_type,
                occurred_at,
            ),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn enqueue_message_lifecycle(
    transaction: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    message_id: &str,
    conversation_id: &str,
    channel: &str,
    action: &str,
    direction: &str,
    responder_type: &str,
    message_type: &str,
    delivery_status: Option<&str>,
    response_time_ms: Option<i64>,
    occurred_at: DateTime<Utc>,
) -> Result<EnqueueResult, analytics_producer::ProducerError> {
    let record_id = format!(
        "message:{message_id}:{action}:{}",
        occurred_at.timestamp_millis()
    );
    enqueue_event(
        transaction,
        EventInput {
            record_id: record_id.clone(),
            source_domain: SOURCE_DOMAIN.to_string(),
            source_stream_key: stream_key(organization_id),
            contract_name: "conversation.message.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: ScopeKind::CoreOrganization,
            scope_external_id: organization_id.to_string(),
            subject_type: "message".to_string(),
            subject_id: message_id.to_string(),
            occurred_at,
            attributes: message_attributes(
                message_id,
                conversation_id,
                channel,
                action,
                direction,
                responder_type,
                message_type,
                delivery_status,
                response_time_ms,
                occurred_at,
            ),
            correlation_id: None,
            causation_id: None,
            idempotency_key: Some(record_id),
        },
    )
    .await
}

pub async fn preceding_customer_response_time_ms(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: &str,
    occurred_at: DateTime<Utc>,
) -> Result<Option<i64>, sqlx::Error> {
    let value = sqlx::query(
        r#"
        SELECT GREATEST(
            0,
            ROUND(EXTRACT(EPOCH FROM (($2::timestamptz - timestamp) * 1000)))
        )::bigint AS response_time_ms
        FROM "Message"
        WHERE "conversationId" = $1
          AND sender = 'customer'
          AND timestamp <= $2
        ORDER BY timestamp DESC
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(occurred_at)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(value.and_then(|row| {
        row.try_get::<Option<i64>, _>("response_time_ms")
            .ok()
            .flatten()
    }))
}

fn stream_key(organization_id: &str) -> String {
    format!("organization:{organization_id}:inbox")
}

fn conversation_attributes(
    conversation_id: &str,
    channel: &str,
    action: &str,
    status: &str,
    actor_type: &str,
    occurred_at: DateTime<Utc>,
) -> serde_json::Value {
    json!({
        "conversation_id": conversation_id,
        "channel": channel,
        "action": action,
        "status": status,
        "actor_type": actor_type,
        "occurred_at": occurred_at,
    })
}

#[allow(clippy::too_many_arguments)]
fn message_attributes(
    message_id: &str,
    conversation_id: &str,
    channel: &str,
    action: &str,
    direction: &str,
    responder_type: &str,
    message_type: &str,
    delivery_status: Option<&str>,
    response_time_ms: Option<i64>,
    occurred_at: DateTime<Utc>,
) -> serde_json::Value {
    json!({
        "message_id": message_id,
        "conversation_id": conversation_id,
        "channel": channel,
        "action": action,
        "direction": direction,
        "responder_type": responder_type,
        "message_type": message_type,
        "delivery_status": delivery_status,
        "response_time_ms": response_time_ms,
        "occurred_at": occurred_at,
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn stream_key_is_scoped_without_customer_data() {
        assert_eq!(super::stream_key("org-123"), "organization:org-123:inbox");
        assert!(!super::stream_key("org-123").contains("phone"));
    }

    #[test]
    fn message_attributes_are_bounded_and_transcript_free() {
        let attributes = super::message_attributes(
            "message-123",
            "conversation-123",
            "whatsapp",
            "created",
            "inbound",
            "customer",
            "text",
            None,
            None,
            chrono::Utc.with_ymd_and_hms(2026, 8, 22, 10, 0, 0).unwrap(),
        );
        let object = attributes.as_object().unwrap();
        assert_eq!(object.len(), 10);
        for prohibited in [
            "content",
            "message_body",
            "customer_identifier",
            "phone_number",
            "email",
            "provider_message_id",
            "credential",
            "token",
        ] {
            assert!(!object.contains_key(prohibited), "unexpected {prohibited}");
        }
    }

    #[test]
    fn meta_backfill_builders_preserve_business_time_and_safe_dimensions() {
        let occurred_at = chrono::Utc.with_ymd_and_hms(2025, 1, 2, 3, 4, 5).unwrap();
        let conversation = super::build_meta_conversation_backfill_record(
            "org-123",
            "conversation-123",
            "facebook",
            "active",
            occurred_at,
        )
        .unwrap();
        assert_eq!(
            conversation.record_id,
            "conversation:conversation-123:opened:1735787045000"
        );
        assert_eq!(conversation.envelope["time"], json!(occurred_at));

        let message = super::build_meta_message_backfill_record(
            "org-123",
            "message-123",
            "conversation-123",
            "facebook",
            "inbound",
            "customer",
            "text",
            occurred_at,
        )
        .unwrap();
        assert_eq!(
            message.record_id,
            "message:message-123:created:1735787045000"
        );
        assert_eq!(message.envelope["time"], json!(occurred_at));
        assert!(message.envelope["data"].get("content").is_none());
        assert!(message.envelope["data"]
            .get("provider_message_id")
            .is_none());
    }
}
