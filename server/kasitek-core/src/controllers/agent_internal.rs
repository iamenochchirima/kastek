//! Private, read-only boundary used by the standalone Agent Platform service.
//!
//! This deliberately does not reuse browser session authentication. Agent
//! workers are service principals, so they authenticate with a dedicated
//! bearer token and must provide the organisation they are acting for. Every
//! query is scoped by that organisation in the service layer.

use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::customers;

fn require_internal_agent(
    config: &AppConfig,
    req: &HttpRequest,
) -> Result<(String, String), AppError> {
    let expected = config
        .agents_internal_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let provided = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AppError::Unauthorized)?;
    if provided != expected {
        return Err(AppError::Unauthorized);
    }

    let organization_id = req
        .headers()
        .get("x-organization-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("x-organization-id is required".to_string()))?;
    let actor_id = req
        .headers()
        .get("x-actor-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kasitek-agent-platform");

    Ok((organization_id.to_string(), actor_id.to_string()))
}

/// Read a customer and its scoped identities, conversations, bookings, and
/// agent activity. No write-capable operation is exposed from this boundary.
pub async fn get_customer(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let (organization_id, actor_id) = require_internal_agent(config.get_ref(), &req)?;
    let customer_id = path.into_inner();
    let detail = customers::get_customer_detail(pool.get_ref(), &organization_id, &customer_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Customer not found".to_string()))?;

    log::info!(
        "agent core read tool=customer.get org_id={} actor_id={} customer_id={}",
        organization_id,
        actor_id,
        customer_id
    );
    Ok(HttpResponse::Ok().json(detail))
}
