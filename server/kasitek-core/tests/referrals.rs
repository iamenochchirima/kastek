use std::env;

use kasitek_core::services::billing::process_provider_event;
use kasitek_core::services::billing_provider::ProviderEvent;
use kasitek_core::services::referrals::{
    attribute_referral, ensure_referral_code, get_referral_summary, list_referral_attributions,
    qualify_referral, set_referral_code_status, ReferralRewardConfig,
};
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn referral_lifecycle_is_idempotent_and_reversible() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");

    let suffix = cuid2::create_id();
    let referrer_user = format!("referral-user-a-{}", suffix);
    let referee_user = format!("referral-user-b-{}", suffix);
    let referrer_org = format!("referral-org-a-{}", suffix);
    let referee_org = format!("referral-org-b-{}", suffix);
    let product_id = format!("referral-product-{}", suffix);
    let plan_id = format!("referral-plan-{}", suffix);
    let checkout_id = format!("referral-checkout-{}", suffix);
    let subscription_id = format!("referral-subscription-{}", suffix);

    sqlx::query(
        r#"
        INSERT INTO "User" (id, email, "createdAt", "updatedAt")
        VALUES ($1, $2, NOW(), NOW()), ($3, $4, NOW(), NOW())
        "#,
    )
    .bind(&referrer_user)
    .bind(format!("{}@example.test", referrer_user))
    .bind(&referee_user)
    .bind(format!("{}@example.test", referee_user))
    .execute(&pool)
    .await
    .expect("test users should be inserted");
    sqlx::query(
        r#"
        INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt")
        VALUES ($1, 'Referral Referrer', $2, $3, NOW(), NOW()),
               ($4, 'Referral Referee', $5, $6, NOW(), NOW())
        "#,
    )
    .bind(&referrer_org)
    .bind(format!("{}-slug", referrer_org))
    .bind(&referrer_user)
    .bind(&referee_org)
    .bind(format!("{}-slug", referee_org))
    .bind(&referee_user)
    .execute(&pool)
    .await
    .expect("test organisations should be inserted");
    sqlx::query(
        r#"
        INSERT INTO "Product" (id, key, name, active, "createdAt", "updatedAt")
        VALUES ($1, $2, 'Referral Test Product', true, NOW(), NOW())
        "#,
    )
    .bind(&product_id)
    .bind(format!("referral-test-product-{}", suffix))
    .execute(&pool)
    .await
    .expect("test product should be inserted");
    sqlx::query(
        r#"
        INSERT INTO "ProductPlan" (id, "productId", key, name, interval, currency, "amountMinor", active, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, 'Referral Test Plan', 'MONTHLY', 'ZAR', 100, true, NOW(), NOW())
        "#,
    )
    .bind(&plan_id)
    .bind(&product_id)
    .bind(format!("referral-test-plan-{}", suffix))
    .execute(&pool)
    .await
    .expect("test plan should be inserted");
    sqlx::query(
        r#"
        INSERT INTO "OrganizationSubscription" (
            id, "orgId", "planId", status, provider, "providerSubscriptionId",
            "startedAt", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, 'ACTIVE', 'paystack', $4, NOW(), NOW(), NOW())
        "#,
    )
    .bind(&subscription_id)
    .bind(&referee_org)
    .bind(&plan_id)
    .bind(&subscription_id)
    .execute(&pool)
    .await
    .expect("test subscription should be inserted");
    sqlx::query(
        r#"
        INSERT INTO "BillingCheckout" (
            id, reference, "idempotencyKey", "orgId", "planId", "userId", email,
            provider, status, "providerResponse", "createdAt", "updatedAt"
        ) VALUES ($1, 'refund-test', $2, $3, $4, $5, $6, 'paystack', 'COMPLETED', $7, NOW(), NOW())
        "#,
    )
    .bind(&checkout_id)
    .bind(format!("referral-checkout-key-{}", suffix))
    .bind(&referee_org)
    .bind(&plan_id)
    .bind(&referee_user)
    .bind(format!("{}@example.test", referee_user))
    .bind(serde_json::json!({ "amountMinor": 100 }))
    .execute(&pool)
    .await
    .expect("test checkout should be inserted");

    let config = ReferralRewardConfig {
        referrer_credits: 10,
        referee_credits: 5,
        reward_expiry_days: 365,
        attribution_window_days: 90,
    };
    let code = ensure_referral_code(&pool, &referrer_org)
        .await
        .expect("referral code should be created");
    assert!(
        set_referral_code_status(&pool, &referrer_org, "DISABLED", "integration test")
            .await
            .expect("code should be disabled")
    );
    let disabled_error = attribute_referral(&pool, &referee_org, &code, config)
        .await
        .expect_err("disabled code should be rejected");
    assert_eq!(disabled_error.code(), "referral_code_disabled");
    assert!(
        set_referral_code_status(&pool, &referrer_org, "ACTIVE", "integration test")
            .await
            .expect("code should be re-enabled")
    );
    assert!(attribute_referral(&pool, &referee_org, &code, config)
        .await
        .expect("attribution should succeed"));
    assert!(!attribute_referral(&pool, &referee_org, &code, config)
        .await
        .expect("duplicate attribution should be idempotent"));

    let pending = get_referral_summary(&pool, &referrer_org, config, "https://app.example")
        .await
        .expect("pending referral summary should load");
    assert_eq!(pending.pending_count, 1);
    assert_eq!(pending.code.attributed_count, 1);
    assert_eq!(pending.code.redemption_count, 0);
    assert_eq!(
        list_referral_attributions(&pool, Some(&referrer_org), None, 10)
            .await
            .expect("admin referral list should load")
            .len(),
        1
    );

    assert!(qualify_referral(&pool, &referee_org, "refund-test", config)
        .await
        .expect("qualification should award both sides"));
    assert!(qualify_referral(&pool, &referee_org, "refund-test", config)
        .await
        .expect("duplicate qualification should be idempotent"));
    let awarded_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "CreditLedgerEntry" WHERE "orgId" IN ($1, $2) AND type = 'GRANT' AND "sourceType" = 'SYSTEM' AND "sourceId" LIKE 'referral:%'"#,
    )
    .bind(&referrer_org)
    .bind(&referee_org)
    .fetch_one(&pool)
    .await
    .expect("referral grants should be recorded");
    assert_eq!(awarded_count, 2);

    assert!(process_provider_event(
        &pool,
        "paystack",
        ProviderEvent::SubscriptionDisabled {
            subscription_id: subscription_id.clone(),
        },
        config,
    )
    .await
    .expect("subscription cancellation should queue manual referral review"));
    let cancellation_details = sqlx::query_scalar::<_, serde_json::Value>(
        r#"SELECT details FROM "BillingReconciliationIssue" WHERE provider = 'paystack' AND "resourceId" = $1 AND "issueType" = 'subscription_disabled'"#,
    )
    .bind(&subscription_id)
    .fetch_one(&pool)
    .await
    .expect("cancellation review issue should be recorded");
    assert_eq!(cancellation_details["referralReviewRequired"], true);

    assert!(process_provider_event(
        &pool,
        "paystack",
        ProviderEvent::DisputeOpened {
            transaction_reference: "refund-test".to_string(),
        },
        config,
    )
    .await
    .expect("dispute event should queue manual referral review"));
    let dispute_details = sqlx::query_scalar::<_, serde_json::Value>(
        r#"SELECT details FROM "BillingReconciliationIssue" WHERE provider = 'paystack' AND "resourceId" = 'refund-test' AND "issueType" = 'dispute_opened'"#,
    )
    .fetch_one(&pool)
    .await
    .expect("dispute review issue should be recorded");
    assert_eq!(dispute_details["referralReviewRequired"], true);

    assert!(process_provider_event(
        &pool,
        "paystack",
        ProviderEvent::RefundProcessed {
            transaction_reference: "refund-test".to_string(),
            amount_minor: Some(100),
        },
        config,
    )
    .await
    .expect("refund event should reverse referral"));
    assert!(process_provider_event(
        &pool,
        "paystack",
        ProviderEvent::RefundProcessed {
            transaction_reference: "refund-test".to_string(),
            amount_minor: Some(100),
        },
        config,
    )
    .await
    .expect("duplicate refund event should be idempotent"));

    let summary = get_referral_summary(&pool, &referrer_org, config, "https://app.example")
        .await
        .expect("reversed referral summary should load");
    assert_eq!(summary.reversed_count, 1);
    let revoke_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "CreditLedgerEntry" WHERE "orgId" IN ($1, $2) AND type = 'REVOKE'"#,
    )
    .bind(&referrer_org)
    .bind(&referee_org)
    .fetch_one(&pool)
    .await
    .expect("reversal ledger entries should be recorded");
    assert_eq!(revoke_count, 2);

    sqlx::query(r#"DELETE FROM "Organization" WHERE id IN ($1, $2)"#)
        .bind(&referrer_org)
        .bind(&referee_org)
        .execute(&pool)
        .await
        .expect("test organisations should be removed");
    sqlx::query(r#"DELETE FROM "User" WHERE id IN ($1, $2)"#)
        .bind(&referrer_user)
        .bind(&referee_user)
        .execute(&pool)
        .await
        .expect("test users should be removed");
    sqlx::query(r#"DELETE FROM "ProductPlan" WHERE id = $1"#)
        .bind(&plan_id)
        .execute(&pool)
        .await
        .expect("test plan should be removed");
    sqlx::query(r#"DELETE FROM "Product" WHERE id = $1"#)
        .bind(&product_id)
        .execute(&pool)
        .await
        .expect("test product should be removed");
}
