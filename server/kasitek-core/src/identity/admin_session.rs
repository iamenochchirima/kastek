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
        "admin" | "superadmin" => ["admin:read".to_string(), "admin:write".to_string()]
            .into_iter()
            .collect(),
        _ => BTreeSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::grants_for_role;

    #[test]
    fn maps_admin_roles_to_narrow_platform_grants() {
        assert!(grants_for_role("viewer").contains("admin:read"));
        assert!(!grants_for_role("viewer").contains("admin:write"));
        assert!(grants_for_role("admin").contains("admin:write"));
        assert!(grants_for_role("superadmin").contains("admin:write"));
        assert!(grants_for_role("unknown").is_empty());
    }
}
