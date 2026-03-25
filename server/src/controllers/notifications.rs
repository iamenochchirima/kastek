use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::{NotificationActionRequest, NotificationListQuery};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::notifications::{
    get_unread_notification_count, list_notification_inbox, mark_all_notifications_read,
    mark_notification_read,
};

pub async fn list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<NotificationListQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let limit = query.limit.unwrap_or(20);
    let inbox =
        list_notification_inbox(pool.get_ref(), &user.id, limit, query.cursor.clone()).await?;
    Ok(HttpResponse::Ok().json(inbox))
}

pub async fn unread(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let unread_count = get_unread_notification_count(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "unreadCount": unread_count })))
}

pub async fn action(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<NotificationActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;

    if body.action.as_deref() != Some("mark_all_read") {
        return Err(AppError::BadRequest("Unsupported action".to_string()));
    }

    let updated = mark_all_notifications_read(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": updated })))
}

pub async fn mark_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let updated = mark_notification_read(pool.get_ref(), &user.id, &path.into_inner()).await?;

    if updated == 0 {
        return Err(AppError::NotFound("Notification not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": updated })))
}
