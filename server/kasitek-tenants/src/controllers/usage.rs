use actix_web::{HttpRequest, HttpResponse};

use crate::{error::AppError, middleware};

pub async fn get_usage(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "usage": {
            "requestsThisMonth": 0,
            "tokensThisMonth": 0,
            "limits": {
                "requestsPerMonth": 0,
                "tokensPerMonth": 0,
            }
        }
    })))
}
