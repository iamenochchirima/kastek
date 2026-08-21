use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::org_logos;
use crate::services::orgs;

// ─── Request types ────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateOrgRequest {
    pub name: String,
    pub slug: Option<String>,
    pub logo: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateOrgRequest {
    pub name: Option<String>,
    pub logo: Option<serde_json::Value>, // null = clear, string = set, missing = no change
}

#[derive(Deserialize)]
pub struct InviteRequest {
    pub email: String,
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    pub role: String,
}

#[derive(Deserialize)]
pub struct ActivateInvitationRequest {
    pub name: Option<String>,
    pub password: String,
}

// ─── Handlers ────────────────────────────────────────────

pub async fn list_orgs(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let orgs = orgs::list_orgs_for_user(pool.get_ref(), &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "orgs": orgs })))
}

pub async fn create_org(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    body: web::Json<CreateOrgRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "Organisation name is required".to_string(),
        ));
    }
    if name.len() > 80 {
        return Err(AppError::BadRequest(
            "Organisation name must be 80 characters or fewer".to_string(),
        ));
    }

    let base_slug = match body
        .slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => orgs::slugify(s),
        None => orgs::slugify(name),
    };
    if base_slug.is_empty() {
        return Err(AppError::BadRequest(
            "Could not generate a valid slug from the name".to_string(),
        ));
    }

    let slug = orgs::unique_slug(pool.get_ref(), &base_slug).await?;
    let _ = config; // available for future use

    let logo = body
        .logo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let org = orgs::create_org(pool.get_ref(), &user.id, name, &slug, logo).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "org": org })))
}

pub async fn get_org(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;

    let org = orgs::get_org(pool.get_ref(), &org_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Organisation not found".to_string()))?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "org": org })))
}

pub async fn update_org(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateOrgRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // logo: None = not in body (no change), Some(null) = clear, Some(string) = set
    let logo_update: Option<Option<&str>> = match body.logo.as_ref() {
        None => None,
        Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            Some(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            })
        }
        _ => None,
    };

    let org = orgs::update_org(pool.get_ref(), &org_id, name, logo_update).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "org": org })))
}

pub async fn upload_logo(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    let org = org_logos::upload(pool.get_ref(), config.get_ref(), &org_id, payload).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "org": org })))
}

pub async fn download_logo(
    config: web::Data<AppConfig>,
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();
    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;
    org_logos::download(config.get_ref(), &org_id).await
}

pub async fn delete_org(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_owner(pool.get_ref(), &org_id, &user.id).await?;

    // Prevent deleting org if it has other members
    let member_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "OrganizationMember" WHERE "orgId" = $1"#,
    )
    .bind(&org_id)
    .fetch_one(pool.get_ref())
    .await?;

    if member_count > 1 {
        return Err(AppError::BadRequest(
            "Remove all other members before deleting the organisation".to_string(),
        ));
    }

    orgs::delete_org(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Organisation deleted" })))
}

// ─── Members ─────────────────────────────────────────────

pub async fn list_members(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;

    let members = orgs::list_members(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "members": members })))
}

pub async fn update_member(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<UpdateMemberRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (org_id, target_user_id) = path.into_inner();

    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    // Only OWNER can assign OWNER role
    if body.role == "OWNER" {
        orgs::require_owner(pool.get_ref(), &org_id, &user.id).await?;
    }

    // Cannot change your own role
    if target_user_id == user.id {
        return Err(AppError::BadRequest(
            "You cannot change your own role".to_string(),
        ));
    }

    orgs::update_member_role(pool.get_ref(), &org_id, &target_user_id, &body.role).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Role updated" })))
}

pub async fn remove_member(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (org_id, target_user_id) = path.into_inner();

    // Member can remove themselves; admin can remove others
    if target_user_id != user.id {
        orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    } else {
        orgs::require_member(pool.get_ref(), &org_id, &user.id).await?;
    }

    orgs::remove_member(pool.get_ref(), &org_id, &target_user_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Member removed" })))
}

// ─── Invitations ─────────────────────────────────────────

pub async fn list_invitations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    let invitations = orgs::list_invitations(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "invitations": invitations })))
}

pub async fn invite_member(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<InviteRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = path.into_inner();

    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    let email = body.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(AppError::BadRequest("Invalid email address".to_string()));
    }

    let role = body.role.as_deref().unwrap_or("MEMBER");

    let org = orgs::get_org(pool.get_ref(), &org_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Organisation not found".to_string()))?;

    let inv = orgs::create_invitation(
        pool.get_ref(),
        config.get_ref(),
        &org_id,
        &org.name,
        &user.id,
        user.name.as_deref(),
        &email,
        role,
    )
    .await?;

    Ok(HttpResponse::Created().json(serde_json::json!({ "invitation": inv })))
}

pub async fn revoke_invitation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (org_id, inv_id) = path.into_inner();

    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;

    orgs::revoke_invitation(pool.get_ref(), &org_id, &inv_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Invitation revoked" })))
}

// ─── Public invitation endpoints ─────────────────────────

pub async fn get_invitation_preview(
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let token = path.into_inner();
    let inv = orgs::get_invitation_by_token(pool.get_ref(), &token)
        .await?
        .ok_or_else(|| AppError::NotFound("Invitation not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "invitation": inv })))
}

pub async fn accept_invitation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let token = path.into_inner();

    let org = orgs::accept_invitation(pool.get_ref(), &token, &user.id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "org": org })))
}

pub async fn activate_invitation(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    path: web::Path<String>,
    body: web::Json<ActivateInvitationRequest>,
) -> Result<HttpResponse, AppError> {
    let password = body.password.trim();
    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".to_string(),
        ));
    }

    let token = path.into_inner();
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (org, user_id) =
        orgs::activate_invitation_with_new_user(pool.get_ref(), &token, name, password).await?;
    let session_token = crate::services::auth::create_session(pool.get_ref(), &user_id).await?;

    Ok(HttpResponse::Created()
        .cookie(config.build_user_session_cookie(&session_token))
        .json(serde_json::json!({ "org": org })))
}
