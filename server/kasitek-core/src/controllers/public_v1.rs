//! Public `/v1` transport contracts. Route mounting remains separate from the
//! legacy `/api/*` composition so the migration can be reviewed independently.

use actions::{ActionDefinition, ActionLifecycle, ActorKind, ProductRuntime};
use actix_web::{web, HttpMessage, HttpRequest, HttpResponse, HttpResponseBuilder};
use jwt_simple::algorithms::ECDSAP256PublicKeyLike;
use jwt_simple::prelude::{ES256PublicKey, VerificationOptions};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

use crate::bootstrap::state::AppState;
use crate::capabilities::content_adapter;
use crate::db::models::{
    SocialPostUpsertRequest, WhatsappContactListQuery, WhatsappTemplateListQuery,
};
use crate::domains::bookings::transport::BookingListResponse;
use crate::error::AppError;
use crate::identity::{product_session, request_context::RequestContext};
use crate::services::agent_platform::AgentPlatformClient;
use crate::services::{inbox, public_api, whatsapp};

pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "status": "ok",
        "service": "kasitek-core",
        "apiVersion": "v1",
        "actionCatalogSize": state.action_registry.definitions().count(),
    }))
}

pub async fn openapi() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/json")
        .body(include_str!("../../openapi/v1.json"))
}

pub async fn metrics(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    let metrics = public_api::metrics(&state.pool, &context).await?;
    Ok(response_with_context(&context).json(metrics))
}

async fn public_context(req: &HttpRequest, state: &AppState) -> Result<RequestContext, AppError> {
    // Product user sessions are opaque bearer values. A JWT-shaped bearer value
    // is an attempted Agent installation credential and must never fall through
    // to cookie/session authentication when signature or claim validation fails.
    let context = if installation_bearer_token(req).is_some() {
        installation_context(req, state)?
    } else {
        product_session::resolve(req, &state.pool).await?
    };
    let audit = public_api::begin_request(
        &state.pool,
        state.config.public_api_rate_limit_per_minute,
        &context,
        req.method().as_str(),
        req.path(),
    )
    .await?;
    req.extensions_mut().insert(audit);
    Ok(context)
}

fn installation_bearer_token(req: &HttpRequest) -> Option<&str> {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    (token.split('.').count() == 3).then_some(token)
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct InstallationTokenClaims {
    #[serde(rename = "organizationId")]
    organization_id: String,
    #[serde(rename = "credentialId")]
    credential_id: String,
}

fn installation_context(req: &HttpRequest, state: &AppState) -> Result<RequestContext, AppError> {
    let token = installation_bearer_token(req).ok_or(AppError::Unauthorized)?;
    let public_key = state
        .config
        .agents_installation_token_public_key
        .as_deref()
        .ok_or(AppError::Unauthorized)?;
    let (installation_id, organization_id, credential_id) = verify_installation_token(
        public_key,
        &state.config.agents_installation_token_issuer,
        token,
    )?;
    Ok(RequestContext {
        principal: crate::identity::principal::Principal {
            kind: crate::identity::principal::PrincipalKind::AgentInstallation,
            id: installation_id.clone(),
            subject_user_id: None,
            client_id: Some(credential_id),
        },
        organization_id,
        user_id: None,
        client_id: None,
        installation_id: Some(installation_id),
        effective_grants: Default::default(),
        correlation_id: optional_header(req, "x-correlation-id"),
        causation_id: optional_header(req, "x-causation-id"),
        idempotency_key: optional_header(req, "idempotency-key"),
    })
}

fn verify_installation_token(
    public_key_pem: &str,
    issuer: &str,
    token: &str,
) -> Result<(String, String, String), AppError> {
    let key = ES256PublicKey::from_pem(public_key_pem).map_err(|_| AppError::Unauthorized)?;
    let mut allowed_audiences = HashSet::new();
    allowed_audiences.insert("kasitek-public-api".to_string());
    let options = VerificationOptions {
        allowed_issuers: Some([issuer.to_string()].into_iter().collect()),
        allowed_audiences: Some(allowed_audiences),
        max_validity: Some(std::time::Duration::from_secs(3600).into()),
        ..VerificationOptions::default()
    };
    let claims = key
        .verify_token::<InstallationTokenClaims>(token, Some(options))
        .map_err(|_| AppError::Unauthorized)?;
    let installation_id = claims.subject.clone().ok_or(AppError::Unauthorized)?;
    if installation_id.trim().is_empty()
        || claims.custom.organization_id.trim().is_empty()
        || claims.custom.credential_id.trim().is_empty()
        || claims
            .jwt_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(AppError::Unauthorized);
    }
    Ok((
        installation_id,
        claims.custom.organization_id,
        claims.custom.credential_id,
    ))
}

