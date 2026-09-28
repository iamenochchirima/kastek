//! Provider-neutral connection access inventory.
//!
//! This module deliberately keeps provider scope names behind a small seam. The rest of Core,
//! the client, and Agent Platform deal in KasiTek capability keys and safe status codes.

use std::collections::HashSet;

use chrono::{Duration, Utc};
use crypto_utils::generate_token;
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use crate::error::AppError;

use super::connection_permission_providers::adapter_for;

pub const MESSAGING_INBOUND: &str = "MESSAGING_INBOUND";
pub const MESSAGING_OUTBOUND: &str = "MESSAGING_OUTBOUND";
pub const SOCIAL_PUBLISH: &str = "SOCIAL_PUBLISH";
pub const MEDIA_PUBLISH: &str = "MEDIA_PUBLISH";
pub const SOCIAL_ANALYTICS: &str = "SOCIAL_ANALYTICS";
pub const COMMENTS_MANAGE: &str = "COMMENTS_MANAGE";
pub const SOCIAL_POST_DELETE: &str = "SOCIAL_POST_DELETE";
pub const EMAIL_INBOUND: &str = "EMAIL_INBOUND";
pub const EMAIL_READ: &str = "EMAIL_READ";
pub const EMAIL_OUTBOUND: &str = "EMAIL_OUTBOUND";
pub const EMAIL_REPLY: &str = "EMAIL_REPLY";

