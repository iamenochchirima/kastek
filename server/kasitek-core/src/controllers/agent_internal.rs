//! Private, narrow boundary used by the standalone Agent Platform service.
//!
//! This deliberately does not reuse browser session authentication. Agent
//! workers are service principals, so they authenticate with a dedicated
//! bearer token and must provide the organisation they are acting for. Every
//! operation is scoped by that organisation in the service layer. Read tools
//! and a small set of explicit, approval-gated actions are exposed here.

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::capabilities::{content_adapter, core_adapter};
use crate::config::AppConfig;
use crate::db::models::{
    ConversationUpdateRequest, SocialPostUpsertRequest, WhatsappContactListQuery,
    WhatsappContactUpdateRequest, WhatsappTemplateListQuery,
};
use crate::error::AppError;
use crate::identity::internal_delegation;
use crate::identity::request_context::RequestContext;
use crate::services::whatsapp::WhatsappReplyButton;
use crate::services::{
    connections, content_media, credits, customers, inbox, website, whatsapp, whatsapp_inbox,
};

#[derive(Debug, Default, Deserialize)]
pub struct AgentContentInsightsQuery {
    pub platform: Option<String>,
    pub metrics: Option<String>,
    #[serde(rename = "publishedFrom", alias = "published_from")]
    pub published_from: Option<String>,
    #[serde(rename = "publishedTo", alias = "published_to")]
    pub published_to: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct AgentCreditUsageReconciliationQuery {
    #[serde(rename = "sourceType", alias = "source_type")]
    pub source_type: Option<String>,
    #[serde(rename = "sourceId", alias = "source_id")]
    pub source_id: Option<String>,
    pub limit: Option<i64>,
}

fn parse_agent_insights_filters(
    query: &AgentContentInsightsQuery,
) -> Result<crate::services::social::SocialPostInsightsFilters, AppError> {
    let filters = crate::services::social::parse_insights_filters(
        query.platform.as_deref(),
        query.metrics.as_deref(),
        query.published_from.as_deref(),
        query.published_to.as_deref(),
    )?;
    if let Some(platform) = filters.platform.as_deref() {
        if !crate::services::social::is_valid_platform(platform) {
            return Err(AppError::BadRequest("Invalid social platform".to_string()));
        }
    }
    Ok(filters)
}

async fn require_internal_agent(
    config: &AppConfig,
    req: &HttpRequest,
    required_capability: &str,
) -> Result<(String, String), AppError> {
    if config.has_agent_delegation_keys() {
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

async fn resolve_internal_agent_context(
    config: &AppConfig,
    req: &HttpRequest,
    required_capability: &str,
) -> Result<RequestContext, AppError> {
    if config.has_agent_delegation_keys() {
        let context = internal_delegation::resolve(config, req).await?;
        if !context.has_grant(required_capability) {
            return Err(AppError::Forbidden(format!(
                "Missing delegated capability: {required_capability}"
            )));
        }
        return Ok(context);
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
        .unwrap_or("kasitek-agent-platform")
        .to_string();
    let idempotency_key = req
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(RequestContext {
        principal: crate::identity::principal::Principal {
            kind: crate::identity::principal::PrincipalKind::TrustedInternalService,
            id: actor_id,
            subject_user_id: None,
            client_id: None,
        },
        organization_id: organization_id.to_string(),
        user_id: None,
        client_id: None,
        installation_id: None,
        effective_grants: [required_capability.to_string()].into_iter().collect(),
        api_scopes: None,
        correlation_id: None,
        causation_id: None,
        idempotency_key,
    })
}

fn resolve_credit_idempotency_key(
    context: &RequestContext,
    requested_key: Option<&str>,
) -> Result<String, AppError> {
    let requested_key = requested_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(signed_key) = context.idempotency_key.as_deref() {
        if let Some(requested_key) = requested_key {
            if requested_key != signed_key {
                return Err(AppError::Conflict(
                    "Request idempotency key does not match the signed delegation".to_string(),
                ));
            }
        }
        return Ok(signed_key.to_string());
    }
    requested_key
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest("idempotency-key is required".to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditReservationRequest {
    pub action_key: String,
    pub estimated_credits: i64,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub pricing_version: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditCaptureRequest {
    pub actual_credits: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub funding_source: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub provider_cost_usd: Option<f64>,
    pub metadata: Option<serde_json::Value>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditReleaseRequest {
    pub reason: String,
    pub idempotency_key: Option<String>,
}

pub async fn reserve_credits(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<CreditReservationRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.credits_reserve")
            .await?;
    let idempotency_key =
        resolve_credit_idempotency_key(&context, body.idempotency_key.as_deref())?;
    let result = credits::reserve_credits(
        pool.get_ref(),
        &context.organization_id,
        &body.action_key,
        body.estimated_credits,
        body.source_type.as_deref(),
        body.source_id.as_deref(),
        body.pricing_version.as_deref(),
        body.expires_at,
        &idempotency_key,
    )
    .await?;
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "credits.reserve",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        action_key = %body.action_key,
        amount = body.estimated_credits,
        idempotent = result.idempotent,
        "agent credit reserve completed"
    );
    Ok(HttpResponse::Ok().json(result))
}

pub async fn capture_credits(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    reservation_id: web::Path<String>,
    body: web::Json<CreditCaptureRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.credits_settle")
            .await?;
    let idempotency_key =
        resolve_credit_idempotency_key(&context, body.idempotency_key.as_deref())?;
    let result = credits::capture_credits(
        pool.get_ref(),
        &context.organization_id,
        reservation_id.trim(),
        body.actual_credits,
        credits::CreditCaptureUsage {
            provider: body.provider.clone(),
            model: body.model.clone(),
            funding_source: body.funding_source.clone(),
            input_tokens: body.input_tokens,
            output_tokens: body.output_tokens,
            provider_cost_usd: body.provider_cost_usd.map(|value| value.to_string()),
            metadata: body.metadata.clone(),
        },
        &idempotency_key,
    )
    .await?;
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "credits.capture",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        reservation_id = %reservation_id,
        amount = body.actual_credits,
        idempotent = result.idempotent,
        "agent credit capture completed"
    );
    Ok(HttpResponse::Ok().json(result))
}

pub async fn release_credits(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    reservation_id: web::Path<String>,
    body: web::Json<CreditReleaseRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.credits_settle")
            .await?;
    let idempotency_key =
        resolve_credit_idempotency_key(&context, body.idempotency_key.as_deref())?;
    let result = credits::release_credits(
        pool.get_ref(),
        &context.organization_id,
        reservation_id.trim(),
        &body.reason,
        &idempotency_key,
    )
    .await?;
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "credits.release",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        reservation_id = %reservation_id,
        idempotent = result.idempotent,
        "agent credit release completed"
    );
    Ok(HttpResponse::Ok().json(result))
}

pub async fn get_credit_usage_reconciliation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentCreditUsageReconciliationQuery>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.credits_usage_read")
            .await?;
    let source_type = query
        .source_type
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("sourceType is required".to_string()))?;
    let source_id = query
        .source_id
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("sourceId is required".to_string()))?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let reservations = credits::get_credit_reservations_for_source(
        pool.get_ref(),
        &context.organization_id,
        source_type,
        source_id,
        limit,
    )
    .await?;
    let usage_events = credits::get_credit_usage_reconciliation_for_source(
        pool.get_ref(),
        &context.organization_id,
        source_type,
        source_id,
        limit,
    )
    .await?;
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "credits.usage_reconciliation",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        source_type = %source_type,
        source_id = %source_id,
        reservation_count = reservations.len(),
        usage_event_count = usage_events.len(),
        "agent credit usage reconciliation read completed"
    );
    Ok(HttpResponse::Ok().json(json!({
        "sourceType": source_type,
        "sourceId": source_id,
        "reservations": reservations,
        "usageEvents": usage_events,
    })))
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

    observability::tracing::info!(
        event = "http.request.completed",
        operation = "customer.get",
        organization_id = %organization_id,
        actor_id = %actor_id,
        customer_id = %customer_id,
        "agent customer read completed"
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
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "workspace.status",
        organization_id = %organization_id,
        actor_id = %actor_id,
        "agent workspace status read completed"
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

/// Return individual connected accounts without provider metadata, errors, or
/// credentials. This is the agent-facing projection used when a user asks
/// which page, channel, or account is connected.
fn agent_connection_summary(
    connection: &crate::db::models::ExternalConnection,
) -> serde_json::Value {
    json!({
        "provider": connection.provider,
        "displayName": connection.display_name,
        "handle": connection.handle,
        "status": connection.status,
        "credentialStatus": connection.credential_status,
        "healthStatus": connection.health_status,
        "webhookStatus": connection.webhook_status,
        "lastCheckedAt": connection.last_checked_at,
        "capabilities": connection.capabilities,
        "permissions": connection.permissions,
        "consumers": connection.consumers,
    })
}

#[derive(Debug, Deserialize)]
pub struct AgentConnectionListQuery {
    pub provider: Option<String>,
    pub status: Option<String>,
    pub limit: Option<u16>,
}

impl AgentConnectionListQuery {
    fn bounded_limit(&self) -> Result<usize, AppError> {
        match self.limit {
            None => Ok(100),
            Some(value) if (1..=200).contains(&value) => Ok(value as usize),
            Some(_) => Err(AppError::BadRequest(
                "limit must be between 1 and 200".to_string(),
            )),
        }
    }
}

fn normalize_agent_connection_filter(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
}

/// List the organisation's connected provider accounts. The service layer
/// refreshes the connection projection before returning it, so this includes
/// account-level health and webhook state rather than only aggregate counts.
pub async fn list_workspace_connections(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentConnectionListQuery>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.connections_list").await?;
    let provider = normalize_agent_connection_filter(query.provider.as_deref());
    let status = normalize_agent_connection_filter(query.status.as_deref());
    let limit = query.bounded_limit()?;
    let connections = connections::list_connections(pool.get_ref(), &organization_id)
        .await?
        .into_iter()
        .filter(|connection| {
            provider.is_none_or(|value| connection.provider.eq_ignore_ascii_case(value))
                && status.is_none_or(|value| connection.status.eq_ignore_ascii_case(value))
        })
        .take(limit)
        .map(|connection| agent_connection_summary(&connection))
        .collect::<Vec<_>>();

    observability::tracing::info!(
        event = "http.request.completed",
        operation = "connections.list",
        organization_id = %organization_id,
        actor_id = %actor_id,
        count = connections.len(),
        "agent connection list completed"
    );
    Ok(HttpResponse::Ok().json(json!({
        "organizationId": organization_id,
        "connections": connections,
    })))
}

#[derive(Debug, Deserialize)]
pub struct AgentConnectionStatusUpdateRequest {
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionIdentityStatusUpdateRequest {
    pub provider: String,
    pub display_name: String,
    pub handle: Option<String>,
    pub status: String,
}

/// Apply only explicit disconnect/revoke transitions from the agent boundary.
/// Reconnection and OAuth remain UI-owned flows, while this write is always
/// approval-gated by the agent capability registry.
pub async fn update_workspace_connection_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<AgentConnectionIdentityStatusUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.connection_status_update",
    )
    .await?;
    let status = body.status.trim().to_ascii_uppercase();
    if !matches!(status.as_str(), "DISCONNECTED" | "REVOKED") {
        return Err(AppError::BadRequest(
            "Agent connection status must be DISCONNECTED or REVOKED".to_string(),
        ));
    }
    let connection = connections::update_status_by_identity(
        pool.get_ref(),
        &context.organization_id,
        &body.provider,
        &body.display_name,
        body.handle.as_deref(),
        &status,
    )
    .await?;

    observability::tracing::info!(
        event = "http.request.completed",
        operation = "connections.status_update",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        provider = %body.provider,
        status = %status,
        "agent connection status updated"
    );
    Ok(HttpResponse::Ok().json(json!({
        "connection": agent_connection_summary(&connection),
    })))
}

pub async fn update_workspace_connection_status_by_id(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<AgentConnectionStatusUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.connection_status_update",
    )
    .await?;
    let status = body.status.trim().to_ascii_uppercase();
    if !matches!(status.as_str(), "DISCONNECTED" | "REVOKED") {
        return Err(AppError::BadRequest(
            "Agent connection status must be DISCONNECTED or REVOKED".to_string(),
        ));
    }
    let connection = connections::update_status(
        pool.get_ref(),
        &context.organization_id,
        &path.into_inner(),
        &status,
    )
    .await?;

    observability::tracing::info!(
        event = "http.request.completed",
        operation = "connections.status_update",
        organization_id = %context.organization_id,
        actor_id = %context.principal.id,
        status = %status,
        "agent connection status updated"
    );
    Ok(HttpResponse::Ok().json(json!({
        "connection": agent_connection_summary(&connection),
    })))
}

/// Return aggregate workspace reporting data without user/session coupling or
/// provider payloads. The report is intentionally separate from the status
/// endpoint so callers can grant health and reporting independently.
pub async fn get_workspace_report(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.workspace_report").await?;
    let report =
        crate::services::workspace_reporting::agent_report(pool.get_ref(), &organization_id)
            .await?;
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "workspace.report",
        organization_id = %organization_id,
        actor_id = %actor_id,
        "agent workspace report completed"
    );
    Ok(HttpResponse::Ok().json(report))
}

