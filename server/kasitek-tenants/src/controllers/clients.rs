use actix_web::{web, HttpRequest, HttpResponse};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{error::AppError, middleware};

#[derive(Debug, Deserialize)]
pub struct CreateTenantClientRequest {
    pub name: String,
    pub slug: Option<String>,
    pub external_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InviteTenantClientUserRequest {
    pub email: String,
    pub name: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, FromRow, Serialize)]
struct TenantClientRow {
    id: String,
    name: String,
    slug: String,
    status: String,
    external_ref: Option<String>,
    metadata: serde_json::Value,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, FromRow, Serialize)]
struct TenantClientUserRow {
    id: String,
    tenant_client_id: String,
    email: String,
    name: Option<String>,
    status: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

fn normalize_slug(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut last_dash = false;

    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn ensure_client_management_roles(roles: &[String]) -> Result<(), AppError> {
    if roles
        .iter()
        .any(|role| matches!(role.as_str(), "owner" | "admin" | "account_manager"))
    {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

pub async fn list_clients(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    let pool = middleware::db_pool(&req)?;

    let clients = sqlx::query_as::<_, TenantClientRow>(
        r#"
        SELECT
            id,
            name,
            slug,
            status,
            external_ref,
            metadata,
            created_at AT TIME ZONE 'UTC' AS created_at,
            updated_at AT TIME ZONE 'UTC' AS updated_at
        FROM tenant_clients
        WHERE workspace_id = $1
        ORDER BY updated_at DESC, created_at DESC
        "#,
    )
    .bind(&session.workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": session.workspace_id,
        "clients": clients
    })))
}

pub async fn create_client(
    req: HttpRequest,
    body: web::Json<CreateTenantClientRequest>,
) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    ensure_client_management_roles(&session.roles)?;
    let pool = middleware::db_pool(&req)?;
    let name = body.name.trim();
    let slug = body
        .slug
        .as_ref()
        .map(|value| normalize_slug(value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| normalize_slug(name));

    if name.is_empty() || slug.is_empty() {
        return Err(AppError::BadRequest(
            "name and slug are required".to_string(),
        ));
    }

    let id = cuid2::create_id();
    let result = sqlx::query(
        r#"
        INSERT INTO tenant_clients (
            id,
            workspace_id,
            name,
            slug,
            external_ref,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(&session.workspace_id)
    .bind(name)
    .bind(&slug)
    .bind(
        body.external_ref
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .execute(pool)
    .await;

    if result.is_err() {
        return Err(AppError::BadRequest(
            "client slug already exists for this workspace".to_string(),
        ));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "client": {
            "id": id,
            "workspaceId": session.workspace_id,
            "name": name,
            "slug": slug,
            "externalRef": body.external_ref,
            "status": "active",
        }
    })))
}

pub async fn list_client_users(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    ensure_client_management_roles(&session.roles)?;
    let pool = middleware::db_pool(&req)?;
    let tenant_client_id = path.into_inner();

    let users = sqlx::query_as::<_, TenantClientUserRow>(
        r#"
        SELECT
            id,
            tenant_client_id,
            email,
            name,
            status,
            created_at AT TIME ZONE 'UTC' AS created_at,
            updated_at AT TIME ZONE 'UTC' AS updated_at
        FROM tenant_client_users
        WHERE workspace_id = $1 AND tenant_client_id = $2
        ORDER BY updated_at DESC, created_at DESC
        "#,
    )
    .bind(&session.workspace_id)
    .bind(&tenant_client_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": session.workspace_id,
        "tenantClientId": tenant_client_id,
        "users": users
    })))
}

pub async fn invite_client_user(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<InviteTenantClientUserRequest>,
) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    ensure_client_management_roles(&session.roles)?;
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;
    let tenant_client_id = path.into_inner();
    let email = body.email.trim().to_ascii_lowercase();
    let role = body
        .role
        .as_deref()
        .unwrap_or("member")
        .trim()
        .to_ascii_lowercase();

    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".to_string()));
    }

    let tenant_client = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM tenant_clients
        WHERE workspace_id = $1 AND id = $2
        LIMIT 1
        "#,
    )
    .bind(&session.workspace_id)
    .bind(&tenant_client_id)
    .fetch_optional(pool)
    .await?;

    if tenant_client.is_none() {
        return Err(AppError::NotFound("tenant client not found".to_string()));
    }

    let existing_user = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM tenant_client_users
        WHERE tenant_client_id = $1 AND lower(email) = lower($2) AND status = 'active'
        LIMIT 1
        "#,
    )
    .bind(&tenant_client_id)
    .bind(&email)
    .fetch_optional(pool)
    .await?;

    if existing_user.is_some() {
        return Err(AppError::BadRequest(
            "client user is already active".to_string(),
        ));
    }

    let tenant_client_user_id = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO tenant_client_users (
            id,
            workspace_id,
            tenant_client_id,
            email,
            name,
            status,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'invited', NOW(), NOW())
        ON CONFLICT (tenant_client_id, email)
        DO UPDATE SET
            name = EXCLUDED.name,
            status = 'invited',
            updated_at = NOW()
        RETURNING id
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&session.workspace_id)
    .bind(&tenant_client_id)
    .bind(&email)
    .bind(
        body.name
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .fetch_one(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_client_user_roles (tenant_client_user_id, role, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (tenant_client_user_id, role) DO NOTHING
        "#,
    )
    .bind(&tenant_client_user_id)
    .bind(&role)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE tenant_client_invites
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE tenant_client_user_id = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
        "#,
    )
    .bind(&tenant_client_user_id)
    .execute(pool)
    .await?;

    let invite_id = cuid2::create_id();
    let invite_token = crypto_utils::generate_token(48);
    let invite_token_hash = crypto_utils::sha256_hex(&invite_token);
    let expires_at = Utc::now() + chrono::Duration::hours(i64::from(config.invite_ttl_hours));
    let activation_url = config.app_base_url.as_ref().map(|base_url| {
        format!(
            "{}/activate?token={}",
            base_url.trim_end_matches('/'),
            invite_token
        )
    });

    sqlx::query(
        r#"
        INSERT INTO tenant_client_invites (
            id,
            workspace_id,
            tenant_client_id,
            tenant_client_user_id,
            email,
            token_hash,
            invited_by_tenant_user_id,
            expires_at,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        "#,
    )
    .bind(&invite_id)
    .bind(&session.workspace_id)
    .bind(&tenant_client_id)
    .bind(&tenant_client_user_id)
    .bind(&email)
    .bind(&invite_token_hash)
    .bind(&session.tenant_user_id)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "invite": {
            "id": invite_id,
            "tenantClientId": tenant_client_id,
            "tenantClientUserId": tenant_client_user_id,
            "email": email,
            "role": role,
            "expiresAt": expires_at,
            "token": invite_token,
            "activationUrl": activation_url,
        }
    })))
}
