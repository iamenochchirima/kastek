//! Bounded, platform-wide analytics for the privileged Admin boundary.
//!
//! These first overview metrics deliberately use Core-owned authoritative records. They are
//! current-state/reporting aggregates, not a replacement for the delayed Analytics projections.
//! The response labels that distinction so the Admin UI cannot present them as an unqualified
//! real-time stream.

use std::collections::BTreeMap;

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

use crate::{
    db::models::AdminUser, error::AppError, identity::admin_session, middleware::extract_admin,
};

const MAX_RANGE_DAYS: i64 = 366;
const DEFAULT_RANGE_DAYS: i64 = 30;
const TOP_ORGANIZATION_LIMIT: i64 = 10;

#[derive(Debug, Deserialize)]
pub struct OverviewQuery {
    pub days: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminOverviewResponse {
    range: OverviewRange,
    timezone: &'static str,
    source: &'static str,
    data_as_of: DateTime<Utc>,
    kpis: OverviewKpis,
    daily: Vec<DailyPoint>,
    product_mix: Vec<BreakdownPoint>,
    plan_mix: Vec<PlanMixPoint>,
    top_organizations: Vec<OrganizationActivity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewRange {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    days: i64,
    interval: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewKpis {
    total_organizations: i64,
    new_organizations: i64,
    active_organizations: i64,
    total_users: i64,
    new_users: i64,
    active_users: i64,
    active_subscriptions: i64,
    trials: i64,
    past_due_subscriptions: i64,
    collected_revenue_minor: i64,
    monthly_recurring_revenue_minor: i64,
    failed_payments: i64,
    operations: i64,
    failed_operations: i64,
    credits_consumed: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyPoint {
    date: NaiveDate,
    new_organizations: i64,
    new_users: i64,
    active_organizations: i64,
    operations: i64,
    failed_operations: i64,
    revenue_minor: i64,
    credits_consumed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BreakdownPoint {
    key: String,
    label: String,
    value: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanMixPoint {
    product: String,
    plan: String,
    subscriptions: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrganizationActivity {
    id: String,
    name: String,
    plan: Option<String>,
    operations: i64,
    active_days: i64,
}

#[derive(Debug, Default)]
struct DailyAccumulator {
    new_organizations: i64,
    new_users: i64,
    active_organizations: i64,
    operations: i64,
    failed_operations: i64,
    revenue_minor: i64,
    credits_consumed: i64,
}

pub async fn overview(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<OverviewQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;

    let days = query.days.unwrap_or(DEFAULT_RANGE_DAYS);
    if !(1..=MAX_RANGE_DAYS).contains(&days) {
        return Err(AppError::BadRequest(format!(
            "days must be between 1 and {MAX_RANGE_DAYS}"
        )));
    }

    let data_as_of = Utc::now();
    let range_end = data_as_of;
    let range_start = start_of_day(range_end - Duration::days(days - 1));
    let daily = load_daily(pool.get_ref(), range_start, range_end).await?;
    let kpis = load_kpis(pool.get_ref(), range_start, range_end).await?;
    let product_mix = load_product_mix(pool.get_ref(), range_start, range_end).await?;
    let plan_mix = load_plan_mix(pool.get_ref()).await?;
    let top_organizations = load_top_organizations(pool.get_ref(), range_start, range_end).await?;

    Ok(HttpResponse::Ok().json(AdminOverviewResponse {
        range: OverviewRange {
            start: range_start,
            end: range_end,
            days,
            interval: "day",
        },
        timezone: "UTC",
        source: "core_authoritative",
        data_as_of,
        kpis,
        daily,
        product_mix,
        plan_mix,
        top_organizations,
    }))
}

async fn authorize_analytics(
    req: &HttpRequest,
    pool: &PgPool,
    admin: &AdminUser,
) -> Result<(), AppError> {
    let context = admin_session::resolve(req, pool).await?;
    if !context.has_grant("admin:read") {
        return Err(AppError::Forbidden("Insufficient permissions".to_string()));
    }
    if ![
        "viewer",
        "support",
        "operator",
        "security",
        "admin",
        "superadmin",
        "owner",
    ]
    .iter()
    .any(|role| role.eq_ignore_ascii_case(admin.role.trim()))
    {
        return Err(AppError::Forbidden("Insufficient permissions".to_string()));
    }
    Ok(())
}

async fn load_kpis(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<OverviewKpis, AppError> {
    let total_organizations = scalar_count(pool, r#"SELECT COUNT(*) FROM "Organization""#).await?;
    let new_organizations = scalar_count_with_range(
        pool,
        r#"SELECT COUNT(*) FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2"#,
        start,
        end,
    )
    .await?;
    let active_organizations = scalar_count_with_range(
        pool,
        r#"
        SELECT COUNT(DISTINCT org_id)
        FROM (
          SELECT "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
        ) activity
        WHERE org_id IS NOT NULL
        "#,
        start,
        end,
    )
    .await?;
    let total_users = scalar_count(pool, r#"SELECT COUNT(*) FROM "User""#).await?;
    let new_users = scalar_count_with_range(
        pool,
        r#"SELECT COUNT(*) FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2"#,
        start,
        end,
    )
    .await?;
    let active_users = scalar_count_with_range(
        pool,
        r#"
        SELECT COUNT(DISTINCT owner_id)
        FROM (
          SELECT o."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2
          UNION ALL
          SELECT o."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2
          UNION ALL
          SELECT o."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2
        ) activity
        "#,
        start,
        end,
    )
    .await?;

    let active_subscriptions = scalar_count(
        pool,
        r#"SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')"#,
    )
    .await?;
    let trials = scalar_count(
        pool,
        r#"SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" = 'TRIAL'"#,
    )
    .await?;
    let past_due_subscriptions = scalar_count(
        pool,
        r#"SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" = 'PAST_DUE'"#,
    )
    .await?;
    let collected_revenue_minor = scalar_sum_with_range(
        pool,
        r#"SELECT COALESCE(SUM("amountMinor"), 0)::BIGINT FROM "BillingInvoice" WHERE "status" = 'PAID' AND "paidAt" >= $1 AND "paidAt" < $2"#,
        start,
        end,
    )
    .await?;
    let monthly_recurring_revenue_minor = scalar_sum(
        pool,
        r#"
        SELECT COALESCE(SUM(
          CASE WHEN plan.interval = 'YEARLY' THEN COALESCE(plan."amountMinor", 0) / 12 ELSE COALESCE(plan."amountMinor", 0) END
        ), 0)::BIGINT
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')
        "#,
    )
    .await?;
    let failed_payments = scalar_count_with_range(
        pool,
        r#"SELECT COUNT(*) FROM "BillingCheckout" WHERE "status" IN ('FAILED', 'ABANDONED') AND "updatedAt" >= $1 AND "updatedAt" < $2"#,
        start,
        end,
    )
    .await?;
    let operations = scalar_sum_with_range(
        pool,
        r#"SELECT COALESCE(SUM("quantity"), 0)::BIGINT FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2"#,
        start,
        end,
    )
    .await?;
    let failed_operations = scalar_sum_with_range(
        pool,
        r#"SELECT COALESCE(SUM("quantity"), 0)::BIGINT FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 AND (LOWER("metricKey") LIKE '%fail%' OR LOWER("metricKey") LIKE '%error%')"#,
        start,
        end,
    )
    .await?;
    let credits_consumed = scalar_sum_with_range(
        pool,
        r#"SELECT COALESCE(SUM("creditsCharged"), 0)::BIGINT FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2"#,
        start,
        end,
    )
    .await?;

    Ok(OverviewKpis {
        total_organizations,
        new_organizations,
        active_organizations,
        total_users,
        new_users,
        active_users,
        active_subscriptions,
        trials,
        past_due_subscriptions,
        collected_revenue_minor,
        monthly_recurring_revenue_minor,
        failed_payments,
        operations,
        failed_operations,
        credits_consumed,
    })
}

async fn load_daily(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<DailyPoint>, AppError> {
    let mut values = BTreeMap::<NaiveDate, DailyAccumulator>::new();
    let mut day = start.date_naive();
    while day <= end.date_naive() {
        values.insert(day, DailyAccumulator::default());
        day += Duration::days(1);
    }

    let rows = sqlx::query(
        r#"SELECT date_trunc('day', "createdAt") AS bucket, COUNT(*)::BIGINT AS value FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        add_daily_value(
            &mut values,
            row_date(&row, "bucket")?,
            "new_organizations",
            row_i64(&row, "value")?,
        );
    }

    let rows = sqlx::query(
        r#"SELECT date_trunc('day', "createdAt") AS bucket, COUNT(*)::BIGINT AS value FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        add_daily_value(
            &mut values,
            row_date(&row, "bucket")?,
            "new_users",
            row_i64(&row, "value")?,
        );
    }

    let rows = sqlx::query(
        r#"
        SELECT bucket, COUNT(DISTINCT org_id)::BIGINT AS value
        FROM (
          SELECT date_trunc('day', "occurredAt") AS bucket, "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
        ) activity
        WHERE org_id IS NOT NULL
        GROUP BY bucket ORDER BY bucket
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        add_daily_value(
            &mut values,
            row_date(&row, "bucket")?,
            "active_organizations",
            row_i64(&row, "value")?,
        );
    }

    let rows = sqlx::query(
        r#"SELECT date_trunc('day', "occurredAt") AS bucket, COALESCE(SUM("quantity"), 0)::BIGINT AS operations, COALESCE(SUM(CASE WHEN LOWER("metricKey") LIKE '%fail%' OR LOWER("metricKey") LIKE '%error%' THEN "quantity" ELSE 0 END), 0)::BIGINT AS failures FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY bucket ORDER BY bucket"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        let date = row_date(&row, "bucket")?;
        add_daily_value(
            &mut values,
            date,
            "operations",
            row_i64(&row, "operations")?,
        );
        add_daily_value(
            &mut values,
            date,
            "failed_operations",
            row_i64(&row, "failures")?,
        );
    }

    let rows = sqlx::query(
        r#"SELECT date_trunc('day', "paidAt") AS bucket, COALESCE(SUM("amountMinor"), 0)::BIGINT AS value FROM "BillingInvoice" WHERE "status" = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY bucket ORDER BY bucket"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        add_daily_value(
            &mut values,
            row_date(&row, "bucket")?,
            "revenue_minor",
            row_i64(&row, "value")?,
        );
    }

    let rows = sqlx::query(
        r#"SELECT date_trunc('day', "createdAt") AS bucket, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS value FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    for row in rows {
        add_daily_value(
            &mut values,
            row_date(&row, "bucket")?,
            "credits_consumed",
            row_i64(&row, "value")?,
        );
    }

    Ok(values
        .into_iter()
        .map(|(date, value)| DailyPoint {
            date,
            new_organizations: value.new_organizations,
            new_users: value.new_users,
            active_organizations: value.active_organizations,
            operations: value.operations,
            failed_operations: value.failed_operations,
            revenue_minor: value.revenue_minor,
            credits_consumed: value.credits_consumed,
        })
        .collect())
}

async fn load_product_mix(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(
        r#"SELECT "productKey" AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey" ORDER BY value DESC, key LIMIT 12"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let key: String = row.try_get("key")?;
            Ok(BreakdownPoint {
                label: humanize_key(&key),
                key,
                value: row.try_get("value")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_plan_mix(pool: &PgPool) -> Result<Vec<PlanMixPoint>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT product.name AS product, plan.name AS plan, COUNT(subscription.id)::BIGINT AS subscriptions
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
        GROUP BY product.name, plan.name
        ORDER BY subscriptions DESC, product.name, plan.name
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PlanMixPoint {
                product: row.try_get("product")?,
                plan: row.try_get("plan")?,
                subscriptions: row.try_get("subscriptions")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_top_organizations(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<OrganizationActivity>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT
          organization.id,
          organization.name,
          current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT date_trunc('day', event."occurredAt"))::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event
          ON event."orgId" = organization.id
         AND event."occurredAt" >= $1
         AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription
          JOIN "ProductPlan" plan ON plan.id = subscription."planId"
          JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id
            AND subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
          ORDER BY subscription."createdAt" DESC
          LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        HAVING COALESCE(SUM(event.quantity), 0) > 0
        ORDER BY operations DESC, active_days DESC, organization.name
        LIMIT $3
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .bind(TOP_ORGANIZATION_LIMIT)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(OrganizationActivity {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                plan: row.try_get("plan")?,
                operations: row.try_get("operations")?,
                active_days: row.try_get("active_days")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn scalar_count(pool: &PgPool, sql: &str) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await?)
}

async fn scalar_count_with_range(
    pool: &PgPool,
    sql: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(sql)
        .bind(start.naive_utc())
        .bind(end.naive_utc())
        .fetch_one(pool)
        .await?)
}

async fn scalar_sum(pool: &PgPool, sql: &str) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await?)
}

async fn scalar_sum_with_range(
    pool: &PgPool,
    sql: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(sql)
        .bind(start.naive_utc())
        .bind(end.naive_utc())
        .fetch_one(pool)
        .await?)
}

fn start_of_day(value: DateTime<Utc>) -> DateTime<Utc> {
    Utc.from_utc_datetime(
        &value
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .expect("valid midnight"),
    )
}

fn row_date(row: &sqlx::postgres::PgRow, column: &str) -> Result<NaiveDate, sqlx::Error> {
    // Core's timestamp columns are `timestamp without time zone`; `date_trunc` preserves
    // that type, so decode the bucket as a NaiveDateTime instead of asking sqlx to attach UTC.
    Ok(row.try_get::<chrono::NaiveDateTime, _>(column)?.date())
}

fn row_i64(row: &sqlx::postgres::PgRow, column: &str) -> Result<i64, sqlx::Error> {
    row.try_get(column)
}

fn add_daily_value(
    values: &mut BTreeMap<NaiveDate, DailyAccumulator>,
    date: NaiveDate,
    field: &str,
    value: i64,
) {
    let entry = values.entry(date).or_default();
    match field {
        "new_organizations" => entry.new_organizations = value,
        "new_users" => entry.new_users = value,
        "active_organizations" => entry.active_organizations = value,
        "operations" => entry.operations = value,
        "failed_operations" => entry.failed_operations = value,
        "revenue_minor" => entry.revenue_minor = value,
        "credits_consumed" => entry.credits_consumed = value,
        _ => {}
    }
}

fn humanize_key(value: &str) -> String {
    value
        .split(['_', '-', '.'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
