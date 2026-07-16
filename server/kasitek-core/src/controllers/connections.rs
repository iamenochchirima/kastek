use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::ExternalConnectionStatusRequest;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{connections, orgs};

pub async fn list(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let items = connections::list_connections(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "connections": items })))
}

pub async fn update_status(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ExternalConnectionStatusRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let status = body
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Status is required".to_string()))?;
    let connection = connections::update_status(pool.get_ref(), &org_id, &path, status).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "connection": connection })))
}
