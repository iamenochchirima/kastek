use crate::config::AppConfig;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
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
    pub limits: HashMap<String, i64>,
}

#[derive(Debug, Serialize)]
pub struct BillingSummary {
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub products: Vec<ProductAccess>,
    #[serde(rename = "manualGrants")]
    pub manual_grants: Vec<ManualGrant>,
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

type HmacSha512 = Hmac<Sha512>;

pub fn verify_paystack_signature(secret: &str, payload: &[u8], signature: &str) -> bool {
    let Ok(signature) = hex::decode(signature.trim()) else {
        return false;
    };
    let Ok(mut mac) = HmacSha512::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(payload);
    mac.verify_slice(&signature).is_ok()
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

pub async fn process_paystack_webhook(pool: &PgPool, event: &Value) -> Result<bool, AppError> {
    let event_type = event.get("event").and_then(Value::as_str).unwrap_or("");
    let data = event
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::BadRequest("Paystack webhook data is missing".to_string()))?;
    let subscription_code = data
        .get("subscription_code")
        .and_then(Value::as_str)
        .or_else(|| {
            data.get("subscription")
                .and_then(Value::as_object)
                .and_then(|subscription| subscription.get("subscription_code"))
                .and_then(Value::as_str)
        });

    if event_type == "subscription.create" {
        let customer_code = data
            .get("customer")
            .and_then(Value::as_object)
            .and_then(|customer| customer.get("customer_code"))
            .and_then(Value::as_str);
        let plan_code = data
            .get("plan")
            .and_then(Value::as_object)
            .and_then(|plan| plan.get("plan_code"))
            .and_then(Value::as_str);
        let (Some(subscription_code), Some(customer_code), Some(plan_code)) =
            (subscription_code, customer_code, plan_code)
        else {
            return Ok(false);
        };
        let result = sqlx::query(r#"
            UPDATE "OrganizationSubscription" SET "providerSubscriptionId" = $1, status = 'ACTIVE'::"OrganizationSubscriptionStatus", "updatedAt" = NOW()
            WHERE id = (
              SELECT subscription.id FROM "OrganizationSubscription" subscription
              JOIN "ProductPlan" plan ON plan.id = subscription."planId"
              WHERE subscription.provider = 'paystack' AND subscription."providerCustomerId" = $2
                AND plan."paystackPlanCode" = $3
              ORDER BY subscription."createdAt" DESC LIMIT 1
            )
        "#).bind(subscription_code).bind(customer_code).bind(plan_code).execute(pool).await?;
        return Ok(result.rows_affected() == 1);
    }

    if matches!(
        event_type,
        "subscription.not_renew" | "subscription.disable" | "invoice.payment_failed"
    ) {
        let Some(subscription_code) = subscription_code else {
            return Ok(false);
        };
        let (status, cancel_at_period_end) = match event_type {
            "subscription.not_renew" => ("ACTIVE", true),
            "invoice.payment_failed" => ("PAST_DUE", false),
            _ => ("CANCELLED", false),
        };
        let result = sqlx::query(
            r#"
            UPDATE "OrganizationSubscription"
            SET status = CAST($2 AS "OrganizationSubscriptionStatus"), "cancelAtPeriodEnd" = $3,
                "cancelledAt" = CASE WHEN $2 = 'CANCELLED' THEN NOW() ELSE "cancelledAt" END,
                "updatedAt" = NOW()
            WHERE provider = 'paystack' AND "providerSubscriptionId" = $1
        "#,
        )
        .bind(subscription_code)
        .bind(status)
        .bind(cancel_at_period_end)
        .execute(pool)
        .await?;
        return Ok(result.rows_affected() == 1);
    }

    if event_type != "charge.success" {
        return Ok(false);
    }

    if data.get("status").and_then(Value::as_str) != Some("success") {
        return Ok(false);
    }
    let reference = data
        .get("reference")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Paystack reference is missing".to_string()))?;

    let mut tx = pool.begin().await?;
    let checkout = sqlx::query_as::<_, (String, String, String, String)>(
        r#"
        SELECT id, "orgId", "planId", status
        FROM "BillingCheckout"
        WHERE reference = $1 AND provider = 'paystack'
        FOR UPDATE
    "#,
    )
    .bind(reference)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((checkout_id, org_id, plan_id, status)) = checkout else {
        return Ok(false);
    };
    if status == "COMPLETED" {
        tx.commit().await?;
        return Ok(true);
    }

    let customer_code = data
        .get("customer")
        .and_then(Value::as_object)
        .and_then(|customer| customer.get("customer_code"))
        .and_then(Value::as_str);
    let subscription_code = data
        .get("subscription")
        .and_then(Value::as_object)
        .and_then(|subscription| subscription.get("subscription_code"))
        .and_then(Value::as_str)
        .or_else(|| data.get("subscription_code").and_then(Value::as_str));
    let provider_subscription_id = subscription_code
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("paystack-charge:{reference}"));

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
        ) VALUES ($1, $2, $3, 'ACTIVE'::"OrganizationSubscriptionStatus", NOW(), NOW(), false, 'paystack', $4, $5, NOW(), NOW())
        ON CONFLICT ("providerSubscriptionId") DO UPDATE SET
          status = 'ACTIVE'::"OrganizationSubscriptionStatus", "cancelledAt" = NULL, "updatedAt" = NOW()
    "#)
    .bind(cuid2::create_id()).bind(&org_id).bind(&plan_id).bind(customer_code)
    .bind(&provider_subscription_id).execute(&mut *tx).await?;

