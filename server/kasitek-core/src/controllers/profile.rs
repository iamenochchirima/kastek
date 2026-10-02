use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::{
    OnboardingPhoneRequest, ProfileBootstrapResponse, UpdateProfileRequest, UserProfileResponse,
};
use crate::error::AppError;
use crate::middleware::extract_user;

pub async fn get(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
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
    .bind(
        body.name
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.phone
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty()),
    )
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
    sqlx::query(r#"UPDATE "User" SET phone = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(phone)
        .bind(user.id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Phone number saved" })))
}
