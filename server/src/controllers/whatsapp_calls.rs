use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::db::models::{
    WhatsappCallActionRequest, WhatsappCallBridgeEventRequest, WhatsappCallSignalRequest,
    WhatsappCallTestCreateRequest,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::{whatsapp_call_bridge, whatsapp_calls};

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
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp_calls::get_call_media_session(pool.get_ref(), config.get_ref(), &user.id, &path)
            .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_bridge_contract(
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, AppError> {
    let _user = extract_user(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(whatsapp_call_bridge::bridge_contract(config.get_ref())))
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
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCallActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp_calls::apply_call_action(pool.get_ref(), config.get_ref(), &user.id, &path, &body)
            .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn post_call_signal(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCallSignalRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp_calls::post_call_signal(pool.get_ref(), config.get_ref(), &user.id, &path, &body)
            .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn create_test_call(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappCallTestCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::create_test_call(pool.get_ref(), &user.id, &body).await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn receive_bridge_event(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    body: web::Json<WhatsappCallBridgeEventRequest>,
) -> Result<HttpResponse, AppError> {
    let provided = req
        .headers()
        .get("x-kasitek-call-bridge-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let expected = config
        .whatsapp_call_bridge_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;

    if provided != Some(expected) {
        return Err(AppError::Unauthorized);
    }

    let result = whatsapp_call_bridge::ingest_bridge_event(pool.get_ref(), &body).await?;
    Ok(HttpResponse::Ok().json(result))
}
