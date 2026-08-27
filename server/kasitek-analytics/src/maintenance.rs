//! Durable orchestration for source reconciliation, quarantine repair, and backfill jobs.
//!
//! The worker owns scheduling and internal backfill execution. Source services claim the work
//! that only they can perform, then return summaries or corrected records through the existing
//! authenticated APIs. This boundary deliberately carries identifiers and safe metadata only;
//! rejected source payloads never enter the maintenance queues.

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::{
    ingestion::{AuthenticatedProducer, IngestionAuthenticator},
    projections,
    registry::RegistrySnapshot,
};

pub const RECONCILIATION_WORK_PATH: &str = "/internal/reconciliation/v1/work";
pub const QUARANTINE_WORK_PATH: &str = "/internal/quarantine/v1/work";
pub const BACKFILL_WORK_PATH: &str = "/internal/backfill/v1/work";

const SOURCE_LEASE_SECONDS: i64 = 300;
const RETRY_DELAY_SECONDS: i64 = 30;

#[derive(Clone, Debug, Serialize)]
pub struct ReconciliationWork {
    pub work_id: i64,
    pub producer_id: String,
    pub source_service: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub reporting_scope_id: Option<i64>,
    pub root_scope_id: Option<i64>,
    pub reason: String,
    pub priority: i16,
    pub attempt_count: i32,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct QuarantineReleaseWork {
    pub work_id: i64,
    pub failure_id: i64,
    pub producer_id: String,
    pub source_service: String,
    pub source_domain: String,
    pub source_stream_key: String,
    pub source_sequence: Option<i64>,
    pub record_category: String,
    pub record_identity: String,
    pub schema_version: Option<i32>,
    pub payload_hash: Option<String>,
    pub reporting_scope_id: Option<i64>,
    pub root_scope_id: Option<i64>,
    pub safe_error_code: String,
    pub attempt_count: i32,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackfillWork {
    pub job_id: String,
    pub source_service: String,
    pub source_domain: String,
    pub reporting_scope_id: i64,
    pub root_scope_id: i64,
    pub scope_external_id: String,
    pub requested_range_start: DateTime<Utc>,
    pub requested_range_end: DateTime<Utc>,
    pub contract_version: String,
    pub projection_version: Option<String>,
    pub method: String,
    pub job_status: String,
    pub checkpoint: Value,
    pub remaining_count: Option<i64>,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SchedulingSummary {
    pub reconciliation_work_created: u64,
    pub quarantine_work_created: u64,
}

pub async fn reconciliation_work_handler(
    request: HttpRequest,
    pool: web::Data<PgPool>,
    authenticator: web::Data<IngestionAuthenticator>,
) -> impl Responder {
    let authenticated = match authenticate(&request, &authenticator) {
        Ok(authenticated) => authenticated,
        Err(response) => return response,
    };
    match claim_reconciliation_work(pool.get_ref(), &authenticated, SOURCE_LEASE_SECONDS).await {
        Ok(Some(work)) => HttpResponse::Ok().json(work),
        Ok(None) => HttpResponse::NoContent().finish(),
        Err(_) => service_unavailable(),
    }
}

pub async fn quarantine_work_handler(
    request: HttpRequest,
    pool: web::Data<PgPool>,
    authenticator: web::Data<IngestionAuthenticator>,
) -> impl Responder {
    let authenticated = match authenticate(&request, &authenticator) {
        Ok(authenticated) => authenticated,
        Err(response) => return response,
    };
    match claim_quarantine_release_work(pool.get_ref(), &authenticated, SOURCE_LEASE_SECONDS).await
    {
        Ok(Some(work)) => HttpResponse::Ok().json(work),
        Ok(None) => HttpResponse::NoContent().finish(),
        Err(_) => service_unavailable(),
    }
}

pub async fn backfill_work_handler(
    request: HttpRequest,
    pool: web::Data<PgPool>,
    authenticator: web::Data<IngestionAuthenticator>,
) -> impl Responder {
    let authenticated = match authenticate(&request, &authenticator) {
        Ok(authenticated) => authenticated,
        Err(response) => return response,
    };
    match claim_source_backfill_work(pool.get_ref(), &authenticated, SOURCE_LEASE_SECONDS).await {
        Ok(Some(work)) => HttpResponse::Ok().json(work),
        Ok(None) => HttpResponse::NoContent().finish(),
        Err(_) => service_unavailable(),
    }
}

fn authenticate(
    request: &HttpRequest,
    authenticator: &IngestionAuthenticator,
) -> Result<AuthenticatedProducer, HttpResponse> {
    authenticator.authenticate(request).map_err(|_| {
        HttpResponse::Unauthorized()
            .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
            .finish()
    })
}

fn service_unavailable() -> HttpResponse {
    HttpResponse::ServiceUnavailable().json(json!({
        "error": "analytics_unavailable"
    }))
}

pub async fn claim_reconciliation_work(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    lease_seconds: i64,
) -> Result<Option<ReconciliationWork>, sqlx::Error> {
    let row = sqlx::query(
        r#"WITH candidate AS (
             SELECT work_id
             FROM analytics.analytics_reconciliation_work
             WHERE producer_id = $1 AND source_service = $2
               AND (
                 (work_status = 'pending' AND available_at <= NOW())
                 OR (work_status = 'leased' AND lease_expires_at <= NOW())
               )
             ORDER BY priority ASC, available_at ASC, work_id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE analytics.analytics_reconciliation_work AS work
           SET work_status = 'leased',
               lease_owner = $3,
               lease_expires_at = NOW() + make_interval(secs => $4),
               attempt_count = work.attempt_count + 1,
               last_error_code = NULL,
               last_error_message = NULL
           FROM candidate
           WHERE work.work_id = candidate.work_id
           RETURNING work.work_id, work.producer_id, work.source_service, work.source_domain,
                     work.source_stream_key, work.reporting_scope_id, work.root_scope_id,
                     work.reason, work.priority, work.attempt_count, work.lease_expires_at"#,
    )
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .bind(&authenticated.producer_id)
    .bind(lease_seconds)
    .fetch_optional(pool)
    .await?;

    row.map(parse_reconciliation_work).transpose()
}

fn parse_reconciliation_work(
    row: sqlx::postgres::PgRow,
) -> Result<ReconciliationWork, sqlx::Error> {
    Ok(ReconciliationWork {
        work_id: row.try_get("work_id")?,
        producer_id: row.try_get("producer_id")?,
        source_service: row.try_get("source_service")?,
        source_domain: row.try_get("source_domain")?,
        source_stream_key: row.try_get("source_stream_key")?,
        reporting_scope_id: row.try_get("reporting_scope_id")?,
        root_scope_id: row.try_get("root_scope_id")?,
        reason: row.try_get("reason")?,
        priority: row.try_get("priority")?,
        attempt_count: row.try_get("attempt_count")?,
        lease_expires_at: row.try_get("lease_expires_at")?,
    })
}

pub async fn claim_quarantine_release_work(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    lease_seconds: i64,
) -> Result<Option<QuarantineReleaseWork>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let row = sqlx::query(
        r#"WITH candidate AS (
             SELECT work.work_id
             FROM analytics.analytics_quarantine_release_work AS work
             JOIN analytics.analytics_ingestion_failure AS failure
               ON failure.failure_id = work.failure_id
             WHERE work.producer_id = $1 AND work.source_service = $2
               AND failure.quarantine_status = 'quarantined'
               AND (
                 (work.work_status = 'pending' AND work.available_at <= NOW())
                 OR (work.work_status = 'leased' AND work.lease_expires_at <= NOW())
               )
             ORDER BY work.available_at ASC, work.work_id ASC
             LIMIT 1
             FOR UPDATE OF work SKIP LOCKED
           )
           UPDATE analytics.analytics_quarantine_release_work AS work
           SET work_status = 'leased',
               lease_owner = $3,
               lease_expires_at = NOW() + make_interval(secs => $4),
               attempt_count = work.attempt_count + 1,
               last_error_code = NULL,
               last_error_message = NULL
           FROM candidate
           WHERE work.work_id = candidate.work_id
           RETURNING work.work_id, work.failure_id, work.producer_id, work.source_service,
                     work.source_stream_key, work.attempt_count, work.lease_expires_at"#,
    )
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .bind(&authenticated.producer_id)
    .bind(lease_seconds)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        transaction.commit().await?;
        return Ok(None);
    };
    let failure = sqlx::query(
        r#"SELECT source_domain, source_sequence, record_category, record_identity,
                  schema_version, payload_hash, reporting_scope_id, root_scope_id,
                  safe_error_code
           FROM analytics.analytics_ingestion_failure
           WHERE failure_id = $1 AND producer_id = $2 AND source_service = $3
             AND quarantine_status = 'quarantined'"#,
    )
    .bind(row.get::<i64, _>("failure_id"))
    .bind(&authenticated.producer_id)
    .bind(&authenticated.source_service)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(failure) = failure else {
        transaction.commit().await?;
        return Ok(None);
    };
    let work = QuarantineReleaseWork {
        work_id: row.get("work_id"),
        failure_id: row.get("failure_id"),
        producer_id: row.get("producer_id"),
        source_service: row.get("source_service"),
        source_domain: failure.get("source_domain"),
        source_stream_key: row.get("source_stream_key"),
        source_sequence: failure.get("source_sequence"),
        record_category: failure.get("record_category"),
        record_identity: failure.get("record_identity"),
        schema_version: failure.get("schema_version"),
        payload_hash: failure.get("payload_hash"),
        reporting_scope_id: failure.get("reporting_scope_id"),
        root_scope_id: failure.get("root_scope_id"),
        safe_error_code: failure.get("safe_error_code"),
        attempt_count: row.get("attempt_count"),
        lease_expires_at: row.get("lease_expires_at"),
    };
    transaction.commit().await?;
    Ok(Some(work))
}

