use std::{env, fs};

use chrono::{TimeZone, Utc};
use kasitek_analytics::{projections, registry::load_registry};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

fn database_url() -> Option<String> {
    if let Ok(value) = env::var("ANALYTICS_DATABASE_URL") {
        return Some(value);
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/.env");
    fs::read_to_string(path).ok().and_then(|contents| {
        contents.lines().find_map(|line| {
            line.strip_prefix("ANALYTICS_DATABASE_URL=")
                .map(str::to_string)
        })
    })
}

async fn pool() -> Option<PgPool> {
    let url = database_url()?;
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .ok()
}

#[tokio::test]
async fn worker_claims_dirty_window_and_promotes_a_complete_generation() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let pending_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM analytics.analytics_projection_work WHERE work_status IN ('pending', 'failed')",
    )
    .fetch_one(&pool)
    .await
    .expect("pending work count");
    if pending_before == 0 {
        return;
    }

    let mut processed_count = 0;
    for _ in 0..10 {
        let processed = projections::process_once(&pool, &registry, "projection-test", 60)
            .await
            .expect("projection pass");
        if !processed {
            break;
        }
        processed_count += 1;
    }
    assert!(processed_count > 0);

    let row = sqlx::query(
        r#"SELECT
             (SELECT COUNT(*) FROM analytics.analytics_projection_generation
               WHERE projection_name = $1 AND generation_status = 'promoted') AS generations,
             (SELECT COUNT(*) FROM analytics.analytics_projection_contribution
               WHERE projection_name = $1) AS contributions,
             (SELECT COUNT(*) FROM analytics.analytics_projection_rollup
               WHERE projection_name = $1) AS rollups"#,
    )
    .bind(projections::PROJECTION_NAME)
    .fetch_one(&pool)
    .await
    .expect("projection rows");
    assert!(row.get::<i64, _>("generations") > 0);
    assert!(row.get::<i64, _>("contributions") > 0);
    assert!(row.get::<i64, _>("rollups") > 0);

    let scope = sqlx::query(
        r#"SELECT checkpoint.reporting_scope_id, checkpoint.root_scope_id, checkpoint.generation_id
           FROM analytics.analytics_projection_checkpoint AS checkpoint
           JOIN analytics.reporting_scope AS scope
             ON scope.scope_id = checkpoint.reporting_scope_id
           WHERE checkpoint.projection_name = $1
             AND scope.external_source_id LIKE 'a09-org-%'
           ORDER BY checkpoint_id DESC
           LIMIT 1"#,
    )
    .bind(projections::PROJECTION_NAME)
    .fetch_one(&pool)
    .await
    .expect("projection checkpoint");
    let old_generation: i64 = scope.get("generation_id");
    let rebuilt_generation = projections::request_rebuild(
        &pool,
        scope.get("reporting_scope_id"),
        scope.get("root_scope_id"),
        "projection-test",
        &registry.sha256,
    )
    .await
    .expect("rebuild request");
    assert_ne!(old_generation, rebuilt_generation);
    let checkpoint_during_rebuild = sqlx::query(
        r#"SELECT generation_id, rebuild_generation_id
           FROM analytics.analytics_projection_checkpoint
           WHERE projection_name = $1 AND reporting_scope_id = $2"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(scope.get::<i64, _>("reporting_scope_id"))
    .fetch_one(&pool)
    .await
    .expect("checkpoint during rebuild");
    assert_eq!(
        checkpoint_during_rebuild.get::<i64, _>("generation_id"),
        old_generation
    );
    assert_eq!(
        checkpoint_during_rebuild.get::<i64, _>("rebuild_generation_id"),
        rebuilt_generation
    );

    for _ in 0..10 {
        if !projections::process_once(&pool, &registry, "projection-test", 60)
            .await
            .expect("rebuild pass")
        {
            break;
        }
    }
    let generation_status: String = sqlx::query_scalar(
        "SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id = $1",
    )
    .bind(rebuilt_generation)
    .fetch_one(&pool)
    .await
    .expect("rebuilt generation status");
    assert_eq!(generation_status, "promoted");

    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let workspace_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone,
             source_version
           ) VALUES ('tenant_workspace','tenant-platform',$1,'active','Africa/Johannesburg',$2)
           RETURNING scope_id"#,
    )
    .bind(format!("a10-workspace-{suffix}"))
    .bind(1_788_020_091_680_i64)
    .fetch_one(&pool)
    .await
    .expect("workspace scope");
    let client_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, parent_scope_id,
             status, reporting_timezone
           ) VALUES ('tenant_client','tenant-platform',$1,$2,'active','Africa/Johannesburg')
           RETURNING scope_id"#,
    )
    .bind(format!("a10-client-{suffix}"))
    .bind(workspace_scope_id)
    .fetch_one(&pool)
    .await
    .expect("client scope");
    let event_time = Utc
        .with_ymd_and_hms(2026, 8, 22, 23, 30, 0)
        .single()
        .expect("event timestamp");
    let stream = format!("a10-agent-stream-{suffix}");
    let attributes = json!({
        "installation_id": format!("installation-{suffix}"),
        "agent_definition_id": "support-agent",
        "agent_version_id": "support-agent-v1",
        "status": "completed",
        "outcome": "success"
    });
    let storage_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_event (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
             subject_type, subject_id, occurred_at, origin, source_record_id, attributes, payload_hash
           ) VALUES ('agent-platform-customer-analytics','agent-platform','agents',$1,1,
                     $2,'agent.run.completed@1',1,$3,$4,'agent_definition','support-agent',$5,
                     'test://a10',$2,$6,repeat('a',64))
           RETURNING storage_id"#,
    )
    .bind(&stream)
    .bind(format!("a10-event-{suffix}"))
    .bind(client_scope_id)
    .bind(workspace_scope_id)
    .bind(event_time)
    .bind(attributes)
    .fetch_one(&pool)
    .await
    .expect("agent event");
    let window_start = Utc
        .with_ymd_and_hms(2026, 8, 22, 23, 0, 0)
        .single()
        .expect("window start");
    let window_end = window_start + chrono::Duration::hours(1);
    let work_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_work (
             projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
             source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
             priority, work_status
           ) VALUES ($1,$2,'event',$3,$4,$5,$6,$7,$7,1,'pending')
           RETURNING work_id"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(projections::PROJECTION_VERSION)
    .bind(client_scope_id)
    .bind(workspace_scope_id)
    .bind(window_start)
    .bind(window_end)
    .bind(storage_id)
    .fetch_one(&pool)
    .await
    .expect("projection work");

    let mut completed = false;
    for _ in 0..5 {
        let _ = projections::process_once(&pool, &registry, "a10-projection-test", 60)
            .await
            .expect("typed projection pass");
        let status: String = sqlx::query_scalar(
            "SELECT work_status FROM analytics.analytics_projection_work WHERE work_id = $1",
        )
        .bind(work_id)
        .fetch_one(&pool)
        .await
        .expect("typed work status");
        if status == "completed" {
            completed = true;
            break;
        }
    }
    assert!(completed, "typed projection work did not complete");
    let generation_id: i64 = sqlx::query_scalar(
        "SELECT generation_id FROM analytics.analytics_projection_work WHERE work_id = $1",
    )
    .bind(work_id)
    .fetch_one(&pool)
    .await
    .expect("typed generation");
    let contribution = sqlx::query(
        r#"SELECT COUNT(*) AS count, MIN(bucket_start) AS bucket_start,
                  COUNT(DISTINCT timezone_name) AS timezone_count,
                  MIN(timezone_name) AS timezone_name, MAX(timezone_revision) AS timezone_revision,
                  COUNT(DISTINCT builder_name) AS builder_count
           FROM analytics.analytics_projection_contribution
           WHERE generation_id = $1 AND source_storage_id = $2
             AND metric_key = 'agent.runs.completed'"#,
    )
    .bind(generation_id)
    .bind(storage_id)
    .fetch_one(&pool)
    .await
    .expect("typed contribution");
    assert_eq!(contribution.get::<i64, _>("count"), 2);
    assert_eq!(
        contribution.get::<chrono::DateTime<Utc>, _>("bucket_start"),
        Utc.with_ymd_and_hms(2026, 8, 22, 23, 0, 0)
            .single()
            .unwrap()
    );
    assert_eq!(contribution.get::<i64, _>("timezone_count"), 1);
    assert_eq!(
        contribution.get::<String, _>("timezone_name"),
        "Africa/Johannesburg"
    );
    assert_eq!(
        contribution.get::<i64, _>("timezone_revision"),
        1_788_020_091_680_i64
    );
    assert_eq!(contribution.get::<i64, _>("builder_count"), 1);

    let mut transaction = pool.begin().await.expect("projection transaction");
    projections::enqueue_fact(
        &mut transaction,
        projections::FactWindow {
            fact_kind: projections::FactKind::Event,
            reporting_scope_id: client_scope_id,
            root_scope_id: workspace_scope_id,
            source_storage_id: storage_id,
            source_window_start: window_start,
            source_window_end: window_end,
        },
    )
    .await
    .expect("existing projection work should be coalesced");
    transaction
        .commit()
        .await
        .expect("projection transaction should commit");
    let work_shape = sqlx::query(
        r#"SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE generation_id IS NULL) AS unassigned
           FROM analytics.analytics_projection_work
           WHERE projection_name = $1 AND projection_version = $2
             AND fact_kind = 'event' AND reporting_scope_id = $3
             AND source_window_start = $4 AND source_window_end = $5"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(projections::PROJECTION_VERSION)
    .bind(client_scope_id)
    .bind(window_start)
    .bind(window_end)
    .fetch_one(&pool)
    .await
    .expect("coalesced projection work");
    assert_eq!(work_shape.get::<i64, _>("total"), 1);
    assert_eq!(work_shape.get::<i64, _>("unassigned"), 0);
    for _ in 0..5 {
        let _ = projections::process_once(&pool, &registry, "a10-coalesce-test", 60)
            .await
            .expect("coalesced projection pass");
        let status: String = sqlx::query_scalar(
            r#"SELECT work_status FROM analytics.analytics_projection_work
               WHERE projection_name = $1 AND projection_version = $2
                 AND fact_kind = 'event' AND reporting_scope_id = $3
                 AND source_window_start = $4 AND source_window_end = $5
                 AND generation_id IS NOT NULL
               ORDER BY work_id DESC LIMIT 1"#,
        )
        .bind(projections::PROJECTION_NAME)
        .bind(projections::PROJECTION_VERSION)
        .bind(client_scope_id)
        .bind(window_start)
        .bind(window_end)
        .fetch_one(&pool)
        .await
        .expect("coalesced projection status");
        if status == "completed" {
            break;
        }
    }
    let coalesced_status: String = sqlx::query_scalar(
        r#"SELECT work_status FROM analytics.analytics_projection_work
           WHERE projection_name = $1 AND projection_version = $2
             AND fact_kind = 'event' AND reporting_scope_id = $3
             AND source_window_start = $4 AND source_window_end = $5
             AND generation_id IS NOT NULL
           ORDER BY work_id DESC LIMIT 1"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(projections::PROJECTION_VERSION)
    .bind(client_scope_id)
    .bind(window_start)
    .bind(window_end)
    .fetch_one(&pool)
    .await
    .expect("final coalesced projection status");
    assert_eq!(coalesced_status, "completed");
    let day_value: f64 = sqlx::query_scalar(
        r#"SELECT value_count::DOUBLE PRECISION
           FROM analytics.analytics_projection_rollup
           WHERE generation_id = $1 AND metric_key = 'agent.runs.completed'
             AND target_scope_id = $2 AND interval = 'day'"#,
    )
    .bind(generation_id)
    .bind(workspace_scope_id)
    .fetch_one(&pool)
    .await
    .expect("ancestor day rollup");
    assert_eq!(day_value, 1.0);

    let campaign_scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(format!("a10-campaign-scope-{suffix}"))
    .fetch_one(&pool)
    .await
    .expect("campaign scope");
    let campaign_stream = format!("a10-campaign-stream-{suffix}");
    let campaign_id = format!("campaign-{suffix}");
    let recipient_id = format!("recipient-{suffix}");
    let sent_storage_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_event (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
             subject_type, subject_id, occurred_at, origin, source_record_id, attributes, payload_hash
           ) VALUES ('core-customer-analytics','core','campaigns',$1,1,$2,
                     'campaign.recipient.sent@1',1,$3,$3,'campaign_recipient',$4,$5,
                     'test://a10',$2,$6,repeat('b',64))
           RETURNING storage_id"#,
    )
    .bind(&campaign_stream)
    .bind(format!("a10-sent-{suffix}"))
    .bind(campaign_scope_id)
    .bind(&recipient_id)
    .bind(event_time)
    .bind(json!({
        "campaign_id": campaign_id,
        "recipient_id": recipient_id,
        "channel": "whatsapp",
        "status": "sent"
    }))
    .fetch_one(&pool)
    .await
    .expect("campaign sent event");
    let delivered_storage_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_event (
             producer_id, source_service, source_domain, source_stream_key, source_sequence,
             event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
             subject_type, subject_id, occurred_at, origin, source_record_id, attributes, payload_hash
           ) VALUES ('core-customer-analytics','core','campaigns',$1,2,$2,
                     'campaign.recipient.delivered@1',1,$3,$3,'campaign_recipient',$4,$5,
                     'test://a10',$2,$6,repeat('c',64))
           RETURNING storage_id"#,
    )
    .bind(&campaign_stream)
    .bind(format!("a10-delivered-{suffix}"))
    .bind(campaign_scope_id)
    .bind(&recipient_id)
    .bind(event_time + chrono::Duration::minutes(5))
    .bind(json!({
        "campaign_id": campaign_id,
        "recipient_id": recipient_id,
        "channel": "whatsapp",
        "status": "delivered"
    }))
    .fetch_one(&pool)
    .await
    .expect("campaign delivered event");
    let campaign_work_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_work (
             projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
             source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
             priority, work_status
           ) VALUES ($1,$2,'event',$3,$3,$4,$5,$6,$7,1,'pending')
           RETURNING work_id"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(projections::PROJECTION_VERSION)
    .bind(campaign_scope_id)
    .bind(window_start)
    .bind(window_end)
    .bind(sent_storage_id)
    .bind(delivered_storage_id)
    .fetch_one(&pool)
    .await
    .expect("campaign projection work");
    let mut campaign_completed = false;
    for _ in 0..5 {
        let _ = projections::process_once(&pool, &registry, "a10-projection-test", 60)
            .await
            .expect("campaign projection pass");
        let status: String = sqlx::query_scalar(
            "SELECT work_status FROM analytics.analytics_projection_work WHERE work_id = $1",
        )
        .bind(campaign_work_id)
        .fetch_one(&pool)
        .await
        .expect("campaign work status");
        if status == "completed" {
            campaign_completed = true;
            break;
        }
    }
    assert!(
        campaign_completed,
        "campaign projection work did not complete"
    );
    let campaign_generation_id: i64 = sqlx::query_scalar(
        "SELECT generation_id FROM analytics.analytics_projection_work WHERE work_id = $1",
    )
    .bind(campaign_work_id)
    .fetch_one(&pool)
    .await
    .expect("campaign generation");
    let ratio = sqlx::query(
        r#"SELECT COUNT(*) AS count, COUNT(numerator) AS numerators,
                  COUNT(denominator) AS denominators
           FROM analytics.analytics_projection_contribution
           WHERE generation_id = $1 AND metric_key = 'campaign.delivery_rate'
             AND source_storage_id IN ($2, $3)"#,
    )
    .bind(campaign_generation_id)
    .bind(sent_storage_id)
    .bind(delivered_storage_id)
    .fetch_one(&pool)
    .await
    .expect("ratio contributions");
    assert_eq!(ratio.get::<i64, _>("count"), 2);
    assert_eq!(ratio.get::<i64, _>("numerators"), 1);
    assert_eq!(ratio.get::<i64, _>("denominators"), 1);
    let delivery_rate: f64 = sqlx::query_scalar(
        r#"SELECT value_sum::DOUBLE PRECISION
           FROM analytics.analytics_projection_rollup
           WHERE generation_id = $1 AND metric_key = 'campaign.delivery_rate'
             AND target_scope_id = $2 AND interval = 'hour'"#,
    )
    .bind(campaign_generation_id)
    .bind(campaign_scope_id)
    .fetch_one(&pool)
    .await
    .expect("delivery rate rollup");
    assert_eq!(delivery_rate, 1.0);
}

