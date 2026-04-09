use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::db::models::{SocialCaptionRequest, SocialIdeasRequest};
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::ai;

pub async fn social_ideas(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialIdeasRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = ai::generate_social_ideas(pool.get_ref(), &user.id, body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}

pub async fn social_caption(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SocialCaptionRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let result = ai::generate_social_caption(pool.get_ref(), &user.id, body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(result))
}
