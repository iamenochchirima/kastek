//! Platform-operator read boundary for Agent operations.
//!
//! The admin browser only talks to these core routes. Core authenticates the
//! admin session, applies the operator role policy, and then uses a short-lived
//! operator-scoped service token to read safe projections from Agents.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::identity::admin_session::{
    can_execute_operator_command, can_manage_support_access, can_view_support_access,
};
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::admin_policy::can_use_emergency_access;
use crate::services::admin_support_access::{self, CreateSupportAccessRequest};
use crate::services::admin_webhook_replay::{self, CreateReplayRequest};
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

async fn command_operator(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = operator(req, pool).await?;
    if !can_execute_operator_command(&admin.role) {
        return Err(AppError::Forbidden(
            "Operator command permission is required".to_string(),
        ));
    }
    Ok(admin)
}

async fn support_viewer(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = operator(req, pool).await?;
    if !can_view_support_access(&admin.role) {
        return Err(AppError::Forbidden(
            "Support access visibility permission is required".to_string(),
        ));
    }
    Ok(admin)
}

async fn support_manager(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = operator(req, pool).await?;
    if !can_manage_support_access(&admin.role) {
        return Err(AppError::Forbidden(
            "Support access management permission is required".to_string(),
        ));
    }
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

pub async fn exports(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<LimitQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator export limit must be between 1 and 500".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_exports(&admin.id, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn kill_switches(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<LimitQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Operator kill-switch limit must be between 1 and 500".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_kill_switches(&admin.id, query.limit)
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

pub async fn create_command(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let admin = command_operator(&req, pool.get_ref()).await?;
    let idempotency_key = req
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.len() >= 8 && value.len() <= 240)
        .ok_or_else(|| {
            AppError::BadRequest("idempotency-key must be 8-240 characters".to_string())
        })?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Operator command body must be an object".to_string(),
        ));
    }
    let emergency_global_kill_switch = body
        .get("commandType")
        .and_then(Value::as_str)
        .is_some_and(|command_type| command_type == "kill_switch_enable")
        && body
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("scopeType"))
            .and_then(Value::as_str)
            .is_some_and(|scope_type| scope_type == "global");
    if emergency_global_kill_switch && !can_use_emergency_access(&admin.role) {
        return Err(AppError::Forbidden(
            "Global kill-switch commands require emergency owner access".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_create_command(&admin.id, idempotency_key, body.into_inner())
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn get_command(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    command_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_get_command(&admin.id, command_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn approve_command(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    command_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = command_operator(&req, pool.get_ref()).await?;
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_approve_command(&admin.id, command_id.trim())
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn webhook_deliveries(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<LimitQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = operator(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=100).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Webhook delivery limit must be between 1 and 100".to_string(),
        ));
    }
    let deliveries = admin_webhook_replay::list_failed_deliveries(
        pool.get_ref(),
        query.limit.unwrap_or(50) as i64,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deliveries": deliveries })))
}

pub async fn create_webhook_replay(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateReplayRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = command_operator(&req, pool.get_ref()).await?;
    let idempotency_key = req
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.len() >= 8 && value.len() <= 240)
        .ok_or_else(|| {
            AppError::BadRequest("idempotency-key must be 8-240 characters".to_string())
        })?;
    let command = admin_webhook_replay::create(
        pool.get_ref(),
        &admin.id,
        idempotency_key,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Accepted().json(command))
}

pub async fn get_webhook_replay(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    command_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = operator(&req, pool.get_ref()).await?;
    let command = admin_webhook_replay::get(pool.get_ref(), command_id.trim()).await?;
    Ok(HttpResponse::Ok().json(command))
}

pub async fn approve_webhook_replay(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    command_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = command_operator(&req, pool.get_ref()).await?;
    let command =
        admin_webhook_replay::approve(pool.get_ref(), command_id.trim(), &admin.id).await?;
    Ok(HttpResponse::Accepted().json(command))
}

#[derive(Debug, Deserialize)]
pub struct SupportGrantQuery {
    #[serde(rename = "organizationId")]
    pub organization_id: Option<String>,
}

pub async fn list_support_grants(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<SupportGrantQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = support_viewer(&req, pool.get_ref()).await?;
    let grants = admin_support_access::list(
        pool.get_ref(),
        query.organization_id.as_deref().map(str::trim),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "grants": grants })))
}

pub async fn create_support_grant(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateSupportAccessRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = support_manager(&req, pool.get_ref()).await?;
    let grant = admin_support_access::create(pool.get_ref(), &admin, body.into_inner()).await?;
    Ok(HttpResponse::Created().json(grant))
}

pub async fn revoke_support_grant(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    grant_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = support_manager(&req, pool.get_ref()).await?;
    let grant = admin_support_access::revoke(pool.get_ref(), &admin, grant_id.as_str()).await?;
    Ok(HttpResponse::Ok().json(grant))
}

pub async fn projection(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    projection_key: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = operator(&req, pool.get_ref()).await?;
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_projection(&admin.id, projection_key.as_str())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn rebuild_projections(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let admin = command_operator(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Projection rebuild body must be an object".to_string(),
        ));
    }
    let response = AgentPlatformClient::from_config(config.get_ref())?
        .operator_rebuild_projections(&admin.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}
