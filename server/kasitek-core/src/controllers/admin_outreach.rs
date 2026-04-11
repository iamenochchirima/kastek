use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cuid2::create_id;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

// ── Campaign ──────────────────────────────────────────────────────────────────

#[derive(Debug, FromRow, Serialize)]
struct CampaignRow {
    id: String,
    name: String,
    category: String,
    status: String,
    #[sqlx(rename = "totalLeads")]
    total_leads: i32,
    #[sqlx(rename = "emailsSent")]
    emails_sent: i32,
    replies: i32,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCampaignBody {
    name: String,
    category: String,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCampaignBody {
    name: Option<String>,
    category: Option<String>,
    status: Option<String>,
}

const CAMPAIGN_COLS: &str = r#"
    id, name, category, status, "totalLeads", "emailsSent", replies,
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

pub async fn list_campaigns(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let campaigns = sqlx::query_as::<_, CampaignRow>(&format!(
        r#"SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" ORDER BY "createdAt" DESC"#
    ))
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(campaigns))
}

pub async fn get_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let campaign = sqlx::query_as::<_, CampaignRow>(&format!(
        r#"SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" WHERE id = $1 LIMIT 1"#
    ))
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("campaign not found".to_string()))?;

    Ok(HttpResponse::Ok().json(campaign))
}

pub async fn create_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateCampaignBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = create_id();
    let now = Utc::now();

    sqlx::query(r#"
        INSERT INTO "OutreachCampaign" (id, name, category, status, "totalLeads", "emailsSent", replies, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 0, 0, 0, $5, $6)
    "#)
    .bind(&id)
    .bind(&body.name)
    .bind(&body.category)
    .bind(body.status.as_deref().unwrap_or("draft"))
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    let campaign = sqlx::query_as::<_, CampaignRow>(&format!(
        r#"SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" WHERE id = $1"#
    ))
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(campaign))
}

pub async fn update_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateCampaignBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();
    let now = Utc::now();

    let mut sets: Vec<String> = vec![r#""updatedAt" = $1"#.to_string()];
    let mut idx = 2usize;

    macro_rules! push_set {
        ($col:expr) => {
            sets.push(format!("{} = ${}", $col, idx));
            idx += 1;
        };
    }

    if body.name.is_some() { push_set!("name"); }
    if body.category.is_some() { push_set!("category"); }
    if body.status.is_some() { push_set!("status"); }

    if sets.len() == 1 {
        return get_campaign(pool, req, web::Path::from(id)).await;
    }

    let where_idx = idx;
    let sql = format!(
        r#"UPDATE "OutreachCampaign" SET {} WHERE id = ${} RETURNING {CAMPAIGN_COLS}"#,
        sets.join(", "),
        where_idx
    );

    let mut q = sqlx::query_as::<_, CampaignRow>(&sql).bind(now);
    if let Some(v) = &body.name { q = q.bind(v); }
    if let Some(v) = &body.category { q = q.bind(v); }
    if let Some(v) = &body.status { q = q.bind(v); }
    q = q.bind(&id);

    let campaign = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("campaign not found".to_string()))?;

    Ok(HttpResponse::Ok().json(campaign))
}

