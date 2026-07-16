use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_admin, require_admin_role};
use crate::services::billing;
use crate::services::billing_provider::BillingProvider;
use crate::services::paystack::PaystackProvider;

#[derive(Deserialize)]
pub struct CreateGrantRequest {
    pub key: String,
    pub value: Value,
    #[serde(rename = "endsAt")]
    pub ends_at: Option<DateTime<Utc>>,
    pub reason: String,
}

#[derive(Deserialize)]
pub struct IssueQuery {
    pub status: Option<String>,
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
    let result = billing::reconcile_billing(pool.get_ref(), &provider, 100).await?;
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
