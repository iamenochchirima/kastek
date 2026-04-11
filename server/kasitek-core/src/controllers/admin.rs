use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::verify;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{AdminUser, AdminUserResponse, LoginRequest};
use crate::error::AppError;
use crate::middleware::{extract_admin, require_admin_role};

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
