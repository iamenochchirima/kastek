use std::collections::BTreeSet;

use actions::{
    ActionDefinition, ActionId, ActionLifecycle, ActorKind, ApprovalRule, AuditRule,
    ClientScopeRule, DataClassification, IdempotencyRule, ProductRuntime, RiskClass, UsageRule,
};
use semver::Version;
use serde_json::json;

pub fn booking_list_services() -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new("bookings.services.list", Version::new(1, 0, 0))
            .expect("built-in booking action name is valid"),
        owning_domain: "bookings".to_string(),
        title: "List booking services".to_string(),
        description: "List active and inactive booking services in the caller's workspace."
            .to_string(),
        input_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false
        }),
        output_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": { "services": { "type": "array" } },
            "required": ["services"],
            "additionalProperties": false
        }),
        risk: RiskClass::Read,
        approval: ApprovalRule::None,
        supported_runtimes: [ProductRuntime::Direct].into_iter().collect(),
        supported_actors: [
            ActorKind::DirectUser,
            ActorKind::NativeAgent,
            ActorKind::ApiClient,
            ActorKind::ExternalAgent,
        ]
        .into_iter()
        .collect(),
        client_scope: ClientScopeRule::NotApplicable,
        required_grants: strings(["bookings.read"]),
        required_oauth_scopes: strings(["bookings:read"]),
        required_entitlements: strings(["feature.bookings.access"]),
        idempotency: IdempotencyRule::NotApplicable,
        data_classification: DataClassification::Confidential,
        audit: AuditRule::Access,
        usage: UsageRule::Count,
        lifecycle: ActionLifecycle::Internal,
    }
}

pub fn definitions() -> Vec<ActionDefinition> {
    vec![booking_list_services()]
}

fn strings<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_string).collect()
}
