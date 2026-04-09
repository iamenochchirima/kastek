use actix_web::{web, HttpRequest, HttpResponse};

use crate::{error::AppError, middleware};

pub async fn list_agents(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "agents": []
    })))
}

pub async fn get_agent(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;
    let id = path.into_inner();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "agent": {
            "id": id,
            "status": "not_implemented",
        }
    })))
}
