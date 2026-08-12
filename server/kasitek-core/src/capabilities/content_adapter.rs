use sqlx::PgPool;

use crate::{
    db::models::{SocialPost, SocialPostUpsertRequest},
    error::AppError,
    identity::request_context::RequestContext,
    services::social,
};

/// Typed content capability boundary. Transport layers pass a normalized
/// context here; organization ownership is never accepted from the payload.
pub async fn list_posts(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<SocialPost>, AppError> {
    social::list_social_posts(pool, &context.organization_id).await
}

pub async fn get_post(
    pool: &PgPool,
    context: &RequestContext,
    post_id: &str,
) -> Result<Option<SocialPost>, AppError> {
    social::get_social_post(pool, &context.organization_id, post_id).await
}

pub async fn create_draft(
    pool: &PgPool,
    context: &RequestContext,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    let actor_id = context
        .user_id
        .as_deref()
        .or(context.principal.subject_user_id.as_deref())
        .unwrap_or(&context.principal.id);
    social::create_social_post(pool, actor_id, &context.organization_id, request).await
}
