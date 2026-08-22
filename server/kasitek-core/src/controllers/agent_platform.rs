use actix_web::{web, HttpRequest, HttpResponse};
use bytes::BytesMut;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{CreateAgentWebsiteDeploymentRequest, UpdateAgentWebsiteDeploymentRequest};
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{agent_platform::AgentPlatformClient, billing, website, whatsapp};

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    pub after: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffQuery {
    pub installation_id: Option<String>,
    pub agent_id: Option<String>,
    pub channel_type: Option<String>,
    pub reason: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub search: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveConversationQuery {
    pub installation_id: Option<String>,
    pub agent_id: Option<String>,
    pub search: Option<String>,
    pub limit: Option<u32>,
}

fn client(config: &AppConfig) -> Result<AgentPlatformClient, AppError> {
    AgentPlatformClient::from_config(config)
}

async fn scope(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<(crate::db::models::User, String), AppError> {
    let user = extract_user(req, pool).await?;
    let organization_id = resolve_active_org_id(req, pool, &user.id).await?;
    Ok((user, organization_id))
}

async fn management_scope(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<(crate::db::models::User, String), AppError> {
    let (user, organization_id) = scope(req, pool).await?;
    billing::require_capability(pool, &organization_id, billing::capabilities::AGENTS_MANAGE)
        .await?;
    Ok((user, organization_id))
}

pub async fn ensure_kasiai(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let settings = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !settings.is_object() {
        return Err(AppError::BadRequest(
            "KasiAi settings must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .ensure_kasiai(&organization_id, &user.id, settings)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_agents(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_agents(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Agent body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_agent(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn update_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    agent_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Agent body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .update_agent(
            &organization_id,
            &user.id,
            agent_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn delete_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    agent_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .delete_agent(&organization_id, &user.id, agent_id.trim())
        .await?;
    if let Some(installation_ids) = response
        .get("installationIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
    {
        website::delete_agent_website_deployments(
            pool.get_ref(),
            &organization_id,
            &installation_ids,
        )
        .await?;
    }
    Ok(HttpResponse::Ok().json(response))
}

pub async fn verify_provider_credential(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Credential verification body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .verify_provider_credential(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_provider_credential(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Credential body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_provider_credential(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn create_external_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "External agent body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_external_agent(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn list_external_agents(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_external_agents(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_external_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_external_agent(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_external_agent_health(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_external_agent_health(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn archive_external_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .archive_external_agent(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn set_external_agent_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (installation_id, status) = path.into_inner();
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !matches!(status.as_str(), "active" | "paused" | "disabled") {
        return Err(AppError::BadRequest(
            "Invalid external-agent status".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .set_external_agent_status(
            &organization_id,
            &user.id,
            installation_id.trim(),
            status.trim(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_agent_version(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    agent_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Agent version body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_agent_version(
            &organization_id,
            &user.id,
            agent_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn operations_summary(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .operations_summary(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn operations_runs(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<RunQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=200).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Run limit must be between 1 and 200".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .operations_runs(&organization_id, &user.id, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn operations_health(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .operations_health(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn operations_effects_reconciliation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<RunQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Reconciliation limit must be between 1 and 500".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .operations_effects_reconciliation(&organization_id, &user.id, query.limit)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn reconcile_effect(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    effect_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Reconciliation body must be an object".to_string(),
        ));
    }
    let outcome = body
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "succeeded" | "failed"))
        .ok_or_else(|| {
            AppError::BadRequest("Reconciliation outcome must be succeeded or failed".to_string())
        })?;
    if outcome == "failed" && body.get("error").is_none() {
        return Err(AppError::BadRequest(
            "A failed reconciliation requires an error object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .reconcile_effect(
            &organization_id,
            &user.id,
            effect_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn list_kill_switches(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_kill_switches(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_kill_switch(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Kill-switch body must be an object".to_string(),
        ));
    }
    let scope_type = body
        .get("scopeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        scope_type,
        "organization" | "agent" | "installation" | "tool"
    ) {
        return Err(AppError::BadRequest(
            "Kill-switch scopeType is invalid".to_string(),
        ));
    }
    for key in ["scopeId", "reason"] {
        if body
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(AppError::BadRequest(format!(
                "Kill-switch {key} is required"
            )));
        }
    }
    let response = client(config.get_ref())?
        .create_kill_switch(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn disable_kill_switch(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    switch_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let _response = client(config.get_ref())?
        .disable_kill_switch(&organization_id, &user.id, switch_id.trim())
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub action: Option<String>,
    #[serde(rename = "resourceType")]
    pub resource_type: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct ConversationQuery {
    pub limit: Option<u32>,
    pub before: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RunQuery {
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct KnowledgeQuery {
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "installationId")]
    pub installation_id: Option<String>,
    pub limit: Option<u32>,
}

pub async fn list_installation_runs(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    query: web::Query<RunQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=200).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Run limit must be between 1 and 200".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .list_installation_runs(
            &organization_id,
            &user.id,
            installation_id.trim(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_installation_schedules(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_schedules(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_installation_schedule(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Schedule body must be an object".to_string(),
        ));
    }
    let expression = body
        .get("expression")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Schedule expression is required".to_string()))?;
    if expression.len() > 240 {
        return Err(AppError::BadRequest(
            "Schedule expression is too long".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_installation_schedule(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn set_schedule_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (schedule_id, status) = path.into_inner();
    if !matches!(status.as_str(), "active" | "paused" | "disabled") {
        return Err(AppError::BadRequest("Invalid schedule status".to_string()));
    }
    let response = client(config.get_ref())?
        .set_schedule_status(&organization_id, &user.id, schedule_id.trim(), &status)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_knowledge_sources(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<KnowledgeQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Knowledge limit must be between 1 and 500".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .list_knowledge_sources(
            &organization_id,
            &user.id,
            query.agent_id.as_deref(),
            query.installation_id.as_deref(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_knowledge_source(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Knowledge source body must be an object".to_string(),
        ));
    }
    if body
        .get("agentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::BadRequest("agentId is required".to_string()));
    }
    let response = client(config.get_ref())?
        .create_knowledge_source(&organization_id, &user.id, body.into_inner())
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn get_knowledge_source(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    source_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_knowledge_source(&organization_id, &user.id, source_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn ingest_knowledge_source_url(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    source_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Knowledge ingest body must be an object".to_string(),
        ));
    }
    if body
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::BadRequest("url is required".to_string()));
    }
    let response = client(config.get_ref())?
        .ingest_knowledge_source_url(
            &organization_id,
            &user.id,
            source_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn ingest_knowledge_source_text(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    source_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Knowledge ingest body must be an object".to_string(),
        ));
    }
    if body
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::BadRequest("text is required".to_string()));
    }
    let response = client(config.get_ref())?
        .ingest_knowledge_source_text(
            &organization_id,
            &user.id,
            source_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn ingest_knowledge_source_file(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    source_id: web::Path<String>,
    mut payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let content_type = req
        .headers()
        .get(actix_web::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut body = BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|error| {
            AppError::BadRequest(format!("Invalid knowledge file upload: {error}"))
        })?;
        // The downstream multipart parser enforces the exact file limit. This
        // additional body guard prevents an oversized multipart envelope from
        // being buffered indefinitely at the product boundary.
        if body.len() + chunk.len() > 22 * 1024 * 1024 {
            return Err(AppError::BadRequest(
                "Knowledge file upload exceeds the 20 MB limit".to_string(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let response = client(config.get_ref())?
        .ingest_knowledge_source_file(
            &organization_id,
            &user.id,
            source_id.trim(),
            content_type,
            body.freeze(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn delete_knowledge_source(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    source_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| serde_json::json!({}));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Knowledge deletion body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .delete_knowledge_source(&organization_id, &user.id, source_id.trim(), body)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_memory(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<KnowledgeQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let agent_id = query
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("agentId is required".to_string()))?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Memory limit must be between 1 and 500".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .list_memory(
            &organization_id,
            &user.id,
            agent_id,
            query.installation_id.as_deref(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn delete_memory(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    memory_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Memory deletion body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .delete_memory(
            &organization_id,
            &user.id,
            memory_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn revalidate_memory(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    memory_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Memory revalidation body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .revalidate_memory(
            &organization_id,
            &user.id,
            memory_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_conversations(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_conversations(&organization_id, &user.id, &installation_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_handoffs(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<HandoffQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let query = query.into_inner();
    let response = client(config.get_ref())?
        .list_handoffs(
            &organization_id,
            &user.id,
            query.installation_id.as_deref(),
            query.agent_id.as_deref(),
            query.channel_type.as_deref(),
            query.reason.as_deref(),
            query.status.as_deref(),
            query.priority.as_deref(),
            query.search.as_deref(),
            query.limit,
            query.cursor.as_deref(),
            query.before.as_deref(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_live_conversations(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<LiveConversationQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let query = query.into_inner();
    let response = client(config.get_ref())?
        .list_live_conversations(
            &organization_id,
            &user.id,
            query.installation_id.as_deref(),
            query.agent_id.as_deref(),
            query.search.as_deref(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn stream_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    conversation_id: web::Path<String>,
    query: web::Query<StreamQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .stream_conversation_events(
            &organization_id,
            &user.id,
            &conversation_id,
            query.after,
        )
        .await?;
    let stream = response.bytes_stream().map(|chunk| {
        chunk.map_err(|error| {
            actix_web::error::ErrorBadGateway(format!("Agent Platform stream failed: {error}"))
        })
    });
    Ok(HttpResponse::Ok()
        .append_header(("Content-Type", "text/event-stream"))
        .append_header(("Cache-Control", "no-cache, no-transform"))
        .append_header(("Connection", "keep-alive"))
        .append_header(("X-Accel-Buffering", "no"))
        .streaming(stream))
}

pub async fn get_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_handoff(&organization_id, &user.id, handoff_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn claim_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .claim_handoff(&organization_id, &user.id, handoff_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn release_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !body.is_object() {
        return Err(AppError::BadRequest("Handoff release body must be an object".to_string()));
    }
    let response = client(config.get_ref())?
        .release_handoff(&organization_id, &user.id, handoff_id.trim(), body)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn expire_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .expire_handoff(&organization_id, &user.id, handoff_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn continue_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Handoff continuation body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .continue_handoff(&organization_id, &user.id, handoff_id.trim(), body)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn resolve_handoff(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Handoff resolution body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .resolve_handoff(&organization_id, &user.id, handoff_id.trim(), body)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn send_human_message(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    handoff_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let mut body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Human message body must be an object".to_string(),
        ));
    }
    let idempotency_key = req
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            body.get("idempotencyKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .ok_or_else(|| AppError::BadRequest("idempotency-key is required".to_string()))?;
    if let Value::Object(ref mut object) = body {
        object.insert(
            "idempotencyKey".to_string(),
            Value::String(idempotency_key.clone()),
        );
    }
    let response = client(config.get_ref())?
        .send_human_message(
            &organization_id,
            &user.id,
            handoff_id.trim(),
            body,
            &idempotency_key,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn kasiai_home(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .kasiai_home(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn kasiai_preferences(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .kasiai_preferences(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn update_kasiai_preferences(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "KasiAi preferences must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .update_kasiai_preferences(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn update_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    conversation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Conversation update must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .update_conversation(
            &organization_id,
            &user.id,
            conversation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn set_channel_default_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    conversation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .set_channel_default_conversation(&organization_id, &user.id, conversation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn set_conversation_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let (conversation_id, status) = path.into_inner();
    if status != "archived" && status != "deleted" {
        return Err(AppError::BadRequest(
            "Unsupported conversation status".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .set_conversation_status(&organization_id, &user.id, &conversation_id, &status)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn restore_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    conversation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .restore_conversation(&organization_id, &user.id, conversation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_channels(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_channels(&organization_id, &user.id, &installation_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_website_deployments(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (_user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let deployments = website::list_agent_website_deployments(
        pool.get_ref(),
        &organization_id,
        installation_id.trim(),
    )
    .await?;
    let share_base = config.public_api_url.trim_end_matches('/');
    let deployments = deployments
        .into_iter()
        .map(|deployment| {
            let mut value = serde_json::to_value(deployment).unwrap_or_else(|_| Value::Null);
            if let Value::Object(ref mut object) = value {
                if let Some(public_id) = object.get("publicId").and_then(Value::as_str) {
                    object.insert(
                        "shareUrl".to_string(),
                        Value::String(format!("{share_base}/api/widget/v1/share/{public_id}")),
                    );
                }
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deployments": deployments })))
}

pub async fn create_website_deployment(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<CreateAgentWebsiteDeploymentRequest>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let installation_id = installation_id.into_inner();
    let installation_id = installation_id.trim();
    let public_id = format!("wdg_{}", cuid2::create_id());
    // A website deployment is a normal public hosted-agent channel. The Agent
    // Platform refuses system-hosted (KasiAi) installations here, so a browser
    // surface cannot accidentally expose a private assistant.
    let channel = client(config.get_ref())?
        .ensure_channel_connection(
            &organization_id,
            &user.id,
            installation_id,
            serde_json::json!({
                "channelType": "website",
                "channelKey": public_id,
                "metadata": { "surface": "website-chat", "publicDeploymentId": public_id },
            }),
        )
        .await?;
    let channel_connection_id = channel.get("id").and_then(Value::as_str).ok_or_else(|| {
        AppError::Internal("Agent website channel response is invalid".to_string())
    })?;
    let deployment = website::create_agent_website_deployment(
        pool.get_ref(),
        &organization_id,
        installation_id,
        channel_connection_id,
        &public_id,
        &user.id,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({
        "deployment": deployment,
        "embedCode": format!(
            "<script async src=\"{}/api/widget/v1/loader.js\" data-kasitek-deployment=\"{}\"></script>",
            config.public_api_url.trim_end_matches('/'),
            public_id,
        ),
        "shareUrl": format!(
            "{}/api/widget/v1/share/{}",
            config.public_api_url.trim_end_matches('/'),
            public_id,
        ),
    })))
}

pub async fn set_website_deployment_status(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String, String)>,
) -> Result<HttpResponse, AppError> {
    let (_user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, deployment_id, status) = path.into_inner();
    let status = status.trim().to_ascii_uppercase();
    let deployment = website::set_agent_website_deployment_status(
        pool.get_ref(),
        &organization_id,
        installation_id.trim(),
        deployment_id.trim(),
        &status,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deployment": deployment })))
}

pub async fn update_website_deployment(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<UpdateAgentWebsiteDeploymentRequest>,
) -> Result<HttpResponse, AppError> {
    let (_user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, deployment_id) = path.into_inner();
    let deployment = website::update_agent_website_deployment(
        pool.get_ref(),
        &organization_id,
        installation_id.trim(),
        deployment_id.trim(),
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deployment": deployment })))
}

pub async fn create_channel_connection(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Channel connection body must be an object".to_string(),
        ));
    }
    for field in ["channelType"] {
        if body
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(AppError::BadRequest(format!("{field} is required")));
        }
    }
    let channel_type = body
        .get("channelType")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if channel_type != "telegram"
        && body
            .get("channelKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(AppError::BadRequest(
            "channelKey is required for this channel".to_string(),
        ));
    }
    if channel_type == "telegram"
        && body
            .get("credentialSecret")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        && body
            .get("credentialReference")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(AppError::BadRequest(
            "A Telegram bot token is required".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .ensure_channel_connection(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn issue_channel_pairing(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, connection_id) = path.into_inner();
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| serde_json::json!({}));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Pairing body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .issue_channel_pairing(
            &organization_id,
            &user.id,
            installation_id.trim(),
            connection_id.trim(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn revoke_channel_connection(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, connection_id) = path.into_inner();
    let response = client(config.get_ref())?
        .revoke_channel_connection(
            &organization_id,
            &user.id,
            installation_id.trim(),
            connection_id.trim(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn disconnect_channel(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    binding_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .revoke_channel_binding(&organization_id, &user.id, binding_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatsappPairingRequest {
    pub connection_id: String,
}

pub async fn issue_kasiai_whatsapp_pairing(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<WhatsappPairingRequest>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let connection_id = body.connection_id.trim();
    let whatsapp_connections = whatsapp::list_connections(pool.get_ref(), &organization_id).await?;
    if !whatsapp_connections
        .iter()
        .any(|connection| connection.id == connection_id)
    {
        return Err(AppError::NotFound(
            "WhatsApp connection not found".to_string(),
        ));
    }
    let agent_client = client(config.get_ref())?;
    let installation = agent_client
        .ensure_kasiai(&organization_id, &user.id, Value::Object(Map::new()))
        .await?;
    let installation_id = installation
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("KasiAi installation response is invalid".to_string()))?;
    let channel = agent_client
        .ensure_channel_connection(
            &organization_id,
            &user.id,
            installation_id,
            serde_json::json!({
                "channelType": "whatsapp",
                "channelKey": connection_id,
                "metadata": { "coreConnectionId": connection_id },
            }),
        )
        .await?;
    let agent_connection_id = channel
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Agent channel response is invalid".to_string()))?;
    let pairing = agent_client
        .issue_channel_pairing(
            &organization_id,
            &user.id,
            installation_id,
            agent_connection_id,
        )
        .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({
        "installationId": installation_id,
        "channel": channel,
        "pairing": pairing,
        "instruction": "Send the one-time pairing code as a WhatsApp message to the connected KasiTek number.",
    })))
}

pub async fn list_audit(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AuditQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Audit limit must be between 1 and 500".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .list_audit(
            &organization_id,
            &user.id,
            query.action.as_deref(),
            query.resource_type.as_deref(),
            query.limit,
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_templates(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_templates(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn install_template(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    template_key: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let body = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| serde_json::json!({}));
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Template installation body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .install_template(&organization_id, &user.id, &template_key, body)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn set_installation_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, status) = path.into_inner();
    if !matches!(status.as_str(), "active" | "paused" | "disabled") {
        return Err(AppError::BadRequest(
            "Invalid installation status".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .set_installation_status(&organization_id, &user.id, &installation_id, &status)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn set_installation_settings(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let object = body.as_object().ok_or_else(|| {
        AppError::BadRequest("Installation settings must be an object".to_string())
    })?;
    let mut settings = Map::new();
    for key in ["language", "tone", "responseDetail", "notificationsEnabled"] {
        if let Some(value) = object.get(key) {
            settings.insert(key.to_string(), value.clone());
        }
    }
    if settings.len() != object.len() {
        return Err(AppError::BadRequest(
            "Unsupported installation setting".to_string(),
        ));
    }
    if settings.is_empty() {
        return Err(AppError::BadRequest(
            "At least one installation setting is required".to_string(),
        ));
    }
    if let Some(language) = settings.get("language").and_then(Value::as_str) {
        if !(2..=20).contains(&language.chars().count()) {
            return Err(AppError::BadRequest(
                "Language must be between 2 and 20 characters".to_string(),
            ));
        }
    }
    if let Some(tone) = settings.get("tone").and_then(Value::as_str) {
        if !matches!(tone, "concise" | "balanced" | "detailed") {
            return Err(AppError::BadRequest("Invalid tone".to_string()));
        }
    }
    if let Some(detail) = settings.get("responseDetail").and_then(Value::as_str) {
        if !matches!(detail, "concise" | "standard" | "detailed") {
            return Err(AppError::BadRequest("Invalid response detail".to_string()));
        }
    }
    if settings
        .get("notificationsEnabled")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(AppError::BadRequest(
            "notificationsEnabled must be boolean".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .set_installation_settings(
            &organization_id,
            &user.id,
            &installation_id,
            Value::Object(settings),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_installation_credentials(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_credentials(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_installation_credential(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Installation credential body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .create_installation_credential(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn revoke_installation_credential(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, credential_id) = path.into_inner();
    let response = client(config.get_ref())?
        .revoke_installation_credential(
            &organization_id,
            &user.id,
            installation_id.trim(),
            credential_id.trim(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn rotate_installation_credential(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let (installation_id, credential_id) = path.into_inner();
    let response = client(config.get_ref())?
        .rotate_installation_credential(
            &organization_id,
            &user.id,
            installation_id.trim(),
            credential_id.trim(),
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn list_installation_capabilities(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_capabilities(&organization_id, &user.id, installation_id.trim(), None)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_installation_readiness(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_installation_readiness(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn grant_installation_tool(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let tool_name = body
        .get("toolName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("toolName is required".to_string()))?;
    let response = client(config.get_ref())?
        .grant_installation_tool(
            &organization_id,
            &user.id,
            installation_id.trim(),
            tool_name,
        )
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn list_installation_grants(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_grants(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn grant_installation_resource(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Resource grant body must be an object".to_string(),
        ));
    }
    let resource_type = body
        .get("resourceType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let resource_id = body
        .get("resourceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if resource_type.is_none() || resource_id.is_none() {
        return Err(AppError::BadRequest(
            "resourceType and resourceId are required".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .grant_installation_resource(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_connectors(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_connectors(&organization_id, &user.id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_installation_connectors(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_installation_connectors(&organization_id, &user.id, installation_id.trim())
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn grant_installation_connector(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    if body
        .get("connectorId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::BadRequest("connectorId is required".to_string()));
    }
    let response = client(config.get_ref())?
        .grant_installation_connector(
            &organization_id,
            &user.id,
            installation_id.trim(),
            body.into_inner(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn list_agent_versions(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    agent_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .list_agent_versions(&organization_id, &user.id, &agent_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_installation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let mut input = body
        .map(|value| value.into_inner())
        .unwrap_or_else(|| Value::Object(Default::default()));
    if !input.is_object() {
        return Err(AppError::BadRequest(
            "Installation body must be an object".to_string(),
        ));
    }
    if input.get("scopeType").is_none() {
        input["scopeType"] = Value::String("organization".to_string());
    }
    if input.get("scopeId").is_none() {
        input["scopeId"] = Value::String(organization_id.clone());
    }
    if input.get("settings").is_none() {
        input["settings"] = Value::Object(Default::default());
    }
    let response = client(config.get_ref())?
        .create_installation(&organization_id, &user.id, input)
        .await?;
    Ok(HttpResponse::Created().json(response))
}

async fn mutate_agent_version(
    pool: &PgPool,
    config: &AppConfig,
    req: HttpRequest,
    agent_id: String,
    version_id: String,
    action: &'static str,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool).await?;
    let response = match action {
        "publish" => {
            client(config)?
                .publish_agent_version(&organization_id, &user.id, &agent_id, &version_id)
                .await?
        }
        "rollback" => {
            client(config)?
                .rollback_agent_version(&organization_id, &user.id, &agent_id, &version_id)
                .await?
        }
        "retire" => {
            client(config)?
                .retire_agent_version(&organization_id, &user.id, &agent_id, &version_id)
                .await?
        }
        _ => {
            return Err(AppError::BadRequest(
                "Unknown agent version action".to_string(),
            ))
        }
    };
    Ok(HttpResponse::Ok().json(response))
}

pub async fn publish_agent_version(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (agent_id, version_id) = path.into_inner();
    mutate_agent_version(
        pool.get_ref(),
        config.get_ref(),
        req,
        agent_id,
        version_id,
        "publish",
    )
    .await
}

pub async fn rollback_agent_version(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (agent_id, version_id) = path.into_inner();
    mutate_agent_version(
        pool.get_ref(),
        config.get_ref(),
        req,
        agent_id,
        version_id,
        "rollback",
    )
    .await
}

pub async fn retire_agent_version(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (agent_id, version_id) = path.into_inner();
    mutate_agent_version(
        pool.get_ref(),
        config.get_ref(),
        req,
        agent_id,
        version_id,
        "retire",
    )
    .await
}

pub async fn archive_agent(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    agent_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = management_scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .archive_agent(&organization_id, &user.id, &agent_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn resolve_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .resolve_platform_conversation(&organization_id, &user.id, &installation_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn create_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .create_platform_conversation(&organization_id, &user.id, &installation_id)
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn clear_conversations(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .clear_platform_conversations(&organization_id, &user.id, &installation_id)
        .await?;
    Ok(HttpResponse::Created().json(response))
}

pub async fn send_message(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    installation_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let body = sanitize_message_body(body.into_inner())?;
    let response = client(config.get_ref())?
        .send_platform_message(&organization_id, &user.id, &installation_id, body)
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn get_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    conversation_id: web::Path<String>,
    query: web::Query<ConversationQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if query.limit.is_some_and(|limit| !(1..=200).contains(&limit)) {
        return Err(AppError::BadRequest(
            "Conversation message limit must be between 1 and 200".to_string(),
        ));
    }
    if query
        .before
        .as_ref()
        .is_some_and(|before| before.parse::<u64>().is_err())
    {
        return Err(AppError::BadRequest(
            "Conversation cursor is invalid".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .get_conversation(
            &organization_id,
            &user.id,
            &conversation_id,
            query.limit,
            query.before.as_deref(),
        )
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_run(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_run(&organization_id, &user.id, &run_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_run_timeline(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_run_timeline(&organization_id, &user.id, &run_id)
        .await?;
    Ok(HttpResponse::Ok().json(response))
}

pub async fn cancel_run(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
    body: Option<web::Json<Value>>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let reason = body
        .and_then(|value| {
            value
                .into_inner()
                .get("reason")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    if reason.len() > 500 {
        return Err(AppError::BadRequest(
            "Cancellation reason is too long".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .cancel_run(
            &organization_id,
            &user.id,
            &run_id,
            serde_json::json!({ "reason": reason }),
        )
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn retry_run(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .retry_run(&organization_id, &user.id, &run_id)
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn signal_external_event(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "External event body must be an object".to_string(),
        ));
    }
    let key = body
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("External event key is required".to_string()))?;
    if key.len() > 160 {
        return Err(AppError::BadRequest(
            "External event key is too long".to_string(),
        ));
    }
    if body
        .get("payload")
        .is_some_and(|payload| !payload.is_object())
    {
        return Err(AppError::BadRequest(
            "External event payload must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .signal_external_event(&organization_id, &user.id, &run_id, body.into_inner())
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn approve_run(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    if !body.is_object() {
        return Err(AppError::BadRequest(
            "Approval body must be an object".to_string(),
        ));
    }
    let response = client(config.get_ref())?
        .approve_run(&organization_id, &user.id, &run_id, body.into_inner())
        .await?;
    Ok(HttpResponse::Accepted().json(response))
}

pub async fn stream_run(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    run_id: web::Path<String>,
    query: web::Query<StreamQuery>,
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .stream_run_events(&organization_id, &user.id, &run_id, query.after)
        .await?;
    let stream = response.bytes_stream().map(|chunk| {
        chunk.map_err(|error| {
            actix_web::error::ErrorBadGateway(format!("Agent Platform stream failed: {error}"))
        })
    });
    Ok(HttpResponse::Ok()
        .append_header(("Content-Type", "text/event-stream"))
        .append_header(("Cache-Control", "no-cache, no-transform"))
        .append_header(("Connection", "keep-alive"))
        .append_header(("X-Accel-Buffering", "no"))
        .streaming(stream))
}

fn sanitize_message_body(body: Value) -> Result<Value, AppError> {
    let object = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("Message body must be an object".to_string()))?;
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Message text is required".to_string()))?;
    if message.chars().count() > 20_000 {
        return Err(AppError::BadRequest("Message text is too long".to_string()));
    }
    let idempotency_key = object
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() >= 8 && value.len() <= 240)
        .ok_or_else(|| AppError::BadRequest("A valid idempotencyKey is required".to_string()))?;
    let mut sanitized = Map::new();
    sanitized.insert("message".to_string(), Value::String(message.to_string()));
    sanitized.insert(
        "idempotencyKey".to_string(),
        Value::String(idempotency_key.to_string()),
    );
    let conversation_id = object
        .get("conversationId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let create_new = object
        .get("createNew")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if conversation_id.is_some() == create_new {
        return Err(AppError::BadRequest(
            "Choose either conversationId or createNew=true".to_string(),
        ));
    }
    if let Some(conversation_id) = conversation_id {
        if conversation_id.len() > 64 {
            return Err(AppError::BadRequest(
                "Conversation id is invalid".to_string(),
            ));
        }
        sanitized.insert(
            "conversationId".to_string(),
            Value::String(conversation_id.to_string()),
        );
    } else {
        sanitized.insert("createNew".to_string(), Value::Bool(true));
    }
    let model_provider = object.get("modelProvider").and_then(Value::as_str);
    let model = object.get("model").and_then(Value::as_str);
    if model_provider.is_some() != model.is_some() {
        return Err(AppError::BadRequest(
            "Model provider and model must be changed together".to_string(),
        ));
    }
    if let (Some(provider), Some(model)) = (model_provider, model) {
        if !matches!(provider, "openrouter" | "openai" | "anthropic" | "gemini")
            || model.trim().is_empty()
            || model.len() > 240
        {
            return Err(AppError::BadRequest(
                "Selected model is invalid".to_string(),
            ));
        }
        sanitized.insert(
            "modelProvider".to_string(),
            Value::String(provider.to_string()),
        );
        sanitized.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(context) = object.get("context") {
        let context = context
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Message context must be an object".to_string()))?;
        let mut safe_context = Map::new();
        for key in ["route", "pageTitle"] {
            if let Some(value) = context.get(key).and_then(Value::as_str) {
                if value.chars().count() > if key == "route" { 500 } else { 240 } {
                    return Err(AppError::BadRequest(
                        "Message context value is too long".to_string(),
                    ));
                }
                safe_context.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
        sanitized.insert("context".to_string(), Value::Object(safe_context));
    }
    Ok(Value::Object(sanitized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_sanitization_keeps_only_browser_safe_context() {
        let value = sanitize_message_body(serde_json::json!({
            "message": "  hello  ",
            "idempotencyKey": "message-123",
            "createNew": true,
            "modelProvider": "openrouter",
            "model": "openai/gpt-oss-20b:free",
            "context": {
                "route": "/agents",
                "pageTitle": "Agents",
                "resourceId": "must-not-cross-the-core-boundary"
            }
        }))
        .unwrap();
        assert_eq!(value["message"], "hello");
        assert_eq!(value["createNew"], true);
        assert_eq!(value["modelProvider"], "openrouter");
        assert_eq!(value["model"], "openai/gpt-oss-20b:free");
        assert_eq!(value["context"]["route"], "/agents");
        assert!(value["context"].get("resourceId").is_none());
    }

    #[test]
    fn message_sanitization_rejects_missing_idempotency() {
        assert!(sanitize_message_body(serde_json::json!({"message": "hello"})).is_err());
    }

    #[test]
    fn message_sanitization_requires_an_explicit_conversation_target() {
        let base = serde_json::json!({"message": "hello", "idempotencyKey": "message-123"});
        assert!(sanitize_message_body(base).is_err());
        assert!(sanitize_message_body(serde_json::json!({
            "message": "hello",
            "idempotencyKey": "message-123",
            "conversationId": "3b5db9dd-06ec-41f1-bdaf-b7c33f36284c",
            "createNew": true
        }))
        .is_err());
    }
}
