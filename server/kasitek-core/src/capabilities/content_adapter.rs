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

/// Update an existing workspace-owned draft through the same content service
/// used by the product controller. The internal Agent boundary may only edit
/// drafts; publishing and scheduling remain separate approval-aware actions.
pub async fn update_draft(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    if request
        .status
        .as_deref()
        .is_some_and(|status| status != "DRAFT")
    {
        return Err(AppError::BadRequest(
            "Agent content updates must keep DRAFT status".to_string(),
        ));
    }
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
    social::update_social_post(pool, &actor_id, &context.organization_id, post_id, request).await
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

/// Move a scheduled post back to a draft and release its queued provider jobs.
/// The idempotency marker is stored with the post so retries return the same
/// draft outcome without reapplying the transition.
pub async fn unschedule(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<serde_json::Value, AppError> {
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for content unscheduling".to_string())
    })?;
    let mut tx = pool.begin().await?;
    let lock_key = format!(
        "kasitek.content.unschedule:{}:{}",
        context.organization_id, post_id
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(lock_key)
        .execute(&mut *tx)
        .await?;
    let (status, metadata) = sqlx::query_as::<_, (String, Option<serde_json::Value>)>(
        r#"SELECT status::text, metadata FROM "SocialPost" WHERE id = $1 AND "orgId" = $2"#,
    )
    .bind(post_id)
    .bind(&context.organization_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    let mut metadata = metadata.unwrap_or_else(|| serde_json::json!({}));
    let object = metadata.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("Content metadata must be a JSON object".to_string())
    })?;
    if object
        .get("_kasitek_agent_unschedule_idempotency_key")
        .and_then(serde_json::Value::as_str)
        == Some(idempotency_key)
    {
        tx.rollback().await?;
        let post = social::get_social_post(pool, &context.organization_id, post_id).await?;
        return Ok(serde_json::json!({ "post": post, "status": "DRAFT" }));
    }
    if status != "SCHEDULED" {
        return Err(AppError::Conflict(
            "Only scheduled content can be unscheduled".to_string(),
        ));
    }
    object.remove("_kasitek_agent_schedule_idempotency_key");
    object.insert(
        "_kasitek_agent_unschedule_idempotency_key".to_string(),
        serde_json::Value::String(idempotency_key.to_string()),
    );
    sqlx::query(
        r#"UPDATE "SocialPost"
           SET status = 'DRAFT'::"SocialPostStatus", "scheduledFor" = NULL, metadata = $3, "updatedAt" = NOW()
           WHERE id = $1 AND "orgId" = $2"#,
    )
    .bind(post_id)
    .bind(&context.organization_id)
    .bind(serde_json::Value::Object(object.clone()))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE "SocialPublishJob"
           SET status = 'PENDING'::"SocialPublishJobStatus", "scheduledFor" = NULL, "updatedAt" = NOW()
           WHERE "postId" = $1 AND status = 'QUEUED'::"SocialPublishJobStatus""#,
    )
    .bind(post_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let post = social::get_social_post(pool, &context.organization_id, post_id).await?;
    Ok(serde_json::json!({ "post": post, "status": "DRAFT" }))
}

/// Delete a draft or scheduled post without exposing a cross-organization
/// existence check. Published records remain immutable for auditability.
pub async fn delete_post(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<serde_json::Value, AppError> {
    if context.idempotency_key.is_none() {
        return Err(AppError::BadRequest(
            "idempotency-key is required for content deletion".to_string(),
        ));
    }
    let status = sqlx::query_scalar::<_, String>(
        r#"SELECT status::text FROM "SocialPost" WHERE id = $1 AND "orgId" = $2"#,
    )
    .bind(post_id)
    .bind(&context.organization_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    if status == "PUBLISHED" {
        return Err(AppError::Conflict(
            "Published content is immutable and cannot be deleted".to_string(),
        ));
    }
    let deleted = social::delete_social_post(pool, &context.organization_id, post_id).await?;
    Ok(serde_json::json!({ "postId": post_id, "deleted": deleted }))
}

#[cfg(test)]
mod tests {
    use sqlx::postgres::PgPoolOptions;

    use crate::identity::{
        principal::{Principal, PrincipalKind},
        request_context::RequestContext,
    };

    use super::{delete_post, publish, schedule, unschedule};

    fn context(idempotency_key: Option<&str>) -> RequestContext {
        RequestContext {
            principal: Principal {
                kind: PrincipalKind::AgentInstallation,
                id: "installation-1".to_string(),
                subject_user_id: Some("actor-1".to_string()),
                client_id: Some("credential-1".to_string()),
            },
            organization_id: "org-1".to_string(),
            user_id: Some("actor-1".to_string()),
            client_id: Some("credential-1".to_string()),
            installation_id: Some("installation-1".to_string()),
            effective_grants: Default::default(),
            correlation_id: None,
            causation_id: None,
            idempotency_key: idempotency_key.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn rejects_invalid_publish_platform_before_database_access() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/kasitek")
            .expect("lazy pool");
        let error = publish(&pool, &context(Some("publish-1")), "post-1", "mastodon")
            .await
            .expect_err("unsupported platform must be rejected");
        assert!(error.to_string().contains("Publishing is not available"));
    }

    #[tokio::test]
    async fn rejects_invalid_schedule_timestamp_before_database_access() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/kasitek")
            .expect("lazy pool");
        let error = schedule(&pool, &context(Some("schedule-1")), "post-1", "tomorrow")
            .await
            .expect_err("non-RFC3339 schedule must be rejected");
        assert!(error.to_string().contains("RFC3339"));
    }

    #[tokio::test]
    async fn requires_idempotency_for_unschedule_and_delete() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://localhost/kasitek")
            .expect("lazy pool");
        assert!(unschedule(&pool, &context(None), "post-1")
            .await
            .expect_err("unschedule must require idempotency")
            .to_string()
            .contains("idempotency-key"));
        assert!(delete_post(&pool, &context(None), "post-1")
            .await
            .expect_err("delete must require idempotency")
            .to_string()
            .contains("idempotency-key"));
    }
}