pub async fn claim_source_backfill_work(
    pool: &PgPool,
    authenticated: &AuthenticatedProducer,
    lease_seconds: i64,
) -> Result<Option<BackfillWork>, sqlx::Error> {
    let row = sqlx::query(
        r#"WITH candidate AS (
             SELECT job_id
             FROM analytics.analytics_backfill_job
             WHERE source_service = $1
               AND method IN ('source_reconstruction', 'provider_history_import')
               AND (
                 job_status = 'queued'
                 OR (job_status = 'running' AND lease_expires_at <= NOW())
               )
             ORDER BY updated_at ASC, job_id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE analytics.analytics_backfill_job AS job
           SET job_status = 'running',
               lease_owner = $2,
               lease_expires_at = NOW() + make_interval(secs => $3),
               attempt_count = job.attempt_count + 1,
               next_attempt_at = NOW(),
               safe_failure_code = NULL,
               last_error_message = NULL,
               started_at = COALESCE(job.started_at, NOW())
           FROM candidate
           WHERE job.job_id = candidate.job_id
           RETURNING job.job_id, job.source_service, job.source_domain, job.reporting_scope_id,
                     job.root_scope_id,
                     (SELECT external_source_id FROM analytics.reporting_scope
                      WHERE scope_id = job.reporting_scope_id) AS scope_external_id,
                     job.requested_range_start, job.requested_range_end,
                     job.contract_version, job.projection_version, job.method, job.job_status,
                     job.checkpoint, job.remaining_count, job.lease_expires_at"#,
    )
    .bind(&authenticated.source_service)
    .bind(&authenticated.producer_id)
    .bind(lease_seconds)
    .fetch_optional(pool)
    .await?;
    row.map(parse_backfill_work).transpose()
}

