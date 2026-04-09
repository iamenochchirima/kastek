use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::{
    DeletePushSubscriptionRequest, NotificationActionRequest, NotificationListQuery,
    PushSubscriptionStatusResponse, SavePushSubscriptionRequest, SendPushTestRequest,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::notifications::{
    get_unread_notification_count, list_notification_inbox, mark_all_notifications_read,
    mark_notification_read,
};
use crate::services::push::{
    delete_push_subscription, get_push_subscription_status, save_push_subscription,
    send_push_notification_to_user, PushNotificationPayload,
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

pub async fn push_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (configured, subscription_count) =
        get_push_subscription_status(pool.get_ref(), config.get_ref(), &user.id).await?;

    Ok(HttpResponse::Ok().json(PushSubscriptionStatusResponse {
        configured,
        public_key: config.web_push_vapid_public_key.clone(),
        subscribed: subscription_count > 0,
        subscription_count,
    }))
}

pub async fn push_subscribe(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SavePushSubscriptionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let subscription = body
        .subscription
        .clone()
        .ok_or_else(|| AppError::BadRequest("Missing subscription payload".to_string()))?;
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|value| value.to_str().ok());

    save_push_subscription(pool.get_ref(), &user.id, subscription, user_agent).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "success": true })))
}

pub async fn push_unsubscribe(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<DeletePushSubscriptionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let endpoint = body
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing subscription endpoint".to_string()))?;

    let deleted = delete_push_subscription(pool.get_ref(), &user.id, endpoint).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": deleted })))
}

pub async fn push_test(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<SendPushTestRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let title = body
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("KasiTek notification test")
        .to_string();
    let push_body = body
        .body
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Push notifications are now connected for this device.")
        .to_string();
    let url = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/workspace/notifications")
        .to_string();

    let delivered = send_push_notification_to_user(
        pool.get_ref(),
        config.get_ref(),
        &user.id,
        PushNotificationPayload {
            title,
            body: push_body,
            url,
            tag: Some("push-test".to_string()),
        },
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "delivered": delivered })))
}
