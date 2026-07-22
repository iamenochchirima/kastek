use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::VoiceConnectionCreateRequest;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::calls;

pub async fn list_calls(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let calls = calls::list_calls(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "calls": calls })))
}

pub async fn call_summary(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let days = query
        .get("days")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(7);
    Ok(HttpResponse::Ok().json(calls::call_summary(pool.get_ref(), &org_id, days).await?))
}

pub async fn provider_status(
    config: web::Data<crate::config::AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    extract_user(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(calls::provider_status(config.get_ref())))
}

pub async fn create_twilio_connection(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<VoiceConnectionCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let connection = calls::create_twilio_connection(pool.get_ref(), &org_id, &body).await?;
    Ok(HttpResponse::Created().json(connection))
}
