use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cuid2::create_id;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize)]
struct QuoteRequestRow {
    id: String,
    #[sqlx(rename = "businessName")]
    business_name: String,
    #[sqlx(rename = "contactPerson")]
    contact_person: String,
    phone: String,
    email: String,
    #[sqlx(rename = "businessType")]
    business_type: String,
    services: Vec<String>,
    description: Option<String>,
    source: String,
    status: String,
    #[sqlx(rename = "quoteAmount")]
    quote_amount: Option<f64>,
    #[sqlx(rename = "followUpDate")]
    follow_up_date: Option<DateTime<Utc>>,
    notes: serde_json::Value,
    #[sqlx(rename = "assignedToId")]
    assigned_to_id: Option<String>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListLeadsQuery {
    status: Option<String>,
    source: Option<String>,
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateLeadBody {
    #[serde(rename = "businessName")]
    business_name: String,
    #[serde(rename = "contactPerson")]
    contact_person: String,
    phone: String,
    email: String,
    #[serde(rename = "businessType")]
    business_type: String,
    services: Option<Vec<String>>,
    description: Option<String>,
    source: Option<String>,
    status: Option<String>,
    #[serde(rename = "quoteAmount")]
    quote_amount: Option<f64>,
    #[serde(rename = "assignedToId")]
    assigned_to_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLeadBody {
    #[serde(rename = "businessName")]
    business_name: Option<String>,
    #[serde(rename = "contactPerson")]
    contact_person: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    #[serde(rename = "businessType")]
    business_type: Option<String>,
    services: Option<Vec<String>>,
    description: Option<String>,
    source: Option<String>,
    status: Option<String>,
    #[serde(rename = "quoteAmount")]
    quote_amount: Option<f64>,
    #[serde(rename = "followUpDate")]
    follow_up_date: Option<String>,
    notes: Option<serde_json::Value>,
    #[serde(rename = "assignedToId")]
    assigned_to_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddNoteBody {
    text: String,
    #[serde(rename = "adminUserName")]
    admin_user_name: Option<String>,
}

const SELECT_COLS: &str = r#"
    id, "businessName", "contactPerson", phone, email, "businessType",
    services, description, source, status, "quoteAmount",
    "followUpDate" AT TIME ZONE 'UTC' AS "followUpDate",
    notes, "assignedToId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

pub async fn list_leads(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ListLeadsQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let leads = sqlx::query_as::<_, QuoteRequestRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "QuoteRequest" ORDER BY "createdAt" DESC"#
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let filtered: Vec<&QuoteRequestRow> = leads
        .iter()
        .filter(|l| {
            let status_ok = query.status.as_deref().map(|s| l.status == s).unwrap_or(true);
            let source_ok = query.source.as_deref().map(|s| l.source == s).unwrap_or(true);
            let search_ok = query.search.as_deref().map(|q| {
                let q = q.to_lowercase();
                l.business_name.to_lowercase().contains(&q)
                    || l.contact_person.to_lowercase().contains(&q)
                    || l.email.to_lowercase().contains(&q)
                    || l.phone.contains(&q)
            }).unwrap_or(true);
            status_ok && source_ok && search_ok
        })
        .collect();

    Ok(HttpResponse::Ok().json(filtered))
}

pub async fn get_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let lead = sqlx::query_as::<_, QuoteRequestRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "QuoteRequest" WHERE id = $1 LIMIT 1"#
    ))
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn create_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateLeadBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = create_id();
    let now = Utc::now();
    let services = body.services.clone().unwrap_or_default();
    let source = body.source.as_deref().unwrap_or("website");
    let status = body.status.as_deref().unwrap_or("new");

    sqlx::query(
        r#"
        INSERT INTO "QuoteRequest" (
            id, "businessName", "contactPerson", phone, email, "businessType",
            services, description, source, status, "quoteAmount", "assignedToId",
            notes, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]', $13, $14)
        "#,
    )
    .bind(&id)
    .bind(&body.business_name)
    .bind(&body.contact_person)
    .bind(&body.phone)
    .bind(&body.email)
    .bind(&body.business_type)
    .bind(&services)
    .bind(&body.description)
    .bind(source)
    .bind(status)
    .bind(body.quote_amount)
    .bind(&body.assigned_to_id)
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    let lead = sqlx::query_as::<_, QuoteRequestRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "QuoteRequest" WHERE id = $1"#
    ))
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn update_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateLeadBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();
    let now = Utc::now();

    let mut sets: Vec<String> = vec![r#""updatedAt" = $1"#.to_string()];
    let mut idx = 2usize;

    macro_rules! push_set {
        ($col:expr) => {
            sets.push(format!(r#"{} = ${}"#, $col, idx));
            idx += 1;
        };
    }

    if body.business_name.is_some() { push_set!(r#""businessName""#); }
    if body.contact_person.is_some() { push_set!(r#""contactPerson""#); }
    if body.phone.is_some() { push_set!("phone"); }
    if body.email.is_some() { push_set!("email"); }
    if body.business_type.is_some() { push_set!(r#""businessType""#); }
    if body.services.is_some() { push_set!("services"); }
    if body.description.is_some() { push_set!("description"); }
    if body.source.is_some() { push_set!("source"); }
    if body.status.is_some() { push_set!("status"); }
    if body.quote_amount.is_some() { push_set!(r#""quoteAmount""#); }
    if body.follow_up_date.is_some() { push_set!(r#""followUpDate""#); }
    if body.notes.is_some() { push_set!("notes"); }
    if body.assigned_to_id.is_some() { push_set!(r#""assignedToId""#); }

    if sets.len() == 1 {
        // Nothing to update
        return get_lead(pool, req, web::Path::from(id)).await;
    }

    let where_idx = idx;
    let sql = format!(
        r#"UPDATE "QuoteRequest" SET {} WHERE id = ${} RETURNING {SELECT_COLS}"#,
        sets.join(", "),
        where_idx
    );

    let mut q = sqlx::query_as::<_, QuoteRequestRow>(&sql).bind(now);
    if let Some(v) = &body.business_name { q = q.bind(v); }
    if let Some(v) = &body.contact_person { q = q.bind(v); }
    if let Some(v) = &body.phone { q = q.bind(v); }
    if let Some(v) = &body.email { q = q.bind(v); }
    if let Some(v) = &body.business_type { q = q.bind(v); }
    if let Some(v) = &body.services { q = q.bind(v); }
    if body.description.is_some() { q = q.bind(body.description.as_deref()); }
    if let Some(v) = &body.source { q = q.bind(v); }
    if let Some(v) = &body.status { q = q.bind(v); }
    if body.quote_amount.is_some() { q = q.bind(body.quote_amount); }
    if let Some(v) = &body.follow_up_date {
        let dt: Option<DateTime<Utc>> = if v.is_empty() || v == "null" {
            None
        } else {
            v.parse::<DateTime<Utc>>().ok()
        };
        q = q.bind(dt);
    }
    if let Some(v) = &body.notes { q = q.bind(v); }
    if body.assigned_to_id.is_some() { q = q.bind(body.assigned_to_id.as_deref()); }
    q = q.bind(&id);

    let lead = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn delete_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let deleted = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "QuoteRequest" WHERE id = $1 RETURNING id"#,
    )
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("lead not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

pub async fn add_note(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<AddNoteBody>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let note = serde_json::json!({
        "text": body.text,
        "timestamp": Utc::now().to_rfc3339(),
        "adminUserId": admin.id,
        "adminUserName": body.admin_user_name.as_deref().unwrap_or(&admin.name),
    });

    let updated = sqlx::query_scalar::<_, serde_json::Value>(
        r#"
        UPDATE "QuoteRequest"
        SET notes = notes || $1::jsonb, "updatedAt" = NOW()
        WHERE id = $2
        RETURNING notes
        "#,
    )
    .bind(serde_json::json!([note]))
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "notes": updated })))
}