fn parse_backfill_work(row: sqlx::postgres::PgRow) -> Result<BackfillWork, sqlx::Error> {
    Ok(BackfillWork {
        job_id: row.try_get("job_id")?,
        source_service: row.try_get("source_service")?,
        source_domain: row.try_get("source_domain")?,
        reporting_scope_id: row.try_get("reporting_scope_id")?,
        root_scope_id: row.try_get("root_scope_id")?,
        scope_external_id: row.try_get("scope_external_id")?,
        requested_range_start: row.try_get("requested_range_start")?,
        requested_range_end: row.try_get("requested_range_end")?,
        contract_version: row.try_get("contract_version")?,
        projection_version: row.try_get("projection_version")?,
        method: row.try_get("method")?,
        job_status: row.try_get("job_status")?,
        checkpoint: row.try_get("checkpoint")?,
        remaining_count: row.try_get("remaining_count")?,
        lease_expires_at: row.try_get("lease_expires_at")?,
    })
}

pub async fn schedule_work(pool: &PgPool) -> Result<SchedulingSummary, sqlx::Error> {
    let reconciliation_work_created = sqlx::query(
        r#"WITH candidates AS (
             SELECT producer_id, source_service, source_domain, source_stream_key,
                    CASE WHEN highest_received_sequence > highest_contiguous_sequence
                         THEN 'sequence_gap' ELSE 'scheduled' END AS reason,
                    CASE WHEN highest_received_sequence > highest_contiguous_sequence
                         THEN 10 ELSE 100 END AS priority
             FROM analytics.analytics_source_cursor
             WHERE latest_reconciliation_at IS NULL
                OR latest_reconciliation_at < NOW() - INTERVAL '15 minutes'
                OR highest_received_sequence > highest_contiguous_sequence
           )
           INSERT INTO analytics.analytics_reconciliation_work (
             producer_id, source_service, source_domain, source_stream_key,
             schedule_key, reason, priority
           )
           SELECT producer_id, source_service, source_domain, source_stream_key,
                  concat('reconciliation:', producer_id, ':', source_stream_key, ':',
                         floor(extract(epoch FROM NOW()) / 900)::BIGINT, ':', reason),
                  reason, priority
           FROM candidates
           ON CONFLICT (schedule_key) DO NOTHING"#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    let quarantine_work_created = sqlx::query(
        r#"INSERT INTO analytics.analytics_quarantine_release_work (
             failure_id, producer_id, source_service, source_domain, source_stream_key,
             source_sequence, record_category, schema_version, record_identity, payload_hash
           )
           SELECT failure_id, producer_id, source_service, source_domain, source_stream_key,
                  source_sequence, record_category, schema_version, record_identity, payload_hash
           FROM analytics.analytics_ingestion_failure
           WHERE quarantine_status = 'quarantined'
           ON CONFLICT (failure_id) DO UPDATE
           SET work_status = CASE
                 WHEN analytics.analytics_quarantine_release_work.work_status IN ('failed', 'cancelled')
                   THEN 'pending'
                 ELSE analytics.analytics_quarantine_release_work.work_status
               END,
               available_at = CASE
                 WHEN analytics.analytics_quarantine_release_work.work_status IN ('failed', 'cancelled')
                   THEN NOW()
                 ELSE analytics.analytics_quarantine_release_work.available_at
               END,
               lease_owner = CASE
                 WHEN analytics.analytics_quarantine_release_work.work_status IN ('failed', 'cancelled')
                   THEN NULL
                 ELSE analytics.analytics_quarantine_release_work.lease_owner
               END,
               lease_expires_at = CASE
                 WHEN analytics.analytics_quarantine_release_work.work_status IN ('failed', 'cancelled')
                   THEN NULL
                 ELSE analytics.analytics_quarantine_release_work.lease_expires_at
               END"#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    Ok(SchedulingSummary {
        reconciliation_work_created,
        quarantine_work_created,
    })
}

