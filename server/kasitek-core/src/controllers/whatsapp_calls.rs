use actix_web::{http::StatusCode, web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::db::models::{
    WhatsappCallActionRequest, WhatsappCallBridgeEventRequest, WhatsappCallSignalRequest,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::{whatsapp_call_bridge, whatsapp_calls};

#[derive(Deserialize)]
pub struct WhatsappCallSummaryQuery {
    pub days: Option<i64>,
}

fn calls_service_base_url(config: &crate::config::AppConfig) -> Option<&str> {
    config
        .kasitek_calls_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

async fn proxy_to_calls_service(
    config: &crate::config::AppConfig,
    req: &HttpRequest,
    payload: Option<Value>,
) -> Result<HttpResponse, AppError> {
    let base_url = calls_service_base_url(config)
        .ok_or_else(|| AppError::Internal("KASITEK_CALLS_URL is not configured".to_string()))?;
    let path = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| req.uri().path());
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .map_err(|error| AppError::Internal(format!("Invalid proxied method: {error}")))?;
    let mut request = client.request(method, url);

    for header_name in ["authorization", "cookie", "x-kasitek-call-bridge-token"] {
        if let Some(value) = req.headers().get(header_name) {
            if let Ok(value) = value.to_str() {
                request = request.header(header_name, value);
            }
        }
    }

    if let Some(body) = payload {
        request = request.json(&body);
    }

    let response = request.send().await?;
    let status = StatusCode::from_u16(response.status().as_u16())
        .map_err(|_| AppError::Internal("Invalid proxied response status".to_string()))?;
    let body = response.bytes().await?;
    Ok(HttpResponse::build(status)
        .content_type("application/json")
        .body(body))
}

fn to_json_value<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|error| AppError::Internal(format!("Failed to encode proxied payload: {error}")))
}

pub async fn list_calls(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::list_calls(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_call(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
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
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
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
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
    let _user = extract_user(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(whatsapp_call_bridge::bridge_contract(config.get_ref())))
}

pub async fn list_call_signals(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp_calls::list_call_signals(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn call_summary(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    query: web::Query<WhatsappCallSummaryQuery>,
) -> Result<HttpResponse, AppError> {
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, None).await;
    }
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
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, Some(to_json_value(&body.into_inner())?))
            .await;
    }
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
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, Some(to_json_value(&body.into_inner())?))
            .await;
    }
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp_calls::post_call_signal(pool.get_ref(), config.get_ref(), &user.id, &path, &body)
            .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn receive_bridge_event(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    body: web::Json<WhatsappCallBridgeEventRequest>,
) -> Result<HttpResponse, AppError> {
    if calls_service_base_url(config.get_ref()).is_some() {
        return proxy_to_calls_service(config.get_ref(), &req, Some(to_json_value(&body.into_inner())?))
            .await;
    }
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
