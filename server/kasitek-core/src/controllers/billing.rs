use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::billing_provider::BillingProvider;
use crate::services::paystack::PaystackProvider;
use crate::services::{billing, credits, orgs, referrals};

#[derive(Deserialize)]
pub struct CheckoutRequest {
    #[serde(rename = "planKey")]
    pub plan_key: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Deserialize)]
pub struct UsageQuery {
    pub range: Option<String>,
}

fn paystack_provider(config: &crate::config::AppConfig) -> Result<PaystackProvider, AppError> {
    let secret = config
        .paystack_secret_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Internal("Paystack is not configured".to_string()))?;
    Ok(PaystackProvider::new(secret, &config.paystack_api_base_url))
}

pub async fn summary(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let summary = billing::get_billing_summary(pool.get_ref(), &org_id).await?;

    Ok(HttpResponse::Ok().json(summary))
}

pub async fn usage(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<UsageQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;
    let days = match query.range.as_deref().unwrap_or("30d") {
        "7d" => 7,
        "30d" => 30,
        "90d" => 90,
        _ => {
            return Err(AppError::BadRequest(
                "Usage range must be 7d, 30d, or 90d".to_string(),
            ))
        }
    };
    let usage = billing::get_billing_usage(pool.get_ref(), &org_id, days).await?;
    let summary = billing::get_billing_summary(pool.get_ref(), &org_id).await?;
    let account = credits::get_credit_account(pool.get_ref(), &org_id).await?;
    let recent = credits::get_credit_usage(pool.get_ref(), &org_id, 20).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "rangeStart": usage.range_start,
        "rangeEnd": usage.range_end,
        "timezone": usage.timezone,
        "granularity": usage.granularity,
        "daily": usage.daily,
        "previousDaily": usage.previous_daily,
        "credits": {
            "used": usage.credits_used,
            "balance": account.balance,
            "reserved": account.reserved_balance,
            "available": account.available_balance,
        },
        "operations": usage.operations,
        "breakdown": usage.breakdown,
        "meters": summary.meters,
        "recent": recent,
    })))
}

pub async fn credits(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;
    let account = credits::get_credit_account(pool.get_ref(), &org_id).await?;
    let usage = credits::get_credit_usage(pool.get_ref(), &org_id, 100).await?;
    let referral = referrals::get_referral_summary(
        pool.get_ref(),
        &org_id,
        referrals::ReferralRewardConfig::from_config(config.get_ref()),
        &config.frontend_url,
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "account": account,
        "usage": usage,
        "referral": referral,
    })))
}

pub async fn plans(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok()
        .json(serde_json::json!({"plans": billing::list_available_plans(pool.get_ref()).await?})))
}

pub async fn plan_details(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    plan_key: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let details = billing::get_available_plan_details(pool.get_ref(), &plan_key).await?;
    Ok(HttpResponse::Ok().json(details))
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
    let provider = paystack_provider(config.get_ref())?;
    Ok(HttpResponse::Ok().json(
        billing::create_checkout(
            pool.get_ref(),
            &provider,
            &config.frontend_url,
            &org_id,
            &user.id,
            email,
            &body.plan_key,
            &body.idempotency_key,
        )
        .await?,
    ))
}

pub async fn verify_checkout(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    reference: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let provider = paystack_provider(config.get_ref())?;
    let result = billing::verify_checkout(
        pool.get_ref(),
        &provider,
        &org_id,
        &reference,
        crate::services::referrals::ReferralRewardConfig::from_config(config.get_ref()),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn set_subscription_enabled(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let (subscription_id, action) = path.into_inner();
    let enabled = match action.as_str() {
        "reactivate" => true,
        "cancel" => false,
        _ => {
            return Err(AppError::BadRequest(
                "Unsupported subscription action".to_string(),
            ))
        }
    };
    let provider = paystack_provider(config.get_ref())?;
    billing::set_subscription_enabled(
        pool.get_ref(),
        &provider,
        &org_id,
        &subscription_id,
        enabled,
    )
    .await?;
    Ok(
        HttpResponse::Ok()
            .json(serde_json::json!({"updated": true, "cancelAtPeriodEnd": !enabled})),
    )
}

pub async fn paystack_webhook(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
    payload: web::Bytes,
) -> Result<HttpResponse, AppError> {
    let signature = req
        .headers()
        .get("x-paystack-signature")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let provider = paystack_provider(config.get_ref())?;
    if !provider.verify_webhook(&payload, signature) {
        return Err(AppError::Unauthorized);
    }
    let event: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|_| AppError::BadRequest("Invalid Paystack webhook payload".to_string()))?;
    let provider_event = provider.parse_webhook(&event)?;
    let event_key = billing::paystack_event_key(&event)?;
    if !billing::record_paystack_event(pool.get_ref(), &event_key, &event).await? {
        return Ok(
            HttpResponse::Ok().json(serde_json::json!({"received": true, "duplicate": true}))
        );
    }
    let processed = match billing::process_provider_event(
        pool.get_ref(),
        provider.name(),
        provider_event,
        crate::services::referrals::ReferralRewardConfig::from_config(config.get_ref()),
    )
    .await
    {
        Ok(processed) => {
            billing::finish_paystack_event(
                pool.get_ref(),
                &event_key,
                if processed { "PROCESSED" } else { "IGNORED" },
                None,
            )
            .await?;
            processed
        }
        Err(error) => {
            billing::finish_paystack_event(
                pool.get_ref(),
                &event_key,
                "FAILED",
                Some(&error.to_string()),
            )
            .await?;
            return Err(error);
        }
    };
    Ok(HttpResponse::Ok().json(serde_json::json!({"received": true, "processed": processed})))
}