fn optional_header(req: &HttpRequest, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
}

fn is_public_action_for_actor(definition: &ActionDefinition, actor: ActorKind) -> bool {
    definition.lifecycle == ActionLifecycle::Public
        && definition
            .supported_runtimes
            .contains(&ProductRuntime::Direct)
        && definition.supported_actors.contains(&actor)
}

fn actor_for_context(context: &RequestContext) -> ActorKind {
    match context.principal.kind {
        crate::identity::principal::PrincipalKind::AgentInstallation => ActorKind::ExternalAgent,
        _ => ActorKind::DirectUser,
    }
}

fn installation_action_allowed(
    definition: &ActionDefinition,
    capability_payload: &serde_json::Value,
) -> bool {
    let granted_scopes = capability_payload
        .get("capabilities")
        .and_then(serde_json::Value::as_array)
        .map(|capabilities| {
            capabilities
                .iter()
                .filter(|capability| {
                    let status = capability
                        .get("availability")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("available");
                    status == "available"
                })
                .filter_map(|capability| {
                    capability
                        .get("manifest")
                        .and_then(|manifest| manifest.get("requiredScope"))
                        .and_then(serde_json::Value::as_str)
                })
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    if !definition
        .required_grants
        .iter()
        .all(|grant| granted_scopes.contains(grant.as_str()))
    {
        return false;
    }
    let required_api_scope = if matches!(definition.risk, actions::RiskClass::Read) {
        "api:read"
    } else {
        "api:write"
    };
    capability_payload
        .get("apiScopes")
        .and_then(serde_json::Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .any(|scope| scope.as_str() == Some(required_api_scope))
        })
        .unwrap_or(false)
}

async fn require_public_action(
    req: &HttpRequest,
    state: &AppState,
    context: &RequestContext,
    name: &str,
) -> Result<(), AppError> {
    let definition = state
        .action_registry
        .definitions()
        .find(|definition| {
            definition.id.name() == name
                && is_public_action_for_actor(definition, actor_for_context(context))
        })
        .ok_or_else(|| AppError::Forbidden(format!("Public capability is unavailable: {name}")))?;
    set_public_audit_action(req, name);
    if !matches!(
        context.principal.kind,
        crate::identity::principal::PrincipalKind::AgentInstallation
    ) {
        return Ok(());
    }
    let capabilities = AgentPlatformClient::from_config(&state.config)?
        .list_installation_capabilities(
            &context.organization_id,
            &context.principal.id,
            context
                .installation_id
                .as_deref()
                .ok_or(AppError::Unauthorized)?,
            context.principal.client_id.as_deref(),
        )
        .await?;
    if installation_action_allowed(definition, &capabilities) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "Public capability is unavailable: {name}"
        )))
    }
}

fn set_public_audit_action(req: &HttpRequest, action: &str) {
    if let Some(audit) = req
        .extensions()
        .get::<public_api::RequestAuditHandle>()
        .cloned()
    {
        req.extensions_mut().insert(public_api::RequestAuditHandle {
            id: audit.id,
            action: Some(action.to_string()),
        });
    }
}

fn public_action_allowed(
    definition: &ActionDefinition,
    actor: ActorKind,
    allowed_grants: Option<&HashSet<String>>,
    allowed_api_scopes: Option<&HashSet<String>>,
    entitlements: &HashSet<String>,
) -> bool {
    if !is_public_action_for_actor(definition, actor) {
        return false;
    }
    let grants_ok = allowed_grants
        .map(|grants| {
            definition
                .required_grants
                .iter()
                .all(|grant| grants.contains(grant))
        })
        .unwrap_or(true);
    let scope_ok = allowed_api_scopes
        .map(|scopes| {
            let required = if matches!(definition.risk, actions::RiskClass::Read) {
                "api:read"
            } else {
                "api:write"
            };
            scopes.contains(required)
        })
        .unwrap_or(true);
    let entitlements_ok = definition
        .required_entitlements
        .iter()
        .all(|entitlement| entitlements.contains(entitlement));
    grants_ok && scope_ok && entitlements_ok
}