pub async fn run_once(
    pool: &PgPool,
    registry: &RegistrySnapshot,
    worker_id: &str,
    lease_seconds: i64,
) -> Result<bool, sqlx::Error> {
    let summary = schedule_work(pool).await?;
    if summary.reconciliation_work_created > 0 || summary.quarantine_work_created > 0 {
        observability::tracing::debug!(
            event = "queue.item.completed",
            service = "kasitek-analytics",
            process = "analytics-worker",
            phase = "schedule",
            reconciliation_work_created = summary.reconciliation_work_created,
            quarantine_work_created = summary.quarantine_work_created,
            "analytics maintenance work scheduled"
        );
    }
    process_backfill_once(pool, registry, worker_id, lease_seconds).await
}

async fn process_backfill_once(
    pool: &PgPool,
    registry: &RegistrySnapshot,
    worker_id: &str,
    lease_seconds: i64,
) -> Result<bool, sqlx::Error> {
    let Some(work) = claim_worker_backfill_work(pool, worker_id, lease_seconds).await? else {
        return Ok(false);
    };

    let result = match work.method.as_str() {
        "projection_rebuild" => process_projection_rebuild(pool, registry, worker_id, &work).await,
        "fact_replay" => process_fact_replay(pool, &work).await,
        _ => Err(sqlx::Error::Protocol(
            "unsupported analytics backfill method".into(),
        )),
    };
    match result {
        Ok(BackfillProgress::Complete(checkpoint)) => {
            finish_backfill(pool, &work.job_id, checkpoint).await?;
        }
        Ok(BackfillProgress::Waiting(checkpoint)) => {
            defer_backfill(pool, &work.job_id, checkpoint).await?;
        }
        Err(error) => {
            fail_backfill(pool, &work.job_id, &error.to_string()).await?;
            return Err(error);
        }
    }
    Ok(true)
}

enum BackfillProgress {
    Complete(Value),
    Waiting(Value),
}

