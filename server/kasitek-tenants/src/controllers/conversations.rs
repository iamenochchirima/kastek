use actix_web::{web, HttpRequest, HttpResponse};

use crate::{error::AppError, middleware};

pub async fn list_conversations(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "conversations": []
    })))
}

pub async fn get_conversation(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;
    let id = path.into_inner();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "conversation": {
            "id": id,
            "status": "not_implemented",
        }
    })))
}

pub async fn list_messages(
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let workspace = middleware::extract_workspace_context(&req).await?;
    let conversation_id = path.into_inner();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "workspaceId": workspace.workspace_id,
        "conversationId": conversation_id,
        "messages": []
    })))
}
