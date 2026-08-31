use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::ExternalConnectionStatusRequest;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{connection_permissions, connections, orgs};

#[derive(Debug, Deserialize)]
pub struct AccessRequestQuery {
    pub capabilities: Option<String>,
}

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

pub async fn access(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let snapshot =
        connection_permissions::get_access_snapshot(pool.get_ref(), &org_id, &path).await?;
    Ok(HttpResponse::Ok().json(snapshot))
}

pub async fn request_access(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<AccessRequestQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    connections::sync_org_connections(pool.get_ref(), &org_id).await?;
    let capabilities =
        connection_permissions::parse_requested_capabilities(query.capabilities.as_deref())?;
    let plan =
        connection_permissions::plan_access_request(pool.get_ref(), &org_id, &path, &capabilities)
            .await?;
    let connection_id = urlencoding::encode(&plan.context.id);
    let requested_capabilities = capabilities.join(",");
    let requested = urlencoding::encode(&requested_capabilities);
    let provider = plan.context.provider.to_ascii_uppercase();
    let location = match provider.as_str() {
        "FACEBOOK" => format!(
            "/api/social/oauth/meta/start?target=facebook&connectionId={connection_id}&capabilities={requested}"
        ),
        "INSTAGRAM" if plan.adapter.auth_mode() == "instagram_login" => format!(
            "/api/social/oauth/instagram/start?connectionId={connection_id}&capabilities={requested}"
        ),
        "INSTAGRAM" => format!(
            "/api/social/oauth/meta/start?target=instagram&connectionId={connection_id}&capabilities={requested}"
        ),
        "THREADS" => format!(
            "/api/social/oauth/threads/start?connectionId={connection_id}&capabilities={requested}"
        ),
        "TIKTOK" => format!(
            "/api/social/oauth/tiktok/start?connectionId={connection_id}&capabilities={requested}"
        ),
        "LINKEDIN" => format!(
            "/api/social/oauth/linkedin/start?connectionId={connection_id}&capabilities={requested}"
        ),
        "X" => format!(
            "/api/social/oauth/x/start?connectionId={connection_id}&capabilities={requested}"
        ),
        "BLUESKY" => {
            let handle = plan.context.handle.as_deref().ok_or_else(|| {
                AppError::BadRequest("This Bluesky connection has no login handle".to_string())
            })?;
            format!(
                "/api/social/oauth/bluesky/start?handle={}&connectionId={connection_id}&capabilities={requested}",
                urlencoding::encode(handle)
            )
        }
        "WHATSAPP" => format!(
            "{}/connections?access=required&provider=whatsapp&connectionId={connection_id}&capabilities={requested}",
            config.auth_url.trim_end_matches('/')
        ),
        _ => {
            return Err(AppError::BadRequest(
                "Access requests are not available for this provider yet".to_string(),
            ))
        }
    };
    Ok(HttpResponse::Found()
        .append_header(("Location", location))
        .finish())
}
