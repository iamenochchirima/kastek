//! Private, narrow boundary used by the standalone Agent Platform service.
//!
//! This deliberately does not reuse browser session authentication. Agent
//! workers are service principals, so they authenticate with a dedicated
//! bearer token and must provide the organisation they are acting for. Every
//! operation is scoped by that organisation in the service layer. Read tools
//! and the explicit channel-delivery transport are the only exposed actions.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::identity::internal_delegation;
use crate::services::{customers, whatsapp};

async fn require_internal_agent(
    config: &AppConfig,
    req: &HttpRequest,
    required_capability: &str,
) -> Result<(String, String), AppError> {
    if config.agents_delegation_public_key.is_some() {
        let context = internal_delegation::resolve(config, req).await?;
        if !context.has_grant(required_capability) {
            return Err(AppError::Forbidden(format!(
                "Missing delegated capability: {required_capability}"
            )));
        }
        return Ok((context.organization_id, context.principal.id));
    }
    if config.environment.eq_ignore_ascii_case("production") {
        return Err(AppError::Unauthorized);
    }
    let expected = config
        .agents_internal_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let provided = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    if provided != expected {
        return Err(AppError::Unauthorized);
    }

    let organization_id = req
        .headers()
        .get("x-organization-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("x-organization-id is required".to_string()))?;
    let actor_id = req
        .headers()
        .get("x-actor-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kasitek-agent-platform");

    Ok((organization_id.to_string(), actor_id.to_string()))
}

/// Read a customer and its scoped identities, conversations, bookings, and
/// agent activity. No write-capable operation is exposed from this boundary.
pub async fn get_customer(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.customer_get").await?;
    let customer_id = path.into_inner();
    let detail = customers::get_customer_detail(pool.get_ref(), &organization_id, &customer_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Customer not found".to_string()))?;

    log::info!(
        "agent core read tool=customer.get org_id={} actor_id={} customer_id={}",
        organization_id,
        actor_id,
        customer_id
    );
    Ok(HttpResponse::Ok().json(detail))
}

/// Return the small, non-sensitive workspace snapshot used for platform
/// guidance. Counts and connection health are scoped by the signed
/// organization header; credentials and provider payloads never cross this
/// boundary.
pub async fn get_workspace_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.workspace_status").await?;
    let rows = sqlx::query(
        r#"SELECT provider, status::text AS status, COUNT(*)::bigint AS count
           FROM "ExternalConnection"
           WHERE "orgId" = $1
           GROUP BY provider, status
           ORDER BY provider, status"#,
    )
    .bind(&organization_id)
    .fetch_all(pool.get_ref())
    .await?;
    log::info!(
        "agent core read tool=workspace.status org_id={} actor_id={}",
        organization_id,
        actor_id
    );
    Ok(HttpResponse::Ok().json(json!({
        "organizationId": organization_id,
        "connections": rows.into_iter().map(|row| json!({
            "provider": row.get::<String, _>("provider"),
            "status": row.get::<String, _>("status"),
            "count": row.get::<i64, _>("count"),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChannelDeliveryRequest {
    pub channel_type: String,
    pub external_conversation_id: String,
    pub text: String,
}

/// Write-capable transport boundary for a reply that has already been
/// persisted by the Agent Platform. It accepts no credentials or arbitrary
/// provider URL; core resolves the organization-scoped connection itself.
pub async fn deliver_channel_message(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<AgentChannelDeliveryRequest>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.channel_deliver").await?;
    let channel_type = body.channel_type.trim().to_ascii_lowercase();
    let text = body.text.trim();
    if text.is_empty() || text.len() > 20_000 {
        return Err(AppError::BadRequest(
            "Agent reply text is invalid".to_string(),
        ));
    }
    let result = match channel_type.as_str() {
        "whatsapp" => {
            whatsapp::deliver_agent_message(
                pool.get_ref(),
                &organization_id,
                body.external_conversation_id.trim(),
                text,
            )
            .await?
        }
        _ => {
            return Err(AppError::BadRequest(format!(
                "Agent delivery channel is not supported: {channel_type}"
            )))
        }
    };
    log::info!(
        "agent channel delivery channel={} org_id={} actor_id={}",
        channel_type,
        organization_id,
        actor_id
    );
    Ok(HttpResponse::Ok().json(result))
}
