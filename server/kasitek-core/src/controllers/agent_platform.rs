use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{agent_platform::AgentPlatformClient, billing, whatsapp};

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    pub after: Option<u64>,
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
            "context": {
                "route": "/agents",
                "pageTitle": "Agents",
                "resourceId": "must-not-cross-the-core-boundary"
            }
        }))
        .unwrap();
        assert_eq!(value["message"], "hello");
        assert_eq!(value["context"]["route"], "/agents");
        assert!(value["context"].get("resourceId").is_none());
    }

    #[test]
    fn message_sanitization_rejects_missing_idempotency() {
        assert!(sanitize_message_body(serde_json::json!({"message": "hello"})).is_err());
    }
}