/// List booking services through the same typed booking query used by the
/// product API. The internal boundary contributes authentication and the
/// normalized request context; it does not duplicate SQL or booking policy.
pub async fn list_booking_services(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentCollectionQuery>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.booking_services_list",
    )
    .await?;
    let mut services = core_adapter::list_booking_services(pool.get_ref(), &context).await?;
    let total = services.len();
    let limit = query.bounded_limit()?;
    services.truncate(limit);
    Ok(HttpResponse::Ok().json(json!({
        "services": services,
        "total": total,
        "hasMore": total > limit,
    })))
}

pub async fn list_bookings(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentCollectionQuery>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.bookings_list")
            .await?;
    let mut bookings = core_adapter::list_bookings(pool.get_ref(), &context).await?;
    let total = bookings.len();
    let limit = query.bounded_limit()?;
    bookings.truncate(limit);
    Ok(HttpResponse::Ok().json(json!({
        "bookings": bookings,
        "total": total,
        "hasMore": total > limit,
    })))
}

pub async fn get_booking(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.booking_get").await?;
    let booking = core_adapter::get_booking(pool.get_ref(), &context, &path.into_inner())
        .await?
        .ok_or_else(|| AppError::NotFound("Booking not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "booking": booking })))
}

pub async fn list_campaigns(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentCollectionQuery>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.campaigns_list").await?;
    let campaigns = whatsapp::list_campaigns(pool.get_ref(), &organization_id).await?;
    Ok(HttpResponse::Ok().json(bound_collection_payload(
        campaigns,
        "campaigns",
        query.bounded_limit()?,
    )?))
}

pub async fn get_campaign_summary(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.campaign_summary").await?;
    let campaign =
        whatsapp::get_campaign_summary(pool.get_ref(), &organization_id, &path.into_inner())
            .await?;
    Ok(HttpResponse::Ok().json(campaign))
}

pub async fn list_templates(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentTemplateListQuery>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.templates_list").await?;
    let query = query.into_inner();
    let limit = bounded_agent_template_limit(query.limit)?;
    let templates = whatsapp::list_templates(
        pool.get_ref(),
        &organization_id,
        WhatsappTemplateListQuery {
            status: query.status,
        },
    )
    .await?;
    Ok(HttpResponse::Ok().json(bound_collection_payload(templates, "templates", limit)?))
}

#[derive(Debug, Deserialize)]
pub struct AgentTemplateListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

fn bounded_agent_template_limit(value: Option<i64>) -> Result<usize, AppError> {
    match value {
        None => Ok(100),
        Some(value) if (1..=200).contains(&value) => Ok(value as usize),
        Some(_) => Err(AppError::BadRequest(
            "limit must be between 1 and 200".to_string(),
        )),
    }
}

/// List the organisation's WhatsApp contacts through the same scoped query
/// used by the product contacts surface. The Agent Platform receives the
/// filtered projection and aggregate counts, never provider credentials.
pub async fn list_contacts(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<WhatsappContactListQuery>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.contacts_list")
            .await?;
    let mut query = query.into_inner();
    let limit = bounded_agent_contact_limit(query.limit)?;
    query.limit = Some(limit);
    let mut result =
        whatsapp::list_contacts(pool.get_ref(), &context.organization_id, query).await?;
    let filtered_total = result
        .get("stats")
        .and_then(|stats| stats.get("filteredTotal"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let object = result
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("Core contacts projection is invalid".to_string()))?;
    object.insert("total".to_string(), json!(filtered_total));
    object.insert("hasMore".to_string(), json!(filtered_total > limit));
    Ok(HttpResponse::Ok().json(result))
}

/// Apply an approval-gated, organization-scoped contact update. Contact
/// consent and exclusion changes are persisted with the Agent idempotency key
/// so a retry cannot apply a different update to the same membership.
pub async fn update_contact(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappContactUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.contact_update")
            .await?;
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for agent contact updates".to_string())
    })?;
    let contact = whatsapp::update_agent_contact(
        pool.get_ref(),
        &context.organization_id,
        &path.into_inner(),
        body.into_inner(),
        idempotency_key,
    )
    .await?;
    Ok(HttpResponse::Ok().json(contact))
}

fn bounded_agent_contact_limit(value: Option<i64>) -> Result<i64, AppError> {
    match value {
        None => Ok(100),
        Some(value) if (1..=200).contains(&value) => Ok(value),
        Some(_) => Err(AppError::BadRequest(
            "limit must be between 1 and 200".to_string(),
        )),
    }
}

/// List the organisation's inbox conversations. Conversation records remain
/// owned by core; this boundary only returns the redacted list projection.
#[derive(Debug, Deserialize)]
pub struct AgentCollectionQuery {
    pub limit: Option<u16>,
}

impl AgentCollectionQuery {
    fn bounded_limit(&self) -> Result<usize, AppError> {
        match self.limit {
            None => Ok(100),
            Some(value) if (1..=200).contains(&value) => Ok(value as usize),
            Some(_) => Err(AppError::BadRequest(
                "limit must be between 1 and 200".to_string(),
            )),
        }
    }
}

fn bound_collection_payload(
    mut payload: serde_json::Value,
    key: &str,
    limit: usize,
) -> Result<serde_json::Value, AppError> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("Core collection projection is invalid".to_string()))?;
    let values = object
        .get_mut(key)
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| AppError::Internal("Core collection projection is invalid".to_string()))?;
    let total = values.len();
    values.truncate(limit);
    object.insert("total".to_string(), json!(total));
    object.insert("hasMore".to_string(), json!(total > limit));
    Ok(payload)
}

