use actix_web::{HttpRequest, HttpResponse};

use crate::{error::AppError, middleware};

pub async fn get_workspace(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspace": {
            "id": workspace.workspace_id,
            "slug": workspace.workspace_slug,
            "scopes": workspace.scopes,
        }
    })))
}

pub async fn get_branding(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "branding": {
            "workspaceId": workspace.workspace_id,
            "displayName": "Tenant Workspace",
            "primaryColor": "#111827",
            "logoUrl": null,
            "customDomain": null,
        }
    })))
}
