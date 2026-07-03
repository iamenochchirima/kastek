use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    SocialChannelCreateRequest, SocialChannelUpdateRequest, SocialPostUpsertRequest,
    SocialPublishJobActionRequest, SocialPublishRequest,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::social;

pub async fn list_channels(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let channels = social::list_social_channels(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "channels": channels })))
}

pub async fn create_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialChannelCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
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

pub async fn update_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialChannelUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let existing = social::get_social_channel(pool.get_ref(), &user.id, &path).await?;
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
        &user.id,
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

pub async fn delete_channel(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let deleted = social::delete_social_channel(pool.get_ref(), &user.id, &path).await?;
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
    let posts = social::list_social_posts(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "posts": posts })))
}

pub async fn create_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let post = social::create_social_post(pool.get_ref(), &user.id, &body).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "post": post })))
}

pub async fn get_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let post = social::get_social_post(pool.get_ref(), &user.id, &path)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn update_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let post = social::update_social_post(pool.get_ref(), &user.id, &path, &body).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn delete_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let deleted = social::delete_social_post(pool.get_ref(), &user.id, &path).await?;
    if !deleted {
        return Err(AppError::NotFound("Post not found".to_string()));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn publish_post(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPublishRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let requested_platform = body.platform.as_deref().unwrap_or("X");
    if requested_platform != "X"
        && requested_platform != "LINKEDIN"
        && requested_platform != "FACEBOOK"
    {
        return Err(AppError::BadRequest(format!(
            "Manual publishing is not available yet for {}",
            requested_platform
        )));
    }
    let post = social::get_social_post(pool.get_ref(), &user.id, &path)
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
    let refreshed_post = social::get_social_post(pool.get_ref(), &user.id, &path).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "post": refreshed_post,
        "result": result
    })))
}

pub async fn update_publish_job(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPublishJobActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let action = body
        .action
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Action is required".to_string()))?;
    let job_id = path.into_inner();

    let job = sqlx::query_as::<_, crate::db::models::SocialPublishJobRow>(
        r#"
        SELECT id, "userId" AS user_id, "postId" AS post_id, "variantId" AS variant_id,
               "channelConnectionId" AS channel_connection_id, platform::text AS platform,
               status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
               "externalPostId" AS external_post_id, "errorMessage" AS error_message,
               metadata, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialPublishJob"
        WHERE id = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(&job_id)
    .bind(&user.id)
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
            sqlx::query(
                r#"
                UPDATE "SocialPublishJob"
                SET status = 'QUEUED'::"SocialPublishJobStatus", "errorMessage" = NULL,
                    "scheduledFor" = NOW(), "updatedAt" = NOW()
                WHERE id = $1
                "#,
            )
            .bind(&job_id)
            .execute(pool.get_ref())
            .await?;
        }
        "run_now" => {
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

    let post = social::get_social_post(pool.get_ref(), &user.id, &job.post_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "post": post })))
}

pub async fn start_x_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let _user = extract_user(&req, pool.get_ref()).await?;
    let state = social::create_x_oauth_state();
    let authorize_url =
        social::build_x_authorize_url(config.get_ref(), &state.state, &state.challenge)?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::X_STATE_COOKIE, state.state)
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
    if let Some(error) = query.error.as_ref() {
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/social/channels?error={}",
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
        social::upsert_x_connection_for_user(pool.get_ref(), &user.id, &tokens, &profile).await?;

    let redirect = format!("{}/social/channels?connected=x", config.auth_url);
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
) -> Result<HttpResponse, AppError> {
    let _user = extract_user(&req, pool.get_ref()).await?;
    let state = social::create_linkedin_oauth_state();
    let authorize_url = social::build_linkedin_authorize_url(config.get_ref(), &state)?;
    Ok(HttpResponse::Found()
        .append_header(("Location", authorize_url))
        .cookie(
            actix_web::cookie::Cookie::build(social::LINKEDIN_STATE_COOKIE, state)
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
) -> Result<HttpResponse, AppError> {
    let _user = extract_user(&req, pool.get_ref()).await?;
    let state = social::create_meta_oauth_state();
    let authorize_url = social::build_meta_authorize_url(config.get_ref(), &state)?;
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
        .finish())
}

pub async fn meta_oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<social::OAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    if let Some(error) = query.error.as_ref() {
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/social/channels?error={}",
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

    let short_lived_tokens = social::exchange_meta_code_for_tokens(config.get_ref(), code).await?;
    let tokens = social::exchange_meta_for_long_lived_token(
        short_lived_tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing Meta access token".to_string()))?,
    )
    .await
    .unwrap_or(short_lived_tokens);
    let pages = social::fetch_meta_pages(
        tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing Meta access token".to_string()))?,
    )
    .await?;
    let connected =
        social::upsert_meta_connections_for_user(pool.get_ref(), &user.id, &tokens, &pages).await?;

    let redirect = format!(
        "{}/social/channels?connected=meta&count={}",
        config.auth_url,
        connected.len()
    );
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(
            actix_web::cookie::Cookie::build(social::META_STATE_COOKIE, "")
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
    if let Some(error) = query.error.as_ref() {
        let message = query
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        let redirect = format!(
            "{}/social/channels?error={}",
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
        .cookie(social::LINKEDIN_STATE_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Invalid OAuth state".to_string()))?;
    if stored_state != returned_state {
        return Err(AppError::BadRequest("Invalid OAuth state".to_string()));
    }

    let tokens = social::exchange_linkedin_code_for_tokens(config.get_ref(), code).await?;
    let profile = social::fetch_linkedin_profile(
        tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing LinkedIn access token".to_string()))?,
    )
    .await?;
    let _channel =
        social::upsert_linkedin_connection_for_user(pool.get_ref(), &user.id, &tokens, &profile)
            .await?;

    let redirect = format!("{}/social/channels?connected=linkedin", config.auth_url);
    Ok(HttpResponse::Found()
        .append_header(("Location", redirect))
        .cookie(
            actix_web::cookie::Cookie::build(social::LINKEDIN_STATE_COOKIE, "")
                .path("/")
                .max_age(actix_web::cookie::time::Duration::seconds(0))
                .finish(),
        )
        .finish())
}
