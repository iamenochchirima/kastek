use actix_web::{web, HttpRequest, HttpResponse};
use bcrypt::{hash, DEFAULT_COST};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{error::AppError, middleware};

fn require_admin_secret(req: &HttpRequest) -> Result<(), AppError> {
    let config = middleware::app_config(req)?;
    let secret = match &config.admin_secret {
        Some(s) => s.clone(),
        None => return Ok(()), // no secret configured — admin API open (dev only)
    };
    let provided = req
        .headers()
        .get("x-admin-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != secret {
        Err(AppError::Forbidden)
    } else {
        Ok(())
    }
}

#[derive(Debug, FromRow, Serialize)]
struct WorkspaceSummaryRow {
    id: String,
    slug: String,
    display_name: String,
    status: String,
    client_count: i64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceBody {
    #[serde(rename = "workspaceName")]
    workspace_name: String,
    slug: String,
    #[serde(rename = "adminEmail")]
    admin_email: String,
    #[serde(rename = "adminPassword")]
    admin_password: String,
    #[serde(rename = "primaryColor")]
    primary_color: Option<String>,
    domain: Option<String>,
}

pub async fn list_workspaces(req: HttpRequest) -> Result<HttpResponse, AppError> {
    require_admin_secret(&req)?;
    let pool = middleware::db_pool(&req)?;

    let workspaces = sqlx::query_as::<_, WorkspaceSummaryRow>(
        r#"
        SELECT
            w.id,
            w.slug,
            w.display_name,
            w.status,
            COUNT(DISTINCT c.id) AS client_count,
            w.created_at AT TIME ZONE 'UTC' AS created_at
        FROM workspaces w
        LEFT JOIN tenant_clients c ON c.workspace_id = w.id
        GROUP BY w.id, w.slug, w.display_name, w.status, w.created_at
        ORDER BY w.created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "workspaces": workspaces })))
}

pub async fn get_workspace(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    require_admin_secret(&req)?;
    let pool = middleware::db_pool(&req)?;
    let id_or_slug = path.into_inner();

    let workspace = sqlx::query_as::<_, WorkspaceSummaryRow>(
        r#"
        SELECT
            w.id,
            w.slug,
            w.display_name,
            w.status,
            COUNT(DISTINCT c.id) AS client_count,
            w.created_at AT TIME ZONE 'UTC' AS created_at
        FROM workspaces w
        LEFT JOIN tenant_clients c ON c.workspace_id = w.id
        WHERE w.id = $1 OR w.slug = $1
        GROUP BY w.id, w.slug, w.display_name, w.status, w.created_at
        LIMIT 1
        "#,
    )
    .bind(&id_or_slug)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("workspace not found".to_string()))?;

    let domains: Vec<String> = sqlx::query_scalar::<_, String>(
        r#"SELECT domain FROM workspace_domains WHERE workspace_id = $1 ORDER BY is_primary DESC"#,
    )
    .bind(&workspace.id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspace": {
            "id": workspace.id,
            "slug": workspace.slug,
            "displayName": workspace.display_name,
            "status": workspace.status,
            "clientCount": workspace.client_count,
            "domains": domains,
            "createdAt": workspace.created_at,
        }
    })))
}

pub async fn create_workspace(
    req: HttpRequest,
    body: web::Json<CreateWorkspaceBody>,
) -> Result<HttpResponse, AppError> {
    require_admin_secret(&req)?;
    let pool = middleware::db_pool(&req)?;

    let workspace_name = body.workspace_name.trim();
    let slug = body.slug.trim().to_ascii_lowercase();
    let admin_email = body.admin_email.trim().to_ascii_lowercase();
    let admin_password = body.admin_password.trim();

    if workspace_name.is_empty() || slug.is_empty() || admin_email.is_empty() || admin_password.is_empty() {
        return Err(AppError::BadRequest(
            "workspaceName, slug, adminEmail, and adminPassword are required".to_string(),
        ));
    }

    let slug_exists = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM workspaces WHERE slug = $1 LIMIT 1"#,
    )
    .bind(&slug)
    .fetch_optional(pool)
    .await?;

    if slug_exists.is_some() {
        return Err(AppError::BadRequest(format!(
            "workspace slug already exists: {slug}"
        )));
    }

    let workspace_id = cuid2::create_id();
    let tenant_user_id = cuid2::create_id();
    let api_key_id = cuid2::create_id();
    let password_hash = hash(admin_password, DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("password hash failed: {e}")))?;
    let api_key_plain = format!("ktnt_{}", crypto_utils::generate_token(32));
    let api_key_prefix = api_key_plain.chars().take(12).collect::<String>();
    let api_key_hash = crypto_utils::sha256_hex(&api_key_plain);
    let scopes = serde_json::json!([
        "workspace:read",
        "workspace:write",
        "clients:read",
        "clients:write",
        "portal:bootstrap"
    ]);
    let now = Utc::now();

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"INSERT INTO workspaces (id, slug, display_name, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', NOW(), NOW())"#,
    )
    .bind(&workspace_id)
    .bind(&slug)
    .bind(workspace_name)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO workspace_branding (workspace_id, display_name, primary_color, custom_domain, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())"#,
    )
    .bind(&workspace_id)
    .bind(workspace_name)
    .bind(&body.primary_color)
    .bind(&body.domain)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO workspace_usage_limits (workspace_id, requests_per_month, tokens_per_month, conversations_per_month, created_at, updated_at)
           VALUES ($1, 0, 0, 0, NOW(), NOW())"#,
    )
    .bind(&workspace_id)
    .execute(&mut *tx)
    .await?;

    if let Some(domain) = &body.domain {
        let domain_trimmed = domain.trim();
        if !domain_trimmed.is_empty() {
            sqlx::query(
                r#"INSERT INTO workspace_domains (id, workspace_id, domain, is_primary, verified_at, dns_status, created_at, updated_at)
                   VALUES ($1, $2, $3, TRUE, NOW(), 'verified', NOW(), NOW())"#,
            )
            .bind(cuid2::create_id())
            .bind(&workspace_id)
            .bind(domain_trimmed)
            .execute(&mut *tx)
            .await?;
        }
    }

    sqlx::query(
        r#"INSERT INTO tenant_users (id, workspace_id, email, password_hash, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())"#,
    )
    .bind(&tenant_user_id)
    .bind(&workspace_id)
    .bind(&admin_email)
    .bind(&password_hash)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO tenant_user_roles (tenant_user_id, role, created_at) VALUES ($1, 'owner', NOW())"#,
    )
    .bind(&tenant_user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO workspace_api_keys (id, workspace_id, label, key_prefix, key_hash, scopes, created_at, updated_at)
           VALUES ($1, $2, 'initial-provisioning-key', $3, $4, $5, NOW(), NOW())"#,
    )
    .bind(&api_key_id)
    .bind(&workspace_id)
    .bind(&api_key_prefix)
    .bind(&api_key_hash)
    .bind(scopes)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspace": {
            "id": workspace_id,
            "slug": slug,
            "displayName": workspace_name,
            "status": "active",
            "createdAt": now,
        },
        "adminUser": {
            "id": tenant_user_id,
            "email": admin_email,
            "role": "owner",
        },
        "apiKey": {
            "id": api_key_id,
            "key": api_key_plain,
            "prefix": api_key_prefix,
        }
    })))
}
