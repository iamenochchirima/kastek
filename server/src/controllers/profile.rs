use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::{hash, verify};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    ChangeEmailRequest, ChangePasswordRequest, OnboardingPhoneRequest, ProfileBootstrapResponse,
    UpdateProfileRequest, UserProfileResponse,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::auth::{issue_verification_token, send_email};

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(ProfileBootstrapResponse {
        has_password: user.password.is_some(),
        user: UserProfileResponse::from(user),
    }))
}

pub async fn patch(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpdateProfileRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;

    let image = body
        .image
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(image_url) = image.as_ref() {
        if !image_url.starts_with("http://") && !image_url.starts_with("https://") {
            return Err(AppError::BadRequest(
                "Photo URL must start with http:// or https://".to_string(),
            ));
        }
    }

    let updated = sqlx::query_as::<_, crate::db::models::User>(
        r#"
        UPDATE "User"
        SET
            name = $1,
            phone = $2,
            image = $3,
            "updatedAt" = NOW()
        WHERE id = $4
        RETURNING
            id,
            name,
            email,
            phone,
            image,
            password,
            "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
            "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        "#,
    )
    .bind(body.name.as_ref().map(|value| value.trim()).filter(|v| !v.is_empty()))
    .bind(body.phone.as_ref().map(|value| value.trim()).filter(|v| !v.is_empty()))
    .bind(image)
    .bind(user.id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user": UserProfileResponse::from(updated)
    })))
}

pub async fn save_onboarding_phone(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<OnboardingPhoneRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let phone = body
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Phone number is required".to_string()))?;
    if !body.phone_verified.unwrap_or(false) {
        return Err(AppError::BadRequest("Phone number must be verified".to_string()));
    }
    sqlx::query(r#"UPDATE "User" SET phone = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(phone)
        .bind(user.id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Phone number saved" })))
}

pub async fn request_email_change(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<ChangeEmailRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let next_email = body
        .email
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Email is required".to_string()))?;
    if !(next_email.contains('@') && next_email.split('@').count() == 2 && next_email.contains('.')) {
        return Err(AppError::BadRequest("Enter a valid email address".to_string()));
    }
    if user.email.as_deref().is_some_and(|email| email.eq_ignore_ascii_case(&next_email)) {
        return Err(AppError::BadRequest(
            "That is already your current email address".to_string(),
        ));
    }
    let existing = sqlx::query_scalar::<_, String>(r#"SELECT id FROM "User" WHERE email = $1 LIMIT 1"#)
        .bind(&next_email)
        .fetch_optional(pool.get_ref())
        .await?;
    if existing.is_some() {
        return Err(AppError::Conflict(
            "An account with that email already exists".to_string(),
        ));
    }

    let identifier = format!(
        "profile-email-change|{}|{}",
        user.id,
        urlencoding::encode(&next_email)
    );
    sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier LIKE $1"#)
        .bind(format!("profile-email-change|{}|%", user.id))
        .execute(pool.get_ref())
        .await?;
    let token = issue_verification_token(pool.get_ref(), &identifier).await?;
    let verify_url = format!(
        "{}/api/profile/email/verify?token={}&change={}",
        config.auth_url,
        urlencoding::encode(&token),
        urlencoding::encode(&identifier)
    );
    send_email(
        config.get_ref(),
        &next_email,
        "Confirm your new KasiTek email address",
        &format!(
            "Click this link to confirm your new email address: {}\n\nThis link expires in 24 hours.",
            verify_url
        ),
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Verification link sent. Open it from your new email to complete the change."
    })))
}

pub async fn verify_email_change(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let token = query.get("token").cloned().unwrap_or_default();
    let change = query.get("change").cloned().unwrap_or_default();
    if token.is_empty() || change.is_empty() {
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("{}/auth-error?error=InvalidToken", config.auth_url)))
            .finish());
    }
    let record = sqlx::query_as::<_, (String, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT token, expires FROM "VerificationToken" WHERE identifier = $1 AND token = $2 LIMIT 1"#,
    )
    .bind(&change)
    .bind(&token)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some((_token, expires)) = record else {
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("{}/auth-error?error=InvalidToken", config.auth_url)))
            .finish());
    };
    if expires < chrono::Utc::now() {
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("{}/auth-error?error=ExpiredToken", config.auth_url)))
            .finish());
    }
    let parts = change.split('|').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "profile-email-change" {
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("{}/auth-error?error=InvalidToken", config.auth_url)))
            .finish());
    }
    let user_id = parts[1];
    let next_email = urlencoding::decode(parts[2])
        .map(|value| value.to_string())
        .unwrap_or_default();

    let existing = sqlx::query_scalar::<_, String>(r#"SELECT id FROM "User" WHERE email = $1 LIMIT 1"#)
        .bind(&next_email)
        .fetch_optional(pool.get_ref())
        .await?;
    if existing.is_some() {
        sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier = $1 AND token = $2"#)
            .bind(&change)
            .bind(&token)
            .execute(pool.get_ref())
            .await?;
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("{}/workspace/profile?emailChange=conflict", config.auth_url)))
            .finish());
    }

    sqlx::query(r#"UPDATE "User" SET email = $1, "emailVerified" = NOW(), "updatedAt" = NOW() WHERE id = $2"#)
        .bind(&next_email)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    sqlx::query(r#"DELETE FROM "VerificationToken" WHERE identifier = $1 AND token = $2"#)
        .bind(&change)
        .bind(&token)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Found()
        .append_header(("Location", format!("{}/workspace/profile?emailChange=success", config.auth_url)))
        .finish())
}

pub async fn change_password(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<ChangePasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let next_password = body.next_password.as_deref().unwrap_or("");
    if next_password.len() < 8 {
        return Err(AppError::BadRequest(
            "New password must be at least 8 characters".to_string(),
        ));
    }
    if let Some(current_hash) = user.password.as_deref() {
        let current_password = body.current_password.as_deref().unwrap_or("");
        if current_password.is_empty() {
            return Err(AppError::BadRequest("Current password is required".to_string()));
        }
        if !verify(current_password, current_hash)? {
            return Err(AppError::BadRequest("Current password is incorrect".to_string()));
        }
    }

    let hashed_password = hash(next_password, 12)?;
    sqlx::query(r#"UPDATE "User" SET password = $1, "emailVerified" = NOW(), "updatedAt" = NOW() WHERE id = $2"#)
        .bind(hashed_password)
        .bind(user.id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": if user.password.is_some() {
            "Password updated."
        } else {
            "Password set successfully."
        }
    })))
}
