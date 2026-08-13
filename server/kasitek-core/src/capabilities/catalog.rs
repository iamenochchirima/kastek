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

fn social_action(
    name: &str,
    version: Version,
    title: &str,
    description: &str,
    risk: RiskClass,
    approval: ApprovalRule,
    input_schema: serde_json::Value,
    output_schema: serde_json::Value,
    grants: [&str; 1],
    idempotency: IdempotencyRule,
) -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new(name, version).expect("built-in social action name is valid"),
        owning_domain: "content".to_string(),
        title: title.to_string(),
        description: description.to_string(),
        input_schema,
        output_schema,
        risk,
        approval,
        supported_runtimes: [ProductRuntime::Direct, ProductRuntime::WhiteLabel]
            .into_iter()
            .collect(),
        supported_actors: [
            ActorKind::DirectUser,
            ActorKind::NativeAgent,
            ActorKind::ApiClient,
            ActorKind::ExternalAgent,
        ]
        .into_iter()
        .collect(),
        client_scope: ClientScopeRule::NotApplicable,
        required_grants: strings(grants),
        required_oauth_scopes: BTreeSet::new(),
        required_entitlements: strings(["feature.social.access"]),
        idempotency,
        data_classification: DataClassification::Confidential,
        audit: AuditRule::Full,
        usage: UsageRule::Count,
        lifecycle: ActionLifecycle::Pilot,
    }
}

pub fn social_list_posts() -> ActionDefinition {
    let mut action = social_action(
        "content.posts.list",
        Version::new(1, 0, 0),
        "List content posts",
        "List workspace-owned content drafts and publication records.",
        RiskClass::Read,
        ApprovalRule::None,
        json!({"type":"object","additionalProperties":false}),
        json!({"type":"object","properties":{"posts":{"type":"array"}},"required":["posts"],"additionalProperties":false}),
        ["content.read"],
        IdempotencyRule::NotApplicable,
    );
    action.lifecycle = ActionLifecycle::Public;
    action
}

pub fn content_create_draft() -> ActionDefinition {
    let mut action = social_action(
        "content.posts.draft.create",
        Version::new(1, 0, 0),
        "Create content draft",
        "Create a reviewable content draft without publishing it.",
        RiskClass::Draft,
        ApprovalRule::None,
        json!({"type":"object","properties":{"text":{"type":"string","maxLength":50000},"media":{"type":"array"}},"required":["text"],"additionalProperties":false}),
        json!({"type":"object","required":["post"],"additionalProperties":true}),
        ["content.write"],
        IdempotencyRule::Required,
    );
    action.lifecycle = ActionLifecycle::Public;
    action
}

pub fn content_publish() -> ActionDefinition {
    social_action(
        "content.posts.publish",
        Version::new(1, 0, 0),
        "Publish content",
        "Publish an immutable, approved content revision to selected channels.",
        RiskClass::ExternalEffect,
        ApprovalRule::PolicyControlled,
        json!({"type":"object","properties":{"postId":{"type":"string"},"platform":{"type":"string"}},"required":["postId","platform"],"additionalProperties":false}),
        json!({"type":"object","required":["status"],"additionalProperties":true}),
        ["content.publish"],
        IdempotencyRule::Required,
    )
}

pub fn definitions() -> Vec<ActionDefinition> {
    vec![
        booking_list_services(),
        social_list_posts(),
        content_create_draft(),
        content_publish(),
    ]
}

fn strings<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::definitions;

    #[test]
    fn built_in_content_actions_have_valid_policy_metadata() {
        let actions = definitions();
        assert_eq!(actions.len(), 4);
        for action in &actions {
            action
                .validate_metadata()
                .expect("built-in action metadata is valid");
        }
        assert!(actions
            .iter()
            .any(|action| action.id.name() == "content.posts.publish"));
        let draft = actions
            .iter()
            .find(|action| action.id.name() == "content.posts.draft.create")
            .expect("draft action is present");
        assert_eq!(draft.idempotency, actions::IdempotencyRule::Required);
        assert!(draft
            .supported_actors
            .contains(&actions::ActorKind::ExternalAgent));
    }
}
