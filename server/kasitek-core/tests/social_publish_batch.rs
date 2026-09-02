use std::collections::BTreeSet;

use kasitek_core::capabilities::content_batch::{
    get_latest_batch_for_post, publish_batch, refresh_batch_status,
};
use kasitek_core::identity::principal::Principal;
use kasitek_core::identity::request_context::RequestContext;
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn batch_status_is_durable_organization_scoped_and_idempotent() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");

    let suffix = cuid2::create_id();
    let user_id = format!("batch-test-user-{suffix}");
    let org_id = format!("batch-test-org-{suffix}");
    let post_id = format!("batch-test-post-{suffix}");
    let job_a = format!("batch-test-job-a-{suffix}");
    let job_b = format!("batch-test-job-b-{suffix}");
    let batch_id = format!("batch-test-{suffix}");
    let item_a = format!("batch-test-item-a-{suffix}");
    let item_b = format!("batch-test-item-b-{suffix}");

    sqlx::query(
        r#"INSERT INTO "User" (id, email, "createdAt", "updatedAt")
           VALUES ($1, $2, NOW(), NOW())"#,
    )
    .bind(&user_id)
    .bind(format!("{user_id}@example.test"))
    .execute(&pool)
    .await
    .expect("test user should be inserted");
    sqlx::query(
        r#"INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())"#,
    )
    .bind(&org_id)
    .bind("Batch status integration")
    .bind(format!("batch-status-{suffix}"))
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("test organization should be inserted");
    sqlx::query(
        r#"INSERT INTO "SocialPost" (
             id, "userId", "orgId", content, channels, status, "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, 'Batch status test', ARRAY['X']::"SocialPlatform"[],
                     'PROCESSING'::"SocialPostStatus", NOW(), NOW())"#,
    )
    .bind(&post_id)
    .bind(&user_id)
    .bind(&org_id)
    .execute(&pool)
    .await
    .expect("test post should be inserted");
    for (job_id, status, external_post_id, error_message) in [
        (&job_a, "PUBLISHED", Some("provider-a"), None),
        (&job_b, "FAILED", None, Some("provider rejected")),
    ] {
        sqlx::query(
            r#"INSERT INTO "SocialPublishJob" (
                 id, "userId", "orgId", "postId", platform, status,
                 "externalPostId", "errorMessage", "createdAt", "updatedAt"
               ) VALUES ($1, $2, $3, $4, 'X'::"SocialPlatform", $5::"SocialPublishJobStatus",
                         $6, $7, NOW(), NOW())"#,
        )
        .bind(job_id)
        .bind(&user_id)
        .bind(&org_id)
        .bind(&post_id)
        .bind(status)
        .bind(external_post_id)
        .bind(error_message)
        .execute(&pool)
        .await
        .expect("test publish job should be inserted");
    }
    sqlx::query(
        r#"INSERT INTO "SocialPublishBatch" (
             id, "userId", "orgId", "postId", status, "idempotencyKey", "snapshotHash",
             "targetCount", "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, $4, 'PROCESSING', $5, 'snapshot-test', 2, NOW(), NOW())"#,
    )
    .bind(&batch_id)
    .bind(&user_id)
    .bind(&org_id)
    .bind(&post_id)
    .bind(format!("batch-idempotency-{suffix}"))
    .execute(&pool)
    .await
    .expect("test batch should be inserted");
    for (item_id, job_id) in [(&item_a, &job_a), (&item_b, &job_b)] {
        sqlx::query(
            r#"INSERT INTO "SocialPublishBatchItem" (
                 id, "batchId", "jobId", platform, status, "createdAt", "updatedAt"
               ) VALUES ($1, $2, $3, 'X'::"SocialPlatform", 'QUEUED', NOW(), NOW())"#,
        )
        .bind(item_id)
        .bind(&batch_id)
        .bind(job_id)
        .execute(&pool)
        .await
        .expect("test batch item should be inserted");
    }

    let summary = refresh_batch_status(&pool, &batch_id, &org_id)
        .await
        .expect("batch status should refresh");
    assert_eq!(summary.status, "PARTIAL");
    assert_eq!(summary.published_count, 1);
    assert_eq!(summary.failed_count, 1);
    assert_eq!(summary.targets.len(), 2);
    assert!(summary
        .targets
        .iter()
        .any(|target| target.state == "PUBLISHED"));
    assert!(summary
        .targets
        .iter()
        .any(|target| target.state == "FAILED" && target.message.is_some()));

    let context = RequestContext {
        principal: Principal::direct_user(&user_id),
        organization_id: org_id.clone(),
        user_id: Some(user_id.clone()),
        client_id: None,
        installation_id: None,
        effective_grants: BTreeSet::new(),
        api_scopes: None,
        correlation_id: None,
        causation_id: None,
        idempotency_key: None,
    };
    let latest = get_latest_batch_for_post(&pool, &context, &post_id)
        .await
        .expect("latest batch should load")
        .expect("latest batch should exist");
    assert_eq!(latest.batch_id, batch_id);
    assert_eq!(latest.status, "PARTIAL");

    let duplicate = sqlx::query(
        r#"INSERT INTO "SocialPublishBatch" (
             id, "userId", "orgId", "postId", status, "idempotencyKey", "snapshotHash",
             "targetCount", "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, $4, 'PROCESSING', $5, 'other-snapshot', 0, NOW(), NOW())"#,
    )
    .bind(format!("batch-test-duplicate-{suffix}"))
    .bind(&user_id)
    .bind(&org_id)
    .bind(&post_id)
    .bind(format!("batch-idempotency-{suffix}"))
    .execute(&pool)
    .await;
    assert!(
        duplicate.is_err(),
        "duplicate organization idempotency key must be rejected"
    );

    sqlx::query(r#"DELETE FROM "Organization" WHERE id = $1"#)
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("test organization should be cleaned up");
    sqlx::query(r#"DELETE FROM "User" WHERE id = $1"#)
        .bind(&user_id)
        .execute(&pool)
        .await
        .expect("test user should be cleaned up");
}

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn blocked_batch_does_not_queue_ready_targets() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");

    let suffix = cuid2::create_id();
    let user_id = format!("batch-blocked-user-{suffix}");
    let org_id = format!("batch-blocked-org-{suffix}");
    let post_id = format!("batch-blocked-post-{suffix}");
    let job_id = format!("batch-blocked-job-{suffix}");

    sqlx::query(
        r#"INSERT INTO "User" (id, email, "createdAt", "updatedAt")
           VALUES ($1, $2, NOW(), NOW())"#,
    )
    .bind(&user_id)
    .bind(format!("{user_id}@example.test"))
    .execute(&pool)
    .await
    .expect("test user should be inserted");
    sqlx::query(
        r#"INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())"#,
    )
    .bind(&org_id)
    .bind("Batch blocked admission")
    .bind(format!("batch-blocked-{suffix}"))
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("test organization should be inserted");
    sqlx::query(
        r#"INSERT INTO "SocialPost" (
             id, "userId", "orgId", content, channels, status, "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, 'Blocked batch test', ARRAY['X']::"SocialPlatform"[],
                     'DRAFT'::"SocialPostStatus", NOW(), NOW())"#,
    )
    .bind(&post_id)
    .bind(&user_id)
    .bind(&org_id)
    .execute(&pool)
    .await
    .expect("test post should be inserted");
    sqlx::query(
        r#"INSERT INTO "SocialPublishJob" (
             id, "userId", "orgId", "postId", platform, status, "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, $4, 'X'::"SocialPlatform", 'PENDING'::"SocialPublishJobStatus", NOW(), NOW())"#,
    )
    .bind(&job_id)
    .bind(&user_id)
    .bind(&org_id)
    .bind(&post_id)
    .execute(&pool)
    .await
    .expect("test publish job should be inserted");

    let context = RequestContext {
        principal: Principal::direct_user(&user_id),
        organization_id: org_id.clone(),
        user_id: Some(user_id.clone()),
        client_id: None,
        installation_id: None,
        effective_grants: BTreeSet::new(),
        api_scopes: None,
        correlation_id: None,
        causation_id: None,
        idempotency_key: Some(format!("blocked-batch-{suffix}")),
    };
    let response = publish_batch(&pool, &context, &post_id, None)
        .await
        .expect("blocked batch admission should be durable");
    assert_eq!(response.batch.status, "BLOCKED");
    assert_eq!(response.batch.blocked_count, 1);
    assert_eq!(response.batch.targets.len(), 1);
    assert_eq!(response.batch.targets[0].state, "BLOCKED");
    assert_eq!(
        response.batch.targets[0].reason_code.as_deref(),
        Some("connection_not_found")
    );

    let job_status = sqlx::query_scalar::<_, String>(
        r#"SELECT status::text FROM "SocialPublishJob" WHERE id = $1"#,
    )
    .bind(&job_id)
    .fetch_one(&pool)
    .await
    .expect("test publish job should remain available");
    assert_eq!(job_status, "PENDING");

    sqlx::query(r#"DELETE FROM "Organization" WHERE id = $1"#)
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("test organization should be cleaned up");
    sqlx::query(r#"DELETE FROM "User" WHERE id = $1"#)
        .bind(&user_id)
        .execute(&pool)
        .await
        .expect("test user should be cleaned up");
}
