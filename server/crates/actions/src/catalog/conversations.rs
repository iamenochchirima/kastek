use std::collections::BTreeSet;

use semver::Version;
use serde_json::json;

use crate::{
    ActionDefinition, ActionId, ActionLifecycle, ActorKind, ApprovalRule, AuditRule,
    ClientScopeRule, DataClassification, IdempotencyRule, ProductRuntime, RiskClass, UsageRule,
};

pub fn conversation_get_summary() -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new("conversation.get_summary", Version::new(1, 0, 0))
            .expect("catalog action name is valid"),
        owning_domain: "conversations".to_string(),
        title: "Get conversation summary".to_string(),
        description: "Read a scoped summary of a customer conversation.".to_string(),
        input_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "conversationId": { "type": "string", "minLength": 1, "maxLength": 128 },
                "includeRecentMessages": { "type": "boolean", "default": false }
            },
            "required": ["conversationId"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "conversationId": { "type": "string", "minLength": 1 },
                "status": { "type": "string", "minLength": 1 },
                "summary": { "type": "string" },
                "participantCount": { "type": "integer", "minimum": 0 },
                "lastMessageAt": { "type": ["string", "null"] }
            },
            "required": ["conversationId", "status", "summary", "participantCount", "lastMessageAt"],
            "additionalProperties": false
        }),
        risk: RiskClass::Read,
        approval: ApprovalRule::None,
        supported_runtimes: runtimes(),
        supported_actors: product_actors(),
        client_scope: ClientScopeRule::Optional,
        required_grants: strings(["conversations.read"]),
        required_oauth_scopes: strings(["conversations:read"]),
        required_entitlements: strings(["product.inbox.enabled"]),
        idempotency: IdempotencyRule::NotApplicable,
        data_classification: DataClassification::Restricted,
        audit: AuditRule::Access,
        usage: UsageRule::Count,
        lifecycle: ActionLifecycle::Internal,
    }
}

pub fn conversation_draft_reply() -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new("conversation.draft_reply", Version::new(1, 0, 0))
            .expect("catalog action name is valid"),
        owning_domain: "conversations".to_string(),
        title: "Draft conversation reply".to_string(),
        description: "Create a reply draft without sending it to the customer.".to_string(),
        input_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "conversationId": { "type": "string", "minLength": 1, "maxLength": 128 },
                "instructions": { "type": "string", "maxLength": 2000 },
                "tone": {
                    "type": "string",
                    "enum": ["neutral", "friendly", "formal", "concise"],
                    "default": "neutral"
                }
            },
            "required": ["conversationId"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "draft": { "type": "string", "minLength": 1 },
                "warnings": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            },
            "required": ["draft", "warnings"],
            "additionalProperties": false
        }),
        risk: RiskClass::Draft,
        approval: ApprovalRule::None,
        supported_runtimes: runtimes(),
        supported_actors: product_actors(),
        client_scope: ClientScopeRule::Optional,
        required_grants: strings(["conversations.draft"]),
        required_oauth_scopes: strings(["conversations:draft"]),
        required_entitlements: strings(["product.agents.enabled", "product.inbox.enabled"]),
        idempotency: IdempotencyRule::Optional,
        data_classification: DataClassification::Restricted,
        audit: AuditRule::Full,
        usage: UsageRule::Measured,
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
