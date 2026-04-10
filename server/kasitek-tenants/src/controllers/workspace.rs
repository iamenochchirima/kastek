use actix_web::{HttpRequest, HttpResponse};
use serde::Serialize;
use sqlx::FromRow;

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

pub async fn get_workspace(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let access = middleware::extract_access_context(&req).await?;
    if access.tenant_user_id.is_some() {
        middleware::require_tenant_roles(
            &access.tenant_user_roles,
            &["owner", "admin", "account_manager", "viewer", "support"],
        )?;
    }
    let pool = middleware::db_pool(&req)?;

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
            "domains": domains.iter().map(|domain| serde_json::json!({
                "domain": domain.domain,
                "isPrimary": domain.is_primary,
            })).collect::<Vec<_>>(),
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
