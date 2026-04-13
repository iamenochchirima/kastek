use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{Datelike, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{error::AppError, middleware};

#[derive(Debug, Deserialize)]
pub struct CreateLeadRequest {
    #[serde(rename = "tenantClientId")]
    pub tenant_client_id: String,
    pub name: String,
    pub email: String,
    pub phone: Option<String>,
    pub company: Option<String>,
    pub source: String,
    pub notes: Option<String>,
}

#[derive(Debug, FromRow, Serialize)]
struct LeadRow {
    id: String,
    tenant_client_id: String,
    tenant_client_name: String,
    name: String,
    email: String,
    phone: Option<String>,
    company: Option<String>,
    source: String,
    status: String,
    score: i32,
    notes: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, FromRow)]
struct LeadStatsRow {
    total_leads: i64,
    qualified_leads: i64,
    converted_leads: i64,
}

#[derive(Debug, Serialize)]
struct WeeklyTrendPoint {
    date: String,
    count: i64,
}

#[derive(Debug, FromRow, Serialize)]
struct StatusCount {
    status: String,
    count: i64,
}

fn ensure_lead_write_roles(roles: &[String]) -> Result<(), AppError> {
    middleware::require_tenant_roles(
        roles,
        &["owner", "admin", "account_manager", "sales_manager", "support"],
    )
}

fn normalize_optional(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn normalize_source(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn calculate_score(source: &str, has_phone: bool, has_company: bool, notes: bool) -> i32 {
    let mut score = match source {
        "voice" => 85,
        "whatsapp" => 78,
        "instagram" => 64,
        "web_chat" => 72,
        "email" => 60,
        _ => 50,
    };

    if has_phone {
        score += 10;
    }

    if has_company {
        score += 8;
    }

    if notes {
        score += 4;
    }

    score.clamp(0, 100)
}

pub async fn list_leads(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    middleware::require_tenant_roles(
        &session.roles,
        &["owner", "admin", "account_manager", "sales_manager", "support"],
    )?;
    let pool = middleware::db_pool(&req)?;

    let leads = sqlx::query_as::<_, LeadRow>(
        r#"
        SELECT
            l.id,
            l.tenant_client_id,
            c.name AS tenant_client_name,
            l.name,
            l.email,
            l.phone,
            l.company,
            l.source,
            l.status,
            l.score,
            l.notes,
            l.created_at,
            l.updated_at
        FROM tenant_leads l
        JOIN tenant_clients c ON c.id = l.tenant_client_id
        WHERE l.workspace_id = $1
        ORDER BY l.created_at DESC
        "#,
    )
    .bind(&session.workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "leads": leads
    })))
}

pub async fn get_lead_stats(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    middleware::require_tenant_roles(
        &session.roles,
        &["owner", "admin", "account_manager", "sales_manager", "support"],
    )?;
    let pool = middleware::db_pool(&req)?;

    let stats = sqlx::query_as::<_, LeadStatsRow>(
        r#"
        SELECT
            COUNT(*) AS total_leads,
            COUNT(*) FILTER (WHERE status = 'qualified') AS qualified_leads,
            COUNT(*) FILTER (WHERE status = 'converted') AS converted_leads
        FROM tenant_leads
        WHERE workspace_id = $1
        "#,
    )
    .bind(&session.workspace_id)
    .fetch_one(pool)
    .await?;

    let raw_weekly = sqlx::query_as::<_, (chrono::NaiveDate, i64)>(
        r#"
        SELECT
            DATE(created_at AT TIME ZONE 'UTC') AS date,
            COUNT(*) AS count
        FROM tenant_leads
        WHERE workspace_id = $1
          AND created_at >= NOW() - INTERVAL '6 days'
        GROUP BY date
        ORDER BY date ASC
        "#,
    )
    .bind(&session.workspace_id)
    .fetch_all(pool)
    .await?;

    let weekly_trend = (0..7)
        .map(|offset| {
            let day = (Utc::now() - Duration::days(i64::from(6 - offset))).date_naive();
            let count = raw_weekly
                .iter()
                .find(|(date, _)| *date == day)
                .map(|(_, count)| *count)
                .unwrap_or(0);

            WeeklyTrendPoint {
                date: format!("{:02}/{:02}", day.month(), day.day()),
                count,
            }
        })
        .collect::<Vec<_>>();

    let by_status = sqlx::query_as::<_, StatusCount>(
        r#"
        SELECT status, COUNT(*) AS count
        FROM tenant_leads
        WHERE workspace_id = $1
        GROUP BY status
        ORDER BY count DESC, status ASC
        "#,
    )
    .bind(&session.workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "stats": {
            "total": stats.total_leads,
            "qualified": stats.qualified_leads,
            "converted": stats.converted_leads,
            "weeklyTrend": weekly_trend,
            "byStatus": by_status,
        }
    })))
}

