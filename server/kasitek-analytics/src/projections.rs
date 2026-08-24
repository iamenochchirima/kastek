//! Durable, generation-scoped projection processing.
//!
//! This module intentionally owns only the projection runtime boundary. Metric definitions and
//! source contracts remain registry data, immutable facts remain in the ingestion tables, and
//! reporting APIs later decide which promoted generation and rollup interval to read.

use std::{collections::BTreeMap, env, time::Duration};

use chrono::{DateTime, Duration as ChronoDuration, TimeZone, Utc};
use serde_json::{Map, Value};
use sqlx::{postgres::PgRow, PgPool, Postgres, Row, Transaction};

use crate::{
    contracts::SERVICE_NAME,
    registry::{MetricDefinition, RegistrySnapshot},
};

pub const PROJECTION_NAME: &str = "typed_domain_facts";
pub const PROJECTION_VERSION: &str = "1";
pub const DEFAULT_SHARD_KEY: &str = "default";
const DEFAULT_POLL_INTERVAL_MS: u64 = 1_000;
const DEFAULT_LEASE_SECONDS: i64 = 60;
const DEFAULT_BATCH_SIZE: usize = 25;
const MAX_ATTEMPTS: i32 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FactKind {
    Event,
    Observation,
}

impl FactKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Observation => "observation",
        }
    }
}

#[derive(Clone, Debug)]
pub struct FactWindow {
    pub fact_kind: FactKind,
    pub reporting_scope_id: i64,
    pub root_scope_id: i64,
    pub source_storage_id: i64,
    pub source_window_start: DateTime<Utc>,
    pub source_window_end: DateTime<Utc>,
}

pub async fn enqueue_fact(
    transaction: &mut Transaction<'_, Postgres>,
    fact: FactWindow,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_work (
             projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
             source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
             priority
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,100)
           ON CONFLICT (
             projection_name, projection_version, fact_kind, reporting_scope_id,
             source_window_start, source_window_end
           ) WHERE generation_id IS NULL
           DO UPDATE SET
             min_source_storage_id = LEAST(analytics.analytics_projection_work.min_source_storage_id, EXCLUDED.min_source_storage_id),
             max_source_storage_id = GREATEST(analytics.analytics_projection_work.max_source_storage_id, EXCLUDED.max_source_storage_id),
             work_status = CASE
               WHEN analytics.analytics_projection_work.work_status IN ('completed', 'failed', 'cancelled')
                 THEN 'pending'
               ELSE analytics.analytics_projection_work.work_status
             END,
             available_at = LEAST(analytics.analytics_projection_work.available_at, EXCLUDED.available_at),
             completed_at = CASE
               WHEN analytics.analytics_projection_work.work_status IN ('completed', 'failed', 'cancelled')
                 THEN NULL
               ELSE analytics.analytics_projection_work.completed_at
             END,
             last_error_code = NULL,
             last_error_message = NULL"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(fact.fact_kind.as_str())
    .bind(fact.reporting_scope_id)
    .bind(fact.root_scope_id)
    .bind(fact.source_window_start)
    .bind(fact.source_window_end)
    .bind(fact.source_storage_id)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id,
             shard_key, processing_status
           ) VALUES ($1,$2,$3,$4,$5,'idle')
           ON CONFLICT (projection_name, projection_version, reporting_scope_id, shard_key)
           DO UPDATE SET root_scope_id = EXCLUDED.root_scope_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(fact.reporting_scope_id)
    .bind(fact.root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

/// Requeues all durable fact windows for a source stream after reconciliation reports a mismatch.
/// The repair marker is operational metadata only; immutable facts remain the rebuild input.
pub async fn enqueue_reconciliation_repair(
    pool: &PgPool,
    producer_id: &str,
    source_stream_key: &str,
    reporting_scope_id: i64,
    root_scope_id: i64,
) -> Result<u64, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let windows = sqlx::query(
        r#"SELECT 'event' AS fact_kind,
                  date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS window_start,
                  (date_trunc('hour', occurred_at AT TIME ZONE 'UTC') + INTERVAL '1 hour') AT TIME ZONE 'UTC' AS window_end,
                  MIN(storage_id) AS min_storage_id, MAX(storage_id) AS max_storage_id
           FROM analytics.analytics_event
           WHERE producer_id = $1 AND source_stream_key = $2 AND reporting_scope_id = $3
           GROUP BY 1, 2, 3
           UNION ALL
           SELECT 'observation' AS fact_kind, reporting_window_start, reporting_window_end,
                  MIN(storage_id), MAX(storage_id)
           FROM analytics.analytics_metric_observation
           WHERE producer_id = $1 AND source_stream_key = $2 AND reporting_scope_id = $3
           GROUP BY 1, 2, 3
           ORDER BY window_start"#,
    )
    .bind(producer_id)
    .bind(source_stream_key)
    .bind(reporting_scope_id)
    .fetch_all(&mut *transaction)
    .await?;

    let mut enqueued = 0;
    for window in windows {
        let result = sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_work (
                 projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
                 source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
                 priority, repair_reason, work_status
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,25,'reconciliation_mismatch','pending')
               ON CONFLICT (
                 projection_name, projection_version, fact_kind, reporting_scope_id,
                 source_window_start, source_window_end
               ) WHERE generation_id IS NULL
               DO UPDATE SET
                 min_source_storage_id = LEAST(analytics.analytics_projection_work.min_source_storage_id, EXCLUDED.min_source_storage_id),
                 max_source_storage_id = GREATEST(analytics.analytics_projection_work.max_source_storage_id, EXCLUDED.max_source_storage_id),
                 priority = LEAST(analytics.analytics_projection_work.priority, EXCLUDED.priority),
                 repair_reason = 'reconciliation_mismatch',
                 work_status = CASE
                   WHEN analytics.analytics_projection_work.work_status IN ('completed', 'failed', 'cancelled')
                     THEN 'pending'
                   ELSE analytics.analytics_projection_work.work_status
                 END,
                 available_at = LEAST(analytics.analytics_projection_work.available_at, EXCLUDED.available_at),
                 completed_at = CASE
                   WHEN analytics.analytics_projection_work.work_status IN ('completed', 'failed', 'cancelled')
                     THEN NULL
                   ELSE analytics.analytics_projection_work.completed_at
                 END"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(window.try_get::<String, _>("fact_kind")?)
        .bind(reporting_scope_id)
        .bind(root_scope_id)
        .bind(window.try_get::<DateTime<Utc>, _>("window_start")?)
        .bind(window.try_get::<DateTime<Utc>, _>("window_end")?)
        .bind(window.try_get::<i64, _>("min_storage_id")?)
        .bind(window.try_get::<i64, _>("max_storage_id")?)
        .execute(&mut *transaction)
        .await?;
        enqueued += result.rows_affected();
    }

    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id,
             shard_key, processing_status
           ) VALUES ($1,$2,$3,$4,$5,'idle')
           ON CONFLICT (projection_name, projection_version, reporting_scope_id, shard_key)
           DO UPDATE SET root_scope_id = EXCLUDED.root_scope_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(enqueued)
}

