use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sqlx::{FromRow, PgPool};
use std::{collections::HashMap, env};

use crate::error::AppError;
use crate::services::billing_provider::{
    BillingProvider, CheckoutRequest, ProviderEvent, ProviderSubscriptionState,
};
use crate::services::credits;
use crate::services::referrals::{self, ReferralRewardConfig};

pub mod capabilities {
    pub const AGENTS_MANAGE: &str = "feature.agents.manage";
    pub const CAMPAIGNS_MANAGE: &str = "feature.campaigns.manage";
    pub const CAMPAIGNS_SEND: &str = "feature.campaigns.send";
    pub const BOOKINGS_ACCESS: &str = "feature.bookings.access";
    pub const CONTACTS_ACCESS: &str = "feature.contacts.access";
    pub const CONTENT_MANAGE: &str = "feature.content.manage";
    pub const CONTENT_PUBLISH: &str = "feature.content.publish";
    pub const ANALYTICS_VIEW: &str = "feature.analytics.view";
    pub const INBOX_ACCESS: &str = "feature.inbox.access";
    pub const TEMPLATES_MANAGE: &str = "feature.templates.manage";
}

pub mod meters {
    pub const AGENT_DEPLOYMENTS: &str = "agent_deployments";
    pub const CAMPAIGN_RECIPIENTS: &str = "campaign_recipients";
    pub const SOCIAL_PUBLISHES: &str = "social_publishes";
    pub const PUBLIC_API_REQUESTS: &str = "public_api_requests";
}

struct CapabilityDefinition {
    key: &'static str,
    name: &'static str,
    description: &'static str,
    legacy_entitlement: &'static str,
}

const CAPABILITY_DEFINITIONS: &[CapabilityDefinition] = &[
    CapabilityDefinition {
        key: capabilities::AGENTS_MANAGE,
        name: "AI agents",
        description: "Create, configure, and deploy workspace agents.",
        legacy_entitlement: "product.agents.enabled",
    },
    CapabilityDefinition {
        key: capabilities::CAMPAIGNS_MANAGE,
        name: "Campaigns",
        description: "Create and manage customer messaging campaigns.",
        legacy_entitlement: "product.reach.enabled",
    },
    CapabilityDefinition {
        key: capabilities::CAMPAIGNS_SEND,
        name: "Campaign sending",
        description: "Launch campaigns and send messages to campaign recipients.",
        legacy_entitlement: "product.reach.enabled",
    },
    CapabilityDefinition {
        key: capabilities::BOOKINGS_ACCESS,
        name: "Bookings",
        description: "Manage workspace booking services and appointments.",
        legacy_entitlement: "product.bookings.enabled",
    },
    CapabilityDefinition {
        key: capabilities::TEMPLATES_MANAGE,
        name: "Message templates",
        description: "Create and manage reusable provider message templates.",
        legacy_entitlement: "product.reach.enabled",
    },
    CapabilityDefinition {
        key: capabilities::CONTACTS_ACCESS,
        name: "Contacts",
        description: "Access and manage workspace customer records.",
        legacy_entitlement: "product.crm.enabled",
    },
    CapabilityDefinition {
        key: capabilities::CONTENT_MANAGE,
        name: "Content workspace",
        description: "Plan, create, schedule, and manage multi-platform content.",
        legacy_entitlement: "product.social.enabled",
    },
    CapabilityDefinition {
        key: capabilities::CONTENT_PUBLISH,
        name: "Content publishing",
        description: "Publish approved content to connected social accounts.",
        legacy_entitlement: "product.social.enabled",
    },
    CapabilityDefinition {
        key: capabilities::ANALYTICS_VIEW,
        name: "Analytics",
        description: "View workspace, campaign, and connected-channel analytics.",
        legacy_entitlement: "product.social.enabled",
    },
    CapabilityDefinition {
        key: capabilities::INBOX_ACCESS,
        name: "Shared inbox",
        description: "Access connected customer conversations in one inbox.",
        legacy_entitlement: "product.inbox.enabled",
    },
];

struct MeterDefinition {
    key: &'static str,
    name: &'static str,
    description: &'static str,
}

const METER_DEFINITIONS: &[MeterDefinition] = &[
    MeterDefinition {
        key: meters::AGENT_DEPLOYMENTS,
        name: "Agent deployments",
        description: "Agent deployment operations during the current month.",
    },
    MeterDefinition {
        key: meters::CAMPAIGN_RECIPIENTS,
        name: "Campaign recipients",
        description: "Recipients processed by campaigns during the current month.",
    },
    MeterDefinition {
        key: meters::SOCIAL_PUBLISHES,
        name: "Published content",
        description: "Social publishing operations during the current month.",
    },
    MeterDefinition {
        key: meters::PUBLIC_API_REQUESTS,
        name: "Public API requests",
        description: "Authenticated public API requests during the current month.",
    },
];

#[derive(Debug, FromRow)]
struct ProductRow {
    key: String,
    name: String,
    description: Option<String>,
}

#[derive(Debug, FromRow)]
struct EntitlementRow {
    key: String,
    value: Value,
}

#[derive(Debug, FromRow)]
struct SubscriptionRow {
    id: String,
    #[sqlx(rename = "productKey")]
    product_key: String,
    #[sqlx(rename = "planName")]
    plan_name: String,
    status: String,
    #[sqlx(rename = "currentPeriodStart")]
    current_period_start: Option<DateTime<Utc>>,
    #[sqlx(rename = "currentPeriodEnd")]
    current_period_end: Option<DateTime<Utc>>,
    #[sqlx(rename = "trialEndsAt")]
    trial_ends_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "cancelAtPeriodEnd")]
    cancel_at_period_end: bool,
}

#[derive(Debug, FromRow)]
struct UsageRow {
    #[sqlx(rename = "productKey")]
    product_key: String,
    #[sqlx(rename = "metricKey")]
    metric_key: String,
    quantity: i64,
}

#[derive(Debug, Serialize)]
pub struct ProductAccess {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "hasAccess")]
    pub has_access: bool,
    pub state: String,
    #[serde(rename = "planName")]
    pub plan_name: Option<String>,
    #[serde(rename = "subscriptionStatus")]
    pub subscription_status: Option<String>,
    #[serde(rename = "subscriptionId")]
    pub subscription_id: Option<String>,
    #[serde(rename = "currentPeriodStart")]
    pub current_period_start: Option<DateTime<Utc>>,
    #[serde(rename = "currentPeriodEnd")]
    pub current_period_end: Option<DateTime<Utc>>,
    #[serde(rename = "trialEndsAt")]
    pub trial_ends_at: Option<DateTime<Utc>>,
    #[serde(rename = "cancelAtPeriodEnd")]
    pub cancel_at_period_end: bool,
    pub usage: HashMap<String, i64>,
    pub limits: HashMap<String, i64>,
}

