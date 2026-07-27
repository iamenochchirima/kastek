use std::collections::BTreeSet;

use actions::{
    catalog, ActionError, ActionId, ActionLifecycle, ActionRegistry, Actor, ActorKind,
    ClientAccess, ClientScopeRule, IdentityRealm, IncomingActionRequest, ProductRuntime,
    RegistryFilter, Scope,
};
use chrono::{Duration, Utc};
use serde_json::json;

fn direct_actor() -> Actor {
    Actor {
        kind: ActorKind::DirectUser,
        id: "user-direct-1".to_string(),
        realm: IdentityRealm::Direct,
        authenticated_client_id: None,
        delegated_by: None,
    }
}

fn tenant_staff_actor() -> Actor {
    Actor {
        kind: ActorKind::TenantStaff,
        id: "tenant-user-1".to_string(),
        realm: IdentityRealm::WhiteLabel,
        authenticated_client_id: None,
        delegated_by: None,
    }
}

fn tenant_client_actor() -> Actor {
    Actor {
        kind: ActorKind::TenantClient,
        id: "tenant-client-user-1".to_string(),
        realm: IdentityRealm::WhiteLabel,
        authenticated_client_id: None,
        delegated_by: None,
    }
}

fn request(actor: Actor, scope: Scope, input: serde_json::Value) -> IncomingActionRequest {
    IncomingActionRequest {
        invocation_id: "invocation-1".to_string(),
        correlation_id: "correlation-1".to_string(),
        causation_id: None,
        action: ActionId::parse("customer.search", "1.0.0").unwrap(),
        actor,
        scope,
        input,
        idempotency_key: None,
        approval_id: None,
        requested_at: Utc::now(),
        deadline: Some(Utc::now() + Duration::seconds(30)),
    }
}

#[test]
fn initial_catalog_registers_in_deterministic_order() {
    let registry = catalog::initial_registry().expect("initial catalog should compile");
    let ids = registry
        .definitions()
        .map(|definition| definition.id.to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        ids,
        vec![
            "conversation.draft_reply@1.0.0",
            "conversation.get_summary@1.0.0",
            "customer.search@1.0.0",
        ]
    );
    assert!(registry
        .definitions()
        .all(|definition| definition.lifecycle == ActionLifecycle::Internal));
}

#[test]
fn duplicate_action_versions_are_rejected() {
    let definition = catalog::customer_search();
    let mut registry = ActionRegistry::new();
    registry.register(definition.clone()).unwrap();

    assert_eq!(
        registry.register(definition),
        Err(ActionError::DuplicateAction(
            "customer.search@1.0.0".to_string()
        ))
    );
}

#[test]
fn invalid_schema_documents_are_rejected_at_registration() {
    let mut definition = catalog::customer_search();
    definition.input_schema = json!({"type": "not-a-json-schema-type"});

    let error = ActionRegistry::from_definitions([definition]).unwrap_err();
    assert!(matches!(error, ActionError::InvalidSchema { .. }));
}

#[test]
fn top_level_action_schemas_must_be_objects() {
    let mut definition = catalog::customer_search();
    definition.output_schema = json!({"type": "string"});

    let error = ActionRegistry::from_definitions([definition]).unwrap_err();
    assert!(matches!(error, ActionError::InvalidSchema { .. }));
}

#[test]
fn direct_request_validates_with_direct_scope() {
    let registry = catalog::initial_registry().unwrap();
    let request = request(
        direct_actor(),
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "Nandi", "limit": 25}),
    );

    assert!(registry.validate_request(request).is_ok());
}

#[test]
fn approval_identifier_must_be_non_empty_when_present() {
    let registry = catalog::initial_registry().unwrap();
    let mut request = request(
        direct_actor(),
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "Nandi"}),
    );
    request.approval_id = Some(" ".to_string());

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message)) if message == "approval ID cannot be empty"
    ));
}

#[test]
fn missing_actor_and_owner_identifiers_fail_closed() {
    let registry = catalog::initial_registry().unwrap();
    let mut actor = direct_actor();
    actor.id.clear();
    let missing_actor = request(
        actor,
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "Nandi"}),
    );
    assert!(matches!(
        registry.validate_request(missing_actor),
        Err(ActionError::InvalidRequest(message)) if message == "actor ID cannot be empty"
    ));

    let missing_organisation = request(
        direct_actor(),
        Scope::Direct {
            organisation_id: "".to_string(),
        },
        json!({"query": "Nandi"}),
    );
    assert!(matches!(
        registry.validate_request(missing_organisation),
        Err(ActionError::InvalidRequest(message)) if message == "organisation ID cannot be empty"
    ));

    let missing_workspace = request(
        tenant_staff_actor(),
        Scope::TenantStaff {
            workspace_id: "".to_string(),
            client_access: ClientAccess::All,
        },
        json!({"query": "Nandi"}),
    );
    assert!(matches!(
        registry.validate_request(missing_workspace),
        Err(ActionError::InvalidRequest(message)) if message == "workspace ID cannot be empty"
    ));
}

