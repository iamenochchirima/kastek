#[path = "../../../kasitek-core/src/controllers/whatsapp_calls.rs"]
mod shared;

pub use shared::*;

use actix_web::{web, HttpResponse};
use serde_json::Value;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::whatsapp_calls;

pub async fn receive_provider_call_webhook(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    whatsapp_calls::ingest_webhook_calls(pool.get_ref(), config.get_ref(), &body).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "success": true
    })))
}
