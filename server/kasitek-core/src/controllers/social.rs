use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::capabilities::content_batch;
use crate::config::AppConfig;
use crate::db::models::{
    SocialChannelCreateRequest, SocialChannelUpdateRequest, SocialPostUpsertRequest,
    SocialPublishJobActionRequest, SocialPublishRequest,
};
use crate::error::AppError;
use crate::identity::product_session;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{
    bluesky_oauth, connection_permissions, connections, orgs, social, social_posts,
};

#[derive(Debug, Deserialize)]
pub struct PublicMediaQuery {
    pub expires: i64,
    pub signature: String,
}

#[derive(Debug, Default, Deserialize)]
struct SocialPostDeleteRequest {
    #[serde(rename = "deleteFromPlatforms")]
    delete_from_platforms: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ProviderAccessStartQuery {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    capabilities: Option<String>,
}

fn has_unknown_publish_outcome(metadata: Option<&serde_json::Value>) -> bool {
    metadata
        .and_then(|value| value.get("_kasitek_outcome"))
        .and_then(|value| value.as_str())
        == Some("UNKNOWN")
}

async fn prepare_provider_access_attempt(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    query: &ProviderAccessStartQuery,
    expected_provider: &str,
    target: &str,
    state: String,
) -> Result<(String, Option<connection_permissions::AuthorizationAttempt>), AppError> {
    let requested = match query.connection_id.as_deref() {
        Some(_) => {
            connection_permissions::parse_requested_capabilities(query.capabilities.as_deref())?
        }
        None => {
            connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref())
        }
    };
    let Some(connection_id) = query.connection_id.as_deref() else {
        return Ok((state, None));
    };
    let plan = connection_permissions::plan_access_request(pool, org_id, connection_id, &requested)
        .await?;
    if !plan
        .context
        .provider
        .eq_ignore_ascii_case(expected_provider)
    {
        return Err(AppError::BadRequest(
            "The access request provider does not match the connection".to_string(),
        ));
    }
    let attempt = connection_permissions::create_authorization_attempt_with_state(
        pool,
        org_id,
        user_id,
        connection_id,
        &plan.context.provider,
        plan.adapter.auth_mode(),
        target,
        &plan.effective_capabilities,
        state.clone(),
    )
    .await?;
    Ok((state, Some(attempt)))
}

async fn finish_provider_attempt(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    state: Option<&str>,
    expected_provider: &str,
    status: &str,
    failure_code: Option<&str>,
) -> Result<Option<connection_permissions::AuthorizationAttempt>, AppError> {
    let Some(state) = state else {
        return Ok(None);
    };
    let Some(attempt) =
        connection_permissions::find_authorization_attempt(pool, org_id, user_id, state).await?
    else {
        return Ok(None);
    };
    if !attempt.provider.eq_ignore_ascii_case(expected_provider) {
        return Err(AppError::BadRequest(
            "OAuth state does not match the requested provider".to_string(),
        ));
    }
    connection_permissions::finish_authorization_attempt(pool, &attempt.id, status, failure_code)
        .await?;
    Ok(Some(attempt))
}

#[derive(Debug, Default, Deserialize)]
pub struct SocialPostInsightsQuery {
    pub platform: Option<String>,
    pub metrics: Option<String>,
    #[serde(rename = "publishedFrom", alias = "published_from")]
    pub published_from: Option<String>,
    #[serde(rename = "publishedTo", alias = "published_to")]
    pub published_to: Option<String>,
    pub limit: Option<i64>,
}

fn parse_social_insights_filters(
    query: &SocialPostInsightsQuery,
) -> Result<social::SocialPostInsightsFilters, AppError> {
    let filters = social::parse_insights_filters(
        query.platform.as_deref(),
        query.metrics.as_deref(),
        query.published_from.as_deref(),
        query.published_to.as_deref(),
    )?;
    if let Some(platform) = filters.platform.as_deref() {
        if !social::is_valid_platform(platform) {
            return Err(AppError::BadRequest("Invalid social platform".to_string()));
        }
    }
    Ok(filters)
}

async fn require_social_access(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: &str,
) -> Result<String, AppError> {
    // Content is temporarily available to every authenticated workspace while
    // product packaging is being finalised. Keep workspace isolation intact.
    resolve_active_org_id(req, pool, user_id).await
}

async fn require_social_publish_access(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: &str,
) -> Result<String, AppError> {
    // Publishing is included with the temporary open-access content rollout.
    resolve_active_org_id(req, pool, user_id).await
}

async fn require_social_connection_admin(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: &str,
) -> Result<String, AppError> {
    let org_id = require_social_access(pool, req, user_id).await?;
    orgs::require_admin(pool, &org_id, user_id).await?;
    Ok(org_id)
}

pub async fn list_channels(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    if let Err(error) =
        social::ensure_meta_page_app_webhooks(pool.get_ref(), &org_id, config.get_ref()).await
    {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "meta",
            operation = "page_app_webhooks.ensure",
            org_id = %org_id,
            error_type = %std::any::type_name_of_val(&error),
            "failed to ensure Page app webhooks"
        );
    }
    if let Err(error) =
        social::ensure_meta_instagram_app_webhooks(pool.get_ref(), &org_id, config.get_ref()).await
    {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "meta",
            operation = "instagram_app_webhooks.ensure",
            org_id = %org_id,
            error_type = %std::any::type_name_of_val(&error),
            "failed to ensure Instagram app webhooks"
        );
    }
    if let Err(error) =
        social::ensure_meta_page_webhook_subscriptions(pool.get_ref(), &org_id).await
    {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "meta",
            operation = "page_webhooks.ensure",
            org_id = %org_id,
            error_type = %std::any::type_name_of_val(&error),
            "failed to ensure Page webhooks"
        );
    }
    if let Err(error) =
        social::ensure_instagram_account_webhook_subscriptions(pool.get_ref(), &org_id).await
    {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "instagram",
            operation = "account_webhooks.ensure",
            org_id = %org_id,
            error_type = %std::any::type_name_of_val(&error),
            "failed to ensure Instagram account webhooks"
        );
    }
    let channels = social::list_social_channels(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "channels": channels })))
}

