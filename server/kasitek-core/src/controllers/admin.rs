use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::{hash, verify};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    AdminForgotPasswordRequest, AdminResetPasswordRequest, AdminUser, AdminUserResponse,
    ChangePasswordRequest, LoginRequest,
};
use crate::error::AppError;
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::auth::{issue_verification_token, send_email};

fn admin_password_reset_identifier(admin_id: &str) -> String {
    format!("admin-password-reset:{admin_id}")
}

pub async fn login(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = sqlx::query_as::<_, AdminUser>(
        r#"
        SELECT id, name, email, password, role,
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
               "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "AdminUser"
        WHERE lower(email) = lower($1)
        LIMIT 1
        "#,
    )
    .bind(body.email.trim().to_lowercase())
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::Unauthorized)?;

    if !verify(body.password.trim(), &admin.password)? {
        return Err(AppError::Unauthorized);
    }

    Ok(HttpResponse::Ok()
        .cookie(config.build_admin_session_cookie(&admin.id))
        .json(AdminUserResponse::from(admin)))
}

pub async fn logout(config: web::Data<AppConfig>) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse::Ok()
        .cookie(config.clear_admin_session_cookie())
        .json(serde_json::json!({ "message": "Logged out" })))
}

pub async fn me(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(AdminUserResponse::from(admin)))
}

pub async fn request_password_reset(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<AdminForgotPasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body.email.as_deref().unwrap_or("").trim().to_lowercase();
    if email.is_empty() {
        return Err(AppError::BadRequest("Email is required".to_string()));
    }

    let admin = sqlx::query_as::<_, AdminUser>(
        r#"
        SELECT id, name, email, password, role,
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
               "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "AdminUser"
        WHERE lower(email) = lower($1)
        LIMIT 1
        "#,
    )
    .bind(&email)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(admin) = admin {
        let token =
            issue_verification_token(pool.get_ref(), &admin_password_reset_identifier(&admin.id))
                .await?;
        let reset_url = format!(
            "{}/reset-password?token={}&email={}",
            config.admin_frontend_url.trim_end_matches('/'),
            token,
            urlencoding::encode(&admin.email)
        );

        send_email(
            config.get_ref(),
            &admin.email,
            "Reset your KasiTek admin password",
            &format!(
                "Use this link to reset your KasiTek admin password: {}",
                reset_url
            ),
        )
        .await?;
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "If an admin account exists for that email, a reset link has been sent."
    })))
}

pub async fn reset_password(
    pool: web::Data<PgPool>,
    body: web::Json<AdminResetPasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let email = body.email.as_deref().unwrap_or("").trim().to_lowercase();
    let token = body.token.as_deref().unwrap_or("").trim().to_string();
    let password = body.password.as_deref().unwrap_or("").trim().to_string();

    if email.is_empty() || token.is_empty() || password.is_empty() {
        return Err(AppError::BadRequest(
            "Email, token, and password are required".to_string(),
        ));
    }

    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    let admin = sqlx::query_as::<_, AdminUser>(
        r#"
        SELECT id, name, email, password, role,
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
               "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "AdminUser"
        WHERE lower(email) = lower($1)
        LIMIT 1
        "#,
    )
    .bind(&email)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::BadRequest(
        "Invalid or expired password reset token".to_string(),
    ))?;

    let identifier = admin_password_reset_identifier(&admin.id);
    let valid_token = sqlx::query_scalar::<_, String>(
        r#"
        DELETE FROM "VerificationToken"
        WHERE identifier = $1
          AND token = $2
          AND expires > NOW()
        RETURNING token
        "#,
    )
    .bind(&identifier)
    .bind(&token)
    .fetch_optional(pool.get_ref())
    .await?;

    if valid_token.is_none() {
        return Err(AppError::BadRequest(
            "Invalid or expired password reset token".to_string(),
        ));
    }

    let password_hash = hash(password, 12)?;
    sqlx::query(r#"UPDATE "AdminUser" SET password = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(password_hash)
        .bind(admin.id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Password reset successfully."
    })))
}

pub async fn change_password(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<ChangePasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    let current_password = body.current_password.as_deref().unwrap_or("");
    let next_password = body.next_password.as_deref().unwrap_or("");

    if current_password.is_empty() {
        return Err(AppError::BadRequest(
            "Current password is required".to_string(),
        ));
    }

    if next_password.len() < 8 {
        return Err(AppError::BadRequest(
            "New password must be at least 8 characters".to_string(),
        ));
    }

    if !verify(current_password, &admin.password)? {
        return Err(AppError::BadRequest(
            "Current password is incorrect".to_string(),
        ));
    }

    let password_hash = hash(next_password, 12)?;
    sqlx::query(r#"UPDATE "AdminUser" SET password = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(password_hash)
        .bind(admin.id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Password updated."
    })))
}

pub async fn stats(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    require_admin_role(&admin, &["superadmin", "admin", "viewer"])?;

    let total_users = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "User""#)
        .fetch_one(pool.get_ref())
        .await?;
    let total_admins = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "AdminUser""#)
        .fetch_one(pool.get_ref())
        .await?;
    let total_social_posts = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "SocialPost""#)
        .fetch_one(pool.get_ref())
        .await
        .unwrap_or(0);
    let total_whatsapp_campaigns =
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "WhatsappCampaign""#)
            .fetch_one(pool.get_ref())
            .await
            .unwrap_or(0);

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "totalUsers": total_users,
        "totalAdmins": total_admins,
        "totalSocialPosts": total_social_posts,
        "totalWhatsappCampaigns": total_whatsapp_campaigns,
    })))
}
