use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cuid2::create_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize)]
struct QuotationRow {
    id: String,
    #[sqlx(rename = "businessName")]
    business_name: String,
    #[sqlx(rename = "contactPerson")]
    contact_person: String,
    #[sqlx(rename = "contactEmail")]
    contact_email: String,
    #[sqlx(rename = "contactPhone")]
    contact_phone: String,
    date: DateTime<Utc>,
    #[sqlx(rename = "serviceType")]
    service_type: String,
    title: String,
    introduction: Option<String>,
    #[sqlx(rename = "scopeOfWork")]
    scope_of_work: Value,
    deliverables: Value,
    #[sqlx(rename = "implementationSteps")]
    implementation_steps: Value,
    #[sqlx(rename = "pricingItems")]
    pricing_items: Value,
    #[sqlx(rename = "maintenanceIncludes")]
    maintenance_includes: Value,
    #[sqlx(rename = "termsAndNotes")]
    terms_and_notes: Value,
    #[sqlx(rename = "includedFunctionality")]
    included_functionality: Value,
    #[sqlx(rename = "knowledgeBaseScope")]
    knowledge_base_scope: Value,
    #[sqlx(rename = "importantNotes")]
    important_notes: Value,
    #[sqlx(rename = "supportIncludes")]
    support_includes: Value,
    #[sqlx(rename = "setupFee")]
    setup_fee: String,
    #[sqlx(rename = "monthlyFee")]
    monthly_fee: String,
    #[sqlx(rename = "deliveryTimeline")]
    delivery_timeline: Option<String>,
    #[sqlx(rename = "validityDays")]
    validity_days: i32,
    status: String,
    #[sqlx(rename = "quoteRequestId")]
    quote_request_id: Option<String>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    #[serde(rename = "businessName")]
    business_name: String,
    #[serde(rename = "contactPerson")]
    contact_person: String,
    #[serde(rename = "contactEmail")]
    contact_email: String,
    #[serde(rename = "contactPhone")]
    contact_phone: String,
    date: String,
    #[serde(rename = "serviceType")]
    service_type: Option<String>,
    title: String,
    introduction: Option<String>,
    #[serde(rename = "scopeOfWork")]
    scope_of_work: Option<Value>,
    deliverables: Option<Value>,
    #[serde(rename = "implementationSteps")]
    implementation_steps: Option<Value>,
    #[serde(rename = "pricingItems")]
    pricing_items: Option<Value>,
    #[serde(rename = "maintenanceIncludes")]
    maintenance_includes: Option<Value>,
    #[serde(rename = "termsAndNotes")]
    terms_and_notes: Option<Value>,
    #[serde(rename = "sectionOrder")]
    section_order: Option<Value>,
    #[serde(rename = "noteSections")]
    note_sections: Option<Value>,
    #[serde(rename = "validityDays")]
    validity_days: Option<serde_json::Value>,
    status: Option<String>,
    #[serde(rename = "quoteRequestId")]
    quote_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    #[serde(rename = "businessName")]
    business_name: Option<String>,
    #[serde(rename = "contactPerson")]
    contact_person: Option<String>,
    #[serde(rename = "contactEmail")]
    contact_email: Option<String>,
    #[serde(rename = "contactPhone")]
    contact_phone: Option<String>,
    date: Option<String>,
    #[serde(rename = "serviceType")]
    service_type: Option<String>,
    title: Option<String>,
    introduction: Option<String>,
    #[serde(rename = "scopeOfWork")]
    scope_of_work: Option<Value>,
    deliverables: Option<Value>,
    #[serde(rename = "implementationSteps")]
    implementation_steps: Option<Value>,
    #[serde(rename = "pricingItems")]
    pricing_items: Option<Value>,
    #[serde(rename = "maintenanceIncludes")]
    maintenance_includes: Option<Value>,
    #[serde(rename = "termsAndNotes")]
    terms_and_notes: Option<Value>,
    #[serde(rename = "sectionOrder")]
    section_order: Option<Value>,
    #[serde(rename = "noteSections")]
    note_sections: Option<Value>,
    #[serde(rename = "validityDays")]
    validity_days: Option<serde_json::Value>,
    status: Option<String>,
    #[serde(rename = "quoteRequestId")]
    quote_request_id: Option<Value>,
}

const SELECT_COLS: &str = r#"
    id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

fn parse_date(s: &str) -> DateTime<Utc> {
    // Try full datetime first, then date-only
    if let Ok(dt) = s.parse::<DateTime<Utc>>() {
        return dt;
    }
    if let Ok(dt) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return dt.and_hms_opt(0, 0, 0).unwrap().and_utc();
    }
    Utc::now()
}

fn parse_validity_days(v: &Option<serde_json::Value>) -> i32 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(14) as i32,
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(14),
        _ => 14,
    }
}

pub async fn list_quotations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let quotations = sqlx::query_as::<_, QuotationRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "Quotation" ORDER BY "createdAt" DESC"#
    ))
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(quotations))
}

pub async fn get_quotation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let quotation = sqlx::query_as::<_, QuotationRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "Quotation" WHERE id = $1 LIMIT 1"#
    ))
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("quotation not found".to_string()))?;

    Ok(HttpResponse::Ok().json(quotation))
}