pub async fn list_inbox_conversations(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentCollectionQuery>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.inbox_conversations_list",
    )
    .await?;
    let result = crate::services::inbox::list_inbox_conversations_bounded(
        pool.get_ref(),
        &context.organization_id,
        query.bounded_limit()?,
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

/// Read the message timeline for one organisation-scoped conversation. Core
/// performs the ownership check before loading any provider-specific data.
pub async fn list_inbox_messages(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<AgentCollectionQuery>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.inbox_messages_list")
            .await?;
    let result = crate::services::inbox::list_conversation_messages_bounded(
        pool.get_ref(),
        &context.organization_id,
        &path.into_inner(),
        query.bounded_limit()?,
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

/// Update the workspace-owned conversation presentation state. This is a
/// local, reversible write and does not expose provider credentials.
pub async fn update_inbox_conversation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ConversationUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.inbox_conversation_update",
    )
    .await?;
    if body.starred.is_none() {
        return Err(AppError::BadRequest(
            "Conversation update requires starred".to_string(),
        ));
    }
    let result = whatsapp::update_conversation(
        pool.get_ref(),
        &context.principal.id,
        &context.organization_id,
        &path.into_inner(),
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

/// Mark a conversation read in core and, when configured, propagate the read
/// receipt to WhatsApp. The idempotency key binds the approved durable call.
pub async fn mark_inbox_conversation_read(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.inbox_conversation_mark_read",
    )
    .await?;
    if context.idempotency_key.is_none() {
        return Err(AppError::BadRequest(
            "idempotency-key is required for marking a conversation read".to_string(),
        ));
    }
    let result = whatsapp::mark_conversation_read(
        pool.get_ref(),
        &context.principal.id,
        &context.organization_id,
        &path.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_content_posts(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_posts_list")
            .await?;
    let posts = content_adapter::list_posts(pool.get_ref(), &context).await?;
    let mut response = json!({ "posts": posts });
    add_agent_media_preview_urls(&mut response, config.get_ref());
    Ok(HttpResponse::Ok().json(response))
}

pub async fn get_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_post_get")
            .await?;
    let post = content_adapter::get_post(pool.get_ref(), &context, &path.into_inner())
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    let mut response = json!({ "post": post });
    add_agent_media_preview_urls(&mut response, config.get_ref());
    Ok(HttpResponse::Ok().json(response))
}

/// Add short-lived, provider-readable media URLs only to the private Agent
/// content projection. The durable social model still exposes asset ids, and
/// the signed URL never grants access outside the asset's existing public
/// media checks.
fn add_agent_media_preview_urls(payload: &mut Value, config: &AppConfig) {
    let Some(posts) = payload.get_mut("posts").and_then(Value::as_array_mut) else {
        if let Some(post) = payload.get_mut("post") {
            add_agent_post_media_preview_urls(post, config);
        }
        return;
    };
    for post in posts {
        add_agent_post_media_preview_urls(post, config);
    }
}

fn add_agent_post_media_preview_urls(post: &mut Value, config: &AppConfig) {
    let Some(media) = post.get_mut("media").and_then(Value::as_array_mut) else {
        return;
    };
    for item in media {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let Some(asset_id) = object.get("assetId").and_then(Value::as_str) else {
            continue;
        };
        object.insert(
            "previewUrl".to_string(),
            Value::String(content_media::public_media_url(config, asset_id)),
        );
    }
}

pub async fn list_content_post_insights(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    query: web::Query<AgentContentInsightsQuery>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.content_posts_insights_report",
    )
    .await?;
    let filters = parse_agent_insights_filters(&query)?;
    let report = content_adapter::list_insights(
        pool.get_ref(),
        &context,
        &filters,
        query.limit.unwrap_or(50),
    )
    .await?;
    Ok(HttpResponse::Ok().json(report))
}

pub async fn get_content_post_insights(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<AgentContentInsightsQuery>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.content_post_insights",
    )
    .await?;
    let filters = parse_agent_insights_filters(&query)?;
    let insights =
        content_adapter::get_insights(pool.get_ref(), &context, &path.into_inner(), &filters)
            .await?
            .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    Ok(HttpResponse::Ok().json(insights))
}

pub async fn create_content_draft(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_post_draft")
            .await?;
    if context.idempotency_key.is_none() {
        return Err(AppError::BadRequest(
            "idempotency-key is required for content drafts".to_string(),
        ));
    }
    if body
        .status
        .as_deref()
        .is_some_and(|status| status != "DRAFT")
    {
        return Err(AppError::BadRequest(
            "Agent content drafts must use DRAFT status".to_string(),
        ));
    }
    let post = content_adapter::create_draft(pool.get_ref(), &context, &body).await?;
    Ok(HttpResponse::Created().json(json!({ "post": post })))
}

pub async fn upload_content_media(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    mut payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_media_upload")
            .await?;
    let mime_type = req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| {
            value.starts_with("image/")
                || value.starts_with("video/")
                || value.starts_with("audio/")
                || *value == "application/ogg"
        })
        .ok_or_else(|| {
            AppError::BadRequest("An image, video, or audio MIME type is required".to_string())
        })?;
    let file_name = req
        .headers()
        .get("x-media-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.into_owned());
    let source = req
        .headers()
        .get("x-media-source")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent_channel")
        .to_string();
    let source_key = req
        .headers()
        .get("x-media-source-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let max_channel_media_bytes: usize =
        if mime_type.starts_with("audio/") || mime_type == "application/ogg" {
            25 * 1024 * 1024
        } else if mime_type.starts_with("image/") {
            20 * 1024 * 1024
        } else {
            512 * 1024 * 1024
        };
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk =
            chunk.map_err(|_| AppError::BadRequest("Failed to read channel image".to_string()))?;
        if bytes.len() + chunk.len() > max_channel_media_bytes {
            return Err(AppError::BadRequest(
                "Channel media exceeds the allowed size".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(AppError::BadRequest("Media is required".to_string()));
    }

    let uploaded_by_id = context
        .user_id
        .as_deref()
        .or(context.principal.subject_user_id.as_deref())
        .map(str::to_string)
        .or_else(|| {
            req.headers()
                .get("x-actor-id")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
    let uploaded_by_id = match uploaded_by_id {
        Some(actor_id) => sqlx::query_scalar::<_, String>(
            r#"SELECT candidate.id
               FROM "User" candidate
               WHERE candidate.id = $1
                 AND (
                   EXISTS (SELECT 1 FROM "Organization" org WHERE org.id = $2 AND org."ownerId" = candidate.id)
                   OR EXISTS (SELECT 1 FROM "OrganizationMember" member WHERE member."orgId" = $2 AND member."userId" = candidate.id)
                 )
               LIMIT 1"#,
        )
        .bind(&actor_id)
        .bind(&context.organization_id)
        .fetch_optional(pool.get_ref())
        .await?,
        None => None,
    }
    .or(sqlx::query_scalar::<_, String>(
        r#"SELECT "ownerId" FROM "Organization" WHERE id = $1"#,
    )
    .bind(&context.organization_id)
    .fetch_optional(pool.get_ref())
    .await?)
    .ok_or_else(|| AppError::NotFound("Organization not found".to_string()))?;
    let asset = content_media::upload_content_media_bytes(
        pool.get_ref(),
        config.get_ref(),
        &uploaded_by_id,
        &context.organization_id,
        content_media::ContentMediaBytesUpload {
            file_name,
            mime_type: mime_type.to_string(),
            bytes,
            source,
            source_key,
        },
    )
    .await?;
    Ok(HttpResponse::Created().json(json!({ "asset": asset })))
}

pub async fn download_content_media(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.content_media_read").await?;
    let stored = content_media::read_content_media_bytes(
        pool.get_ref(),
        config.get_ref(),
        &organization_id,
        &path.into_inner(),
    )
    .await?;
    let mut response = HttpResponse::Ok();
    response.content_type(stored.mime_type);
    if let Some(checksum) = stored.checksum {
        response.insert_header(("X-Media-Checksum", checksum));
    }
    Ok(response.body(stored.bytes))
}

/// Metadata projection for the Agent Media Harness. The response contains a
/// stable asset identity and safe display fields only; it never includes an
/// expiring preview URL, storage key, or bytes.
pub async fn get_content_media_metadata(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.content_media_read").await?;
    let asset = content_media::get_content_media_asset(
        pool.get_ref(),
        &organization_id,
        &path.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(json!({ "asset": asset })))
}

pub async fn get_content_media_preview(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.content_media_read").await?;
    let (asset, preview_url) = content_media::get_content_media_preview(
        pool.get_ref(),
        config.get_ref(),
        &organization_id,
        &path.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(json!({ "asset": asset, "previewUrl": preview_url })))
}

pub async fn delete_audio_content_media(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, _) =
        require_internal_agent(config.get_ref(), &req, "kasitek.core.content_media_delete").await?;
    let deleted = content_media::delete_audio_content_media(
        pool.get_ref(),
        config.get_ref(),
        &organization_id,
        &path.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(json!({ "deleted": deleted })))
}

#[derive(Debug, Deserialize)]
pub struct AgentContentPublishRequest {
    pub platform: String,
}

pub async fn update_content_draft(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_post_update")
            .await?;
    let post =
        content_adapter::update_draft(pool.get_ref(), &context, &path.into_inner(), &body).await?;
    Ok(HttpResponse::Ok().json(json!({ "post": post })))
}

pub async fn publish_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<AgentContentPublishRequest>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_post_publish")
            .await?;
    if context.idempotency_key.is_none() {
        return Err(AppError::BadRequest(
            "idempotency-key is required for content publishing".to_string(),
        ));
    }
    let result =
        content_adapter::publish(pool.get_ref(), &context, &path.into_inner(), &body.platform)
            .await?;
    Ok(HttpResponse::Accepted().json(result))
}

#[derive(Debug, Deserialize)]
pub struct AgentContentScheduleRequest {
    #[serde(rename = "scheduledFor")]
    pub scheduled_for: String,
}

pub async fn schedule_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<AgentContentScheduleRequest>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.content_post_schedule",
    )
    .await?;
    let result = content_adapter::schedule(
        pool.get_ref(),
        &context,
        &path.into_inner(),
        &body.scheduled_for,
    )
    .await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn unschedule_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.content_post_unschedule",
    )
    .await?;
    let result = content_adapter::unschedule(pool.get_ref(), &context, &path.into_inner()).await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn delete_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.content_post_delete")
            .await?;
    let result = content_adapter::delete_post(pool.get_ref(), &context, &path.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn delete_published_content_post(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<AgentContentDeletePublishedRequest>,
) -> Result<HttpResponse, AppError> {
    let context = resolve_internal_agent_context(
        config.get_ref(),
        &req,
        "kasitek.core.content_post_delete_published",
    )
    .await?;
    let result = content_adapter::delete_published_post(
        pool.get_ref(),
        config.get_ref(),
        &context,
        &path.into_inner(),
        &body.platform,
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

#[derive(Debug, Deserialize)]
pub struct AgentContentDeletePublishedRequest {
    pub platform: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChannelDeliveryRequest {
    pub channel_type: String,
    pub external_conversation_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub media: Vec<whatsapp_inbox::AgentMediaAttachment>,
    #[serde(default)]
    pub buttons: Vec<WhatsappReplyButton>,
    #[serde(default)]
    pub ui: Option<Value>,
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
    let context =
        resolve_internal_agent_context(config.get_ref(), &req, "kasitek.core.channel_deliver")
            .await?;
    let organization_id = context.organization_id.clone();
    let actor_id = context.principal.id.clone();
    let idempotency_key = context.idempotency_key.as_deref().ok_or_else(|| {
        AppError::BadRequest("idempotency-key is required for agent channel delivery".to_string())
    })?;
    let channel_type = body.channel_type.trim().to_ascii_lowercase();
    let text = body.text.trim();
    if (text.is_empty() && body.media.is_empty()) || text.len() > 20_000 {
        return Err(AppError::BadRequest(
            "Agent reply must include text or media".to_string(),
        ));
    }
    let result = match channel_type.as_str() {
        "whatsapp" => {
            if !body.buttons.is_empty() && !body.media.is_empty() {
                return Err(AppError::BadRequest(
                    "WhatsApp replies cannot combine buttons and media".to_string(),
                ));
            }
            whatsapp::deliver_agent_message(
                pool.get_ref(),
                config.get_ref(),
                &organization_id,
                body.external_conversation_id.trim(),
                text,
                idempotency_key,
                &body.media,
                &body.buttons,
            )
            .await?
        }
        "website" => {
            let event = website::record_agent_website_delivery(
                pool.get_ref(),
                &organization_id,
                body.external_conversation_id.trim(),
                idempotency_key,
                text,
                &body.media,
                body.ui.as_ref(),
            )
            .await?
            .ok_or_else(|| AppError::NotFound("Website Chat session not found".to_string()))?;
            serde_json::json!({ "providerMessageId": event.id, "status": "sent" })
        }
        "facebook" | "instagram" => {
            if !body.buttons.is_empty() || !body.media.is_empty() {
                return Err(AppError::BadRequest(
                    "Facebook and Instagram agent replies support text only".to_string(),
                ));
            }
            inbox::deliver_agent_meta_message(
                pool.get_ref(),
                &organization_id,
                body.external_conversation_id.trim(),
                text,
                idempotency_key,
            )
            .await?
        }
        _ => {
            return Err(AppError::BadRequest(format!(
                "Agent delivery channel is not supported: {channel_type}"
            )))
        }
    };
    observability::tracing::info!(
        event = "http.request.completed",
        operation = "channel.delivery",
        channel = %channel_type,
        organization_id = %organization_id,
        actor_id = %actor_id,
        media_count = body.media.len(),
        "agent channel delivery completed"
    );
    Ok(HttpResponse::Ok().json(result))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::{
        agent_connection_summary, bounded_agent_contact_limit, bounded_agent_template_limit,
        normalize_agent_connection_filter, resolve_credit_idempotency_key, AgentCollectionQuery,
    };
    use crate::db::models::ExternalConnection;
    use crate::identity::principal::{Principal, PrincipalKind};
    use crate::identity::request_context::RequestContext;
    use std::collections::BTreeSet;

    #[test]
    fn agent_collection_limits_are_bounded_without_silent_clamping() {
        assert_eq!(
            AgentCollectionQuery { limit: None }
                .bounded_limit()
                .unwrap(),
            100
        );
        assert_eq!(
            AgentCollectionQuery { limit: Some(200) }
                .bounded_limit()
                .unwrap(),
            200
        );
        assert!(AgentCollectionQuery { limit: Some(0) }
            .bounded_limit()
            .is_err());
        assert!(AgentCollectionQuery { limit: Some(201) }
            .bounded_limit()
            .is_err());
    }

    #[test]
    fn agent_contact_limits_are_bounded_without_silent_clamping() {
        assert_eq!(bounded_agent_contact_limit(None).unwrap(), 100);
        assert_eq!(bounded_agent_contact_limit(Some(200)).unwrap(), 200);
        assert!(bounded_agent_contact_limit(Some(0)).is_err());
        assert!(bounded_agent_contact_limit(Some(201)).is_err());
        assert!(bounded_agent_contact_limit(Some(-1)).is_err());
    }

    #[test]
    fn agent_template_limits_are_bounded_without_silent_clamping() {
        assert_eq!(bounded_agent_template_limit(None).unwrap(), 100);
        assert_eq!(bounded_agent_template_limit(Some(200)).unwrap(), 200);
        assert!(bounded_agent_template_limit(Some(0)).is_err());
        assert!(bounded_agent_template_limit(Some(201)).is_err());
        assert!(bounded_agent_template_limit(Some(-1)).is_err());
    }

    #[test]
    fn agent_connection_summary_omits_raw_identifiers() {
        let now = Utc::now();
        let summary = agent_connection_summary(&ExternalConnection {
            id: "ext_internal_connection".to_string(),
            provider: "FACEBOOK".to_string(),
            external_account_id: Some("provider-account-raw-id".to_string()),
            display_name: "KasiTek".to_string(),
            handle: Some("@kasitek".to_string()),
            status: "CONNECTED".to_string(),
            credential_status: "ACTIVE".to_string(),
            health_status: "HEALTHY".to_string(),
            webhook_status: "UNKNOWN".to_string(),
            last_checked_at: Some(now),
            last_error: None,
            metadata: Some(json!({ "secret": "never expose" })),
            capabilities: json!([]),
            permissions: json!([]),
            consumers: json!([]),
            created_at: now,
            updated_at: now,
        });

        assert_eq!(summary["provider"], "FACEBOOK");
        assert_eq!(summary["displayName"], "KasiTek");
        assert!(summary.get("id").is_none());
        assert!(summary.get("externalAccountId").is_none());
        assert!(summary.get("metadata").is_none());
    }

    #[test]
    fn agent_connection_filters_treat_empty_and_all_as_unfiltered() {
        assert_eq!(normalize_agent_connection_filter(None), None);
        assert_eq!(normalize_agent_connection_filter(Some("")), None);
        assert_eq!(normalize_agent_connection_filter(Some("  ")), None);
        assert_eq!(normalize_agent_connection_filter(Some("all")), None);
        assert_eq!(normalize_agent_connection_filter(Some(" ALL ")), None);
        assert_eq!(
            normalize_agent_connection_filter(Some("FACEBOOK")),
            Some("FACEBOOK")
        );
    }

    fn credit_context(idempotency_key: Option<&str>) -> RequestContext {
        RequestContext {
            principal: Principal {
                kind: PrincipalKind::TrustedInternalService,
                id: "agent-platform".to_string(),
                subject_user_id: None,
                client_id: None,
            },
            organization_id: "org-1".to_string(),
            user_id: None,
            client_id: None,
            installation_id: None,
            effective_grants: BTreeSet::new(),
            api_scopes: None,
            correlation_id: None,
            causation_id: None,
            idempotency_key: idempotency_key.map(str::to_string),
        }
    }

    #[test]
    fn credit_idempotency_must_match_signed_delegation() {
        let context = credit_context(Some("signed-key"));
        assert_eq!(
            resolve_credit_idempotency_key(&context, None).unwrap(),
            "signed-key"
        );
        assert!(resolve_credit_idempotency_key(&context, Some("other-key")).is_err());
    }

    #[test]
    fn fallback_credit_requests_require_an_idempotency_key() {
        let context = credit_context(None);
        assert!(resolve_credit_idempotency_key(&context, None).is_err());
        assert_eq!(
            resolve_credit_idempotency_key(&context, Some("request-key")).unwrap(),
            "request-key"
        );
    }
}
