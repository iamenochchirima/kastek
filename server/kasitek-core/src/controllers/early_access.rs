//! Transport handlers for the public early-access status and admin lifecycle.

use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_admin, extract_user, require_admin_role, resolve_active_org_id};
use crate::services::early_access::{self, ApplicationQuery, ApproveRequest, RejectRequest};

pub async fn status(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "earlyAccess": early_access::status_for_org(pool.get_ref(), &org_id).await?,
    })))
}

async fn admin_context(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = extract_admin(req, pool).await?;
    require_admin_role(&admin, &["superadmin", "admin"])?;
    Ok(admin)
}

pub async fn list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ApplicationQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = admin_context(&req, pool.get_ref()).await?;
    let applications = early_access::list_applications(pool.get_ref(), &query).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "applications": applications })))
}

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = admin_context(&req, pool.get_ref()).await?;
    let (application, events) = early_access::get_application(pool.get_ref(), &path).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "application": application,
        "events": events,
    })))
}

pub async fn approval_context(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = admin_context(&req, pool.get_ref()).await?;
    let context = early_access::approval_context(pool.get_ref(), &path).await?;
    Ok(HttpResponse::Ok().json(context))
}

pub async fn reject(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<RejectRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = admin_context(&req, pool.get_ref()).await?;
    let application =
        early_access::reject_application(pool.get_ref(), &path, &admin.id, body.into_inner())
            .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "application": application })))
}

pub async fn approve(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ApproveRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = admin_context(&req, pool.get_ref()).await?;
    let application = early_access::approve_application(
        pool.get_ref(),
        config.get_ref(),
        &path,
        &admin.id,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "application": application })))
}

pub async fn resend(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = admin_context(&req, pool.get_ref()).await?;
    let application =
        early_access::resend_invitation(pool.get_ref(), config.get_ref(), &path, &admin.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "application": application })))
}

pub async fn restore(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<serde_json::Value>,
) -> Result<HttpResponse, AppError> {
    let admin = admin_context(&req, pool.get_ref()).await?;
    let reason = body
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let application = early_access::restore_application(
        pool.get_ref(),
        config.get_ref(),
        &path,
        &admin.id,
        reason,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "application": application })))
}

pub async fn revoke(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<serde_json::Value>,
) -> Result<HttpResponse, AppError> {
    let admin = admin_context(&req, pool.get_ref()).await?;
    let reason = body
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let application =
        early_access::revoke_application(pool.get_ref(), &path, &admin.id, reason).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "application": application })))
}