pub async fn create_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialChannelCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let platform = body
        .platform
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("A valid platform is required".to_string()))?;
    if !social::is_valid_platform(platform) {
        return Err(AppError::BadRequest(
            "A valid platform is required".to_string(),
        ));
    }
    let display_name = body
        .display_name
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Display name is required".to_string()))?;
    let status = body.status.as_deref().unwrap_or("CONNECTED");
    if !social::is_valid_channel_status(status) {
        return Err(AppError::BadRequest("Invalid channel status".to_string()));
    }
    let channel = social::create_social_channel(
        pool.get_ref(),
        &user.id,
        &org_id,
        platform,
        display_name,
        body.handle
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        body.external_account_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        status,
        body.metadata.clone(),
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "channel": channel })))
}

pub async fn tiktok_creator_info(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let creator = social::get_tiktok_creator_info(pool.get_ref(), &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({"creator": creator})))
}

pub async fn update_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialChannelUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let existing = social::get_social_channel(pool.get_ref(), &org_id, &path).await?;
    let existing = existing.ok_or_else(|| AppError::NotFound("Channel not found".to_string()))?;
    let platform = body
        .platform
        .as_deref()
        .unwrap_or(existing.platform.as_str());
    if !social::is_valid_platform(platform) {
        return Err(AppError::BadRequest("Invalid platform".to_string()));
    }
    let status = body.status.as_deref().unwrap_or(existing.status.as_str());
    if !social::is_valid_channel_status(status) {
        return Err(AppError::BadRequest("Invalid channel status".to_string()));
    }
    let display_name = body
        .display_name
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(existing.display_name.clone());
    let channel = social::update_social_channel(
        pool.get_ref(),
        &org_id,
        &path,
        platform,
        &display_name,
        body.handle
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or(existing.handle.clone()),
        status,
        body.metadata.clone().or(existing.metadata.clone()),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "channel": channel })))
}

pub async fn refresh_channel_identity(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let channel = social::refresh_social_channel_identity(pool.get_ref(), &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "channel": channel })))
}

pub async fn delete_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let deleted = social::delete_social_channel(pool.get_ref(), &org_id, &path).await?;
    if !deleted {
        return Err(AppError::NotFound("Channel not found".to_string()));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn list_posts(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let posts = social::list_social_posts(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "posts": posts })))
}

pub async fn upload_media(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let asset = crate::services::content_media::upload_content_media(
        pool.get_ref(),
        config.get_ref(),
        &user.id,
        &org_id,
        payload,
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "asset": asset })))
}

pub async fn download_media(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    crate::services::content_media::download_content_media(
        pool.get_ref(),
        config.get_ref(),
        &org_id,
        &path,
    )
    .await
}

pub async fn download_public_media(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
    query: web::Query<PublicMediaQuery>,
) -> Result<HttpResponse, AppError> {
    crate::services::content_media::download_public_content_media(
        pool.get_ref(),
        config.get_ref(),
        &path,
        query.expires,
        &query.signature,
    )
    .await
}

pub async fn create_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let post = social::create_social_post(pool.get_ref(), &user.id, &org_id, &body).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "post": post })))
}

pub async fn get_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let post = social::get_social_post(pool.get_ref(), &org_id, &path)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn get_post_activity(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let post_id = path.into_inner();
    let activity = social_posts::get_social_post_activity(pool.get_ref(), &org_id, &post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(activity))
}

pub async fn list_post_insights(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<SocialPostInsightsQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let filters = parse_social_insights_filters(&query)?;
    let report = social::list_social_post_insights(
        pool.get_ref(),
        &org_id,
        &filters,
        query.limit.unwrap_or(50),
    )
    .await?;
    Ok(HttpResponse::Ok().json(report))
}

pub async fn get_post_insights(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<SocialPostInsightsQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let filters = parse_social_insights_filters(&query)?;
    let insights =
        social::get_social_post_insights(pool.get_ref(), &org_id, &path.into_inner(), &filters)
            .await?
            .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(insights))
}

pub async fn refresh_post_insights(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<SocialPostInsightsQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let post_id = path.into_inner();
    let filters = parse_social_insights_filters(&query)?;
    social::force_sync_social_post_insights(pool.get_ref(), &org_id, Some(&post_id), 1).await?;
    let insights = social::get_social_post_insights(pool.get_ref(), &org_id, &post_id, &filters)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(insights))
}

pub async fn update_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let post = social::update_social_post(pool.get_ref(), &user.id, &org_id, &path, &body).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn delete_post(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Bytes,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_access(pool.get_ref(), &req, &user.id).await?;
    let delete_from_platforms = if body.is_empty() {
        false
    } else {
        serde_json::from_slice::<SocialPostDeleteRequest>(&body)
            .map_err(|_| AppError::BadRequest("Invalid delete options".to_string()))?
            .delete_from_platforms
            .unwrap_or(false)
    };

    if delete_from_platforms {
        let result = social::delete_social_post_from_platforms(
            pool.get_ref(),
            config.get_ref(),
            &org_id,
            &path,
        )
        .await?;
        if !result.success {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "success": false,
                "error": "The post was not removed from KasiTek because one or more platform deletions failed.",
                "localDeleted": result.local_deleted,
                "providerResults": result.provider_results,
                "authorizationRequired": result.authorization_required,
            })));
        }
        return Ok(HttpResponse::Ok().json(result));
    }

    let deleted = social::delete_social_post(pool.get_ref(), &org_id, &path).await?;
    if !deleted {
        return Err(AppError::NotFound("Post not found".to_string()));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "localDeleted": true,
        "providerResults": []
    })))
}