#[tokio::test]
async fn connections_projection_builds_registered_metrics_with_bounded_dimensions() {
    let Some(pool) = pool().await else { return };
    let registry = load_registry().expect("registry");
    let suffix = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let scope_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.reporting_scope (
             scope_kind, owning_source_service, external_source_id, status, reporting_timezone
           ) VALUES ('core_organization','core',$1,'active','UTC')
           RETURNING scope_id"#,
    )
    .bind(format!("connections-projection-{suffix}"))
    .fetch_one(&pool)
    .await
    .expect("Connections scope");
    let stream = format!("connections-projection-stream-{suffix}");
    let connection_id = format!("ext-connections-{suffix}");
    let event_time = Utc
        .with_ymd_and_hms(2026, 8, 24, 10, 12, 0)
        .single()
        .expect("Connections event timestamp");
    let events = [
        (
            "connection.lifecycle@1",
            json!({
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "action": "connected",
                "status": "CONNECTED",
                "credential_status": "ACTIVE",
                "health_status": "HEALTHY",
                "webhook_status": "UNKNOWN",
                "occurred_at": event_time,
            }),
        ),
        (
            "connection.health_check@1",
            json!({
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "status": "CONNECTED",
                "health_status": "HEALTHY",
                "credential_status": "ACTIVE",
                "webhook_status": "UNKNOWN",
                "check_result": "healthy",
                "occurred_at": event_time,
            }),
        ),
        (
            "connection.capability.lifecycle@1",
            json!({
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "capability": "MESSAGING_INBOUND",
                "action": "enabled",
                "enabled": true,
                "occurred_at": event_time,
            }),
        ),
        (
            "connection.sync_attempt@1",
            json!({
                "attempt_id": format!("attempt-{suffix}"),
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "operation": "connection_refresh",
                "outcome": "succeeded",
                "failure_class": "none",
                "duration_ms": 120,
                "occurred_at": event_time,
            }),
        ),
        (
            "connection.rate_limit@1",
            json!({
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "operation": "connection_refresh",
                "rate_limit_scope": "provider",
                "retry_after_seconds": null,
                "observed_at": event_time,
            }),
        ),
        (
            "connection.incident.lifecycle@1",
            json!({
                "connection_id": connection_id,
                "provider": "WHATSAPP",
                "incident_key": "connection_health",
                "action": "opened",
                "severity": "critical",
                "reason_code": "provider_health_failed",
                "occurred_at": event_time,
            }),
        ),
    ];
    let mut storage_ids = Vec::new();
    for (sequence, (event_type, attributes)) in events.iter().enumerate() {
        let event_id = format!("connections-projection-event-{suffix}-{sequence}");
        let storage_id: i64 = sqlx::query_scalar(
            r#"INSERT INTO analytics.analytics_event (
                 producer_id, source_service, source_domain, source_stream_key, source_sequence,
                 event_id, event_type, schema_version, reporting_scope_id, root_scope_id,
                 subject_type, subject_id, occurred_at, origin, source_record_id, attributes, payload_hash
               ) VALUES ('core-customer-analytics','core','connections',$1,$2,$3,$4,1,$5,$5,
                         'connection',$6,$7,'test://connections-projection',$3,$8,repeat('d',64))
               RETURNING storage_id"#,
        )
        .bind(&stream)
        .bind(i64::try_from(sequence + 1).expect("sequence fits"))
        .bind(&event_id)
        .bind(*event_type)
        .bind(scope_id)
        .bind(&connection_id)
        .bind(event_time)
        .bind(attributes)
        .fetch_one(&pool)
        .await
        .expect("Connections event");
        storage_ids.push(storage_id);
    }

    let window_start = Utc
        .with_ymd_and_hms(2026, 8, 24, 10, 0, 0)
        .single()
        .expect("Connections window start");
    let window_end = window_start + chrono::Duration::hours(1);
    let work_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO analytics.analytics_projection_work (
             projection_name, projection_version, fact_kind, reporting_scope_id, root_scope_id,
             source_window_start, source_window_end, min_source_storage_id, max_source_storage_id,
             priority, work_status
           ) VALUES ($1,$2,'event',$3,$3,$4,$5,$6,$7,1,'pending')
           RETURNING work_id"#,
    )
    .bind(projections::PROJECTION_NAME)
    .bind(projections::PROJECTION_VERSION)
    .bind(scope_id)
    .bind(window_start)
    .bind(window_end)
    .bind(*storage_ids.first().expect("first storage id"))
    .bind(*storage_ids.last().expect("last storage id"))
    .fetch_one(&pool)
    .await
    .expect("Connections projection work");

    let mut completed = false;
    for _ in 0..8 {
        let _ = projections::process_once(&pool, &registry, "connections-projection-test", 60)
            .await
            .expect("Connections projection pass");
        let status: String = sqlx::query_scalar(
            "SELECT work_status FROM analytics.analytics_projection_work WHERE work_id = $1",
        )
        .bind(work_id)
        .fetch_one(&pool)
        .await
        .expect("Connections work status");
        if status == "completed" {
            completed = true;
            break;
        }
    }
    assert!(completed, "Connections projection work did not complete");

    let generation_id: i64 = sqlx::query_scalar(
        "SELECT generation_id FROM analytics.analytics_projection_work WHERE work_id = $1",
    )
    .bind(work_id)
    .fetch_one(&pool)
    .await
    .expect("Connections generation");
    assert_eq!(
        projections::enqueue_replay_range(&pool, scope_id, scope_id, window_start, window_end)
            .await
            .expect("Connections replay enqueue"),
        1
    );
    for _ in 0..8 {
        let _ = projections::process_once(&pool, &registry, "connections-replay-test", 60)
            .await
            .expect("Connections replay pass");
        let pending: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM analytics.analytics_projection_work
               WHERE projection_name = $1 AND projection_version = $2
                 AND reporting_scope_id = $3
                 AND source_window_start = $4 AND source_window_end = $5
                 AND work_status IN ('pending', 'leased', 'failed')"#,
        )
        .bind(projections::PROJECTION_NAME)
        .bind(projections::PROJECTION_VERSION)
        .bind(scope_id)
        .bind(window_start)
        .bind(window_end)
        .fetch_one(&pool)
        .await
        .expect("Connections replay status");
        if pending == 0 {
            break;
        }
    }
    let expected_dimensions = [
        (
            "connection.lifecycle_events",
            json!({"provider": "WHATSAPP", "lifecycle_action": "connected", "status": "CONNECTED"}),
        ),
        (
            "connection.health_checks",
            json!({
                "provider": "WHATSAPP",
                "status": "CONNECTED",
                "connection_health_status": "HEALTHY",
                "connection_credential_status": "ACTIVE",
                "connection_webhook_status": "UNKNOWN"
            }),
        ),
        (
            "connection.capability_events",
            json!({
                "provider": "WHATSAPP",
                "capability": "MESSAGING_INBOUND",
                "lifecycle_action": "enabled"
            }),
        ),
        (
            "connection.sync_attempts",
            json!({
                "provider": "WHATSAPP",
                "connection_sync_operation": "connection_refresh",
                "outcome": "succeeded",
                "failure_class": "none"
            }),
        ),
        (
            "connection.rate_limit_encounters",
            json!({
                "provider": "WHATSAPP",
                "connection_sync_operation": "connection_refresh",
                "rate_limit_scope": "provider"
            }),
        ),
        (
            "connection.incidents",
            json!({
                "provider": "WHATSAPP",
                "lifecycle_action": "opened",
                "incident_severity": "critical",
                "incident_reason_code": "provider_health_failed"
            }),
        ),
    ];
    for (metric_key, dimensions) in expected_dimensions {
        let row = sqlx::query(
            r#"SELECT COUNT(*) AS count, MIN(builder_name) AS builder_name,
                      (array_agg(dimensions))[1] AS dimensions,
                      (array_agg(coverage))[1] AS coverage
               FROM analytics.analytics_projection_contribution
               WHERE generation_id = $1 AND source_scope_id = $2 AND metric_key = $3"#,
        )
        .bind(generation_id)
        .bind(scope_id)
        .bind(metric_key)
        .fetch_one(&pool)
        .await
        .expect("Connections contribution");
        assert_eq!(row.get::<i64, _>("count"), 1, "metric {metric_key}");
        assert_eq!(row.get::<String, _>("builder_name"), "connections.v1");
        assert_eq!(row.get::<serde_json::Value, _>("dimensions"), dimensions);
        assert_eq!(
            row.get::<serde_json::Value, _>("coverage")
                .get("coverage_state")
                .and_then(serde_json::Value::as_str),
            Some("observed")
        );
    }
}
