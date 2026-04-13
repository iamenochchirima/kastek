use actix_web::{HttpRequest, HttpResponse};
use chrono::Utc;
use serde::Serialize;
use sqlx::FromRow;
use std::collections::BTreeSet;
use tokio::net::lookup_host;

use crate::{error::AppError, middleware};

#[derive(Debug, FromRow, Serialize)]
struct WorkspaceRow {
    id: String,
    slug: String,
    display_name: String,
    status: String,
}

#[derive(Debug, FromRow, Serialize)]
struct BrandingRow {
    #[sqlx(rename = "workspace_id")]
    workspace_id: String,
    display_name: String,
    primary_color: Option<String>,
    secondary_color: Option<String>,
    logo_url: Option<String>,
    widget_config: serde_json::Value,
}

#[derive(Debug, FromRow)]
struct DomainRow {
    domain: String,
    is_primary: bool,
}

#[derive(Debug, FromRow, Serialize)]
struct WorkspaceDomainRow {
    id: String,
    domain: String,
    is_primary: bool,
    dns_status: String,
    verified_at: Option<chrono::DateTime<Utc>>,
    created_at: chrono::DateTime<Utc>,
}

fn hosted_workspace_domain(workspace_slug: &str, platform_base_domain: Option<&str>) -> Option<String> {
    platform_base_domain.and_then(|base| {
        let normalized_base = base.trim().trim_matches('.').to_ascii_lowercase();
        if normalized_base.is_empty() {
            None
        } else {
            Some(format!("{workspace_slug}.{normalized_base}"))
        }
    })
}

fn normalize_domain(value: &str) -> Result<String, AppError> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .split('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    if normalized.is_empty() {
        return Err(AppError::BadRequest("domain is required".to_string()));
    }

    if normalized.contains(' ') || !normalized.contains('.') {
        return Err(AppError::BadRequest("domain must be a valid hostname".to_string()));
    }

    Ok(normalized)
}

fn verification_message(status: &str, domain: &str, expected_target_host: Option<&str>) -> String {
    match (status, expected_target_host) {
        ("verified", Some(target)) => format!("{domain} resolves to the shared portal target {target}."),
        ("misconfigured", Some(target)) => format!(
            "{domain} resolves publicly, but it does not currently point to the shared portal target {target}."
        ),
        ("pending", Some(target)) => {
            format!("{domain} does not resolve to the shared portal target {target} yet.")
        }
        ("verified", None) => format!("{domain} resolves publicly."),
        ("misconfigured", None) => format!(
            "{domain} resolves publicly, but verification could not confirm the expected platform target."
        ),
        _ => format!("{domain} is not reachable in DNS yet."),
    }
}

async fn resolve_ips(host: &str) -> BTreeSet<String> {
    lookup_host((host, 443))
        .await
        .map(|records| records.map(|addr| addr.ip().to_string()).collect())
        .unwrap_or_default()
}

async fn sync_workspace_custom_domain(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: &str,
) -> Result<(), AppError> {
    let primary_domain = sqlx::query_scalar::<_, String>(
        r#"
        SELECT domain
        FROM workspace_domains
        WHERE workspace_id = $1 AND is_primary = TRUE
        ORDER BY created_at ASC
        LIMIT 1
        "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE workspace_branding
        SET custom_domain = $1, updated_at = NOW()
        WHERE workspace_id = $2
        "#,
    )
    .bind(primary_domain)
    .bind(workspace_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn require_workspace_admin(access: &types::TenantAccessContext) -> Result<(), AppError> {
    middleware::require_tenant_roles(&access.tenant_user_roles, &["owner", "admin"])
}

pub async fn get_workspace(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    if access.tenant_user_id.is_some() {
        middleware::require_tenant_roles(
            &access.tenant_user_roles,
            &["owner", "admin", "account_manager", "viewer", "support"],
        )?;
    }
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;

    let workspace = sqlx::query_as::<_, WorkspaceRow>(
        r#"
        SELECT id, slug, display_name, status
        FROM workspaces
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(&access.workspace_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("workspace not found".to_string()))?;

    let domains = sqlx::query_as::<_, DomainRow>(
        r#"
        SELECT domain, is_primary
        FROM workspace_domains
        WHERE workspace_id = $1
        ORDER BY is_primary DESC, domain ASC
        "#,
    )
    .bind(&access.workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspace": {
            "id": workspace.id,
            "slug": workspace.slug,
            "displayName": workspace.display_name,
            "status": workspace.status,
            "hostedDomain": hosted_workspace_domain(&workspace.slug, config.platform_base_domain.as_deref()),
            "domains": domains.iter().map(|domain| serde_json::json!({
                "domain": domain.domain,
                "isPrimary": domain.is_primary,
            })).collect::<Vec<_>>(),
            "domainVerification": {
                "expectedTargetHost": config.portal_host_target,
                "hostedDomainBase": config.platform_base_domain,
            },
            "scopes": access.scopes,
            "tenantUserId": access.tenant_user_id,
            "tenantUserRoles": access.tenant_user_roles,
        }
    })))
}

