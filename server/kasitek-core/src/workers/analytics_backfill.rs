//! Core-owned source reconstruction for authenticated Analytics backfill jobs.
//!
//! This worker reads only the authoritative Core rows needed for the leased source boundary. It
//! never reads Analytics storage, never sends message content or provider identifiers, and never
//! uses the live outbox. Re-running a range is safe because the record identities and source
//! sequences are deterministic.

use std::{env, time::Duration};

use analytics_producer::{
    backfill_source_sequence, AnalyticsIngestionClient, BackfillRecord, SourceBackfillWork,
};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};

use crate::analytics;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4300";
const DEFAULT_PRODUCER_ID: &str = "core-customer-analytics";
const DEFAULT_BATCH_SIZE: i64 = 100;
const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;
const META_SOURCE_DOMAIN: &str = "inbox";
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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct BackfillStats {
    conversation_records: usize,
    message_records: usize,
    rejected_records: usize,
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
                if work.source_domain != META_SOURCE_DOMAIN
                    || work.method != SOURCE_RECONSTRUCTION_METHOD
                {
                    log::warn!(
                        "[analytics-backfill] unsupported source job={} domain={} method={}",
                        work.job_id,
                        work.source_domain,
                        work.method
                    );
                } else {
                    match process_meta_source_reconstruction(
                        &pool,
                        &client,
                        &settings,
                        &work,
                    )
                    .await
                    {
                        Ok(stats) => log::info!(
                            "[analytics-backfill] completed pass job={} conversations={} messages={} rejected={}",
                            work.job_id,
                            stats.conversation_records,
                            stats.message_records,
                            stats.rejected_records
                        ),
                        Err(error) => log::error!(
                            "[analytics-backfill] pass failed job={} error={}",
                            work.job_id,
                            error
                        ),
                    }
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
    use super::meta_responder_type;

    #[test]
    fn meta_responder_mapping_preserves_agent_and_system_boundaries() {
        assert_eq!(meta_responder_type("customer", None, None), "customer");
        assert_eq!(meta_responder_type("bot", Some("run-1"), None), "agent");
        assert_eq!(meta_responder_type("bot", None, Some("template")), "system");
        assert_eq!(meta_responder_type("bot", None, None), "human");
    }
}
