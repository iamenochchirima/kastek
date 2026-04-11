use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cuid2::create_id;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize)]
struct WebServiceLeadRow {
    id: String,
    #[sqlx(rename = "businessName")]
    business_name: String,
    website: Option<String>,
    address: Option<String>,
    category: String,
    #[sqlx(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    #[sqlx(rename = "callStatus")]
    call_status: String,
    notes: Option<String>,
    #[sqlx(rename = "callbackDate")]
    callback_date: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(rename = "callStatus")]
    call_status: Option<String>,
    category: Option<String>,
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    #[serde(rename = "businessName")]
    business_name: String,
    website: Option<String>,
    address: Option<String>,
    category: String,
    #[serde(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    #[serde(rename = "callStatus")]
    call_status: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    #[serde(rename = "businessName")]
    business_name: Option<String>,
    website: Option<String>,
    address: Option<String>,
    category: Option<String>,
    #[serde(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    #[serde(rename = "callStatus")]
    call_status: Option<String>,
    notes: Option<String>,
    #[serde(rename = "callbackDate")]
    callback_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportBody {
    leads: Vec<CreateBody>,
}

const SELECT_COLS: &str = r#"
    id, "businessName", website, address, category, "bizbayUrl",
    phone, email, "callStatus", notes, "callbackDate", "createdAt", "updatedAt"
"#;

pub async fn list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ListQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let leads = sqlx::query_as::<_, WebServiceLeadRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "WebServiceLead" ORDER BY "createdAt" DESC, id ASC"#
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let filtered: Vec<&WebServiceLeadRow> = leads
        .iter()
        .filter(|l| {
            let status_ok = query.call_status.as_deref().map(|s| l.call_status == s).unwrap_or(true);
            let cat_ok = query.category.as_deref().map(|c| l.category == c).unwrap_or(true);
            let search_ok = query.search.as_deref().map(|q| {
                let q = q.to_lowercase();
                l.business_name.to_lowercase().contains(&q)
                    || l.address.as_deref().unwrap_or("").to_lowercase().contains(&q)
            }).unwrap_or(true);
            status_ok && cat_ok && search_ok
        })
        .collect();

    Ok(HttpResponse::Ok().json(filtered))
}

pub async fn get(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let lead = sqlx::query_as::<_, WebServiceLeadRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "WebServiceLead" WHERE id = $1 LIMIT 1"#
    ))
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("web service lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn create(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = create_id();
    let now = Utc::now();
    let call_status = body.call_status.as_deref().unwrap_or("pending");

    sqlx::query(
        r#"
        INSERT INTO "WebServiceLead" (
            id, "businessName", website, address, category, "bizbayUrl",
            phone, email, "callStatus", notes, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
    )
    .bind(&id)
    .bind(&body.business_name)
    .bind(&body.website)
    .bind(&body.address)
    .bind(&body.category)
    .bind(&body.bizbay_url)
    .bind(&body.phone)
    .bind(&body.email)
    .bind(call_status)
    .bind(&body.notes)
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    let lead = sqlx::query_as::<_, WebServiceLeadRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "WebServiceLead" WHERE id = $1"#
    ))
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn update(
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
    if body.website.is_some() { push_set!("website"); }
    if body.address.is_some() { push_set!("address"); }
    if body.category.is_some() { push_set!("category"); }
    if body.bizbay_url.is_some() { push_set!(r#""bizbayUrl""#); }
    if body.phone.is_some() { push_set!("phone"); }
    if body.email.is_some() { push_set!("email"); }
    if body.call_status.is_some() { push_set!(r#""callStatus""#); }
    if body.notes.is_some() { push_set!("notes"); }
    if body.callback_date.is_some() { push_set!(r#""callbackDate""#); }

    if sets.len() == 1 {
        return get(pool, req, web::Path::from(id)).await;
    }

    let where_idx = idx;
    let sql = format!(
        r#"UPDATE "WebServiceLead" SET {} WHERE id = ${} RETURNING {SELECT_COLS}"#,
        sets.join(", "),
        where_idx
    );

    let mut q = sqlx::query_as::<_, WebServiceLeadRow>(&sql).bind(now);
    if let Some(v) = &body.business_name { q = q.bind(v); }
    if body.website.is_some() { q = q.bind(body.website.as_deref()); }
    if body.address.is_some() { q = q.bind(body.address.as_deref()); }
    if let Some(v) = &body.category { q = q.bind(v); }
    if body.bizbay_url.is_some() { q = q.bind(body.bizbay_url.as_deref()); }
    if body.phone.is_some() { q = q.bind(body.phone.as_deref()); }
    if body.email.is_some() { q = q.bind(body.email.as_deref()); }
    if let Some(v) = &body.call_status { q = q.bind(v); }
    if body.notes.is_some() { q = q.bind(body.notes.as_deref()); }
    if let Some(v) = &body.callback_date {
        let dt: Option<DateTime<Utc>> = if v.is_empty() || v == "null" {
            None
        } else {
            v.parse::<DateTime<Utc>>().ok()
        };
        q = q.bind(dt);
    }
    q = q.bind(&id);

    let lead = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("web service lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn delete(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let deleted = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "WebServiceLead" WHERE id = $1 RETURNING id"#,
    )
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("web service lead not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

pub async fn import(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<ImportBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let now = Utc::now();
    let mut inserted = 0usize;

    for item in &body.leads {
        let id = create_id();
        let call_status = item.call_status.as_deref().unwrap_or("pending");

        sqlx::query(
            r#"
            INSERT INTO "WebServiceLead" (
                id, "businessName", website, address, category, "bizbayUrl",
                phone, email, "callStatus", notes, "createdAt", "updatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(&id)
        .bind(&item.business_name)
        .bind(&item.website)
        .bind(&item.address)
        .bind(&item.category)
        .bind(&item.bizbay_url)
        .bind(&item.phone)
        .bind(&item.email)
        .bind(call_status)
        .bind(&item.notes)
        .bind(now)
        .bind(now)
        .execute(pool.get_ref())
        .await?;

        inserted += 1;
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "inserted": inserted })))
}
