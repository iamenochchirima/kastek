use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::Value;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    BotActionRequest, BotCreateRequest, BotDeploymentCallbackRequest, BotEventCreateRequest,
};
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{billing, bots};

async fn require_agents_access(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: &str,
) -> Result<String, AppError> {
    let org_id = resolve_active_org_id(req, pool, user_id).await?;
    billing::require_product_access(pool, &org_id, "agents")
        .await
        .map(|()| org_id)
}

pub async fn create(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<BotCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_agents_access(pool.get_ref(), &req, &user.id).await?;
    let input = body.into_inner();
    let auto_provision = bots::should_auto_provision(&input);
    let bot = bots::create_bot(pool.get_ref(), &user.id, &org_id, input).await?;

    if auto_provision {
        match bots::execute_bot_action(
            pool.get_ref(),
            config.get_ref(),
            &user.id,
            &org_id,
            &bot.id,
            BotActionRequest {
                action: Some("provision".to_string()),
            },
        )
        .await
        {
            Ok(provisioned_bot) => {
                return Ok(HttpResponse::Created()
                    .json(serde_json::json!({ "bot": bot, "provisionedBot": provisioned_bot })));
            }
            Err(error) => {
                log::warn!(
                    "automatic provisioning failed after bot creation for user_id={} bot_id={}: {}",
                    user.id,
                    bot.id,
                    error
                );
                return Ok(HttpResponse::Created().json(serde_json::json!({
                    "bot": bot,
                    "provisioningError": error.to_string(),
                })));
            }
        }
    }

    Ok(HttpResponse::Created().json(serde_json::json!({ "bot": bot })))
}

pub async fn list(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let bots = bots::list_bots(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bots": bots })))
}

pub async fn activity(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(bots::list_agent_activity(pool.get_ref(), &org_id).await?))
}

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let bot = bots::get_bot(pool.get_ref(), &org_id, &path)
        .await?
        .ok_or_else(|| AppError::NotFound("Bot not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bot": bot })))
}

pub async fn patch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_agents_access(pool.get_ref(), &req, &user.id).await?;
    let bot = bots::update_bot(pool.get_ref(), &org_id, &path, body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bot": bot })))
}

pub async fn delete(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_agents_access(pool.get_ref(), &req, &user.id).await?;
    bots::delete_bot(pool.get_ref(), &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn create_event(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BotEventCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_agents_access(pool.get_ref(), &req, &user.id).await?;
    bots::record_bot_event(pool.get_ref(), &user.id, &org_id, &path, body.into_inner()).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "success": true })))
}

pub async fn action(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BotActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = require_agents_access(pool.get_ref(), &req, &user.id).await?;
    let bot = bots::execute_bot_action(
        pool.get_ref(),
        config.get_ref(),
        &user.id,
        &org_id,
        &path,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bot": bot })))
}

pub async fn deployment_callback(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<BotDeploymentCallbackRequest>,
) -> Result<HttpResponse, AppError> {
    let expected_token = config
        .n8n_callback_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;

    let authorized = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .map(|token| token == expected_token)
        .unwrap_or(false);

    if !authorized {
        return Err(AppError::Unauthorized);
    }

    let (bot_id, deployment_id) = path.into_inner();
    bots::apply_deployment_callback(pool.get_ref(), &bot_id, &deployment_id, body.into_inner())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn create_event_trusted(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BotEventCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let expected_token = config
        .n8n_callback_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;

    let authorized = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .map(|token| token == expected_token)
        .unwrap_or(false);

    if !authorized {
        return Err(AppError::Unauthorized);
    }

    bots::record_bot_event_trusted(pool.get_ref(), &path, body.into_inner()).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "success": true })))
}
