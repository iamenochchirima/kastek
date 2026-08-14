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

fn public_read_action(
    name: &str,
    title: &str,
    description: &str,
    grant: &str,
    entitlement: &str,
    input_schema: serde_json::Value,
    output_schema: serde_json::Value,
) -> ActionDefinition {
    ActionDefinition {
        id: ActionId::new(name, Version::new(1, 0, 0))
            .expect("built-in public read action name is valid"),
        owning_domain: name.split('.').next().unwrap_or("core").to_string(),
        title: title.to_string(),
        description: description.to_string(),
        input_schema,
        output_schema,
        risk: RiskClass::Read,
        approval: ApprovalRule::None,
        supported_runtimes: [ProductRuntime::Direct].into_iter().collect(),
        supported_actors: [
            ActorKind::DirectUser,
            ActorKind::ApiClient,
            ActorKind::ExternalAgent,
        ]
        .into_iter()
        .collect(),
        client_scope: ClientScopeRule::NotApplicable,
        required_grants: strings([grant]),
        required_oauth_scopes: BTreeSet::new(),
        required_entitlements: strings([entitlement]),
        idempotency: IdempotencyRule::NotApplicable,
        data_classification: DataClassification::Restricted,
        audit: AuditRule::Access,
        usage: UsageRule::Count,
        lifecycle: ActionLifecycle::Public,
    }
}

pub fn contacts_list() -> ActionDefinition {
    public_read_action(
        "contacts.list",
        "List contacts",
        "List the caller's organization-scoped contacts without provider secrets.",
        "contacts.read",
        "feature.contacts.access",
        json!({
            "type": "object",
            "properties": {
                "q": { "type": "string", "maxLength": 200 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
            },
            "additionalProperties": false
        }),
        json!({ "type": "object", "required": ["contacts"], "additionalProperties": true }),
    )
}

pub fn inbox_conversations_list() -> ActionDefinition {
    public_read_action(
        "inbox.conversations.list",
        "List inbox conversations",
        "List organization-scoped inbox conversations and safe unread state.",
        "inbox.read",
        "feature.inbox.access",
        json!({ "type": "object", "additionalProperties": false }),
        json!({ "type": "object", "required": ["conversations"], "additionalProperties": true }),
    )
}

pub fn inbox_messages_list() -> ActionDefinition {
    public_read_action(
        "inbox.messages.list",
        "List inbox messages",
        "Read a redacted organization-scoped inbox conversation timeline.",
        "inbox.read",
        "feature.inbox.access",
        json!({
            "type": "object",
            "properties": { "conversationId": { "type": "string", "minLength": 1, "maxLength": 160 } },
            "required": ["conversationId"],
            "additionalProperties": false
        }),
        json!({ "type": "object", "required": ["messages"], "additionalProperties": true }),
    )
}

pub fn bookings_list() -> ActionDefinition {
    public_read_action(
        "bookings.list",
        "List bookings",
        "List organization-scoped booking services and appointments.",
        "bookings.read",
        "feature.bookings.access",
        json!({ "type": "object", "additionalProperties": false }),
        json!({ "type": "object", "required": ["bookings"], "additionalProperties": true }),
    )
}

pub fn campaigns_list() -> ActionDefinition {
    public_read_action(
        "campaigns.list",
        "List campaigns",
        "List organization-scoped WhatsApp campaign status and delivery summaries.",
        "campaigns.read",
        "feature.campaigns.manage",
        json!({ "type": "object", "additionalProperties": false }),
        json!({ "type": "object", "required": ["campaigns"], "additionalProperties": true }),
    )
}

pub fn campaign_get() -> ActionDefinition {
    public_read_action(
        "campaigns.get",
        "Get campaign summary",
        "Read one organization-scoped WhatsApp campaign summary without recipient details.",
        "campaigns.read",
        "feature.campaigns.manage",
        json!({
            "type": "object",
            "properties": { "campaignId": { "type": "string", "minLength": 1, "maxLength": 160 } },
            "required": ["campaignId"],
            "additionalProperties": false
        }),
        json!({ "type": "object", "required": ["campaign"], "additionalProperties": true }),
    )
}

pub fn templates_list() -> ActionDefinition {
    public_read_action(
        "templates.list",
        "List templates",
        "List organization-scoped WhatsApp templates and approval status without message bodies.",
        "templates.read",
        "feature.templates.manage",
        json!({
            "type": "object",
            "properties": { "status": { "type": "string", "enum": ["APPROVED", "PENDING", "REJECTED", "DISABLED"] } },
            "additionalProperties": false
        }),
        json!({ "type": "object", "required": ["templates"], "additionalProperties": true }),
    )
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

pub fn content_update_draft() -> ActionDefinition {
    let mut action = social_action(
        "content.posts.draft.update",
        Version::new(1, 0, 0),
        "Update content draft",
        "Update a workspace content draft without publishing it.",
        RiskClass::Draft,
        ApprovalRule::None,
        json!({
            "type": "object",
            "properties": {
                "postId": { "type": "string" },
                "content": { "type": "string" },
                "channels": { "type": "array" },
                "title": { "type": "string" },
                "prompt": { "type": "string" },
                "metadata": { "type": "object" }
            },
            "required": ["postId"],
            "additionalProperties": false
        }),
        json!({"type":"object","required":["post"],"additionalProperties":true}),
        ["content.write"],
        IdempotencyRule::NotApplicable,
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

pub fn content_unschedule() -> ActionDefinition {
    social_action(
        "content.posts.unschedule",
        Version::new(1, 0, 0),
        "Unschedule content",
        "Move a scheduled content post back to a draft without publishing it.",
        RiskClass::ExternalEffect,
        ApprovalRule::Always,
        json!({"type":"object","properties":{"postId":{"type":"string"}},"required":["postId"],"additionalProperties":false}),
        json!({"type":"object","required":["post","status"],"additionalProperties":true}),
        ["content.publish"],
        IdempotencyRule::Required,
    )
}

pub fn content_delete() -> ActionDefinition {
    social_action(
        "content.posts.delete",
        Version::new(1, 0, 0),
        "Delete content",
        "Delete an unpublished content draft or schedule.",
        RiskClass::ExternalEffect,
        ApprovalRule::Always,
        json!({"type":"object","properties":{"postId":{"type":"string"}},"required":["postId"],"additionalProperties":false}),
        json!({"type":"object","properties":{"postId":{"type":"string"},"deleted":{"type":"boolean"}},"required":["postId","deleted"],"additionalProperties":false}),
        ["content.write"],
        IdempotencyRule::Required,
    )
}

pub fn definitions() -> Vec<ActionDefinition> {
    vec![
        booking_list_services(),
        contacts_list(),
        inbox_conversations_list(),
        inbox_messages_list(),
        bookings_list(),
        campaigns_list(),
        campaign_get(),
        templates_list(),
        social_list_posts(),
        content_create_draft(),
        content_update_draft(),
        content_publish(),
        content_unschedule(),
        content_delete(),
    ]
}

fn strings<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::definitions;

    #[test]
    fn built_in_actions_have_valid_policy_metadata() {
        let actions = definitions();
        assert_eq!(actions.len(), 14);
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
        for public_read in [
            "contacts.list",
            "inbox.conversations.list",
            "inbox.messages.list",
            "bookings.list",
            "campaigns.list",
            "campaigns.get",
            "templates.list",
        ] {
            let action = actions
                .iter()
                .find(|action| action.id.name() == public_read)
                .expect("public read action is present");
            assert_eq!(action.lifecycle, actions::ActionLifecycle::Public);
            assert_eq!(action.risk, actions::RiskClass::Read);
        }
    }
}
