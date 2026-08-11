use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::agent_platform::AgentPlatformClient;

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

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub action: Option<String>,
    #[serde(rename = "resourceType")]
    pub resource_type: Option<String>,
    pub limit: Option<u32>,
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
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
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
) -> Result<HttpResponse, AppError> {
    let (user, organization_id) = scope(&req, pool.get_ref()).await?;
    let response = client(config.get_ref())?
        .get_conversation(&organization_id, &user.id, &conversation_id)
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
