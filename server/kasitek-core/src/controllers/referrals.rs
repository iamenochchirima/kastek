use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{orgs, referrals};

#[derive(Deserialize)]
pub struct AttributeReferralRequest {
    pub code: String,
}

pub async fn get_code(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;
    Ok(HttpResponse::Ok().json(
        referrals::get_referral_summary(
            pool.get_ref(),
            &org_id,
            referrals::ReferralRewardConfig::from_config(config.get_ref()),
            &config.frontend_url,
        )
        .await?,
    ))
}

pub async fn attribute(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<AttributeReferralRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let created = referrals::attribute_referral(
        pool.get_ref(),
        &org_id,
        &body.code,
        referrals::ReferralRewardConfig::from_config(config.get_ref()),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "attributed": created })))
}
