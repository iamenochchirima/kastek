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
}

#[derive(Clone, Debug)]
struct ProjectionFact {
    fact_kind: FactKind,
    source_storage_id: i64,
    metric: MetricIdentity,
    reporting_scope_id: i64,
    source_scope_id: i64,
    root_scope_id: i64,
    bucket_start: DateTime<Utc>,
    bucket_end: DateTime<Utc>,
    dimensions: Value,
    value: f64,
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
               generation_id = COALESCE(generation_id, $3),
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

    if remaining == 0 {
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
                     WHEN $3 THEN 'rebuilding'
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
    let selection = work
        .generation_id
        .map(|generation_id| GenerationSelection {
            generation_id,
            shadow: true,
        })
        .or_else(|| {
            rebuild_generation.map(|generation_id| GenerationSelection {
                generation_id,
                shadow: true,
            })
        })
        .or_else(|| {
            checkpoint_generation.map(|generation_id| GenerationSelection {
                generation_id,
                shadow: false,
            })
        });
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
                       processing_status = CASE WHEN $2 THEN 'rebuilding' ELSE 'running' END
                   WHERE projection_name = $3 AND projection_version = $4
                     AND reporting_scope_id = $5 AND shard_key = $6"#,
            )
            .bind(generation_id)
            .bind(selection.shadow)
            .bind(PROJECTION_NAME)
            .bind(PROJECTION_VERSION)
            .bind(work.reporting_scope_id)
            .bind(DEFAULT_SHARD_KEY)
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
           WHERE generation_id = $1 AND target_scope_id = $2
             AND bucket_start >= $3 AND bucket_start < $4"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"DELETE FROM analytics.analytics_projection_rollup
           WHERE generation_id = $1 AND target_scope_id = $2
             AND bucket_start >= $3 AND bucket_start < $4"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .execute(&mut **transaction)
    .await?;

    let mut facts = Vec::new();
    let event_rows = sqlx::query(
        r#"SELECT storage_id, event_type, reporting_scope_id, root_scope_id,
                  subject_type, subject_id, occurred_at, attributes
           FROM analytics.analytics_event
           WHERE reporting_scope_id = $1
             AND occurred_at >= $2 AND occurred_at < $3
           ORDER BY storage_id"#,
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
        let occurred_at: DateTime<Utc> = row.try_get("occurred_at")?;
        for metric in registry
            .metrics
            .iter()
            .filter(|metric| metric.sources.iter().any(|source| source == &event_type))
        {
            facts.push(ProjectionFact {
                fact_kind: FactKind::Event,
                source_storage_id: row.try_get("storage_id")?,
                metric: MetricIdentity::from_definition(metric),
                reporting_scope_id: work.reporting_scope_id,
                source_scope_id: work.reporting_scope_id,
                root_scope_id: row.try_get("root_scope_id")?,
                bucket_start: utc_hour(occurred_at),
                bucket_end: utc_hour(occurred_at) + ChronoDuration::hours(1),
                dimensions: event_dimensions(metric, &attributes, &subject_type, &subject_id),
                value: 1.0,
            });
        }
    }

    let observation_rows = sqlx::query(
        r#"SELECT storage_id, metric_key, numeric_value::DOUBLE PRECISION AS numeric_value,
                  reporting_scope_id, root_scope_id,
                  reporting_window_start, reporting_window_end, dimensions
           FROM analytics.analytics_metric_observation
           WHERE reporting_scope_id = $1
             AND reporting_window_start >= $2 AND reporting_window_start < $3
           ORDER BY storage_id"#,
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
        let dimensions: Value = row.try_get("dimensions")?;
        let bucket_start: DateTime<Utc> = row.try_get("reporting_window_start")?;
        let bucket_end: DateTime<Utc> = row.try_get("reporting_window_end")?;
        let value: f64 = row.try_get("numeric_value")?;
        facts.push(ProjectionFact {
            fact_kind: FactKind::Observation,
            source_storage_id: row.try_get("storage_id")?,
            metric: MetricIdentity::from_definition(metric),
            reporting_scope_id: work.reporting_scope_id,
            source_scope_id: work.reporting_scope_id,
            root_scope_id: row.try_get("root_scope_id")?,
            bucket_start,
            bucket_end,
            dimensions: observation_dimensions(metric, &dimensions),
            value,
        });
    }

