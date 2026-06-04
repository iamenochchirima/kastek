use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{WhatsappCallActionRequest, WhatsappCallSignalRequest};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::whatsapp_calls;

#[derive(Deserialize)]
pub struct WhatsappCallSummaryQuery {
    pub days: Option<i64>,
}

pub async fn list_calls(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::list_calls(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_call(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::get_call(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_call_media_session(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::get_call_media_session(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_call_signals(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::list_call_signals(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn call_summary(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<WhatsappCallSummaryQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp_calls::call_summary(pool.get_ref(), &user.id, query.days.unwrap_or(7)).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn apply_call_action(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCallActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::apply_call_action(pool.get_ref(), &user.id, &path, &body).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn post_call_signal(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCallSignalRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::post_call_signal(pool.get_ref(), &user.id, &path, &body).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn receive_provider_call_webhook(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    whatsapp_calls::ingest_webhook_calls(pool.get_ref(), config.get_ref(), &body).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "success": true
    })))
}