fn response_with_context(context: &RequestContext) -> HttpResponseBuilder {
    let mut response = HttpResponse::Ok();
    if let Some(correlation_id) = context.correlation_id.as_deref() {
        response.insert_header(("x-correlation-id", correlation_id.to_string()));
    }
    response
}

fn public_action(definition: &ActionDefinition) -> serde_json::Value {
    json!({
        "name": definition.id.name(),
        "version": definition.id.version().to_string(),
        "owningDomain": definition.owning_domain,
        "title": definition.title,
        "description": definition.description,
        "inputSchema": definition.input_schema,
        "outputSchema": definition.output_schema,
        "risk": definition.risk,
        "approval": definition.approval,
        "idempotency": definition.idempotency,
        "requiredGrants": definition.required_grants,
        "requiredOAuthScopes": definition.required_oauth_scopes,
        "requiredEntitlements": definition.required_entitlements,
        "dataClassification": definition.data_classification,
        "audit": definition.audit,
        "usage": definition.usage,
    })
}

fn redact_keys(value: &mut serde_json::Value, keys: &[&str]) {
    match value {
        serde_json::Value::Object(object) => {
            for key in keys {
                object.remove(*key);
            }
            for child in object.values_mut() {
                redact_keys(child, keys);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_keys(item, keys);
            }
        }
        _ => {}
    }
}

fn redacted(value: serde_json::Value, keys: &[&str]) -> serde_json::Value {
    let mut value = value;
    redact_keys(&mut value, keys);
    value
}

#[derive(Debug, Deserialize)]
pub struct CapabilitiesQuery {
    pub limit: Option<usize>,
    pub cursor: Option<usize>,
    pub version: Option<String>,
}

