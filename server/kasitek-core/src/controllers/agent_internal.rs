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

use crate::capabilities::{content_adapter, core_adapter};
use crate::config::AppConfig;
use crate::db::models::{
    ConversationUpdateRequest, SocialPostUpsertRequest, WhatsappContactListQuery,
    WhatsappContactUpdateRequest, WhatsappTemplateListQuery,
};
use crate::error::AppError;
use crate::identity::internal_delegation;
use crate::identity::request_context::RequestContext;
use crate::services::{customers, whatsapp};

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
    log::info!(
        "agent core read tool=workspace.report org_id={} actor_id={}",
        organization_id,
        actor_id
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
    Ok(HttpResponse::Ok().json(json!({ "posts": posts })))
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
    Ok(HttpResponse::Ok().json(json!({ "post": post })))
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
    log::info!(
        "agent channel delivery channel={} org_id={} actor_id={}",
        channel_type,
        organization_id,
        actor_id
    );
    Ok(HttpResponse::Ok().json(result))
}

#[cfg(test)]
mod tests {
    use super::{bounded_agent_contact_limit, bounded_agent_template_limit, AgentCollectionQuery};

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
}
