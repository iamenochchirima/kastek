use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;

use crate::{
    controllers::{
        auth::{authenticate_tenant_user, build_session_cookie, clear_session_cookie},
        client_auth::{
            authenticate_client_user, build_client_session_cookie, clear_client_session_cookie,
        },
    },
    error::AppError,
    middleware,
};

#[derive(Debug, Deserialize)]
pub struct PortalLoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn login(
    req: HttpRequest,
    body: web::Json<PortalLoginRequest>,
) -> Result<HttpResponse, AppError> {
    let config = middleware::app_config(&req)?;
    let email = body.email.trim().to_ascii_lowercase();
    let password = body.password.trim();

    if email.is_empty() || password.is_empty() {
        return Err(AppError::BadRequest(
            "email and password are required".to_string(),
        ));
    }

    if let Some((user, session_token)) = authenticate_tenant_user(&req, &email, password).await? {
        return Ok(HttpResponse::Ok()
            .cookie(build_session_cookie(config, &session_token))
            .cookie(clear_client_session_cookie(config))
            .json(serde_json::json!({
                "audience": "tenant",
                "user": user,
            })));
    }

    if let Some((client_user, session_token)) =
        authenticate_client_user(&req, &email, password).await?
    {
        return Ok(HttpResponse::Ok()
            .cookie(build_client_session_cookie(config, &session_token))
            .cookie(clear_session_cookie(config))
            .json(serde_json::json!({
                "audience": "client",
                "clientUser": client_user,
            })));
    }

    Err(AppError::Unauthorized)
}

pub async fn get(req: HttpRequest) -> Result<HttpResponse, AppError> {
    if let Ok(session) = middleware::extract_tenant_user_session(&req).await {
        return Ok(HttpResponse::Ok().json(serde_json::json!({
            "audience": "tenant",
            "user": {
                "id": session.tenant_user_id,
                "workspaceId": session.workspace_id,
                "workspaceSlug": session.workspace_slug,
                "email": session.email,
                "name": session.name,
                "roles": session.roles,
            }
        })));
    }

    if let Ok(session) = middleware::extract_tenant_client_user_session(&req).await {
        return Ok(HttpResponse::Ok().json(serde_json::json!({
            "audience": "client",
            "clientUser": {
                "id": session.tenant_client_user_id,
                "workspaceId": session.workspace_id,
                "workspaceSlug": session.workspace_slug,
                "tenantClientId": session.tenant_client_id,
                "tenantClientName": session.tenant_client_name,
                "email": session.email,
                "name": session.name,
                "roles": session.roles,
            }
        })));
    }

    Err(AppError::Unauthorized)
}

pub async fn logout(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;

    if let Ok(session_token) = middleware::extract_tenant_session_token(&req) {
        let token_hash = crypto_utils::sha256_hex(&session_token);
        sqlx::query("DELETE FROM tenant_sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(pool)
            .await?;
    }

    if let Ok(session_token) = middleware::extract_client_session_token(&req) {
        let token_hash = crypto_utils::sha256_hex(&session_token);
        sqlx::query("DELETE FROM tenant_client_sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(pool)
            .await?;
    }

    Ok(HttpResponse::Ok()
        .cookie(clear_session_cookie(config))
        .cookie(clear_client_session_cookie(config))
        .json(serde_json::json!({
            "message": "logged out"
        })))
}
