use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::billing;

pub async fn summary(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let summary = billing::get_billing_summary(pool.get_ref(), &org_id).await?;

    Ok(HttpResponse::Ok().json(summary))
}