#[test]
fn direct_identity_cannot_enter_white_label_scope() {
    let registry = catalog::initial_registry().unwrap();
    let request = request(
        direct_actor(),
        Scope::TenantStaff {
            workspace_id: "workspace-1".to_string(),
            client_access: ClientAccess::All,
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "actor identity realm does not match the product runtime"
    ));
}

#[test]
fn white_label_identity_cannot_enter_direct_scope() {
    let registry = catalog::initial_registry().unwrap();
    let request = request(
        tenant_staff_actor(),
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "actor identity realm does not match the product runtime"
    ));
}

#[test]
fn tenant_client_requires_a_non_empty_client_scope() {
    let registry = catalog::initial_registry().unwrap();
    let request = request(
        tenant_client_actor(),
        Scope::TenantClient {
            workspace_id: "workspace-1".to_string(),
            tenant_client_id: "".to_string(),
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "tenant client ID cannot be empty"
    ));
}

#[test]
fn tenant_client_cannot_use_tenant_staff_scope() {
    let registry = catalog::initial_registry().unwrap();
    let request = request(
        tenant_client_actor(),
        Scope::TenantStaff {
            workspace_id: "workspace-1".to_string(),
            client_access: ClientAccess::All,
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "tenant client actors require tenant-client scope"
    ));
}

#[test]
fn input_schema_rejects_unknown_and_invalid_fields() {
    let registry = catalog::initial_registry().unwrap();
    let invalid = request(
        direct_actor(),
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "", "unexpected": true}),
    );

    assert!(matches!(
        registry.validate_request(invalid),
        Err(ActionError::SchemaViolation { .. })
    ));
}

#[test]
fn output_schema_is_enforced() {
    let registry = catalog::initial_registry().unwrap();
    let id = ActionId::parse("customer.search", "1.0.0").unwrap();

    assert!(registry
        .validate_output(
            &id,
            &json!({
                "customers": [{"id": "customer-1", "displayName": "Nandi"}],
                "nextCursor": null
            }),
        )
        .is_ok());
    assert!(matches!(
        registry.validate_output(&id, &json!({"customers": []})),
        Err(ActionError::SchemaViolation { .. })
    ));
}

#[test]
fn machine_actors_require_an_authenticated_client() {
    let registry = catalog::initial_registry().unwrap();
    let machine = Actor {
        kind: ActorKind::ExternalAgent,
        id: "agent-1".to_string(),
        realm: IdentityRealm::Direct,
        authenticated_client_id: None,
        delegated_by: None,
    };
    let request = request(
        machine,
        Scope::Direct {
            organisation_id: "org-1".to_string(),
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "machine actors require an authenticated client ID"
    ));
}

#[test]
fn action_client_scope_rule_is_enforced() {
    let mut definition = catalog::customer_search();
    definition.client_scope = ClientScopeRule::Required;
    definition.supported_runtimes = [ProductRuntime::WhiteLabel].into_iter().collect();
    let registry = ActionRegistry::from_definitions([definition]).unwrap();
    let request = request(
        tenant_staff_actor(),
        Scope::TenantStaff {
            workspace_id: "workspace-1".to_string(),
            client_access: ClientAccess::All,
        },
        json!({"query": "Nandi"}),
    );

    assert!(matches!(
        registry.validate_request(request),
        Err(ActionError::InvalidRequest(message))
            if message == "action requires tenant-client scope"
    ));
}

#[test]
fn registry_discovery_filters_by_runtime_actor_lifecycle_and_grants() {
    let registry = catalog::initial_registry().unwrap();
    let grants = BTreeSet::from(["customers.read".to_string()]);
    let definitions = registry
        .discoverable_definitions(RegistryFilter {
            runtime: ProductRuntime::Direct,
            actor: ActorKind::DirectUser,
            lifecycle: Some(ActionLifecycle::Internal),
            grants: &grants,
        })
        .map(|definition| definition.id.to_string())
        .collect::<Vec<_>>();

    assert_eq!(definitions, vec!["customer.search@1.0.0"]);
}
