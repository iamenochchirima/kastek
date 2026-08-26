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

pub(crate) fn report_window(
    requested_days: Option<i64>,
) -> Result<(DateTime<Utc>, DateTime<Utc>, i64), AppError> {
    let days = requested_days.unwrap_or(DEFAULT_RANGE_DAYS);
    if !(1..=MAX_RANGE_DAYS).contains(&days) {
        return Err(AppError::BadRequest(format!(
            "days must be between 1 and {MAX_RANGE_DAYS}"
        )));
    }

    let end = Utc::now();
    let start = start_of_day(end - Duration::days(days - 1));
    Ok((start, end, days))
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

    let data_as_of = Utc::now();
    let (range_start, range_end, days) = report_window(query.days)?;
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

pub(crate) async fn authorize_analytics(
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsageResponse {
    range: OverviewRange,
    timezone: &'static str,
    source: &'static str,
    data_as_of: DateTime<Utc>,
    coverage: Vec<CoveragePoint>,
    kpis: UsageKpis,
    daily: Vec<UsageDailyPoint>,
    product_mix: Vec<BreakdownPoint>,
    metric_mix: Vec<BreakdownPoint>,
    channel_mix: Vec<BreakdownPoint>,
    campaign_funnel: Vec<BreakdownPoint>,
    connection_mix: Vec<BreakdownPoint>,
    credit_lifecycle: Vec<CreditLifecyclePoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoveragePoint {
    key: &'static str,
    label: &'static str,
    status: &'static str,
    detail: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageKpis {
    operations: i64,
    conversations: i64,
    messages: i64,
    calls: i64,
    campaign_sends: i64,
    delivered_messages: i64,
    failed_messages: i64,
    delivery_rate: f64,
    connections: i64,
    connection_issues: i64,
    credits_consumed: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageDailyPoint {
    date: NaiveDate,
    operations: i64,
    conversations: i64,
    messages: i64,
    calls: i64,
    campaign_sends: i64,
    credits_consumed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditLifecyclePoint {
    kind: String,
    amount: i64,
}

pub async fn usage(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<OverviewQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    let data_as_of = Utc::now();
    let (range_start, range_end, days) = report_window(query.days)?;
    let daily = load_usage_daily(pool.get_ref(), range_start, range_end).await?;
    let product_mix = load_usage_product_mix(pool.get_ref(), range_start, range_end).await?;
    let metric_mix = load_usage_metric_mix(pool.get_ref(), range_start, range_end).await?;
    let channel_mix = load_usage_channel_mix(pool.get_ref(), range_start, range_end).await?;
    let campaign_funnel = load_campaign_funnel(pool.get_ref(), range_start, range_end).await?;
    let connection_mix = load_connection_mix(pool.get_ref()).await?;
    let credit_lifecycle = load_credit_lifecycle(pool.get_ref(), range_start, range_end).await?;

    let operations = daily.iter().map(|point| point.operations).sum();
    let conversations = daily.iter().map(|point| point.conversations).sum();
    let messages = daily.iter().map(|point| point.messages).sum();
    let calls = daily.iter().map(|point| point.calls).sum();
    let campaign_sends = daily.iter().map(|point| point.campaign_sends).sum();
    let credits_consumed = daily.iter().map(|point| point.credits_consumed).sum();
    // READ is a successful delivery state too. Sum both states instead of
    // selecting whichever happens to appear first in the ordered breakdown.
    let delivered_messages = campaign_funnel
        .iter()
        .filter(|point| point.key == "DELIVERED" || point.key == "READ")
        .map(|point| point.value)
        .sum();
    let failed_messages = campaign_funnel
        .iter()
        .find(|point| point.key == "FAILED")
        .map(|point| point.value)
        .unwrap_or(0);
    let connection_issues = connection_mix
        .iter()
        .filter(|point| {
            matches!(
                point.key.as_str(),
                "NEEDS_ATTENTION" | "DISCONNECTED" | "REVOKED"
            )
        })
        .map(|point| point.value)
        .sum();
    let connections = connection_mix.iter().map(|point| point.value).sum();
    let delivery_denominator = delivered_messages + failed_messages;

    Ok(HttpResponse::Ok().json(AdminUsageResponse {
        range: OverviewRange {
            start: range_start,
            end: range_end,
            days,
            interval: "day",
        },
        timezone: "UTC",
        source: "core_authoritative",
        data_as_of,
        coverage: vec![
            CoveragePoint {
                key: "usage_events",
                label: "Product usage events",
                status: "available",
                detail: "Transactional Core usage records",
            },
            CoveragePoint {
                key: "messaging",
                label: "Conversations and messages",
                status: "available",
                detail: "Core conversation and message records",
            },
            CoveragePoint {
                key: "campaign_delivery",
                label: "Campaign delivery",
                status: "available",
                detail: "WhatsApp send-event records",
            },
            CoveragePoint {
                key: "agent_runs",
                label: "Agent runs and model cost",
                status: "unavailable",
                detail: "Agent Platform reporting scope is not connected to this boundary",
            },
            CoveragePoint {
                key: "social_insights",
                label: "Social reach and engagement",
                status: "unavailable",
                detail: "Provider insight coverage is not a Core transactional metric",
            },
        ],
        kpis: UsageKpis {
            operations,
            conversations,
            messages,
            calls,
            campaign_sends,
            delivered_messages,
            failed_messages,
            delivery_rate: if delivery_denominator == 0 {
                0.0
            } else {
                (delivered_messages as f64 / delivery_denominator as f64) * 100.0
            },
            connections,
            connection_issues,
            credits_consumed,
        },
        daily,
        product_mix,
        metric_mix,
        channel_mix,
        campaign_funnel,
        connection_mix,
        credit_lifecycle,
    }))
}

async fn load_usage_daily(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<UsageDailyPoint>, AppError> {
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), usage AS (
          SELECT ("occurredAt" AT TIME ZONE 'UTC')::date AS date, COALESCE(SUM("quantity"), 0)::BIGINT AS operations
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
        ), conversations AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS conversations
          FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), messages AS (
          SELECT (message."timestamp" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS messages
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2 GROUP BY 1
        ), calls AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS calls
          FROM "CommunicationCall" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), sends AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS campaign_sends
          FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), credits AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS credits_consumed
          FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(usage.operations, 0)::BIGINT AS operations,
          COALESCE(conversations.conversations, 0)::BIGINT AS conversations,
          COALESCE(messages.messages, 0)::BIGINT AS messages,
          COALESCE(calls.calls, 0)::BIGINT AS calls,
          COALESCE(sends.campaign_sends, 0)::BIGINT AS campaign_sends,
          COALESCE(credits.credits_consumed, 0)::BIGINT AS credits_consumed
        FROM days
        LEFT JOIN usage ON usage.date = days.date
        LEFT JOIN conversations ON conversations.date = days.date
        LEFT JOIN messages ON messages.date = days.date
        LEFT JOIN calls ON calls.date = days.date
        LEFT JOIN sends ON sends.date = days.date
        LEFT JOIN credits ON credits.date = days.date
        ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            Ok(UsageDailyPoint {
                date: row.try_get("date")?,
                operations: row.try_get("operations")?,
                conversations: row.try_get("conversations")?,
                messages: row.try_get("messages")?,
                calls: row.try_get("calls")?,
                campaign_sends: row.try_get("campaign_sends")?,
                credits_consumed: row.try_get("credits_consumed")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_usage_product_mix(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    load_usage_breakdown(
        pool,
        r#"SELECT "productKey" AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey" ORDER BY value DESC, key LIMIT 16"#,
        start,
        end,
        true,
    )
    .await
}

async fn load_usage_metric_mix(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    load_usage_breakdown(
        pool,
        r#"SELECT CONCAT("productKey", ':', "metricKey") AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey", "metricKey" ORDER BY value DESC, key LIMIT 16"#,
        start,
        end,
        false,
    )
    .await
}

async fn load_usage_channel_mix(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    load_usage_breakdown(
        pool,
        r#"SELECT channel AS key, COUNT(*)::BIGINT AS value FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY channel ORDER BY value DESC, key"#,
        start,
        end,
        true,
    )
    .await
}

async fn load_usage_breakdown(
    pool: &PgPool,
    sql: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    humanize: bool,
) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(sql)
        .bind(start.naive_utc())
        .bind(end.naive_utc())
        .fetch_all(pool)
        .await?;
    rows.into_iter()
        .map(|row| {
            let key: String = row.try_get("key")?;
            Ok(BreakdownPoint {
                label: if humanize {
                    humanize_key(&key)
                } else {
                    key.clone()
                },
                key,
                value: row.try_get("value")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_campaign_funnel(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(
        r#"SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "WhatsappSendEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY "status" ORDER BY value DESC, key"#,
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

async fn load_connection_mix(pool: &PgPool) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(
        r#"SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "ExternalConnection" GROUP BY "status" ORDER BY value DESC, key"#,
    )
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

async fn load_credit_lifecycle(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<CreditLifecyclePoint>, AppError> {
    let rows = sqlx::query(
        r#"SELECT "type" AS kind, COALESCE(SUM("amount"), 0)::BIGINT AS amount FROM "CreditLedgerEntry" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY "type" ORDER BY kind"#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(CreditLifecyclePoint {
                kind: row.try_get("kind")?,
                amount: row.try_get("amount")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminRevenueResponse {
    range: OverviewRange,
    timezone: &'static str,
    source: &'static str,
    data_as_of: DateTime<Utc>,
    coverage: Vec<CoveragePoint>,
    kpis: RevenueKpis,
    daily: Vec<RevenueDailyPoint>,
    plan_mix: Vec<PlanMixPoint>,
    payment_outcomes: Vec<BreakdownPoint>,
    invoice_status: Vec<BreakdownPoint>,
    subscription_status: Vec<BreakdownPoint>,
    credit_lifecycle: Vec<CreditLifecyclePoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevenueKpis {
    collected_revenue_minor: i64,
    refunds_minor: i64,
    monthly_recurring_revenue_minor: i64,
    paid_invoices: i64,
    failed_payments: i64,
    active_subscriptions: i64,
    trials: i64,
    past_due_subscriptions: i64,
    new_subscriptions: i64,
    cancellations: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevenueDailyPoint {
    date: NaiveDate,
    collected_revenue_minor: i64,
    refunds_minor: i64,
    paid_invoices: i64,
    failed_payments: i64,
    new_subscriptions: i64,
    cancellations: i64,
}

pub async fn revenue(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<OverviewQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    let data_as_of = Utc::now();
    let (range_start, range_end, days) = report_window(query.days)?;
    let daily = load_revenue_daily(pool.get_ref(), range_start, range_end).await?;
    let plan_mix = load_plan_mix(pool.get_ref()).await?;
    let payment_outcomes = load_status_breakdown(
        pool.get_ref(),
        r#"SELECT "status" AS key, COUNT(*)::BIGINT AS value FROM "BillingCheckout" WHERE "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY "status" ORDER BY value DESC, key"#,
        range_start,
        range_end,
    )
    .await?;
    let invoice_status = load_status_breakdown(
        pool.get_ref(),
        r#"SELECT "status" AS key, COUNT(*)::BIGINT AS value FROM "BillingInvoice" WHERE "issuedAt" >= $1 AND "issuedAt" < $2 GROUP BY "status" ORDER BY value DESC, key"#,
        range_start,
        range_end,
    )
    .await?;
    let subscription_status = load_current_status_breakdown(
        pool.get_ref(),
        r#"SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "OrganizationSubscription" GROUP BY "status" ORDER BY value DESC, key"#,
    )
    .await?;
    let credit_lifecycle = load_credit_lifecycle(pool.get_ref(), range_start, range_end).await?;

    let collected_revenue_minor = daily
        .iter()
        .map(|point| point.collected_revenue_minor)
        .sum();
    let refunds_minor = daily.iter().map(|point| point.refunds_minor).sum();
    let paid_invoices = daily.iter().map(|point| point.paid_invoices).sum();
    let failed_payments = daily.iter().map(|point| point.failed_payments).sum();
    let new_subscriptions = daily.iter().map(|point| point.new_subscriptions).sum();
    let cancellations = daily.iter().map(|point| point.cancellations).sum();
    let active_subscriptions = subscription_status
        .iter()
        .filter(|point| matches!(point.key.as_str(), "ACTIVE" | "PAST_DUE" | "GRACE"))
        .map(|point| point.value)
        .sum();
    let trials = subscription_status
        .iter()
        .find(|point| point.key == "TRIAL")
        .map(|point| point.value)
        .unwrap_or(0);
    let past_due_subscriptions = subscription_status
        .iter()
        .find(|point| point.key == "PAST_DUE")
        .map(|point| point.value)
        .unwrap_or(0);

    Ok(HttpResponse::Ok().json(AdminRevenueResponse {
        range: OverviewRange {
            start: range_start,
            end: range_end,
            days,
            interval: "day",
        },
        timezone: "UTC",
        source: "core_authoritative",
        data_as_of,
        coverage: vec![
            CoveragePoint {
                key: "invoices",
                label: "Invoices and collections",
                status: "available",
                detail: "Core invoice records with provider references",
            },
            CoveragePoint {
                key: "subscriptions",
                label: "Subscriptions",
                status: "available",
                detail: "Core subscription state and plan catalog",
            },
            CoveragePoint {
                key: "payments",
                label: "Paystack checkout outcomes",
                status: "available",
                detail: "Core checkout and webhook reconciliation records",
            },
            CoveragePoint {
                key: "refunds",
                label: "Refunds",
                status: "partial",
                detail: "Refunded invoice statuses; provider-level net settlement is not stored",
            },
            CoveragePoint {
                key: "credits",
                label: "Credit lifecycle",
                status: "available",
                detail: "Core credit ledger records",
            },
        ],
        kpis: RevenueKpis {
            collected_revenue_minor,
            refunds_minor,
            monthly_recurring_revenue_minor: scalar_sum(
                pool.get_ref(),
                r#"SELECT COALESCE(SUM(CASE WHEN plan.interval = 'YEARLY' THEN COALESCE(plan."amountMinor", 0) / 12 ELSE COALESCE(plan."amountMinor", 0) END), 0)::BIGINT FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')"#,
            )
            .await?,
            paid_invoices,
            failed_payments,
            active_subscriptions,
            trials,
            past_due_subscriptions,
            new_subscriptions,
            cancellations,
        },
        daily,
        plan_mix,
        payment_outcomes,
        invoice_status,
        subscription_status,
        credit_lifecycle,
    }))
}

async fn load_revenue_daily(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<RevenueDailyPoint>, AppError> {
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), invoices AS (
          SELECT (COALESCE("paidAt", "issuedAt") AT TIME ZONE 'UTC')::date AS date,
            COALESCE(SUM(CASE WHEN "status" = 'PAID' THEN COALESCE("amountMinor", 0) ELSE 0 END), 0)::BIGINT AS collected_revenue_minor,
            COALESCE(SUM(CASE WHEN "status" IN ('REFUNDED', 'PARTIALLY_REFUNDED') THEN COALESCE("amountMinor", 0) ELSE 0 END), 0)::BIGINT AS refunds_minor,
            COUNT(*) FILTER (WHERE "status" = 'PAID')::BIGINT AS paid_invoices
          FROM "BillingInvoice"
          WHERE ("paidAt" >= $1 AND "paidAt" < $2) OR ("issuedAt" >= $1 AND "issuedAt" < $2)
          GROUP BY 1
        ), checkouts AS (
          SELECT ("updatedAt" AT TIME ZONE 'UTC')::date AS date,
            COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'ABANDONED'))::BIGINT AS failed_payments
          FROM "BillingCheckout" WHERE "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        ), subscriptions AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS new_subscriptions
          FROM "OrganizationSubscription" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), cancellations AS (
          SELECT ("cancelledAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS cancellations
          FROM "OrganizationSubscription" WHERE "cancelledAt" IS NOT NULL AND "cancelledAt" >= $1 AND "cancelledAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(invoices.collected_revenue_minor, 0)::BIGINT AS collected_revenue_minor,
          COALESCE(invoices.refunds_minor, 0)::BIGINT AS refunds_minor,
          COALESCE(invoices.paid_invoices, 0)::BIGINT AS paid_invoices,
          COALESCE(checkouts.failed_payments, 0)::BIGINT AS failed_payments,
          COALESCE(subscriptions.new_subscriptions, 0)::BIGINT AS new_subscriptions,
          COALESCE(cancellations.cancellations, 0)::BIGINT AS cancellations
        FROM days LEFT JOIN invoices ON invoices.date = days.date
        LEFT JOIN checkouts ON checkouts.date = days.date
        LEFT JOIN subscriptions ON subscriptions.date = days.date
        LEFT JOIN cancellations ON cancellations.date = days.date
        ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(RevenueDailyPoint {
                date: row.try_get("date")?,
                collected_revenue_minor: row.try_get("collected_revenue_minor")?,
                refunds_minor: row.try_get("refunds_minor")?,
                paid_invoices: row.try_get("paid_invoices")?,
                failed_payments: row.try_get("failed_payments")?,
                new_subscriptions: row.try_get("new_subscriptions")?,
                cancellations: row.try_get("cancellations")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_status_breakdown(
    pool: &PgPool,
    sql: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(sql)
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

async fn load_current_status_breakdown(
    pool: &PgPool,
    sql: &str,
) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(sql).fetch_all(pool).await?;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminCustomersResponse {
    range: OverviewRange,
    timezone: &'static str,
    source: &'static str,
    data_as_of: DateTime<Utc>,
    coverage: Vec<CoveragePoint>,
    kpis: CustomerKpis,
    daily: Vec<CustomerDailyPoint>,
    funnel: Vec<BreakdownPoint>,
    plan_mix: Vec<BreakdownPoint>,
    top_organizations: Vec<OrganizationActivity>,
    inactive_organizations: Vec<OrganizationActivity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerKpis {
    total_organizations: i64,
    new_organizations: i64,
    active_organizations: i64,
    inactive_organizations: i64,
    activation_rate: f64,
    total_users: i64,
    active_users: i64,
    paying_organizations: i64,
    trial_organizations: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerDailyPoint {
    date: NaiveDate,
    new_organizations: i64,
    active_organizations: i64,
    new_users: i64,
    active_users: i64,
}

pub async fn customers(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<OverviewQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    let data_as_of = Utc::now();
    let (range_start, range_end, days) = report_window(query.days)?;
    let daily = load_customer_daily(pool.get_ref(), range_start, range_end).await?;
    let active_organizations =
        active_organizations_in_range(pool.get_ref(), range_start, range_end).await?;
    let total_organizations =
        scalar_count(pool.get_ref(), r#"SELECT COUNT(*) FROM "Organization""#).await?;
    let total_users = scalar_count(pool.get_ref(), r#"SELECT COUNT(*) FROM "User""#).await?;
    let new_organizations = daily.iter().map(|point| point.new_organizations).sum();
    let active_users = scalar_count_with_range(
        pool.get_ref(),
        r#"SELECT COUNT(DISTINCT owner_id) FROM (SELECT o."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2 UNION ALL SELECT o."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2 UNION ALL SELECT o."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2) activity"#,
        range_start,
        range_end,
    )
    .await?;
    let paying_organizations = scalar_count(
        pool.get_ref(),
        r#"SELECT COUNT(DISTINCT "orgId") FROM "OrganizationSubscription" WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')"#,
    )
    .await?;
    let trial_organizations = scalar_count(
        pool.get_ref(),
        r#"SELECT COUNT(DISTINCT "orgId") FROM "OrganizationSubscription" WHERE "status" = 'TRIAL'"#,
    )
    .await?;
    let top_organizations =
        load_customer_cohorts(pool.get_ref(), range_start, range_end, false).await?;
    let inactive_organizations =
        load_customer_cohorts(pool.get_ref(), range_start, range_end, true).await?;
    let plan_mix = load_customer_plan_mix(pool.get_ref()).await?;
    let activated = active_organizations;
    let inactive = (total_organizations - activated).max(0);

    Ok(HttpResponse::Ok().json(AdminCustomersResponse {
        range: OverviewRange {
            start: range_start,
            end: range_end,
            days,
            interval: "day",
        },
        timezone: "UTC",
        source: "core_authoritative",
        data_as_of,
        coverage: vec![
            CoveragePoint {
                key: "organization_lifecycle",
                label: "Organization lifecycle",
                status: "available",
                detail: "Organization and user creation records",
            },
            CoveragePoint {
                key: "activation",
                label: "Activation",
                status: "partial",
                detail: "Activated means at least one meaningful recorded product event in the selected period",
            },
            CoveragePoint {
                key: "customer_content",
                label: "Customer content analytics",
                status: "unavailable",
                detail: "Raw customer content is intentionally excluded from platform analytics",
            },
        ],
        kpis: CustomerKpis {
            total_organizations,
            new_organizations,
            active_organizations: activated,
            inactive_organizations: inactive,
            activation_rate: if total_organizations == 0 {
                0.0
            } else {
                (activated as f64 / total_organizations as f64) * 100.0
            },
            total_users,
            active_users,
            paying_organizations,
            trial_organizations,
        },
        daily,
        funnel: vec![
            BreakdownPoint { key: "organizations".to_string(), label: "Organizations".to_string(), value: total_organizations },
            BreakdownPoint { key: "activated".to_string(), label: "Activated".to_string(), value: activated },
            BreakdownPoint { key: "paying".to_string(), label: "Paying".to_string(), value: paying_organizations },
        ],
        plan_mix,
        top_organizations,
        inactive_organizations,
    }))
}

async fn active_organizations_in_range(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<i64, AppError> {
    scalar_count_with_range(
        pool,
        r#"SELECT COUNT(DISTINCT org_id) FROM (SELECT "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2) activity WHERE org_id IS NOT NULL"#,
        start,
        end,
    )
    .await
}

async fn load_customer_daily(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<CustomerDailyPoint>, AppError> {
    let rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), new_orgs AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS value FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), new_users AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS value FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), active_orgs AS (
          SELECT date, COUNT(DISTINCT org_id)::BIGINT AS value FROM (
            SELECT ("occurredAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          ) activity WHERE org_id IS NOT NULL GROUP BY date
        ), active_users AS (
          SELECT date, COUNT(DISTINCT owner_id)::BIGINT AS value FROM (
            SELECT (event."occurredAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2
            UNION ALL SELECT (event."createdAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2
            UNION ALL SELECT (event."createdAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2
          ) activity GROUP BY date
        )
        SELECT days.date, COALESCE(new_orgs.value, 0)::BIGINT AS new_organizations, COALESCE(active_orgs.value, 0)::BIGINT AS active_organizations, COALESCE(new_users.value, 0)::BIGINT AS new_users, COALESCE(active_users.value, 0)::BIGINT AS active_users
        FROM days LEFT JOIN new_orgs ON new_orgs.date = days.date LEFT JOIN active_orgs ON active_orgs.date = days.date LEFT JOIN new_users ON new_users.date = days.date LEFT JOIN active_users ON active_users.date = days.date ORDER BY days.date
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(CustomerDailyPoint {
                date: row.try_get("date")?,
                new_organizations: row.try_get("new_organizations")?,
                active_organizations: row.try_get("active_organizations")?,
                new_users: row.try_get("new_users")?,
                active_users: row.try_get("active_users")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_customer_plan_mix(pool: &PgPool) -> Result<Vec<BreakdownPoint>, AppError> {
    let rows = sqlx::query(
        r#"SELECT CONCAT(product.name, ' · ', plan.name) AS key, COUNT(DISTINCT subscription."orgId")::BIGINT AS value FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" JOIN "Product" product ON product.id = plan."productId" WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL') GROUP BY product.name, plan.name ORDER BY value DESC, key"#,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let key: String = row.try_get("key")?;
            Ok(BreakdownPoint {
                label: key.clone(),
                key,
                value: row.try_get("value")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

async fn load_customer_cohorts(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    inactive: bool,
) -> Result<Vec<OrganizationActivity>, AppError> {
    let order = if inactive {
        "operations ASC, active_days ASC, organization.name"
    } else {
        "operations DESC, active_days DESC, organization.name"
    };
    let sql = format!(
        r#"
        SELECT organization.id, organization.name, current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT (event."occurredAt" AT TIME ZONE 'UTC')::date)::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event ON event."orgId" = organization.id AND event."occurredAt" >= $1 AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id AND subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL') ORDER BY subscription."createdAt" DESC LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        {}
        ORDER BY {}
        LIMIT 10
        "#,
        if inactive {
            "HAVING COALESCE(SUM(event.quantity), 0) = 0"
        } else {
            "HAVING COALESCE(SUM(event.quantity), 0) > 0"
        },
        order,
    );
    let rows = sqlx::query(&sql)
        .bind(start.naive_utc())
        .bind(end.naive_utc())
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
