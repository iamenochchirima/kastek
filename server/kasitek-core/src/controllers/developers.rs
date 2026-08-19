use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{developer_api_keys, orgs};

#[derive(Debug, Deserialize)]
pub struct CreateDeveloperApiKeyRequest {
    pub name: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
}

async fn workspace_admin(
    pool: &PgPool,
    req: &HttpRequest,
) -> Result<(String, String), AppError> {
    let user = extract_user(req, pool).await?;
    let organization_id = resolve_active_org_id(req, pool, &user.id).await?;
    orgs::require_admin(pool, &organization_id, &user.id).await?;
    Ok((organization_id, user.id))
}

fn mcp_endpoint(config: &AppConfig) -> String {
    if let Ok(value) = std::env::var("KASITEK_MCP_PUBLIC_URL") {
        let value = value.trim().trim_end_matches('/');
        if !value.is_empty() {
            return if value.ends_with("/mcp") {
                value.to_string()
            } else {
                format!("{value}/mcp")
            };
        }
    }
    if config.is_production() {
        "https://agents.kasitek.co.za/mcp".to_string()
    } else {
        "http://127.0.0.1:4200/mcp".to_string()
    }
}

pub async fn bootstrap(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) = workspace_admin(pool.get_ref(), &req).await?;
    let keys = developer_api_keys::list(pool.get_ref(), &organization_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "apiKeys": keys,
        "config": {
            "restBaseUrl": format!("{}/v1", config.public_api_url.trim_end_matches('/')),
            "mcpEndpoint": mcp_endpoint(config.get_ref()),
            "mcpPackage": "@kasitek/mcp",
            "clients": [
                { "id": "claude", "label": "Claude" },
                { "id": "chatgpt", "label": "ChatGPT" },
                { "id": "claude-code", "label": "Claude Code" },
                { "id": "cursor", "label": "Cursor" },
                { "id": "other", "label": "Other MCP client" }
            ]
        }
    })))
}

pub async fn create_api_key(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateDeveloperApiKeyRequest>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, user_id) = workspace_admin(pool.get_ref(), &req).await?;
    let created = developer_api_keys::create(
        pool.get_ref(),
        &organization_id,
        &user_id,
        &body.name,
        body.expires_at,
    )
    .await?;
    Ok(HttpResponse::Created().json(created))
}

pub async fn revoke_api_key(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) = workspace_admin(pool.get_ref(), &req).await?;
    developer_api_keys::revoke(pool.get_ref(), &organization_id, &path).await?;
    Ok(HttpResponse::NoContent().finish())
}

pub async fn rotate_api_key(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, user_id) = workspace_admin(pool.get_ref(), &req).await?;
    let created = developer_api_keys::rotate(
        pool.get_ref(),
        &organization_id,
        &user_id,
        &path,
    )
    .await?;
    Ok(HttpResponse::Created().json(created))
}
