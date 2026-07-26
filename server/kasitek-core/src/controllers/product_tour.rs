use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};

const TOUR_STEPS: i32 = 5;

#[derive(FromRow)]
struct TourRow {
    #[sqlx(rename = "primaryGoal")]
    primary_goal: Option<String>,
    status: Option<String>,
    #[sqlx(rename = "currentStep")]
    current_step: Option<i32>,
    #[sqlx(rename = "completedAt")]
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "skippedAt")]
    skipped_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize)]
struct TourStatus {
    #[serde(rename = "shouldShow")]
    should_show: bool,
    #[serde(rename = "currentStep")]
    current_step: i32,
    #[serde(rename = "primaryGoal")]
    primary_goal: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateTourRequest {
    pub action: String,
    #[serde(rename = "currentStep")]
    pub current_step: Option<i32>,
}

async fn tour_row(pool: &PgPool, org_id: &str, user_id: &str) -> Result<TourRow, AppError> {
    sqlx::query_as::<_, TourRow>(
        r#"SELECT p."primaryGoal", t.status, t."currentStep",
                  p."completedAt" AT TIME ZONE 'UTC' AS "completedAt",
                  p."skippedAt" AT TIME ZONE 'UTC' AS "skippedAt"
           FROM "Organization" o
           LEFT JOIN "OrganizationOnboardingProfile" p ON p."orgId" = o.id
           LEFT JOIN "UserProductTour" t ON t."orgId" = o.id AND t."userId" = $2
           WHERE o.id = $1"#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn get(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let row = tour_row(pool.get_ref(), &org_id, &user.id).await?;
    let onboarding_finished = row.completed_at.is_some() || row.skipped_at.is_some();
    let should_show = onboarding_finished
        && !matches!(row.status.as_deref(), Some("COMPLETED") | Some("DISMISSED"));

    Ok(HttpResponse::Ok().json(TourStatus {
        should_show,
        current_step: row.current_step.unwrap_or(0).clamp(0, TOUR_STEPS - 1),
        primary_goal: row.primary_goal,
    }))
}

pub async fn update(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpdateTourRequest>,
) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let org_id = resolve_active_org_id(&req, pool.get_ref(), &user.id).await?;
    let action = body.action.trim().to_lowercase();
    let (status, step) = match action.as_str() {
        "start" | "advance" => ("IN_PROGRESS", body.current_step.unwrap_or(0).clamp(0, TOUR_STEPS - 1)),
        "complete" => ("COMPLETED", TOUR_STEPS - 1),
        "dismiss" => ("DISMISSED", body.current_step.unwrap_or(0).clamp(0, TOUR_STEPS - 1)),
        "restart" => ("PENDING", 0),
        _ => return Err(AppError::BadRequest("Unknown tour action".to_string())),
    };

    let row = tour_row(pool.get_ref(), &org_id, &user.id).await?;
    if row.completed_at.is_none() && row.skipped_at.is_none() {
        return Err(AppError::Forbidden("Finish workspace onboarding before starting the tour".to_string()));
    }

    sqlx::query(
        r#"INSERT INTO "UserProductTour" (
              id, "userId", "orgId", status, "currentStep", "startedAt", "completedAt", "dismissedAt", "createdAt", "updatedAt"
            ) VALUES (
              $1, $2, $3, $4, $5,
              CASE WHEN $4 IN ('IN_PROGRESS', 'COMPLETED') THEN NOW() ELSE NULL END,
              CASE WHEN $4 = 'COMPLETED' THEN NOW() ELSE NULL END,
              CASE WHEN $4 = 'DISMISSED' THEN NOW() ELSE NULL END, NOW(), NOW()
            ) ON CONFLICT ("userId", "orgId") DO UPDATE SET
              status = EXCLUDED.status,
              "currentStep" = EXCLUDED."currentStep",
              "startedAt" = CASE WHEN EXCLUDED.status = 'IN_PROGRESS' THEN COALESCE("UserProductTour"."startedAt", NOW()) ELSE "UserProductTour"."startedAt" END,
              "completedAt" = CASE WHEN EXCLUDED.status = 'COMPLETED' THEN NOW() WHEN EXCLUDED.status = 'PENDING' THEN NULL ELSE "UserProductTour"."completedAt" END,
              "dismissedAt" = CASE WHEN EXCLUDED.status = 'DISMISSED' THEN NOW() WHEN EXCLUDED.status = 'PENDING' THEN NULL ELSE "UserProductTour"."dismissedAt" END,
              "updatedAt" = NOW()"#,
    )
    .bind(cuid2::create_id())
    .bind(&user.id)
    .bind(&org_id)
    .bind(status)
    .bind(step)
    .execute(pool.get_ref())
    .await?;

    get(pool, req).await
}
