//! Bounded report definitions and aggregate exports for the Admin boundary.
//!
//! Reports are deliberately separate from live analytics. A report is a named,
//! repeatable view over the same Core-owned aggregate records, while export
//! returns a small CSV artifact that never contains customer message content,
//! provider payloads, credentials, or support-access data.

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, NaiveDate, Utc};
use csv::Writer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::{
    controllers::admin_analytics::{authorize_analytics, report_window},
    error::AppError,
    middleware::{extract_admin, require_admin_role},
};

const MAX_SAVED_REPORTS: i64 = 100;
const MAX_CONFIG_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportDefinition {
    key: &'static str,
    version: u8,
    name: &'static str,
    description: &'static str,
    source: &'static str,
}

const REPORT_DEFINITIONS: [ReportDefinition; 4] = [
    ReportDefinition {
        key: "platform-overview",
        version: 1,
        name: "Platform overview",
        description: "Daily organizations, users, operations, and collected revenue.",
        source: "Core authoritative records",
    },
    ReportDefinition {
        key: "usage-daily",
        version: 1,
        name: "Usage by day",
        description: "Daily operations, conversations, messages, sends, and credits consumed.",
        source: "Core authoritative records",
    },
    ReportDefinition {
        key: "revenue-daily",
        version: 1,
        name: "Revenue by day",
        description: "Daily collections, refunds, paid invoices, and failed checkouts.",
        source: "Core billing records",
    },
    ReportDefinition {
        key: "customer-cohorts",
        version: 1,
        name: "Customer cohorts",
        description: "Organization activity and current plan distribution.",
        source: "Core organization and billing records",
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportsResponse {
    reports: &'static [ReportDefinition],
    saved: Vec<SavedReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedReport {
    id: String,
    name: String,
    report_key: String,
    config: Value,
    version: u8,
    created_by_id: String,
    created_by_name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReportRequest {
    pub name: String,
    pub report_key: String,
    pub days: Option<i64>,
    pub config: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    pub report: String,
    pub days: Option<i64>,
}

pub async fn index(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    let saved = load_saved_reports(pool.get_ref(), &admin.id).await?;

    Ok(HttpResponse::Ok().json(ReportsResponse {
        reports: &REPORT_DEFINITIONS,
        saved,
    }))
}

pub async fn save(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<SaveReportRequest>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    require_admin_role(&admin, &["admin", "superadmin", "owner"])?;
    let name = body.name.trim();
    if !(2..=80).contains(&name.chars().count()) {
        return Err(AppError::BadRequest(
            "Report name must be between 2 and 80 characters".to_string(),
        ));
    }
    if !is_known_report(&body.report_key) {
        return Err(AppError::BadRequest("Report type is invalid".to_string()));
    }
    let days = body.days.unwrap_or(30);
    report_window(Some(days))?;

    let mut config = body.config.clone().unwrap_or_else(|| json!({}));
    if !config.is_object() {
        return Err(AppError::BadRequest(
            "Report configuration must be an object".to_string(),
        ));
    }
    config
        .as_object_mut()
        .expect("object checked above")
        .extend([
            ("days".to_string(), json!(days)),
            (
                "version".to_string(),
                json!(report_version(&body.report_key)),
            ),
        ]);
    if serde_json::to_vec(&config)
        .map_err(|_| AppError::BadRequest("Report configuration is invalid".to_string()))?
        .len()
        > MAX_CONFIG_BYTES
    {
        return Err(AppError::BadRequest(
            "Report configuration is too large".to_string(),
        ));
    }

    let id = cuid2::create_id();
    let saved = sqlx::query(
        r#"
        INSERT INTO "AdminSavedReport" (id, name, "reportKey", config, "createdById", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id, name, "reportKey", config,
                  "createdById", ("createdAt" AT TIME ZONE 'UTC') AS created_at,
                  ("updatedAt" AT TIME ZONE 'UTC') AS updated_at
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(&body.report_key)
    .bind(config)
    .bind(&admin.id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(SavedReport {
        id: saved.try_get("id")?,
        name: saved.try_get("name")?,
        report_key: saved.try_get("reportKey")?,
        config: saved.try_get("config")?,
        version: report_version(&body.report_key),
        created_by_id: saved.try_get("createdById")?,
        created_by_name: admin.name,
        created_at: saved.try_get("created_at")?,
        updated_at: saved.try_get("updated_at")?,
    }))
}

pub async fn remove(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    report_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    require_admin_role(&admin, &["admin", "superadmin", "owner"])?;
    let result =
        sqlx::query(r#"DELETE FROM "AdminSavedReport" WHERE id = $1 AND "createdById" = $2"#)
            .bind(report_id.into_inner())
            .bind(&admin.id)
            .execute(pool.get_ref())
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Saved report not found".to_string()));
    }
    Ok(HttpResponse::NoContent().finish())
}

pub async fn export(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ExportQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    require_admin_role(&admin, &["admin", "superadmin", "owner"])?;
    if !is_known_report(&query.report) {
        return Err(AppError::BadRequest("Report type is invalid".to_string()));
    }
    let (start, end, _) = report_window(query.days)?;
    let export_audit_id = cuid2::create_id();
    let requested_days = query.days.unwrap_or(30);
    sqlx::query(
        r#"INSERT INTO "AdminReportExportAuditEvent" (id, "adminId", "reportKey", days, format, status, "createdAt") VALUES ($1, $2, $3, $4, 'csv', 'REQUESTED', NOW())"#,
    )
    .bind(&export_audit_id)
    .bind(&admin.id)
    .bind(&query.report)
    .bind(requested_days)
    .execute(pool.get_ref())
    .await?;

    let mut writer = Writer::from_writer(Vec::<u8>::new());
    let export_result: Result<(), AppError> = match query.report.as_str() {
        "platform-overview" => {
            write_platform_overview(&mut writer, pool.get_ref(), start, end).await
        }
        "usage-daily" => write_usage_daily(&mut writer, pool.get_ref(), start, end).await,
        "revenue-daily" => write_revenue_daily(&mut writer, pool.get_ref(), start, end).await,
        "customer-cohorts" => write_customer_cohorts(&mut writer, pool.get_ref(), start, end).await,
        _ => unreachable!("known report validated above"),
    };
    if let Err(error) = export_result {
        let _ = sqlx::query(
            r#"UPDATE "AdminReportExportAuditEvent" SET status = 'FAILED' WHERE id = $1"#,
        )
        .bind(&export_audit_id)
        .execute(pool.get_ref())
        .await;
        return Err(error);
    }
    let bytes = writer
        .into_inner()
        .map_err(|_| AppError::Internal("Unable to finalize report export".to_string()))?;
    sqlx::query(r#"UPDATE "AdminReportExportAuditEvent" SET status = 'SUCCEEDED' WHERE id = $1"#)
        .bind(&export_audit_id)
        .execute(pool.get_ref())
        .await?;
    let filename = format!(
        "kasitek-{}-{}.csv",
        query.report,
        Utc::now().format("%Y%m%d")
    );
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/csv; charset=utf-8"))
        .insert_header((
            "Content-Disposition",
            format!("attachment; filename=\"{filename}\""),
        ))
        .insert_header(("Cache-Control", "no-store"))
        .body(bytes))
}

async fn load_saved_reports(pool: &PgPool, admin_id: &str) -> Result<Vec<SavedReport>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT report.id, report.name, report."reportKey", report.config,
               report."createdById", admin.name AS created_by_name,
               (report."createdAt" AT TIME ZONE 'UTC') AS created_at,
               (report."updatedAt" AT TIME ZONE 'UTC') AS updated_at
        FROM "AdminSavedReport" report
        JOIN "AdminUser" admin ON admin.id = report."createdById"
        WHERE report."createdById" = $1
        ORDER BY report."updatedAt" DESC
        LIMIT $2
        "#,
    )
    .bind(admin_id)
    .bind(MAX_SAVED_REPORTS)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(SavedReport {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                report_key: row.try_get("reportKey")?,
                config: row.try_get("config")?,
                version: row
                    .try_get::<Value, _>("config")?
                    .get("version")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(|| {
                        report_version(&row.try_get::<String, _>("reportKey").unwrap_or_default())
                            as u64
                    }) as u8,
                created_by_id: row.try_get("createdById")?,
                created_by_name: row.try_get("created_by_name")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

fn is_known_report(value: &str) -> bool {
    REPORT_DEFINITIONS.iter().any(|report| report.key == value)
}

fn report_version(value: &str) -> u8 {
    REPORT_DEFINITIONS
        .iter()
        .find(|report| report.key == value)
        .map(|report| report.version)
        .unwrap_or(0)
}

async fn write_platform_overview(
    writer: &mut Writer<Vec<u8>>,
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(), AppError> {
    writer.write_record([
        "date",
        "new_organizations",
        "new_users",
        "active_organizations",
        "operations",
        "collected_revenue_minor",
    ])?;
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', $1::timestamp),
            date_trunc('day', ($2::timestamp - interval '1 microsecond')),
            interval '1 day'
          )::date AS date
        ), organizations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
        ), users AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
        ), active AS (
          SELECT date, COUNT(DISTINCT org_id)::BIGINT AS value FROM (
            SELECT date_trunc('day', "occurredAt")::date AS date, "orgId" AS org_id
            FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
            UNION ALL
            SELECT date_trunc('day', "createdAt")::date, "orgId"
            FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL
            SELECT date_trunc('day', "createdAt")::date, "orgId"
            FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          ) activity GROUP BY date
        ), usage AS (
          SELECT date_trunc('day', "occurredAt")::date AS date, COALESCE(SUM(quantity), 0)::BIGINT AS value
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
        ), revenue AS (
          SELECT date_trunc('day', "paidAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS value
          FROM "BillingInvoice"
          WHERE status = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(organizations.value, 0)::BIGINT AS new_organizations,
          COALESCE(users.value, 0)::BIGINT AS new_users,
          COALESCE(active.value, 0)::BIGINT AS active_organizations,
          COALESCE(usage.value, 0)::BIGINT AS operations,
          COALESCE(revenue.value, 0)::BIGINT AS collected_revenue_minor
        FROM days
        LEFT JOIN organizations USING (date)
        LEFT JOIN users USING (date)
        LEFT JOIN active USING (date)
        LEFT JOIN usage USING (date)
        LEFT JOIN revenue USING (date)
        ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        writer.write_record([
            row.try_get::<NaiveDate, _>("date")?.to_string(),
            row.try_get::<i64, _>("new_organizations")?.to_string(),
            row.try_get::<i64, _>("new_users")?.to_string(),
            row.try_get::<i64, _>("active_organizations")?.to_string(),
            row.try_get::<i64, _>("operations")?.to_string(),
            row.try_get::<i64, _>("collected_revenue_minor")?
                .to_string(),
        ])?;
    }
    Ok(())
}

async fn write_usage_daily(
    writer: &mut Writer<Vec<u8>>,
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(), AppError> {
    writer.write_record([
        "date",
        "operations",
        "conversations",
        "messages",
        "calls",
        "campaign_sends",
        "credits_consumed",
    ])?;
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        ), usage AS (
          SELECT date_trunc('day', "occurredAt")::date AS date, COALESCE(SUM(quantity), 0)::BIGINT AS value
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
        ), conversations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), messages AS (
          SELECT date_trunc('day', message."timestamp")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2 GROUP BY 1
        ), calls AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "CommunicationCall" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), sends AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), credits AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS value
          FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(usage.value, 0)::BIGINT AS operations,
          COALESCE(conversations.value, 0)::BIGINT AS conversations,
          COALESCE(messages.value, 0)::BIGINT AS messages,
          COALESCE(calls.value, 0)::BIGINT AS calls,
          COALESCE(sends.value, 0)::BIGINT AS campaign_sends,
          COALESCE(credits.value, 0)::BIGINT AS credits_consumed
        FROM days
        LEFT JOIN usage USING (date)
        LEFT JOIN conversations USING (date)
        LEFT JOIN messages USING (date)
        LEFT JOIN calls USING (date)
        LEFT JOIN sends USING (date)
        LEFT JOIN credits USING (date)
        ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        writer.write_record([
            row.try_get::<NaiveDate, _>("date")?.to_string(),
            row.try_get::<i64, _>("operations")?.to_string(),
            row.try_get::<i64, _>("conversations")?.to_string(),
            row.try_get::<i64, _>("messages")?.to_string(),
            row.try_get::<i64, _>("calls")?.to_string(),
            row.try_get::<i64, _>("campaign_sends")?.to_string(),
            row.try_get::<i64, _>("credits_consumed")?.to_string(),
        ])?;
    }
    Ok(())
}

async fn write_revenue_daily(
    writer: &mut Writer<Vec<u8>>,
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(), AppError> {
    writer.write_record([
        "date",
        "collected_revenue_minor",
        "refunds_minor",
        "paid_invoices",
        "failed_checkouts",
    ])?;
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        ), paid AS (
          SELECT date_trunc('day', "paidAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS amount, COUNT(*)::BIGINT AS invoices
          FROM "BillingInvoice" WHERE status = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY 1
        ), refunds AS (
          SELECT date_trunc('day', "updatedAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS amount
          FROM "BillingInvoice" WHERE status = 'REFUNDED' AND "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        ), failed AS (
          SELECT date_trunc('day', "updatedAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "BillingCheckout" WHERE status IN ('FAILED', 'ABANDONED') AND "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(paid.amount, 0)::BIGINT AS collected_revenue_minor,
          COALESCE(refunds.amount, 0)::BIGINT AS refunds_minor,
          COALESCE(paid.invoices, 0)::BIGINT AS paid_invoices,
          COALESCE(failed.value, 0)::BIGINT AS failed_checkouts
        FROM days LEFT JOIN paid USING (date) LEFT JOIN refunds USING (date) LEFT JOIN failed USING (date)
        ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        writer.write_record([
            row.try_get::<NaiveDate, _>("date")?.to_string(),
            row.try_get::<i64, _>("collected_revenue_minor")?
                .to_string(),
            row.try_get::<i64, _>("refunds_minor")?.to_string(),
            row.try_get::<i64, _>("paid_invoices")?.to_string(),
            row.try_get::<i64, _>("failed_checkouts")?.to_string(),
        ])?;
    }
    Ok(())
}

async fn write_customer_cohorts(
    writer: &mut Writer<Vec<u8>>,
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(), AppError> {
    writer.write_record([
        "organization_id",
        "organization_name",
        "current_plan",
        "operations",
        "active_days",
    ])?;
    let rows = sqlx::query(
        r#"
        SELECT organization.id, organization.name,
          current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT date_trunc('day', event."occurredAt"))::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event ON event."orgId" = organization.id AND event."occurredAt" >= $1 AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription
          JOIN "ProductPlan" plan ON plan.id = subscription."planId"
          JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id AND subscription.status IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
          ORDER BY subscription."createdAt" DESC LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        ORDER BY operations DESC, active_days DESC, organization.name
        LIMIT 500
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        let plan: Option<String> = row.try_get("plan")?;
        writer.write_record([
            row.try_get::<String, _>("id")?,
            row.try_get::<String, _>("name")?,
            plan.unwrap_or_default(),
            row.try_get::<i64, _>("operations")?.to_string(),
            row.try_get::<i64, _>("active_days")?.to_string(),
        ])?;
    }
    Ok(())
}