pub async fn publish_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPublishRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_publish_access(pool.get_ref(), &req, &user.id).await?;
    let requested_platform = body.platform.as_deref().unwrap_or("X");
    if !matches!(
        requested_platform,
        "FACEBOOK" | "INSTAGRAM" | "THREADS" | "TIKTOK" | "BLUESKY" | "LINKEDIN" | "X"
    ) {
        return Err(AppError::BadRequest(format!(
            "Manual publishing is not available yet for {}",
            requested_platform
        )));
    }
    let post = social::get_social_post(pool.get_ref(), &org_id, &path)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;

    if !post
        .row
        .channels
        .iter()
        .any(|channel| channel == requested_platform)
    {
        return Err(AppError::BadRequest(format!(
            "This post is not configured for {}",
            requested_platform
        )));
    }

    if post.publish_jobs.iter().any(|job| {
        job.platform == requested_platform
            && job.status == "PUBLISHED"
            && job.external_post_id.is_some()
    }) {
        return Err(AppError::Conflict(format!(
            "This post has already been published to {}",
            requested_platform
        )));
    }

    let job = post
        .publish_jobs
        .iter()
        .find(|job| job.platform == requested_platform)
        .map(|job| job.id.clone())
        .ok_or_else(|| AppError::NotFound("Publish job not found".to_string()))?;

    let claimed =
        social::claim_publish_job(pool.get_ref(), &job, &["PENDING", "FAILED", "QUEUED"]).await?;
    if !claimed {
        return Err(AppError::Conflict(
            "This publish job is already being processed".to_string(),
        ));
    }

    let result = social::execute_social_publish_job(pool.get_ref(), &job).await?;
    let refreshed_post = social::get_social_post(pool.get_ref(), &org_id, &path).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "post": refreshed_post,
        "result": result
    })))
}

pub async fn publish_post_batch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let mut context = product_session::resolve(&req, pool.get_ref()).await?;
    let post_id = path.into_inner();
    if context.idempotency_key.is_none() {
        context.idempotency_key = Some(format!(
            "manual:content-publish-batch:{}:{}",
            post_id,
            cuid2::create_id()
        ));
    }
    let result = content_batch::publish_batch(pool.get_ref(), &context, &post_id, None).await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn preflight_post_batch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = product_session::resolve(&req, pool.get_ref()).await?;
    let result = content_batch::preflight(pool.get_ref(), &context, &path.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_latest_post_batch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = product_session::resolve(&req, pool.get_ref()).await?;
    let result =
        content_batch::get_latest_batch_for_post(pool.get_ref(), &context, &path.into_inner())
            .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "batch": result })))
}

pub async fn retry_post_batch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let mut context = product_session::resolve(&req, pool.get_ref()).await?;
    let batch_id = path.into_inner();
    if context.idempotency_key.is_none() {
        context.idempotency_key = Some(format!(
            "manual:content-publish-batch-retry:{}:{}",
            batch_id,
            cuid2::create_id()
        ));
    }
    let result = content_batch::retry_failed_batch(pool.get_ref(), &context, &batch_id).await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn update_publish_job(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPublishJobActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_publish_access(pool.get_ref(), &req, &user.id).await?;
    let action = body
        .action
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Action is required".to_string()))?;
    let job_id = path.into_inner();

    let job = sqlx::query_as::<_, crate::db::models::SocialPublishJobRow>(
        r#"
        SELECT id, "userId" AS user_id, "postId" AS post_id, "variantId" AS variant_id,
               "channelConnectionId" AS channel_connection_id, platform::text AS platform,
               status::text AS status, "scheduledFor" AT TIME ZONE 'UTC' AS scheduled_for,
               "publishedAt" AT TIME ZONE 'UTC' AS published_at,
               "externalPostId" AS external_post_id, "errorMessage" AS error_message,
               metadata, "deliverySnapshot" AS delivery_snapshot,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialPublishJob"
        WHERE id = $1 AND "orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(&job_id)
    .bind(&org_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Publish job not found".to_string()))?;

    match action {
        "cancel" => {
            sqlx::query(
                r#"
                UPDATE "SocialPublishJob"
                SET status = 'CANCELED'::"SocialPublishJobStatus", "errorMessage" = NULL, "updatedAt" = NOW()
                WHERE id = $1
                "#,
            )
            .bind(&job_id)
            .execute(pool.get_ref())
            .await?;
        }
        "retry" => {
            if has_unknown_publish_outcome(job.metadata.as_ref()) {
                return Err(AppError::Conflict(
                    "This publish result is unknown; reconcile the provider before retrying"
                        .to_string(),
                ));
            }
            sqlx::query(
                r#"
                UPDATE "SocialPublishJob"
                SET status = 'QUEUED'::"SocialPublishJobStatus", "errorMessage" = NULL,
                    "scheduledFor" = NOW(),
                    metadata = COALESCE(metadata, '{}'::jsonb) - '_kasitek_outcome',
                    "updatedAt" = NOW()
                WHERE id = $1
                "#,
            )
            .bind(&job_id)
            .execute(pool.get_ref())
            .await?;
        }
        "run_now" => {
            if has_unknown_publish_outcome(job.metadata.as_ref()) {
                return Err(AppError::Conflict(
                    "This publish result is unknown; reconcile the provider before retrying"
                        .to_string(),
                ));
            }
            let claimed = social::claim_publish_job(
                pool.get_ref(),
                &job_id,
                &["PENDING", "FAILED", "QUEUED"],
            )
            .await?;
            if !claimed {
                return Err(AppError::Conflict(
                    "This publish job is already processing".to_string(),
                ));
            }
            let _ = social::execute_social_publish_job(pool.get_ref(), &job_id).await?;
        }
        _ => return Err(AppError::BadRequest("Unsupported action".to_string())),
    }

    let post = social::get_social_post(pool.get_ref(), &org_id, &job.post_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn start_x_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ProviderAccessStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let state = social::create_x_oauth_state();
    let requested_capabilities =
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
    let (state_value, access_attempt) = prepare_provider_access_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        &query,
        "X",
        "x",
        state.state.clone(),
    )
    .await?;
    let authorize_url = social::build_x_authorize_url_for_request(
        config.get_ref(),
        &state_value,
        &state.challenge,
        access_attempt
            .as_ref()
            .map(|attempt| attempt.requested_capabilities.as_slice())
            .unwrap_or(requested_capabilities.as_slice()),
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::X_STATE_COOKIE, state_value)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .cookie(
            actix_web::cookie::Cookie::build(social::X_VERIFIER_COOKIE, state.verifier)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .finish())
}

pub async fn x_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        finish_provider_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            query.state.as_deref(),
            "X",
            "DECLINED",
            Some("provider_denied"),
        )
        .await?;
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/connections?error={}",
            config.auth_url,
            urlencoding::encode(&message)
        );
        return Ok(HttpResponse::Found()
            .append_header(("Location", redirect))
            .finish());
    }

    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth code".to_string()))?;
    let returned_state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    let stored_state = req
        .cookie(social::X_STATE_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    let verifier = req
        .cookie(social::X_VERIFIER_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    if stored_state != returned_state {
        return Err(AppError::BadRequest("Invalid OAuth state".to_string()));
    }

    let tokens = social::exchange_x_code_for_tokens(config.get_ref(), code, &verifier).await?;
    let profile = social::fetch_x_me(
        tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing X access token".to_string()))?,
    )
    .await?;
    let _channel =
        social::upsert_x_connection_for_org(pool.get_ref(), &user.id, &org_id, &tokens, &profile)
            .await?;
    let access_attempt = finish_provider_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        Some(returned_state),
        "X",
        "COMPLETED",
        None,
    )
    .await?;

    let redirect = if access_attempt.is_some() {
        format!("{}/connections?connected=x&access=granted", config.auth_url)
    } else {
        format!("{}/connections?connected=x", config.auth_url)
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(
            actix_web::cookie::Cookie::build(social::X_STATE_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .cookie(
            actix_web::cookie::Cookie::build(social::X_VERIFIER_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .finish())
}

pub async fn start_linkedin_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ProviderAccessStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let state = social::create_linkedin_oauth_state();
    let requested_capabilities =
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
    let organization = if let Some(connection_id) = query.connection_id.as_deref() {
        let context = connection_permissions::get_connection_access_context(
            pool.get_ref(),
            &org_id,
            connection_id,
        )
        .await?;
        context
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("accountType"))
            .and_then(|value| value.as_str())
            == Some("organization")
    } else {
        false
    };
    let (state_value, access_attempt) = prepare_provider_access_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        &query,
        "LINKEDIN",
        "linkedin",
        state,
    )
    .await?;
    let authorize_url = social::build_linkedin_authorize_url_for_request(
        config.get_ref(),
        &state_value,
        access_attempt
            .as_ref()
            .map(|attempt| attempt.requested_capabilities.as_slice())
            .unwrap_or(requested_capabilities.as_slice()),
        organization,
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::LINKEDIN_STATE_COOKIE, state_value)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .finish())
}