pub async fn get_branding(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    if access.tenant_user_id.is_some() {
        middleware::require_tenant_roles(
            &access.tenant_user_roles,
            &["owner", "admin", "account_manager", "viewer", "support"],
        )?;
    }
    let pool = middleware::db_pool(&req)?;

    let branding = sqlx::query_as::<_, BrandingRow>(
        r#"
        SELECT workspace_id, display_name, primary_color, secondary_color, logo_url, widget_config
        FROM workspace_branding
        WHERE workspace_id = $1
        LIMIT 1
        "#,
    )
    .bind(&access.workspace_id)
    .fetch_optional(pool)
    .await?;

    let custom_domain = sqlx::query_scalar::<_, String>(
        r#"
        SELECT domain
        FROM workspace_domains
        WHERE workspace_id = $1
        ORDER BY is_primary DESC, domain ASC
        LIMIT 1
        "#,
    )
    .bind(&access.workspace_id)
    .fetch_optional(pool)
    .await?;

    let response = if let Some(branding) = branding {
        serde_json::json!({
            "workspaceId": branding.workspace_id,
            "displayName": branding.display_name,
            "primaryColor": branding.primary_color,
            "secondaryColor": branding.secondary_color,
            "logoUrl": branding.logo_url,
            "customDomain": custom_domain,
            "widgetConfig": branding.widget_config,
        })
    } else {
        serde_json::json!({
            "workspaceId": access.workspace_id,
            "displayName": access.workspace_slug,
            "primaryColor": null,
            "secondaryColor": null,
            "logoUrl": null,
            "customDomain": custom_domain,
            "widgetConfig": {},
        })
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "branding": response
    })))
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateWorkspaceDomainBody {
    domain: String,
    #[serde(rename = "makePrimary")]
    make_primary: Option<bool>,
}

pub async fn list_workspace_domains(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    require_workspace_admin(&access)?;
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;

    let domains = sqlx::query_as::<_, WorkspaceDomainRow>(
        r#"
        SELECT
            id,
            domain,
            is_primary,
            dns_status,
            verified_at,
            created_at
        FROM workspace_domains
        WHERE workspace_id = $1
        ORDER BY is_primary DESC, created_at ASC
        "#,
    )
    .bind(&access.workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "hostedDomain": hosted_workspace_domain(&access.workspace_slug, config.platform_base_domain.as_deref()),
        "domains": domains.into_iter().map(|row| serde_json::json!({
            "id": row.id,
            "domain": row.domain.clone(),
            "isPrimary": row.is_primary,
            "dnsStatus": row.dns_status,
            "verifiedAt": row.verified_at,
            "createdAt": row.created_at,
            "verificationMessage": verification_message(&row.dns_status, &row.domain, config.portal_host_target.as_deref()),
        })).collect::<Vec<_>>(),
        "verification": {
            "expectedTargetHost": config.portal_host_target,
            "hostedDomainBase": config.platform_base_domain,
        }
    })))
}

pub async fn add_workspace_domain(
    req: HttpRequest,
    body: actix_web::web::Json<CreateWorkspaceDomainBody>,
) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    require_workspace_admin(&access)?;
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;
    let domain = normalize_domain(&body.domain)?;
    let make_primary = body.make_primary.unwrap_or(false);

    let existing = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM workspace_domains WHERE lower(domain) = lower($1) LIMIT 1"#,
    )
    .bind(&domain)
    .fetch_optional(pool)
    .await?;

    if existing.is_some() {
        return Err(AppError::BadRequest("domain already exists".to_string()));
    }

    let domain_id = cuid2::create_id();
    let mut tx = pool.begin().await?;
    let existing_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM workspace_domains WHERE workspace_id = $1"#,
    )
    .bind(&access.workspace_id)
    .fetch_one(&mut *tx)
    .await?;

    let should_be_primary = make_primary || existing_count == 0;
    if should_be_primary {
        sqlx::query(
            r#"UPDATE workspace_domains SET is_primary = FALSE, updated_at = NOW() WHERE workspace_id = $1"#,
        )
        .bind(&access.workspace_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO workspace_domains (id, workspace_id, domain, is_primary, dns_status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
        "#,
    )
    .bind(&domain_id)
    .bind(&access.workspace_id)
    .bind(&domain)
    .bind(should_be_primary)
    .execute(&mut *tx)
    .await?;

    sync_workspace_custom_domain(&mut tx, &access.workspace_id).await?;
    tx.commit().await?;

    Ok(HttpResponse::Created().json(serde_json::json!({
        "domain": {
            "id": domain_id,
            "domain": domain.clone(),
            "isPrimary": should_be_primary,
            "dnsStatus": "pending",
            "verifiedAt": serde_json::Value::Null,
            "verificationMessage": verification_message("pending", &domain, config.portal_host_target.as_deref()),
        }
    })))
}

pub async fn verify_workspace_domain(
    req: HttpRequest,
    path: actix_web::web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    require_workspace_admin(&access)?;
    let pool = middleware::db_pool(&req)?;
    let config = middleware::app_config(&req)?;
    let domain_id = path.into_inner();

    let record = sqlx::query_as::<_, WorkspaceDomainRow>(
        r#"
        SELECT
            id,
            domain,
            is_primary,
            dns_status,
            verified_at,
            created_at
        FROM workspace_domains
        WHERE workspace_id = $1 AND id = $2
        LIMIT 1
        "#,
    )
    .bind(&access.workspace_id)
    .bind(&domain_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("domain not found".to_string()))?;

    let domain_ips = resolve_ips(&record.domain).await;
    let dns_status = if domain_ips.is_empty() {
        "pending"
    } else if let Some(expected_target_host) = config.portal_host_target.as_deref() {
        let target_ips = resolve_ips(expected_target_host).await;
        if !target_ips.is_empty() && domain_ips.iter().any(|ip| target_ips.contains(ip)) {
            "verified"
        } else {
            "misconfigured"
        }
    } else {
        "verified"
    };

    sqlx::query(
        r#"
        UPDATE workspace_domains
        SET dns_status = $1,
            verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE NULL END,
            updated_at = NOW()
        WHERE id = $2 AND workspace_id = $3
        "#,
    )
    .bind(dns_status)
    .bind(&domain_id)
    .bind(&access.workspace_id)
    .execute(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "domain": {
            "id": record.id,
            "domain": record.domain,
            "isPrimary": record.is_primary,
            "dnsStatus": dns_status,
            "verifiedAt": if dns_status == "verified" { serde_json::json!(Utc::now()) } else { serde_json::Value::Null },
            "verificationMessage": verification_message(dns_status, &record.domain, config.portal_host_target.as_deref()),
        }
    })))
}