pub async fn create_lead(
    req: HttpRequest,
    body: web::Json<CreateLeadRequest>,
) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_user_session(&req).await?;
    ensure_lead_write_roles(&session.roles)?;
    let pool = middleware::db_pool(&req)?;

    let name = body.name.trim();
    let email = body.email.trim().to_ascii_lowercase();
    let source = normalize_source(&body.source);

    if body.tenant_client_id.trim().is_empty() || name.is_empty() || email.is_empty() {
        return Err(AppError::BadRequest(
            "tenantClientId, name, and email are required".to_string(),
        ));
    }

    let tenant_client = middleware::require_active_tenant_client(
        pool,
        &session.workspace_id,
        body.tenant_client_id.trim(),
    )
    .await
    .map_err(|_| AppError::BadRequest("tenant client not found".to_string()))?;

    let score = calculate_score(
        &source,
        normalize_optional(&body.phone).is_some(),
        normalize_optional(&body.company).is_some(),
        normalize_optional(&body.notes).is_some(),
    );
    let lead_id = cuid2::create_id();

    sqlx::query(
        r#"
        INSERT INTO tenant_leads (
            id,
            workspace_id,
            tenant_client_id,
            created_by_tenant_user_id,
            name,
            email,
            phone,
            company,
            source,
            status,
            score,
            notes,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new', $10, $11, NOW(), NOW())
        "#,
    )
    .bind(&lead_id)
    .bind(&session.workspace_id)
    .bind(body.tenant_client_id.trim())
    .bind(&session.tenant_user_id)
    .bind(name)
    .bind(&email)
    .bind(normalize_optional(&body.phone))
    .bind(normalize_optional(&body.company))
    .bind(&source)
    .bind(score)
    .bind(normalize_optional(&body.notes))
    .execute(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "lead": {
            "id": lead_id,
            "tenantClientId": body.tenant_client_id.trim(),
            "tenantClientName": tenant_client.name,
            "name": name,
            "email": email,
            "phone": normalize_optional(&body.phone),
            "company": normalize_optional(&body.company),
            "source": source,
            "status": "new",
            "score": score,
            "notes": normalize_optional(&body.notes),
        }
    })))
}

pub async fn list_client_leads(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_client_user_session(&req).await?;
    let pool = middleware::db_pool(&req)?;

    let leads = sqlx::query_as::<_, LeadRow>(
        r#"
        SELECT
            l.id,
            l.tenant_client_id,
            c.name AS tenant_client_name,
            l.name,
            l.email,
            l.phone,
            l.company,
            l.source,
            l.status,
            l.score,
            l.notes,
            l.created_at,
            l.updated_at
        FROM tenant_leads l
        JOIN tenant_clients c ON c.id = l.tenant_client_id
        WHERE l.workspace_id = $1
          AND l.tenant_client_id = $2
        ORDER BY l.created_at DESC
        "#,
    )
    .bind(&session.workspace_id)
    .bind(&session.tenant_client_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "tenantClientId": session.tenant_client_id,
        "leads": leads
    })))
}

pub async fn get_client_lead_stats(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let session = middleware::extract_tenant_client_user_session(&req).await?;
    let pool = middleware::db_pool(&req)?;

    let stats = sqlx::query_as::<_, LeadStatsRow>(
        r#"
        SELECT
            COUNT(*) AS total_leads,
            COUNT(*) FILTER (WHERE status = 'qualified') AS qualified_leads,
            COUNT(*) FILTER (WHERE status = 'converted') AS converted_leads
        FROM tenant_leads
        WHERE workspace_id = $1
          AND tenant_client_id = $2
        "#,
    )
    .bind(&session.workspace_id)
    .bind(&session.tenant_client_id)
    .fetch_one(pool)
    .await?;

    let by_status = sqlx::query_as::<_, StatusCount>(
        r#"
        SELECT status, COUNT(*) AS count
        FROM tenant_leads
        WHERE workspace_id = $1
          AND tenant_client_id = $2
        GROUP BY status
        ORDER BY count DESC, status ASC
        "#,
    )
    .bind(&session.workspace_id)
    .bind(&session.tenant_client_id)
    .fetch_all(pool)
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "stats": {
            "total": stats.total_leads,
            "qualified": stats.qualified_leads,
            "converted": stats.converted_leads,
            "byStatus": by_status,
        }
    })))
}