pub async fn start_meta_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::MetaOAuthStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let target = match query.target.as_deref().unwrap_or("facebook") {
        "facebook" => "facebook",
        "instagram" => "instagram",
        _ => {
            return Err(AppError::BadRequest(
                "Meta connection target must be facebook or instagram".to_string(),
            ))
        }
    };
    let requested_capabilities = if query.connection_id.is_some() {
        connection_permissions::parse_requested_capabilities(query.capabilities.as_deref())?
    } else {
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref())
    };
    let requested_capabilities = if let Some(connection_id) = query.connection_id.as_deref() {
        let plan = connection_permissions::plan_access_request(
            pool.get_ref(),
            &org_id,
            connection_id,
            &requested_capabilities,
        )
        .await?;
        let expected_provider = if target == "facebook" {
            "FACEBOOK"
        } else {
            "INSTAGRAM"
        };
        if plan.context.provider != expected_provider || plan.adapter.auth_mode() != "meta_login" {
            return Err(AppError::BadRequest(
                "The access request target does not match the connection authorization mode"
                    .to_string(),
            ));
        }
        let attempt = connection_permissions::create_authorization_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            connection_id,
            &plan.context.provider,
            plan.adapter.auth_mode(),
            target,
            &plan.effective_capabilities,
        )
        .await?;
        (attempt.state, attempt.requested_capabilities)
    } else {
        (social::create_meta_oauth_state(), requested_capabilities)
    };
    let (state, requested_capabilities) = requested_capabilities;
    let authorize_url = social::build_meta_authorize_url_for_request(
        config.get_ref(),
        &state,
        target,
        &requested_capabilities,
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::META_STATE_COOKIE, state)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .cookie(
            actix_web::cookie::Cookie::build(social::META_TARGET_COOKIE, target)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .finish())
}

pub async fn start_instagram_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::MetaOAuthStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let requested_capabilities = if query.connection_id.is_some() {
        connection_permissions::parse_requested_capabilities(query.capabilities.as_deref())?
    } else {
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref())
    };
    let requested_capabilities = if let Some(connection_id) = query.connection_id.as_deref() {
        let plan = connection_permissions::plan_access_request(
            pool.get_ref(),
            &org_id,
            connection_id,
            &requested_capabilities,
        )
        .await?;
        if plan.context.provider != "INSTAGRAM" || plan.adapter.auth_mode() != "instagram_login" {
            return Err(AppError::BadRequest(
                "This connection must be authorized through Instagram Login".to_string(),
            ));
        }
        let attempt = connection_permissions::create_authorization_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            connection_id,
            &plan.context.provider,
            plan.adapter.auth_mode(),
            "instagram",
            &plan.effective_capabilities,
        )
        .await?;
        (attempt.state, attempt.requested_capabilities)
    } else {
        (
            social::create_instagram_oauth_state(),
            requested_capabilities,
        )
    };
    let (state, requested_capabilities) = requested_capabilities;
    let authorize_url = social::build_instagram_authorize_url_for_request(
        config.get_ref(),
        &state,
        &requested_capabilities,
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::INSTAGRAM_STATE_COOKIE, state)
                .path("/")
                .http_only(true)
                .same_site(actix_web::cookie::SameSite::Lax)
                .secure(config.is_production())
                .finish(),
        )
        .finish())
}