/// Requests a deterministic shadow rebuild for one reporting scope.
///
/// The current checkpoint generation is left untouched while all existing source windows are
/// attached to the new generation. The normal worker promotes the shadow only after every window
/// has completed successfully.
pub async fn request_rebuild(
    pool: &PgPool,
    reporting_scope_id: i64,
    root_scope_id: i64,
    requested_by: &str,
    registry_sha256: &str,
) -> Result<i64, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{}:{}:{}:{}",
            PROJECTION_NAME, PROJECTION_VERSION, reporting_scope_id, DEFAULT_SHARD_KEY
        ))
        .execute(&mut *transaction)
        .await?;

    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id,
             shard_key, processing_status
           ) VALUES ($1,$2,$3,$4,$5,'rebuilding')
           ON CONFLICT (projection_name, projection_version, reporting_scope_id, shard_key)
           DO UPDATE SET root_scope_id = EXCLUDED.root_scope_id,
                         processing_status = 'rebuilding',
                         rebuild_requested_at = NOW()"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut *transaction)
    .await?;

    let generation_number: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(MAX(generation_number), 0) + 1
           FROM analytics.analytics_projection_generation
           WHERE projection_name = $1 AND projection_version = $2
             AND reporting_scope_id = $3 AND shard_key = $4"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .fetch_one(&mut *transaction)
    .await?;
    let generation_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_generation (
             projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
             generation_number, generation_status, metric_registry_sha256,
             created_by_type, created_by_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'building',$7,'rebuild_request',$8)
           RETURNING generation_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .bind(generation_number)
    .bind(registry_sha256)
    .bind(requested_by)
    .fetch_one(&mut *transaction)
    .await?;

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_checkpoint
           SET rebuild_generation_id = $1, processing_status = 'rebuilding', rebuild_requested_at = NOW()
           WHERE projection_name = $2 AND projection_version = $3
             AND reporting_scope_id = $4 AND shard_key = $5"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut *transaction)
    .await?;

    let windows = sqlx::query(
        r#"SELECT 'event' AS fact_kind,
                  date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS window_start,
                  (date_trunc('hour', occurred_at AT TIME ZONE 'UTC') + INTERVAL '1 hour') AT TIME ZONE 'UTC' AS window_end,
                  MIN(storage_id) AS min_storage_id, MAX(storage_id) AS max_storage_id
           FROM analytics.analytics_event
           WHERE reporting_scope_id = $1
           GROUP BY 1, 2, 3
           UNION ALL
           SELECT 'observation' AS fact_kind, reporting_window_start, reporting_window_end,
                  MIN(storage_id), MAX(storage_id)
           FROM analytics.analytics_metric_observation
           WHERE reporting_scope_id = $1
           GROUP BY 1, 2, 3
           ORDER BY window_start"#,
    )
    .bind(reporting_scope_id)
    .fetch_all(&mut *transaction)
    .await?;

    for window in &windows {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_work (
                 projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
                 source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
                 generation_id, priority, work_status
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,600,'pending')
               ON CONFLICT DO NOTHING"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(window.try_get::<String, _>("fact_kind")?)
        .bind(reporting_scope_id)
        .bind(root_scope_id)
        .bind(window.try_get::<DateTime<Utc>, _>("window_start")?)
        .bind(window.try_get::<DateTime<Utc>, _>("window_end")?)
        .bind(window.try_get::<i64, _>("min_storage_id")?)
        .bind(window.try_get::<i64, _>("max_storage_id")?)
        .bind(generation_id)
        .execute(&mut *transaction)
        .await?;
    }

    if windows.is_empty() {
        promote_empty_generation(&mut transaction, generation_id, reporting_scope_id).await?;
    }

    transaction.commit().await?;
    Ok(generation_id)
}

/// Requeues projection windows for immutable facts inside a requested time range.
///
/// Fact replay does not rewrite facts or create a new generation. It simply makes the normal
/// projection worker revisit the affected windows, preserving the same idempotent projection
/// boundary used by live ingestion.
pub async fn enqueue_replay_range(
    pool: &PgPool,
    reporting_scope_id: i64,
    root_scope_id: i64,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let windows = sqlx::query(
        r#"SELECT 'event' AS fact_kind,
                  date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS window_start,
                  (date_trunc('hour', occurred_at AT TIME ZONE 'UTC') + INTERVAL '1 hour') AT TIME ZONE 'UTC' AS window_end,
                  MIN(storage_id) AS min_storage_id, MAX(storage_id) AS max_storage_id
           FROM analytics.analytics_event
           WHERE reporting_scope_id = $1 AND occurred_at >= $2 AND occurred_at < $3
           GROUP BY 1, 2, 3
           UNION ALL
           SELECT 'observation' AS fact_kind, reporting_window_start, reporting_window_end,
                  MIN(storage_id), MAX(storage_id)
           FROM analytics.analytics_metric_observation
           WHERE reporting_scope_id = $1
             AND reporting_window_start >= $2 AND reporting_window_start < $3
           GROUP BY 1, 2, 3
           ORDER BY window_start"#,
    )
    .bind(reporting_scope_id)
    .bind(range_start)
    .bind(range_end)
    .fetch_all(&mut *transaction)
    .await?;

    let mut enqueued = 0;
    for window in windows {
        let reset = sqlx::query(
            r#"UPDATE analytics.analytics_projection_work AS work
               SET min_source_storage_id = LEAST(work.min_source_storage_id, $7),
                   max_source_storage_id = GREATEST(work.max_source_storage_id, $8),
                   work_status = 'pending',
                   available_at = NOW(),
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   attempt_count = 0,
                   last_error_code = NULL,
                   last_error_message = NULL,
                   completed_at = NULL
               WHERE work.work_id = (
                 SELECT candidate.work_id
                 FROM analytics.analytics_projection_work AS candidate
                 JOIN analytics.analytics_projection_checkpoint AS checkpoint
                   ON checkpoint.generation_id = candidate.generation_id
                 WHERE candidate.projection_name = $1
                   AND candidate.projection_version = $2
                   AND candidate.fact_kind = $3
                   AND candidate.reporting_scope_id = $4
                   AND candidate.source_window_start = $5
                   AND candidate.source_window_end = $6
                   AND checkpoint.projection_name = $1
                   AND checkpoint.projection_version = $2
                   AND checkpoint.reporting_scope_id = $4
                   AND checkpoint.shard_key = $9
                 ORDER BY candidate.work_id DESC
                 LIMIT 1
               )"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(window.try_get::<String, _>("fact_kind")?)
        .bind(reporting_scope_id)
        .bind(window.try_get::<DateTime<Utc>, _>("window_start")?)
        .bind(window.try_get::<DateTime<Utc>, _>("window_end")?)
        .bind(window.try_get::<i64, _>("min_storage_id")?)
        .bind(window.try_get::<i64, _>("max_storage_id")?)
        .bind(DEFAULT_SHARD_KEY)
        .execute(&mut *transaction)
        .await?;

        if reset.rows_affected() > 0 {
            enqueued += 1;
            continue;
        }

        let result = sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_work (
                 projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
                 source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
                 priority, work_status
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,700,'pending')
               ON CONFLICT DO NOTHING"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(window.try_get::<String, _>("fact_kind")?)
        .bind(reporting_scope_id)
        .bind(root_scope_id)
        .bind(window.try_get::<DateTime<Utc>, _>("window_start")?)
        .bind(window.try_get::<DateTime<Utc>, _>("window_end")?)
        .bind(window.try_get::<i64, _>("min_storage_id")?)
        .bind(window.try_get::<i64, _>("max_storage_id")?)
        .execute(&mut *transaction)
        .await?;
        enqueued += result.rows_affected();
    }

    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id,
             shard_key, processing_status
           ) VALUES ($1,$2,$3,$4,$5,'idle')
           ON CONFLICT (projection_name, projection_version, reporting_scope_id, shard_key)
           DO UPDATE SET root_scope_id = EXCLUDED.root_scope_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;
    Ok(enqueued)
}