async fn active_entitlements(
    state: &AppState,
    organization_id: &str,
) -> Result<HashSet<String>, AppError> {
    let rows = sqlx::query_scalar::<_, String>(
        r#"
        SELECT key
        FROM "OrganizationEntitlementGrant"
        WHERE "orgId" = $1
          AND "startsAt" <= NOW()
          AND ("endsAt" IS NULL OR "endsAt" > NOW())
          AND jsonb_typeof(value) = 'boolean'
          AND (value #>> '{}')::boolean = TRUE
        UNION
        SELECT entitlement.key
        FROM "OrganizationSubscription" subscription
        JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"
        WHERE subscription."orgId" = $1
          AND subscription.status IN (
            'TRIAL'::"OrganizationSubscriptionStatus",
            'ACTIVE'::"OrganizationSubscriptionStatus",
            'GRACE'::"OrganizationSubscriptionStatus"
          )
          AND jsonb_typeof(entitlement.value) = 'boolean'
          AND (entitlement.value #>> '{}')::boolean = TRUE
        "#,
    )
    .bind(organization_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|error| {
        AppError::Internal(format!(
            "Failed to resolve public API entitlements: {error}"
        ))
    })?;
    Ok(rows.into_iter().collect())
}

pub async fn capabilities(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<CapabilitiesQuery>,
) -> Result<HttpResponse, AppError> {
    let limit = query.limit.unwrap_or(100);
    if !(1..=200).contains(&limit) {
        return Err(AppError::BadRequest(
            "capabilities limit must be between 1 and 200".to_string(),
        ));
    }
    let cursor = query.cursor.unwrap_or(0);
    if query
        .version
        .as_deref()
        .is_some_and(|version| version != "v1")
    {
        return Err(AppError::BadRequest(
            "unsupported capabilities version".to_string(),
        ));
    }
    let context = public_context(&req, &state).await?;
    set_public_audit_action(&req, "capabilities.list");
    let actor = actor_for_context(&context);
    let entitlements = active_entitlements(&state, &context.organization_id).await?;
    let mut allowed_grants: Option<HashSet<String>> = None;
    let mut allowed_api_scopes: Option<HashSet<String>> = None;
    if matches!(
        context.principal.kind,
        crate::identity::principal::PrincipalKind::AgentInstallation
    ) {
        let credential_id = context.principal.client_id.as_deref();
        let capability_payload = AgentPlatformClient::from_config(&state.config)?
            .list_installation_capabilities(
                &context.organization_id,
                &context.principal.id,
                context
                    .installation_id
                    .as_deref()
                    .ok_or(AppError::Unauthorized)?,
                credential_id,
            )
            .await?;
        let mut grants = HashSet::new();
        if let Some(capabilities) = capability_payload
            .get("capabilities")
            .and_then(|value| value.as_array())
        {
            for capability in capabilities {
                let available = capability
                    .get("availability")
                    .and_then(|value| value.as_str())
                    .unwrap_or("available");
                if available == "not_granted"
                    || available == "not_configured"
                    || available == "unhealthy"
                {
                    continue;
                }
                if let Some(scope) = capability
                    .get("manifest")
                    .and_then(|value| value.get("requiredScope"))
                    .and_then(|value| value.as_str())
                {
                    grants.insert(scope.to_string());
                }
            }
        }
        allowed_grants = Some(grants);
        allowed_api_scopes = capability_payload
            .get("apiScopes")
            .and_then(|value| value.as_array())
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(|scope| scope.as_str().map(str::to_string))
                    .collect()
            });
    }
    let actions = state
        .action_registry
        .definitions()
        .filter(|definition| {
            public_action_allowed(
                definition,
                actor,
                allowed_grants.as_ref(),
                allowed_api_scopes.as_ref(),
                &entitlements,
            )
        })
        .map(public_action)
        .collect::<Vec<_>>();
    let total = actions.len();
    if cursor > total {
        return Err(AppError::BadRequest(
            "capabilities cursor is past the end of the result".to_string(),
        ));
    }
    let next_cursor = (cursor + limit < total).then_some(cursor + limit);
    let actions = actions
        .into_iter()
        .skip(cursor)
        .take(limit)
        .collect::<Vec<_>>();
    let mut response = HttpResponse::Ok();
    if let Some(correlation_id) = context.correlation_id.as_deref() {
        response.insert_header(("x-correlation-id", correlation_id.to_string()));
    }
    Ok(response.json(json!({
        "version": "v1",
        "principal": {
            "kind": match context.principal.kind {
                crate::identity::principal::PrincipalKind::AgentInstallation => "agent_installation",
                _ => "direct_user",
            },
            "id": context.principal.id,
            "organizationId": context.organization_id,
        },
        "actions": actions,
        "pagination": {
            "limit": limit,
            "cursor": cursor,
            "nextCursor": next_cursor,
            "total": total,
            "version": "v1",
        },
    })))
}

pub async fn list_content_posts(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "content.posts.list").await?;
    let posts = content_adapter::list_posts(&state.pool, &context).await?;
    Ok(response_with_context(&context).json(json!({ "posts": posts })))
}

pub async fn get_content_post(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "content.posts.list").await?;
    let post = content_adapter::get_post(&state.pool, &context, &path.into_inner())
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    Ok(response_with_context(&context).json(json!({ "post": post })))
}

pub async fn get_content_post_activity(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "content.posts.list").await?;
    let activity = content_adapter::get_activity(&state.pool, &context, &path.into_inner())
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    Ok(response_with_context(&context).json(activity))
}

pub async fn create_content_draft(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "content.posts.draft.create").await?;
    let post = content_adapter::create_draft(&state.pool, &context, &body).await?;
    Ok(response_with_context(&context)
        .status(actix_web::http::StatusCode::CREATED)
        .json(json!({ "post": post })))
}

pub async fn update_content_draft(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "content.posts.draft.update").await?;
    let post =
        content_adapter::update_draft(&state.pool, &context, &path.into_inner(), &body).await?;
    Ok(response_with_context(&context).json(json!({ "post": post })))
}

pub async fn list_contacts(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<WhatsappContactListQuery>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "contacts.list").await?;
    let contacts =
        whatsapp::list_contacts(&state.pool, &context.organization_id, query.into_inner()).await?;
    Ok(response_with_context(&context).json(redacted(
        contacts,
        &["phone", "metadata", "lastMarketingSent"],
    )))
}

