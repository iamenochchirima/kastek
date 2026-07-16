use crate::config::AppConfig;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;

use crate::error::AppError;

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
    #[sqlx(rename = "productKey")]
    product_key: String,
    #[sqlx(rename = "planName")]
    plan_name: String,
    status: String,
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
    #[serde(rename = "currentPeriodEnd")]
    pub current_period_end: Option<DateTime<Utc>>,
    #[serde(rename = "trialEndsAt")]
    pub trial_ends_at: Option<DateTime<Utc>>,
    #[serde(rename = "cancelAtPeriodEnd")]
    pub cancel_at_period_end: bool,
    pub usage: HashMap<String, i64>,
}

#[derive(Debug, Serialize)]
pub struct BillingSummary {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub products: Vec<ProductAccess>,
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

#[derive(Debug, Deserialize)]
struct PaystackInitializeResponse {
    status: bool,
    message: String,
    data: Option<PaystackCheckoutData>,
}
#[derive(Debug, Deserialize)]
struct PaystackCheckoutData {
    authorization_url: String,
    reference: String,
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

pub async fn create_paystack_checkout(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    email: &str,
    plan_key: &str,
) -> Result<Value, AppError> {
    let secret = config
        .paystack_secret_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Paystack checkout is not configured".to_string()))?;
    let plan = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT plan."paystackPlanCode", product.key, plan.name
        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"
        WHERE plan.key = $1 AND plan.active = true AND product.active = true
    "#,
    )
    .bind(plan_key)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Active plan not found".to_string()))?;
    let (paystack_plan_code, product_key, plan_name) = plan;
    if paystack_plan_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "This plan is not connected to Paystack yet".to_string(),
        ));
    }
    let reference = format!("ks_{}", cuid2::create_id());
    let callback_url = format!(
        "{}/billing?payment=complete",
        config.frontend_url.trim_end_matches('/')
    );
    let response = reqwest::Client::new().post("https://api.paystack.co/transaction/initialize")
        .bearer_auth(secret).json(&serde_json::json!({"email": email, "plan": paystack_plan_code, "reference": reference, "callback_url": callback_url, "metadata": {"orgId": org_id, "planKey": plan_key, "productKey": product_key}})).send().await?;
    let body: PaystackInitializeResponse = response.json().await?;
    let data = body
        .data
        .filter(|_| body.status)
        .ok_or_else(|| AppError::BadRequest(body.message))?;
    Ok(
        serde_json::json!({"authorizationUrl": data.authorization_url, "reference": data.reference, "planName": plan_name}),
    )
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
        let value = match (entitlements.get(&entitlement.key), &entitlement.value) {
            // Multiple valid grants should be additive. A stale or narrower false grant must not
            // turn off access provided by an active plan or another grant.
            (Some(Value::Bool(existing)), Value::Bool(next)) => Value::Bool(*existing || *next),
            _ => entitlement.value,
        };
        entitlements.insert(entitlement.key, value);
    }

    let subscription_rows = sqlx::query_as::<_, SubscriptionRow>(
        r#"
        SELECT product.key AS "productKey", plan.name AS "planName", subscription.status::text AS status,
               subscription."currentPeriodEnd" AT TIME ZONE 'UTC' AS "currentPeriodEnd",
               subscription."trialEndsAt" AT TIME ZONE 'UTC' AS "trialEndsAt",
               subscription."cancelAtPeriodEnd" AS "cancelAtPeriodEnd"
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE subscription."orgId" = $1
          AND subscription.status IN ('TRIAL'::"OrganizationSubscriptionStatus", 'ACTIVE'::"OrganizationSubscriptionStatus", 'GRACE'::"OrganizationSubscriptionStatus")
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
            let has_access = grant_allows_access || subscription.is_some();
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
            }
        })
        .collect();

    Ok(BillingSummary {
        org_id: org_id.to_string(),
        products,
    })
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