async fn promote_empty_generation(
    transaction: &mut Transaction<'_, Postgres>,
    generation_id: i64,
    reporting_scope_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE analytics.analytics_projection_generation
           SET generation_status = 'superseded'
           WHERE projection_name = $1 AND projection_version = $2
             AND reporting_scope_id = $3 AND shard_key = $4
             AND generation_status = 'promoted' AND generation_id <> $5"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE analytics.analytics_projection_generation
           SET generation_status = 'validated', validated_at = NOW(), validation_summary = '{"status":"passed","source_facts":0}'
           WHERE generation_id = $1"#,
    )
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE analytics.analytics_projection_generation
           SET generation_status = 'promoted', promoted_at = NOW()
           WHERE generation_id = $1"#,
    )
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE analytics.analytics_projection_checkpoint
           SET generation_id = $1, rebuild_generation_id = NULL,
               processing_status = 'idle', rebuild_requested_at = NULL
           WHERE projection_name = $2 AND projection_version = $3
             AND reporting_scope_id = $4 AND shard_key = $5"#,
    )
    .bind(generation_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[derive(Clone, Debug)]
struct ClaimedWork {
    work_id: i64,
    fact_kind: FactKind,
    reporting_scope_id: i64,
    root_scope_id: i64,
    source_window_start: DateTime<Utc>,
    source_window_end: DateTime<Utc>,
    max_source_storage_id: i64,
    generation_id: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
struct GenerationSelection {
    generation_id: i64,
    shadow: bool,
    rebuild_in_progress: bool,
}

#[derive(Clone, Debug)]
struct ProjectionFact {
    fact_kind: FactKind,
    source_storage_id: i64,
    metric: MetricIdentity,
    target_scope_id: i64,
    source_scope_id: i64,
    root_scope_id: i64,
    bucket_start: DateTime<Utc>,
    bucket_end: DateTime<Utc>,
    timezone_name: String,
    timezone_revision: i32,
    dimensions: Value,
    value: f64,
    numerator: Option<f64>,
    denominator: Option<f64>,
    deduplication_key: Option<String>,
    builder_name: &'static str,
    coverage: Value,
}

#[derive(Clone, Debug)]
struct MetricIdentity {
    key: String,
    version: i32,
}

impl MetricIdentity {
    fn from_definition(metric: &MetricDefinition) -> Self {
        Self {
            key: metric.key.clone(),
            version: metric.version as i32,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DomainBuilder {
    Agents,
    Campaigns,
    Connections,
    Inbox,
    Tenants,
}

impl DomainBuilder {
    fn for_metric(metric: &MetricDefinition) -> Result<Self, sqlx::Error> {
        match metric.domain.as_str() {
            "agents" => Ok(Self::Agents),
            "campaigns" => Ok(Self::Campaigns),
            "connections" => Ok(Self::Connections),
            "inbox" => Ok(Self::Inbox),
            "tenants" => Ok(Self::Tenants),
            domain => Err(sqlx::Error::Protocol(format!(
                "no typed projection builder for domain {domain}"
            ))),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Agents => "agents.v1",
            Self::Campaigns => "campaigns.v1",
            Self::Connections => "connections.v1",
            Self::Inbox => "inbox.v1",
            Self::Tenants => "tenants.v1",
        }
    }
}

pub async fn process_once(
    pool: &PgPool,
    registry: &RegistrySnapshot,
    worker_id: &str,
    lease_seconds: i64,
) -> Result<bool, sqlx::Error> {
    let Some(work) = claim_work(pool, worker_id, lease_seconds).await? else {
        return Ok(false);
    };

    match process_work(pool, registry, worker_id, &work).await {
        Ok(()) => Ok(true),
        Err(error) => {
            mark_failed(pool, &work, worker_id, &error.to_string()).await?;
            Err(error)
        }
    }
}

pub async fn run(pool: PgPool, registry: RegistrySnapshot) -> Result<(), std::io::Error> {
    let worker_id = env::var("ANALYTICS_PROJECTION_WORKER_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("analytics-worker-{}", std::process::id()));
    let poll_interval = env::var("ANALYTICS_PROJECTION_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    let lease_seconds = env::var("ANALYTICS_PROJECTION_LEASE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_LEASE_SECONDS);
    let batch_size = env::var("ANALYTICS_PROJECTION_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_BATCH_SIZE);

    log::info!(
        "service={} process=analytics-worker status=started projection={} version={} worker_id={} batch_size={}",
        SERVICE_NAME,
        PROJECTION_NAME,
        PROJECTION_VERSION,
        worker_id,
        batch_size
    );

    let mut interval = tokio::time::interval(Duration::from_millis(poll_interval));
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = interval.tick() => {
                if let Err(error) = crate::maintenance::run_once(
                    &pool,
                    &registry,
                    &worker_id,
                    lease_seconds,
                )
                .await
                {
                    log::error!(
                        "service={} process=analytics-worker status=maintenance_failed error={}",
                        SERVICE_NAME,
                        error
                    );
                }
                for _ in 0..batch_size {
                    match process_once(&pool, &registry, &worker_id, lease_seconds).await {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(error) => {
                            log::error!("service={} process=analytics-worker projection={} status=failed error={}", SERVICE_NAME, PROJECTION_NAME, error);
                            break;
                        }
                    }
                }
            }
        }
    }

    log::info!(
        "service={} process=analytics-worker status=stopping projection={}",
        SERVICE_NAME,
        PROJECTION_NAME
    );
    Ok(())
}

async fn claim_work(
    pool: &PgPool,
    worker_id: &str,
    lease_seconds: i64,
) -> Result<Option<ClaimedWork>, sqlx::Error> {
    let row = sqlx::query(
        r#"WITH candidate AS (
             SELECT work_id
             FROM analytics.analytics_projection_work
             WHERE projection_name = $1
               AND projection_version = $2
               AND attempt_count < $3
               AND (
                 (work_status IN ('pending', 'failed') AND available_at <= NOW())
                 OR (work_status = 'leased' AND lease_expires_at <= NOW())
               )
             ORDER BY priority ASC, available_at ASC, work_id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE analytics.analytics_projection_work AS work
           SET work_status = 'leased',
               lease_owner = $4,
               lease_expires_at = NOW() + make_interval(secs => $5),
               attempt_count = work.attempt_count + 1,
               last_error_code = NULL,
               last_error_message = NULL
           FROM candidate
           WHERE work.work_id = candidate.work_id
           RETURNING work.work_id, work.fact_kind, work.reporting_scope_id, work.root_scope_id,
                     work.source_window_start, work.source_window_end, work.max_source_storage_id,
                     work.generation_id, work.attempt_count"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(MAX_ATTEMPTS)
    .bind(worker_id)
    .bind(lease_seconds)
    .fetch_optional(pool)
    .await?;

    row.map(parse_claimed_work).transpose()
}

fn parse_claimed_work(row: PgRow) -> Result<ClaimedWork, sqlx::Error> {
    let fact_kind = row.try_get::<String, _>("fact_kind")?;
    if !matches!(fact_kind.as_str(), "event" | "observation") {
        return Err(sqlx::Error::Protocol("invalid projection fact kind".into()));
    }
    Ok(ClaimedWork {
        work_id: row.try_get("work_id")?,
        fact_kind: if fact_kind == "event" {
            FactKind::Event
        } else {
            FactKind::Observation
        },
        reporting_scope_id: row.try_get("reporting_scope_id")?,
        root_scope_id: row.try_get("root_scope_id")?,
        source_window_start: row.try_get("source_window_start")?,
        source_window_end: row.try_get("source_window_end")?,
        max_source_storage_id: row.try_get("max_source_storage_id")?,
        generation_id: row.try_get("generation_id")?,
    })
}

async fn process_work(
    pool: &PgPool,
    registry: &RegistrySnapshot,
    worker_id: &str,
    work: &ClaimedWork,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{}:{}:{}:{}",
            PROJECTION_NAME, PROJECTION_VERSION, work.reporting_scope_id, DEFAULT_SHARD_KEY
        ))
        .execute(&mut *transaction)
        .await?;

    let selection = ensure_generation(&mut transaction, registry, worker_id, work).await?;
    rebuild_window(&mut transaction, registry, selection.generation_id, work).await?;

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_work
           SET work_status = CASE
                 WHEN max_source_storage_id > $2 THEN 'pending'
                 ELSE 'completed'
               END,
               generation_id = CASE
                 WHEN $5 AND generation_id IS NULL THEN NULL
                 ELSE COALESCE(generation_id, $3)
               END,
               lease_owner = NULL,
               lease_expires_at = NULL,
               completed_at = CASE
                 WHEN max_source_storage_id > $2 THEN NULL
                 ELSE NOW()
               END,
               last_error_code = NULL,
               last_error_message = NULL
           WHERE work_id = $1 AND work_status = 'leased' AND lease_owner = $4"#,
    )
    .bind(work.work_id)
    .bind(work.max_source_storage_id)
    .bind(selection.generation_id)
    .bind(worker_id)
    .bind(selection.shadow)
    .execute(&mut *transaction)
    .await?;

    let remaining: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM analytics.analytics_projection_work
           WHERE projection_name = $1
             AND projection_version = $2
             AND reporting_scope_id = $3
             AND work_status IN ('pending', 'leased', 'failed')
             AND (
               generation_id = $4
               OR ($5 AND generation_id IS NULL)
             )"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(selection.generation_id)
    .bind(selection.shadow || work.generation_id.is_none())
    .fetch_one(&mut *transaction)
    .await?;

    if remaining == 0 && (selection.shadow || !selection.rebuild_in_progress) {
        finish_generation(&mut transaction, selection, work, registry).await?;
    } else {
        sqlx::query(
            r#"UPDATE analytics.analytics_projection_checkpoint
               SET generation_id = CASE WHEN $3 THEN generation_id ELSE $5 END,
                   rebuild_generation_id = CASE WHEN $3 THEN $5 ELSE rebuild_generation_id END,
                   root_scope_id = $4,
                   last_processed_storage_id = GREATEST(last_processed_storage_id, $1),
                   last_processed_work_id = GREATEST(last_processed_work_id, $2),
                   processing_status = CASE
                     WHEN $3 OR $10 THEN 'rebuilding'
                     ELSE 'running'
                   END,
                   lease_owner = NULL,
                   lease_expires_at = NULL
               WHERE projection_name = $6
                 AND projection_version = $7
                 AND reporting_scope_id = $8
                 AND shard_key = $9"#,
        )
        .bind(work.max_source_storage_id)
        .bind(work.work_id)
        .bind(selection.shadow)
        .bind(work.root_scope_id)
        .bind(selection.generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(work.reporting_scope_id)
        .bind(DEFAULT_SHARD_KEY)
        .bind(selection.rebuild_in_progress)
        .execute(&mut *transaction)
        .await?;
    }

    transaction.commit().await
}

async fn ensure_generation(
    transaction: &mut Transaction<'_, Postgres>,
    registry: &RegistrySnapshot,
    worker_id: &str,
    work: &ClaimedWork,
) -> Result<GenerationSelection, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_checkpoint (
             projection_name, projection_version, reporting_scope_id, root_scope_id,
             shard_key, processing_status
           ) VALUES ($1,$2,$3,$4,$5,'running')
           ON CONFLICT (projection_name, projection_version, reporting_scope_id, shard_key)
           DO UPDATE SET root_scope_id = EXCLUDED.root_scope_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(work.root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut **transaction)
    .await?;

    let checkpoint = sqlx::query(
        r#"SELECT generation_id, rebuild_generation_id, processing_status
           FROM analytics.analytics_projection_checkpoint
           WHERE projection_name = $1 AND projection_version = $2
             AND reporting_scope_id = $3 AND shard_key = $4
           FOR UPDATE"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .fetch_one(&mut **transaction)
    .await?;

    let checkpoint_generation: Option<i64> = checkpoint.try_get("generation_id")?;
    let rebuild_generation: Option<i64> = checkpoint.try_get("rebuild_generation_id")?;
    let selection = if let Some(generation_id) = work.generation_id {
        Some(GenerationSelection {
            generation_id,
            shadow: true,
            rebuild_in_progress: true,
        })
    } else if let Some(generation_id) = checkpoint_generation {
        Some(GenerationSelection {
            generation_id,
            shadow: false,
            rebuild_in_progress: rebuild_generation.is_some(),
        })
    } else {
        rebuild_generation.map(|generation_id| GenerationSelection {
            generation_id,
            shadow: true,
            rebuild_in_progress: true,
        })
    };
    if let Some(selection) = selection {
        let generation_id = selection.generation_id;
        let status: String = sqlx::query_scalar(
            "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id = $1",
        )
        .bind(generation_id)
        .fetch_one(&mut **transaction)
        .await?;
        if matches!(status.as_str(), "building" | "validated" | "promoted") {
            sqlx::query(
                r#"UPDATE analytics.analytics_projection_checkpoint
                   SET generation_id = CASE WHEN $2 THEN generation_id ELSE $1 END,
                       rebuild_generation_id = CASE WHEN $2 THEN $1 ELSE rebuild_generation_id END,
                       processing_status = CASE WHEN $2 OR $7 THEN 'rebuilding' ELSE 'running' END
                   WHERE projection_name = $3 AND projection_version = $4
                     AND reporting_scope_id = $5 AND shard_key = $6"#,
            )
            .bind(generation_id)
            .bind(selection.shadow)
            .bind(PROJECTION_NAME)
            .bind(PROJECTION_VERSION)
            .bind(work.reporting_scope_id)
            .bind(DEFAULT_SHARD_KEY)
            .bind(selection.rebuild_in_progress)
            .execute(&mut **transaction)
            .await?;
            return Ok(selection);
        }
    }

    let next_generation: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(MAX(generation_number), 0) + 1
           FROM analytics.analytics_projection_generation
           WHERE projection_name = $1 AND projection_version = $2
             AND reporting_scope_id = $3 AND shard_key = $4"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .fetch_one(&mut **transaction)
    .await?;
    let generation_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_generation (
             projection_name, projection_version, reporting_scope_id, root_scope_id, shard_key,
             generation_number, generation_status, source_high_watermark, metric_registry_sha256,
             created_by_type, created_by_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'building',$7,$8,'worker',$9)
           RETURNING generation_id"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(work.root_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .bind(next_generation)
    .bind(work.max_source_storage_id)
    .bind(&registry.sha256)
    .bind(worker_id)
    .fetch_one(&mut **transaction)
    .await?;

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_checkpoint
           SET generation_id = CASE WHEN $2 THEN generation_id ELSE $1 END,
               rebuild_generation_id = CASE WHEN $2 THEN $1 ELSE rebuild_generation_id END,
               processing_status = CASE WHEN $2 THEN 'rebuilding' ELSE 'running' END
           WHERE projection_name = $3 AND projection_version = $4
             AND reporting_scope_id = $5 AND shard_key = $6"#,
    )
    .bind(generation_id)
    .bind(work.generation_id.is_some())
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut **transaction)
    .await?;

    Ok(GenerationSelection {
        generation_id,
        shadow: work.generation_id.is_some(),
        rebuild_in_progress: work.generation_id.is_some(),
    })
}

async fn rebuild_window(
    transaction: &mut Transaction<'_, Postgres>,
    registry: &RegistrySnapshot,
    generation_id: i64,
    work: &ClaimedWork,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"DELETE FROM analytics.analytics_projection_contribution
           WHERE generation_id = $1 AND source_scope_id = $2 AND source_kind = 'event'
             AND source_storage_id IN (
               SELECT storage_id FROM analytics.analytics_event
               WHERE reporting_scope_id = $2 AND occurred_at >= $3 AND occurred_at < $4
             )"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"DELETE FROM analytics.analytics_projection_contribution
           WHERE generation_id = $1 AND source_scope_id = $2 AND source_kind = 'observation'
             AND source_storage_id IN (
               SELECT storage_id FROM analytics.analytics_metric_observation
               WHERE reporting_scope_id = $2
                 AND reporting_window_start >= $3 AND reporting_window_start < $4
             )"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .execute(&mut **transaction)
    .await?;

    let mut facts = Vec::new();
    let event_rows = sqlx::query(
        r#"SELECT e.storage_id, e.event_type, e.reporting_scope_id AS source_scope_id,
                  e.subject_type, e.subject_id, e.occurred_at, e.attributes,
                  target.scope_id AS target_scope_id, target.root_scope_id AS target_root_scope_id,
                  target.scope_kind AS target_scope_kind, target.reporting_timezone AS timezone_name,
                  target.source_version AS timezone_revision,
                  date_trunc('hour', e.occurred_at AT TIME ZONE target.reporting_timezone)
                    AT TIME ZONE target.reporting_timezone AS bucket_start,
                  (date_trunc('hour', e.occurred_at AT TIME ZONE target.reporting_timezone)
                    + INTERVAL '1 hour') AT TIME ZONE target.reporting_timezone AS bucket_end
           FROM analytics.analytics_event e
           JOIN analytics.scope_ancestor hierarchy
             ON hierarchy.descendant_scope_id = e.reporting_scope_id
           JOIN analytics.reporting_scope target
             ON target.scope_id = hierarchy.ancestor_scope_id
           WHERE e.reporting_scope_id = $1
             AND e.occurred_at >= $2 AND e.occurred_at < $3
           ORDER BY e.storage_id, target.scope_id"#,
    )
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .fetch_all(&mut **transaction)
    .await?;
    for row in event_rows {
        let event_type: String = row.try_get("event_type")?;
        let attributes: Value = row.try_get("attributes")?;
        let subject_type: String = row.try_get("subject_type")?;
        let subject_id: String = row.try_get("subject_id")?;
        let target_scope_kind: String = row.try_get("target_scope_kind")?;
        let timezone_name: String = row.try_get("timezone_name")?;
        let timezone_revision: i64 = row.try_get("timezone_revision")?;
        let bucket_start: DateTime<Utc> = row.try_get("bucket_start")?;
        let bucket_end: DateTime<Utc> = row.try_get("bucket_end")?;
        for metric in registry
            .metrics
            .iter()
            .filter(|metric| metric.sources.iter().any(|source| source == &event_type))
        {
            if !metric
                .scope_kinds
                .iter()
                .any(|kind| kind == &target_scope_kind)
            {
                continue;
            }
            let builder = DomainBuilder::for_metric(metric)?;
            let dimensions =
                typed_event_dimensions(builder, metric, &attributes, &subject_type, &subject_id)?;
            let Some(value) = event_metric_value(metric, &attributes) else {
                continue;
            };
            let (numerator, denominator) = ratio_component(metric, &event_type, registry);
            if metric.default_aggregation == "ratio_of_sums"
                && numerator.is_none()
                && denominator.is_none()
            {
                continue;
            }
            facts.push(ProjectionFact {
                fact_kind: FactKind::Event,
                source_storage_id: row.try_get("storage_id")?,
                metric: MetricIdentity::from_definition(metric),
                target_scope_id: row.try_get("target_scope_id")?,
                source_scope_id: row.try_get("source_scope_id")?,
                root_scope_id: row.try_get("target_root_scope_id")?,
                bucket_start,
                bucket_end,
                timezone_name: timezone_name.clone(),
                timezone_revision: i32::try_from(timezone_revision).map_err(|_| {
                    sqlx::Error::Protocol("reporting timezone revision is out of range".into())
                })?,
                dimensions,
                value,
                numerator,
                denominator,
                deduplication_key: deduplication_key(metric, &attributes),
                builder_name: builder.name(),
                coverage: typed_coverage(metric, builder, FactKind::Event),
            });
        }
    }

    let observation_rows = sqlx::query(
        r#"SELECT o.storage_id, o.metric_key, o.numeric_value::DOUBLE PRECISION AS numeric_value,
                  o.reporting_scope_id AS source_scope_id, o.reporting_window_start, o.dimensions,
                  target.scope_id AS target_scope_id, target.root_scope_id AS target_root_scope_id,
                  target.scope_kind AS target_scope_kind, target.reporting_timezone AS timezone_name,
                  target.source_version AS timezone_revision,
                  date_trunc('hour', o.reporting_window_start AT TIME ZONE target.reporting_timezone)
                    AT TIME ZONE target.reporting_timezone AS bucket_start,
                  (date_trunc('hour', o.reporting_window_start AT TIME ZONE target.reporting_timezone)
                    + INTERVAL '1 hour') AT TIME ZONE target.reporting_timezone AS bucket_end
           FROM analytics.analytics_metric_observation o
           JOIN analytics.scope_ancestor hierarchy
             ON hierarchy.descendant_scope_id = o.reporting_scope_id
           JOIN analytics.reporting_scope target
             ON target.scope_id = hierarchy.ancestor_scope_id
           WHERE o.reporting_scope_id = $1
             AND o.reporting_window_start >= $2 AND o.reporting_window_start < $3
           ORDER BY o.storage_id, target.scope_id"#,
    )
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .fetch_all(&mut **transaction)
    .await?;
    for row in observation_rows {
        let metric_key: String = row.try_get("metric_key")?;
        let Some(metric) = registry
            .metrics
            .iter()
            .find(|metric| metric.key == metric_key)
        else {
            continue;
        };
        let target_scope_kind: String = row.try_get("target_scope_kind")?;
        if !metric
            .scope_kinds
            .iter()
            .any(|kind| kind == &target_scope_kind)
        {
            continue;
        }
        let builder = DomainBuilder::for_metric(metric)?;
        let dimensions: Value = row.try_get("dimensions")?;
        let value: f64 = row.try_get("numeric_value")?;
        facts.push(ProjectionFact {
            fact_kind: FactKind::Observation,
            source_storage_id: row.try_get("storage_id")?,
            metric: MetricIdentity::from_definition(metric),
            target_scope_id: row.try_get("target_scope_id")?,
            source_scope_id: row.try_get("source_scope_id")?,
            root_scope_id: row.try_get("target_root_scope_id")?,
            bucket_start: row.try_get("bucket_start")?,
            bucket_end: row.try_get("bucket_end")?,
            timezone_name: row.try_get("timezone_name")?,
            timezone_revision: i32::try_from(row.try_get::<i64, _>("timezone_revision")?).map_err(
                |_| sqlx::Error::Protocol("reporting timezone revision is out of range".into()),
            )?,
            dimensions: observation_dimensions(metric, &dimensions),
            value,
            numerator: None,
            denominator: None,
            deduplication_key: None,
            builder_name: builder.name(),
            coverage: typed_coverage(metric, builder, FactKind::Observation),
        });
    }

    for fact in facts {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_contribution (
                 generation_id, projection_name, projection_version, metric_key, metric_version,
                 source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
                 bucket_start, bucket_end, timezone_name, timezone_revision, dimensions,
                 deduplication_key, builder_name, value_count, value_sum, value_min, value_max,
                 numerator, denominator, source_high_watermark, coverage
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,$18,$18,$18,$19,$20,$7,$21)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(&fact.metric.key)
        .bind(fact.metric.version)
        .bind(fact.fact_kind.as_str())
        .bind(fact.source_storage_id)
        .bind(fact.target_scope_id)
        .bind(fact.source_scope_id)
        .bind(fact.root_scope_id)
        .bind(fact.bucket_start)
        .bind(fact.bucket_end)
        .bind(&fact.timezone_name)
        .bind(fact.timezone_revision)
        .bind(fact.dimensions)
        .bind(fact.deduplication_key)
        .bind(fact.builder_name)
        .bind(fact.value)
        .bind(fact.numerator)
        .bind(fact.denominator)
        .bind(fact.coverage)
        .execute(&mut **transaction)
        .await?;
    }

    rebuild_rollups(transaction, registry, generation_id, work).await
}

async fn rebuild_rollups(
    transaction: &mut Transaction<'_, Postgres>,
    registry: &RegistrySnapshot,
    generation_id: i64,
    work: &ClaimedWork,
) -> Result<(), sqlx::Error> {
    let rollup_start = work.source_window_start - ChronoDuration::days(31);
    let rollup_end = work.source_window_end + ChronoDuration::days(31);
    sqlx::query(
        r#"DELETE FROM analytics.analytics_projection_rollup
           WHERE generation_id = $1 AND source_scope_id = $2
             AND bucket_end > $3 AND bucket_start < $4"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(rollup_start)
    .bind(rollup_end)
    .execute(&mut **transaction)
    .await?;

    for metric in &registry.metrics {
        for interval in ["hour", "day", "month"] {
            if !metric
                .supported_intervals
                .iter()
                .any(|value| value == interval)
            {
                continue;
            }
            let bucket_expression = match interval {
                "hour" => "bucket_start",
                "day" => "date_trunc('day', bucket_start AT TIME ZONE timezone_name) AT TIME ZONE timezone_name",
                "month" => "date_trunc('month', bucket_start AT TIME ZONE timezone_name) AT TIME ZONE timezone_name",
                _ => unreachable!(),
            };
            let end_expression = match interval {
                "hour" => "bucket_end",
                "day" => "(date_trunc('day', bucket_start AT TIME ZONE timezone_name) + INTERVAL '1 day') AT TIME ZONE timezone_name",
                "month" => "(date_trunc('month', bucket_start AT TIME ZONE timezone_name) + INTERVAL '1 month') AT TIME ZONE timezone_name",
                _ => unreachable!(),
            };
            let value_count_expression = if metric.default_aggregation == "distinct_count" {
                "COUNT(DISTINCT deduplication_key)"
            } else {
                "COALESCE(SUM(value_count), 0)"
            };
            let value_sum_expression = if metric.default_aggregation == "ratio_of_sums" {
                "COALESCE(COALESCE(SUM(numerator), 0) / NULLIF(SUM(denominator), 0), 0)"
            } else {
                "COALESCE(SUM(value_sum), 0)"
            };
            let numerator_expression = if metric.default_aggregation == "ratio_of_sums" {
                "SUM(numerator)"
            } else {
                "NULL"
            };
            let denominator_expression = if metric.default_aggregation == "ratio_of_sums" {
                "SUM(denominator)"
            } else {
                "NULL"
            };
            let statement = format!(
                r#"INSERT INTO analytics.analytics_projection_rollup (
                     generation_id, projection_name, projection_version, metric_key, metric_version,
                     target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
                     timezone_name, timezone_revision, dimensions, value_count, value_sum, value_min,
                     value_max, numerator, denominator, source_high_watermark, coverage
                   )
                   SELECT generation_id, projection_name, projection_version, metric_key, metric_version,
                          target_scope_id, source_scope_id, root_scope_id, $4, {bucket}, {end},
                          timezone_name, timezone_revision, dimensions, {value_count}, {value_sum},
                          MIN(value_min), MAX(value_max), {numerator}, {denominator},
                          MAX(source_high_watermark),
                          jsonb_build_object(
                            'interval', $4,
                            'source_fact_count', COUNT(*),
                            'builder_names', jsonb_agg(DISTINCT builder_name),
                            'coverage_state', CASE
                              WHEN BOOL_AND(coverage ->> 'coverage_state' = 'observed')
                                THEN 'observed'
                              ELSE 'partial'
                            END,
                            'required_sources', $9::jsonb,
                            'exactness', $10
                          )
                   FROM analytics.analytics_projection_contribution
                   WHERE generation_id = $1 AND source_scope_id = $2
                     AND metric_key = $5 AND metric_version = $6
                     AND bucket_end > $7 AND bucket_start < $8
                   GROUP BY generation_id, projection_name, projection_version, metric_key, metric_version,
                            target_scope_id, source_scope_id, root_scope_id, timezone_name,
                            timezone_revision, dimensions, {bucket}, {end}
                   ON CONFLICT (
                     generation_id, metric_key, metric_version, target_scope_id, source_scope_id,
                     interval, bucket_start, bucket_end, dimensions
                   ) DO UPDATE SET
                     timezone_name = EXCLUDED.timezone_name,
                     timezone_revision = EXCLUDED.timezone_revision,
                     value_count = EXCLUDED.value_count,
                     value_sum = EXCLUDED.value_sum,
                     value_min = EXCLUDED.value_min,
                     value_max = EXCLUDED.value_max,
                     numerator = EXCLUDED.numerator,
                     denominator = EXCLUDED.denominator,
                     source_high_watermark = EXCLUDED.source_high_watermark,
                     coverage = EXCLUDED.coverage"#,
                bucket = bucket_expression,
                end = end_expression,
                value_count = value_count_expression,
                value_sum = value_sum_expression,
                numerator = numerator_expression,
                denominator = denominator_expression,
            );
            sqlx::query(&statement)
                .bind(generation_id)
                .bind(work.reporting_scope_id)
                .bind(work.root_scope_id)
                .bind(interval)
                .bind(&metric.key)
                .bind(metric.version as i32)
                .bind(rollup_start)
                .bind(rollup_end)
                .bind(
                    serde_json::to_value(&metric.coverage.required_sources)
                        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
                )
                .bind(&metric.exactness)
                .execute(&mut **transaction)
                .await?;
        }
    }
    Ok(())
}

async fn validate_projection_window(
    transaction: &mut Transaction<'_, Postgres>,
    registry: &RegistrySnapshot,
    generation_id: i64,
    work: &ClaimedWork,
) -> Result<Value, sqlx::Error> {
    let target_scopes = sqlx::query(
        r#"SELECT hierarchy.ancestor_scope_id AS scope_id, target.scope_kind
           FROM analytics.scope_ancestor hierarchy
           JOIN analytics.reporting_scope target
             ON target.scope_id = hierarchy.ancestor_scope_id
           WHERE hierarchy.descendant_scope_id = $1
           ORDER BY hierarchy.depth DESC"#,
    )
    .bind(work.reporting_scope_id)
    .fetch_all(&mut **transaction)
    .await?;

    let mut metrics_checked = 0_i64;
    let mut expected_source_facts = 0_i64;
    let mut contribution_rows = 0_i64;
    for metric in &registry.metrics {
        let builder = DomainBuilder::for_metric(metric)?;
        if !metric.scope_kinds.iter().any(|kind| {
            target_scopes
                .iter()
                .any(|scope| scope.try_get::<String, _>("scope_kind").ok().as_deref() == Some(kind))
        }) {
            continue;
        }
        let (expected, source_kind) = match work.fact_kind {
            FactKind::Event => {
                let source_count = sqlx::query_scalar::<_, i64>(
                    r#"SELECT COUNT(*) FROM analytics.analytics_event
                       WHERE reporting_scope_id = $1 AND occurred_at >= $2 AND occurred_at < $3
                         AND event_type = ANY($4)"#,
                )
                .bind(work.reporting_scope_id)
                .bind(work.source_window_start)
                .bind(work.source_window_end)
                .bind(&metric.sources)
                .fetch_one(&mut **transaction)
                .await?;
                let expected = if metric.default_aggregation == "weighted_average" {
                    let rows = sqlx::query(
                        r#"SELECT attributes FROM analytics.analytics_event
                           WHERE reporting_scope_id = $1 AND occurred_at >= $2 AND occurred_at < $3
                             AND event_type = ANY($4)"#,
                    )
                    .bind(work.reporting_scope_id)
                    .bind(work.source_window_start)
                    .bind(work.source_window_end)
                    .bind(&metric.sources)
                    .fetch_all(&mut **transaction)
                    .await?;
                    rows.into_iter()
                        .filter(|row| {
                            row.try_get::<Value, _>("attributes")
                                .ok()
                                .and_then(|value| event_metric_value(metric, &value))
                                .is_some()
                        })
                        .count() as i64
                } else {
                    source_count
                };
                (expected, FactKind::Event)
            }
            FactKind::Observation => (
                sqlx::query_scalar::<_, i64>(
                    r#"SELECT COUNT(*) FROM analytics.analytics_metric_observation
                       WHERE reporting_scope_id = $1
                         AND reporting_window_start >= $2 AND reporting_window_start < $3
                         AND metric_key = $4"#,
                )
                .bind(work.reporting_scope_id)
                .bind(work.source_window_start)
                .bind(work.source_window_end)
                .bind(&metric.key)
                .fetch_one(&mut **transaction)
                .await?,
                FactKind::Observation,
            ),
        };
        for scope in &target_scopes {
            let target_scope_id: i64 = scope.try_get("scope_id")?;
            let target_scope_kind: String = scope.try_get("scope_kind")?;
            if !metric
                .scope_kinds
                .iter()
                .any(|kind| kind == &target_scope_kind)
            {
                continue;
            }
            let actual: i64 = match source_kind {
                FactKind::Event => {
                    sqlx::query_scalar(
                        r#"SELECT COUNT(DISTINCT contribution.source_storage_id)
                       FROM analytics.analytics_projection_contribution contribution
                       WHERE contribution.generation_id = $1
                         AND contribution.source_kind = 'event'
                         AND contribution.source_scope_id = $2
                         AND contribution.target_scope_id = $3
                         AND contribution.metric_key = $4
                         AND contribution.metric_version = $5
                         AND contribution.source_storage_id IN (
                           SELECT storage_id FROM analytics.analytics_event
                           WHERE reporting_scope_id = $2
                             AND occurred_at >= $6 AND occurred_at < $7
                             AND event_type = ANY($8)
                         )"#,
                    )
                    .bind(generation_id)
                    .bind(work.reporting_scope_id)
                    .bind(target_scope_id)
                    .bind(&metric.key)
                    .bind(metric.version as i32)
                    .bind(work.source_window_start)
                    .bind(work.source_window_end)
                    .bind(&metric.sources)
                    .fetch_one(&mut **transaction)
                    .await?
                }
                FactKind::Observation => {
                    sqlx::query_scalar(
                        r#"SELECT COUNT(DISTINCT contribution.source_storage_id)
                       FROM analytics.analytics_projection_contribution contribution
                       WHERE contribution.generation_id = $1
                         AND contribution.source_kind = 'observation'
                         AND contribution.source_scope_id = $2
                         AND contribution.target_scope_id = $3
                         AND contribution.metric_key = $4
                         AND contribution.metric_version = $5
                         AND contribution.source_storage_id IN (
                           SELECT storage_id FROM analytics.analytics_metric_observation
                           WHERE reporting_scope_id = $2
                             AND reporting_window_start >= $6 AND reporting_window_start < $7
                             AND metric_key = $4
                         )"#,
                    )
                    .bind(generation_id)
                    .bind(work.reporting_scope_id)
                    .bind(target_scope_id)
                    .bind(&metric.key)
                    .bind(metric.version as i32)
                    .bind(work.source_window_start)
                    .bind(work.source_window_end)
                    .fetch_one(&mut **transaction)
                    .await?
                }
            };
            if actual != expected {
                return Err(sqlx::Error::Protocol(
                    format!(
                        "projection parity failed metric={} target_scope={} expected={} actual={} builder={}",
                        metric.key, target_scope_id, expected, actual, builder.name()
                    ),
                ));
            }
            expected_source_facts += expected;
            contribution_rows += actual;
            metrics_checked += 1;
        }
    }
    Ok(serde_json::json!({
        "status": "passed",
        "builder_count": 5,
        "metrics_checked": metrics_checked,
        "expected_source_facts": expected_source_facts,
        "contribution_rows": contribution_rows,
        "scope_id": work.reporting_scope_id,
        "work_id": work.work_id,
    }))
}

async fn finish_generation(
    transaction: &mut Transaction<'_, Postgres>,
    selection: GenerationSelection,
    work: &ClaimedWork,
    registry: &RegistrySnapshot,
) -> Result<(), sqlx::Error> {
    let generation_id = selection.generation_id;
    let generation_status: String = sqlx::query_scalar(
        "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id = $1 FOR UPDATE",
    )
    .bind(generation_id)
    .fetch_one(&mut **transaction)
    .await?;

    if generation_status == "building" || generation_status == "validated" {
        let validation_summary =
            validate_projection_window(transaction, registry, generation_id, work).await?;
        sqlx::query(
            r#"UPDATE analytics.analytics_projection_generation
               SET generation_status = 'validated',
                   source_high_watermark = GREATEST(COALESCE(source_high_watermark, 0), $2),
                   metric_registry_sha256 = $3,
                   validation_summary = $4,
                   validated_at = NOW()
               WHERE generation_id = $1"#,
        )
        .bind(generation_id)
        .bind(work.max_source_storage_id)
        .bind(&registry.sha256)
        .bind(validation_summary)
        .execute(&mut **transaction)
        .await?;

        sqlx::query(
            r#"UPDATE analytics.analytics_projection_generation
               SET generation_status = 'superseded'
               WHERE projection_name = $1 AND projection_version = $2
                 AND reporting_scope_id = $3 AND shard_key = $4
                 AND generation_status = 'promoted' AND generation_id <> $5"#,
        )
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(work.reporting_scope_id)
        .bind(DEFAULT_SHARD_KEY)
        .bind(generation_id)
        .execute(&mut **transaction)
        .await?;

        sqlx::query(
            r#"UPDATE analytics.analytics_projection_generation
               SET generation_status = 'promoted', promoted_at = NOW()
               WHERE generation_id = $1"#,
        )
        .bind(generation_id)
        .execute(&mut **transaction)
        .await?;
    }

    sqlx::query(
        r#"UPDATE analytics.analytics_projection_checkpoint
           SET generation_id = $1,
               rebuild_generation_id = NULL,
               last_processed_storage_id = GREATEST(last_processed_storage_id, $2),
               last_processed_work_id = GREATEST(last_processed_work_id, $3),
               processing_status = 'idle',
               lease_owner = NULL,
               lease_expires_at = NULL,
               rebuild_requested_at = NULL
           WHERE projection_name = $4 AND projection_version = $5
             AND reporting_scope_id = $6 AND shard_key = $7"#,
    )
    .bind(generation_id)
    .bind(work.max_source_storage_id)
    .bind(work.work_id)
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(work.reporting_scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

async fn mark_failed(
    pool: &PgPool,
    work: &ClaimedWork,
    worker_id: &str,
    message: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE analytics.analytics_projection_work
           SET work_status = 'failed',
               lease_owner = NULL,
               lease_expires_at = NULL,
               available_at = NOW() + make_interval(
                 secs => LEAST(300.0, power(2.0, LEAST(attempt_count, 8)::DOUBLE PRECISION))
               ),
               last_error_code = 'projection_failed',
               last_error_message = LEFT($3, 2000),
               completed_at = NULL
           WHERE work_id = $1 AND work_status = 'leased' AND lease_owner = $2"#,
    )
    .bind(work.work_id)
    .bind(worker_id)
    .bind(message)
    .execute(pool)
    .await?;
    Ok(())
}

fn typed_event_dimensions(
    builder: DomainBuilder,
    metric: &MetricDefinition,
    attributes: &Value,
    subject_type: &str,
    subject_id: &str,
) -> Result<Value, sqlx::Error> {
    match builder {
        DomainBuilder::Agents => {
            required_text(attributes, "installation_id")?;
            required_text(attributes, "status")?;
        }
        DomainBuilder::Campaigns => {
            required_text(attributes, "campaign_id")?;
            required_text(attributes, "recipient_id")?;
            required_text(attributes, "channel")?;
            required_text(attributes, "status")?;
            if metric.key == "campaign.delivery_delay_ms" {
                require_text_fields(attributes, &["timing_kind"])?;
                required_number(attributes, "duration_ms")?;
            }
            if metric.key == "campaign.recipients.pricing_recorded" {
                require_text_fields(attributes, &["pricing_category"])?;
                if !attributes.get("billable").is_some_and(Value::is_boolean) {
                    return Err(sqlx::Error::Protocol(
                        "typed projection builder missing billable".to_string(),
                    ));
                }
            }
        }
        DomainBuilder::Inbox => {
            required_text(attributes, "conversation_id")?;
            required_text(attributes, "channel")?;
            if metric.key == "conversation.lifecycle_events" {
                required_text(attributes, "actor_type")?;
            } else {
                required_text(attributes, "responder_type")?;
            }
        }
        DomainBuilder::Connections => {
            required_text(attributes, "connection_id")?;
            required_text(attributes, "provider")?;
            match metric.key.as_str() {
                "connection.lifecycle_events" => {
                    require_text_fields(
                        attributes,
                        &[
                            "action",
                            "status",
                            "credential_status",
                            "health_status",
                            "webhook_status",
                        ],
                    )?;
                }
                "connection.health_checks" => {
                    require_text_fields(
                        attributes,
                        &[
                            "status",
                            "health_status",
                            "credential_status",
                            "webhook_status",
                            "check_result",
                        ],
                    )?;
                }
                "connection.capability_events" => {
                    require_text_fields(attributes, &["capability", "action"])?;
                    required_bool(attributes, "enabled")?;
                }
                "connection.sync_attempts" => {
                    require_text_fields(
                        attributes,
                        &["attempt_id", "operation", "outcome", "failure_class"],
                    )?;
                    required_number(attributes, "duration_ms")?;
                }
                "connection.rate_limit_encounters" => {
                    require_text_fields(attributes, &["operation", "rate_limit_scope"])?;
                }
                "connection.incidents" => {
                    require_text_fields(
                        attributes,
                        &["incident_key", "action", "severity", "reason_code"],
                    )?;
                }
                metric => {
                    return Err(sqlx::Error::Protocol(format!(
                        "unsupported Connections metric {metric}"
                    )));
                }
            }
        }
        DomainBuilder::Tenants => {
            require_text_fields(attributes, &["tenant_client_id", "action", "status"])?;
            match metric.key.as_str() {
                "tenant.leads.lifecycle_events" => {
                    require_text_fields(attributes, &["lead_id", "source", "score_band"])?;
                    if attributes.get("action").and_then(Value::as_str) == Some("status_changed") {
                        require_text_fields(
                            attributes,
                            &["previous_status", "reason_code", "actor_type"],
                        )?;
                    }
                }
                "tenant.clients.lifecycle_events" => {}
                "tenant.client.assignment_events" => {
                    require_text_fields(attributes, &["tenant_user_id", "assignment_role"])?;
                }
                _ => {
                    return Err(sqlx::Error::Protocol(format!(
                        "unsupported Tenant metric {}",
                        metric.key
                    )))
                }
            }
        }
    }
    Ok(event_dimensions(
        metric,
        attributes,
        subject_type,
        subject_id,
    ))
}

fn required_text(attributes: &Value, key: &str) -> Result<String, sqlx::Error> {
    attributes
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| sqlx::Error::Protocol(format!("typed projection builder missing {key}")))
}

fn require_text_fields(attributes: &Value, keys: &[&str]) -> Result<(), sqlx::Error> {
    for key in keys {
        required_text(attributes, key)?;
    }
    Ok(())
}

fn required_bool(attributes: &Value, key: &str) -> Result<bool, sqlx::Error> {
    attributes
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| sqlx::Error::Protocol(format!("typed projection builder missing {key}")))
}

fn required_number(attributes: &Value, key: &str) -> Result<f64, sqlx::Error> {
    attributes
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| sqlx::Error::Protocol(format!("typed projection builder missing {key}")))
}

