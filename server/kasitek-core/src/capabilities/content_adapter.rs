use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::{
    db::models::{SocialPost, SocialPostUpsertRequest},
    error::AppError,
    identity::request_context::RequestContext,
    services::social,
};

const SUPPORTED_PLATFORMS: [&str; 7] = [
    "FACEBOOK",
    "INSTAGRAM",
    "THREADS",
    "TIKTOK",
    "BLUESKY",
    "LINKEDIN",
    "X",
];

/// Typed content capability boundary. Transport layers pass a normalized
/// context here; organization ownership is never accepted from the payload.
pub async fn list_posts(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<SocialPost>, AppError> {
    social::list_social_posts(pool, &context.organization_id).await
}

pub async fn get_post(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<Option<SocialPost>, AppError> {
    social::get_social_post(pool, &context.organization_id, post_id).await
}

pub async fn create_draft(
    pool: &PgPool,
    context: &RequestContext,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    let actor_id = context
        .user_id
        .as_deref()
        .or(context.principal.subject_user_id.as_deref())
        .map(str::to_string);
    let actor_id = match actor_id {
        Some(actor_id) => actor_id,
        None => {
            sqlx::query_scalar::<_, String>(r#"SELECT "ownerId" FROM "Organization" WHERE id = $1"#)
                .bind(&context.organization_id)
                .fetch_optional(pool)
                .await?
                .ok_or_else(|| AppError::NotFound("Organization owner not found".to_string()))?
        }
    };
    social::create_social_post_idempotent(
        pool,
        &actor_id,
        &context.organization_id,
        request,
        context.idempotency_key.as_deref(),
    )
    .await
}

pub async fn publish(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
    platform: &str,
) -> Result<serde_json::Value, AppError> {
    let platform = platform.trim().to_ascii_uppercase();
    if !SUPPORTED_PLATFORMS.contains(&platform.as_str()) {
        return Err(AppError::BadRequest(format!(
            "Publishing is not available for {platform}"
        )));
    }
    let post = social::get_social_post(pool, &context.organization_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    if !post.row.channels.iter().any(|channel| channel == &platform) {
        return Err(AppError::BadRequest(format!(
            "This post is not configured for {platform}"
        )));
    }
    let job_id = post
        .publish_jobs
        .iter()
        .find(|job| job.platform == platform)
        .map(|job| job.id.clone())
        .ok_or_else(|| AppError::NotFound("Publish job not found".to_string()))?;
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for content publishing".to_string())
    })?;
    let job = post
        .publish_jobs
        .iter()
        .find(|job| job.id == job_id)
        .expect("publish job selected from post");
    let prior_key = job
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("_kasitek_agent_idempotency_key"))
        .and_then(serde_json::Value::as_str);
    if prior_key == Some(idempotency_key) {
        let result = social::execute_social_publish_job(pool, &job_id).await?;
        let refreshed = social::get_social_post(pool, &context.organization_id, post_id).await?;
        return Ok(serde_json::json!({ "post": refreshed, "result": result }));
    }
    if prior_key.is_some() {
        return Err(AppError::Conflict(
            "This publish job already has an idempotent execution".to_string(),
        ));
    }
    if job.status == "PUBLISHED" && job.external_post_id.is_some() {
        return Err(AppError::Conflict(format!(
            "This post has already been published to {platform}"
        )));
    }
    let marked = sqlx::query(
        r#"UPDATE "SocialPublishJob"
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_kasitek_agent_idempotency_key}', to_jsonb($2::text), true), "updatedAt" = NOW()
           WHERE id = $1 AND metadata->>'_kasitek_agent_idempotency_key' IS NULL"#,
    )
    .bind(&job_id)
    .bind(idempotency_key)
    .execute(pool)
    .await?;
    if marked.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "This publish job was claimed by another execution".to_string(),
        ));
    }
    if !social::claim_publish_job(pool, &job_id, &["PENDING", "FAILED", "QUEUED"]).await? {
        return Err(AppError::Conflict(
            "This publish job is already being processed".to_string(),
        ));
    }
    let result = social::execute_social_publish_job(pool, &job_id).await?;
    let refreshed = social::get_social_post(pool, &context.organization_id, post_id).await?;
    Ok(serde_json::json!({ "post": refreshed, "result": result }))
}

pub async fn schedule(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
    scheduled_for: &str,
) -> Result<serde_json::Value, AppError> {
    let scheduled_for = DateTime::parse_from_rfc3339(scheduled_for)
        .map_err(|_| AppError::BadRequest("scheduledFor must be an RFC3339 timestamp".to_string()))?
        .with_timezone(&Utc);
    if scheduled_for <= Utc::now() {
        return Err(AppError::BadRequest(
            "scheduledFor must be in the future".to_string(),
        ));
    }
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for content scheduling".to_string())
    })?;
    let mut tx = pool.begin().await?;
    let lock_key = format!(
        "kasitek.content.schedule:{}:{}",
        context.organization_id, idempotency_key
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(lock_key)
        .execute(&mut *tx)
        .await?;
    let existing_marker = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "SocialPost" WHERE "orgId" = $1 AND metadata->>'_kasitek_agent_schedule_idempotency_key' = $2 LIMIT 1"#,
    )
    .bind(&context.organization_id)
    .bind(idempotency_key)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing_id) = existing_marker {
        tx.rollback().await?;
        let post = social::get_social_post(pool, &context.organization_id, &existing_id).await?;
        return Ok(serde_json::json!({ "post": post, "status": "SCHEDULED" }));
    }
    let post = social::get_social_post(pool, &context.organization_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    if !matches!(post.row.status.as_str(), "DRAFT" | "SCHEDULED") {
        return Err(AppError::Conflict(
            "Only draft content can be scheduled".to_string(),
        ));
    }
    let metadata = post.row.metadata.unwrap_or_else(|| serde_json::json!({}));
    let mut metadata = metadata.as_object().cloned().ok_or_else(|| {
        AppError::BadRequest("Content metadata must be a JSON object".to_string())
    })?;
    metadata.insert(
        "_kasitek_agent_schedule_idempotency_key".to_string(),
        serde_json::Value::String(idempotency_key.to_string()),
    );
    sqlx::query(
        r#"UPDATE "SocialPost"
           SET status = 'SCHEDULED'::"SocialPostStatus", "scheduledFor" = $2, metadata = $3, "updatedAt" = NOW()
           WHERE id = $1 AND "orgId" = $4"#,
    )
    .bind(post_id)
    .bind(scheduled_for)
    .bind(serde_json::Value::Object(metadata))
    .bind(&context.organization_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE "SocialPublishJob"
           SET status = 'QUEUED'::"SocialPublishJobStatus", "scheduledFor" = $2, "updatedAt" = NOW()
           WHERE "postId" = $1 AND status IN ('PENDING'::"SocialPublishJobStatus", 'FAILED'::"SocialPublishJobStatus", 'QUEUED'::"SocialPublishJobStatus")"#,
    )
    .bind(post_id)
    .bind(scheduled_for)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let refreshed = social::get_social_post(pool, &context.organization_id, post_id).await?;
    Ok(serde_json::json!({ "post": refreshed, "status": "SCHEDULED" }))
}
