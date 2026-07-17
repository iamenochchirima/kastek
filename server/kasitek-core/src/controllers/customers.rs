use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::customers;

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let detail = customers::get_customer_detail(pool.get_ref(), &org_id, &path)
        .await?
        .ok_or_else(|| AppError::NotFound("Customer not found".to_string()))?;
    Ok(HttpResponse::Ok().json(detail))
}