pub async fn delete_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let deleted = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "OutreachCampaign" WHERE id = $1 RETURNING id"#,
    )
    .bind(&id)
    .fetch_optional(pool.get_ref())
    .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("campaign not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

pub async fn delete_all_campaigns(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    sqlx::query(r#"DELETE FROM "OutreachLead""#)
        .execute(pool.get_ref())
        .await?;

    let result = sqlx::query_scalar::<_, i64>(
        r#"WITH deleted AS (DELETE FROM "OutreachCampaign" RETURNING id) SELECT COUNT(*) FROM deleted"#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": result })))
}

// ── Leads ─────────────────────────────────────────────────────────────────────

#[derive(Debug, FromRow, Serialize)]
struct LeadRow {
    id: String,
    #[sqlx(rename = "campaignId")]
    campaign_id: String,
    #[sqlx(rename = "businessName")]
    business_name: String,
    website: Option<String>,
    address: Option<String>,
    #[sqlx(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    category: String,
    phone: Option<String>,
    #[sqlx(rename = "emailStatus")]
    email_status: String,
    #[sqlx(rename = "emailAddress")]
    email_address: Option<String>,
    #[sqlx(rename = "emailSentAt")]
    email_sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "emailTemplate")]
    email_template: Option<String>,
    #[sqlx(rename = "followUpCount")]
    follow_up_count: i32,
    #[sqlx(rename = "lastFollowUp")]
    last_follow_up: Option<DateTime<Utc>>,
    #[sqlx(rename = "nextFollowUp")]
    next_follow_up: Option<DateTime<Utc>>,
    notes: Option<String>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct LeadQuery {
    #[serde(rename = "emailStatus")]
    email_status: Option<String>,
    search: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateLeadBody {
    #[serde(rename = "businessName")]
    business_name: String,
    website: Option<String>,
    address: Option<String>,
    #[serde(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    category: String,
    phone: Option<String>,
    #[serde(rename = "emailAddress")]
    email_address: Option<String>,
    #[serde(rename = "emailTemplate")]
    email_template: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLeadBody {
    #[serde(rename = "emailStatus")]
    email_status: Option<String>,
    phone: Option<String>,
    #[serde(rename = "emailAddress")]
    email_address: Option<String>,
    #[serde(rename = "emailSentAt")]
    email_sent_at: Option<String>,
    #[serde(rename = "emailTemplate")]
    email_template: Option<String>,
    #[serde(rename = "followUpCount")]
    follow_up_count: Option<i32>,
    #[serde(rename = "lastFollowUp")]
    last_follow_up: Option<String>,
    #[serde(rename = "nextFollowUp")]
    next_follow_up: Option<serde_json::Value>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportBody {
    name: String,
    category: String,
    listings: Vec<ImportListing>,
}

#[derive(Debug, Deserialize)]
pub struct ImportListing {
    name: String,
    website: Option<String>,
    address: Option<String>,
    #[serde(rename = "bizbayUrl")]
    bizbay_url: Option<String>,
    phone: Option<String>,
}

const LEAD_COLS: &str = r#"
    id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
    "emailStatus", "emailAddress",
    "emailSentAt" AT TIME ZONE 'UTC' AS "emailSentAt",
    "emailTemplate", "followUpCount",
    "lastFollowUp" AT TIME ZONE 'UTC' AS "lastFollowUp",
    "nextFollowUp" AT TIME ZONE 'UTC' AS "nextFollowUp",
    notes,
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

pub async fn list_leads(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<LeadQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let campaign_id = path.into_inner();

    let leads = sqlx::query_as::<_, LeadRow>(&format!(
        r#"SELECT {LEAD_COLS} FROM "OutreachLead" WHERE "campaignId" = $1 ORDER BY "createdAt" DESC"#
    ))
    .bind(&campaign_id)
    .fetch_all(pool.get_ref())
    .await?;

    let filtered: Vec<&LeadRow> = leads
        .iter()
        .filter(|l| {
            let status_ok = query
                .email_status
                .as_deref()
                .map(|s| l.email_status == s)
                .unwrap_or(true);
            let search_ok = query
                .search
                .as_deref()
                .map(|q| {
                    let q = q.to_lowercase();
                    l.business_name.to_lowercase().contains(&q)
                        || l.website.as_deref().unwrap_or("").to_lowercase().contains(&q)
                        || l.email_address
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&q)
                })
                .unwrap_or(true);
            status_ok && search_ok
        })
        .collect();

    Ok(HttpResponse::Ok().json(filtered))
}

pub async fn create_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<CreateLeadBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let campaign_id = path.into_inner();
    let now = Utc::now();

    // Verify campaign exists
    let exists = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "OutreachCampaign" WHERE id = $1 LIMIT 1"#,
    )
    .bind(&campaign_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if exists.is_none() {
        return Err(AppError::NotFound("campaign not found".to_string()));
    }

    let id = create_id();

    sqlx::query(r#"
        INSERT INTO "OutreachLead" (
            id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
            "emailStatus", "emailAddress", "emailTemplate", "followUpCount", notes,
            "createdAt", "updatedAt"
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,0,$11,$12,$13)
    "#)
    .bind(&id)
    .bind(&campaign_id)
    .bind(&body.business_name)
    .bind(&body.website)
    .bind(&body.address)
    .bind(&body.bizbay_url)
    .bind(&body.category)
    .bind(&body.phone)
    .bind(&body.email_address)
    .bind(&body.email_template)
    .bind(&body.notes)
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    // Update campaign totalLeads count
    sqlx::query(r#"
        UPDATE "OutreachCampaign"
        SET "totalLeads" = (SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1), "updatedAt" = NOW()
        WHERE id = $1
    "#)
    .bind(&campaign_id)
    .execute(pool.get_ref())
    .await?;

    let lead = sqlx::query_as::<_, LeadRow>(&format!(
        r#"SELECT {LEAD_COLS} FROM "OutreachLead" WHERE id = $1"#
    ))
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(lead))
}

pub async fn update_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<UpdateLeadBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let (campaign_id, lead_id) = path.into_inner();
    let now = Utc::now();

    let mut sets: Vec<String> = vec![r#""updatedAt" = $1"#.to_string()];
    let mut idx = 2usize;

    macro_rules! push_set {
        ($col:expr) => {
            sets.push(format!(r#"{} = ${}"#, $col, idx));
            idx += 1;
        };
    }

    if body.email_status.is_some() { push_set!(r#""emailStatus""#); }
    if body.phone.is_some() { push_set!("phone"); }
    if body.email_address.is_some() { push_set!(r#""emailAddress""#); }
    if body.email_sent_at.is_some() { push_set!(r#""emailSentAt""#); }
    if body.email_template.is_some() { push_set!(r#""emailTemplate""#); }
    if body.follow_up_count.is_some() { push_set!(r#""followUpCount""#); }
    if body.last_follow_up.is_some() { push_set!(r#""lastFollowUp""#); }
    if body.next_follow_up.is_some() { push_set!(r#""nextFollowUp""#); }
    if body.notes.is_some() { push_set!("notes"); }

    let where_idx = idx;
    let where_plus = idx + 1;
    let sql = format!(
        r#"UPDATE "OutreachLead" SET {} WHERE id = ${} AND "campaignId" = ${} RETURNING {LEAD_COLS}"#,
        sets.join(", "),
        where_idx,
        where_plus
    );

    let mut q = sqlx::query_as::<_, LeadRow>(&sql).bind(now);
    if let Some(v) = &body.email_status { q = q.bind(v); }
    if body.phone.is_some() { q = q.bind(body.phone.as_deref()); }
    if body.email_address.is_some() { q = q.bind(body.email_address.as_deref()); }
    if let Some(v) = &body.email_sent_at {
        let dt: Option<DateTime<Utc>> = v.parse::<DateTime<Utc>>().ok();
        q = q.bind(dt);
    }
    if body.email_template.is_some() { q = q.bind(body.email_template.as_deref()); }
    if let Some(v) = body.follow_up_count { q = q.bind(v); }
    if let Some(v) = &body.last_follow_up {
        let dt: Option<DateTime<Utc>> = v.parse::<DateTime<Utc>>().ok();
        q = q.bind(dt);
    }
    if let Some(v) = &body.next_follow_up {
        let dt: Option<DateTime<Utc>> = match v {
            serde_json::Value::String(s) if !s.is_empty() && s != "null" => {
                s.parse::<DateTime<Utc>>().ok()
            }
            _ => None,
        };
        q = q.bind(dt);
    }
    if body.notes.is_some() { q = q.bind(body.notes.as_deref()); }
    q = q.bind(&lead_id).bind(&campaign_id);

    let lead = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("lead not found".to_string()))?;

    // Update campaign sent/reply counters
    let (sent_count, reply_count) = tokio::try_join!(
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1 AND "emailStatus" = 'sent'"#,
        )
        .bind(&campaign_id)
        .fetch_one(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1 AND "emailStatus" IN ('replied','interested')"#,
        )
        .bind(&campaign_id)
        .fetch_one(pool.get_ref()),
    )?;

    sqlx::query(r#"
        UPDATE "OutreachCampaign" SET "emailsSent" = $1, replies = $2, "updatedAt" = NOW() WHERE id = $3
    "#)
    .bind(sent_count as i32)
    .bind(reply_count as i32)
    .bind(&campaign_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn get_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let (campaign_id, lead_id) = path.into_inner();

    let lead = sqlx::query_as::<_, LeadRow>(&format!(
        r#"SELECT {LEAD_COLS} FROM "OutreachLead" WHERE id = $1 AND "campaignId" = $2 LIMIT 1"#
    ))
    .bind(&lead_id)
    .bind(&campaign_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("lead not found".to_string()))?;

    Ok(HttpResponse::Ok().json(lead))
}

pub async fn delete_lead(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let (campaign_id, lead_id) = path.into_inner();

    let deleted = sqlx::query_scalar::<_, String>(
        r#"DELETE FROM "OutreachLead" WHERE id = $1 AND "campaignId" = $2 RETURNING id"#,
    )
    .bind(&lead_id)
    .bind(&campaign_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("lead not found".to_string()));
    }

    // Update campaign totalLeads count
    sqlx::query(r#"
        UPDATE "OutreachCampaign"
        SET "totalLeads" = (SELECT COUNT(*) FROM "OutreachLead" WHERE "campaignId" = $1), "updatedAt" = NOW()
        WHERE id = $1
    "#)
    .bind(&campaign_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

// ── Delivery Log Creation ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateDeliveryLogEntry {
    #[serde(rename = "campaignId")]
    campaign_id: Option<String>,
    #[serde(rename = "leadId")]
    lead_id: Option<String>,
    recipient: String,
    subject: String,
    status: String,
    provider: String,
    #[serde(rename = "providerMessageId")]
    provider_message_id: Option<String>,
    #[serde(rename = "providerResponse")]
    provider_response: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDeliveryLogsBody {
    logs: Vec<CreateDeliveryLogEntry>,
}

pub async fn create_delivery_logs(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateDeliveryLogsBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let now = Utc::now();

    for entry in &body.logs {
        let id = create_id();
        sqlx::query(r#"
            INSERT INTO "OutreachEmailDeliveryLog" (
                id, "campaignId", "leadId", recipient, subject, status, provider,
                "providerMessageId", "providerResponse", "errorMessage", "attemptedAt"
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        "#)
        .bind(&id)
        .bind(&entry.campaign_id)
        .bind(&entry.lead_id)
        .bind(&entry.recipient)
        .bind(&entry.subject)
        .bind(&entry.status)
        .bind(&entry.provider)
        .bind(&entry.provider_message_id)
        .bind(&entry.provider_response)
        .bind(&entry.error_message)
        .bind(now)
        .execute(pool.get_ref())
        .await?;
    }

    Ok(HttpResponse::Created().json(serde_json::json!({ "created": body.logs.len() })))
}

pub async fn import_campaign(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<ImportBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    // Check for duplicate category
    let existing = sqlx::query_as::<_, (String, String)>(
        r#"SELECT id, name FROM "OutreachCampaign" WHERE lower(category) = lower($1) LIMIT 1"#,
    )
    .bind(&body.category)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some((_, existing_name)) = existing {
        return Err(AppError::BadRequest(format!(
            "A campaign for \"{}\" already exists: \"{}\"",
            body.category, existing_name
        )));
    }

    let campaign_id = create_id();
    let now = Utc::now();
    let total = body.listings.len() as i32;

    let mut tx = pool.begin().await?;

    sqlx::query(r#"
        INSERT INTO "OutreachCampaign" (id, name, category, status, "totalLeads", "emailsSent", replies, "createdAt", "updatedAt")
        VALUES ($1,$2,$3,'draft',$4,0,0,$5,$6)
    "#)
    .bind(&campaign_id)
    .bind(&body.name)
    .bind(&body.category)
    .bind(total)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    for listing in &body.listings {
        let id = create_id();
        let slug = listing
            .name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else if c == ' ' { '-' } else { '\0' })
            .filter(|c| *c != '\0')
            .collect::<String>()
            .to_lowercase();
        let bizbay_url = listing
            .bizbay_url
            .clone()
            .unwrap_or_else(|| format!("https://bizbay.co.za/Company/{slug}"));

        sqlx::query(r#"
            INSERT INTO "OutreachLead" (
                id, "campaignId", "businessName", website, address, "bizbayUrl", category, phone,
                "emailStatus", "followUpCount", "createdAt", "updatedAt"
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10)
        "#)
        .bind(&id)
        .bind(&campaign_id)
        .bind(&listing.name)
        .bind(&listing.website)
        .bind(&listing.address)
        .bind(&bizbay_url)
        .bind(&body.category)
        .bind(&listing.phone)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let campaign = sqlx::query_as::<_, CampaignRow>(&format!(
        r#"SELECT {CAMPAIGN_COLS} FROM "OutreachCampaign" WHERE id = $1"#
    ))
    .bind(&campaign_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(campaign))
}

// ── Delivery Logs ─────────────────────────────────────────────────────────────

#[derive(Debug, FromRow, Serialize)]
struct DeliveryLogRow {
    id: String,
    #[sqlx(rename = "campaignId")]
    campaign_id: Option<String>,
    #[sqlx(rename = "leadId")]
    lead_id: Option<String>,
    #[sqlx(rename = "isTest")]
    is_test: bool,
    recipient: String,
    subject: String,
    status: String,
    provider: String,
    #[sqlx(rename = "providerMessageId")]
    provider_message_id: Option<String>,
    #[sqlx(rename = "errorMessage")]
    error_message: Option<String>,
    #[sqlx(rename = "attemptedAt")]
    attempted_at: DateTime<Utc>,
    campaign_name: Option<String>,
    campaign_category: Option<String>,
    lead_business_name: Option<String>,
    lead_website: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeliveryQuery {
    #[serde(rename = "campaignId")]
    campaign_id: Option<String>,
    status: Option<String>,
    mode: Option<String>,
    recipient: Option<String>,
    domain: Option<String>,
    #[serde(rename = "dateFrom")]
    date_from: Option<String>,
    #[serde(rename = "dateTo")]
    date_to: Option<String>,
    format: Option<String>,
    limit: Option<i64>,
}

pub async fn list_delivery_logs(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<DeliveryQuery>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    let mut idx = 1usize;

    if let Some(v) = &query.campaign_id {
        if !v.is_empty() {
            conditions.push(format!(r#"l."campaignId" = ${idx}"#));
            params.push(v.clone());
            idx += 1;
        }
    }
    if let Some(v) = &query.status {
        if !v.is_empty() {
            conditions.push(format!("l.status = ${idx}"));
            params.push(v.clone());
            idx += 1;
        }
    }
    if let Some(v) = &query.mode {
        match v.as_str() {
            "test" => {
                conditions.push(format!("c.category = ${idx}"));
                params.push("system-test".to_string());
                idx += 1;
            }
            "live" => {
                conditions.push(format!("(c.category IS NULL OR c.category != ${idx})"));
                params.push("system-test".to_string());
                idx += 1;
            }
            _ => {}
        }
    }
    if let Some(v) = &query.recipient {
        if !v.is_empty() {
            conditions.push(format!("lower(l.recipient) LIKE ${idx}"));
            params.push(format!("%{}%", v.to_lowercase()));
            idx += 1;
        }
    }
    if let Some(v) = &query.domain {
        let domain = v.trim_start_matches('@');
        if !domain.is_empty() {
            conditions.push(format!("lower(l.recipient) LIKE ${idx}"));
            params.push(format!("%@{}", domain.to_lowercase()));
            idx += 1;
        }
    }
    if let Some(v) = &query.date_from {
        if !v.is_empty() {
            conditions.push(format!(r#"l."attemptedAt" >= ${idx}::timestamptz"#));
            params.push(format!("{v}T00:00:00Z"));
            idx += 1;
        }
    }
    if let Some(v) = &query.date_to {
        if !v.is_empty() {
            conditions.push(format!(r#"l."attemptedAt" <= ${idx}::timestamptz"#));
            params.push(format!("{v}T23:59:59Z"));
            let _ = idx; // idx not used after this branch
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let limit = query.limit.unwrap_or(20000).min(20000);
    let sql = format!(r#"
        SELECT
            l.id, l."campaignId", l."leadId", l."isTest",
            l.recipient, l.subject, l.status, l.provider,
            l."providerMessageId", l."errorMessage",
            l."attemptedAt" AT TIME ZONE 'UTC' AS "attemptedAt",
            c.name AS campaign_name, c.category AS campaign_category,
            ol."businessName" AS lead_business_name, ol.website AS lead_website
        FROM "OutreachEmailDeliveryLog" l
        LEFT JOIN "OutreachCampaign" c ON c.id = l."campaignId"
        LEFT JOIN "OutreachLead" ol ON ol.id = l."leadId"
        {where_clause}
        ORDER BY l."attemptedAt" DESC
        LIMIT {limit}
    "#);

    // Build query with positional params
    let mut q = sqlx::query_as::<_, DeliveryLogRow>(&sql);
    for p in &params {
        q = q.bind(p);
    }

    let rows = q.fetch_all(pool.get_ref()).await?;

    // Return CSV if requested
    if query.format.as_deref() == Some("csv") {
        let mut csv = String::from(
            "attempted_at,status,recipient,subject,campaign,category,business,website,provider,error\n",
        );
        for r in &rows {
            let row = [
                r.attempted_at.to_rfc3339(),
                r.status.clone(),
                r.recipient.clone(),
                r.subject.clone(),
                r.campaign_name.clone().unwrap_or_default(),
                r.campaign_category.clone().unwrap_or_default(),
                r.lead_business_name.clone().unwrap_or_default(),
                r.lead_website.clone().unwrap_or_default(),
                r.provider.clone(),
                r.error_message.clone().unwrap_or_default(),
            ]
            .iter()
            .map(|v| {
                if v.contains(',') || v.contains('"') || v.contains('\n') {
                    format!("\"{}\"", v.replace('"', "\"\""))
                } else {
                    v.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(",");
            csv.push_str(&row);
            csv.push('\n');
        }

        return Ok(HttpResponse::Ok()
            .content_type("text/csv")
            .append_header(("Content-Disposition", "attachment; filename=delivery-log.csv"))
            .body(csv));
    }

    Ok(HttpResponse::Ok().json(rows))
}
