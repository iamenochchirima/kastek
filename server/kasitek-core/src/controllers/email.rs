use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{email, orgs};

#[derive(Debug, Default, Deserialize)]
pub struct EmailOAuthStartQuery {
    #[serde(rename = "returnTo")]
    pub return_to: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EmailOAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    #[serde(rename = "error_description")]
    pub error_description: Option<String>,
}

pub async fn providers() -> Result<HttpResponse, AppError> {
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "providers": email::provider_options(),
        "customEmail": { "status": "coming_soon" }
    })))
}

pub async fn list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let connections = email::list(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "connections": connections })))
}

pub async fn start_oauth(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<EmailOAuthStartQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let provider = email::provider_config(config.get_ref(), &path)?;
    let return_path = email::safe_return_path(query.return_to.as_deref());
    let state = email::create_oauth_state(
        pool.get_ref(),
        &org_id,
        &user.id,
        &provider,
        &return_path,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "provider": provider.provider,
        "authorizationUrl": email::authorization_url(&provider, &state)
    })))
}

pub async fn oauth_callback(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
    query: web::Query<EmailOAuthCallbackQuery>,
) -> Result<HttpResponse, AppError> {
    let state = query.state.as_deref().ok_or_else(|| AppError::BadRequest("Email OAuth state is missing".to_string()))?;
    let state_record = email::consume_oauth_state(pool.get_ref(), state).await?;
    let Some(state_record) = state_record else {
        return Err(AppError::BadRequest("Email OAuth state is invalid or expired".to_string()));
    };
    let expected_provider = email::normalize_provider(&path)?;
    if state_record.provider != expected_provider {
        return Err(AppError::BadRequest("Email OAuth provider does not match the request".to_string()));
    }
    if let Some(error) = query.error.as_deref() {
        let code = if error == "access_denied" { "access_denied" } else { "provider_error" };
        return Ok(HttpResponse::Found()
            .append_header(("Location", email::frontend_redirect(config.get_ref(), &email::oauth_error_path(Some(&state_record), code))))
            .finish());
    }
    let code = query.code.as_deref().ok_or_else(|| AppError::BadRequest("Email OAuth code is missing".to_string()))?;
    match email::finish_oauth(pool.get_ref(), config.get_ref(), state_record.clone(), code).await {
        Ok(_) => Ok(HttpResponse::Found()
            .append_header(("Location", email::frontend_redirect(config.get_ref(), &email::oauth_success_path(&state_record, expected_provider))))
            .finish()),
        Err(error) => {
            let code = error.code();
            Ok(HttpResponse::Found()
                .append_header(("Location", email::frontend_redirect(config.get_ref(), &email::oauth_error_path(Some(&state_record), code))))
                .finish())
        }
    }
}