    for fact in facts {
        sqlx::query(
            r#"INSERT INTO analytics.analytics_projection_contribution (
                 generation_id, projection_name, projection_version, metric_key, metric_version,
                 source_kind, source_storage_id, target_scope_id, source_scope_id, root_scope_id,
                 bucket_start, bucket_end, dimensions, value_count, value_sum, value_min, value_max,
                 source_high_watermark, coverage
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$14,$14,$7,$15)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(&fact.metric.key)
        .bind(fact.metric.version)
        .bind(fact.fact_kind.as_str())
        .bind(fact.source_storage_id)
        .bind(fact.reporting_scope_id)
        .bind(fact.source_scope_id)
        .bind(fact.root_scope_id)
        .bind(fact.bucket_start)
        .bind(fact.bucket_end)
        .bind(fact.dimensions)
        .bind(fact.value)
        .bind(serde_json::json!({"source_kind": fact.fact_kind.as_str()}))
        .execute(&mut **transaction)
        .await?;
    }

    sqlx::query(
        r#"INSERT INTO analytics.analytics_projection_rollup (
             generation_id, projection_name, projection_version, metric_key, metric_version,
             target_scope_id, source_scope_id, root_scope_id, interval, bucket_start, bucket_end,
             dimensions, value_count, value_sum, value_min, value_max, source_high_watermark, coverage
           )
           SELECT generation_id, projection_name, projection_version, metric_key, metric_version,
                  target_scope_id, source_scope_id, root_scope_id, 'hour', bucket_start, bucket_end,
                  dimensions, SUM(value_count), SUM(value_sum), MIN(value_min), MAX(value_max),
                  MAX(source_high_watermark), jsonb_build_object('source_fact_count', COUNT(*))
           FROM analytics.analytics_projection_contribution
           WHERE generation_id = $1 AND target_scope_id = $2
             AND bucket_start >= $3 AND bucket_start < $4
           GROUP BY generation_id, projection_name, projection_version, metric_key, metric_version,
                    target_scope_id, source_scope_id, root_scope_id, bucket_start, bucket_end, dimensions
           ON CONFLICT (
             generation_id, metric_key, metric_version, target_scope_id, source_scope_id,
             interval, bucket_start, bucket_end, dimensions
           ) DO UPDATE SET
             value_count = EXCLUDED.value_count,
             value_sum = EXCLUDED.value_sum,
             value_min = EXCLUDED.value_min,
             value_max = EXCLUDED.value_max,
             source_high_watermark = EXCLUDED.source_high_watermark,
             coverage = EXCLUDED.coverage"#,
    )
    .bind(generation_id)
    .bind(work.reporting_scope_id)
    .bind(work.source_window_start)
    .bind(work.source_window_end)
    .execute(&mut **transaction)
    .await?;

    Ok(())
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
        sqlx::query(
            r#"UPDATE analytics.analytics_projection_generation
               SET generation_status = 'validated',
                   source_high_watermark = GREATEST(COALESCE(source_high_watermark, 0), $2),
                   metric_registry_sha256 = $3,
                   validation_summary = jsonb_build_object('status', 'passed', 'work_id', $4),
                   validated_at = NOW()
               WHERE generation_id = $1"#,
        )
        .bind(generation_id)
        .bind(work.max_source_storage_id)
        .bind(&registry.sha256)
        .bind(work.work_id)
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

fn event_dimensions(
    metric: &MetricDefinition,
    attributes: &Value,
    subject_type: &str,
    subject_id: &str,
) -> Value {
    let mut dimensions = Map::new();
    for key in &metric.dimensions {
        let value = match key.as_str() {
            "agent_definition" if subject_type == "agent_definition" => {
                Some(Value::String(subject_id.to_string()))
            }
            "agent_version" => attributes.get("agent_version_id").cloned(),
            "agent_installation" => attributes.get("installation_id").cloned(),
            "campaign" => attributes.get("campaign_id").cloned(),
            "channel" | "conversation_channel" => attributes.get("channel").cloned(),
            "provider" => attributes.get("provider").cloned(),
            "responder_type" => attributes.get("responder_type").cloned(),
            "outcome" => attributes.get("outcome").cloned(),
            "failure_class" => attributes.get("failure_class").cloned(),
            "status" => attributes.get("status").cloned(),
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