pub async fn create_quotation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = create_id();
    let now = Utc::now();
    let date = parse_date(&body.date);
    let validity_days = parse_validity_days(&body.validity_days);
    let empty = serde_json::json!([]);

    sqlx::query(r#"
        INSERT INTO "Quotation" (
            id, "businessName", "contactPerson", "contactEmail", "contactPhone",
            date, "serviceType", title, introduction,
            "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
            "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
            "knowledgeBaseScope", "importantNotes", "supportIncludes",
            "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
            "quoteRequestId", "createdAt", "updatedAt"
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
            '','',NULL,$20,$21,$22,$23,$24
        )
    "#)
    .bind(&id)
    .bind(&body.business_name)
    .bind(&body.contact_person)
    .bind(&body.contact_email)
    .bind(&body.contact_phone)
    .bind(date)
    .bind(body.service_type.as_deref().unwrap_or("website_agent"))
    .bind(&body.title)
    .bind(&body.introduction)
    .bind(body.scope_of_work.as_ref().unwrap_or(&empty))
    .bind(body.deliverables.as_ref().unwrap_or(&empty))
    .bind(body.implementation_steps.as_ref().unwrap_or(&empty))
    .bind(body.pricing_items.as_ref().unwrap_or(&empty))
    .bind(body.maintenance_includes.as_ref().unwrap_or(&empty))
    .bind(body.terms_and_notes.as_ref().unwrap_or(&empty))
    .bind(body.section_order.as_ref().unwrap_or(&empty))
    .bind(&empty) // knowledgeBaseScope
    .bind(body.note_sections.as_ref().unwrap_or(&empty))
    .bind(&empty) // supportIncludes
    .bind(validity_days)
    .bind(body.status.as_deref().unwrap_or("draft"))
    .bind(&body.quote_request_id)
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    let quotation = sqlx::query_as::<_, QuotationRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "Quotation" WHERE id = $1"#
    ))
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(quotation))
}

pub async fn update_quotation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateBody>,
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
    if body.contact_email.is_some() { push_set!(r#""contactEmail""#); }
    if body.contact_phone.is_some() { push_set!(r#""contactPhone""#); }
    if body.date.is_some() { push_set!("date"); }
    if body.service_type.is_some() { push_set!(r#""serviceType""#); }
    if body.title.is_some() { push_set!("title"); }
    if body.introduction.is_some() { push_set!("introduction"); }
    if body.scope_of_work.is_some() { push_set!(r#""scopeOfWork""#); }
    if body.deliverables.is_some() { push_set!("deliverables"); }
    if body.implementation_steps.is_some() { push_set!(r#""implementationSteps""#); }
    if body.pricing_items.is_some() { push_set!(r#""pricingItems""#); }
    if body.maintenance_includes.is_some() { push_set!(r#""maintenanceIncludes""#); }
    if body.terms_and_notes.is_some() { push_set!(r#""termsAndNotes""#); }
    if body.section_order.is_some() { push_set!(r#""includedFunctionality""#); }
    if body.note_sections.is_some() { push_set!(r#""importantNotes""#); }
    if body.validity_days.is_some() { push_set!(r#""validityDays""#); }
    if body.status.is_some() { push_set!("status"); }
    if body.quote_request_id.is_some() { push_set!(r#""quoteRequestId""#); }

    if sets.len() == 1 {
        return get_quotation(pool, req, web::Path::from(id)).await;
    }

    let where_idx = idx;
    let sql = format!(
        r#"UPDATE "Quotation" SET {} WHERE id = ${} RETURNING {SELECT_COLS}"#,
        sets.join(", "),
        where_idx
    );

    let mut q = sqlx::query_as::<_, QuotationRow>(&sql).bind(now);
    if let Some(v) = &body.business_name { q = q.bind(v); }
    if let Some(v) = &body.contact_person { q = q.bind(v); }
    if let Some(v) = &body.contact_email { q = q.bind(v); }
    if let Some(v) = &body.contact_phone { q = q.bind(v); }
    if let Some(v) = &body.date { q = q.bind(parse_date(v)); }
    if let Some(v) = &body.service_type { q = q.bind(v); }
    if let Some(v) = &body.title { q = q.bind(v); }
    if body.introduction.is_some() { q = q.bind(body.introduction.as_deref()); }
    if let Some(v) = &body.scope_of_work { q = q.bind(v); }
    if let Some(v) = &body.deliverables { q = q.bind(v); }
    if let Some(v) = &body.implementation_steps { q = q.bind(v); }
    if let Some(v) = &body.pricing_items { q = q.bind(v); }
    if let Some(v) = &body.maintenance_includes { q = q.bind(v); }
    if let Some(v) = &body.terms_and_notes { q = q.bind(v); }
    if let Some(v) = &body.section_order { q = q.bind(v); }
    if let Some(v) = &body.note_sections { q = q.bind(v); }
    if body.validity_days.is_some() { q = q.bind(parse_validity_days(&body.validity_days)); }
    if let Some(v) = &body.status { q = q.bind(v); }
    if let Some(v) = &body.quote_request_id {
        let id_val: Option<String> = match v {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        q = q.bind(id_val);
    }
    q = q.bind(&id);

    let quotation = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("quotation not found".to_string()))?;

    Ok(HttpResponse::Ok().json(quotation))
}

pub async fn delete_quotation(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let deleted = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "Quotation" WHERE id = $1 RETURNING id"#,
    )
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("quotation not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
