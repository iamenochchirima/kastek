use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;

use crate::error::AppError;
use crate::services::billing_provider::{
    BillingProvider, CheckoutRequest, ProviderEvent, ProviderSubscriptionState,
};

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
pub struct BillingSummary {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub products: Vec<ProductAccess>,
    #[serde(rename = "manualGrants")]
    pub manual_grants: Vec<ManualGrant>,
    pub payments: Vec<PaymentHistoryItem>,
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
    let key = key.trim();
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

#[derive(Debug, Serialize, FromRow)]
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
    #[serde(rename = "checkoutReady")]
    pub checkout_ready: bool,
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
    let result = sqlx::query(r#"
        INSERT INTO "PaystackWebhookEvent" (id, "eventKey", "eventType", payload, status, "receivedAt")
        VALUES ($1, $2, $3, $4, 'RECEIVED', NOW()) ON CONFLICT ("eventKey") DO NOTHING
    "#).bind(cuid2::create_id()).bind(event_key).bind(event_type).bind(event).execute(pool).await?;
    Ok(result.rows_affected() == 1)
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
        WHERE "eventKey" = $1
    "#,
    )
    .bind(event_key)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn process_provider_event(
    pool: &PgPool,
    provider_name: &str,
    event: ProviderEvent,
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
            update_subscription_status(pool, provider_name, &subscription_id, "CANCELLED", false)
                .await
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
                serde_json::json!({"reference": transaction_reference}),
            )
            .await?;
            Ok(true)
        }
        ProviderEvent::ChargeSucceeded {
            reference,
            customer_id,
            subscription_id,
        } => {
            activate_checkout(
                pool,
                provider_name,
                &reference,
                customer_id.as_deref(),
                subscription_id.as_deref(),
            )
            .await
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
    .bind(checkout_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
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
    .bind(subscription_id)
    .bind(status)
    .bind(cancel_at_period_end)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn activate_checkout(
    pool: &PgPool,
    provider_name: &str,
    reference: &str,
    customer_id: Option<&str>,
    subscription_id: Option<&str>,
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
        tx.commit().await?;
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
          id, "orgId", "planId", status, "startedAt", "currentPeriodStart",
          "cancelAtPeriodEnd", provider, "providerCustomerId", "providerSubscriptionId", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, 'ACTIVE'::"OrganizationSubscriptionStatus", NOW(), NOW(), false, $4, $5, $6, NOW(), NOW())
        ON CONFLICT ("providerSubscriptionId") DO UPDATE SET
          status = 'ACTIVE'::"OrganizationSubscriptionStatus", "cancelledAt" = NULL, "updatedAt" = NOW()
    "#).bind(cuid2::create_id()).bind(&org_id).bind(&plan_id).bind(provider_name).bind(customer_id)
    .bind(&provider_subscription_id).execute(&mut *tx).await?;

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
    .bind(checkout_id)
    .bind(customer_id)
    .bind(&provider_subscription_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn list_available_plans(pool: &PgPool) -> Result<Vec<AvailablePlan>, AppError> {
    sqlx::query_as::<_, AvailablePlan>(
        r#"
        SELECT plan.key, product.key AS product_key, plan.name, plan.interval::text AS interval,
               plan.currency, plan."amountMinor" AS amount_minor,
               (plan."paystackPlanCode" IS NOT NULL) AS checkout_ready
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.active = true AND product.active = true
        ORDER BY product.name, plan.name
    "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
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
            bool,
            Option<String>,
        ),
    >(
        r#"
        SELECT plan.key, product.key, plan.name, plan.interval::text, plan.currency,
               plan."amountMinor", plan.active, plan."paystackPlanCode"
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        ORDER BY product.name, plan.name
    "#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(key, product_key, name, interval, currency, amount_minor, active, paystack_plan_code)| {
            serde_json::json!({
                "key": key, "productKey": product_key, "name": name, "interval": interval,
                "currency": currency, "amountMinor": amount_minor, "active": active,
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
    Ok(serde_json::json!({"products": products, "plans": plans, "entitlements": entitlements}))
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
    if amount_minor.is_some_and(|amount| amount < 0) || name.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Plan name and a non-negative amount are required".to_string(),
        ));
    }
    let plan_code = paystack_plan_code
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let row = sqlx::query_as::<_, (String, String, String, String, Option<i32>, bool, Option<String>)>(r#"
        INSERT INTO "ProductPlan" (id, "productId", key, name, interval, currency, "amountMinor", active, "paystackPlanCode", "createdAt", "updatedAt")
        SELECT $1, product.id, $3, $4, CAST($5 AS "BillingInterval"), $6, $7, $8, $9, NOW(), NOW()
        FROM "Product" product WHERE product.key = $2
        ON CONFLICT (key) DO UPDATE SET "productId" = EXCLUDED."productId", name = EXCLUDED.name,
          interval = EXCLUDED.interval, currency = EXCLUDED.currency, "amountMinor" = EXCLUDED."amountMinor",
          active = EXCLUDED.active, "paystackPlanCode" = EXCLUDED."paystackPlanCode", "updatedAt" = NOW()
        RETURNING key, name, interval::text, currency, "amountMinor", active, "paystackPlanCode"
    "#)
    .bind(cuid2::create_id()).bind(product_key).bind(key).bind(name.trim()).bind(&interval)
    .bind(&currency).bind(amount_minor).bind(active).bind(plan_code).fetch_optional(pool).await?
    .ok_or_else(|| AppError::NotFound("Product not found".to_string()))?;
    Ok(
        serde_json::json!({"key": row.0, "name": row.1, "interval": row.2, "currency": row.3,
        "amountMinor": row.4, "active": row.5, "paystackPlanCode": row.6}),
    )
}

pub async fn upsert_plan_entitlement(
    pool: &PgPool,
    plan_key: &str,
    key: &str,
    value: Value,
) -> Result<Value, AppError> {
    let plan_key = validate_catalog_key(plan_key)?;
    let key = validate_catalog_key(key)?;
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
    let plan = sqlx::query_as::<_, (String, String, String, String)>(
        r#"
        SELECT plan.id, plan."paystackPlanCode", product.key, plan.name
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.key = $1 AND plan.active = true AND product.active = true
    "#,
    )
    .bind(plan_key)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Active plan not found".to_string()))?;
    let (plan_id, paystack_plan_code, product_key, plan_name) = plan;
    if paystack_plan_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "This plan is not connected to Paystack yet".to_string(),
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
        return Ok(CheckoutVerification {
            reference: reference.to_string(),
            status: "completed",
            activated: true,
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
        UPDATE "BillingCheckout" SET "providerResponse" = $3, "updatedAt" = NOW()
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
    }))
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
) -> Result<ReconciliationResult, AppError> {
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
    for usage in usage_rows {
        usage_by_product
            .entry(usage.product_key)
            .or_default()
            .insert(usage.metric_key, usage.quantity);
    }

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
            let has_access = grant_allows_access
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
    Ok(BillingSummary {
        org_id: org_id.to_string(),
        products,
        manual_grants,
        payments,
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

pub async fn require_product_access(
    pool: &PgPool,
    org_id: &str,
    product_key: &str,
) -> Result<(), AppError> {
    let summary = get_billing_summary(pool, org_id).await?;
    let product = summary
        .products
        .into_iter()
        .find(|product| product.key == product_key)
        .ok_or_else(|| AppError::NotFound("Product is not configured".to_string()))?;

    if product.has_access {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "{} requires an active plan or entitlement grant for this organisation",
            product.name
        )))
    }
}

pub async fn usage_limit(
    pool: &PgPool,
    org_id: &str,
    product_key: &str,
    metric_key: &str,
) -> Result<Option<i64>, AppError> {
    let entitlement_key = format!("limit.{product_key}.{metric_key}");
    sqlx::query_scalar::<_, Option<i64>>(r#"
        SELECT MAX((candidate.value #>> '{}')::bigint)
        FROM (
          SELECT value FROM "OrganizationEntitlementGrant"
          WHERE "orgId" = $1 AND key = $2 AND "startsAt" <= NOW()
            AND ("endsAt" IS NULL OR "endsAt" > NOW()) AND jsonb_typeof(value) = 'number'
          UNION ALL
          SELECT entitlement.value
          FROM "OrganizationSubscription" subscription
          JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"
          WHERE subscription."orgId" = $1 AND entitlement.key = $2
            AND subscription.status IN ('TRIAL'::"OrganizationSubscriptionStatus", 'ACTIVE'::"OrganizationSubscriptionStatus", 'GRACE'::"OrganizationSubscriptionStatus")
            AND jsonb_typeof(entitlement.value) = 'number'
        ) candidate
    "#).bind(org_id).bind(entitlement_key).fetch_one(pool).await.map_err(AppError::from)
}

pub async fn require_usage_available(
    pool: &PgPool,
    org_id: &str,
    product_key: &str,
    metric_key: &str,
    quantity: i64,
) -> Result<(), AppError> {
    let Some(limit) = usage_limit(pool, org_id, product_key, metric_key).await? else {
        return Ok(());
    };
    let used = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(quantity), 0)::bigint FROM "UsageEvent"
        WHERE "orgId" = $1 AND "productKey" = $2 AND "metricKey" = $3
          AND "occurredAt" >= date_trunc('month', NOW())
    "#,
    )
    .bind(org_id)
    .bind(product_key)
    .bind(metric_key)
    .fetch_one(pool)
    .await?;
    if used.saturating_add(quantity) > limit {
        return Err(AppError::Forbidden(format!(
            "The {product_key} {metric_key} monthly limit has been reached"
        )));
    }
    Ok(())
}

pub async fn record_usage(
    pool: &PgPool,
    org_id: &str,
    product_key: &str,
    metric_key: &str,
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
    .bind(cuid2::create_id()).bind(org_id).bind(product_key).bind(metric_key).bind(quantity)
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
}