pub async fn meta_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        if let Some(state) = query.state.as_deref() {
            if let Some(attempt) = connection_permissions::find_authorization_attempt(
                pool.get_ref(),
                &org_id,
                &user.id,
                state,
            )
            .await?
            {
                connection_permissions::finish_authorization_attempt(
                    pool.get_ref(),
                    &attempt.id,
                    "DECLINED",
                    Some("provider_denied"),
                )
                .await?;
            }
        }
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/connections?error={}",
            config.auth_url,
            urlencoding::encode(&message)
        );
        return Ok(HttpResponse::Found()
            .append_header(("Location", redirect))
            .finish());
    }

    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth code".to_string()))?;
    let returned_state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    let stored_state = req
        .cookie(social::META_STATE_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    if stored_state != returned_state {
        return Err(AppError::BadRequest("Invalid OAuth state".to_string()));
    }
    let attempt = connection_permissions::find_authorization_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        returned_state,
    )
    .await?;
    let target = attempt
        .as_ref()
        .map(|item| item.target.clone())
        .or_else(|| {
            req.cookie(social::META_TARGET_COOKIE)
                .map(|cookie| cookie.value().to_string())
        })
        .unwrap_or_else(|| "facebook".to_string());
    let (include_facebook_pages, include_instagram_accounts) = match target.as_str() {
        "facebook" => (true, false),
        "instagram" => (false, true),
        _ => {
            return Err(AppError::BadRequest(
                "Invalid Meta connection target".to_string(),
            ))
        }
    };

    let short_lived_tokens = social::exchange_meta_code_for_tokens(config.get_ref(), code).await?;
    let tokens = social::exchange_meta_for_long_lived_token(
        short_lived_tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing Meta access token".to_string()))?,
    )
    .await
    .unwrap_or(short_lived_tokens);
    let access_token = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Meta access token".to_string()))?;
    let granted_permissions = match social::fetch_meta_permissions(access_token).await {
        Ok(permissions) => Some(permissions),
        Err(error) => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "oauth.permissions.inspect",
                error_type = %std::any::type_name_of_val(&error),
                "Meta permission inspection failed; access will be shown as unknown"
            );
            None
        }
    };
    let pages = social::fetch_meta_pages(access_token).await?;
    let connected = social::upsert_meta_connections_for_org(
        pool.get_ref(),
        &user.id,
        &org_id,
        &tokens,
        &pages,
        granted_permissions.as_deref(),
        include_facebook_pages,
        include_instagram_accounts,
    )
    .await?;
    let facebook_count = connected
        .iter()
        .filter(|channel| channel.platform == "FACEBOOK")
        .count();
    let instagram_count = connected
        .iter()
        .filter(|channel| channel.platform == "INSTAGRAM")
        .count();

    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let page_app_subscription = if facebook_count > 0 {
        let result = social::subscribe_meta_page_app_webhooks(config.get_ref()).await;
        if let Err(error) = &result {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "page_app_webhooks.configure",
                error_type = %std::any::type_name_of_val(error),
                "failed to configure Page messaging webhooks"
            );
        }
        Some(result)
    } else {
        None
    };
    let instagram_app_subscription = if include_instagram_accounts && instagram_count > 0 {
        let result = social::subscribe_meta_instagram_app_webhooks(config.get_ref()).await;
        if let Err(error) = &result {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "instagram_app_webhooks.configure",
                error_type = %std::any::type_name_of_val(error),
                "failed to configure Instagram messaging webhooks"
            );
        }
        Some(result)
    } else {
        None
    };
    for page in &pages {
        let Some(page_access_token) = page.access_token.as_deref() else {
            continue;
        };
        let subscription_result =
            social::subscribe_meta_page_webhooks(page_access_token, &page.id).await;
        for channel in connected.iter().filter(|channel| {
            channel.external_account_id.as_deref() == Some(page.id.as_str())
                || channel
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("pageId"))
                    .and_then(|value| value.as_str())
                    == Some(page.id.as_str())
        }) {
            let page_app_error = page_app_subscription
                .as_ref()
                .and_then(|result| result.as_ref().err());
            let instagram_app_error = (channel.platform == "INSTAGRAM")
                .then_some(instagram_app_subscription.as_ref())
                .flatten()
                .and_then(|result| result.as_ref().err());
            let app_subscription_error = if channel.platform == "INSTAGRAM" {
                instagram_app_error
            } else {
                page_app_error
            };
            let error_message = subscription_result
                .as_ref()
                .err()
                .or(app_subscription_error)
                .map(ToString::to_string);
            let subscription_healthy =
                subscription_result.is_ok() && app_subscription_error.is_none();
            connections::record_synced_source_health(
                pool.get_ref(),
                &org_id,
                "SOCIAL",
                &channel.id,
                subscription_healthy,
                Some(if subscription_healthy {
                    "ACTIVE"
                } else {
                    "FAILED"
                }),
                error_message.as_deref(),
            )
            .await?;
        }
        if let Err(error) = subscription_result {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "meta",
                operation = "page_webhooks.subscribe",
                error_type = %std::any::type_name_of_val(&error),
                "failed to subscribe Page webhooks"
            );
        }
    }

    let redirect = format!(
        "{}/connections?connected=meta&facebook_count={}&instagram_count={}&access={}",
        config.auth_url,
        facebook_count,
        instagram_count,
        if attempt.is_some() {
            "granted"
        } else {
            "connected"
        }
    );
    if let Some(attempt) = attempt.as_ref() {
        connection_permissions::finish_authorization_attempt(
            pool.get_ref(),
            &attempt.id,
            "COMPLETED",
            None,
        )
        .await?;
    }
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(
            actix_web::cookie::Cookie::build(social::META_STATE_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .cookie(
            actix_web::cookie::Cookie::build(social::META_TARGET_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .finish())
}

pub async fn instagram_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        if let Some(state) = query.state.as_deref() {
            if let Some(attempt) = connection_permissions::find_authorization_attempt(
                pool.get_ref(),
                &org_id,
                &user.id,
                state,
            )
            .await?
            {
                connection_permissions::finish_authorization_attempt(
                    pool.get_ref(),
                    &attempt.id,
                    "DECLINED",
                    Some("provider_denied"),
                )
                .await?;
            }
        }
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/connections?error={}",
            config.auth_url,
            urlencoding::encode(&message)
        );
        return Ok(HttpResponse::Found()
            .append_header(("Location", redirect))
            .finish());
    }

    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Instagram OAuth code".to_string()))?;
    let returned_state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid Instagram OAuth state".to_string()))?;
    let stored_state = req
        .cookie(social::INSTAGRAM_STATE_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid Instagram OAuth state".to_string()))?;
    if stored_state != returned_state {
        return Err(AppError::BadRequest(
            "Invalid Instagram OAuth state".to_string(),
        ));
    }
    let attempt = connection_permissions::find_authorization_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        returned_state,
    )
    .await?;

    let short_lived = social::exchange_instagram_code_for_token(config.get_ref(), code).await?;
    let short_lived_access_token = short_lived
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Instagram access token".to_string()))?;
    let long_lived =
        social::exchange_instagram_for_long_lived_token(short_lived_access_token).await?;
    let access_token = long_lived
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Instagram access token".to_string()))?;
    let profile = social::fetch_instagram_profile(access_token).await?;
    let channel = social::upsert_instagram_connection_for_org(
        pool.get_ref(),
        &user.id,
        &org_id,
        &long_lived,
        short_lived.permissions.as_deref(),
        &profile,
    )
    .await?;

    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let account_id = channel.external_account_id.as_deref().ok_or_else(|| {
        AppError::Internal("Saved Instagram connection is missing an account ID".to_string())
    })?;
    let subscription_result = social::subscribe_instagram_webhooks(access_token, account_id).await;
    let subscription_error = subscription_result.as_ref().err().map(ToString::to_string);
    connections::record_synced_source_health(
        pool.get_ref(),
        &org_id,
        "SOCIAL",
        &channel.id,
        subscription_result.is_ok(),
        Some(if subscription_result.is_ok() {
            "ACTIVE"
        } else {
            "FAILED"
        }),
        subscription_error.as_deref(),
    )
    .await?;
    if let Err(error) = subscription_result {
        observability::tracing::warn!(
            event = "provider.call.failed",
            provider = "instagram",
            operation = "account_webhooks.subscribe",
            error_type = %std::any::type_name_of_val(&error),
            "failed to subscribe Instagram account webhooks"
        );
    }

    let redirect = format!(
        "{}/connections?connected=instagram&access={}",
        config.auth_url,
        if attempt.is_some() {
            "granted"
        } else {
            "connected"
        }
    );
    if let Some(attempt) = attempt.as_ref() {
        connection_permissions::finish_authorization_attempt(
            pool.get_ref(),
            &attempt.id,
            "COMPLETED",
            None,
        )
        .await?;
    }
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(
            actix_web::cookie::Cookie::build(social::INSTAGRAM_STATE_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .finish())
}

