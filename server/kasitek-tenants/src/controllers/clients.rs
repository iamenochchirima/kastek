use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{config::AppConfig, controllers::client_auth, error::AppError, middleware};

#[derive(Debug, Deserialize)]
pub struct CreateTenantClientRequest {
    pub name: String,
    pub slug: Option<String>,
    pub external_ref: Option<String>,
    #[serde(rename = "adminEmail")]
    pub admin_email: String,
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
    user_count: i64,
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
    middleware::require_tenant_roles(roles, &["owner", "admin", "account_manager"])
}

async fn provision_client_user_invite(
    pool: &sqlx::PgPool,
    config: &AppConfig,
    workspace_id: &str,
    workspace_slug: &str,
    tenant_client_id: &str,
    email: &str,
    name: Option<&str>,
    role: &str,
    invited_by_tenant_user_id: Option<&str>,
) -> Result<(String, client_auth::IssuedClientInvite), AppError> {
    middleware::require_active_tenant_client(pool, workspace_id, tenant_client_id).await?;

    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".to_string()));
    }

    let existing_user = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM tenant_client_users
        WHERE tenant_client_id = $1 AND lower(email) = lower($2) AND status = 'active'
        LIMIT 1
        "#,
    )
    .bind(tenant_client_id)
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
    .bind(workspace_id)
    .bind(tenant_client_id)
    .bind(&email)
    .bind(name.map(|value| value.trim()).filter(|value| !value.is_empty()))
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
    .bind(role)
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

    let invite = client_auth::issue_client_invite(
        pool,
        config,
        workspace_id,
        workspace_slug,
        tenant_client_id,
        &tenant_client_user_id,
        &email,
        invited_by_tenant_user_id,
    )
    .await?;

    Ok((tenant_client_user_id, invite))
}

pub async fn list_clients(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    let pool = middleware::db_pool(&req)?;

    let clients = sqlx::query_as::<_, TenantClientRow>(
        r#"
        SELECT
            c.id,
            c.name,
            c.slug,
            c.status,
            COUNT(DISTINCT u.id)::bigint AS user_count,
            c.external_ref,
            c.metadata,
            c.created_at,
            c.updated_at
        FROM tenant_clients c
        LEFT JOIN tenant_client_users u
          ON u.workspace_id = c.workspace_id
         AND u.tenant_client_id = c.id
        WHERE c.workspace_id = $1
        GROUP BY c.id, c.name, c.slug, c.status, c.external_ref, c.metadata, c.created_at, c.updated_at
        ORDER BY c.updated_at DESC, c.created_at DESC
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
    let config = middleware::app_config(&req)?;
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

    let admin_email = body.admin_email.trim().to_ascii_lowercase();
    if admin_email.is_empty() || !admin_email.contains('@') || admin_email.contains(' ') {
        return Err(AppError::BadRequest(
            "adminEmail must be a valid email address".to_string(),
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

    let (_, admin_invite) = provision_client_user_invite(
        pool,
        config,
        &session.workspace_id,
        &session.workspace_slug,
        &id,
        &admin_email,
        None,
        "owner",
        Some(&session.tenant_user_id),
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "client": {
            "id": id,
            "workspaceId": session.workspace_id,
            "name": name,
            "slug": slug,
            "externalRef": body.external_ref,
            "status": "active",
        },
        "adminInvite": {
            "email": admin_email,
            "emailSent": admin_invite.email_sent,
            "activationUrl": admin_invite.activation_url,
            "portalUrl": admin_invite.portal_url,
            "expiresAt": admin_invite.expires_at,
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
            created_at,
            updated_at
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

    let (tenant_client_user_id, invite) = provision_client_user_invite(
        pool,
        config,
        &session.workspace_id,
        &session.workspace_slug,
        &tenant_client_id,
        &email,
        body.name.as_deref(),
        &role,
        Some(&session.tenant_user_id),
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "invite": {
            "id": invite.invite_id,
            "tenantClientId": tenant_client_id,
            "tenantClientUserId": tenant_client_user_id,
            "email": email,
            "role": role,
            "expiresAt": invite.expires_at,
            "activationUrl": invite.activation_url,
            "portalUrl": invite.portal_url,
            "emailSent": invite.email_sent,
        }
    })))
}
