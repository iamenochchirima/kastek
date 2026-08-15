use std::collections::BTreeSet;

use actix_web::HttpRequest;
use sqlx::PgPool;

use crate::{
    error::AppError,
    identity::{
        principal::{Principal, PrincipalKind},
        request_context::RequestContext,
    },
    middleware::extract_admin,
};

/// Resolve the global admin cookie into the same normalized context shape used
/// by product, public-credential, and internal-delegation adapters. Admins are
/// platform principals, so their context intentionally has no workspace scope.
pub async fn resolve(req: &HttpRequest, pool: &PgPool) -> Result<RequestContext, AppError> {
    let admin = extract_admin(req, pool).await?;
    let effective_grants = grants_for_role(&admin.role);
    if effective_grants.is_empty() {
        return Err(AppError::Forbidden(
            "Unsupported administrator role".to_string(),
        ));
    }
    Ok(RequestContext {
        principal: Principal {
            kind: PrincipalKind::PlatformAdmin,
            id: admin.id,
            subject_user_id: None,
            client_id: None,
        },
        organization_id: "platform".to_string(),
        user_id: None,
        client_id: None,
        installation_id: None,
        effective_grants,
        correlation_id: None,
        causation_id: None,
        idempotency_key: None,
    })
}

pub fn grants_for_role(role: &str) -> BTreeSet<String> {
    match role.trim().to_ascii_lowercase().as_str() {
        "viewer" => ["admin:read".to_string()].into_iter().collect(),
        "support" => ["admin:read".to_string(), "admin:support".to_string()]
            .into_iter()
            .collect(),
        "security" => ["admin:read".to_string(), "admin:security".to_string()]
            .into_iter()
            .collect(),
        "operator" => [
            "admin:read".to_string(),
            "admin:write".to_string(),
            "admin:operate".to_string(),
        ]
        .into_iter()
        .collect(),
        "admin" => [
            "admin:read".to_string(),
            "admin:write".to_string(),
            "admin:operate".to_string(),
        ]
        .into_iter()
        .collect(),
        "superadmin" | "owner" => [
            "admin:read".to_string(),
            "admin:write".to_string(),
            "admin:operate".to_string(),
            "admin:support".to_string(),
            "admin:security".to_string(),
            "admin:emergency".to_string(),
        ]
        .into_iter()
        .collect(),
        _ => BTreeSet::new(),
    }
}

pub fn can_view_customer_content(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "support" | "operator" | "admin" | "superadmin" | "owner"
    )
}

pub fn can_execute_operator_command(role: &str) -> bool {
    grants_for_role(role).contains("admin:operate")
}

pub fn can_manage_support_access(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "admin" | "superadmin" | "owner"
    )
}

pub fn can_view_support_access(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "support" | "security" | "operator" | "admin" | "superadmin" | "owner"
    )
}

#[cfg(test)]
mod tests {
    use crate::services::admin_policy::can_use_emergency_access;

    use super::{
        can_execute_operator_command, can_manage_support_access, can_view_customer_content,
        can_view_support_access, grants_for_role,
    };

    #[test]
    fn maps_admin_roles_to_narrow_platform_grants() {
        assert!(grants_for_role("viewer").contains("admin:read"));
        assert!(!grants_for_role("viewer").contains("admin:write"));
        assert!(grants_for_role("admin").contains("admin:write"));
        assert!(grants_for_role("operator").contains("admin:operate"));
        assert!(grants_for_role("support").contains("admin:support"));
        assert!(!grants_for_role("support").contains("admin:operate"));
        assert!(grants_for_role("owner").contains("admin:emergency"));
        assert!(grants_for_role("superadmin").contains("admin:write"));
        assert!(grants_for_role("unknown").is_empty());
    }

    #[test]
    fn separates_content_access_from_mutating_operator_commands() {
        assert!(!can_view_customer_content("viewer"));
        assert!(can_view_customer_content("support"));
        assert!(can_view_customer_content("OWNER"));
        assert!(!can_execute_operator_command("support"));
        assert!(can_execute_operator_command("operator"));
        assert!(can_manage_support_access("admin"));
        assert!(!can_manage_support_access("support"));
        assert!(can_view_support_access("security"));
    }

    #[test]
    fn covers_the_complete_operator_role_matrix_without_privilege_creep() {
        let cases = [
            ("viewer", &["admin:read"][..], false, false, false, false),
            (
                "support",
                &["admin:read", "admin:support"][..],
                true,
                false,
                false,
                false,
            ),
            (
                "security",
                &["admin:read", "admin:security"][..],
                false,
                false,
                false,
                false,
            ),
            (
                "operator",
                &["admin:read", "admin:write", "admin:operate"][..],
                true,
                true,
                false,
                false,
            ),
            (
                "admin",
                &["admin:read", "admin:write", "admin:operate"][..],
                true,
                true,
                true,
                false,
            ),
            (
                "superadmin",
                &[
                    "admin:read",
                    "admin:write",
                    "admin:operate",
                    "admin:support",
                    "admin:security",
                    "admin:emergency",
                ][..],
                true,
                true,
                true,
                true,
            ),
            (
                "owner",
                &[
                    "admin:read",
                    "admin:write",
                    "admin:operate",
                    "admin:support",
                    "admin:security",
                    "admin:emergency",
                ][..],
                true,
                true,
                true,
                true,
            ),
        ];

        for (role, expected_grants, customer_content, commands, support_management, emergency) in
            cases
        {
            let grants = grants_for_role(role);
            assert_eq!(
                grants,
                expected_grants
                    .iter()
                    .map(|grant| (*grant).to_string())
                    .collect()
            );
            assert_eq!(can_view_customer_content(role), customer_content, "{role}");
            assert_eq!(can_execute_operator_command(role), commands, "{role}");
            assert_eq!(
                can_manage_support_access(role),
                support_management,
                "{role}"
            );
            assert_eq!(can_use_emergency_access(role), emergency, "{role}");
            assert!(can_view_support_access(role) || role == "viewer");
        }

        for role in [" VIEWER ", "SUPPORT", "Security", "OPERATOR", "ADMIN"] {
            assert!(
                !grants_for_role(role).is_empty(),
                "role should normalize: {role}"
            );
        }
        assert!(grants_for_role("unknown").is_empty());
        assert!(!can_view_support_access("unknown"));
        assert!(!can_use_emergency_access("unknown"));
    }
}