    sqlx::query(r#"
        UPDATE "BillingCheckout" SET status = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1
    "#).bind(checkout_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::verify_paystack_signature;
    use hmac::{Hmac, Mac};
    use sha2::Sha512;

    #[test]
    fn verifies_paystack_hmac_and_rejects_modified_payload() {
        let payload = br#"{"event":"charge.success"}"#;
        let mut mac = Hmac::<Sha512>::new_from_slice(b"secret").unwrap();
        mac.update(payload);
        let signature = hex::encode(mac.finalize().into_bytes());
        assert!(verify_paystack_signature("secret", payload, &signature));
        assert!(!verify_paystack_signature(
            "secret",
            b"modified",
            &signature
        ));
    }
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
    user_id: &str,
    email: &str,
    plan_key: &str,
) -> Result<Value, AppError> {
    let secret = config
        .paystack_secret_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("Paystack checkout is not configured".to_string()))?;
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
    let reference = format!("ks_{}", cuid2::create_id());
    sqlx::query(r#"
        INSERT INTO "BillingCheckout" (id, reference, "orgId", "planId", "userId", email, provider, status, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, 'paystack', 'PENDING', NOW(), NOW())
    "#)
    .bind(cuid2::create_id()).bind(&reference).bind(org_id).bind(&plan_id).bind(user_id).bind(email)
    .execute(pool).await?;
    let callback_url = format!(
        "{}/billing?payment=complete",
        config.frontend_url.trim_end_matches('/')
    );
    let response = reqwest::Client::new().post("https://api.paystack.co/transaction/initialize")
        .bearer_auth(secret).json(&serde_json::json!({"email": email, "plan": paystack_plan_code, "reference": reference, "callback_url": callback_url, "metadata": {"orgId": org_id, "planKey": plan_key, "productKey": product_key}})).send().await?;
    let body: PaystackInitializeResponse = response.json().await?;
    if !body.status {
        sqlx::query(r#"UPDATE "BillingCheckout" SET status = 'FAILED', "updatedAt" = NOW() WHERE reference = $1"#)
            .bind(&reference).execute(pool).await?;
    }
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
            (Some(existing), next) if existing.as_i64().is_some() && next.as_i64().is_some() => {
                Value::from(existing.as_i64().unwrap().max(next.as_i64().unwrap()))
            }
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
            let limit_prefix = format!("limit.{}.", product.key);
            let limits = entitlements
                .iter()
                .filter_map(|(key, value)| {
                    key.strip_prefix(&limit_prefix)
                        .and_then(|metric| value.as_i64().map(|limit| (metric.to_string(), limit)))
                })
                .collect();
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
                limits,
            }
        })
        .collect();

    let manual_grants = list_manual_grants(pool, org_id)
        .await?
        .into_iter()
        .filter(|grant| grant.ends_at.is_none_or(|ends_at| ends_at > Utc::now()))
        .collect();
    Ok(BillingSummary {
        org_id: org_id.to_string(),
        products,
        manual_grants,
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