async fn process_projection_rebuild(
    pool: &PgPool,
    registry: &RegistrySnapshot,
    worker_id: &str,
    work: &BackfillWork,
) -> Result<BackfillProgress, sqlx::Error> {
    let generation_id =
        if let Some(generation_id) = work.checkpoint.get("generation_id").and_then(Value::as_i64) {
            generation_id
        } else {
            projections::request_rebuild(
                pool,
                work.reporting_scope_id,
                work.root_scope_id,
                worker_id,
                &registry.sha256,
            )
            .await?
        };
    let status: String = sqlx::query_scalar(
        "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id = $1",
    )
    .bind(generation_id)
    .fetch_one(pool)
    .await?;
    let checkpoint = json!({
        "generation_id": generation_id,
        "generation_status": status,
        "requested_range_start": work.requested_range_start,
        "requested_range_end": work.requested_range_end
    });
    match status.as_str() {
        "promoted" => Ok(BackfillProgress::Complete(checkpoint)),
        "failed" | "cancelled" => Err(sqlx::Error::Protocol(
            "projection rebuild generation did not complete".into(),
        )),
        _ => Ok(BackfillProgress::Waiting(checkpoint)),
    }
}

async fn process_fact_replay(
    pool: &PgPool,
    work: &BackfillWork,
) -> Result<BackfillProgress, sqlx::Error> {
    let enqueued = projections::enqueue_replay_range(
        pool,
        work.reporting_scope_id,
        work.root_scope_id,
        work.requested_range_start,
        work.requested_range_end,
    )
    .await?;
    Ok(BackfillProgress::Complete(json!({
        "enqueued_projection_work": enqueued,
        "requested_range_start": work.requested_range_start,
        "requested_range_end": work.requested_range_end
    })))
}

async fn claim_worker_backfill_work(
    pool: &PgPool,
    worker_id: &str,
    lease_seconds: i64,
) -> Result<Option<BackfillWork>, sqlx::Error> {
    let row = sqlx::query(
        r#"WITH candidate AS (
             SELECT job_id
             FROM analytics.analytics_backfill_job
             WHERE method IN ('projection_rebuild', 'fact_replay')
               AND (
                 (job_status IN ('queued', 'failed') AND next_attempt_at <= NOW())
                 OR (job_status = 'running' AND lease_expires_at <= NOW())
               )
             ORDER BY next_attempt_at ASC, updated_at ASC, job_id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE analytics.analytics_backfill_job AS job
           SET job_status = 'running',
               lease_owner = $1,
               lease_expires_at = NOW() + make_interval(secs => $2),
               attempt_count = job.attempt_count + 1,
               next_attempt_at = NOW(),
               safe_failure_code = NULL,
               last_error_message = NULL,
               started_at = COALESCE(job.started_at, NOW()),
               completed_at = NULL
           FROM candidate
           WHERE job.job_id = candidate.job_id
           RETURNING job.job_id, job.source_service, job.source_domain, job.reporting_scope_id,
                     job.root_scope_id,
                     (SELECT external_source_id FROM analytics.reporting_scope
                      WHERE scope_id = job.reporting_scope_id) AS scope_external_id,
                     job.requested_range_start, job.requested_range_end,
                     job.contract_version, job.projection_version, job.method, job.job_status,
                     job.checkpoint, job.remaining_count, job.lease_expires_at"#,
    )
    .bind(worker_id)
    .bind(lease_seconds)
    .fetch_optional(pool)
    .await?;
    row.map(parse_backfill_work).transpose()
}

async fn finish_backfill(
    pool: &PgPool,
    job_id: &str,
    checkpoint: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE analytics.analytics_backfill_job
           SET job_status = 'completed', checkpoint = $2, lease_owner = NULL,
               lease_expires_at = NULL, completed_at = NOW(), next_attempt_at = NOW(),
               safe_failure_code = NULL, last_error_message = NULL
           WHERE job_id = $1 AND job_status = 'running'"#,
    )
    .bind(job_id)
    .bind(checkpoint)
    .execute(pool)
    .await?;
    Ok(())
}

async fn defer_backfill(pool: &PgPool, job_id: &str, checkpoint: Value) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE analytics.analytics_backfill_job
           SET job_status = 'running', checkpoint = $2, lease_owner = NULL,
               lease_expires_at = NULL,
               next_attempt_at = NOW() + make_interval(secs => $3)
           WHERE job_id = $1 AND job_status = 'running'"#,
    )
    .bind(job_id)
    .bind(checkpoint)
    .bind(RETRY_DELAY_SECONDS)
    .execute(pool)
    .await?;
    Ok(())
}

async fn fail_backfill(pool: &PgPool, job_id: &str, message: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE analytics.analytics_backfill_job
           SET job_status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = NOW() + make_interval(secs => $3),
               safe_failure_code = 'backfill_worker_failed',
               last_error_message = LEFT($2, 2000), completed_at = NULL
           WHERE job_id = $1 AND job_status = 'running'"#,
    )
    .bind(job_id)
    .bind(message)
    .bind(RETRY_DELAY_SECONDS)
    .execute(pool)
    .await?;
    Ok(())
}
