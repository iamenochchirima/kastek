//! Public `/v1` transport contracts. Route mounting remains separate from the
//! legacy `/api/*` composition so the migration can be reviewed independently.

use actions::{ActionDefinition, ActionLifecycle, ActorKind, ProductRuntime};
use actix_web::{web, HttpRequest, HttpResponse};
use jwt_simple::algorithms::ECDSAP256PublicKeyLike;
use jwt_simple::prelude::{ES256PublicKey, VerificationOptions};
use serde_json::json;
use std::collections::HashSet;

use crate::bootstrap::state::AppState;
use crate::error::AppError;
use crate::identity::{product_session, request_context::RequestContext};

pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "status": "ok",
        "service": "kasitek-core",
        "apiVersion": "v1",
        "actionCatalogSize": state.action_registry.definitions().count(),
    }))
}

async fn public_context(req: &HttpRequest, state: &AppState) -> Result<RequestContext, AppError> {
    if req.headers().get("authorization").is_some() {
        return installation_context(req, state);
    }
    product_session::resolve(req, &state.pool).await
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct InstallationTokenClaims {
    #[serde(rename = "organizationId")]
    organization_id: String,
    #[serde(rename = "credentialId")]
    credential_id: String,
}

fn installation_context(req: &HttpRequest, state: &AppState) -> Result<RequestContext, AppError> {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
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

pub async fn capabilities(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let context = public_context(&req, &state).await?;
    let actions = state
        .action_registry
        .definitions()
        .filter(|definition| {
            let actor = match context.principal.kind {
                crate::identity::principal::PrincipalKind::AgentInstallation => {
                    ActorKind::ExternalAgent
                }
                _ => ActorKind::DirectUser,
            };
            is_public_action_for_actor(definition, actor)
        })
        .map(public_action)
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
    })))
}

#[cfg(test)]
mod tests {
    use super::{is_public_action_for_actor, verify_installation_token};
    use actions::{catalog::initial_registry, ActionLifecycle, ActorKind, ProductRuntime};
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
    }
}
