use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::billing_provider::BillingProvider;
use crate::services::paystack::PaystackProvider;
use crate::services::{billing, credits, referrals};

#[derive(Deserialize)]
pub struct CreateGrantRequest {
    pub key: String,
    pub value: Value,
    #[serde(rename = "endsAt")]
    pub ends_at: Option<DateTime<Utc>>,
    pub reason: String,
}

#[derive(Deserialize)]
pub struct CreditGrantRequest {
    pub amount: i64,
    pub source: String,
    #[serde(rename = "endsAt")]
    pub ends_at: Option<DateTime<Utc>>,
    pub reason: String,
    pub reference: Option<String>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Deserialize)]
pub struct CreditSetBalanceRequest {
    #[serde(rename = "targetBalance")]
    pub target_balance: i64,
    pub reason: String,
    pub reference: Option<String>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Deserialize)]
pub struct CreditOrganizationQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct IssueQuery {
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct ReferralQuery {
    #[serde(rename = "orgId")]
    pub org_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct ReferralActionRequest {
    pub reason: String,
    pub reference: String,
}

#[derive(Deserialize)]
pub struct ReferralCodeStatusRequest {
    pub status: String,
    pub reason: String,
}

#[derive(Deserialize)]
pub struct UpsertProductRequest {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub active: bool,
}

#[derive(Deserialize)]
pub struct UpsertPlanRequest {
    #[serde(rename = "productKey")]
    pub product_key: String,
    pub key: String,
    pub name: String,
    pub interval: String,
    pub currency: String,
    #[serde(rename = "amountMinor")]
    pub amount_minor: Option<i32>,
    #[serde(rename = "creditsPerPeriod")]
    pub credits_per_period: Option<i64>,
    pub active: bool,
    #[serde(rename = "paystackPlanCode")]
    pub paystack_plan_code: Option<String>,
}

#[derive(Deserialize)]
pub struct UpsertEntitlementRequest {
    #[serde(rename = "planKey")]
    pub plan_key: String,
    pub key: String,
    pub value: Value,
}

async fn require_billing_admin(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<crate::db::models::AdminUser, AppError> {
    let admin = extract_admin(req, pool).await?;
    require_admin_role(&admin, &["superadmin", "admin"])?;
    Ok(admin)
}

pub async fn list_grants(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(
        serde_json::json!({"grants": billing::list_manual_grants(pool.get_ref(), &org_id).await?}),
    ))
}

pub async fn create_grant(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
    body: web::Json<CreateGrantRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let grant = billing::create_manual_grant(
        pool.get_ref(),
        &org_id,
        &body.key,
        body.value.clone(),
        body.ends_at,
        &body.reason,
        &admin.id,
    )
    .await?;
    Ok(HttpResponse::Created().json(grant))
}

pub async fn expire_grant(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    let (org_id, grant_id) = path.into_inner();
    if !billing::expire_manual_grant(pool.get_ref(), &org_id, &grant_id).await? {
        return Err(AppError::NotFound(
            "Active manual grant not found".to_string(),
        ));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({"expired": true})))
}

pub async fn get_credits(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(credits::get_credit_account(pool.get_ref(), &org_id).await?))
}

pub async fn search_credit_organizations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<CreditOrganizationQuery>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    let organizations = credits::search_credit_organizations(
        pool.get_ref(),
        query.q.as_deref(),
        query.limit.unwrap_or(25),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "organizations": organizations })))
}

pub async fn grant_credits(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
    body: web::Json<CreditGrantRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let result = credits::grant_credits(
        pool.get_ref(),
        &org_id,
        body.amount,
        &body.source,
        body.ends_at,
        &body.reason,
        body.reference.as_deref(),
        &admin.id,
        &body.idempotency_key,
    )
    .await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn set_credit_balance(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
    body: web::Json<CreditSetBalanceRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let result = credits::set_credit_balance(
        pool.get_ref(),
        &org_id,
        body.target_balance,
        &body.reason,
        body.reference.as_deref(),
        &admin.id,
        &body.idempotency_key,
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_referrals(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ReferralQuery>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    let items = referrals::list_referral_attributions(
        pool.get_ref(),
        query.org_id.as_deref(),
        query.status.as_deref(),
        query.limit.unwrap_or(100),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "referrals": items })))
}

pub async fn update_referral_code_status(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    org_id: web::Path<String>,
    body: web::Json<ReferralCodeStatusRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let reason = format!("admin:{} {}", admin.id, body.reason.trim());
    let updated =
        referrals::set_referral_code_status(pool.get_ref(), &org_id, &body.status, &reason).await?;
    if !updated {
        return Err(AppError::NotFound("Referral code not found".to_string()));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": true })))
}

pub async fn reject_referral(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    attribution_id: web::Path<String>,
    body: web::Json<ReferralActionRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let reference = format!("admin:{}:{}", admin.id, body.reference.trim());
    let rejected = referrals::reject_referral_attribution(
        pool.get_ref(),
        &attribution_id,
        &body.reason,
        &reference,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "rejected": rejected })))
}

pub async fn reverse_referral(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    attribution_id: web::Path<String>,
    body: web::Json<ReferralActionRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = require_billing_admin(&req, pool.get_ref()).await?;
    let reference = format!("admin:{}:{}", admin.id, body.reference.trim());
    let reversed = referrals::reverse_referral_attribution(
        pool.get_ref(),
        &attribution_id,
        &body.reason,
        &reference,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "reversed": reversed })))
}

pub async fn reconcile_paystack(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    let secret = config
        .paystack_secret_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Internal("Paystack is not configured".to_string()))?;
    let provider = PaystackProvider::new(secret, &config.paystack_api_base_url);
    let result = billing::reconcile_billing(
        pool.get_ref(),
        &provider,
        100,
        crate::services::referrals::ReferralRewardConfig::from_config(config.get_ref()),
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "provider": provider.name(),
        "mode": config.paystack_mode,
        "result": result,
    })))
}

pub async fn list_reconciliation_issues(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<IssueQuery>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "issues": billing::list_reconciliation_issues(pool.get_ref(), status).await?,
    })))
}

pub async fn catalog(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(billing::admin_catalog(pool.get_ref()).await?))
}

pub async fn upsert_product(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpsertProductRequest>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(
        billing::upsert_product(
            pool.get_ref(),
            &body.key,
            &body.name,
            body.description.as_deref(),
            body.active,
        )
        .await?,
    ))
}

pub async fn upsert_plan(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpsertPlanRequest>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(
        billing::upsert_plan(
            pool.get_ref(),
            &body.product_key,
            &body.key,
            &body.name,
            &body.interval,
            &body.currency,
            body.amount_minor,
            body.credits_per_period,
            body.active,
            body.paystack_plan_code.as_deref(),
        )
        .await?,
    ))
}

pub async fn upsert_entitlement(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpsertEntitlementRequest>,
) -> Result<HttpResponse, AppError> {
    require_billing_admin(&req, pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(
        billing::upsert_plan_entitlement(
            pool.get_ref(),
            &body.plan_key,
            &body.key,
            body.value.clone(),
        )
        .await?,
    ))
}
