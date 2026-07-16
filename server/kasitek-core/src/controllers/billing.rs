use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{billing, orgs};

#[derive(Deserialize)]
pub struct CheckoutRequest {
    #[serde(rename = "planKey")]
    pub plan_key: String,
}

pub async fn summary(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let summary = billing::get_billing_summary(pool.get_ref(), &org_id).await?;

    Ok(HttpResponse::Ok().json(summary))
}

pub async fn plans(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok()
        .json(serde_json::json!({"plans": billing::list_available_plans(pool.get_ref()).await?})))
}

pub async fn checkout(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    body: web::Json<CheckoutRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let email = user
        .email
        .as_deref()
        .filter(|email| !email.trim().is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("An account email is required for checkout".to_string())
        })?;
    Ok(HttpResponse::Ok().json(
        billing::create_paystack_checkout(
            pool.get_ref(),
            config.get_ref(),
            &org_id,
            &user.id,
            email,
            &body.plan_key,
        )
        .await?,
    ))
}
