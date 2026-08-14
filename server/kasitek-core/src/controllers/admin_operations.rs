//! Platform-operator read boundary for Agent operations.
//!
//! The admin browser only talks to these core routes. Core authenticates the
//! admin session, applies the operator role policy, and then uses a short-lived
//! operator-scoped service token to read safe projections from Agents.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::agent_platform::AgentPlatformClient;

async fn operator(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = extract_admin(req, pool).await?;
    require_admin_role(
        &admin,
        &[
            "viewer",
            "support",
            "operator",
            "security",
            "admin",
            "superadmin",
            "owner",
        ],
    )?;
    Ok(admin)
}

pub async fn summary(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_summary(&admin.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

#[derive(Debug, Deserialize)]
pub struct LimitQuery {
    pub limit: Option<u32>,
}

pub async fn runs(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<LimitQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator run limit must be between 1 and 500".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_runs(&admin.id, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn health(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_health(&admin.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn effects(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<LimitQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator reconciliation limit must be between 1 and 500".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_effects_reconciliation(&admin.id, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub action: Option<String>,
    #[serde(rename = "resourceType")]
    pub resource_type: Option<String>,
    pub limit: Option<u32>,
}

pub async fn audit(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AuditQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator audit limit must be between 1 and 500".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_audit(
            &admin.id,
            query.action.as_deref(),
            query.resource_type.as_deref(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<u32>,
}

pub async fn search(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<SearchQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    let value = query.q.trim();
    if value.len() < 2 || value.len() > 160 {
        return Err(AppError::BadRequest(
            "Operator search requires 2-160 characters".to_string(),
        ));
    }
    if query.limit.is_some_and(|limit| !(1..=200).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator search limit must be between 1 and 200".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_search(&admin.id, value, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}