pub async fn list_inbox_conversations(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "inbox.conversations.list").await?;
    let conversations =
        inbox::list_inbox_conversations(&state.pool, &context.organization_id).await?;
    Ok(response_with_context(&context).json(redacted(
        conversations,
        &["phone", "lastMessage", "customerIdentifier"],
    )))
}

pub async fn list_inbox_messages(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "inbox.messages.list").await?;
    let messages = inbox::list_conversation_messages(
        &state.pool,
        &context.organization_id,
        &path.into_inner(),
    )
    .await?;
    Ok(response_with_context(&context).json(redacted(
        messages,
        &["content", "attachments", "customerIdentifier"],
    )))
}

pub async fn list_bookings(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "bookings.list").await?;
    let bookings = crate::domains::bookings::queries::list_bookings(&state.pool, &context).await?;
    let payload = serde_json::to_value(BookingListResponse::new(bookings))
        .map_err(|_| AppError::Internal("Failed to serialize bookings".to_string()))?;
    Ok(response_with_context(&context).json(redacted(payload, &["contactPhone", "notes"])))
}

pub async fn list_campaigns(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "campaigns.list").await?;
    let campaigns = whatsapp::list_campaigns(&state.pool, &context.organization_id).await?;
    Ok(response_with_context(&context).json(redacted(
        campaigns,
        &[
            "templateBody",
            "templateButtons",
            "recipientPhone",
            "contactMetadata",
        ],
    )))
}

pub async fn get_campaign_summary(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "campaigns.get").await?;
    let campaign =
        whatsapp::get_campaign_summary(&state.pool, &context.organization_id, &path.into_inner())
            .await?;
    Ok(response_with_context(&context).json(redacted(
        campaign,
        &[
            "templateBody",
            "templateButtons",
            "recipientPhone",
            "contactMetadata",
        ],
    )))
}

