//! Core-owned source reconstruction for authenticated Analytics backfill jobs.
//!
//! This worker reads only the authoritative Core rows needed for the leased source boundary. It
//! never reads Analytics storage and never sends message content or provider identifiers. For
//! Connections, the immutable Core analytics outbox is the source-owned event history because the
//! operational connection projection stores current state only; the worker never mutates or claims
//! those source rows. Re-running a range is safe because the record identities and source
//! sequences are deterministic.

use std::{env, time::Duration};

use analytics_producer::{
    backfill_source_sequence, AnalyticsIngestionClient, AnalyticsOutboxRecord, BackfillRecord,
    RecordCategory, ScopeKind, SourceBackfillWork,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::analytics;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4300";
const DEFAULT_PRODUCER_ID: &str = "core-customer-analytics";
const DEFAULT_BATCH_SIZE: i64 = 100;
const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;
const META_SOURCE_DOMAIN: &str = "inbox";
const CONNECTIONS_SOURCE_DOMAIN: &str = "connections";
const CAMPAIGNS_SOURCE_DOMAIN: &str = "campaigns";
const SOURCE_RECONSTRUCTION_METHOD: &str = "source_reconstruction";

#[derive(Clone, Debug)]
struct Settings {
    endpoint: String,
    token: String,
    producer_id: String,
    batch_size: i64,
    request_timeout: Duration,
}

#[derive(Debug, FromRow)]
struct MetaConversationBackfillRow {
    id: String,
    channel: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct MetaMessageBackfillRow {
    id: String,
    conversation_id: String,
    channel: String,
    sender: String,
    message_type: Option<String>,
    agent_idempotency_key: Option<String>,
    inbox_message_kind: Option<String>,
    occurred_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ConnectionsBackfillRow {
    source_sequence: i64,
    outbox_id: String,
    source_service: String,
    source_domain: String,
    source_stream_key: String,
    record_category: String,
    record_id: String,
    contract_name: String,
    schema_version: i32,
    scope_kind: String,
    scope_external_id: String,
    idempotency_key: String,
    envelope: Value,
    payload_hash: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BackfillStats {
    pub conversation_records: usize,
    pub message_records: usize,
    pub connection_records: usize,
    pub campaign_records: usize,
    pub rejected_records: usize,
}

pub async fn run(pool: PgPool) {
    let Some(settings) = settings_from_env() else {
        log::warn!(
            "[analytics-backfill] disabled; set ANALYTICS_CORE_INGESTION_TOKEN to enable Core source reconstruction"
        );
        return;
    };
    let client = match AnalyticsIngestionClient::new(
        settings.endpoint.clone(),
        settings.token.clone(),
        settings.request_timeout,
    ) {
        Ok(client) => client,
        Err(error) => {
            log::error!("[analytics-backfill] invalid transport configuration: {error}");
            return;
        }
    };
    log::info!(
        "[analytics-backfill] started producer_id={} endpoint={} batch_size={}",
        settings.producer_id,
        settings.endpoint,
        settings.batch_size
    );

    loop {
        match client.claim_source_backfill_work().await {
            Ok(Some(work)) => {
                let result = match (work.source_domain.as_str(), work.method.as_str()) {
                    (META_SOURCE_DOMAIN, SOURCE_RECONSTRUCTION_METHOD) => {
                        process_meta_source_reconstruction(&pool, &client, &settings, &work).await
                    }
                    (CONNECTIONS_SOURCE_DOMAIN, SOURCE_RECONSTRUCTION_METHOD) => {
                        process_connections_source_reconstruction(
                            &pool,
                            &client,
                            &settings.producer_id,
                            settings.batch_size,
                            &work,
                        )
                        .await
                    }
                    (CAMPAIGNS_SOURCE_DOMAIN, SOURCE_RECONSTRUCTION_METHOD) => {
                        process_campaign_source_reconstruction(
                            &pool,
                            &client,
                            &settings.producer_id,
                            settings.batch_size,
                            &work,
                        )
                        .await
                    }
                    _ => Err(format!(
                        "unsupported_source_job:{}:{}",
                        work.source_domain, work.method
                    )),
                };
                match result {
                    Ok(stats) => log::info!(
                        "[analytics-backfill] completed pass job={} conversations={} messages={} connections={} campaigns={} rejected={}",
                        work.job_id,
                        stats.conversation_records,
                        stats.message_records,
                        stats.connection_records,
                        stats.campaign_records,
                        stats.rejected_records
                    ),
                    Err(error) => log::error!(
                        "[analytics-backfill] pass failed job={} error={}",
                        work.job_id,
                        error
                    ),
                }
            }
            Ok(None) => {}
            Err(error) => log::error!("[analytics-backfill] claim failed: {error}"),
        }
        tokio::time::sleep(poll_interval()).await;
    }
}

async fn process_meta_source_reconstruction(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    settings: &Settings,
    work: &SourceBackfillWork,
) -> Result<BackfillStats, String> {
    if work.scope_external_id.trim().is_empty()
        || work.requested_range_end <= work.requested_range_start
    {
        return Err("invalid_source_backfill_scope_or_range".to_string());
    }
    if work.remaining_count.is_none() {
        return Err("source_backfill_requires_expected_count".to_string());
    }

    let mut stats = BackfillStats::default();
    let mut conversation_cursor: Option<(DateTime<Utc>, String)> = None;
    loop {
        let rows = load_meta_conversations(
            pool,
            &work.scope_external_id,
            work.requested_range_start,
            work.requested_range_end,
            conversation_cursor.as_ref(),
            settings.batch_size,
        )
        .await
        .map_err(|error| format!("load_meta_conversations: {error}"))?;
        if rows.is_empty() {
            break;
        }
        let last = rows
            .last()
            .map(|row| (row.created_at, row.id.clone()))
            .expect("non-empty conversation page has a last row");
        let records = rows
            .into_iter()
            .map(|row| {
                analytics::inbox::build_meta_conversation_backfill_record(
                    &work.scope_external_id,
                    &row.id,
                    &row.channel,
                    "active",
                    row.created_at,
                )
                .map(|record| BackfillRecord {
                    source_sequence: backfill_source_sequence(&record.record_id),
                    record,
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("build_meta_conversation_fact: {error}"))?;
        let response = client
            .send_backfill_batch(&settings.producer_id, &work.job_id, &records)
            .await
            .map_err(|error| format!("send_meta_conversation_batch: {error}"))?;
        if response.retryable_count > 0 {
            return Err("meta_conversation_batch_has_retryable_records".to_string());
        }
        stats.conversation_records += records.len();
        stats.rejected_records += response.rejected_count;
        conversation_cursor = Some(last);
    }

    let mut message_cursor: Option<(DateTime<Utc>, String)> = None;
    loop {
        let rows = load_meta_messages(
            pool,
            &work.scope_external_id,
            work.requested_range_start,
            work.requested_range_end,
            message_cursor.as_ref(),
            settings.batch_size,
        )
        .await
        .map_err(|error| format!("load_meta_messages: {error}"))?;
        if rows.is_empty() {
            break;
        }
        let last = rows
            .last()
            .map(|row| (row.occurred_at, row.id.clone()))
            .expect("non-empty message page has a last row");
        let records = rows
            .into_iter()
            .map(|row| {
                let direction = if row.sender == "customer" {
                    "inbound"
                } else {
                    "outbound"
                };
                let message_type = row
                    .message_type
                    .as_deref()
                    .unwrap_or("TEXT")
                    .to_ascii_lowercase();
                let responder_type = meta_responder_type(
                    &row.sender,
                    row.agent_idempotency_key.as_deref(),
                    row.inbox_message_kind.as_deref(),
                );
                analytics::inbox::build_meta_message_backfill_record(
                    &work.scope_external_id,
                    &row.id,
                    &row.conversation_id,
                    &row.channel,
                    direction,
                    responder_type,
                    &message_type,
                    row.occurred_at,
                )
                .map(|record| BackfillRecord {
                    source_sequence: backfill_source_sequence(&record.record_id),
                    record,
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("build_meta_message_fact: {error}"))?;
        let response = client
            .send_backfill_batch(&settings.producer_id, &work.job_id, &records)
            .await
            .map_err(|error| format!("send_meta_message_batch: {error}"))?;
        if response.retryable_count > 0 {
            return Err("meta_message_batch_has_retryable_records".to_string());
        }
        stats.message_records += records.len();
        stats.rejected_records += response.rejected_count;
        message_cursor = Some(last);
    }

    Ok(stats)
}

pub async fn process_connections_source_reconstruction(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    producer_id: &str,
    batch_size: i64,
    work: &SourceBackfillWork,
) -> Result<BackfillStats, String> {
    if producer_id.trim().is_empty() || !(1..=500).contains(&batch_size) {
        return Err("invalid_source_backfill_transport_settings".to_string());
    }
    if work.scope_external_id.trim().is_empty()
        || work.requested_range_end <= work.requested_range_start
    {
        return Err("invalid_source_backfill_scope_or_range".to_string());
    }
    if work.remaining_count.is_none() {
        return Err("source_backfill_requires_expected_count".to_string());
    }

    let mut stats = BackfillStats::default();
    let mut cursor = None;
    loop {
        let rows = load_connections_history(
            pool,
            &work.scope_external_id,
            work.requested_range_start,
            work.requested_range_end,
            cursor,
            batch_size,
        )
        .await
        .map_err(|error| format!("load_connections_history: {error}"))?;
        if rows.is_empty() {
            break;
        }
        let last_sequence = rows
            .last()
            .map(|row| row.source_sequence)
            .expect("non-empty Connections page has a last row");
        let records = rows
            .into_iter()
            .map(|row| {
                build_connections_backfill_record(row).map(|record| BackfillRecord {
                    source_sequence: backfill_source_sequence(&record.record_id),
                    record,
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("build_connections_fact: {error}"))?;
        let response = client
            .send_backfill_batch(producer_id, &work.job_id, &records)
            .await
            .map_err(|error| format!("send_connections_batch: {error}"))?;
        if response.retryable_count > 0 {
            return Err("connections_batch_has_retryable_records".to_string());
        }
        stats.connection_records += records.len();
        stats.rejected_records += response.rejected_count;
        cursor = Some(last_sequence);
    }

    Ok(stats)
}

pub async fn process_campaign_source_reconstruction(
    pool: &PgPool,
    client: &AnalyticsIngestionClient,
    producer_id: &str,
    batch_size: i64,
    work: &SourceBackfillWork,
) -> Result<BackfillStats, String> {
    if producer_id.trim().is_empty() || !(1..=500).contains(&batch_size) {
        return Err("invalid_source_backfill_transport_settings".to_string());
    }
    if work.scope_external_id.trim().is_empty()
        || work.requested_range_end <= work.requested_range_start
    {
        return Err("invalid_source_backfill_scope_or_range".to_string());
    }
    if work.remaining_count.is_none() {
        return Err("source_backfill_requires_expected_count".to_string());
    }

    let mut stats = BackfillStats::default();
    let mut cursor = None;
    loop {
        let rows = load_campaign_history(
            pool,
            &work.scope_external_id,
            work.requested_range_start,
            work.requested_range_end,
            cursor,
            batch_size,
        )
        .await
        .map_err(|error| format!("load_campaign_history: {error}"))?;
        if rows.is_empty() {
            break;
        }
        let last_sequence = rows
            .last()
            .map(|row| row.source_sequence)
            .expect("non-empty Campaign page has a last row");
        let records = rows
            .into_iter()
            .map(|row| {
                build_campaign_backfill_record(row).map(|record| BackfillRecord {
                    source_sequence: backfill_source_sequence(&record.record_id),
                    record,
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("build_campaign_fact: {error}"))?;
        let response = client
            .send_backfill_batch(producer_id, &work.job_id, &records)
            .await
            .map_err(|error| format!("send_campaign_batch: {error}"))?;
        if response.retryable_count > 0 {
            return Err("campaign_batch_has_retryable_records".to_string());
        }
        stats.campaign_records += records.len();
        stats.rejected_records += response.rejected_count;
        cursor = Some(last_sequence);
    }

    Ok(stats)
}

async fn load_connections_history(
    pool: &PgPool,
    organization_id: &str,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Vec<ConnectionsBackfillRow>, sqlx::Error> {
    let query = r#"
        SELECT source_sequence,
               outbox_id,
               source_service,
               source_domain,
               source_stream_key,
               record_category,
               record_id,
               contract_name,
               schema_version,
               scope_kind,
               scope_external_id,
               idempotency_key,
               envelope,
               payload_hash
        FROM analytics_outbox
        WHERE source_service = 'core'
          AND source_domain = 'connections'
          AND record_category = 'event'
          AND source_stream_key = 'organization:' || $1 || ':connections'
          AND scope_external_id = $1
          AND NULLIF(envelope ->> 'time', '')::timestamptz >= $2
          AND NULLIF(envelope ->> 'time', '')::timestamptz < $3
          AND ($4::bigint IS NULL OR source_sequence > $4)
        ORDER BY source_sequence
        LIMIT $5
    "#;
    sqlx::query_as::<_, ConnectionsBackfillRow>(query)
        .bind(organization_id)
        .bind(range_start)
        .bind(range_end)
        .bind(cursor)
        .bind(limit)
        .fetch_all(pool)
        .await
}

async fn load_campaign_history(
    pool: &PgPool,
    organization_id: &str,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Vec<ConnectionsBackfillRow>, sqlx::Error> {
    let query = r#"
        SELECT source_sequence,
               outbox_id,
               source_service,
               source_domain,
               source_stream_key,
               record_category,
               record_id,
               contract_name,
               schema_version,
               scope_kind,
               scope_external_id,
               idempotency_key,
               envelope,
               payload_hash
        FROM analytics_outbox
        WHERE source_service = 'core'
          AND source_domain = 'campaigns'
          AND record_category = 'event'
          AND source_stream_key = 'organization:' || $1 || ':campaigns'
          AND scope_external_id = $1
          AND NULLIF(envelope ->> 'time', '')::timestamptz >= $2
          AND NULLIF(envelope ->> 'time', '')::timestamptz < $3
          AND ($4::bigint IS NULL OR source_sequence > $4)
        ORDER BY source_sequence
        LIMIT $5
    "#;
    sqlx::query_as::<_, ConnectionsBackfillRow>(query)
        .bind(organization_id)
        .bind(range_start)
        .bind(range_end)
        .bind(cursor)
        .bind(limit)
        .fetch_all(pool)
        .await
}

fn build_connections_backfill_record(
    row: ConnectionsBackfillRow,
) -> Result<AnalyticsOutboxRecord, String> {
    if row.source_service != "core" || row.source_domain != CONNECTIONS_SOURCE_DOMAIN {
        return Err("connections_source_identity_mismatch".to_string());
    }
    if row.source_stream_key != format!("organization:{}:connections", row.scope_external_id) {
        return Err("connections_source_stream_mismatch".to_string());
    }
    if row.outbox_id.trim().is_empty() {
        return Err("connections_outbox_identity_missing".to_string());
    }
    let record_category =
        serde_json::from_value::<RecordCategory>(Value::String(row.record_category))
            .map_err(|error| format!("invalid_record_category:{error}"))?;
    if record_category != RecordCategory::Event {
        return Err("connections_backfill_requires_event_record".to_string());
    }
    let scope_kind = serde_json::from_value::<ScopeKind>(Value::String(row.scope_kind))
        .map_err(|error| format!("invalid_scope_kind:{error}"))?;
    Ok(AnalyticsOutboxRecord {
        outbox_id: row.outbox_id,
        source_service: row.source_service,
        source_domain: row.source_domain,
        source_stream_key: row.source_stream_key,
        record_category,
        record_id: row.record_id,
        contract_name: row.contract_name,
        schema_version: row.schema_version,
        scope_kind,
        scope_external_id: row.scope_external_id,
        idempotency_key: row.idempotency_key,
        envelope: row.envelope,
        payload_hash: row.payload_hash,
    })
}

fn build_campaign_backfill_record(
    row: ConnectionsBackfillRow,
) -> Result<AnalyticsOutboxRecord, String> {
    if row.source_service != "core" || row.source_domain != CAMPAIGNS_SOURCE_DOMAIN {
        return Err("campaigns_source_identity_mismatch".to_string());
    }
    if row.source_stream_key != format!("organization:{}:campaigns", row.scope_external_id) {
        return Err("campaigns_source_stream_mismatch".to_string());
    }
    if row.outbox_id.trim().is_empty() {
        return Err("campaigns_outbox_identity_missing".to_string());
    }
    let record_category =
        serde_json::from_value::<RecordCategory>(Value::String(row.record_category))
            .map_err(|error| format!("invalid_record_category:{error}"))?;
    if record_category != RecordCategory::Event {
        return Err("campaigns_backfill_requires_event_record".to_string());
    }
    let scope_kind = serde_json::from_value::<ScopeKind>(Value::String(row.scope_kind))
        .map_err(|error| format!("invalid_scope_kind:{error}"))?;
    Ok(AnalyticsOutboxRecord {
        outbox_id: row.outbox_id,
        source_service: row.source_service,
        source_domain: row.source_domain,
        source_stream_key: row.source_stream_key,
        record_category,
        record_id: row.record_id,
        contract_name: row.contract_name,
        schema_version: row.schema_version,
        scope_kind,
        scope_external_id: row.scope_external_id,
        idempotency_key: row.idempotency_key,
        envelope: row.envelope,
        payload_hash: row.payload_hash,
    })
}

async fn load_meta_conversations(
    pool: &PgPool,
    organization_id: &str,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    cursor: Option<&(DateTime<Utc>, String)>,
    limit: i64,
) -> Result<Vec<MetaConversationBackfillRow>, sqlx::Error> {
    let query = r#"
        SELECT id, channel, "createdAt" AS created_at
        FROM "Conversation"
        WHERE "orgId" = $1
          AND channel IN ('facebook', 'instagram')
          AND "createdAt" >= $2
          AND "createdAt" < $3
          AND ($4::timestamptz IS NULL OR ("createdAt", id) > ($4, $5))
        ORDER BY "createdAt", id
        LIMIT $6
    "#;
    sqlx::query_as::<_, MetaConversationBackfillRow>(query)
        .bind(organization_id)
        .bind(range_start)
        .bind(range_end)
        .bind(cursor.map(|value| value.0))
        .bind(cursor.map(|value| value.1.as_str()))
        .bind(limit)
        .fetch_all(pool)
        .await
}

async fn load_meta_messages(
    pool: &PgPool,
    organization_id: &str,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    cursor: Option<&(DateTime<Utc>, String)>,
    limit: i64,
) -> Result<Vec<MetaMessageBackfillRow>, sqlx::Error> {
    let query = r#"
        SELECT message.id,
               message."conversationId" AS conversation_id,
               conversation.channel,
               message.sender,
               message."contentType"::text AS message_type,
               message."providerMetadata" ->> '_kasitek_agent_idempotency_key'
                   AS agent_idempotency_key,
               message."providerMetadata" ->> '_kasitek_inbox_message_kind'
                   AS inbox_message_kind,
               message.timestamp AS occurred_at
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation.channel IN ('facebook', 'instagram')
          AND message.timestamp >= $2
          AND message.timestamp < $3
          AND ($4::timestamptz IS NULL OR (message.timestamp, message.id) > ($4, $5))
        ORDER BY message.timestamp, message.id
        LIMIT $6
    "#;
    sqlx::query_as::<_, MetaMessageBackfillRow>(query)
        .bind(organization_id)
        .bind(range_start)
        .bind(range_end)
        .bind(cursor.map(|value| value.0))
        .bind(cursor.map(|value| value.1.as_str()))
        .bind(limit)
        .fetch_all(pool)
        .await
}

fn meta_responder_type(
    sender: &str,
    agent_idempotency_key: Option<&str>,
    inbox_message_kind: Option<&str>,
) -> &'static str {
    if sender == "customer" {
        "customer"
    } else if agent_idempotency_key.is_some_and(|value| !value.is_empty()) {
        "agent"
    } else if inbox_message_kind == Some("template") {
        "system"
    } else {
        "human"
    }
}

fn settings_from_env() -> Option<Settings> {
    let token = env::var("ANALYTICS_CORE_INGESTION_TOKEN")
        .ok()
        .or_else(|| env::var("ANALYTICS_INGESTION_TOKEN").ok())
        .filter(|value| !value.trim().is_empty())?;
    Some(Settings {
        endpoint: env::var("ANALYTICS_INGESTION_URL")
            .unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string()),
        token,
        producer_id: env_string("ANALYTICS_CORE_PRODUCER_ID", DEFAULT_PRODUCER_ID),
        batch_size: env_i64("ANALYTICS_BACKFILL_BATCH_SIZE", DEFAULT_BATCH_SIZE).clamp(1, 500),
        request_timeout: Duration::from_millis(env_u64(
            "ANALYTICS_BACKFILL_REQUEST_TIMEOUT_MS",
            10_000,
        )),
    })
}

fn poll_interval() -> Duration {
    Duration::from_millis(env_u64(
        "ANALYTICS_BACKFILL_POLL_INTERVAL_MS",
        DEFAULT_POLL_INTERVAL_MS,
    ))
}

fn env_string(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_i64(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &u64| *value > 0)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use analytics_producer::{RecordCategory, ScopeKind};
    use chrono::Utc;
    use serde_json::json;

    use super::{
        build_campaign_backfill_record, build_connections_backfill_record, meta_responder_type,
        ConnectionsBackfillRow,
    };

    #[test]
    fn meta_responder_mapping_preserves_agent_and_system_boundaries() {
        assert_eq!(meta_responder_type("customer", None, None), "customer");
        assert_eq!(meta_responder_type("bot", Some("run-1"), None), "agent");
        assert_eq!(meta_responder_type("bot", None, Some("template")), "system");
        assert_eq!(meta_responder_type("bot", None, None), "human");
    }

    #[test]
    fn connections_backfill_reuses_only_the_immutable_safe_event_envelope() {
        let row = ConnectionsBackfillRow {
            source_sequence: 12,
            outbox_id: "outbox-12".to_string(),
            source_service: "core".to_string(),
            source_domain: "connections".to_string(),
            source_stream_key: "organization:org-1:connections".to_string(),
            record_category: "event".to_string(),
            record_id: "connection:ext-1:lifecycle:connected:12".to_string(),
            contract_name: "connection.lifecycle@1".to_string(),
            schema_version: 1,
            scope_kind: "core_organization".to_string(),
            scope_external_id: "org-1".to_string(),
            idempotency_key: "connection:ext-1:lifecycle:connected:12".to_string(),
            envelope: json!({
                "specversion": "1.0",
                "id": "event-12",
                "source": "kasitek://core",
                "type": "connection.lifecycle@1",
                "subject": "connection:ext-1",
                "time": Utc::now(),
                "datacontenttype": "application/json",
                "dataschema": "https://kasitek.co.za/analytics/contracts/events/connections/lifecycle/v1.schema.json",
                "source_service": "core",
                "source_domain": "connections",
                "record_category": "event",
                "scope_kind": "core_organization",
                "scope_external_id": "org-1",
                "idempotency_key": "connection:ext-1:lifecycle:connected:12",
                "data": {
                    "connection_id": "ext-1",
                    "provider": "WHATSAPP",
                    "action": "connected",
                    "status": "CONNECTED"
                }
            }),
            payload_hash: "a".repeat(64),
        };

        let record = build_connections_backfill_record(row).expect("safe event row");
        assert_eq!(record.record_category, RecordCategory::Event);
        assert_eq!(record.scope_kind, ScopeKind::CoreOrganization);
        assert_eq!(record.source_domain, "connections");
        assert_eq!(record.record_id, "connection:ext-1:lifecycle:connected:12");
        assert_eq!(record.envelope["data"]["provider"], "WHATSAPP");
    }

    #[test]
    fn connections_backfill_rejects_non_event_source_rows() {
        let row = ConnectionsBackfillRow {
            source_sequence: 13,
            outbox_id: "outbox-13".to_string(),
            source_service: "core".to_string(),
            source_domain: "connections".to_string(),
            source_stream_key: "organization:org-1:connections".to_string(),
            record_category: "manifest".to_string(),
            record_id: "manifest:connections:13".to_string(),
            contract_name: "source.manifest@1".to_string(),
            schema_version: 1,
            scope_kind: "core_organization".to_string(),
            scope_external_id: "org-1".to_string(),
            idempotency_key: "manifest:connections:13".to_string(),
            envelope: json!({}),
            payload_hash: "b".repeat(64),
        };

        assert_eq!(
            build_connections_backfill_record(row).expect_err("manifest must not be reconstructed"),
            "connections_backfill_requires_event_record"
        );
    }

    #[test]
    fn campaign_backfill_accepts_only_campaign_event_streams() {
        let row = ConnectionsBackfillRow {
            source_sequence: 21,
            outbox_id: "outbox-21".to_string(),
            source_service: "core".to_string(),
            source_domain: "campaigns".to_string(),
            source_stream_key: "organization:org-2:campaigns".to_string(),
            record_category: "event".to_string(),
            record_id: "campaign-recipient:campaign-2:recipient-2:sent".to_string(),
            contract_name: "campaign.recipient.sent@1".to_string(),
            schema_version: 1,
            scope_kind: "core_organization".to_string(),
            scope_external_id: "org-2".to_string(),
            idempotency_key: "campaign-recipient:campaign-2:recipient-2:sent".to_string(),
            envelope: json!({
                "type": "campaign.recipient.sent@1",
                "source_domain": "campaigns",
                "record_category": "event",
                "scope_kind": "core_organization",
                "scope_external_id": "org-2",
                "data": { "campaign_id": "campaign-2", "recipient_id": "recipient-2" }
            }),
            payload_hash: "c".repeat(64),
        };

        let record = build_campaign_backfill_record(row).expect("campaign event row");
        assert_eq!(record.record_category, RecordCategory::Event);
        assert_eq!(record.scope_kind, ScopeKind::CoreOrganization);
        assert_eq!(record.source_domain, "campaigns");
    }
}
