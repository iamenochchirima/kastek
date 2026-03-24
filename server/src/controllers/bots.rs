use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::Value;
use sqlx::PgPool;

use crate::db::models::BotCreateRequest;
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::bots;

pub async fn create(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<BotCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let bot = bots::create_bot(pool.get_ref(), &user.id, body.into_inner()).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "bot": bot })))
}

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let bot = bots::get_bot(pool.get_ref(), &user.id, &path)
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
    let bot = bots::update_bot(pool.get_ref(), &user.id, &path, body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bot": bot })))
}

pub async fn delete(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    bots::delete_bot(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}