pub async fn linkedin_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        let _ = finish_provider_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            query.state.as_deref(),
            "LINKEDIN",
            "DECLINED",
            Some("provider_denied"),
        )
        .await?;
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/connections?error={}",
            config.auth_url,
            urlencoding::encode(&message)
        );
        return Ok(HttpResponse::Found()
            .append_header(("Location", redirect))
            .cookie(clear_oauth_cookie(social::LINKEDIN_STATE_COOKIE))
            .finish());
    }

    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth code".to_string()))?;
    let returned_state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    let stored_state = req
        .cookie(social::LINKEDIN_STATE_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    if stored_state != returned_state {
        return Err(AppError::BadRequest("Invalid OAuth state".to_string()));
    }
    let tokens = social::exchange_linkedin_code_for_tokens(config.get_ref(), code)
        .await
        .map_err(|error| {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "linkedin",
                operation = "oauth.token_exchange",
                error_type = %std::any::type_name_of_val(&error),
                "LinkedIn OAuth token exchange failed"
            );
            match error {
                AppError::BadRequest(message) => {
                    AppError::BadRequest(format!("LinkedIn token exchange failed: {message}"))
                }
                other => other,
            }
        })?;
    let access_token = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing LinkedIn access token".to_string()))?;

    let profile = social::fetch_linkedin_profile(access_token)
        .await
        .map_err(|error| {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "linkedin",
                operation = "oauth.profile_lookup",
                error_type = %std::any::type_name_of_val(&error),
                "LinkedIn OAuth profile lookup failed"
            );
            match error {
                AppError::BadRequest(message) => {
                    AppError::BadRequest(format!("LinkedIn profile lookup failed: {message}"))
                }
                other => other,
            }
        })?;
    let organization_access_requested = social::linkedin_organization_scopes_configured()
        || tokens.scope.as_deref().is_some_and(|scope| {
            scope
                .split_whitespace()
                .any(|value| matches!(value, "r_organization_admin" | "w_organization_social"))
        });
    let (pages, page_discovery_unavailable) = if organization_access_requested {
        match social::fetch_linkedin_pages(access_token).await {
            Ok(pages) => (pages, false),
            Err(error) => {
                observability::tracing::warn!(
                    event = "provider.call.failed",
                    provider = "linkedin",
                    operation = "oauth.page_discovery",
                    error_type = %std::any::type_name_of_val(&error),
                    "LinkedIn Page discovery failed; keeping the member connection"
                );
                (Vec::new(), true)
            }
        }
    } else {
        (Vec::new(), false)
    };
    let _channel = social::upsert_linkedin_connection_for_org(
        pool.get_ref(),
        &user.id,
        &org_id,
        &tokens,
        &profile,
    )
    .await?;
    let page_channels = social::upsert_linkedin_page_connections_for_org(
        pool.get_ref(),
        &user.id,
        &org_id,
        &tokens,
        &pages,
    )
    .await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let access_attempt = finish_provider_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        Some(returned_state),
        "LINKEDIN",
        "COMPLETED",
        None,
    )
    .await?;

    let redirect = format!(
        "{}/connections?connected=linkedin&pages_count={}&pages_status={}&access={}",
        config.auth_url,
        page_channels.len(),
        if page_discovery_unavailable {
            "unavailable"
        } else {
            "ready"
        },
        if access_attempt.is_some() {
            "granted"
        } else {
            "connected"
        }
    );
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(clear_oauth_cookie(social::LINKEDIN_STATE_COOKIE))
        .finish())
}

fn oauth_state_cookie(
    name: &'static str,
    value: String,
    secure: bool,
) -> actix_web::cookie::Cookie<'static> {
    actix_web::cookie::Cookie::build(name, value)
        .path("/")
        .http_only(true)
        .same_site(actix_web::cookie::SameSite::Lax)
        .secure(secure)
        .finish()
}