#[derive(Debug, Clone, Serialize)]
pub struct AuthorizationRequirement {
    pub code: &'static str,
    pub provider: String,
    #[serde(rename = "connectionId", skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(rename = "requiredCapabilities")]
    pub required_capabilities: Vec<&'static str>,
    pub requestable: bool,
    #[serde(rename = "authMode")]
    pub auth_mode: Option<String>,
    #[serde(rename = "reasonCode")]
    pub reason_code: String,
    pub remediation: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionPermissionDefinition {
    pub key: String,
    pub group: String,
    pub label: String,
    pub description: String,
    pub state: String,
    pub requestable: bool,
    #[serde(rename = "reasonCode")]
    pub reason_code: Option<String>,
    #[serde(rename = "authMode")]
    pub auth_mode: Option<String>,
    #[serde(rename = "verificationSource")]
    pub verification_source: Option<String>,
}

#[derive(Debug, Clone)]
struct PermissionDefinition {
    key: &'static str,
    group: &'static str,
    label: &'static str,
    description: &'static str,
}

#[derive(Debug, FromRow)]
struct ConnectionMetadataRow {
    id: String,
    provider: String,
    metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct PermissionSnapshot {
    pub(crate) definition: ConnectionPermissionDefinition,
    provider_permission: Option<&'static str>,
}

#[derive(Debug, Clone, FromRow)]
pub struct AuthorizationAttempt {
    pub id: String,
    #[sqlx(rename = "connection_id")]
    pub connection_id: String,
    pub provider: String,
    #[sqlx(rename = "auth_mode")]
    pub auth_mode: String,
    pub target: String,
    pub state: String,
    #[sqlx(rename = "requested_capabilities")]
    pub requested_capabilities: Vec<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ConnectionAccessContext {
    pub id: String,
    #[sqlx(rename = "source_type")]
    pub source_type: String,
    #[sqlx(rename = "source_id")]
    pub source_id: String,
    pub provider: String,
    #[sqlx(rename = "display_name")]
    pub display_name: String,
    pub handle: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionAccessSnapshot {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub provider: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub handle: Option<String>,
    #[serde(rename = "authMode")]
    pub auth_mode: String,
    pub permissions: Vec<ConnectionPermissionDefinition>,
}

#[derive(Debug, Clone)]
pub(crate) struct AccessRequestPlan {
    pub context: ConnectionAccessContext,
    pub adapter: super::connection_permission_providers::ProviderAdapter,
    pub effective_capabilities: Vec<String>,
}

const DEFINITIONS: &[PermissionDefinition] = &[
    PermissionDefinition {
        key: MESSAGING_INBOUND,
        group: "MESSAGING",
        label: "Receive messages",
        description: "Let KasiTek receive messages for this account.",
    },
    PermissionDefinition {
        key: MESSAGING_OUTBOUND,
        group: "MESSAGING",
        label: "Reply to messages",
        description: "Let KasiTek send replies from this account.",
    },
    PermissionDefinition {
        key: SOCIAL_PUBLISH,
        group: "PUBLISHING",
        label: "Publish content",
        description: "Create and publish content to this account.",
    },
    PermissionDefinition {
        key: MEDIA_PUBLISH,
        group: "MEDIA",
        label: "Use media",
        description: "Upload and use images or videos in content.",
    },
    PermissionDefinition {
        key: SOCIAL_ANALYTICS,
        group: "ANALYTICS",
        label: "View analytics",
        description: "Read performance and audience metrics.",
    },
    PermissionDefinition {
        key: COMMENTS_MANAGE,
        group: "COMMUNITY",
        label: "Manage comments",
        description: "Read and manage supported comments and interactions.",
    },
    PermissionDefinition {
        key: SOCIAL_POST_DELETE,
        group: "CONTENT_MANAGEMENT",
        label: "Delete published content",
        description: "Delete content published through this account.",
    },
    PermissionDefinition {
        key: EMAIL_INBOUND,
        group: "EMAIL",
        label: "Receive email",
        description: "Sync incoming email into the workspace inbox.",
    },
    PermissionDefinition {
        key: EMAIL_READ,
        group: "EMAIL",
        label: "Read email",
        description: "Read message headers and content from this mailbox.",
    },
    PermissionDefinition {
        key: EMAIL_OUTBOUND,
        group: "EMAIL",
        label: "Send email",
        description: "Send email from this mailbox.",
    },
    PermissionDefinition {
        key: EMAIL_REPLY,
        group: "EMAIL",
        label: "Reply to email",
        description: "Reply within an existing email thread.",
    },
];

pub fn normalize_requested_capabilities(value: Option<&str>) -> Vec<String> {
    let allowed: HashSet<&str> = DEFINITIONS.iter().map(|item| item.key).collect();
    let mut requested = Vec::new();
    for capability in value.unwrap_or_default().split(',') {
        let normalized = capability.trim().to_ascii_uppercase();
        if allowed.contains(normalized.as_str()) && !requested.contains(&normalized) {
            requested.push(normalized);
        }
    }
    requested
}

pub fn parse_requested_capabilities(value: Option<&str>) -> Result<Vec<String>, AppError> {
    let raw = value.unwrap_or_default();
    let requested = normalize_requested_capabilities(Some(raw));
    let allowed: HashSet<&str> = DEFINITIONS.iter().map(|item| item.key).collect();
    let supplied = raw
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if supplied.is_empty() {
        return Err(AppError::BadRequest(
            "At least one access capability is required".to_string(),
        ));
    }
    if supplied
        .iter()
        .any(|item| !allowed.contains(item.to_ascii_uppercase().as_str()))
    {
        return Err(AppError::BadRequest(
            "The access request contains an unsupported capability".to_string(),
        ));
    }
    Ok(requested)
}

/// Return the capabilities that must be included in a replacement OAuth grant. Providers such as
/// X issue a new token for each authorization request, so requesting only a newly selected
/// capability would silently remove permissions that were already granted.
pub(crate) fn effective_requested_capabilities(
    requested: &[String],
    snapshots: &[PermissionSnapshot],
) -> Vec<String> {
    let mut effective = requested.to_vec();
    for snapshot in snapshots {
        if snapshot.definition.state == "GRANTED" && !effective.contains(&snapshot.definition.key) {
            effective.push(snapshot.definition.key.clone());
        }
    }
    effective
}

pub fn is_authorization_error(error: &AppError) -> bool {
    match error {
        AppError::Unauthorized | AppError::Forbidden(_) => true,
        AppError::BadRequest(message) => {
            let message = message.to_ascii_lowercase();
            [
                "permission",
                "oauth",
                "unauthor",
                "forbidden",
                "access token",
                "scope",
            ]
            .iter()
            .any(|marker| message.contains(marker))
        }
        _ => false,
    }
}

/// Build the Meta scopes needed for a product-level access request. The provider adapter remains
/// the only place where raw Meta permission names are defined.
pub fn meta_scopes_for_request(target: &str, requested_capabilities: &[String]) -> Vec<String> {
    let adapter = if target.eq_ignore_ascii_case("instagram") {
        adapter_for("INSTAGRAM", Some("meta_login"), None)
    } else {
        adapter_for("FACEBOOK", Some("meta_login"), None)
    };
    if requested_capabilities.is_empty() {
        return if target.eq_ignore_ascii_case("instagram") {
            vec![
                "instagram_basic",
                "instagram_content_publish",
                "instagram_manage_messages",
                "instagram_manage_comments",
                "instagram_manage_insights",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        } else {
            vec![
                "pages_show_list",
                "pages_manage_metadata",
                "pages_read_engagement",
                "pages_manage_posts",
                "pages_messaging",
                "pages_manage_engagement",
                "read_insights",
                "instagram_basic",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        };
    }
    adapter.required_scopes(requested_capabilities, None)
}

pub fn instagram_scopes_for_request(requested_capabilities: &[String]) -> Vec<String> {
    if requested_capabilities.is_empty() {
        return [
            "instagram_business_basic",
            "instagram_business_content_publish",
            "instagram_business_manage_messages",
            "instagram_business_manage_comments",
            "instagram_business_manage_insights",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
    }

    adapter_for("INSTAGRAM", Some("instagram_login"), None)
        .required_scopes(requested_capabilities, None)
}

pub async fn sync_permission_inventory(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    let rows = sqlx::query_as::<_, ConnectionMetadataRow>(
        r#"SELECT id, provider, metadata
           FROM "ExternalConnection"
           WHERE "orgId" = $1"#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    let mut tx = pool.begin().await?;
    for row in rows {
        sync_connection_permissions(&mut tx, &row.id, &row.provider, row.metadata.as_ref()).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn sync_connection_permissions(
    tx: &mut Transaction<'_, Postgres>,
    connection_id: &str,
    provider: &str,
    metadata: Option<&Value>,
) -> Result<(), AppError> {
    let snapshots = permission_snapshots(provider, metadata);
    sqlx::query(r#"DELETE FROM "ExternalConnectionPermission" WHERE "connectionId" = $1"#)
        .bind(connection_id)
        .execute(&mut **tx)
        .await?;

    for snapshot in snapshots {
        sqlx::query(
            r#"INSERT INTO "ExternalConnectionPermission" (
                   id, "connectionId", key, "providerPermission", state, requestable,
                   "reasonCode", "authMode", "verificationSource", "observedAt", "createdAt", "updatedAt"
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),NOW())"#,
        )
        .bind(cuid2::create_id())
        .bind(connection_id)
        .bind(&snapshot.definition.key)
        .bind(snapshot.provider_permission)
        .bind(&snapshot.definition.state)
        .bind(snapshot.definition.requestable)
        .bind(&snapshot.definition.reason_code)
        .bind(&snapshot.definition.auth_mode)
        .bind(&snapshot.definition.verification_source)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(crate) fn permission_snapshots(
    provider: &str,
    metadata: Option<&Value>,
) -> Vec<PermissionSnapshot> {
    let provider = provider.to_ascii_uppercase();
    let permissions = metadata_values(metadata, "permissions");
    let scopes = metadata_values(metadata, "scope");
    let tasks = metadata_values(metadata, "tasks");
    let inventory_inspected = metadata
        .and_then(|value| value.get("permissionsInspected"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auth_mode = metadata
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            (provider == "FACEBOOK" || provider == "INSTAGRAM").then_some("meta_login".to_string())
        });
    let adapter = adapter_for(&provider, auth_mode.as_deref(), metadata);
    let verified_source = if !permissions.is_empty() {
        Some("oauth_permissions".to_string())
    } else if !tasks.is_empty() {
        Some("provider_tasks".to_string())
    } else if !scopes.is_empty() {
        Some("oauth_scope".to_string())
    } else if inventory_inspected {
        Some("oauth_permission_inspection".to_string())
    } else {
        None
    };

    DEFINITIONS
        .iter()
        .map(|definition| {
            let rule = adapter.capability(definition.key);
            let provider_grant = rule.grants.iter().any(|candidate| {
                permissions.iter().any(|value| value == candidate)
                    || scopes.iter().any(|value| value == candidate)
                    || tasks.iter().any(|value| value == candidate)
            });
            let target_check = metadata_capability_check(metadata, adapter, definition.key);
            let granted = if rule.requires_target_check {
                provider_grant && target_check == Some(true)
            } else {
                provider_grant || target_check == Some(true)
            };
            let unsupported = !rule.supported;
            let provider_requestable = rule.requestable;
            let state = if unsupported {
                "UNSUPPORTED"
            } else if granted {
                "GRANTED"
            } else if rule.requires_target_check && target_check.is_none() {
                "UNKNOWN"
            } else if metadata
                .and_then(|value| value.get("requiresAppReview"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "REQUIRES_PROVIDER_APPROVAL"
            } else if permissions.is_empty()
                && scopes.is_empty()
                && tasks.is_empty()
                && !inventory_inspected
            {
                "UNKNOWN"
            } else if provider_requestable {
                "REQUESTABLE"
            } else {
                "NOT_GRANTED"
            };
            let requestable =
                provider_requestable && !granted && state != "REQUIRES_PROVIDER_APPROVAL";
            let reason_code = if unsupported {
                Some(
                    if matches!(
                        adapter,
                        super::connection_permission_providers::ProviderAdapter::InstagramDirect
                    ) {
                        "direct_instagram_login_unsupported"
                    } else {
                        "provider_capability_unsupported"
                    }
                    .to_string(),
                )
            } else if state == "REQUESTABLE" {
                Some("missing_provider_permission".to_string())
            } else if state == "UNKNOWN" {
                Some("provider_permission_unavailable".to_string())
            } else if state == "NOT_GRANTED" {
                Some("missing_provider_permission".to_string())
            } else if state == "REQUIRES_PROVIDER_APPROVAL" {
                Some("provider_approval_required".to_string())
            } else {
                None
            };
            PermissionSnapshot {
                definition: ConnectionPermissionDefinition {
                    key: definition.key.to_string(),
                    group: definition.group.to_string(),
                    label: definition.label.to_string(),
                    description: definition.description.to_string(),
                    state: state.to_string(),
                    requestable,
                    reason_code,
                    auth_mode: auth_mode.clone(),
                    verification_source: verified_source.clone(),
                },
                provider_permission: rule.provider_permission,
            }
        })
        .collect()
}

fn metadata_capability_check(
    metadata: Option<&Value>,
    adapter: super::connection_permission_providers::ProviderAdapter,
    key: &str,
) -> Option<bool> {
    let explicit = metadata
        .and_then(|value| value.get("capabilityChecks"))
        .and_then(|checks| checks.get(key))
        .and_then(|check| {
            check
                .as_bool()
                .or_else(|| check.get("ok").and_then(Value::as_bool))
        });
    if explicit.is_some() {
        return explicit;
    }

    if !matches!(
        adapter,
        super::connection_permission_providers::ProviderAdapter::LinkedInOrganization
    ) {
        return None;
    }

    let role = metadata
        .and_then(|value| value.get("role"))
        .and_then(Value::as_str)
        .map(|value| value.to_ascii_uppercase());
    let Some(role) = role else {
        return None;
    };
    let can_publish = matches!(
        role.as_str(),
        "ADMINISTRATOR"
            | "CONTENT_ADMIN"
            | "CONTENT_ADMINISTRATOR"
            | "DIRECT_SPONSORED_CONTENT_POSTER"
    );
    match key {
        SOCIAL_PUBLISH | MEDIA_PUBLISH | COMMENTS_MANAGE => Some(can_publish),
        SOCIAL_ANALYTICS => Some(role == "ADMINISTRATOR"),
        _ => None,
    }
}

pub async fn get_connection_access_context(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<ConnectionAccessContext, AppError> {
    sqlx::query_as::<_, ConnectionAccessContext>(
        r#"SELECT id, "sourceType" AS source_type, "sourceId" AS source_id, provider,
                  "displayName" AS display_name, handle, metadata
           FROM "ExternalConnection"
           WHERE id = $1 AND "orgId" = $2
           LIMIT 1"#,
    )
    .bind(connection_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))
}

pub async fn get_access_snapshot(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<ConnectionAccessSnapshot, AppError> {
    sync_permission_inventory(pool, org_id).await?;
    let context = get_connection_access_context(pool, org_id, connection_id).await?;
    let provider = context.provider.to_ascii_uppercase();
    let auth_mode = context
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            adapter_for(&provider, None, context.metadata.as_ref())
                .auth_mode()
                .to_string()
        });
    Ok(ConnectionAccessSnapshot {
        connection_id: context.id.clone(),
        provider,
        display_name: context.display_name.clone(),
        handle: context.handle.clone(),
        auth_mode,
        permissions: permission_snapshots(&context.provider, context.metadata.as_ref())
            .into_iter()
            .map(|item| item.definition)
            .collect(),
    })
}

pub(crate) async fn plan_access_request(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
    requested_capabilities: &[String],
) -> Result<AccessRequestPlan, AppError> {
    if requested_capabilities.is_empty() {
        return Err(AppError::BadRequest(
            "At least one access capability is required".to_string(),
        ));
    }
    let context = get_connection_access_context(pool, org_id, connection_id).await?;
    if !matches!(context.source_type.as_str(), "SOCIAL" | "WHATSAPP") {
        return Err(AppError::BadRequest(
            "Access requests are not available for this connection type".to_string(),
        ));
    }
    let auth_mode = context
        .metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str);
    let adapter = adapter_for(&context.provider, auth_mode, context.metadata.as_ref());
    if adapter.provider_name() == "UNKNOWN" {
        return Err(AppError::BadRequest(
            "Access requests are not available for this provider yet".to_string(),
        ));
    }
    let snapshots = permission_snapshots(&context.provider, context.metadata.as_ref());
    for capability in requested_capabilities {
        let Some(permission) = snapshots
            .iter()
            .find(|item| item.definition.key == *capability)
        else {
            return Err(AppError::BadRequest(
                "The access request contains an unsupported capability".to_string(),
            ));
        };
        if !permission.definition.requestable {
            let reason = permission
                .definition
                .reason_code
                .as_deref()
                .unwrap_or("unsupported_access_request");
            return Err(AppError::BadRequest(format!(
                "Access capability {capability} cannot be requested ({reason})"
            )));
        }
    }
    let effective_capabilities =
        effective_requested_capabilities(requested_capabilities, &snapshots);
    Ok(AccessRequestPlan {
        context,
        adapter,
        effective_capabilities,
    })
}

pub(crate) fn authorization_requirement(
    provider: &str,
    metadata: Option<&Value>,
    capability: &'static str,
) -> Option<AuthorizationRequirement> {
    let permission = permission_snapshots(provider, metadata)
        .into_iter()
        .find(|item| item.definition.key == capability)?;
    if permission.definition.state == "GRANTED" {
        return None;
    }
    Some(AuthorizationRequirement {
        code: "authorization_required",
        provider: provider.to_ascii_uppercase(),
        connection_id: None,
        required_capabilities: vec![capability],
        requestable: permission.definition.requestable,
        auth_mode: permission.definition.auth_mode,
        reason_code: permission
            .definition
            .reason_code
            .unwrap_or_else(|| "missing_provider_permission".to_string()),
        remediation: "connections_access",
    })
}

pub async fn create_authorization_attempt(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    connection_id: &str,
    provider: &str,
    auth_mode: &str,
    target: &str,
    requested_capabilities: &[String],
) -> Result<AuthorizationAttempt, AppError> {
    create_authorization_attempt_with_state(
        pool,
        org_id,
        user_id,
        connection_id,
        provider,
        auth_mode,
        target,
        requested_capabilities,
        generate_token(32),
    )
    .await
}

pub async fn create_authorization_attempt_with_state(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    connection_id: &str,
    provider: &str,
    auth_mode: &str,
    target: &str,
    requested_capabilities: &[String],
    state: String,
) -> Result<AuthorizationAttempt, AppError> {
    let id = cuid2::create_id();
    let expires_at = Utc::now() + Duration::minutes(10);
    sqlx::query(
        r#"INSERT INTO "ExternalConnectionAuthorizationAttempt" (
               id, "connectionId", "orgId", "userId", provider, "authMode", target, state,
               "requestedCapabilities", status, "expiresAt", "createdAt", "updatedAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STARTED',$10,NOW(),NOW())"#,
    )
    .bind(&id)
    .bind(connection_id)
    .bind(org_id)
    .bind(user_id)
    .bind(provider)
    .bind(auth_mode)
    .bind(target)
    .bind(&state)
    .bind(requested_capabilities)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(AuthorizationAttempt {
        id,
        connection_id: connection_id.to_string(),
        provider: provider.to_string(),
        auth_mode: auth_mode.to_string(),
        target: target.to_string(),
        state,
        requested_capabilities: requested_capabilities.to_vec(),
    })
}

pub async fn find_authorization_attempt(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    state: &str,
) -> Result<Option<AuthorizationAttempt>, AppError> {
    sqlx::query_as::<_, AuthorizationAttempt>(
        r#"SELECT id, "connectionId" AS connection_id, provider, "authMode" AS auth_mode,
                  target, state, "requestedCapabilities" AS requested_capabilities
           FROM "ExternalConnectionAuthorizationAttempt"
           WHERE state = $1 AND "orgId" = $2 AND "userId" = $3
             AND status = 'STARTED' AND "expiresAt" > NOW()"#,
    )
    .bind(state)
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn finish_authorization_attempt(
    pool: &PgPool,
    attempt_id: &str,
    status: &str,
    failure_code: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE "ExternalConnectionAuthorizationAttempt"
           SET status = $1, "failureCode" = $2, "completedAt" = NOW(), "updatedAt" = NOW()
           WHERE id = $3"#,
    )
    .bind(status)
    .bind(failure_code)
    .bind(attempt_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn metadata_values(metadata: Option<&Value>, key: &str) -> Vec<String> {
    let Some(value) = metadata.and_then(|item| item.get(key)) else {
        return Vec::new();
    };
    match value {
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Value::String(value) => value
            .split([',', ' '])
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::connection_permission_providers::adapter_for;
    use super::{
        authorization_requirement, effective_requested_capabilities, is_authorization_error,
        meta_scopes_for_request, normalize_requested_capabilities, permission_snapshots,
        MESSAGING_INBOUND, SOCIAL_POST_DELETE,
    };
    use crate::error::AppError;
    use serde_json::json;

    #[test]
    fn instagram_meta_delete_access_is_requestable_when_missing() {
        let permissions = permission_snapshots(
            "INSTAGRAM",
            Some(&json!({
                "authMethod": "meta_login",
                "permissions": ["instagram_content_publish"],
                "permissionsInspected": true
            })),
        );
        let delete = permissions
            .iter()
            .find(|item| item.definition.key == SOCIAL_POST_DELETE)
            .unwrap();
        assert_eq!(delete.definition.state, "REQUESTABLE");
        assert!(delete.definition.requestable);
        assert_eq!(
            delete.provider_permission,
            Some("instagram_manage_contents")
        );
    }

    #[test]
    fn instagram_meta_delete_access_is_granted_when_inspected() {
        let permissions = permission_snapshots(
            "INSTAGRAM",
            Some(&json!({
                "authMethod": "meta_login",
                "permissions": ["instagram_manage_contents"],
                "permissionsInspected": true
            })),
        );
        let delete = permissions
            .iter()
            .find(|item| item.definition.key == SOCIAL_POST_DELETE)
            .unwrap();
        assert_eq!(delete.definition.state, "GRANTED");
        assert!(!delete.definition.requestable);
    }

    #[test]
    fn direct_instagram_login_reports_delete_as_unsupported() {
        let permissions = permission_snapshots(
            "INSTAGRAM",
            Some(&json!({
                "authMethod": "instagram_login",
                "permissions": ["instagram_business_content_publish"]
            })),
        );
        let delete = permissions
            .iter()
            .find(|item| item.definition.key == SOCIAL_POST_DELETE)
            .unwrap();
        assert_eq!(delete.definition.state, "UNSUPPORTED");
        assert!(!delete.definition.requestable);
    }

    #[test]
    fn meta_request_adds_only_selected_capability_scopes() {
        let scopes = meta_scopes_for_request("instagram", &["SOCIAL_PUBLISH".to_string()]);
        assert!(scopes.contains(&"instagram_content_publish".to_string()));
        assert!(scopes.contains(&"instagram_basic".to_string()));
        assert!(!scopes.contains(&"pages_messaging".to_string()));
    }

    #[test]
    fn meta_instagram_delete_request_uses_content_management_permission() {
        let scopes = meta_scopes_for_request("instagram", &[SOCIAL_POST_DELETE.to_string()]);
        assert!(scopes.contains(&"instagram_manage_contents".to_string()));
        assert!(scopes.contains(&"instagram_basic".to_string()));
    }

    #[test]
    fn incremental_access_requests_preserve_existing_x_grants() {
        let existing = permission_snapshots(
            "X",
            Some(&json!({
                "scope": "tweet.write tweet.read users.read offline.access"
            })),
        );
        let effective = effective_requested_capabilities(&["MEDIA_PUBLISH".to_string()], &existing);
        let scopes = adapter_for("X", None, None).required_scopes(&effective, None);

        assert!(effective.contains(&"SOCIAL_PUBLISH".to_string()));
        assert!(effective.contains(&"MEDIA_PUBLISH".to_string()));
        assert!(scopes.contains(&"tweet.write".to_string()));
        assert!(scopes.contains(&"media.write".to_string()));
    }

    #[test]
    fn provider_tasks_are_treated_as_grants() {
        let permissions = permission_snapshots(
            "FACEBOOK",
            Some(&json!({
                "authMethod": "meta_login",
                "tasks": ["CREATE_CONTENT", "MODERATE"]
            })),
        );
        let delete = permissions
            .iter()
            .find(|item| item.definition.key == SOCIAL_POST_DELETE)
            .unwrap();
        assert_eq!(delete.definition.state, "GRANTED");
        assert!(!delete.definition.requestable);
    }

    #[test]
    fn absent_provider_inventory_is_unknown_not_not_granted() {
        let permissions =
            permission_snapshots("FACEBOOK", Some(&json!({"authMethod": "meta_login"})));
        let publish = permissions
            .iter()
            .find(|item| item.definition.key == "SOCIAL_PUBLISH")
            .unwrap();
        assert_eq!(publish.definition.state, "UNKNOWN");
        assert_eq!(
            publish.definition.reason_code.as_deref(),
            Some("provider_permission_unavailable")
        );
    }

    #[test]
    fn provider_review_access_is_not_user_requestable() {
        let permissions = permission_snapshots(
            "FACEBOOK",
            Some(&json!({
                "authMethod": "meta_login",
                "permissions": ["pages_manage_posts"],
                "requiresAppReview": true
            })),
        );
        let messaging = permissions
            .iter()
            .find(|item| item.definition.key == "MESSAGING_INBOUND")
            .unwrap();
        assert_eq!(messaging.definition.state, "REQUIRES_PROVIDER_APPROVAL");
        assert!(!messaging.definition.requestable);
    }

    #[test]
    fn request_normalization_allowlists_and_deduplicates_capabilities() {
        assert_eq!(
            normalize_requested_capabilities(Some("social_post_delete, SOCIAL_POST_DELETE, nope",)),
            vec!["SOCIAL_POST_DELETE"]
        );
    }

    #[test]
    fn authorization_requirement_contains_client_remediation_intent() {
        let requirement = authorization_requirement(
            "INSTAGRAM",
            Some(&json!({
                "authMethod": "meta_login",
                "permissions": ["instagram_content_publish"]
            })),
            SOCIAL_POST_DELETE,
        )
        .unwrap();
        assert_eq!(requirement.remediation, "connections_access");
    }

    #[test]
    fn only_provider_authorization_failures_trigger_permission_remediation() {
        assert!(is_authorization_error(&AppError::BadRequest(
            "OAuthException: permission denied".to_string(),
        )));
        assert!(!is_authorization_error(&AppError::BadRequest(
            "Failed to delete the post: provider unavailable".to_string(),
        )));
    }

    #[test]
    fn expanded_provider_grants_are_normalized_without_raw_scope_output() {
        let cases = [
            ("THREADS", "threads_delete", SOCIAL_POST_DELETE, "GRANTED"),
            ("TIKTOK", "video.publish", "SOCIAL_PUBLISH", "GRANTED"),
            ("X", "dm.read", "MESSAGING_INBOUND", "GRANTED"),
            (
                "BLUESKY",
                "repo:app.bsky.feed.post",
                "SOCIAL_PUBLISH",
                "GRANTED",
            ),
        ];

        for (provider, scope, key, expected) in cases {
            let permissions = permission_snapshots(
                provider,
                Some(&json!({
                    "scope": scope,
                    "permissionsInspected": true,
                })),
            );
            let permission = permissions
                .iter()
                .find(|item| item.definition.key == key)
                .unwrap();
            assert_eq!(permission.definition.state, expected, "{provider} {key}");
            assert!(permission.definition.reason_code.as_deref() != Some(scope));
        }
    }

    #[test]
    fn threads_delete_access_is_requestable_before_the_scope_is_granted() {
        let permissions = permission_snapshots(
            "THREADS",
            Some(&json!({
                "scope": "threads_content_publish",
                "permissionsInspected": true,
            })),
        );
        let delete = permissions
            .iter()
            .find(|item| item.definition.key == SOCIAL_POST_DELETE)
            .unwrap();

        assert_eq!(delete.definition.state, "REQUESTABLE");
        assert!(delete.definition.requestable);
        assert_eq!(delete.provider_permission, Some("threads_delete"));
    }

    #[test]
    fn threads_scope_fallback_marks_requested_access_as_granted() {
        let permissions = permission_snapshots(
            "THREADS",
            Some(&json!({
                "scope": "threads_basic threads_content_publish threads_delete",
                "permissionsInspected": true,
            })),
        );
        for key in ["SOCIAL_PUBLISH", "MEDIA_PUBLISH", SOCIAL_POST_DELETE] {
            let permission = permissions
                .iter()
                .find(|item| item.definition.key == key)
                .unwrap();
            assert_eq!(permission.definition.state, "GRANTED", "{key}");
            assert!(!permission.definition.requestable, "{key}");
        }
    }

    #[test]
    fn linkedin_organization_access_requires_the_returned_page_role() {
        let without_role = permission_snapshots(
            "LINKEDIN",
            Some(&json!({
                "accountType": "organization",
                "scope": "w_organization_social"
            })),
        );
        let publish = without_role
            .iter()
            .find(|item| item.definition.key == "SOCIAL_PUBLISH")
            .unwrap();
        assert_eq!(publish.definition.state, "UNKNOWN");

        let with_role = permission_snapshots(
            "LINKEDIN",
            Some(&json!({
                "accountType": "organization",
                "scope": "w_organization_social",
                "role": "CONTENT_ADMIN"
            })),
        );
        let publish = with_role
            .iter()
            .find(|item| item.definition.key == "SOCIAL_PUBLISH")
            .unwrap();
        assert_eq!(publish.definition.state, "GRANTED");
    }

    #[test]
    fn provider_grants_do_not_cross_claim_between_read_and_manage_access() {
        let threads = permission_snapshots(
            "THREADS",
            Some(&json!({
                "scope": "threads_read_replies",
                "permissionsInspected": true
            })),
        );
        let comments = threads
            .iter()
            .find(|item| item.definition.key == "COMMENTS_MANAGE")
            .unwrap();
        assert_ne!(comments.definition.state, "GRANTED");

        let linkedin = permission_snapshots(
            "LINKEDIN",
            Some(&json!({
                "scope": "r_member_postAnalytics",
                "permissionsInspected": true
            })),
        );
        let comments = linkedin
            .iter()
            .find(|item| item.definition.key == "COMMENTS_MANAGE")
            .unwrap();
        assert_ne!(comments.definition.state, "GRANTED");
    }

    #[test]
    fn whatsapp_requires_setup_evidence_in_addition_to_the_token_permission() {
        let without_setup = permission_snapshots(
            "WHATSAPP",
            Some(&json!({
                "permissions": ["whatsapp_business_messaging"],
                "permissionsInspected": true,
            })),
        );
        let inbound = without_setup
            .iter()
            .find(|item| item.definition.key == MESSAGING_INBOUND)
            .unwrap();
        assert_eq!(inbound.definition.state, "UNKNOWN");

        let with_setup = permission_snapshots(
            "WHATSAPP",
            Some(&json!({
                "permissions": ["whatsapp_business_messaging"],
                "permissionsInspected": true,
                "capabilityChecks": {"MESSAGING_INBOUND": true},
            })),
        );
        let inbound = with_setup
            .iter()
            .find(|item| item.definition.key == MESSAGING_INBOUND)
            .unwrap();
        assert_eq!(inbound.definition.state, "GRANTED");
    }
}
