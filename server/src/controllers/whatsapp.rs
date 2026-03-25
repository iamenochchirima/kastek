use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::{
    WhatsappCampaignActionRequest, WhatsappCampaignCreateRequest, WhatsappConnectionCreateRequest,
    WhatsappConnectionTokenRequest, WhatsappContactListQuery, WhatsappContactUpdateRequest,
    WhatsappEmbeddedSignupRequest, WhatsappReactionRequest, WhatsappSendMessageRequest,
    WhatsappStartConversationRequest, WhatsappTemplateCreateRequest, WhatsappTemplateListQuery,
};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::whatsapp;

pub async fn list_connections(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let connections = whatsapp::list_connections(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "connections": connections })))
}

pub async fn create_connection(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappConnectionCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::connect_manual_connection(
        pool.get_ref(),
        &user.id,
        body.waba_id.as_deref().unwrap_or(""),
        body.phone_number_id.as_deref().unwrap_or(""),
        body.access_token.as_deref().unwrap_or(""),
        body.phone_display_number.as_deref(),
    )
    .await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn complete_onboarding(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappEmbeddedSignupRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let code = body
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing embedded signup code".to_string()))?;
    let result = whatsapp::complete_embedded_signup(
        pool.get_ref(),
        &user.id,
        code,
        body.waba_id.as_deref(),
        body.phone_number_id.as_deref(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn update_connection_token(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappConnectionTokenRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::update_connection_access_token(
        pool.get_ref(),
        &user.id,
        &path,
        body.access_token.as_deref().unwrap_or(""),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn refresh_connection(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::refresh_connection(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn connection_health(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::connection_health(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn sync_connection_templates(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::sync_connection_templates(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn create_template(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappTemplateCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::create_template(
        pool.get_ref(),
        &user.id,
        body.connection_id.as_deref().unwrap_or(""),
        body.template_name.as_deref().unwrap_or(""),
        body.language.as_deref().unwrap_or(""),
        body.category.as_deref().unwrap_or("MARKETING"),
        body.header.as_deref(),
        body.body.as_deref().unwrap_or(""),
        body.footer.as_deref(),
    )
    .await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn list_templates(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<WhatsappTemplateListQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::list_templates(pool.get_ref(), &user.id, query.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_contacts(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<WhatsappContactListQuery>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::list_contacts(pool.get_ref(), &user.id, query.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn update_contact(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappContactUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::update_contact(pool.get_ref(), &user.id, &path, body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn import_contacts(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::import_contacts(pool.get_ref(), &user.id, payload).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_campaigns(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::list_campaigns(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn create_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappCampaignCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::create_campaign(pool.get_ref(), &user.id, &body).await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn get_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::get_campaign(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn launch_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCampaignActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp::launch_campaign(pool.get_ref(), &user.id, &path, body.scheduled_at.clone()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn update_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappCampaignActionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let action = body
        .action
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Action is required".to_string()))?;
    let result = match action {
        "pause" => whatsapp::pause_campaign(pool.get_ref(), &user.id, &path).await?,
        "resume" => {
            whatsapp::resume_campaign(pool.get_ref(), &user.id, &path, body.scheduled_at.clone()).await?
        }
        "cancel" => whatsapp::cancel_campaign(pool.get_ref(), &user.id, &path).await?,
        "retry_failed" => whatsapp::retry_failed_campaign(pool.get_ref(), &user.id, &path).await?,
        _ => return Err(AppError::BadRequest("Unsupported action".to_string())),
    };
    Ok(HttpResponse::Ok().json(result))
}

pub async fn verify_webhook(
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let mode = query.get("hub.mode").cloned().unwrap_or_default();
    let token = query.get("hub.verify_token").cloned().unwrap_or_default();
    let challenge = query.get("hub.challenge").cloned().unwrap_or_default();

    if mode != "subscribe" || challenge.is_empty() {
        return Err(AppError::BadRequest("Invalid verification request".to_string()));
    }
    let expected = std::env::var("WHATSAPP_WEBHOOK_VERIFY_TOKEN").unwrap_or_default();
    if token != expected {
        return Err(AppError::Forbidden("Invalid verify token".to_string()));
    }

    Ok(HttpResponse::Ok().body(challenge))
}

pub async fn receive_webhook(
    pool: web::Data<PgPool>,
    body: web::Json<serde_json::Value>,
) -> Result<HttpResponse, AppError> {
    whatsapp::process_webhook_payload(pool.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "queued": false
    })))
}

pub async fn list_inbox_conversations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::list_inbox_conversations(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn start_inbox_conversation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<WhatsappStartConversationRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::start_inbox_conversation(pool.get_ref(), &user.id, &body).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn inbox_unread_count(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::inbox_unread_count(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn list_conversation_messages(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::list_conversation_messages(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn send_conversation_message(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<WhatsappSendMessageRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result =
        whatsapp::send_conversation_message(pool.get_ref(), &user.id, &path, body.into_inner()).await?;
    Ok(HttpResponse::Accepted().json(result))
}

pub async fn mark_conversation_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = whatsapp::mark_conversation_read(pool.get_ref(), &user.id, &path).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn send_message_reaction(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<WhatsappReactionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (conversation_id, message_id) = path.into_inner();
    let result = whatsapp::send_message_reaction(
        pool.get_ref(),
        &user.id,
        &conversation_id,
        &message_id,
        body.into_inner(),
    )
    .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn delete_conversation_message(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (conversation_id, message_id) = path.into_inner();
    let result =
        whatsapp::delete_conversation_message(pool.get_ref(), &user.id, &conversation_id, &message_id)
            .await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn download_message_media(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    whatsapp::download_message_media(pool.get_ref(), &user.id, &path).await
}
