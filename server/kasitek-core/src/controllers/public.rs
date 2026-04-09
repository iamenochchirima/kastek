use actix_web::{web, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{ProductWaitlistCreateRequest, QuoteRequestCreateRequest};
use crate::error::AppError;
use crate::services::public;

pub async fn create_quote_request(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<QuoteRequestCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let result =
        public::create_quote_request(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn create_waitlist_entry(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<ProductWaitlistCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let result =
        public::create_waitlist_entry(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created().json(result))
}
