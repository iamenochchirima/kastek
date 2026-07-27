use std::collections::BTreeSet;

use semver::Version;
use serde_json::json;

use crate::{
    ActionDefinition, ActionId, ActionLifecycle, ActorKind, ApprovalRule, AuditRule,
    ClientScopeRule, DataClassification, IdempotencyRule, ProductRuntime, RiskClass, UsageRule,
};

pub fn customer_search() -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new("customer.search", Version::new(1, 0, 0))
            .expect("catalog action name is valid"),
        owning_domain: "customer_crm".to_string(),
        title: "Search customers".to_string(),
        description: "Search customer records within the caller's authorised scope.".to_string(),
        input_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "maxLength": 200 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
                "cursor": { "type": "string", "minLength": 1, "maxLength": 512 }
            },
            "required": ["query"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "customers": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "minLength": 1 },
                            "displayName": { "type": ["string", "null"] }
                        },
                        "required": ["id", "displayName"],
                        "additionalProperties": false
                    }
                },
                "nextCursor": { "type": ["string", "null"] }
            },
            "required": ["customers", "nextCursor"],
            "additionalProperties": false
        }),
        risk: RiskClass::Read,
        approval: ApprovalRule::None,
        supported_runtimes: runtimes(),
        supported_actors: product_actors(),
        client_scope: ClientScopeRule::Optional,
        required_grants: strings(["customers.read"]),
        required_oauth_scopes: strings(["customers:read"]),
        required_entitlements: strings(["product.crm.enabled"]),
        idempotency: IdempotencyRule::NotApplicable,
        data_classification: DataClassification::Confidential,
        audit: AuditRule::Access,
        usage: UsageRule::Count,
        lifecycle: ActionLifecycle::Internal,
    }
}

fn runtimes() -> BTreeSet<ProductRuntime> {
    [ProductRuntime::Direct, ProductRuntime::WhiteLabel]
        .into_iter()
        .collect()
}

fn product_actors() -> BTreeSet<ActorKind> {
    [
        ActorKind::DirectUser,
        ActorKind::TenantStaff,
        ActorKind::TenantClient,
        ActorKind::NativeAgent,
        ActorKind::ApiClient,
        ActorKind::ExternalAgent,
    ]
    .into_iter()
    .collect()
}

fn strings<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_string).collect()
}
