use actix_web::{web, HttpRequest, HttpResponse};
use bytes::Bytes;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::WhatsappSendMessageRequest;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::inbox;

pub async fn list_conversations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let result = inbox::list_inbox_conversations(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_messages(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let result = inbox::list_conversation_messages(pool.get_ref(), &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn send_message(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappSendMessageRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let result = inbox::send_conversation_message(
        pool.get_ref(),
        &user.id,
        &org_id,
        &path,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn mark_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let result = inbox::mark_conversation_read(pool.get_ref(), &user.id, &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn verify_meta_webhook(
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let challenge = inbox::verify_meta_webhook_request(&query)?;
    Ok(HttpResponse::Ok().body(challenge))
}

pub async fn receive_meta_webhook(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: Bytes,
) -> Result<HttpResponse, AppError> {
    let signature = req
        .headers()
        .get("X-Hub-Signature-256")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    inbox::verify_meta_webhook_signature(signature.as_deref(), &body)?;

    let payload: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("Invalid Meta webhook payload".to_string()))?;

    inbox::process_meta_webhook_payload(pool.get_ref(), config.get_ref(), payload).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}
