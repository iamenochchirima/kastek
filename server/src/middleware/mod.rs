use actix_web::HttpRequest;
use sqlx::PgPool;

use crate::config::{ADMIN_SESSION_COOKIE, USER_SESSION_COOKIE};
use crate::db::models::{AdminUser, SessionRecord, User};
use crate::error::AppError;

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

pub async fn extract_user(req: &HttpRequest, pool: &PgPool) -> Result<User, AppError> {
    let token = extract_user_session_token(req).ok_or(AppError::Unauthorized)?;

    let session = sqlx::query_as::<_, SessionRecord>(
        r#"
        SELECT id, "sessionToken", "userId", expires
        FROM "Session"
        WHERE "sessionToken" = $1 AND expires > NOW()
        "#,
    )
    .bind(token)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let _ = (&session.id, &session.session_token, &session.expires);

    sqlx::query_as::<_, User>(
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
    .bind(session.user_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)
}

pub async fn extract_admin(req: &HttpRequest, pool: &PgPool) -> Result<AdminUser, AppError> {
    let admin_id = req
        .cookie(ADMIN_SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or(AppError::Unauthorized)?;

    sqlx::query_as::<_, AdminUser>(
        r#"
        SELECT id, name, email, password, role, "createdAt", "updatedAt"
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
    if roles.contains(&admin.role.as_str()) {
        Ok(())
    } else {
        Err(AppError::Forbidden("Insufficient permissions".to_string()))
    }
}
