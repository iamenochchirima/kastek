use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::orgs;

#[derive(Serialize, FromRow)]
struct OnboardingProfileRow {
    #[sqlx(rename = "orgId")]
    #[serde(rename = "orgId")]
    org_id: String,
    #[sqlx(rename = "orgName")]
    #[serde(rename = "orgName")]
    org_name: String,
    website: Option<String>,
    #[sqlx(rename = "primaryGoal")]
    #[serde(rename = "primaryGoal")]
    primary_goal: Option<String>,
    #[sqlx(rename = "primaryGoals")]
    #[serde(rename = "primaryGoals")]
    primary_goals: Vec<String>,
    #[sqlx(rename = "teamRole")]
    #[serde(rename = "teamRole")]
    team_role: Option<String>,
    industry: Option<String>,
    #[sqlx(rename = "referralSource")]
    #[serde(rename = "referralSource")]
    referral_source: Option<String>,
    #[sqlx(rename = "completedAt")]
    #[serde(rename = "completedAt")]
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "skippedAt")]
    #[serde(rename = "skippedAt")]
    skipped_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
pub struct UpdateOnboardingRequest {
    #[serde(rename = "companyName")]
    pub company_name: Option<String>,
    pub website: Option<String>,
    #[serde(rename = "primaryGoal")]
    pub primary_goal: Option<String>,
    #[serde(rename = "primaryGoals")]
    pub primary_goals: Option<Vec<String>>,
    #[serde(rename = "teamRole")]
    pub team_role: Option<String>,
    pub industry: Option<String>,
    #[serde(rename = "referralSource")]
    pub referral_source: Option<String>,
    pub complete: Option<bool>,
    pub skip: Option<bool>,
}

fn clean(value: Option<String>, label: &str, max_len: usize) -> Result<Option<String>, AppError> {
    let value = value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
    if value.as_ref().is_some_and(|item| item.len() > max_len) {
        return Err(AppError::BadRequest(format!(
            "{label} must be {max_len} characters or fewer"
        )));
    }
    Ok(value)
}

fn clean_list(
    values: Option<Vec<String>>,
    label: &str,
    max_len: usize,
) -> Result<Option<Vec<String>>, AppError> {
    let Some(values) = values else {
        return Ok(None);
    };
    let mut cleaned = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if value.len() > max_len {
            return Err(AppError::BadRequest(format!(
                "{label} must be {max_len} characters or fewer"
            )));
        }
        if !cleaned.contains(&value) {
            cleaned.push(value);
        }
    }
    Ok(Some(cleaned))
}

async fn active_org_and_role(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: &str,
) -> Result<(String, String), AppError> {
    let org_id = resolve_active_org_id(req, pool, user_id).await?;
    let role = orgs::require_member(pool, &org_id, user_id).await?;
    Ok((org_id, role))
}

pub async fn get(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (org_id, role) = active_org_and_role(pool.get_ref(), &req, &user.id).await?;
    let profile = sqlx::query_as::<_, OnboardingProfileRow>(
        r#"SELECT o.id AS "orgId", o.name AS "orgName", p.website, p."primaryGoal", COALESCE(p."primaryGoals", ARRAY[]::TEXT[]) AS "primaryGoals", p."teamRole", p.industry,
                  p."referralSource", p."completedAt" AT TIME ZONE 'UTC' AS "completedAt",
                  p."skippedAt" AT TIME ZONE 'UTC' AS "skippedAt"
           FROM "Organization" o
           LEFT JOIN "OrganizationOnboardingProfile" p ON p."orgId" = o.id
           WHERE o.id = $1"#,
    )
    .bind(&org_id)
    .fetch_one(pool.get_ref())
    .await?;
    let can_manage = role == "OWNER" || role == "ADMIN";
    let needs_onboarding =
        can_manage && profile.completed_at.is_none() && profile.skipped_at.is_none();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "profile": profile,
        "canManage": can_manage,
        "needsOnboarding": needs_onboarding,
    })))
}

pub async fn update(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpdateOnboardingRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let (org_id, _) = active_org_and_role(pool.get_ref(), &req, &user.id).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user.id).await?;
    let input = body.into_inner();
    let company_name = clean(input.company_name, "Company name", 80)?;
    let website = clean(input.website, "Website", 500)?;
    let primary_goals = clean_list(input.primary_goals, "Primary goal", 80)?;
    let primary_goal = primary_goals
        .as_ref()
        .and_then(|goals| goals.first().cloned())
        .or(clean(input.primary_goal, "Primary goal", 80)?);
    let team_role = clean(input.team_role, "Team role", 80)?;
    let industry = clean(input.industry, "Industry", 80)?;
    let referral_source = clean(input.referral_source, "Referral source", 80)?;

    if input.complete == Some(true) && company_name.is_none() {
        return Err(AppError::BadRequest(
            "Company name is required to complete onboarding".to_string(),
        ));
    }

    if let Some(company_name) = company_name.as_deref() {
        orgs::update_org(pool.get_ref(), &org_id, Some(company_name), None).await?;
    }

    sqlx::query(
        r#"INSERT INTO "OrganizationOnboardingProfile" (
                id, "orgId", website, "primaryGoal", "primaryGoals", "teamRole", industry, "referralSource",
                "completedAt", "skippedAt", "createdAt", "updatedAt"
            ) VALUES ($1, $2, $3, $4, COALESCE($5, ARRAY[]::TEXT[]), $6, $7, $8,
                CASE WHEN $9 THEN NOW() ELSE NULL END,
                CASE WHEN $10 THEN NOW() ELSE NULL END, NOW(), NOW())
            ON CONFLICT ("orgId") DO UPDATE SET
                website = COALESCE(EXCLUDED.website, "OrganizationOnboardingProfile".website),
                "primaryGoal" = COALESCE(EXCLUDED."primaryGoal", "OrganizationOnboardingProfile"."primaryGoal"),
                "primaryGoals" = COALESCE($5, "OrganizationOnboardingProfile"."primaryGoals"),
                "teamRole" = COALESCE(EXCLUDED."teamRole", "OrganizationOnboardingProfile"."teamRole"),
                industry = COALESCE(EXCLUDED.industry, "OrganizationOnboardingProfile".industry),
                "referralSource" = COALESCE(EXCLUDED."referralSource", "OrganizationOnboardingProfile"."referralSource"),
                "completedAt" = CASE WHEN $9 THEN NOW() ELSE "OrganizationOnboardingProfile"."completedAt" END,
                "skippedAt" = CASE WHEN $10 THEN NOW() ELSE "OrganizationOnboardingProfile"."skippedAt" END,
                "updatedAt" = NOW()"#,
    )
    .bind(cuid2::create_id())
    .bind(&org_id)
    .bind(website)
    .bind(primary_goal)
    .bind(primary_goals)
    .bind(team_role)
    .bind(industry)
    .bind(referral_source)
    .bind(input.complete == Some(true))
    .bind(input.skip == Some(true))
    .execute(pool.get_ref())
    .await?;

    get(pool, req).await
}