fn clear_oauth_cookie(name: &'static str) -> actix_web::cookie::Cookie<'static> {
    actix_web::cookie::Cookie::build(name, "")
        .path("/")
        .max_age(actix_web::cookie::time::Duration::seconds(0))
        .finish()
}

pub async fn start_threads_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ProviderAccessStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let state = social::create_threads_oauth_state();
    let requested_capabilities =
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
    let (state_value, access_attempt) = prepare_provider_access_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        &query,
        "THREADS",
        "threads",
        state,
    )
    .await?;
    let url = social::build_threads_authorize_url_for_request(
        config.get_ref(),
        &state_value,
        access_attempt
            .as_ref()
            .map(|attempt| attempt.requested_capabilities.as_slice())
            .unwrap_or(requested_capabilities.as_slice()),
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", url))
        .cookie(oauth_state_cookie(
            social::THREADS_STATE_COOKIE,
            state_value,
            config.is_production(),
        ))
        .finish())
}

pub async fn threads_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        finish_provider_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            query.state.as_deref(),
            "THREADS",
            "DECLINED",
            Some("provider_denied"),
        )
        .await?;
        let message = query.error_description.as_ref().unwrap_or(error);
        return Ok(HttpResponse::Found()
            .append_header((
                "Location",
                format!(
                    "{}/connections?error={}",
                    config.auth_url,
                    urlencoding::encode(message)
                ),
            ))
            .finish());
    }
    let state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid Threads OAuth state".to_string()))?;
    if req
        .cookie(social::THREADS_STATE_COOKIE)
        .map(|v| v.value() != state)
        .unwrap_or(true)
    {
        return Err(AppError::BadRequest(
            "Invalid Threads OAuth state".to_string(),
        ));
    }
    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Threads OAuth code".to_string()))?;
    let tokens = social::exchange_threads_code_for_token(config.get_ref(), code).await?;
    let access = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Threads access token".to_string()))?;
    let profile = social::fetch_threads_profile(access).await?;
    social::upsert_threads_connection_for_org(pool.get_ref(), &user.id, &org_id, &tokens, &profile)
        .await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let access_attempt = finish_provider_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        Some(state),
        "THREADS",
        "COMPLETED",
        None,
    )
    .await?;
    let redirect = if access_attempt.is_some() {
        format!(
            "{}/connections?connected=threads&access=granted",
            config.auth_url
        )
    } else {
        format!("{}/connections?connected=threads", config.auth_url)
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(clear_oauth_cookie(social::THREADS_STATE_COOKIE))
        .finish())
}

#[derive(serde::Deserialize)]
pub struct ThreadsSignedRequestForm {
    signed_request: String,
}

async fn sync_removed_threads_connections(pool: &PgPool, org_ids: Vec<String>) {
    for org_id in org_ids {
        if let Err(error) = connections::sync_org_connections(pool, &org_id).await {
            observability::tracing::warn!(
                event = "operation.failed",
                operation = "social_connections.sync_after_uninstall",
                provider = "threads",
                org_id = %org_id,
                error_type = %std::any::type_name_of_val(&error),
                "failed to sync connections after Threads removal"
            );
        }
    }
}

pub async fn threads_uninstall_callback(
    pool: web::Data<PgPool>,
    body: web::Form<ThreadsSignedRequestForm>,
) -> Result<HttpResponse, AppError> {
    let external_user_id = social::verify_threads_signed_request(&body.signed_request)?;
    let org_ids =
        social::remove_threads_connection_data(pool.get_ref(), &external_user_id, None).await?;
    sync_removed_threads_connections(pool.get_ref(), org_ids).await;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn threads_data_deletion_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    body: web::Form<ThreadsSignedRequestForm>,
) -> Result<HttpResponse, AppError> {
    let external_user_id = social::verify_threads_signed_request(&body.signed_request)?;
    let confirmation_code = cuid2::create_id().replace('-', "");
    let org_ids = social::remove_threads_connection_data(
        pool.get_ref(),
        &external_user_id,
        Some(&confirmation_code),
    )
    .await?;
    sync_removed_threads_connections(pool.get_ref(), org_ids).await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "url": social::threads_data_deletion_status_url(config.get_ref(), &confirmation_code),
        "confirmation_code": confirmation_code,
    })))
}

pub async fn threads_data_deletion_status(
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let confirmation_code = path.into_inner();
    if confirmation_code.len() > 128 {
        return Ok(HttpResponse::NotFound()
            .content_type("text/html; charset=utf-8")
            .body("<!doctype html><title>Deletion request not found</title><h1>Deletion request not found</h1>"));
    }
    let Some(status) =
        social::threads_data_deletion_status(pool.get_ref(), &confirmation_code).await?
    else {
        return Ok(HttpResponse::NotFound()
            .content_type("text/html; charset=utf-8")
            .body("<!doctype html><title>Deletion request not found</title><h1>Deletion request not found</h1>"));
    };
    let message = if status == "COMPLETED" {
        "Your Threads connection data has been deleted from KasiTek."
    } else {
        "Your Threads data deletion request is being processed."
    };
    Ok(HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(format!(
            "<!doctype html><title>Threads data deletion</title><h1>Threads data deletion</h1><p>{message}</p>"
        )))
}

pub async fn receive_tiktok_webhook(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Bytes,
) -> Result<HttpResponse, AppError> {
    let signature = req
        .headers()
        .get("TikTok-Signature")
        .and_then(|value| value.to_str().ok());
    social::verify_tiktok_webhook_signature(signature, &body)?;
    let payload = social::parse_tiktok_webhook_envelope(&body)?;
    let inserted = social::record_tiktok_webhook_event(pool.get_ref(), &payload, &body).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "received": true,
        "duplicate": !inserted,
    })))
}

pub async fn start_tiktok_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ProviderAccessStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let state = social::create_tiktok_oauth_state();
    let requested_capabilities =
        connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
    let (state_value, access_attempt) = prepare_provider_access_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        &query,
        "TIKTOK",
        "tiktok",
        state,
    )
    .await?;
    let url = social::build_tiktok_authorize_url_for_request(
        config.get_ref(),
        &state_value,
        access_attempt
            .as_ref()
            .map(|attempt| attempt.requested_capabilities.as_slice())
            .unwrap_or(requested_capabilities.as_slice()),
    )?;
    Ok(HttpResponse::Found()
        .append_header(("Location", url))
        .cookie(oauth_state_cookie(
            social::TIKTOK_STATE_COOKIE,
            state_value,
            config.is_production(),
        ))
        .finish())
}

