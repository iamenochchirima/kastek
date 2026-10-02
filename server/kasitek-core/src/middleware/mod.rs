use actix_web::HttpRequest;
use sqlx::PgPool;

use crate::config::{ADMIN_SESSION_COOKIE, USER_SESSION_COOKIE};
use crate::db::models::{AdminUser, User};
use crate::error::AppError;
use crate::services::orgs;

pub const ACTIVE_ORG_COOKIE: &str = "kasitek_active_org";

pub(crate) fn active_org_cookie(req: &HttpRequest) -> Option<String> {
    req.cookie(ACTIVE_ORG_COOKIE)
        .map(|cookie| cookie.value().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn extract_bearer_token(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get("Authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
}

fn extract_user_session_token(req: &HttpRequest) -> Option<String> {
    req.cookie(USER_SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .or_else(|| extract_bearer_token(req))
}

pub async fn extract_user_allow_unverified(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<User, AppError> {
    if req.cookie(USER_SESSION_COOKIE).is_some()
        && !matches!(
            *req.method(),
            actix_web::http::Method::GET
                | actix_web::http::Method::HEAD
                | actix_web::http::Method::OPTIONS
        )
    {
        let config = req
            .app_data::<actix_web::web::Data<crate::config::AppConfig>>()
            .ok_or(AppError::Unauthorized)?;
        crate::controllers::auth::require_origin(req, config)?;
    }
    let token = extract_user_session_token(req).ok_or(AppError::Unauthorized)?;

    let user_id =
        crate::services::identity::check_session(pool, &crypto_utils::sha256_hex(&token), req)
            .await?;

    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT
            id,
            name,
            email,
            phone,
            image,
            password,
            "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
            "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "User"
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    Ok(user)
}

pub async fn extract_user(req: &HttpRequest, pool: &PgPool) -> Result<User, AppError> {
    let user = extract_user_allow_unverified(req, pool).await?;
    if user.email_verified.is_none() {
        return Err(AppError::Forbidden(
            "Verify your email before accessing your workspace".to_string(),
        ));
    }
    Ok(user)
}

/// Resolve the active workspace and verify the authenticated user belongs to it.
/// The cookie is a workspace preference only; membership is always checked against the database.
pub async fn resolve_active_org_id(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: &str,
) -> Result<String, AppError> {
    if let Some(org_id) = active_org_cookie(req) {
        orgs::require_member(pool, &org_id, user_id).await?;
        return Ok(org_id);
    }

    orgs::list_orgs_for_user(pool, user_id)
        .await?
        .into_iter()
        .next()
        .map(|org| org.id)
        .ok_or_else(|| {
            AppError::Forbidden("No organisation is available for this user".to_string())
        })
}

pub async fn extract_admin(req: &HttpRequest, pool: &PgPool) -> Result<AdminUser, AppError> {
    let admin_id = req
        .cookie(ADMIN_SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or(AppError::Unauthorized)?;

    sqlx::query_as::<_, AdminUser>(
        r#"
        SELECT id, name, email, password, role,
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
               "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "AdminUser"
        WHERE id = $1
        "#,
    )
    .bind(admin_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)
}

pub fn require_admin_role(admin: &AdminUser, roles: &[&str]) -> Result<(), AppError> {
    if roles
        .iter()
        .any(|role| role.eq_ignore_ascii_case(admin.role.trim()))
    {
        Ok(())
    } else {
        Err(AppError::Forbidden("Insufficient permissions".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::active_org_cookie;
    use actix_web::test::TestRequest;

    #[test]
    fn organization_headers_cannot_supply_product_scope() {
        let request = TestRequest::default()
            .insert_header(("x-organization-id", "attacker-org"))
            .to_http_request();
        assert_eq!(active_org_cookie(&request), None);
    }

    #[test]
    fn active_workspace_scope_only_comes_from_the_bounded_cookie() {
        let request = TestRequest::default()
            .cookie(actix_web::cookie::Cookie::new(
                super::ACTIVE_ORG_COOKIE,
                " org-a ",
            ))
            .to_http_request();
        assert_eq!(active_org_cookie(&request).as_deref(), Some("org-a"));
    }
}

#[cfg(test)]
mod csrf_tests {
    use super::*;
    #[actix_web::test]
    async fn cookie_mutations_cannot_skip_origin_validation_when_configuration_is_missing() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        for method in [
            actix_web::http::Method::POST,
            actix_web::http::Method::PUT,
            actix_web::http::Method::PATCH,
            actix_web::http::Method::DELETE,
        ] {
            let req = actix_web::test::TestRequest::default()
                .method(method)
                .uri("/api/orgs")
                .cookie(actix_web::cookie::Cookie::new(
                    USER_SESSION_COOKIE,
                    "opaque",
                ))
                .insert_header(("Origin", "https://other.example.test"))
                .to_http_request();
            assert!(matches!(
                extract_user_allow_unverified(&req, &pool).await,
                Err(AppError::Unauthorized)
            ));
        }
    }
}