pub async fn set_workspace_primary_domain(
    req: HttpRequest,
    path: actix_web::web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    require_workspace_admin(&access)?;
    let pool = middleware::db_pool(&req)?;
    let domain_id = path.into_inner();

    let mut tx = pool.begin().await?;
    let exists = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM workspace_domains WHERE workspace_id = $1 AND id = $2 LIMIT 1"#,
    )
    .bind(&access.workspace_id)
    .bind(&domain_id)
    .fetch_optional(&mut *tx)
    .await?;

    if exists.is_none() {
        return Err(AppError::NotFound("domain not found".to_string()));
    }

    sqlx::query(
        r#"UPDATE workspace_domains SET is_primary = FALSE, updated_at = NOW() WHERE workspace_id = $1"#,
    )
    .bind(&access.workspace_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"UPDATE workspace_domains SET is_primary = TRUE, updated_at = NOW() WHERE workspace_id = $1 AND id = $2"#,
    )
    .bind(&access.workspace_id)
    .bind(&domain_id)
    .execute(&mut *tx)
    .await?;

    sync_workspace_custom_domain(&mut tx, &access.workspace_id).await?;
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": true })))
}

pub async fn remove_workspace_domain(
    req: HttpRequest,
    path: actix_web::web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    require_workspace_admin(&access)?;
    let pool = middleware::db_pool(&req)?;
    let domain_id = path.into_inner();

    let mut tx = pool.begin().await?;
    let domain = sqlx::query_as::<_, WorkspaceDomainRow>(
        r#"
        SELECT
            id,
            domain,
            is_primary,
            dns_status,
            verified_at,
            created_at
        FROM workspace_domains
        WHERE workspace_id = $1 AND id = $2
        LIMIT 1
        "#,
    )
    .bind(&access.workspace_id)
    .bind(&domain_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("domain not found".to_string()))?;

    sqlx::query(r#"DELETE FROM workspace_domains WHERE id = $1 AND workspace_id = $2"#)
        .bind(&domain_id)
        .bind(&access.workspace_id)
        .execute(&mut *tx)
        .await?;

    if domain.is_primary {
        let next_primary = sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM workspace_domains WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1"#,
        )
        .bind(&access.workspace_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(next_primary) = next_primary {
            sqlx::query(
                r#"UPDATE workspace_domains SET is_primary = TRUE, updated_at = NOW() WHERE id = $1 AND workspace_id = $2"#,
            )
            .bind(&next_primary)
            .bind(&access.workspace_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    sync_workspace_custom_domain(&mut tx, &access.workspace_id).await?;
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

pub async fn get_public_tenant_context(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::resolve_workspace_from_request(&req).await?;
    let pool = middleware::db_pool(&req)?;

    let branding = sqlx::query_as::<_, BrandingRow>(
        r#"
        SELECT workspace_id, display_name, primary_color, secondary_color, logo_url, widget_config
        FROM workspace_branding
        WHERE workspace_id = $1
        LIMIT 1
        "#,
    )
    .bind(&workspace.workspace_id)
    .fetch_optional(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspace": {
            "id": workspace.workspace_id,
            "slug": workspace.workspace_slug,
            "displayName": workspace.display_name,
        },
        "branding": branding.map(|row| serde_json::json!({
            "displayName": row.display_name,
            "primaryColor": row.primary_color,
            "secondaryColor": row.secondary_color,
            "logoUrl": row.logo_url,
            "widgetConfig": row.widget_config,
        }))
    })))
}
