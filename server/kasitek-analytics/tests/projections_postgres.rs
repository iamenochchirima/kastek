use std::{env, fs};

use kasitek_analytics::{projections, registry::load_registry};
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
}
