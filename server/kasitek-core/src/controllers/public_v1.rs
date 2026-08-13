//! Public `/v1` transport contracts. Route mounting remains separate from the
//! legacy `/api/*` composition so the migration can be reviewed independently.

use actions::{ActionDefinition, ActionLifecycle, ActorKind, ProductRuntime};
use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::json;

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
    product_session::resolve(req, &state.pool).await
}

fn is_public_action(definition: &ActionDefinition) -> bool {
    definition.lifecycle == ActionLifecycle::Public
        && definition
            .supported_runtimes
            .contains(&ProductRuntime::Direct)
        && definition.supported_actors.contains(&ActorKind::DirectUser)
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
        .filter(|definition| is_public_action(definition))
        .map(public_action)
        .collect::<Vec<_>>();
    let mut response = HttpResponse::Ok();
    if let Some(correlation_id) = context.correlation_id.as_deref() {
        response.insert_header(("x-correlation-id", correlation_id.to_string()));
    }
    Ok(response.json(json!({
        "version": "v1",
        "principal": {
            "kind": "direct_user",
            "id": context.principal.id,
            "organizationId": context.organization_id,
        },
        "actions": actions,
    })))
}

#[cfg(test)]
mod tests {
    use super::is_public_action;
    use actions::{catalog::initial_registry, ActionLifecycle, ProductRuntime};

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
            .any(|definition| !is_public_action(definition)));
        for definition in definitions
            .iter()
            .filter(|definition| is_public_action(definition))
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
            .find(|definition| is_public_action(definition))
            .expect("public action");
        let payload = super::public_action(definition);
        assert!(payload.get("name").is_some());
        assert!(payload.get("owningDomain").is_some());
        assert!(payload.get("handler").is_none());
    }
}
