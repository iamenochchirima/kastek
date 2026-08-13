use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::{hash, verify};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    AdminForgotPasswordRequest, AdminResetPasswordRequest, AdminUser, AdminUserResponse,
    ChangePasswordRequest, LoginRequest,
};
use crate::error::AppError;
use crate::identity::admin_session;
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::auth::{issue_verification_token, send_email};
use crate::services::orgs;

#[derive(serde::Deserialize)]
pub struct ProvisionLaunchUserRequest {
    pub name: String,
    pub email: String,
    #[serde(rename = "workspaceName")]
    pub workspace_name: String,
}

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
    let _context = admin_session::resolve(&req, pool.get_ref()).await?;
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
    let context = admin_session::resolve(&req, pool.get_ref()).await?;
    if !context.has_grant("admin:read") {
        return Err(AppError::Forbidden("Insufficient permissions".to_string()));
    }

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

pub async fn list_launch_access(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    require_admin_role(&admin, &["superadmin", "admin", "viewer"])?;
    let users = sqlx::query(
        r#"SELECT i.id, i.email, i.role::text AS role, i."expiresAt", i."acceptedAt", i."revokedAt", i."createdAt",
                  o.id AS "orgId", o.name AS "orgName", u.name
           FROM "OrganizationInvitation" i
           JOIN "Organization" o ON o.id = i."orgId"
           JOIN "User" u ON lower(u.email) = lower(i.email)
           WHERE u.password IS NULL OR i."acceptedAt" IS NOT NULL
           ORDER BY i."createdAt" DESC"#,
    ).fetch_all(pool.get_ref()).await?;
    let now = chrono::Utc::now();
    let access = users.into_iter().map(|row| {
        let expires_at: chrono::DateTime<chrono::Utc> = sqlx::Row::try_get(&row, "expiresAt").unwrap_or(now);
        let accepted_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::Row::try_get(&row, "acceptedAt").unwrap_or(None);
        let revoked_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::Row::try_get(&row, "revokedAt").unwrap_or(None);
        let status = if accepted_at.is_some() { "active" } else if revoked_at.is_some() { "revoked" } else if expires_at <= now { "expired" } else { "pending" };
        serde_json::json!({
            "id": sqlx::Row::try_get::<String, _>(&row, "id").unwrap_or_default(),
            "name": sqlx::Row::try_get::<Option<String>, _>(&row, "name").unwrap_or(None),
            "email": sqlx::Row::try_get::<String, _>(&row, "email").unwrap_or_default(),
            "workspaceId": sqlx::Row::try_get::<String, _>(&row, "orgId").unwrap_or_default(),
            "workspaceName": sqlx::Row::try_get::<String, _>(&row, "orgName").unwrap_or_default(),
            "role": sqlx::Row::try_get::<String, _>(&row, "role").unwrap_or_default(),
            "status": status,
            "expiresAt": expires_at,
            "createdAt": sqlx::Row::try_get::<chrono::DateTime<chrono::Utc>, _>(&row, "createdAt").unwrap_or(now),
        })
    }).collect::<Vec<_>>();
    Ok(HttpResponse::Ok().json(serde_json::json!({ "access": access })))
}

pub async fn provision_launch_user(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<ProvisionLaunchUserRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    require_admin_role(&admin, &["superadmin", "admin"])?;
    let name = body.name.trim();
    let email = body.email.trim().to_ascii_lowercase();
    let workspace_name = body.workspace_name.trim();
    if name.is_empty() || workspace_name.is_empty() || !email.contains('@') {
        return Err(AppError::BadRequest(
            "Name, valid email, and workspace name are required".to_string(),
        ));
    }
    let existing = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(SELECT 1 FROM "User" WHERE lower(email) = lower($1))"#,
    )
    .bind(&email)
    .fetch_one(pool.get_ref())
    .await?;
    if existing {
        return Err(AppError::Conflict(
            "A KasiTek account or launch invitation already exists for this email".to_string(),
        ));
    }
    let user_id = cuid2::create_id();
    sqlx::query(r#"INSERT INTO "User" (id, name, email, "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())"#)
        .bind(&user_id).bind(name).bind(&email).execute(pool.get_ref()).await?;
    let base_slug = orgs::slugify(workspace_name);
    let slug = orgs::unique_slug(pool.get_ref(), &base_slug).await?;
    let org = orgs::create_org(pool.get_ref(), &user_id, workspace_name, &slug, None).await?;
    let invitation = orgs::create_invitation(
        pool.get_ref(),
        config.get_ref(),
        &org.id,
        &org.name,
        &user_id,
        Some(name),
        &email,
        "ADMIN",
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "workspace": org, "invitation": { "id": invitation.id, "email": email, "expiresAt": invitation.expires_at } })))
}

pub async fn resend_launch_access(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    require_admin_role(&admin, &["superadmin", "admin"])?;
    let invite_id = path.into_inner();
    let row = sqlx::query(r#"SELECT i.email, i."orgId", o.name AS "orgName", o."ownerId", u.name AS "ownerName" FROM "OrganizationInvitation" i JOIN "Organization" o ON o.id = i."orgId" JOIN "User" u ON u.id = o."ownerId" WHERE i.id = $1"#)
        .bind(&invite_id).fetch_optional(pool.get_ref()).await?.ok_or_else(|| AppError::NotFound("Launch invitation not found".to_string()))?;
    let email: String = sqlx::Row::try_get(&row, "email").unwrap_or_default();
    let org_id: String = sqlx::Row::try_get(&row, "orgId").unwrap_or_default();
    let org_name: String = sqlx::Row::try_get(&row, "orgName").unwrap_or_default();
    let owner_id: String = sqlx::Row::try_get(&row, "ownerId").unwrap_or_default();
    let owner_name: Option<String> = sqlx::Row::try_get(&row, "ownerName").unwrap_or(None);
    let invitation = orgs::create_invitation(
        pool.get_ref(),
        config.get_ref(),
        &org_id,
        &org_name,
        &owner_id,
        owner_name.as_deref(),
        &email,
        "ADMIN",
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "invitation": { "id": invitation.id, "expiresAt": invitation.expires_at } })))
}

pub async fn revoke_launch_access(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    require_admin_role(&admin, &["superadmin", "admin"])?;
    let invitation_id = path.into_inner();
    let org_id = sqlx::query_scalar::<_, String>(
        r#"SELECT "orgId" FROM "OrganizationInvitation" WHERE id = $1"#,
    )
    .bind(&invitation_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Launch invitation not found".to_string()))?;
    orgs::revoke_invitation(pool.get_ref(), &org_id, &invitation_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "revoked": true })))
}
