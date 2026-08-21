use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::Value;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::agent_platform::AgentPlatformClient;

pub async fn receive_webhook(
    config: web::Data<AppConfig>,
    request: HttpRequest,
    connection_id: web::Path<String>,
    body: web::Json<Value>,
) -> Result<HttpResponse, AppError> {
    let provider_secret = request
        .headers()
        .get("x-telegram-bot-api-secret-token")
        .and_then(|value| value.to_str().ok());
    AgentPlatformClient::from_config(config.get_ref())?
        .forward_telegram_webhook(connection_id.trim(), provider_secret, body.into_inner())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true })))
}