#[derive(Debug, Serialize)]
pub struct CapabilityAccess {
    pub key: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct MeterUsage {
    pub key: String,
    pub name: String,
    pub description: String,
    pub used: i64,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DailyCreditUsage {
    pub date: NaiveDate,
    #[serde(rename = "creditsUsed")]
    pub credits_used: i64,
    pub operations: i64,
}

#[derive(Debug, Serialize)]
pub struct CreditUsageBreakdown {
    pub key: String,
    #[serde(rename = "creditsUsed")]
    pub credits_used: i64,
    pub operations: i64,
}

#[derive(Debug, Serialize)]
pub struct BillingUsage {
    #[serde(rename = "rangeStart")]
    pub range_start: DateTime<Utc>,
    #[serde(rename = "rangeEnd")]
    pub range_end: DateTime<Utc>,
    pub timezone: String,
    pub granularity: String,
    pub daily: Vec<DailyCreditUsage>,
    #[serde(rename = "previousDaily")]
    pub previous_daily: Vec<DailyCreditUsage>,
    #[serde(rename = "creditsUsed")]
    pub credits_used: i64,
    pub operations: i64,
    pub breakdown: Vec<CreditUsageBreakdown>,
}

#[derive(Debug, FromRow)]
struct DailyCreditUsageRow {
    date: NaiveDate,
    #[sqlx(rename = "credits_used")]
    credits_used: i64,
}

#[derive(Debug, FromRow)]
struct DailyMeterUsageRow {
    date: NaiveDate,
    operations: i64,
}

#[derive(Debug, FromRow)]
struct CreditUsageBreakdownRow {
    #[sqlx(rename = "action_key")]
    action_key: String,
    #[sqlx(rename = "credits_used")]
    credits_used: i64,
    operations: i64,
}

fn build_daily_usage(
    first_day: NaiveDate,
    days: i64,
    credit_rows: Vec<DailyCreditUsageRow>,
    meter_rows: Vec<DailyMeterUsageRow>,
) -> Vec<DailyCreditUsage> {
    let credits_by_date = credit_rows
        .into_iter()
        .map(|row| (row.date, row))
        .collect::<HashMap<_, _>>();
    let meters_by_date = meter_rows
        .into_iter()
        .map(|row| (row.date, row))
        .collect::<HashMap<_, _>>();
    (0..days)
        .map(|offset| {
            let date = first_day + Duration::days(offset);
            let credit_day = credits_by_date.get(&date);
            let meter_day = meters_by_date.get(&date);
            DailyCreditUsage {
                date,
                credits_used: credit_day.map(|row| row.credits_used).unwrap_or_default(),
                operations: meter_day.map(|row| row.operations).unwrap_or_default(),
            }
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct BillingSummary {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub features: Vec<CapabilityAccess>,
    pub meters: Vec<MeterUsage>,
    // Kept temporarily for checkout and subscription-management compatibility.
    // Runtime authorization must use `features`, never this product catalog.
    pub products: Vec<ProductAccess>,
    #[serde(rename = "manualGrants")]
    pub manual_grants: Vec<ManualGrant>,
    pub payments: Vec<PaymentHistoryItem>,
    pub invoices: Vec<BillingInvoiceItem>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PaymentHistoryItem {
    pub reference: String,
    #[serde(rename = "productName")]
    #[sqlx(rename = "product_name")]
    pub product_name: String,
    #[serde(rename = "planName")]
    #[sqlx(rename = "plan_name")]
    pub plan_name: String,
    pub status: String,
    pub currency: String,
    #[serde(rename = "amountMinor")]
    #[sqlx(rename = "amount_minor")]
    pub amount_minor: Option<i32>,
    #[serde(rename = "completedAt")]
    #[sqlx(rename = "completed_at")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct BillingInvoiceItem {
    #[serde(rename = "invoiceNumber")]
    #[sqlx(rename = "invoice_number")]
    pub invoice_number: String,
    #[serde(rename = "productName")]
    #[sqlx(rename = "product_name")]
    pub product_name: String,
    #[serde(rename = "planName")]
    #[sqlx(rename = "plan_name")]
    pub plan_name: String,
    pub status: String,
    pub currency: String,
    #[serde(rename = "amountMinor")]
    #[sqlx(rename = "amount_minor")]
    pub amount_minor: Option<i32>,
    #[serde(rename = "issuedAt")]
    #[sqlx(rename = "issued_at")]
    pub issued_at: DateTime<Utc>,
    #[serde(rename = "paidAt")]
    #[sqlx(rename = "paid_at")]
    pub paid_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ManualGrant {
    pub id: String,
    #[serde(rename = "orgId")]
    #[sqlx(rename = "org_id")]
    pub org_id: String,
    pub key: String,
    pub value: Value,
    #[serde(rename = "startsAt")]
    #[sqlx(rename = "starts_at")]
    pub starts_at: DateTime<Utc>,
    #[serde(rename = "endsAt")]
    #[sqlx(rename = "ends_at")]
    pub ends_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
    #[serde(rename = "createdById")]
    #[sqlx(rename = "created_by_id")]
    pub created_by_id: Option<String>,
}

pub async fn list_manual_grants(pool: &PgPool, org_id: &str) -> Result<Vec<ManualGrant>, AppError> {
    sqlx::query_as::<_, ManualGrant>(
        r#"
        SELECT id, "orgId" AS org_id, key, value,
               "startsAt" AT TIME ZONE 'UTC' AS starts_at,
               "endsAt" AT TIME ZONE 'UTC' AS ends_at,
               reason, "createdById" AS created_by_id
        FROM "OrganizationEntitlementGrant"
        WHERE "orgId" = $1 AND source = 'MANUAL'::"EntitlementSource"
        ORDER BY "createdAt" DESC
    "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn create_manual_grant(
    pool: &PgPool,
    org_id: &str,
    key: &str,
    value: Value,
    ends_at: Option<DateTime<Utc>>,
    reason: &str,
    actor_id: &str,
) -> Result<ManualGrant, AppError> {
    let key = validate_entitlement_key(key)?;
    let reason = reason.trim();
    if key.is_empty() || reason.is_empty() {
        return Err(AppError::BadRequest(
            "Grant key and reason are required".to_string(),
        ));
    }
    if ends_at.is_some_and(|date| date <= Utc::now()) {
        return Err(AppError::BadRequest(
            "Grant expiry must be in the future".to_string(),
        ));
    }
    sqlx::query_as::<_, ManualGrant>(r#"
        INSERT INTO "OrganizationEntitlementGrant" (id, "orgId", key, value, source, "startsAt", "endsAt", reason, "createdById", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 'MANUAL'::"EntitlementSource", NOW(), $5, $6, $7, NOW(), NOW())
        RETURNING id, "orgId" AS org_id, key, value,
                  "startsAt" AT TIME ZONE 'UTC' AS starts_at,
                  "endsAt" AT TIME ZONE 'UTC' AS ends_at,
                  reason, "createdById" AS created_by_id
    "#)
    .bind(cuid2::create_id()).bind(org_id).bind(key).bind(value).bind(ends_at).bind(reason).bind(actor_id)
    .fetch_one(pool).await.map_err(AppError::from)
}

pub async fn expire_manual_grant(
    pool: &PgPool,
    org_id: &str,
    grant_id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "OrganizationEntitlementGrant" SET "endsAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1 AND "orgId" = $2 AND source = 'MANUAL'::"EntitlementSource"
          AND ("endsAt" IS NULL OR "endsAt" > NOW())
    "#,
    )
    .bind(grant_id)
    .bind(org_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct AvailablePlan {
    pub key: String,
    #[serde(rename = "productKey")]
    #[sqlx(rename = "product_key")]
    pub product_key: String,
    pub name: String,
    pub interval: String,
    pub currency: String,
    #[serde(rename = "amountMinor")]
    #[sqlx(rename = "amount_minor")]
    pub amount_minor: Option<i32>,
    #[serde(rename = "creditsPerPeriod")]
    #[sqlx(rename = "credits_per_period")]
    pub credits_per_period: Option<i64>,
    #[serde(rename = "checkoutReady")]
    pub checkout_ready: bool,
}

#[derive(Debug, Serialize)]
pub struct PlanEntitlementView {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Serialize)]
pub struct AvailablePlanDetails {
    #[serde(flatten)]
    pub plan: AvailablePlan,
    pub entitlements: Vec<PlanEntitlementView>,
}

pub fn paystack_event_key(event: &Value) -> Result<String, AppError> {
    let event_type = event
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Paystack event type is missing".to_string()))?;
    let data = event.get("data").unwrap_or(&Value::Null);
    let identity = data
        .get("id")
        .map(Value::to_string)
        .or_else(|| {
            data.get("reference")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            data.get("subscription_code")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| hex::encode(sha2::Sha512::digest(event.to_string().as_bytes())));
    Ok(format!("{event_type}:{identity}"))
}

pub async fn record_paystack_event(
    pool: &PgPool,
    event_key: &str,
    event: &Value,
) -> Result<bool, AppError> {
    let event_type = event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let claimed = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "PaystackWebhookEvent" (
            id, "eventKey", "eventType", payload, status, "receivedAt", "processedAt"
        )
        VALUES ($1, $2, $3, $4, 'PROCESSING', NOW(), NOW())
        ON CONFLICT ("eventKey") DO UPDATE SET
            "eventType" = EXCLUDED."eventType",
            payload = EXCLUDED.payload,
            status = 'PROCESSING',
            "errorMessage" = NULL,
            "processedAt" = NOW()
        WHERE "PaystackWebhookEvent".status IN ('FAILED', 'RECEIVED')
           OR (
                "PaystackWebhookEvent".status = 'PROCESSING'
                AND (
                    "PaystackWebhookEvent"."processedAt" IS NULL
                    OR "PaystackWebhookEvent"."processedAt" < NOW() - INTERVAL '10 minutes'
                )
           )
        RETURNING id
        "#,
    )
    .bind(cuid2::create_id())
    .bind(event_key)
    .bind(event_type)
    .bind(event)
    .fetch_optional(pool)
    .await?;
    Ok(claimed.is_some())
}

pub async fn finish_paystack_event(
    pool: &PgPool,
    event_key: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "PaystackWebhookEvent" SET status = $2, "errorMessage" = $3, "processedAt" = NOW()
        WHERE "eventKey" = $1 AND status = 'PROCESSING'
    "#,
    )
    .bind(event_key)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, FromRow)]
struct PaystackWebhookRetryCandidate {
    #[sqlx(rename = "event_key")]
    event_key: String,
}

async fn claim_paystack_webhook_retry(
    pool: &PgPool,
    event_key: &str,
) -> Result<Option<Value>, AppError> {
    sqlx::query_as::<_, (Value,)>(
        r#"
        UPDATE "PaystackWebhookEvent"
        SET status = 'PROCESSING', "errorMessage" = NULL, "processedAt" = NOW()
        WHERE "eventKey" = $1
          AND (
            status IN ('FAILED', 'RECEIVED')
            OR (
                status = 'PROCESSING'
                AND (
                    "processedAt" IS NULL
                    OR "processedAt" < NOW() - INTERVAL '10 minutes'
                )
            )
          )
        RETURNING payload
        "#,
    )
    .bind(event_key)
    .fetch_optional(pool)
    .await
    .map(|row| row.map(|(payload,)| payload))
    .map_err(AppError::from)
}

async fn retry_failed_paystack_events(
    pool: &PgPool,
    provider: &dyn BillingProvider,
    limit: i64,
    referral_config: ReferralRewardConfig,
) -> Result<usize, AppError> {
    let candidates = sqlx::query_as::<_, PaystackWebhookRetryCandidate>(
        r#"
        SELECT "eventKey" AS event_key
        FROM "PaystackWebhookEvent"
        WHERE status = 'FAILED'
           OR status = 'RECEIVED'
           OR (
                status = 'PROCESSING'
                AND (
                    "processedAt" IS NULL
                    OR "processedAt" < NOW() - INTERVAL '10 minutes'
                )
           )
        ORDER BY "receivedAt" ASC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await?;

    let mut attempted = 0;
    for candidate in candidates {
        let Some(payload) = claim_paystack_webhook_retry(pool, &candidate.event_key).await? else {
            continue;
        };
        attempted += 1;
        let provider_event = match provider.parse_webhook(&payload) {
            Ok(event) => event,
            Err(error) => {
                finish_paystack_event(
                    pool,
                    &candidate.event_key,
                    "FAILED",
                    Some(&error.to_string()),
                )
                .await?;
                continue;
            }
        };
        match process_provider_event(pool, provider.name(), provider_event, referral_config).await {
            Ok(processed) => {
                finish_paystack_event(
                    pool,
                    &candidate.event_key,
                    if processed { "PROCESSED" } else { "IGNORED" },
                    None,
                )
                .await?;
            }
            Err(error) => {
                finish_paystack_event(
                    pool,
                    &candidate.event_key,
                    "FAILED",
                    Some(&error.to_string()),
                )
                .await?;
            }
        }
    }
    Ok(attempted)
}

pub async fn process_provider_event(
    pool: &PgPool,
    provider_name: &str,
    event: ProviderEvent,
    referral_config: ReferralRewardConfig,
) -> Result<bool, AppError> {
    match event {
        ProviderEvent::SubscriptionCreated {
            subscription_id,
            customer_id,
            plan_code,
        } => {
            let result = sqlx::query(r#"
                UPDATE "OrganizationSubscription" SET "providerSubscriptionId" = $1, status = 'ACTIVE'::"OrganizationSubscriptionStatus", "updatedAt" = NOW()
                WHERE id = (
                  SELECT subscription.id FROM "OrganizationSubscription" subscription
                  JOIN "ProductPlan" plan ON plan.id = subscription."planId"
                  WHERE subscription.provider = $2 AND subscription."providerCustomerId" = $3
                    AND plan."paystackPlanCode" = $4
                  ORDER BY subscription."createdAt" DESC LIMIT 1
                )
            "#).bind(subscription_id).bind(provider_name).bind(customer_id).bind(plan_code).execute(pool).await?;
            Ok(result.rows_affected() == 1)
        }
        ProviderEvent::SubscriptionNotRenewing { subscription_id } => {
            update_subscription_status(pool, provider_name, &subscription_id, "ACTIVE", true).await
        }
        ProviderEvent::SubscriptionDisabled { subscription_id } => {
            mark_subscription_disabled(pool, provider_name, &subscription_id).await
        }
        ProviderEvent::InvoicePaymentFailed { subscription_id } => {
            update_subscription_status(pool, provider_name, &subscription_id, "PAST_DUE", false)
                .await
        }
        ProviderEvent::RefundProcessed {
            transaction_reference,
            amount_minor,
        } => process_refund(pool, provider_name, &transaction_reference, amount_minor).await,
        ProviderEvent::DisputeOpened {
            transaction_reference,
        } => {
            let checkout = checkout_org(pool, provider_name, &transaction_reference).await?;
            upsert_reconciliation_issue(
                pool,
                checkout.as_deref(),
                provider_name,
                "transaction",
                &transaction_reference,
                "dispute_opened",
                serde_json::json!({
                    "reference": transaction_reference,
                    "referralReviewRequired": true,
                    "referralPolicy": "manual_review",
                }),
            )
            .await?;
            Ok(true)
        }
        ProviderEvent::ChargeSucceeded {
            reference,
            customer_id,
            subscription_id,
            transaction_id,
            invoice_id,
            amount_minor,
            currency,
        } => {
            let activated = activate_checkout(
                pool,
                provider_name,
                &reference,
                customer_id.as_deref(),
                subscription_id.as_deref(),
                referral_config,
            )
            .await?;
            if activated {
                Ok(true)
            } else {
                process_recurring_charge(
                    pool,
                    provider_name,
                    &reference,
                    subscription_id.as_deref(),
                    transaction_id.as_deref(),
                    invoice_id.as_deref(),
                    amount_minor,
                    currency.as_deref(),
                )
                .await
            }
        }
        ProviderEvent::Ignored => Ok(false),
    }
}

async fn checkout_org(
    pool: &PgPool,
    provider_name: &str,
    reference: &str,
) -> Result<Option<String>, AppError> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT "orgId" FROM "BillingCheckout" WHERE provider = $1 AND reference = $2
    "#,
    )
    .bind(provider_name)
    .bind(reference)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn process_refund(
    pool: &PgPool,
    provider_name: &str,
    reference: &str,
    amount_minor: Option<i64>,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let checkout = sqlx::query_as::<_, (String, String, String, Option<i64>, Option<String>)>(
        r#"
        SELECT checkout.id, checkout."orgId", checkout."planId",
               COALESCE((checkout."providerResponse"->>'amountMinor')::bigint, plan."amountMinor"::bigint),
               checkout."providerResponse"->>'subscriptionId'
        FROM "BillingCheckout" checkout
        JOIN "ProductPlan" plan ON plan.id = checkout."planId"
        WHERE checkout.provider = $1 AND checkout.reference = $2
        FOR UPDATE
    "#,
    )
    .bind(provider_name)
    .bind(reference)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((checkout_id, org_id, plan_id, plan_amount, provider_subscription_id)) = checkout
    else {
        return Ok(false);
    };

    let Some(refund_amount) = amount_minor else {
        tx.commit().await?;
        upsert_reconciliation_issue(
            pool,
            Some(&org_id),
            provider_name,
            "transaction",
            reference,
            "refund_amount_unverified",
            serde_json::json!({"refundAmountMinor": amount_minor, "transactionAmountMinor": plan_amount}),
        )
        .await?;
        return Ok(true);
    };
    let Some(transaction_amount) = plan_amount else {
        tx.commit().await?;
        upsert_reconciliation_issue(
            pool,
            Some(&org_id),
            provider_name,
            "transaction",
            reference,
            "refund_amount_unverified",
            serde_json::json!({"refundAmountMinor": refund_amount, "transactionAmountMinor": plan_amount}),
        )
        .await?;
        return Ok(true);
    };
    if refund_amount < transaction_amount {
        tx.commit().await?;
        upsert_reconciliation_issue(
            pool,
            Some(&org_id),
            provider_name,
            "transaction",
            reference,
            "partial_refund_processed",
            serde_json::json!({"refundAmountMinor": refund_amount, "transactionAmountMinor": transaction_amount}),
        )
        .await?;
        return Ok(true);
    }

    let provider_subscription_id =
        provider_subscription_id.unwrap_or_else(|| format!("{provider_name}-charge:{reference}"));
    sqlx::query(
        r#"
        UPDATE "OrganizationSubscription"
        SET status = 'CANCELLED'::"OrganizationSubscriptionStatus", "cancelledAt" = NOW(),
            "cancelAtPeriodEnd" = false, "updatedAt" = NOW()
        WHERE "orgId" = $1 AND "planId" = $2 AND provider = $3
          AND "providerSubscriptionId" = $4
    "#,
    )
    .bind(&org_id)
    .bind(&plan_id)
    .bind(provider_name)
    .bind(&provider_subscription_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE "BillingCheckout" SET status = 'REVERSED', "updatedAt" = NOW() WHERE id = $1
    "#,
    )
    .bind(&checkout_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    referrals::reverse_referral(
        pool,
        &org_id,
        "Initial payment was fully refunded",
        &format!("{provider_name}:refund:{reference}"),
    )
    .await?;
    Ok(true)
}

async fn update_subscription_status(
    pool: &PgPool,
    provider_name: &str,
    subscription_id: &str,
    status: &str,
    cancel_at_period_end: bool,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "OrganizationSubscription"
        SET status = CAST($3 AS "OrganizationSubscriptionStatus"), "cancelAtPeriodEnd" = $4,
            "cancelledAt" = CASE WHEN $3 = 'CANCELLED' THEN NOW() ELSE "cancelledAt" END,
            "updatedAt" = NOW()
        WHERE provider = $1 AND "providerSubscriptionId" = $2
    "#,
    )
    .bind(provider_name)
    .bind(&subscription_id)
    .bind(status)
    .bind(cancel_at_period_end)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn mark_subscription_disabled(
    pool: &PgPool,
    provider_name: &str,
    subscription_id: &str,
) -> Result<bool, AppError> {
    let org_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "orgId"
        FROM "OrganizationSubscription"
        WHERE provider = $1 AND "providerSubscriptionId" = $2
        "#,
    )
    .bind(provider_name)
    .bind(subscription_id)
    .fetch_optional(pool)
    .await?;
    let updated =
        update_subscription_status(pool, provider_name, subscription_id, "CANCELLED", false)
            .await?;
    if updated {
        upsert_reconciliation_issue(
            pool,
            org_id.as_deref(),
            provider_name,
            "subscription",
            subscription_id,
            "subscription_disabled",
            serde_json::json!({
                "reference": subscription_id,
                "referralReviewRequired": true,
                "referralPolicy": "manual_review",
            }),
        )
        .await?;
    }
    Ok(updated)
}

pub async fn activate_checkout(
    pool: &PgPool,
    provider_name: &str,
    reference: &str,
    customer_id: Option<&str>,
    subscription_id: Option<&str>,
    referral_config: ReferralRewardConfig,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let checkout = sqlx::query_as::<_, (String, String, String, String)>(
        r#"
        SELECT id, "orgId", "planId", status FROM "BillingCheckout"
        WHERE reference = $1 AND provider = $2 FOR UPDATE
    "#,
    )
    .bind(reference)
    .bind(provider_name)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((checkout_id, org_id, plan_id, status)) = checkout else {
        return Ok(false);
    };
    if status == "COMPLETED" {
        let subscription = sqlx::query_as::<_, (String, DateTime<Utc>, DateTime<Utc>)>(
            r#"
            SELECT id,
                   "currentPeriodStart" AT TIME ZONE 'UTC',
                   "currentPeriodEnd" AT TIME ZONE 'UTC'
            FROM "OrganizationSubscription"
            WHERE "orgId" = $1 AND "planId" = $2 AND provider = $3
              AND status IN (
                'ACTIVE'::"OrganizationSubscriptionStatus",
                'GRACE'::"OrganizationSubscriptionStatus",
                'PAST_DUE'::"OrganizationSubscriptionStatus"
              )
            ORDER BY "createdAt" DESC
            LIMIT 1
            "#,
        )
        .bind(&org_id)
        .bind(&plan_id)
        .bind(provider_name)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        let Some((subscription_id, period_start, period_end)) = subscription else {
            return Err(AppError::Internal(
                "Completed checkout has no active subscription".to_string(),
            ));
        };
        finalize_paid_activation(
            pool,
            &org_id,
            &plan_id,
            &subscription_id,
            period_start,
            period_end,
            reference,
            &format!("paid-activation:{reference}"),
            referral_config,
        )
        .await?;
        return Ok(true);
    }
    if status != "PENDING" {
        tx.commit().await?;
        return Ok(false);
    }
    let provider_subscription_id = subscription_id
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{provider_name}-charge:{reference}"));

    sqlx::query(r#"
        UPDATE "OrganizationSubscription" subscription
        SET status = 'CANCELLED'::"OrganizationSubscriptionStatus", "cancelledAt" = NOW(), "updatedAt" = NOW()
        WHERE subscription."orgId" = $1
          AND subscription.status IN ('TRIAL'::"OrganizationSubscriptionStatus", 'ACTIVE'::"OrganizationSubscriptionStatus", 'GRACE'::"OrganizationSubscriptionStatus")
          AND subscription."planId" IN (
            SELECT sibling.id FROM "ProductPlan" sibling
            WHERE sibling."productId" = (SELECT "productId" FROM "ProductPlan" WHERE id = $2)
          )
    "#).bind(&org_id).bind(&plan_id).execute(&mut *tx).await?;

    sqlx::query(r#"
        INSERT INTO "OrganizationSubscription" (
          id, "orgId", "planId", status, "startedAt", "currentPeriodStart", "currentPeriodEnd",
          "cancelAtPeriodEnd", provider, "providerCustomerId", "providerSubscriptionId", "createdAt", "updatedAt"
        )
        SELECT $1, $2, $3, 'ACTIVE'::"OrganizationSubscriptionStatus", NOW(), NOW(),
               NOW() + CASE WHEN plan.interval = 'YEARLY'::"BillingInterval"
                            THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END,
               false, $4, $5, $6, NOW(), NOW()
        FROM "ProductPlan" plan WHERE plan.id = $3
        ON CONFLICT ("providerSubscriptionId") DO UPDATE SET
          status = 'ACTIVE'::"OrganizationSubscriptionStatus", "cancelledAt" = NULL, "updatedAt" = NOW()
    "#).bind(cuid2::create_id()).bind(&org_id).bind(&plan_id).bind(provider_name).bind(customer_id)
    .bind(&provider_subscription_id).execute(&mut *tx).await?;

    let subscription_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id FROM "OrganizationSubscription"
        WHERE "orgId" = $1 AND provider = $2 AND "providerSubscriptionId" = $3
        "#,
    )
    .bind(&org_id)
    .bind(provider_name)
    .bind(&provider_subscription_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE "BillingCheckout"
        SET status = 'COMPLETED', "completedAt" = NOW(),
            "providerResponse" = COALESCE("providerResponse", '{}'::jsonb) ||
              jsonb_strip_nulls(jsonb_build_object(
                'customerId', $2::text,
                'subscriptionId', $3::text
              )),
            "updatedAt" = NOW()
        WHERE id = $1
    "#,
    )
    .bind(&checkout_id)
    .bind(customer_id)
    .bind(&provider_subscription_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "BillingInvoice" (
          id, "invoiceNumber", "orgId", "checkoutId", "subscriptionId", provider,
          "providerTransactionId", status, currency, "amountMinor", "issuedAt", "paidAt",
          "createdAt", "updatedAt"
        )
        SELECT $1, 'KS-' || checkout.reference, checkout."orgId", checkout.id, $2, checkout.provider,
               checkout.reference, 'PAID', plan.currency,
               COALESCE((checkout."providerResponse"->>'amountMinor')::integer, plan."amountMinor"),
               NOW(), NOW(), NOW(), NOW()
        FROM "BillingCheckout" checkout
        JOIN "ProductPlan" plan ON plan.id = checkout."planId"
        WHERE checkout.id = $3
        ON CONFLICT ("checkoutId") DO UPDATE SET
          "subscriptionId" = EXCLUDED."subscriptionId",
          "providerTransactionId" = EXCLUDED."providerTransactionId",
          "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&subscription_id)
    .bind(checkout_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let period = sqlx::query_as::<_, (DateTime<Utc>, DateTime<Utc>)>(
        r#"
        SELECT "currentPeriodStart" AT TIME ZONE 'UTC', "currentPeriodEnd" AT TIME ZONE 'UTC'
        FROM "OrganizationSubscription" WHERE id = $1
        "#,
    )
    .bind(&subscription_id)
    .fetch_one(pool)
    .await?;
    finalize_paid_activation(
        pool,
        &org_id,
        &plan_id,
        &subscription_id,
        period.0,
        period.1,
        reference,
        &format!("paid-activation:{reference}"),
        referral_config,
    )
    .await?;
    Ok(true)
}

async fn finalize_paid_activation(
    pool: &PgPool,
    org_id: &str,
    plan_id: &str,
    subscription_id: &str,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
    payment_reference: &str,
    idempotency_key: &str,
    referral_config: ReferralRewardConfig,
) -> Result<(), AppError> {
    grant_paid_period_credits(
        pool,
        org_id,
        subscription_id,
        plan_id,
        period_start,
        period_end,
        payment_reference,
        idempotency_key,
    )
    .await?;
    referrals::qualify_referral(pool, org_id, payment_reference, referral_config).await?;
    Ok(())
}

async fn grant_paid_period_credits(
    pool: &PgPool,
    org_id: &str,
    subscription_id: &str,
    plan_id: &str,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
    payment_reference: &str,
    idempotency_key: &str,
) -> Result<(), AppError> {
    let credits_per_period = sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT "creditsPerPeriod" FROM "ProductPlan" WHERE id = $1"#,
    )
    .bind(plan_id)
    .fetch_one(pool)
    .await?;
    let Some(credits_per_period) = credits_per_period else {
        return Ok(());
    };
    if credits_per_period <= 0 {
        return Err(AppError::Internal(
            "Configured plan credit allowance must be positive".to_string(),
        ));
    }
    credits::grant_system_credits(
        pool,
        org_id,
        credits_per_period,
        "PLAN",
        Some(period_end),
        "Paid subscription period credits",
        Some(payment_reference),
        Some(&serde_json::json!({
            "subscriptionId": subscription_id,
            "planId": plan_id,
            "periodStart": period_start,
            "periodEnd": period_end,
        })),
        idempotency_key,
    )
    .await?;
    Ok(())
}

async fn process_recurring_charge(
    pool: &PgPool,
    provider_name: &str,
    payment_reference: &str,
    provider_subscription_id: Option<&str>,
    provider_transaction_id: Option<&str>,
    provider_invoice_id: Option<&str>,
    amount_minor: Option<i64>,
    currency: Option<&str>,
) -> Result<bool, AppError> {
    let Some(provider_subscription_id) = provider_subscription_id else {
        return Ok(false);
    };
    let invoice_number = recurring_invoice_number(provider_name, payment_reference);
    let mut tx = pool.begin().await?;
    if let Some((org_id, plan_id, subscription_id, period_start, period_end)) = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Option<DateTime<Utc>>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
            SELECT invoice."orgId", subscription."planId", invoice."subscriptionId",
                   invoice."periodStart" AT TIME ZONE 'UTC',
                   invoice."periodEnd" AT TIME ZONE 'UTC'
            FROM "BillingInvoice" invoice
            JOIN "OrganizationSubscription" subscription
              ON subscription.id = invoice."subscriptionId"
            WHERE invoice."invoiceNumber" = $1
            "#,
    )
    .bind(&invoice_number)
    .fetch_optional(&mut *tx)
    .await?
    {
        tx.commit().await?;
        let Some(period_start) = period_start else {
            return Err(AppError::Internal(
                "Recurring invoice is missing its period start".to_string(),
            ));
        };
        let Some(period_end) = period_end else {
            return Err(AppError::Internal(
                "Recurring invoice is missing its period end".to_string(),
            ));
        };
        grant_paid_period_credits(
            pool,
            &org_id,
            &subscription_id,
            &plan_id,
            period_start,
            period_end,
            payment_reference,
            &format!("paid-invoice:{invoice_number}"),
        )
        .await?;
        return Ok(true);
    }

    let subscription = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Option<DateTime<Utc>>,
            Option<DateTime<Utc>>,
            String,
            String,
            Option<i32>,
        ),
    >(
        r#"
        SELECT subscription.id, subscription."orgId", subscription."planId",
               subscription."currentPeriodStart" AT TIME ZONE 'UTC',
               subscription."currentPeriodEnd" AT TIME ZONE 'UTC',
               plan.interval::text, plan.currency, plan."amountMinor"
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        WHERE subscription.provider = $1 AND subscription."providerSubscriptionId" = $2
        FOR UPDATE
        "#,
    )
    .bind(provider_name)
    .bind(provider_subscription_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        subscription_id,
        org_id,
        plan_id,
        _current_period_start,
        current_period_end,
        interval,
        plan_currency,
        plan_amount_minor,
    )) = subscription
    else {
        tx.commit().await?;
        return Err(AppError::Conflict(
            "Recurring payment arrived before its local subscription was linked".to_string(),
        ));
    };
    let period_start = current_period_end.unwrap_or_else(Utc::now);
    let period_end = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        SELECT $1 + CASE WHEN $2 = 'YEARLY' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END
        "#,
    )
    .bind(period_start)
    .bind(&interval)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE "OrganizationSubscription"
        SET status = 'ACTIVE'::"OrganizationSubscriptionStatus",
            "currentPeriodStart" = $2, "currentPeriodEnd" = $3,
            "cancelAtPeriodEnd" = false, "updatedAt" = NOW()
        WHERE id = $1
        "#,
    )
    .bind(&subscription_id)
    .bind(period_start)
    .bind(period_end)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "BillingInvoice" (
            id, "invoiceNumber", "orgId", "checkoutId", "subscriptionId", provider,
            "providerInvoiceId", "providerTransactionId", status, currency, "amountMinor",
            "periodStart", "periodEnd", "issuedAt", "paidAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, NULL, $4, $5, $6, $7, 'PAID', $8, $9,
            $10, $11, NOW(), NOW(), NOW(), NOW()
        )
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&invoice_number)
    .bind(&org_id)
    .bind(&subscription_id)
    .bind(provider_name)
    .bind(provider_invoice_id)
    .bind(provider_transaction_id.or(Some(payment_reference)))
    .bind(currency.unwrap_or(&plan_currency))
    .bind(amount_minor.or(plan_amount_minor.map(i64::from)))
    .bind(period_start)
    .bind(period_end)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    grant_paid_period_credits(
        pool,
        &org_id,
        &subscription_id,
        &plan_id,
        period_start,
        period_end,
        payment_reference,
        &format!("paid-invoice:{invoice_number}"),
    )
    .await?;
    Ok(true)
}

fn recurring_invoice_number(provider_name: &str, payment_reference: &str) -> String {
    format!("KS-{provider_name}-{payment_reference}")
}

pub async fn list_available_plans(pool: &PgPool) -> Result<Vec<AvailablePlan>, AppError> {
    sqlx::query_as::<_, AvailablePlan>(
        r#"
        SELECT plan.key, product.key AS product_key, plan.name, plan.interval::text AS interval,
               plan.currency, plan."amountMinor" AS amount_minor,
               plan."creditsPerPeriod" AS credits_per_period,
               (plan."paystackPlanCode" IS NOT NULL) AS checkout_ready
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.active = true AND product.active = true
        ORDER BY product.name, plan."amountMinor" ASC NULLS LAST, plan.name
    "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn get_available_plan_details(
    pool: &PgPool,
    plan_key: &str,
) -> Result<AvailablePlanDetails, AppError> {
    let plan = sqlx::query_as::<_, AvailablePlan>(
        r#"
        SELECT plan.key, product.key AS product_key, plan.name, plan.interval::text AS interval,
               plan.currency, plan."amountMinor" AS amount_minor,
               plan."creditsPerPeriod" AS credits_per_period,
               (plan."paystackPlanCode" IS NOT NULL) AS checkout_ready
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.key = $1 AND plan.active = true AND product.active = true
        "#,
    )
    .bind(plan_key)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Plan not found".to_string()))?;
    let entitlement_rows = sqlx::query_as::<_, (String, Value)>(
        r#"
        SELECT entitlement.key, entitlement.value
        FROM "PlanEntitlement" entitlement
        JOIN "ProductPlan" candidate ON candidate.id = entitlement."planId"
        WHERE candidate.id = (
            SELECT id FROM "ProductPlan" WHERE key = $1
        )
        ORDER BY entitlement.key
        "#,
    )
    .bind(plan_key)
    .fetch_all(pool)
    .await?;
    let entitlements = entitlement_rows
        .into_iter()
        .filter_map(|(key, value)| {
            if key.starts_with("limit.") {
                let meter_key = key.trim_start_matches("limit.");
                let definition = METER_DEFINITIONS
                    .iter()
                    .find(|item| item.key == meter_key)?;
                Some(PlanEntitlementView {
                    key,
                    name: definition.name.to_string(),
                    description: Some(definition.description.to_string()),
                    kind: "limit".to_string(),
                    value,
                })
            } else {
                let definition = capability_definition(&key)?;
                Some(PlanEntitlementView {
                    key,
                    name: definition.name.to_string(),
                    description: Some(definition.description.to_string()),
                    kind: "feature".to_string(),
                    value,
                })
            }
        })
        .collect();
    Ok(AvailablePlanDetails { plan, entitlements })
}

fn validate_catalog_key(key: &str) -> Result<&str, AppError> {
    let key = key.trim();
    if key.is_empty()
        || key.len() > 80
        || !key.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(AppError::BadRequest(
            "Keys must use lowercase letters, numbers, dots, hyphens, or underscores".to_string(),
        ));
    }
    Ok(key)
}

fn validate_entitlement_key(key: &str) -> Result<&str, AppError> {
    let key = validate_catalog_key(key)?;
    let is_capability = capability_definition(key).is_some();
    let is_meter = key
        .strip_prefix("limit.")
        .is_some_and(|meter_key| METER_DEFINITIONS.iter().any(|item| item.key == meter_key));
    if !is_capability && !is_meter {
        return Err(AppError::BadRequest(
            "Entitlements must use a registered feature key or workspace meter limit".to_string(),
        ));
    }
    Ok(key)
}

pub async fn admin_catalog(pool: &PgPool) -> Result<Value, AppError> {
    let products = sqlx::query_as::<_, (String, String, Option<String>, bool)>(
        r#"
        SELECT key, name, description, active FROM "Product" ORDER BY name
    "#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(key, name, description, active)| {
        serde_json::json!({
            "key": key, "name": name, "description": description, "active": active,
        })
    })
    .collect::<Vec<_>>();
    let plans = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            Option<i32>,
            Option<i64>,
            bool,
            Option<String>,
        ),
    >(
        r#"
        SELECT plan.key, product.key, plan.name, plan.interval::text, plan.currency,
               plan."amountMinor", plan."creditsPerPeriod", plan.active, plan."paystackPlanCode"
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        ORDER BY product.name, plan.name
    "#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(
            key,
            product_key,
            name,
            interval,
            currency,
            amount_minor,
            credits_per_period,
            active,
            paystack_plan_code,
        )| {
            serde_json::json!({
                "key": key, "productKey": product_key, "name": name, "interval": interval,
                "currency": currency, "amountMinor": amount_minor,
                "creditsPerPeriod": credits_per_period, "active": active,
                "paystackPlanCode": paystack_plan_code,
            })
        },
    )
    .collect::<Vec<_>>();
    let entitlements = sqlx::query_as::<_, (String, String, Value)>(
        r#"
        SELECT plan.key, entitlement.key, entitlement.value
        FROM "PlanEntitlement" entitlement
        JOIN "ProductPlan" plan ON plan.id = entitlement."planId"
        ORDER BY plan.key, entitlement.key
    "#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(plan_key, key, value)| {
        serde_json::json!({
            "planKey": plan_key, "key": key, "value": value,
        })
    })
    .collect::<Vec<_>>();
    let capability_definitions = CAPABILITY_DEFINITIONS
        .iter()
        .map(|definition| {
            serde_json::json!({
                "key": definition.key,
                "name": definition.name,
                "kind": "capability",
            })
        })
        .collect::<Vec<_>>();
    let meter_definitions = METER_DEFINITIONS
        .iter()
        .map(|definition| {
            serde_json::json!({
                "key": format!("limit.{}", definition.key),
                "name": definition.name,
                "kind": "meter",
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "products": products,
        "plans": plans,
        "entitlements": entitlements,
        "accessDefinitions": capability_definitions.into_iter().chain(meter_definitions).collect::<Vec<_>>(),
    }))
}

pub async fn upsert_product(
    pool: &PgPool,
    key: &str,
    name: &str,
    description: Option<&str>,
    active: bool,
) -> Result<Value, AppError> {
    let key = validate_catalog_key(key)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Product name is required".to_string()));
    }
    let row = sqlx::query_as::<_, (String, String, Option<String>, bool)>(
        r#"
        INSERT INTO "Product" (id, key, name, description, active, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
          active = EXCLUDED.active, "updatedAt" = NOW()
        RETURNING key, name, description, active
    "#,
    )
    .bind(cuid2::create_id())
    .bind(key)
    .bind(name)
    .bind(description)
    .bind(active)
    .fetch_one(pool)
    .await?;
    Ok(serde_json::json!({"key": row.0, "name": row.1, "description": row.2, "active": row.3}))
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_plan(
    pool: &PgPool,
    product_key: &str,
    key: &str,
    name: &str,
    interval: &str,
    currency: &str,
    amount_minor: Option<i32>,
    credits_per_period: Option<i64>,
    active: bool,
    paystack_plan_code: Option<&str>,
) -> Result<Value, AppError> {
    let key = validate_catalog_key(key)?;
    let product_key = validate_catalog_key(product_key)?;
    let interval = interval.trim().to_uppercase();
    if !matches!(interval.as_str(), "MONTHLY" | "YEARLY") {
        return Err(AppError::BadRequest(
            "Plan interval must be MONTHLY or YEARLY".to_string(),
        ));
    }
    let currency = currency.trim().to_uppercase();
    if currency.len() != 3
        || !currency
            .chars()
            .all(|character| character.is_ascii_uppercase())
    {
        return Err(AppError::BadRequest(
            "Currency must be a three-letter code".to_string(),
        ));
    }
    if amount_minor.is_some_and(|amount| amount < 0)
        || credits_per_period.is_some_and(|credits| credits <= 0)
        || name.trim().is_empty()
    {
        return Err(AppError::BadRequest(
            "Plan name and a non-negative amount are required".to_string(),
        ));
    }
    let plan_code = paystack_plan_code
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let row = sqlx::query_as::<_, (String, String, String, String, Option<i32>, Option<i64>, bool, Option<String>)>(r#"
        INSERT INTO "ProductPlan" (id, "productId", key, name, interval, currency, "amountMinor", "creditsPerPeriod", active, "paystackPlanCode", "createdAt", "updatedAt")
        SELECT $1, product.id, $3, $4, CAST($5 AS "BillingInterval"), $6, $7, $8, $9, $10, NOW(), NOW()
        FROM "Product" product WHERE product.key = $2
        ON CONFLICT (key) DO UPDATE SET "productId" = EXCLUDED."productId", name = EXCLUDED.name,
          interval = EXCLUDED.interval, currency = EXCLUDED.currency, "amountMinor" = EXCLUDED."amountMinor",
          "creditsPerPeriod" = EXCLUDED."creditsPerPeriod", active = EXCLUDED.active,
          "paystackPlanCode" = EXCLUDED."paystackPlanCode", "updatedAt" = NOW()
        RETURNING key, name, interval::text, currency, "amountMinor", "creditsPerPeriod", active, "paystackPlanCode"
    "#)
    .bind(cuid2::create_id()).bind(product_key).bind(key).bind(name.trim()).bind(&interval)
    .bind(&currency).bind(amount_minor).bind(credits_per_period).bind(active).bind(plan_code).fetch_optional(pool).await?
    .ok_or_else(|| AppError::NotFound("Product not found".to_string()))?;
    Ok(
        serde_json::json!({"key": row.0, "name": row.1, "interval": row.2, "currency": row.3,
        "amountMinor": row.4, "creditsPerPeriod": row.5, "active": row.6, "paystackPlanCode": row.7}),
    )
}

pub async fn upsert_plan_entitlement(
    pool: &PgPool,
    plan_key: &str,
    key: &str,
    value: Value,
) -> Result<Value, AppError> {
    let plan_key = validate_catalog_key(plan_key)?;
    let key = validate_entitlement_key(key)?;
    if !value.is_boolean() && !value.is_number() && !value.is_string() {
        return Err(AppError::BadRequest(
            "Entitlement values must be boolean, number, or string".to_string(),
        ));
    }
    let row = sqlx::query_as::<_, (String, Value)>(
        r#"
        INSERT INTO "PlanEntitlement" (id, "planId", key, value, "createdAt", "updatedAt")
        SELECT $1, plan.id, $3, $4, NOW(), NOW() FROM "ProductPlan" plan WHERE plan.key = $2
        ON CONFLICT ("planId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()
        RETURNING key, value
    "#,
    )
    .bind(cuid2::create_id())
    .bind(plan_key)
    .bind(key)
    .bind(value)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Plan not found".to_string()))?;
    Ok(serde_json::json!({"planKey": plan_key, "key": row.0, "value": row.1}))
}

pub async fn create_checkout(
    pool: &PgPool,
    provider: &dyn BillingProvider,
    frontend_url: &str,
    org_id: &str,
    user_id: &str,
    email: &str,
    plan_key: &str,
    idempotency_key: &str,
) -> Result<Value, AppError> {
    let idempotency_key = idempotency_key.trim();
    if idempotency_key.is_empty() || idempotency_key.len() > 128 {
        return Err(AppError::BadRequest(
            "A valid checkout idempotency key is required".to_string(),
        ));
    }
    let plan = sqlx::query_as::<_, (String, String, String, String, Option<i32>, String)>(
        r#"
        SELECT plan.id, plan."paystackPlanCode", product.key, plan.name,
               plan."amountMinor", plan.currency
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.key = $1 AND plan.active = true AND product.active = true
    "#,
    )
    .bind(plan_key)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Active plan not found".to_string()))?;
    let (plan_id, paystack_plan_code, product_key, plan_name, amount_minor, currency) = plan;
    if paystack_plan_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "This plan is not connected to Paystack yet".to_string(),
        ));
    }
    let amount_minor = amount_minor.ok_or_else(|| {
        AppError::BadRequest("This plan does not have a configured checkout amount".to_string())
    })?;
    if amount_minor <= 0 {
        return Err(AppError::BadRequest(
            "This plan must have a positive checkout amount".to_string(),
        ));
    }
    if let Some((authorization_url, reference)) = sqlx::query_as::<_, (String, String)>(
        r#"
            SELECT "authorizationUrl", reference FROM "BillingCheckout"
            WHERE "orgId" = $1 AND provider = $2 AND "idempotencyKey" = $3
              AND status = 'PENDING' AND "planId" = $4 AND "authorizationUrl" IS NOT NULL
        "#,
    )
    .bind(org_id)
    .bind(provider.name())
    .bind(idempotency_key)
    .bind(&plan_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(serde_json::json!({
            "authorizationUrl": authorization_url,
            "reference": reference,
            "planName": plan_name,
            "reused": true,
        }));
    }
    let reference = format!("ks_{}", cuid2::create_id());
    let inserted = sqlx::query(r#"
        INSERT INTO "BillingCheckout" (id, reference, "idempotencyKey", "orgId", "planId", "userId", email, provider, status, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', NOW(), NOW())
        ON CONFLICT ("orgId", provider, "idempotencyKey") DO NOTHING
    "#)
    .bind(cuid2::create_id()).bind(&reference).bind(idempotency_key).bind(org_id).bind(&plan_id).bind(user_id).bind(email).bind(provider.name())
    .execute(pool).await?;
    if inserted.rows_affected() == 0 {
        let existing = sqlx::query_as::<_, (String, String, Option<String>, String)>(
            r#"
            SELECT reference, "planId", "authorizationUrl", status FROM "BillingCheckout"
            WHERE "orgId" = $1 AND provider = $2 AND "idempotencyKey" = $3
        "#,
        )
        .bind(org_id)
        .bind(provider.name())
        .bind(idempotency_key)
        .fetch_one(pool)
        .await?;
        if existing.1 != plan_id {
            return Err(AppError::BadRequest(
                "The checkout idempotency key is already used for another plan".to_string(),
            ));
        }
        if let Some(authorization_url) = existing.2 {
            return Ok(serde_json::json!({
                "authorizationUrl": authorization_url,
                "reference": existing.0,
                "planName": plan_name,
                "reused": true,
            }));
        }
        return Err(AppError::BadRequest(format!(
            "Checkout {} is already being initialised ({})",
            existing.0, existing.3
        )));
    }
    let callback_url = format!(
        "{}/billing?payment=complete",
        frontend_url.trim_end_matches('/')
    );
    let result = provider.initialize_checkout(CheckoutRequest {
        email: email.to_string(),
        plan_code: paystack_plan_code,
        amount_minor: i64::from(amount_minor),
        currency,
        reference: reference.clone(),
        callback_url,
        metadata: serde_json::json!({"orgId": org_id, "planKey": plan_key, "productKey": product_key}),
    }).await;
    let data = match result {
        Ok(data) => data,
        Err(error) => {
            sqlx::query(r#"UPDATE "BillingCheckout" SET status = 'FAILED', "updatedAt" = NOW() WHERE reference = $1"#)
                .bind(&reference).execute(pool).await?;
            return Err(error);
        }
    };
    sqlx::query(
        r#"
        UPDATE "BillingCheckout"
        SET "authorizationUrl" = $2,
            "providerResponse" = jsonb_build_object('reference', $3::text),
            "updatedAt" = NOW()
        WHERE reference = $1
    "#,
    )
    .bind(&reference)
    .bind(&data.authorization_url)
    .bind(&data.reference)
    .execute(pool)
    .await?;
    Ok(
        serde_json::json!({"authorizationUrl": data.authorization_url, "reference": data.reference, "planName": plan_name}),
    )
}

#[derive(Debug, Serialize)]
pub struct CheckoutVerification {
    pub reference: String,
    pub status: &'static str,
    pub activated: bool,
}

pub async fn verify_checkout(
    pool: &PgPool,
    provider: &dyn BillingProvider,
    org_id: &str,
    reference: &str,
    referral_config: ReferralRewardConfig,
) -> Result<CheckoutVerification, AppError> {
    let checkout_status = sqlx::query_scalar::<_, String>(
        r#"
        SELECT status FROM "BillingCheckout"
        WHERE reference = $1 AND "orgId" = $2 AND provider = $3
    "#,
    )
    .bind(reference)
    .bind(org_id)
    .bind(provider.name())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Checkout not found".to_string()))?;

    if checkout_status == "COMPLETED" {
        let activated = activate_checkout(
            pool,
            provider.name(),
            reference,
            None,
            None,
            referral_config,
        )
        .await?;
        return Ok(CheckoutVerification {
            reference: reference.to_string(),
            status: "completed",
            activated,
        });
    }
    if checkout_status != "PENDING" {
        return Ok(CheckoutVerification {
            reference: reference.to_string(),
            status: "failed",
            activated: false,
        });
    }

    let transaction = provider.verify_transaction(reference).await?;
    record_verification_response(pool, provider.name(), reference, &transaction).await?;
    if transaction.reference != reference {
        return Err(AppError::BadRequest(
            "Payment reference did not match the checkout".to_string(),
        ));
    }
    if !transaction.successful {
        return Ok(CheckoutVerification {
            reference: reference.to_string(),
            status: "pending",
            activated: false,
        });
    }
    let activated = activate_checkout(
        pool,
        provider.name(),
        reference,
        transaction.customer_id.as_deref(),
        transaction.subscription_id.as_deref(),
        referral_config,
    )
    .await?;
    Ok(CheckoutVerification {
        reference: reference.to_string(),
        status: "completed",
        activated,
    })
}

async fn record_verification_response(
    pool: &PgPool,
    provider_name: &str,
    expected_reference: &str,
    transaction: &crate::services::billing_provider::VerifiedTransaction,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "BillingCheckout"
        SET "providerResponse" = $3,
            "providerTransactionId" = COALESCE($4, "providerTransactionId"),
            "providerAuthorizationId" = COALESCE($5, "providerAuthorizationId"),
            "updatedAt" = NOW()
        WHERE reference = $1 AND provider = $2
    "#,
    )
    .bind(expected_reference)
    .bind(provider_name)
    .bind(serde_json::json!({
        "reference": transaction.reference,
        "successful": transaction.successful,
        "amountMinor": transaction.amount_minor,
        "currency": transaction.currency,
        "customerId": transaction.customer_id,
        "subscriptionId": transaction.subscription_id,
        "transactionId": transaction.provider_transaction_id,
        "authorizationId": transaction.provider_authorization_id,
    }))
    .bind(&transaction.provider_transaction_id)
    .bind(&transaction.provider_authorization_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ReconciliationResult {
    pub checked: usize,
    pub completed: usize,
    pub pending: usize,
    pub failed: usize,
    #[serde(rename = "subscriptionsChecked")]
    pub subscriptions_checked: usize,
    #[serde(rename = "subscriptionsUpdated")]
    pub subscriptions_updated: usize,
    #[serde(rename = "openIssues")]
    pub open_issues: i64,
    #[serde(rename = "webhookRetries")]
    pub webhook_retries: usize,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ReconciliationIssue {
    pub id: String,
    pub fingerprint: String,
    #[serde(rename = "orgId")]
    #[sqlx(rename = "org_id")]
    pub org_id: Option<String>,
    pub provider: String,
    #[serde(rename = "resourceType")]
    #[sqlx(rename = "resource_type")]
    pub resource_type: String,
    #[serde(rename = "resourceId")]
    #[sqlx(rename = "resource_id")]
    pub resource_id: String,
    #[serde(rename = "issueType")]
    #[sqlx(rename = "issue_type")]
    pub issue_type: String,
    pub status: String,
    pub details: Value,
    #[serde(rename = "detectedAt")]
    #[sqlx(rename = "detected_at")]
    pub detected_at: DateTime<Utc>,
    #[serde(rename = "resolvedAt")]
    #[sqlx(rename = "resolved_at")]
    pub resolved_at: Option<DateTime<Utc>>,
}

pub async fn list_reconciliation_issues(
    pool: &PgPool,
    status: Option<&str>,
) -> Result<Vec<ReconciliationIssue>, AppError> {
    sqlx::query_as::<_, ReconciliationIssue>(
        r#"
        SELECT id, fingerprint, "orgId" AS org_id, provider,
               "resourceType" AS resource_type, "resourceId" AS resource_id,
               "issueType" AS issue_type, status, details,
               "detectedAt" AT TIME ZONE 'UTC' AS detected_at,
               "resolvedAt" AT TIME ZONE 'UTC' AS resolved_at
        FROM "BillingReconciliationIssue"
        WHERE $1::text IS NULL OR status = $1
        ORDER BY "detectedAt" DESC LIMIT 200
    "#,
    )
    .bind(status)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

async fn upsert_reconciliation_issue(
    pool: &PgPool,
    org_id: Option<&str>,
    provider: &str,
    resource_type: &str,
    resource_id: &str,
    issue_type: &str,
    details: Value,
) -> Result<(), AppError> {
    let fingerprint = format!("{provider}:{resource_type}:{resource_id}:{issue_type}");
    sqlx::query(
        r#"
        INSERT INTO "BillingReconciliationIssue" (
          id, fingerprint, "orgId", provider, "resourceType", "resourceId", "issueType",
          status, details, "detectedAt", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, NOW(), NOW(), NOW())
        ON CONFLICT (fingerprint) DO UPDATE SET
          status = 'OPEN', details = EXCLUDED.details, "detectedAt" = NOW(),
          "resolvedAt" = NULL, "updatedAt" = NOW()
    "#,
    )
    .bind(cuid2::create_id())
    .bind(fingerprint)
    .bind(org_id)
    .bind(provider)
    .bind(resource_type)
    .bind(resource_id)
    .bind(issue_type)
    .bind(details)
    .execute(pool)
    .await?;
    Ok(())
}

async fn resolve_reconciliation_issue(
    pool: &PgPool,
    provider: &str,
    resource_type: &str,
    resource_id: &str,
    issue_type: &str,
) -> Result<(), AppError> {
    let fingerprint = format!("{provider}:{resource_type}:{resource_id}:{issue_type}");
    sqlx::query(
        r#"
        UPDATE "BillingReconciliationIssue"
        SET status = 'RESOLVED', "resolvedAt" = NOW(), "updatedAt" = NOW()
        WHERE fingerprint = $1 AND status = 'OPEN'
    "#,
    )
    .bind(fingerprint)
    .execute(pool)
    .await?;
    Ok(())
}

fn internal_subscription_state(state: &ProviderSubscriptionState) -> Option<(&'static str, bool)> {
    match state {
        ProviderSubscriptionState::Active => Some(("ACTIVE", false)),
        ProviderSubscriptionState::NonRenewing => Some(("ACTIVE", true)),
        ProviderSubscriptionState::Attention => Some(("PAST_DUE", false)),
        ProviderSubscriptionState::Completed | ProviderSubscriptionState::Cancelled => {
            Some(("CANCELLED", false))
        }
        ProviderSubscriptionState::Unknown(_) => None,
    }
}

fn subscription_grants_access(status: &str) -> bool {
    matches!(status, "TRIAL" | "ACTIVE" | "GRACE")
}

fn merge_entitlement_value(existing: Option<&Value>, next: Value) -> Value {
    match (existing, &next) {
        (Some(Value::Bool(existing)), Value::Bool(next)) => Value::Bool(*existing || *next),
        (Some(existing), next) if existing.as_i64().is_some() && next.as_i64().is_some() => {
            Value::from(existing.as_i64().unwrap().max(next.as_i64().unwrap()))
        }
        _ => next,
    }
}

pub async fn reconcile_billing(
    pool: &PgPool,
    provider: &dyn BillingProvider,
    limit: i64,
    referral_config: ReferralRewardConfig,
) -> Result<ReconciliationResult, AppError> {
    // Keep pending referral state bounded even when no customer opens the
    // Billing page. The reconciliation loop already runs on the provider's
    // retry cadence, so it is the existing scheduled lifecycle boundary.
    referrals::expire_attributions(pool, limit).await?;
    let webhook_retries =
        retry_failed_paystack_events(pool, provider, limit, referral_config).await?;
    let references = sqlx::query_scalar::<_, String>(
        r#"
        SELECT reference FROM "BillingCheckout"
        WHERE provider = $1 AND status = 'PENDING'
          AND "createdAt" < NOW() - INTERVAL '30 seconds'
        ORDER BY "createdAt" ASC LIMIT $2
    "#,
    )
    .bind(provider.name())
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await?;

    let mut result = ReconciliationResult {
        checked: references.len(),
        completed: 0,
        pending: 0,
        failed: 0,
        subscriptions_checked: 0,
        subscriptions_updated: 0,
        open_issues: 0,
        webhook_retries,
    };
    for reference in references {
        match provider.verify_transaction(&reference).await {
            Ok(transaction) if transaction.reference == reference && transaction.successful => {
                record_verification_response(pool, provider.name(), &reference, &transaction)
                    .await?;
                if activate_checkout(
                    pool,
                    provider.name(),
                    &reference,
                    transaction.customer_id.as_deref(),
                    transaction.subscription_id.as_deref(),
                    referral_config,
                )
                .await?
                {
                    result.completed += 1;
                } else {
                    result.failed += 1;
                }
            }
            Ok(transaction) => {
                record_verification_response(pool, provider.name(), &reference, &transaction)
                    .await?;
                if transaction.reference == reference {
                    result.pending += 1;
                } else {
                    let org_id = checkout_org(pool, provider.name(), &reference).await?;
                    upsert_reconciliation_issue(
                        pool,
                        org_id.as_deref(),
                        provider.name(),
                        "transaction",
                        &reference,
                        "reference_mismatch",
                        serde_json::json!({"expected": reference, "received": transaction.reference}),
                    )
                    .await?;
                    result.failed += 1;
                }
            }
            Err(error) => {
                let org_id = checkout_org(pool, provider.name(), &reference).await?;
                upsert_reconciliation_issue(
                    pool,
                    org_id.as_deref(),
                    provider.name(),
                    "transaction",
                    &reference,
                    "verification_failed",
                    serde_json::json!({"error": error.to_string()}),
                )
                .await?;
                result.failed += 1;
            }
        }
    }

    let subscriptions = sqlx::query_as::<_, (String, String, String, bool)>(
        r#"
        SELECT id, "orgId", "providerSubscriptionId", "cancelAtPeriodEnd"
        FROM "OrganizationSubscription"
        WHERE provider = $1 AND "providerSubscriptionId" IS NOT NULL
          AND status IN (
            'ACTIVE'::"OrganizationSubscriptionStatus",
            'PAST_DUE'::"OrganizationSubscriptionStatus",
            'GRACE'::"OrganizationSubscriptionStatus"
          )
        ORDER BY "updatedAt" ASC LIMIT $2
    "#,
    )
    .bind(provider.name())
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await?;
    result.subscriptions_checked = subscriptions.len();

    for (subscription_row_id, org_id, subscription_id, cancel_at_period_end) in subscriptions {
        match provider.verify_subscription(&subscription_id).await {
            Ok(verified) => {
                if let Some(provider_invoice_id) = verified.provider_invoice_id.as_deref() {
                    sqlx::query(
                        r#"
                        UPDATE "BillingInvoice"
                        SET "providerInvoiceId" = $1, "updatedAt" = NOW()
                        WHERE "subscriptionId" = $2 AND provider = $3
                          AND "providerInvoiceId" IS NULL
                        "#,
                    )
                    .bind(provider_invoice_id)
                    .bind(&subscription_row_id)
                    .bind(provider.name())
                    .execute(pool)
                    .await?;
                }
                let Some((status, provider_cancel_at_period_end)) =
                    internal_subscription_state(&verified.state)
                else {
                    upsert_reconciliation_issue(
                        pool,
                        Some(&org_id),
                        provider.name(),
                        "subscription",
                        &subscription_id,
                        "unknown_provider_status",
                        serde_json::json!({"state": format!("{:?}", verified.state)}),
                    )
                    .await?;
                    result.failed += 1;
                    continue;
                };

                let current_status = sqlx::query_scalar::<_, String>(
                    r#"
                    SELECT status::text FROM "OrganizationSubscription" WHERE id = $1
                "#,
                )
                .bind(&subscription_row_id)
                .fetch_one(pool)
                .await?;
                if current_status != status || cancel_at_period_end != provider_cancel_at_period_end
                {
                    upsert_reconciliation_issue(
                        pool,
                        Some(&org_id),
                        provider.name(),
                        "subscription",
                        &subscription_id,
                        "state_mismatch",
                        serde_json::json!({
                            "internalStatus": current_status,
                            "providerState": format!("{:?}", verified.state),
                            "correctedStatus": status,
                        }),
                    )
                    .await?;
                    sqlx::query(r#"
                        UPDATE "OrganizationSubscription"
                        SET status = CAST($2 AS "OrganizationSubscriptionStatus"),
                            "cancelAtPeriodEnd" = $3,
                            "currentPeriodStart" = COALESCE($4, "currentPeriodStart"),
                            "currentPeriodEnd" = COALESCE($5, "currentPeriodEnd"),
                            "cancelledAt" = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE "cancelledAt" END,
                            "updatedAt" = NOW()
                        WHERE id = $1
                    "#)
                    .bind(&subscription_row_id)
                    .bind(status)
                    .bind(provider_cancel_at_period_end)
                    .bind(verified.current_period_start)
                    .bind(verified.current_period_end)
                    .execute(pool)
                    .await?;
                    result.subscriptions_updated += 1;
                } else {
                    resolve_reconciliation_issue(
                        pool,
                        provider.name(),
                        "subscription",
                        &subscription_id,
                        "state_mismatch",
                    )
                    .await?;
                }
                resolve_reconciliation_issue(
                    pool,
                    provider.name(),
                    "subscription",
                    &subscription_id,
                    "verification_failed",
                )
                .await?;
            }
            Err(error) => {
                upsert_reconciliation_issue(
                    pool,
                    Some(&org_id),
                    provider.name(),
                    "subscription",
                    &subscription_id,
                    "verification_failed",
                    serde_json::json!({"error": error.to_string()}),
                )
                .await?;
                result.failed += 1;
            }
        }
    }
    result.open_issues = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)::bigint FROM "BillingReconciliationIssue"
        WHERE provider = $1 AND status = 'OPEN'
    "#,
    )
    .bind(provider.name())
    .fetch_one(pool)
    .await?;
    Ok(result)
}

pub async fn get_billing_summary(pool: &PgPool, org_id: &str) -> Result<BillingSummary, AppError> {
    let billing_enforced = billing_enforcement_enabled();
    let products = sqlx::query_as::<_, ProductRow>(
        r#"
        SELECT key, name, description
        FROM "Product"
        WHERE active = true
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let entitlement_rows = sqlx::query_as::<_, EntitlementRow>(
        r#"
        SELECT key, value
        FROM "OrganizationEntitlementGrant"
        WHERE "orgId" = $1
          AND "startsAt" <= NOW()
          AND ("endsAt" IS NULL OR "endsAt" > NOW())
        UNION ALL
        SELECT entitlement.key, entitlement.value
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        JOIN "PlanEntitlement" entitlement ON entitlement."planId" = plan.id
        WHERE subscription."orgId" = $1
          AND subscription.status IN ('TRIAL'::"OrganizationSubscriptionStatus", 'ACTIVE'::"OrganizationSubscriptionStatus", 'GRACE'::"OrganizationSubscriptionStatus")
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    let mut entitlements = HashMap::<String, Value>::new();
    for entitlement in entitlement_rows {
        let value = merge_entitlement_value(entitlements.get(&entitlement.key), entitlement.value);
        entitlements.insert(entitlement.key, value);
    }
    let features = CAPABILITY_DEFINITIONS
        .iter()
        .map(|definition| CapabilityAccess {
            key: definition.key.to_string(),
            name: definition.name.to_string(),
            description: definition.description.to_string(),
            enabled: !billing_enforced || entitlement_allows_capability(&entitlements, definition),
        })
        .collect();

    let subscription_rows = sqlx::query_as::<_, SubscriptionRow>(
        r#"
        SELECT subscription.id, product.key AS "productKey", plan.name AS "planName", subscription.status::text AS status,
               subscription."currentPeriodStart" AT TIME ZONE 'UTC' AS "currentPeriodStart",
               subscription."currentPeriodEnd" AT TIME ZONE 'UTC' AS "currentPeriodEnd",
               subscription."trialEndsAt" AT TIME ZONE 'UTC' AS "trialEndsAt",
               subscription."cancelAtPeriodEnd" AS "cancelAtPeriodEnd"
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE subscription."orgId" = $1
        ORDER BY subscription."createdAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    let mut subscriptions = HashMap::<String, SubscriptionRow>::new();
    for subscription in subscription_rows {
        subscriptions
            .entry(subscription.product_key.clone())
            .or_insert(subscription);
    }

    let usage_rows = sqlx::query_as::<_, UsageRow>(
        r#"
        SELECT "productKey", "metricKey", COALESCE(SUM(quantity), 0)::bigint AS quantity
        FROM "UsageEvent"
        WHERE "orgId" = $1
          AND "occurredAt" >= date_trunc('month', NOW())
        GROUP BY "productKey", "metricKey"
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;

    let mut usage_by_product = HashMap::<String, HashMap<String, i64>>::new();
    let mut usage_by_meter = HashMap::<String, i64>::new();
    for usage in usage_rows {
        if let Some(meter_key) = canonical_meter_key(&usage.product_key, &usage.metric_key) {
            *usage_by_meter.entry(meter_key.to_string()).or_default() += usage.quantity;
        }
        usage_by_product
            .entry(usage.product_key)
            .or_default()
            .insert(usage.metric_key, usage.quantity);
    }
    let meters = METER_DEFINITIONS
        .iter()
        .map(|definition| {
            let current_key = format!("limit.{}", definition.key);
            let legacy_limit = legacy_meter(definition.key).and_then(|(product, metric)| {
                entitlements
                    .get(&format!("limit.{product}.{metric}"))
                    .and_then(Value::as_i64)
            });
            MeterUsage {
                key: definition.key.to_string(),
                name: definition.name.to_string(),
                description: definition.description.to_string(),
                used: usage_by_meter.remove(definition.key).unwrap_or_default(),
                limit: if billing_enforced {
                    entitlements
                        .get(&current_key)
                        .and_then(Value::as_i64)
                        .or(legacy_limit)
                } else {
                    None
                },
            }
        })
        .collect();

    let products = products
        .into_iter()
        .map(|product| {
            let access_key = format!("product.{}.enabled", product.key);
            let grant_allows_access = entitlements
                .get(&access_key)
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let subscription = subscriptions.remove(&product.key);
            let limit_prefix = format!("limit.{}.", product.key);
            let limits = entitlements
                .iter()
                .filter_map(|(key, value)| {
                    key.strip_prefix(&limit_prefix)
                        .and_then(|metric| value.as_i64().map(|limit| (metric.to_string(), limit)))
                })
                .collect();
            let has_access = !billing_enforced
                || grant_allows_access
                || subscription
                    .as_ref()
                    .is_some_and(|item| subscription_grants_access(&item.status));
            let state = if has_access {
                "enabled"
            } else {
                "upgrade_required"
            }
            .to_string();

            ProductAccess {
                key: product.key.clone(),
                name: product.name,
                description: product.description,
                has_access,
                state,
                plan_name: subscription.as_ref().map(|item| item.plan_name.clone()),
                subscription_status: subscription.as_ref().map(|item| item.status.clone()),
                subscription_id: subscription.as_ref().map(|item| item.id.clone()),
                current_period_start: subscription
                    .as_ref()
                    .and_then(|item| item.current_period_start),
                current_period_end: subscription
                    .as_ref()
                    .and_then(|item| item.current_period_end.clone()),
                trial_ends_at: subscription
                    .as_ref()
                    .and_then(|item| item.trial_ends_at.clone()),
                cancel_at_period_end: subscription
                    .as_ref()
                    .map(|item| item.cancel_at_period_end)
                    .unwrap_or(false),
                usage: usage_by_product.remove(&product.key).unwrap_or_default(),
                limits,
            }
        })
        .collect();

    let manual_grants = list_manual_grants(pool, org_id)
        .await?
        .into_iter()
        .filter(|grant| grant.ends_at.is_none_or(|ends_at| ends_at > Utc::now()))
        .collect();
    let payments = sqlx::query_as::<_, PaymentHistoryItem>(
        r#"
        SELECT checkout.reference, product.name AS product_name, plan.name AS plan_name,
               checkout.status, plan.currency, plan."amountMinor" AS amount_minor,
               checkout."completedAt" AT TIME ZONE 'UTC' AS completed_at,
               checkout."createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "BillingCheckout" checkout
        JOIN "ProductPlan" plan ON plan.id = checkout."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE checkout."orgId" = $1
        ORDER BY checkout."createdAt" DESC LIMIT 25
    "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    let invoices = sqlx::query_as::<_, BillingInvoiceItem>(
        r#"
        SELECT invoice."invoiceNumber" AS invoice_number, product.name AS product_name,
               plan.name AS plan_name, invoice.status, invoice.currency,
               invoice."amountMinor" AS amount_minor,
               invoice."issuedAt" AT TIME ZONE 'UTC' AS issued_at,
               invoice."paidAt" AT TIME ZONE 'UTC' AS paid_at
        FROM "BillingInvoice" invoice
        JOIN "BillingCheckout" checkout ON checkout.id = invoice."checkoutId"
        JOIN "ProductPlan" plan ON plan.id = checkout."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE invoice."orgId" = $1
        ORDER BY invoice."issuedAt" DESC LIMIT 25
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    Ok(BillingSummary {
        org_id: org_id.to_string(),
        features,
        meters,
        products,
        manual_grants,
        payments,
        invoices,
    })
}

pub async fn get_billing_usage(
    pool: &PgPool,
    org_id: &str,
    days: i64,
) -> Result<BillingUsage, AppError> {
    let days = days.clamp(7, 90);
    let now = Utc::now();
    let timezone = sqlx::query_scalar::<_, String>(
        r#"
        SELECT CASE
                 WHEN EXISTS (
                     SELECT 1 FROM pg_timezone_names
                     WHERE name = COALESCE(NULLIF("reportingTimezone", ''), 'UTC')
                 ) THEN COALESCE(NULLIF("reportingTimezone", ''), 'UTC')
                 ELSE 'UTC'
               END
        FROM "Organization"
        WHERE id = $1
        "#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .unwrap_or_else(|| "UTC".to_string());
    let local_today = sqlx::query_scalar::<_, NaiveDate>(r#"SELECT (NOW() AT TIME ZONE $1)::date"#)
        .bind(&timezone)
        .fetch_one(pool)
        .await?;
    let first_day = local_today - Duration::days(days - 1);
    let range_start = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"
        SELECT (((NOW() AT TIME ZONE $1)::date - $2)::timestamp AT TIME ZONE $1)
        "#,
    )
    .bind(&timezone)
    .bind((days - 1) as i32)
    .fetch_one(pool)
    .await?;

    // CreditUsageEvent is the source of truth for AI/credit consumption. It is
    // intentionally separate from UsageEvent, which records non-AI workspace
    // activity such as publishing and campaign recipients.
    let daily_credit_rows = sqlx::query_as::<_, DailyCreditUsageRow>(
        r#"
        SELECT (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $4)::date AS date,
               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used
        FROM "CreditUsageEvent"
        WHERE "orgId" = $1
          AND status = 'COMPLETED'
          AND "createdAt" >= $2
          AND "createdAt" <= $3
        GROUP BY 1
        ORDER BY 1 ASC
        "#,
    )
    .bind(org_id)
    .bind(range_start)
    .bind(now)
    .bind(&timezone)
    .fetch_all(pool)
    .await?;

    let daily_meter_rows = sqlx::query_as::<_, DailyMeterUsageRow>(
        r#"
        SELECT (("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE $3)::date AS date,
               COALESCE(SUM(quantity), 0)::bigint AS operations
        FROM "UsageEvent"
        WHERE "orgId" = $1
          AND "occurredAt" >= $2
          AND "occurredAt" <= $4
        GROUP BY 1
        ORDER BY 1 ASC
        "#,
    )
    .bind(org_id)
    .bind(range_start)
    .bind(&timezone)
    .bind(now)
    .fetch_all(pool)
    .await?;
    let daily = build_daily_usage(first_day, days, daily_credit_rows, daily_meter_rows);

    // The previous period is returned for a real comparison line in the
    // client. It uses the same sources and duration as the selected period.
    let previous_range_start = range_start - Duration::days(days);
    let previous_first_day = first_day - Duration::days(days);
    let previous_credit_rows = sqlx::query_as::<_, DailyCreditUsageRow>(
        r#"
        SELECT (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $4)::date AS date,
               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used
        FROM "CreditUsageEvent"
        WHERE "orgId" = $1
          AND status = 'COMPLETED'
          AND "createdAt" >= $2
          AND "createdAt" < $3
        GROUP BY 1
        ORDER BY 1 ASC
        "#,
    )
    .bind(org_id)
    .bind(previous_range_start)
    .bind(range_start)
    .bind(&timezone)
    .fetch_all(pool)
    .await?;
    let previous_meter_rows = sqlx::query_as::<_, DailyMeterUsageRow>(
        r#"
        SELECT (("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE $3)::date AS date,
               COALESCE(SUM(quantity), 0)::bigint AS operations
        FROM "UsageEvent"
        WHERE "orgId" = $1
          AND "occurredAt" >= $2
          AND "occurredAt" < $4
        GROUP BY 1
        ORDER BY 1 ASC
        "#,
    )
    .bind(org_id)
    .bind(previous_range_start)
    .bind(&timezone)
    .bind(range_start)
    .fetch_all(pool)
    .await?;
    let previous_daily = build_daily_usage(
        previous_first_day,
        days,
        previous_credit_rows,
        previous_meter_rows,
    );

    let breakdown = sqlx::query_as::<_, CreditUsageBreakdownRow>(
        r#"
        SELECT "actionKey" AS action_key,
               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used,
               COUNT(*)::bigint AS operations
        FROM "CreditUsageEvent"
        WHERE "orgId" = $1
          AND status = 'COMPLETED'
          AND "createdAt" >= $2
          AND "createdAt" <= $3
        GROUP BY "actionKey"
        ORDER BY credits_used DESC, action_key ASC
        "#,
    )
    .bind(org_id)
    .bind(range_start)
    .bind(now)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| CreditUsageBreakdown {
        key: row.action_key,
        credits_used: row.credits_used,
        operations: row.operations,
    })
    .collect::<Vec<_>>();

    Ok(BillingUsage {
        range_start,
        range_end: now,
        timezone,
        granularity: "day".to_string(),
        credits_used: daily.iter().map(|day| day.credits_used).sum(),
        operations: daily.iter().map(|day| day.operations).sum(),
        daily,
        previous_daily,
        breakdown,
    })
}

pub async fn set_subscription_enabled(
    pool: &PgPool,
    provider: &dyn BillingProvider,
    org_id: &str,
    subscription_id: &str,
    enabled: bool,
) -> Result<(), AppError> {
    let provider_subscription_id = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT "providerSubscriptionId" FROM "OrganizationSubscription"
        WHERE id = $1 AND "orgId" = $2 AND provider = $3
    "#,
    )
    .bind(subscription_id)
    .bind(org_id)
    .bind(provider.name())
    .fetch_optional(pool)
    .await?
    .flatten()
    .ok_or_else(|| AppError::NotFound("Provider subscription not found".to_string()))?;
    provider
        .set_subscription_enabled(&provider_subscription_id, enabled)
        .await?;
    sqlx::query(
        r#"
        UPDATE "OrganizationSubscription" SET "cancelAtPeriodEnd" = $2,
          status = CASE WHEN $3 THEN 'ACTIVE'::"OrganizationSubscriptionStatus" ELSE status END,
          "cancelledAt" = CASE WHEN $3 THEN NULL ELSE "cancelledAt" END, "updatedAt" = NOW()
        WHERE id = $1 AND "orgId" = $4
    "#,
    )
    .bind(subscription_id)
    .bind(!enabled)
    .bind(enabled)
    .bind(org_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn entitlement_allows_capability(
    entitlements: &HashMap<String, Value>,
    definition: &CapabilityDefinition,
) -> bool {
    entitlements
        .get(definition.key)
        .and_then(Value::as_bool)
        .or_else(|| {
            entitlements
                .get(definition.legacy_entitlement)
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

/// Commercial feature and meter enforcement is intentionally disabled during the
/// controlled Agent Platform testing phase. Usage is still recorded, while auth,
/// organization isolation, runtime limits, approvals, and provider safety checks
/// remain enforced elsewhere.
fn billing_enforcement_enabled() -> bool {
    env::var("KASITEK_BILLING_ENFORCEMENT")
        .ok()
        .as_deref()
        .is_some_and(parse_enabled_flag)
}

fn parse_enabled_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn capability_definition(capability_key: &str) -> Option<&'static CapabilityDefinition> {
    CAPABILITY_DEFINITIONS
        .iter()
        .find(|definition| definition.key == capability_key)
}

async fn capability_is_enabled(
    pool: &PgPool,
    org_id: &str,
    definition: &CapabilityDefinition,
) -> Result<bool, AppError> {
    let enabled = sqlx::query_scalar::<_, bool>(
        r#"
        WITH candidate AS (
          SELECT key, value
          FROM "OrganizationEntitlementGrant"
          WHERE "orgId" = $1
            AND key = ANY(ARRAY[$2, $3])
            AND "startsAt" <= NOW()
            AND ("endsAt" IS NULL OR "endsAt" > NOW())
            AND jsonb_typeof(value) = 'boolean'
          UNION ALL
          SELECT entitlement.key, entitlement.value
          FROM "OrganizationSubscription" subscription
          JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"
          WHERE subscription."orgId" = $1
            AND entitlement.key = ANY(ARRAY[$2, $3])
            AND subscription.status IN (
              'TRIAL'::"OrganizationSubscriptionStatus",
              'ACTIVE'::"OrganizationSubscriptionStatus",
              'GRACE'::"OrganizationSubscriptionStatus"
            )
            AND jsonb_typeof(entitlement.value) = 'boolean'
        ),
        current_value AS (
          SELECT bool_or((value #>> '{}')::boolean) AS enabled
          FROM candidate WHERE key = $2
        ),
        legacy_value AS (
          SELECT bool_or((value #>> '{}')::boolean) AS enabled
          FROM candidate WHERE key = $3
        )
        SELECT COALESCE(
          (SELECT enabled FROM current_value),
          (SELECT enabled FROM legacy_value),
          false
        )
        "#,
    )
    .bind(org_id)
    .bind(definition.key)
    .bind(definition.legacy_entitlement)
    .fetch_one(pool)
    .await?;
    Ok(enabled)
}

pub async fn require_capability(
    pool: &PgPool,
    org_id: &str,
    capability_key: &str,
) -> Result<(), AppError> {
    let definition = capability_definition(capability_key)
        .ok_or_else(|| AppError::Internal(format!("Unknown capability: {capability_key}")))?;
    if !billing_enforcement_enabled() {
        return Ok(());
    }
    if capability_is_enabled(pool, org_id, definition).await? {
        return Ok(());
    }
    Err(AppError::Forbidden(format!(
        "{} is not included in this workspace's current plan",
        definition.name
    )))
}

fn legacy_meter(meter_key: &str) -> Option<(&'static str, &'static str)> {
    match meter_key {
        meters::AGENT_DEPLOYMENTS => Some(("agents", "deployments")),
        meters::CAMPAIGN_RECIPIENTS => Some(("reach", "campaign_recipients")),
        meters::SOCIAL_PUBLISHES => Some(("social", "publishes")),
        _ => None,
    }
}

fn canonical_meter_key(product_key: &str, metric_key: &str) -> Option<&'static str> {
    if product_key == "workspace" {
        return METER_DEFINITIONS
            .iter()
            .find(|definition| definition.key == metric_key)
            .map(|definition| definition.key);
    }
    METER_DEFINITIONS
        .iter()
        .find(|definition| {
            legacy_meter(definition.key).is_some_and(|legacy| legacy == (product_key, metric_key))
        })
        .map(|definition| definition.key)
}

pub async fn meter_limit(
    pool: &PgPool,
    org_id: &str,
    meter_key: &str,
) -> Result<Option<i64>, AppError> {
    if !billing_enforcement_enabled() {
        return Ok(None);
    }
    let current_key = format!("limit.{meter_key}");
    let legacy_key = legacy_meter(meter_key)
        .map(|(product, metric)| format!("limit.{product}.{metric}"))
        .unwrap_or_default();
    sqlx::query_scalar::<_, Option<i64>>(r#"
        WITH candidate AS (
          SELECT key, value FROM "OrganizationEntitlementGrant"
          WHERE "orgId" = $1 AND key = ANY(ARRAY[$2, $3]) AND "startsAt" <= NOW()
            AND ("endsAt" IS NULL OR "endsAt" > NOW()) AND jsonb_typeof(value) = 'number'
          UNION ALL
          SELECT entitlement.key, entitlement.value
          FROM "OrganizationSubscription" subscription
          JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"
          WHERE subscription."orgId" = $1 AND entitlement.key = ANY(ARRAY[$2, $3])
            AND subscription.status IN ('TRIAL'::"OrganizationSubscriptionStatus", 'ACTIVE'::"OrganizationSubscriptionStatus", 'GRACE'::"OrganizationSubscriptionStatus")
            AND jsonb_typeof(entitlement.value) = 'number'
        ),
        current_value AS (
          SELECT MAX((value #>> '{}')::bigint) AS value FROM candidate WHERE key = $2
        ),
        legacy_value AS (
          SELECT MAX((value #>> '{}')::bigint) AS value FROM candidate WHERE key = $3
        )
        SELECT COALESCE(
          (SELECT value FROM current_value),
          (SELECT value FROM legacy_value)
        )
    "#).bind(org_id).bind(current_key).bind(legacy_key).fetch_one(pool).await.map_err(AppError::from)
}

pub async fn require_meter_available(
    pool: &PgPool,
    org_id: &str,
    meter_key: &str,
    quantity: i64,
) -> Result<(), AppError> {
    let Some(limit) = meter_limit(pool, org_id, meter_key).await? else {
        return Ok(());
    };
    let legacy = legacy_meter(meter_key);
    let used = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(quantity), 0)::bigint FROM "UsageEvent"
        WHERE "orgId" = $1
          AND (
            ("productKey" = 'workspace' AND "metricKey" = $2)
            OR ("productKey" = $3 AND "metricKey" = $4)
          )
          AND "occurredAt" >= date_trunc('month', NOW())
    "#,
    )
    .bind(org_id)
    .bind(meter_key)
    .bind(legacy.map(|item| item.0).unwrap_or(""))
    .bind(legacy.map(|item| item.1).unwrap_or(""))
    .fetch_one(pool)
    .await?;
    if used.saturating_add(quantity) > limit {
        return Err(AppError::Forbidden(format!(
            "The {meter_key} monthly limit for this workspace has been reached"
        )));
    }
    Ok(())
}

pub async fn record_meter_usage(
    pool: &PgPool,
    org_id: &str,
    meter_key: &str,
    quantity: i32,
    source_type: &str,
    source_id: &str,
    idempotency_key: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query(r#"
        INSERT INTO "UsageEvent" (id, "orgId", "productKey", "metricKey", quantity, "sourceType", "sourceId", "idempotencyKey", "occurredAt", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT ("idempotencyKey") DO NOTHING
    "#)
    .bind(cuid2::create_id()).bind(org_id).bind("workspace").bind(meter_key).bind(quantity)
    .bind(source_type).bind(source_id).bind(idempotency_key).execute(pool).await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_provider_subscription_states_without_granting_unknown_states() {
        assert_eq!(
            internal_subscription_state(&ProviderSubscriptionState::Active),
            Some(("ACTIVE", false))
        );
        assert_eq!(
            internal_subscription_state(&ProviderSubscriptionState::NonRenewing),
            Some(("ACTIVE", true))
        );
        assert_eq!(
            internal_subscription_state(&ProviderSubscriptionState::Attention),
            Some(("PAST_DUE", false))
        );
        assert_eq!(
            internal_subscription_state(&ProviderSubscriptionState::Completed),
            Some(("CANCELLED", false))
        );
        assert_eq!(
            internal_subscription_state(&ProviderSubscriptionState::Unknown("paused".to_string())),
            None
        );
        assert!(subscription_grants_access("TRIAL"));
        assert!(subscription_grants_access("ACTIVE"));
        assert!(subscription_grants_access("GRACE"));
        assert!(!subscription_grants_access("PAST_DUE"));
        assert!(!subscription_grants_access("CANCELLED"));
        assert!(!subscription_grants_access("SUSPENDED"));

        assert_eq!(
            merge_entitlement_value(Some(&Value::Bool(true)), Value::Bool(false)),
            Value::Bool(true)
        );
        assert_eq!(
            merge_entitlement_value(Some(&Value::from(10)), Value::from(25)),
            Value::from(25)
        );
        assert_eq!(
            merge_entitlement_value(Some(&Value::from(50)), Value::from(25)),
            Value::from(50)
        );
    }

    #[test]
    fn resolves_capabilities_from_new_keys_before_legacy_keys() {
        let definition = capability_definition(capabilities::CONTENT_PUBLISH).unwrap();
        let mut entitlements =
            HashMap::from([("product.social.enabled".to_string(), Value::Bool(true))]);
        assert!(entitlement_allows_capability(&entitlements, definition));

        entitlements.insert(
            capabilities::CONTENT_PUBLISH.to_string(),
            Value::Bool(false),
        );
        assert!(!entitlement_allows_capability(&entitlements, definition));
    }

    #[test]
    fn billing_enforcement_only_turns_on_for_explicit_truthy_values() {
        assert!(parse_enabled_flag("true"));
        assert!(parse_enabled_flag(" ON "));
        assert!(parse_enabled_flag("1"));
        assert!(!parse_enabled_flag("false"));
        assert!(!parse_enabled_flag("off"));
        assert!(!parse_enabled_flag(""));
    }

    #[test]
    fn maps_legacy_usage_to_workspace_meters() {
        assert_eq!(
            canonical_meter_key("reach", "campaign_recipients"),
            Some(meters::CAMPAIGN_RECIPIENTS)
        );
        assert_eq!(
            canonical_meter_key("workspace", meters::SOCIAL_PUBLISHES),
            Some(meters::SOCIAL_PUBLISHES)
        );
        assert_eq!(canonical_meter_key("reach", "unknown"), None);
    }

    #[test]
    fn recurring_invoice_numbers_are_deterministic() {
        assert_eq!(
            recurring_invoice_number("paystack", "charge_123"),
            "KS-paystack-charge_123"
        );
        assert_eq!(
            recurring_invoice_number("paystack", "charge_123"),
            recurring_invoice_number("paystack", "charge_123")
        );
        assert_ne!(
            recurring_invoice_number("paystack", "charge_123"),
            recurring_invoice_number("paystack", "charge_456")
        );
    }
}