pub async fn list_templates(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<WhatsappTemplateListQuery>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&req, &state, &context, "templates.list").await?;
    let templates =
        whatsapp::list_templates(&state.pool, &context.organization_id, query.into_inner()).await?;
    Ok(response_with_context(&context).json(redacted(
        templates,
        &["body", "buttons", "header", "footer"],
    )))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        installation_action_allowed, installation_bearer_token, is_public_action_for_actor,
        public_action_allowed, redacted, verify_installation_token,
    };
    use actions::{catalog::initial_registry, ActionLifecycle, ActorKind, ProductRuntime};
    use actix_web::test::TestRequest;
    use jwt_simple::{
        algorithms::ECDSAP256KeyPairLike,
        prelude::{Claims, Duration, ES256KeyPair},
    };

    fn all_definitions() -> Vec<actions::ActionDefinition> {
        let registry = initial_registry().expect("catalog");
        registry
            .definitions()
            .cloned()
            .chain(crate::capabilities::catalog::definitions())
            .collect()
    }

    #[test]
    fn public_discovery_excludes_internal_and_unsupported_runtime_actions() {
        let definitions = all_definitions();
        assert!(definitions
            .iter()
            .any(|definition| definition.lifecycle == ActionLifecycle::Public));
        assert!(definitions
            .iter()
            .any(|definition| { !is_public_action_for_actor(definition, ActorKind::DirectUser) }));
        for definition in definitions
            .iter()
            .filter(|definition| is_public_action_for_actor(definition, ActorKind::DirectUser))
        {
            assert_eq!(definition.lifecycle, ActionLifecycle::Public);
            assert!(definition
                .supported_runtimes
                .contains(&ProductRuntime::Direct));
        }
    }

    #[test]
    fn installation_invocation_requires_live_grant_and_api_scope() {
        let definition = all_definitions()
            .into_iter()
            .find(|definition| definition.id.name() == "content.posts.list")
            .expect("content list action");
        let allowed = serde_json::json!({
            "apiScopes": ["api:read"],
            "capabilities": [{
                "availability": "available",
                "manifest": { "requiredScope": "content.read" }
            }]
        });
        assert!(installation_action_allowed(&definition, &allowed));
        assert!(!installation_action_allowed(
            &definition,
            &serde_json::json!({ "apiScopes": ["api:read"], "capabilities": [] })
        ));
        assert!(!installation_action_allowed(
            &definition,
            &serde_json::json!({
                "apiScopes": ["api:write"],
                "capabilities": [{ "availability": "available", "manifest": { "requiredScope": "content.read" } }]
            })
        ));
        assert!(!installation_action_allowed(
            &definition,
            &serde_json::json!({
                "apiScopes": ["api:read"],
                "capabilities": [{ "availability": "revoked", "manifest": { "requiredScope": "content.read" } }]
            })
        ));
    }

    #[test]
    fn public_openapi_document_is_valid_and_covers_current_v1_routes() {
        let document: serde_json::Value =
            serde_json::from_str(include_str!("../../openapi/v1.json"))
                .expect("valid OpenAPI JSON");
        assert_eq!(
            document.get("openapi").and_then(|value| value.as_str()),
            Some("3.1.0")
        );
        let operations = [
            ("/health", "get", &["200"][..]),
            ("/capabilities", "get", &["200", "400", "401", "403"][..]),
            ("/metrics", "get", &["200", "401"][..]),
            ("/content/posts", "get", &["200", "401", "403"][..]),
            ("/content/posts", "post", &["201", "400", "401", "403"][..]),
            (
                "/content/posts/{id}",
                "get",
                &["200", "401", "403", "404"][..],
            ),
            (
                "/content/posts/{id}",
                "patch",
                &["200", "400", "401", "403", "404"][..],
            ),
            (
                "/content/posts/{id}/activity",
                "get",
                &["200", "401", "403", "404"][..],
            ),
            ("/contacts", "get", &["200", "401", "403"][..]),
            ("/inbox/conversations", "get", &["200", "401", "403"][..]),
            (
                "/inbox/conversations/{id}/messages",
                "get",
                &["200", "401", "403", "404"][..],
            ),
            ("/bookings", "get", &["200", "401", "403"][..]),
            ("/campaigns", "get", &["200", "401", "403"][..]),
            ("/campaigns/{id}", "get", &["200", "401", "403", "404"][..]),
            ("/templates", "get", &["200", "401", "403"][..]),
        ];
        for (path, method, statuses) in operations {
            let operation = document
                .get("paths")
                .and_then(|paths| paths.get(path))
                .and_then(|path_item| path_item.get(method))
                .unwrap_or_else(|| panic!("missing OpenAPI operation {method} {path}"));
            for status in statuses {
                let response = operation
                    .get("responses")
                    .and_then(|responses| responses.get(status))
                    .unwrap_or_else(|| panic!("missing response {status} for {method} {path}"));
                assert!(response.get("$ref").is_some() || response.get("description").is_some(), "response {status} for {method} {path} has no description or component reference");
            }
            if path == "/health" {
                assert_eq!(
                    operation
                        .get("security")
                        .and_then(|security| security.as_array())
                        .map(Vec::len),
                    Some(0)
                );
            } else {
                assert!(
                    document
                        .get("security")
                        .and_then(|security| security.as_array())
                        .is_some(),
                    "protected operation {method} {path} has no document security contract"
                );
            }
        }
        assert!(document
            .pointer("/components/securitySchemes/bearerInstallation")
            .is_some());
    }

    #[test]
    fn public_action_payload_is_not_the_internal_definition_shape() {
        let definitions = all_definitions();
        let definition = definitions
            .iter()
            .find(|definition| is_public_action_for_actor(definition, ActorKind::DirectUser))
            .expect("public action");
        let payload = super::public_action(definition);
        assert!(payload.get("name").is_some());
        assert!(payload.get("owningDomain").is_some());
        assert!(payload.get("handler").is_none());
    }

    #[test]
    fn content_public_actions_are_read_and_draft_only() {
        let registry = actions::catalog::initial_registry().expect("catalog");
        let mut action_registry = registry;
        for definition in crate::capabilities::catalog::definitions() {
            action_registry.register(definition).expect("definition");
        }
        let state = action_registry;
        let direct = state
            .definitions()
            .any(|definition| definition.id.name() == "content.posts.list");
        let publish = state.definitions().any(|definition| {
            definition.id.name() == "content.posts.publish"
                && definition.lifecycle == ActionLifecycle::Public
        });
        assert!(direct);
        assert!(!publish);
    }

    #[test]
    fn installation_discovery_requires_all_grants_and_the_matching_api_scope() {
        let definitions = all_definitions();
        let draft = definitions
            .iter()
            .find(|definition| definition.id.name() == "content.posts.draft.create")
            .expect("draft action");
        let entitlements = HashSet::from(["feature.social.access".to_string()]);
        let read_only = HashSet::from(["api:read".to_string(), "content.write".to_string()]);
        assert!(!public_action_allowed(
            draft,
            ActorKind::ExternalAgent,
            Some(&HashSet::from(["content.write".to_string()])),
            Some(&read_only),
            &entitlements,
        ));
        assert!(public_action_allowed(
            draft,
            ActorKind::ExternalAgent,
            Some(&HashSet::from(["content.write".to_string()])),
            Some(&HashSet::from(["api:write".to_string()])),
            &entitlements,
        ));
    }

    #[test]
    fn public_resource_redaction_removes_sensitive_nested_fields_without_changing_shape() {
        let value = redacted(
            serde_json::json!({
                "contacts": [{ "fullName": "Ada", "phone": "+2711", "metadata": { "secret": "x" } }],
                "stats": { "totalContacts": 1 }
            }),
            &["phone", "metadata"],
        );
        assert_eq!(value["contacts"][0]["fullName"], "Ada");
        assert!(value["contacts"][0].get("phone").is_none());
        assert!(value["contacts"][0].get("metadata").is_none());
        assert_eq!(value["stats"]["totalContacts"], 1);
    }

    #[test]
    fn discovery_denies_actions_when_an_entitlement_is_missing() {
        let definitions = all_definitions();
        let list = definitions
            .iter()
            .find(|definition| definition.id.name() == "content.posts.list")
            .expect("content list action");
        let grants = HashSet::from(["content.read".to_string()]);
        let scopes = HashSet::from(["api:read".to_string()]);
        assert!(!public_action_allowed(
            list,
            ActorKind::ExternalAgent,
            Some(&grants),
            Some(&scopes),
            &HashSet::new(),
        ));
    }

    #[test]
    fn installation_tokens_require_signature_issuer_audience_and_claims() {
        let key_pair = ES256KeyPair::generate();
        let custom = super::InstallationTokenClaims {
            organization_id: "org-1".to_string(),
            credential_id: "credential-1".to_string(),
        };
        let claims = Claims::with_custom_claims(custom, Duration::from_hours(1))
            .with_issuer("kasitek-agents")
            .with_audience("kasitek-public-api")
            .with_subject("installation-1")
            .with_jwt_id("token-1");
        let token = key_pair.sign(claims).expect("token");
        let public_key = key_pair.public_key().to_pem().expect("public key");
        assert_eq!(
            verify_installation_token(&public_key, "kasitek-agents", &token).expect("valid token"),
            (
                "installation-1".to_string(),
                "org-1".to_string(),
                "credential-1".to_string()
            )
        );
        assert!(verify_installation_token(&public_key, "wrong-issuer", &token).is_err());
        assert!(
            verify_installation_token(&public_key, "kasitek-agents", &format!("{token}x")).is_err()
        );

        let wrong_audience = key_pair
            .sign(
                Claims::with_custom_claims(
                    super::InstallationTokenClaims {
                        organization_id: "org-1".to_string(),
                        credential_id: "credential-1".to_string(),
                    },
                    Duration::from_hours(1),
                )
                .with_issuer("kasitek-agents")
                .with_audience("mcp")
                .with_subject("installation-1")
                .with_jwt_id("token-wrong-audience"),
            )
            .expect("wrong audience token");
        assert!(verify_installation_token(&public_key, "kasitek-agents", &wrong_audience).is_err());
    }

    #[test]
    fn only_jwt_shaped_bearers_select_installation_authentication() {
        let opaque_session = TestRequest::default()
            .insert_header(("authorization", "Bearer opaque-session-token"))
            .to_http_request();
        assert_eq!(installation_bearer_token(&opaque_session), None);

        let installation_jwt = TestRequest::default()
            .insert_header(("authorization", "Bearer header.payload.signature"))
            .to_http_request();
        assert_eq!(
            installation_bearer_token(&installation_jwt),
            Some("header.payload.signature")
        );
    }
}