pub async fn tiktok_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    if let Some(error) = query.error.as_ref() {
        finish_provider_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            query.state.as_deref(),
            "TIKTOK",
            "DECLINED",
            Some("provider_denied"),
        )
        .await?;
        let message = query.error_description.as_ref().unwrap_or(error);
        return Ok(HttpResponse::Found()
            .append_header((
                "Location",
                format!(
                    "{}/connections?error={}",
                    config.auth_url,
                    urlencoding::encode(message)
                ),
            ))
            .finish());
    }
    let state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Invalid TikTok OAuth state".to_string()))?;
    if req
        .cookie(social::TIKTOK_STATE_COOKIE)
        .map(|v| v.value() != state)
        .unwrap_or(true)
    {
        return Err(AppError::BadRequest(
            "Invalid TikTok OAuth state".to_string(),
        ));
    }
    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing TikTok OAuth code".to_string()))?;
    let tokens = social::exchange_tiktok_code_for_tokens(config.get_ref(), code).await?;
    let access = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing TikTok access token".to_string()))?;
    let profile = social::fetch_tiktok_profile(access).await?;
    social::upsert_tiktok_connection_for_org(pool.get_ref(), &user.id, &org_id, &tokens, &profile)
        .await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let access_attempt = finish_provider_attempt(
        pool.get_ref(),
        &org_id,
        &user.id,
        Some(state),
        "TIKTOK",
        "COMPLETED",
        None,
    )
    .await?;
    let redirect = if access_attempt.is_some() {
        format!(
            "{}/connections?connected=tiktok&access=granted",
            config.auth_url
        )
    } else {
        format!("{}/connections?connected=tiktok", config.auth_url)
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(clear_oauth_cookie(social::TIKTOK_STATE_COOKIE))
        .finish())
}

pub async fn bluesky_client_metadata(
    config: web::Data<AppConfig>,
) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .json(bluesky_oauth::client_metadata(config.get_ref())?))
}

pub async fn bluesky_oauth_readiness(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    bluesky_oauth::verify_public_client_metadata(config.get_ref()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "ready": true,
        "clientMetadataUrl": bluesky_oauth::client_id(config.get_ref()),
        "callbackUrl": bluesky_oauth::callback_url(config.get_ref()),
    })))
}

pub async fn start_bluesky_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::BlueskyOAuthStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_social_connection_admin(pool.get_ref(), &req, &user.id).await?;
    let handle = query
        .handle
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Bluesky handle is required".to_string()))?;
    let url = if query.connection_id.is_some() {
        let state = bluesky_oauth::create_authorization_state();
        let requested_capabilities =
            connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
        let access_query = ProviderAccessStartQuery {
            connection_id: query.connection_id.clone(),
            capabilities: query.capabilities.clone(),
        };
        let (state, attempt) = prepare_provider_access_attempt(
            pool.get_ref(),
            &org_id,
            &user.id,
            &access_query,
            "BLUESKY",
            "bluesky",
            state,
        )
        .await?;
        let effective_capabilities = attempt
            .as_ref()
            .map(|item| item.requested_capabilities.as_slice())
            .unwrap_or(requested_capabilities.as_slice());
        let url = bluesky_oauth::start_with_state(
            pool.get_ref(),
            config.get_ref(),
            &user.id,
            &org_id,
            handle,
            Some(&state),
            effective_capabilities,
        )
        .await?;
        url
    } else {
        let requested_capabilities =
            connection_permissions::normalize_requested_capabilities(query.capabilities.as_deref());
        let url = bluesky_oauth::start_with_state(
            pool.get_ref(),
            config.get_ref(),
            &user.id,
            &org_id,
            handle,
            None,
            &requested_capabilities,
        )
        .await?;
        url
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", url))
        .finish())
}

pub async fn bluesky_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    if let Some(error) = query.error.as_deref() {
        return Err(AppError::BadRequest(
            query
                .error_description
                .clone()
                .unwrap_or_else(|| format!("Bluesky authorization failed: {error}")),
        ));
    }
    let state = query
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Bluesky OAuth state".to_string()))?;
    let code = query
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Bluesky OAuth code".to_string()))?;
    let issuer = query
        .iss
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Bluesky OAuth issuer".to_string()))?;
    let authorization =
        bluesky_oauth::complete(pool.get_ref(), config.get_ref(), state, code, issuer).await?;
    let org_id = authorization.org_id.clone();
    social::upsert_bluesky_oauth_connection_for_org(pool.get_ref(), &authorization).await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let access_attempt = connection_permissions::find_authorization_attempt(
        pool.get_ref(),
        &org_id,
        &authorization.user_id,
        state,
    )
    .await?;
    if let Some(attempt) = access_attempt.as_ref() {
        if !attempt.provider.eq_ignore_ascii_case("BLUESKY") {
            return Err(AppError::BadRequest(
                "OAuth state does not match the requested provider".to_string(),
            ));
        }
        connection_permissions::finish_authorization_attempt(
            pool.get_ref(),
            &attempt.id,
            "COMPLETED",
            None,
        )
        .await?;
    }
    let redirect = if access_attempt.is_some() {
        format!(
            "{}/connections?connected=bluesky&access=granted",
            config.auth_url
        )
    } else {
        format!("{}/connections?connected=bluesky", config.auth_url)
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .finish())
}

#[cfg(test)]
mod tests {
    use super::has_unknown_publish_outcome;
    use serde_json::json;

    #[test]
    fn unknown_provider_results_are_distinguished_from_retryable_failures() {
        assert!(has_unknown_publish_outcome(Some(&json!({
            "_kasitek_outcome": "UNKNOWN"
        }))));
        assert!(!has_unknown_publish_outcome(Some(&json!({
            "_kasitek_outcome": "FAILED"
        }))));
        assert!(!has_unknown_publish_outcome(None));
    }
}
