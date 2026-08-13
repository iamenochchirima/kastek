//! Public `/v1` transport contracts. Route mounting remains separate from the
//! legacy `/api/*` composition so the migration can be reviewed independently.

use actions::{ActionDefinition, ActionLifecycle, ActorKind, ProductRuntime};
use actix_web::{web, HttpRequest, HttpResponse, HttpResponseBuilder};
use jwt_simple::algorithms::ECDSAP256PublicKeyLike;
use jwt_simple::prelude::{ES256PublicKey, VerificationOptions};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

use crate::bootstrap::state::AppState;
use crate::capabilities::content_adapter;
use crate::db::models::SocialPostUpsertRequest;
use crate::error::AppError;
use crate::identity::{product_session, request_context::RequestContext};
use crate::services::agent_platform::AgentPlatformClient;

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

async fn public_context(req: &HttpRequest, state: &AppState) -> Result<RequestContext, AppError> {
    // Product user sessions are opaque bearer values. A JWT-shaped bearer value
    // is an attempted Agent installation credential and must never fall through
    // to cookie/session authentication when signature or claim validation fails.
    if installation_bearer_token(req).is_some() {
        return installation_context(req, state);
    }
    product_session::resolve(req, &state.pool).await
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

fn require_public_action(
    state: &AppState,
    context: &RequestContext,
    name: &str,
) -> Result<(), AppError> {
    let available = state.action_registry.definitions().any(|definition| {
        definition.id.name() == name
            && is_public_action_for_actor(definition, actor_for_context(context))
    });
    if available {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "Public capability is unavailable: {name}"
        )))
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
    require_public_action(&state, &context, "content.posts.list")?;
    let posts = content_adapter::list_posts(&state.pool, &context).await?;
    Ok(response_with_context(&context).json(json!({ "posts": posts })))
}

pub async fn get_content_post(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&state, &context, "content.posts.list")?;
    let post = content_adapter::get_post(&state.pool, &context, &path.into_inner())
        .await?
        .ok_or_else(|| AppError::NotFound("Content post not found".to_string()))?;
    Ok(response_with_context(&context).json(json!({ "post": post })))
}

pub async fn create_content_draft(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<SocialPostUpsertRequest>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    require_public_action(&state, &context, "content.posts.draft.create")?;
    let post = content_adapter::create_draft(&state.pool, &context, &body).await?;
    Ok(response_with_context(&context)
        .status(actix_web::http::StatusCode::CREATED)
        .json(json!({ "post": post })))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        installation_bearer_token, is_public_action_for_actor, public_action_allowed,
        verify_installation_token,
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
    fn public_openapi_document_is_valid_and_covers_current_v1_routes() {
        let document: serde_json::Value =
            serde_json::from_str(include_str!("../../openapi/v1.json"))
                .expect("valid OpenAPI JSON");
        assert_eq!(
            document.get("openapi").and_then(|value| value.as_str()),
            Some("3.1.0")
        );
        for path in [
            "/health",
            "/capabilities",
            "/content/posts",
            "/content/posts/{id}",
        ] {
            assert!(
                document
                    .get("paths")
                    .and_then(|paths| paths.get(path))
                    .is_some(),
                "missing {path}"
            );
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
