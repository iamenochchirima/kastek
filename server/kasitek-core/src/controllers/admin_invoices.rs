use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use cuid2::create_id;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};

use crate::{error::AppError, middleware::extract_admin};

#[derive(Debug, FromRow, Serialize, Clone)]
struct InvoiceRow {
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
    #[sqlx(rename = "billingMode")]
    billing_mode: String,
    #[sqlx(rename = "recurringActive")]
    recurring_active: bool,
    #[sqlx(rename = "billingAnchorDay")]
    billing_anchor_day: Option<i32>,
    #[sqlx(rename = "reminderDaysAfterDue")]
    reminder_days_after_due: i32,
    #[sqlx(rename = "lastSentAt")]
    last_sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastReminderAt")]
    last_reminder_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastPaidAt")]
    last_paid_at: Option<DateTime<Utc>>,
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

#[derive(Debug, FromRow, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InvoiceRunRow {
    id: String,
    #[sqlx(rename = "invoiceId")]
    invoice_id: String,
    #[sqlx(rename = "cycleKey")]
    cycle_key: String,
    #[sqlx(rename = "issueDate")]
    issue_date: DateTime<Utc>,
    #[sqlx(rename = "periodStart")]
    period_start: DateTime<Utc>,
    #[sqlx(rename = "periodEnd")]
    period_end: DateTime<Utc>,
    #[sqlx(rename = "dueDate")]
    due_date: DateTime<Utc>,
    status: String,
    #[sqlx(rename = "sendStatus")]
    send_status: String,
    #[sqlx(rename = "reminderStatus")]
    reminder_status: String,
    #[sqlx(rename = "sentAt")]
    sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "reminderDueAt")]
    reminder_due_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "reminderSentAt")]
    reminder_sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "paidAt")]
    paid_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "pricingItemsSnapshot")]
    pricing_items_snapshot: Value,
    #[sqlx(rename = "titleSnapshot")]
    title_snapshot: String,
    #[sqlx(rename = "contactEmailSnapshot")]
    contact_email_snapshot: String,
    #[sqlx(rename = "businessNameSnapshot")]
    business_name_snapshot: String,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceOperationsSummary {
    needs_invoice_send: bool,
    needs_reminder: bool,
    recurring_client: bool,
    cycle_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceActionItem {
    invoice_id: String,
    invoice_run_id: String,
    business_name: String,
    action_type: String,
    title: String,
    message: String,
    due_at: DateTime<Utc>,
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
    #[serde(rename = "billingMode")]
    billing_mode: Option<String>,
    #[serde(rename = "recurringActive")]
    recurring_active: Option<bool>,
    #[serde(rename = "billingAnchorDay")]
    billing_anchor_day: Option<serde_json::Value>,
    #[serde(rename = "reminderDaysAfterDue")]
    reminder_days_after_due: Option<serde_json::Value>,
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
    #[serde(rename = "billingMode")]
    billing_mode: Option<String>,
    #[serde(rename = "recurringActive")]
    recurring_active: Option<bool>,
    #[serde(rename = "billingAnchorDay")]
    billing_anchor_day: Option<serde_json::Value>,
    #[serde(rename = "reminderDaysAfterDue")]
    reminder_days_after_due: Option<serde_json::Value>,
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

#[derive(Debug, Deserialize)]
pub struct RunActionBody {
    action: String,
}

const SELECT_COLS: &str = r#"
    id, "businessName", "contactPerson", "contactEmail", "contactPhone",
    date AT TIME ZONE 'UTC' AS date, "serviceType", "billingMode", "recurringActive",
    "billingAnchorDay", "reminderDaysAfterDue",
    "lastSentAt" AT TIME ZONE 'UTC' AS "lastSentAt",
    "lastReminderAt" AT TIME ZONE 'UTC' AS "lastReminderAt",
    "lastPaidAt" AT TIME ZONE 'UTC' AS "lastPaidAt",
    title, introduction,
    "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
    "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
    "knowledgeBaseScope", "importantNotes", "supportIncludes",
    "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
    "quoteRequestId",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

const RUN_SELECT_COLS: &str = r#"
    id, "invoiceId", "cycleKey",
    "issueDate" AT TIME ZONE 'UTC' AS "issueDate",
    "periodStart" AT TIME ZONE 'UTC' AS "periodStart",
    "periodEnd" AT TIME ZONE 'UTC' AS "periodEnd",
    "dueDate" AT TIME ZONE 'UTC' AS "dueDate",
    status, "sendStatus", "reminderStatus",
    "sentAt" AT TIME ZONE 'UTC' AS "sentAt",
    "reminderDueAt" AT TIME ZONE 'UTC' AS "reminderDueAt",
    "reminderSentAt" AT TIME ZONE 'UTC' AS "reminderSentAt",
    "paidAt" AT TIME ZONE 'UTC' AS "paidAt",
    "pricingItemsSnapshot", "titleSnapshot", "contactEmailSnapshot", "businessNameSnapshot",
    "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
"#;

fn parse_date(s: &str) -> DateTime<Utc> {
    if let Ok(dt) = s.parse::<DateTime<Utc>>() {
        return dt;
    }
    if let Ok(dt) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return dt.and_hms_opt(0, 0, 0).unwrap().and_utc();
    }
    Utc::now()
}

fn parse_i32_value(v: &Option<serde_json::Value>, default: i32) -> i32 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(default as i64) as i32,
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn parse_validity_days(v: &Option<serde_json::Value>) -> i32 {
    parse_i32_value(v, 14).max(1)
}

fn parse_anchor_day(v: &Option<serde_json::Value>, fallback: i32) -> i32 {
    parse_i32_value(v, fallback).clamp(1, 31)
}

fn parse_reminder_days(v: &Option<serde_json::Value>) -> i32 {
    parse_i32_value(v, 3).clamp(0, 60)
}

fn invoice_is_recurring(invoice: &InvoiceRow) -> bool {
    invoice.billing_mode == "monthly" && invoice.recurring_active
}

fn utc_date(date: NaiveDate) -> DateTime<Utc> {
    date.and_hms_opt(0, 0, 0).unwrap().and_utc()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    for day in (28..=31).rev() {
        if NaiveDate::from_ymd_opt(year, month, day).is_some() {
            return day;
        }
    }
    28
}

fn month_anchor(year: i32, month: u32, anchor_day: i32) -> NaiveDate {
    let clamped_day = anchor_day.max(1) as u32;
    let day = clamped_day.min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap()
}

fn shift_month(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let zero_based = month as i32 - 1 + delta;
    let next_year = year + zero_based.div_euclid(12);
    let next_month = zero_based.rem_euclid(12) + 1;
    (next_year, next_month as u32)
}

fn current_cycle(anchor_day: i32, now: DateTime<Utc>) -> (NaiveDate, NaiveDate, String) {
    let today = now.date_naive();
    let this_month_anchor = month_anchor(today.year(), today.month(), anchor_day);
    let start = if today >= this_month_anchor {
        this_month_anchor
    } else {
        let (year, month) = shift_month(today.year(), today.month(), -1);
        month_anchor(year, month, anchor_day)
    };
    let (next_year, next_month) = shift_month(start.year(), start.month(), 1);
    let next_start = month_anchor(next_year, next_month, anchor_day);
    let end = next_start.pred_opt().unwrap();
    (start, end, start.format("%Y-%m-%d").to_string())
}

fn run_state(
    invoice: &InvoiceRow,
    run: &InvoiceRunRow,
    now: DateTime<Utc>,
) -> (String, String, Option<DateTime<Utc>>) {
    if run.paid_at.is_some() {
        return ("paid".to_string(), "sent".to_string(), run.reminder_due_at);
    }

    if run.sent_at.is_none() {
        return ("pending".to_string(), "not_needed".to_string(), None);
    }

    let reminder_due_at = Some(run.due_date + Duration::days(invoice.reminder_days_after_due as i64));

    if run.reminder_sent_at.is_some() {
        return ("reminder_sent".to_string(), "sent".to_string(), reminder_due_at);
    }

    if now >= run.due_date {
        if let Some(reminder_due) = reminder_due_at {
            if now >= reminder_due {
                return ("reminder_due".to_string(), "pending".to_string(), reminder_due_at);
            }
        }
        return ("overdue".to_string(), "not_needed".to_string(), reminder_due_at);
    }

    ("sent".to_string(), "not_needed".to_string(), reminder_due_at)
}

async fn list_admin_ids(pool: &PgPool) -> Result<Vec<String>, AppError> {
    sqlx::query_scalar::<_, String>(r#"SELECT id FROM "AdminUser""#)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

async fn publish_admin_notification(
    pool: &PgPool,
    title: &str,
    message: &str,
    entity_type: &str,
    entity_id: &str,
    payload: Value,
    dedupe_key: &str,
) -> Result<(), AppError> {
    let admin_ids = list_admin_ids(pool).await?;
    if admin_ids.is_empty() {
        return Ok(());
    }

    let existing = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "NotificationEvent"
        WHERE "scopeType" = 'ADMIN'::"NotificationScopeType"
          AND "scopeId" = 'global'
          AND "dedupeKey" = $1
        LIMIT 1
        "#,
    )
    .bind(dedupe_key)
    .fetch_optional(pool)
    .await?;

    if existing.is_some() {
        return Ok(());
    }

    let event_id = create_id();
    sqlx::query(
        r#"
        INSERT INTO "NotificationEvent" (
            id, "scopeType", "scopeId", "eventType", title, message, severity,
            "entityType", "entityId", payload, "dedupeKey", "createdAt"
        )
        VALUES (
            $1, 'ADMIN'::"NotificationScopeType", 'global', 'invoice.reminder_due', $2, $3,
            'WARNING'::"NotificationSeverity", $4, $5, $6, $7, NOW()
        )
        "#,
    )
    .bind(&event_id)
    .bind(title)
    .bind(message)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload)
    .bind(dedupe_key)
    .execute(pool)
    .await?;

    for admin_id in admin_ids {
        sqlx::query(
            r#"
            INSERT INTO "Notification" (
                id, "eventId", "recipientType", "recipientId", channel, status, "sentAt", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, 'ADMIN'::"NotificationRecipientType", $3,
                'IN_APP'::"NotificationChannel", 'SENT'::"NotificationStatus", NOW(), NOW(), NOW()
            )
            "#,
        )
        .bind(create_id())
        .bind(&event_id)
        .bind(admin_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

async fn fetch_invoice(pool: &PgPool, id: &str) -> Result<InvoiceRow, AppError> {
    sqlx::query_as::<_, InvoiceRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "Invoice" WHERE id = $1 LIMIT 1"#
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("invoice not found".to_string()))
}

async fn fetch_recent_runs(
    pool: &PgPool,
    invoice_id: &str,
    limit: i64,
) -> Result<Vec<InvoiceRunRow>, AppError> {
    sqlx::query_as::<_, InvoiceRunRow>(&format!(
        r#"
        SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE "invoiceId" = $1
        ORDER BY "issueDate" DESC
        LIMIT $2
        "#
    ))
    .bind(invoice_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn sync_current_run(
    pool: &PgPool,
    invoice: &InvoiceRow,
) -> Result<Option<InvoiceRunRow>, AppError> {
    if !invoice_is_recurring(invoice) {
        return Ok(None);
    }

    let anchor_day = invoice
        .billing_anchor_day
        .unwrap_or(invoice.date.day() as i32)
        .clamp(1, 31);
    let now = Utc::now();
    let (period_start, period_end, cycle_key) = current_cycle(anchor_day, now);
    let issue_date = utc_date(period_start);
    let due_date = issue_date + Duration::days(invoice.validity_days as i64);

    let mut run = sqlx::query_as::<_, InvoiceRunRow>(&format!(
        r#"
        SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE "invoiceId" = $1 AND "cycleKey" = $2
        LIMIT 1
        "#
    ))
    .bind(&invoice.id)
    .bind(&cycle_key)
    .fetch_optional(pool)
    .await?;

    if run.is_none() {
        let id = create_id();
        sqlx::query(
            r#"
            INSERT INTO "InvoiceRun" (
                id, "invoiceId", "cycleKey", "issueDate", "periodStart", "periodEnd",
                "dueDate", "status", "sendStatus", "reminderStatus", "pricingItemsSnapshot",
                "titleSnapshot", "contactEmailSnapshot", "businessNameSnapshot", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, 'pending', 'pending', 'not_needed', $8,
                $9, $10, $11, NOW(), NOW()
            )
            "#,
        )
        .bind(&id)
        .bind(&invoice.id)
        .bind(&cycle_key)
        .bind(issue_date)
        .bind(utc_date(period_start))
        .bind(utc_date(period_end))
        .bind(due_date)
        .bind(&invoice.pricing_items)
        .bind(&invoice.title)
        .bind(&invoice.contact_email)
        .bind(&invoice.business_name)
        .execute(pool)
        .await?;

        run = sqlx::query_as::<_, InvoiceRunRow>(&format!(
            r#"SELECT {RUN_SELECT_COLS} FROM "InvoiceRun" WHERE id = $1"#
        ))
        .bind(&id)
        .fetch_optional(pool)
        .await?;
    }

    let Some(run) = run else {
        return Ok(None);
    };

    let (status, reminder_status, reminder_due_at) = run_state(invoice, &run, now);
    let snapshot_changed = run.title_snapshot != invoice.title
        || run.contact_email_snapshot != invoice.contact_email
        || run.business_name_snapshot != invoice.business_name
        || run.pricing_items_snapshot != invoice.pricing_items;

    if status != run.status
        || reminder_status != run.reminder_status
        || reminder_due_at != run.reminder_due_at
        || snapshot_changed
    {
        sqlx::query(
            r#"
            UPDATE "InvoiceRun"
            SET
                status = $1,
                "reminderStatus" = $2,
                "reminderDueAt" = $3,
                "pricingItemsSnapshot" = $4,
                "titleSnapshot" = $5,
                "contactEmailSnapshot" = $6,
                "businessNameSnapshot" = $7,
                "updatedAt" = NOW()
            WHERE id = $8
            "#,
        )
        .bind(&status)
        .bind(&reminder_status)
        .bind(reminder_due_at)
        .bind(&invoice.pricing_items)
        .bind(&invoice.title)
        .bind(&invoice.contact_email)
        .bind(&invoice.business_name)
        .bind(&run.id)
        .execute(pool)
        .await?;
    }

    let run = sqlx::query_as::<_, InvoiceRunRow>(&format!(
        r#"SELECT {RUN_SELECT_COLS} FROM "InvoiceRun" WHERE id = $1"#
    ))
    .bind(&run.id)
    .fetch_one(pool)
    .await?;

    if run.reminder_status == "pending" {
        let _ = publish_admin_notification(
            pool,
            "Invoice reminder still needs to be sent",
            &format!(
                "{} is overdue and still needs a reminder email for billing cycle {}.",
                run.business_name_snapshot, run.cycle_key
            ),
            "invoice_run",
            &run.id,
            json!({
                "invoiceId": invoice.id,
                "invoiceRunId": run.id,
                "businessName": run.business_name_snapshot,
                "cycleKey": run.cycle_key,
                "dueDate": run.due_date,
            }),
            &format!("invoice-reminder-due-{}", run.id),
        )
        .await;
    }

    Ok(Some(run))
}

fn operations_summary(invoice: &InvoiceRow, current_run: Option<&InvoiceRunRow>) -> InvoiceOperationsSummary {
    InvoiceOperationsSummary {
        recurring_client: invoice_is_recurring(invoice),
        needs_invoice_send: current_run.is_some_and(|run| run.send_status == "pending" && Utc::now() >= run.issue_date),
        needs_reminder: current_run.is_some_and(|run| run.reminder_status == "pending"),
        cycle_label: current_run.map(|run| run.cycle_key.clone()),
    }
}

fn action_items_for_invoice(invoice: &InvoiceRow, current_run: Option<&InvoiceRunRow>) -> Vec<InvoiceActionItem> {
    let mut items = Vec::new();

    if let Some(run) = current_run {
        if run.send_status == "pending" && Utc::now() >= run.issue_date {
            items.push(InvoiceActionItem {
                invoice_id: invoice.id.clone(),
                invoice_run_id: run.id.clone(),
                business_name: invoice.business_name.clone(),
                action_type: "send_invoice".to_string(),
                title: "Monthly invoice still needs to be sent".to_string(),
                message: format!(
                    "{} is due for cycle {} and has not been marked sent yet.",
                    invoice.business_name, run.cycle_key
                ),
                due_at: run.issue_date,
            });
        }
        if run.reminder_status == "pending" {
            items.push(InvoiceActionItem {
                invoice_id: invoice.id.clone(),
                invoice_run_id: run.id.clone(),
                business_name: invoice.business_name.clone(),
                action_type: "send_reminder".to_string(),
                title: "Payment reminder email still needs to be sent".to_string(),
                message: format!(
                    "{} is overdue for cycle {} and no reminder has been marked sent yet.",
                    invoice.business_name, run.cycle_key
                ),
                due_at: run.reminder_due_at.unwrap_or(run.due_date),
            });
        }
    }

    items
}

async fn invoice_response(
    pool: &PgPool,
    mut invoice: InvoiceRow,
) -> Result<Value, AppError> {
    let current_run = sync_current_run(pool, &invoice).await?;

    if let Some(run) = &current_run {
        let next_status = match run.status.as_str() {
            "paid" => "paid",
            "reminder_due" | "overdue" | "reminder_sent" => "overdue",
            "sent" => "sent",
            _ => invoice.status.as_str(),
        };

        if next_status != invoice.status {
            sqlx::query(r#"UPDATE "Invoice" SET status = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(next_status)
                .bind(&invoice.id)
                .execute(pool)
                .await?;
            invoice.status = next_status.to_string();
        }
    }

    let recent_runs = fetch_recent_runs(pool, &invoice.id, 6).await?;
    let operations = operations_summary(&invoice, current_run.as_ref());

    Ok(json!({
        "id": invoice.id,
        "quoteRequestId": invoice.quote_request_id,
        "businessName": invoice.business_name,
        "contactPerson": invoice.contact_person,
        "contactEmail": invoice.contact_email,
        "contactPhone": invoice.contact_phone,
        "date": invoice.date,
        "serviceType": invoice.service_type,
        "billingMode": invoice.billing_mode,
        "recurringActive": invoice.recurring_active,
        "billingAnchorDay": invoice.billing_anchor_day,
        "reminderDaysAfterDue": invoice.reminder_days_after_due,
        "lastSentAt": invoice.last_sent_at,
        "lastReminderAt": invoice.last_reminder_at,
        "lastPaidAt": invoice.last_paid_at,
        "title": invoice.title,
        "introduction": invoice.introduction,
        "scopeOfWork": invoice.scope_of_work,
        "deliverables": invoice.deliverables,
        "implementationSteps": invoice.implementation_steps,
        "pricingItems": invoice.pricing_items,
        "maintenanceIncludes": invoice.maintenance_includes,
        "termsAndNotes": invoice.terms_and_notes,
        "includedFunctionality": invoice.included_functionality,
        "knowledgeBaseScope": invoice.knowledge_base_scope,
        "importantNotes": invoice.important_notes,
        "supportIncludes": invoice.support_includes,
        "setupFee": invoice.setup_fee,
        "monthlyFee": invoice.monthly_fee,
        "deliveryTimeline": invoice.delivery_timeline,
        "validityDays": invoice.validity_days,
        "status": invoice.status,
        "createdAt": invoice.created_at,
        "updatedAt": invoice.updated_at,
        "currentRun": current_run,
        "recentRuns": recent_runs,
        "operations": operations,
    }))
}

pub async fn list_invoices(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;

    let invoices = sqlx::query_as::<_, InvoiceRow>(&format!(
        r#"SELECT {SELECT_COLS} FROM "Invoice" ORDER BY "createdAt" DESC"#
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let mut list = Vec::new();
    let mut action_items = Vec::new();
    let mut recurring_clients = 0usize;
    let mut needs_send = 0usize;
    let mut needs_reminder = 0usize;

    for invoice in invoices {
        let current_run = sync_current_run(pool.get_ref(), &invoice).await?;
        let operations = operations_summary(&invoice, current_run.as_ref());
        if operations.recurring_client {
            recurring_clients += 1;
        }
        if operations.needs_invoice_send {
            needs_send += 1;
        }
        if operations.needs_reminder {
            needs_reminder += 1;
        }
        action_items.extend(action_items_for_invoice(&invoice, current_run.as_ref()));

        list.push(json!({
            "id": invoice.id,
            "businessName": invoice.business_name,
            "contactPerson": invoice.contact_person,
            "contactEmail": invoice.contact_email,
            "contactPhone": invoice.contact_phone,
            "serviceType": invoice.service_type,
            "billingMode": invoice.billing_mode,
            "recurringActive": invoice.recurring_active,
            "title": invoice.title,
            "status": invoice.status,
            "pricingItems": invoice.pricing_items,
            "createdAt": invoice.created_at,
            "updatedAt": invoice.updated_at,
            "currentRun": current_run,
            "operations": operations,
        }));
    }

    action_items.sort_by_key(|item| item.due_at);

    Ok(HttpResponse::Ok().json(json!({
        "summary": {
            "totalInvoices": list.len(),
            "recurringClients": recurring_clients,
            "needsInvoiceSend": needs_send,
            "needsReminder": needs_reminder,
        },
        "actionItems": action_items,
        "invoices": list,
    })))
}

pub async fn get_invoice(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();
    let invoice = fetch_invoice(pool.get_ref(), &id).await?;
    let payload = invoice_response(pool.get_ref(), invoice).await?;
    Ok(HttpResponse::Ok().json(payload))
}

pub async fn create_invoice(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = create_id();
    let now = Utc::now();
    let date = parse_date(&body.date);
    let validity_days = parse_validity_days(&body.validity_days);
    let empty = json!([]);
    let billing_mode = body
        .billing_mode
        .clone()
        .unwrap_or_else(|| "one_off".to_string());
    let recurring_active = body.recurring_active.unwrap_or(billing_mode == "monthly");
    let billing_anchor_day = if recurring_active {
        Some(parse_anchor_day(&body.billing_anchor_day, date.day() as i32))
    } else {
        None
    };
    let reminder_days_after_due = parse_reminder_days(&body.reminder_days_after_due);

    sqlx::query(
        r#"
        INSERT INTO "Invoice" (
            id, "businessName", "contactPerson", "contactEmail", "contactPhone",
            date, "serviceType", "billingMode", "recurringActive", "billingAnchorDay",
            "reminderDaysAfterDue", title, introduction,
            "scopeOfWork", deliverables, "implementationSteps", "pricingItems",
            "maintenanceIncludes", "termsAndNotes", "includedFunctionality",
            "knowledgeBaseScope", "importantNotes", "supportIncludes",
            "setupFee", "monthlyFee", "deliveryTimeline", "validityDays", status,
            "quoteRequestId", "createdAt", "updatedAt"
        )
        VALUES (
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,
            $14,$15,$16,$17,
            $18,$19,$20,
            $21,$22,$23,
            '','',NULL,$24,$25,
            $26,$27,$28
        )
    "#,
    )
    .bind(&id)
    .bind(&body.business_name)
    .bind(&body.contact_person)
    .bind(&body.contact_email)
    .bind(&body.contact_phone)
    .bind(date)
    .bind(body.service_type.as_deref().unwrap_or("website_agent"))
    .bind(&billing_mode)
    .bind(recurring_active)
    .bind(billing_anchor_day)
    .bind(reminder_days_after_due)
    .bind(&body.title)
    .bind(&body.introduction)
    .bind(body.scope_of_work.as_ref().unwrap_or(&empty))
    .bind(body.deliverables.as_ref().unwrap_or(&empty))
    .bind(body.implementation_steps.as_ref().unwrap_or(&empty))
    .bind(body.pricing_items.as_ref().unwrap_or(&empty))
    .bind(body.maintenance_includes.as_ref().unwrap_or(&empty))
    .bind(body.terms_and_notes.as_ref().unwrap_or(&empty))
    .bind(body.section_order.as_ref().unwrap_or(&empty))
    .bind(&empty)
    .bind(body.note_sections.as_ref().unwrap_or(&empty))
    .bind(&empty)
    .bind(validity_days)
    .bind(body.status.as_deref().unwrap_or("draft"))
    .bind(&body.quote_request_id)
    .bind(now)
    .bind(now)
    .execute(pool.get_ref())
    .await?;

    let invoice = fetch_invoice(pool.get_ref(), &id).await?;
    let payload = invoice_response(pool.get_ref(), invoice).await?;
    Ok(HttpResponse::Created().json(payload))
}

pub async fn update_invoice(
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

    if body.business_name.is_some() {
        push_set!(r#""businessName""#);
    }
    if body.contact_person.is_some() {
        push_set!(r#""contactPerson""#);
    }
    if body.contact_email.is_some() {
        push_set!(r#""contactEmail""#);
    }
    if body.contact_phone.is_some() {
        push_set!(r#""contactPhone""#);
    }
    if body.date.is_some() {
        push_set!("date");
    }
    if body.service_type.is_some() {
        push_set!(r#""serviceType""#);
    }
    if body.billing_mode.is_some() {
        push_set!(r#""billingMode""#);
    }
    if body.recurring_active.is_some() {
        push_set!(r#""recurringActive""#);
    }
    if body.billing_anchor_day.is_some() {
        push_set!(r#""billingAnchorDay""#);
    }
    if body.reminder_days_after_due.is_some() {
        push_set!(r#""reminderDaysAfterDue""#);
    }
    if body.title.is_some() {
        push_set!("title");
    }
    if body.introduction.is_some() {
        push_set!("introduction");
    }
    if body.scope_of_work.is_some() {
        push_set!(r#""scopeOfWork""#);
    }
    if body.deliverables.is_some() {
        push_set!("deliverables");
    }
    if body.implementation_steps.is_some() {
        push_set!(r#""implementationSteps""#);
    }
    if body.pricing_items.is_some() {
        push_set!(r#""pricingItems""#);
    }
    if body.maintenance_includes.is_some() {
        push_set!(r#""maintenanceIncludes""#);
    }
    if body.terms_and_notes.is_some() {
        push_set!(r#""termsAndNotes""#);
    }
    if body.section_order.is_some() {
        push_set!(r#""includedFunctionality""#);
    }
    if body.note_sections.is_some() {
        push_set!(r#""importantNotes""#);
    }
    if body.validity_days.is_some() {
        push_set!(r#""validityDays""#);
    }
    if body.status.is_some() {
        push_set!("status");
    }
    if body.quote_request_id.is_some() {
        push_set!(r#""quoteRequestId""#);
    }

    if sets.len() == 1 {
        return get_invoice(pool, req, web::Path::from(id)).await;
    }

    let existing = fetch_invoice(pool.get_ref(), &id).await?;
    let default_anchor = body
        .date
        .as_deref()
        .map(parse_date)
        .unwrap_or(existing.date)
        .day() as i32;

    let where_idx = idx;
    let sql = format!(
        r#"UPDATE "Invoice" SET {} WHERE id = ${} RETURNING {SELECT_COLS}"#,
        sets.join(", "),
        where_idx
    );

    let mut q = sqlx::query_as::<_, InvoiceRow>(&sql).bind(now);
    if let Some(v) = &body.business_name {
        q = q.bind(v);
    }
    if let Some(v) = &body.contact_person {
        q = q.bind(v);
    }
    if let Some(v) = &body.contact_email {
        q = q.bind(v);
    }
    if let Some(v) = &body.contact_phone {
        q = q.bind(v);
    }
    if let Some(v) = &body.date {
        q = q.bind(parse_date(v));
    }
    if let Some(v) = &body.service_type {
        q = q.bind(v);
    }
    if let Some(v) = &body.billing_mode {
        q = q.bind(v);
    }
    if let Some(v) = body.recurring_active {
        q = q.bind(v);
    }
    if body.billing_anchor_day.is_some() {
        let next_anchor = if body.recurring_active == Some(false) {
            None
        } else {
            Some(parse_anchor_day(&body.billing_anchor_day, default_anchor))
        };
        q = q.bind(next_anchor);
    }
    if body.reminder_days_after_due.is_some() {
        q = q.bind(parse_reminder_days(&body.reminder_days_after_due));
    }
    if let Some(v) = &body.title {
        q = q.bind(v);
    }
    if body.introduction.is_some() {
        q = q.bind(body.introduction.as_deref());
    }
    if let Some(v) = &body.scope_of_work {
        q = q.bind(v);
    }
    if let Some(v) = &body.deliverables {
        q = q.bind(v);
    }
    if let Some(v) = &body.implementation_steps {
        q = q.bind(v);
    }
    if let Some(v) = &body.pricing_items {
        q = q.bind(v);
    }
    if let Some(v) = &body.maintenance_includes {
        q = q.bind(v);
    }
    if let Some(v) = &body.terms_and_notes {
        q = q.bind(v);
    }
    if let Some(v) = &body.section_order {
        q = q.bind(v);
    }
    if let Some(v) = &body.note_sections {
        q = q.bind(v);
    }
    if body.validity_days.is_some() {
        q = q.bind(parse_validity_days(&body.validity_days));
    }
    if let Some(v) = &body.status {
        q = q.bind(v);
    }
    if let Some(v) = &body.quote_request_id {
        let id_val: Option<String> = match v {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        q = q.bind(id_val);
    }
    q = q.bind(&id);

    let invoice = q
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("invoice not found".to_string()))?;

    let payload = invoice_response(pool.get_ref(), invoice).await?;
    Ok(HttpResponse::Ok().json(payload))
}

pub async fn invoice_run_action(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<RunActionBody>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let (invoice_id, run_id) = path.into_inner();
    let invoice = fetch_invoice(pool.get_ref(), &invoice_id).await?;

    let run = sqlx::query_as::<_, InvoiceRunRow>(&format!(
        r#"
        SELECT {RUN_SELECT_COLS}
        FROM "InvoiceRun"
        WHERE id = $1 AND "invoiceId" = $2
        LIMIT 1
        "#
    ))
    .bind(&run_id)
    .bind(&invoice_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("invoice run not found".to_string()))?;

    let now = Utc::now();
    match body.action.as_str() {
        "mark_sent" => {
            let reminder_due_at =
                run.due_date + Duration::days(invoice.reminder_days_after_due as i64);
            sqlx::query(
                r#"
                UPDATE "InvoiceRun"
                SET
                    "sentAt" = COALESCE("sentAt", $1),
                    status = CASE
                        WHEN "paidAt" IS NOT NULL THEN 'paid'
                        WHEN $2 >= "dueDate" THEN 'overdue'
                        ELSE 'sent'
                    END,
                    "sendStatus" = 'sent',
                    "reminderDueAt" = $3,
                    "updatedAt" = NOW()
                WHERE id = $4
                "#,
            )
            .bind(now)
            .bind(now)
            .bind(reminder_due_at)
            .bind(&run_id)
            .execute(pool.get_ref())
            .await?;

            sqlx::query(
                r#"
                UPDATE "Invoice"
                SET status = 'sent', "lastSentAt" = $1, "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(now)
            .bind(&invoice_id)
            .execute(pool.get_ref())
            .await?;
        }
        "mark_reminder_sent" => {
            sqlx::query(
                r#"
                UPDATE "InvoiceRun"
                SET
                    "reminderSentAt" = COALESCE("reminderSentAt", $1),
                    "reminderStatus" = 'sent',
                    status = CASE WHEN "paidAt" IS NOT NULL THEN 'paid' ELSE 'reminder_sent' END,
                    "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(now)
            .bind(&run_id)
            .execute(pool.get_ref())
            .await?;

            sqlx::query(
                r#"
                UPDATE "Invoice"
                SET status = 'overdue', "lastReminderAt" = $1, "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(now)
            .bind(&invoice_id)
            .execute(pool.get_ref())
            .await?;
        }
        "mark_paid" => {
            sqlx::query(
                r#"
                UPDATE "InvoiceRun"
                SET
                    "paidAt" = COALESCE("paidAt", $1),
                    status = 'paid',
                    "sendStatus" = CASE WHEN "sentAt" IS NULL THEN 'pending' ELSE 'sent' END,
                    "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(now)
            .bind(&run_id)
            .execute(pool.get_ref())
            .await?;

            sqlx::query(
                r#"
                UPDATE "Invoice"
                SET status = 'paid', "lastPaidAt" = $1, "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(now)
            .bind(&invoice_id)
            .execute(pool.get_ref())
            .await?;
        }
        "reopen_cycle" => {
            sqlx::query(
                r#"
                UPDATE "InvoiceRun"
                SET
                    "sentAt" = NULL,
                    "reminderDueAt" = NULL,
                    "reminderSentAt" = NULL,
                    "paidAt" = NULL,
                    status = 'pending',
                    "sendStatus" = 'pending',
                    "reminderStatus" = 'not_needed',
                    "updatedAt" = NOW()
                WHERE id = $1
                "#,
            )
            .bind(&run_id)
            .execute(pool.get_ref())
            .await?;

            sqlx::query(r#"UPDATE "Invoice" SET status = 'draft', "updatedAt" = NOW() WHERE id = $1"#)
                .bind(&invoice_id)
                .execute(pool.get_ref())
                .await?;
        }
        _ => {
            return Err(AppError::BadRequest("unsupported invoice action".to_string()));
        }
    }

    let invoice = fetch_invoice(pool.get_ref(), &invoice_id).await?;
    let payload = invoice_response(pool.get_ref(), invoice).await?;
    Ok(HttpResponse::Ok().json(payload))
}

pub async fn delete_invoice(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let _admin = extract_admin(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let deleted =
        sqlx::query_scalar::<_, String>(r#"DELETE FROM "Invoice" WHERE id = $1 RETURNING id"#)
            .bind(&id)
            .fetch_optional(pool.get_ref())
            .await?;

    if deleted.is_none() {
        return Err(AppError::NotFound("invoice not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(json!({ "deleted": true })))
}