fn event_metric_value(metric: &MetricDefinition, attributes: &Value) -> Option<f64> {
    if metric.default_aggregation != "weighted_average" {
        return Some(1.0);
    }
    let field = metric
        .formula
        .split_once(',')
        .and_then(|(_, value)| value.strip_suffix(')'))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    attributes
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn deduplication_key(metric: &MetricDefinition, attributes: &Value) -> Option<String> {
    let key = match metric.deduplication.as_str() {
        "recipient" => "recipient_id",
        "conversation" => "conversation_id",
        "source_entity" => {
            if attributes.get("source_entity_id").is_some() {
                "source_entity_id"
            } else {
                "connection_id"
            }
        }
        _ => return None,
    };
    attributes
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn ratio_component(
    metric: &MetricDefinition,
    event_type: &str,
    registry: &RegistrySnapshot,
) -> (Option<f64>, Option<f64>) {
    if metric.default_aggregation != "ratio_of_sums" {
        return (None, None);
    }
    let numerator = metric.numerator.as_deref().and_then(|identity| {
        registry
            .metrics
            .iter()
            .find(|candidate| format!("{}@{}", candidate.key, candidate.version) == identity)
            .filter(|candidate| candidate.sources.iter().any(|source| source == event_type))
            .map(|_| 1.0)
    });
    let denominator = metric.denominator.as_deref().and_then(|identity| {
        registry
            .metrics
            .iter()
            .find(|candidate| format!("{}@{}", candidate.key, candidate.version) == identity)
            .filter(|candidate| candidate.sources.iter().any(|source| source == event_type))
            .map(|_| 1.0)
    });
    (numerator, denominator)
}

fn typed_coverage(metric: &MetricDefinition, builder: DomainBuilder, fact_kind: FactKind) -> Value {
    serde_json::json!({
        "builder": builder.name(),
        "source_kind": fact_kind.as_str(),
        "coverage_state": "observed",
        "required_sources": metric.coverage.required_sources,
        "exactness": metric.exactness,
    })
}

fn event_dimensions(
    metric: &MetricDefinition,
    attributes: &Value,
    subject_type: &str,
    subject_id: &str,
) -> Value {
    let mut dimensions = Map::new();
    for key in &metric.dimensions {
        let value = match key.as_str() {
            "agent_definition" => attributes.get("agent_definition_id").cloned().or_else(|| {
                (subject_type == "agent_definition").then(|| Value::String(subject_id.to_string()))
            }),
            "agent_version" => attributes.get("agent_version_id").cloned(),
            "agent_installation" => attributes.get("installation_id").cloned(),
            "agent_audience" => attributes.get("agent_audience").cloned(),
            "campaign" => attributes.get("campaign_id").cloned(),
            "channel" | "conversation_channel" => attributes.get("channel").cloned(),
            "provider" => attributes.get("provider").cloned(),
            "responder_type" => attributes.get("responder_type").cloned(),
            "outcome" => attributes.get("outcome").cloned(),
            "failure_class" => attributes.get("failure_class").cloned(),
            "suppression_class" => attributes.get("suppression_class").cloned(),
            "unsubscribe_source" => attributes.get("unsubscribe_source").cloned(),
            "timing_kind" => attributes.get("timing_kind").cloned(),
            "pricing_billable" => {
                attributes
                    .get("billable")
                    .and_then(Value::as_bool)
                    .map(|value| {
                        Value::String(if value { "billable" } else { "non_billable" }.to_string())
                    })
            }
            "pricing_category" => attributes.get("pricing_category").cloned(),
            "pricing_model" => attributes.get("pricing_model").cloned(),
            "pricing_type" => attributes.get("pricing_type").cloned(),
            "status" => attributes.get("status").cloned(),
            "lifecycle_action" => attributes.get("action").cloned(),
            "message_action" => attributes.get("action").cloned(),
            "message_direction" => attributes.get("direction").cloned(),
            "message_type" => attributes.get("message_type").cloned(),
            "message_delivery_status" => attributes.get("delivery_status").cloned(),
            "connection_health_status" => attributes.get("health_status").cloned(),
            "connection_credential_status" => attributes.get("credential_status").cloned(),
            "connection_webhook_status" => attributes.get("webhook_status").cloned(),
            "capability" => attributes.get("capability").cloned(),
            "connection_sync_operation" => attributes.get("operation").cloned(),
            "rate_limit_scope" => attributes.get("rate_limit_scope").cloned(),
            "incident_severity" => attributes.get("severity").cloned(),
            "incident_reason_code" => attributes.get("reason_code").cloned(),
            "tenant_client" => attributes.get("tenant_client_id").cloned(),
            "client_lifecycle_action" => attributes.get("action").cloned(),
            "assignment_action" => attributes.get("action").cloned(),
            "assignment_role" => attributes.get("assignment_role").cloned(),
            "lead_action" => attributes.get("action").cloned(),
            "lead_status" => attributes.get("status").cloned(),
            "lead_source" => attributes.get("source").cloned(),
            "lead_score_band" => attributes.get("score_band").cloned(),
            "lead_reason_code" => attributes.get("reason_code").cloned(),
            "lead_actor_type" => attributes.get("actor_type").cloned(),
            "handoff_channel" => attributes.get("channel_type").cloned(),
            "handoff_conversation_state" => attributes.get("conversation_state").cloned(),
            "handoff_reason" => attributes.get("reason").cloned(),
            "handoff_priority" => attributes.get("priority").cloned(),
            "handoff_actor_type" => attributes.get("actor_type").cloned(),
            "handoff_resolution_code" => attributes.get("resolution_code").cloned(),
            _ => None,
        };
        if let Some(value) = value.filter(is_safe_dimension_value) {
            dimensions.insert(key.clone(), value);
        }
    }
    Value::Object(dimensions)
}

fn observation_dimensions(metric: &MetricDefinition, dimensions: &Value) -> Value {
    let mut filtered = Map::new();
    for key in &metric.dimensions {
        if let Some(value) = dimensions
            .get(key)
            .filter(|value| is_safe_dimension_value(value))
        {
            filtered.insert(key.clone(), value.clone());
        }
    }
    Value::Object(filtered)
}

fn is_safe_dimension_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

fn utc_hour(timestamp: DateTime<Utc>) -> DateTime<Utc> {
    let seconds = timestamp.timestamp();
    Utc.timestamp_opt(seconds - seconds.rem_euclid(3_600), 0)
        .single()
        .expect("UTC hour is always representable")
}

pub fn hourly_window(timestamp: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = utc_hour(timestamp);
    (start, start + ChronoDuration::hours(1))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{event_dimensions, event_metric_value, typed_event_dimensions, DomainBuilder};
    use crate::registry::load_registry;

    #[test]
    fn inbox_projection_preserves_message_dimensions() {
        let registry = load_registry().expect("analytics registry");
        let metric = registry
            .metrics
            .iter()
            .find(|metric| metric.key == "conversation.message.lifecycle_events")
            .expect("Inbox message metric");
        let dimensions = event_dimensions(
            metric,
            &json!({
                "conversation_id": "conversation-1",
                "channel": "facebook",
                "action": "delivery_updated",
                "direction": "outbound",
                "responder_type": "agent",
                "message_type": "text",
                "delivery_status": "delivered"
            }),
            "message",
            "message-1",
        );

        assert_eq!(dimensions["conversation_channel"], "facebook");
        assert_eq!(dimensions["message_action"], "delivery_updated");
        assert_eq!(dimensions["message_direction"], "outbound");
        assert_eq!(dimensions["responder_type"], "agent");
        assert_eq!(dimensions["message_type"], "text");
        assert_eq!(dimensions["message_delivery_status"], "delivered");
    }

    #[test]
    fn inbox_conversation_lifecycle_uses_actor_type_validation() {
        let registry = load_registry().expect("analytics registry");
        let metric = registry
            .metrics
            .iter()
            .find(|metric| metric.key == "conversation.lifecycle_events")
            .expect("Inbox conversation metric");

        typed_event_dimensions(
            DomainBuilder::Inbox,
            metric,
            &json!({
                "conversation_id": "conversation-1",
                "channel": "facebook",
                "action": "opened",
                "status": "active",
                "actor_type": "customer"
            }),
            "conversation",
            "conversation-1",
        )
        .expect("conversation lifecycle should validate without responder_type");
    }

    #[test]
    fn weighted_event_metrics_read_the_numeric_formula_field() {
        let registry = load_registry().expect("analytics registry");
        let metric = registry
            .metrics
            .iter()
            .find(|metric| metric.key == "campaign.delivery_delay_ms")
            .expect("Campaign timing metric");
        assert_eq!(
            event_metric_value(metric, &json!({"duration_ms": 4200})),
            Some(4200.0)
        );
        assert_eq!(
            event_metric_value(metric, &json!({"duration_ms": null})),
            None
        );
    }
}

#[allow(dead_code)]
fn dimensions_map(value: &Value) -> BTreeMap<String, Value> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}
