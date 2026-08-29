use std::env;

use kasitek_core::config::AppConfig;
use kasitek_core::db::models::ProductWaitlistCreateRequest;
use kasitek_core::services::early_access::{
    approval_context, approve_application, get_application, list_applications, mark_activated,
    record_submission, resend_invitation, restore_application, revoke_application, status_for_org,
    ApplicationQuery, ApproveRequest, STATUS_ACTIVE, STATUS_INVITED, STATUS_REVOKED,
};
use kasitek_core::services::website;
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn early_access_provisions_once_and_tracks_activation_and_revocation() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut config = AppConfig::from_env().expect("Core configuration should be available");
    config.resend_api_key = None;

    let suffix = cuid2::create_id();
    let application_id = format!("early-access-application-{suffix}");
    let email = format!("early-access-{suffix}@example.test");

    sqlx::query(
        r#"
        INSERT INTO "ProductWaitlistEntry" (
            id, "businessName", "contactPerson", email, "businessType", products,
            notes, source, status, "contactConsentAt", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'professional_services', $5, $6, 'website', 'new', NOW(), NOW(), NOW())
        "#,
    )
    .bind(&application_id)
    .bind(format!("Early Access Test {suffix}"))
    .bind("Early Access Applicant")
    .bind(&email)
    .bind(vec!["kasitek_product_basic".to_string()])
    .bind("Test the workspace with a real operating team.")
    .execute(&pool)
    .await
    .expect("test application should be inserted");

    record_submission(&pool, &application_id)
        .await
        .expect("submission event should be recorded");
    let approved = approve_application(
        &pool,
        &config,
        &application_id,
        "test-admin",
        ApproveRequest {
            workspace_name: Some(format!("Early Access Workspace {suffix}")),
            duration_days: Some(30),
            credits: Some(100),
            entitlement_keys: None,
            organization_id: None,
            create_workspace_for_existing_account: None,
        },
    )
    .await
    .expect("application should provision");
    assert_eq!(approved.status, STATUS_INVITED);
    let org_id = approved
        .organization_id
        .clone()
        .expect("approval should link an organisation");
    assert!(approved.invitation_id.is_some());
    assert_eq!(approved.cohort, "beta");
    let first_invitation_id = approved.invitation_id.clone();

    let resent = resend_invitation(&pool, &config, &application_id, "test-admin")
        .await
        .expect("invitation should be replaceable and resent");
    assert_eq!(resent.status, STATUS_INVITED);
    assert_ne!(resent.invitation_id, first_invitation_id);

    let grants_before_retry = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "OrganizationEntitlementGrant" WHERE "orgId" = $1 AND reason = $2"#,
    )
    .bind(&org_id)
    .bind(format!("Early-access approval {application_id}"))
    .fetch_one(&pool)
    .await
    .expect("entitlement grants should be queryable");

    let retried = approve_application(
        &pool,
        &config,
        &application_id,
        "test-admin",
        ApproveRequest {
            workspace_name: None,
            duration_days: None,
            credits: None,
            entitlement_keys: None,
            organization_id: None,
            create_workspace_for_existing_account: None,
        },
    )
    .await
    .expect("approval retry should be safe");
    assert_eq!(retried.status, STATUS_INVITED);
    assert_eq!(retried.organization_id.as_deref(), Some(org_id.as_str()));
    let grants_after_retry = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "OrganizationEntitlementGrant" WHERE "orgId" = $1 AND reason = $2"#,
    )
    .bind(&org_id)
    .bind(format!("Early-access approval {application_id}"))
    .fetch_one(&pool)
    .await
    .expect("entitlement grants should remain queryable");
    assert_eq!(grants_after_retry, grants_before_retry);

    let owner_id =
        sqlx::query_scalar::<_, String>(r#"SELECT "ownerId" FROM "Organization" WHERE id = $1"#)
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .expect("provisioned organisation should have an owner");
    mark_activated(&pool, &org_id, &owner_id)
        .await
        .expect("invitation activation should be recorded");
    sqlx::query(r#"UPDATE "User" SET "emailVerified" = NOW() WHERE id = $1"#)
        .bind(&owner_id)
        .execute(&pool)
        .await
        .expect("test owner should be marked as an active account");
    sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET "activatedAt" = NULL WHERE id = $1"#)
        .bind(&application_id)
        .execute(&pool)
        .await
        .expect("test activation marker should be adjustable");
    assert_eq!(
        get_application(&pool, &application_id)
            .await
            .unwrap()
            .0
            .status,
        STATUS_ACTIVE
    );
    assert!(status_for_org(&pool, &org_id)
        .await
        .expect("workspace status should load")
        .is_some());

    let revoked = revoke_application(
        &pool,
        &application_id,
        "test-admin",
        "End integration-test access",
    )
    .await
    .expect("active early access should be revocable");
    assert_eq!(revoked.status, STATUS_REVOKED);
    sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET "organizationId" = NULL WHERE id = $1"#)
        .bind(&application_id)
        .execute(&pool)
        .await
        .expect("test workspace link should be adjustable");

    let restored = restore_application(
        &pool,
        &config,
        &application_id,
        "test-admin",
        "Restore integration-test access",
    )
    .await
    .expect("revoked early access should be restorable");
    assert_eq!(restored.status, STATUS_ACTIVE);
    assert_eq!(restored.organization_id.as_deref(), Some(org_id.as_str()));
    assert!(restored.activated_at.is_some());
    assert_ne!(restored.credit_grant_id, revoked.credit_grant_id);
    assert!(
        restored.entitlement_grant_ids.as_array().unwrap().len()
            > revoked.entitlement_grant_ids.as_array().unwrap().len()
    );

    let revoked_again = revoke_application(
        &pool,
        &application_id,
        "test-admin",
        "End integration-test access again",
    )
    .await
    .expect("restored early access should be revocable again");
    assert_eq!(revoked_again.status, STATUS_REVOKED);

    let listed = list_applications(
        &pool,
        &ApplicationQuery {
            status: Some(STATUS_REVOKED.to_string()),
            search: Some(email.clone()),
            cohort: Some("beta".to_string()),
            limit: Some(10),
        },
    )
    .await
    .expect("admin list should filter the application");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, application_id);

    sqlx::query(r#"DELETE FROM "Organization" WHERE id = $1"#)
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("test organisation should be removed");
    sqlx::query(r#"DELETE FROM "User" WHERE id = $1"#)
        .bind(&owner_id)
        .execute(&pool)
        .await
        .expect("test owner should be removed");
    sqlx::query(r#"DELETE FROM "ProductWaitlistEntry" WHERE id = $1"#)
        .bind(&application_id)
        .execute(&pool)
        .await
        .expect("test application should be removed");
}

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn early_access_attaches_to_existing_workspace_without_duplicate_provisioning() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut config = AppConfig::from_env().expect("Core configuration should be available");
    config.resend_api_key = None;

    let suffix = cuid2::create_id();
    let application_id = format!("early-access-existing-application-{suffix}");
    let user_id = format!("early-access-existing-user-{suffix}");
    let org_id = format!("early-access-existing-org-{suffix}");
    let email = format!("early-access-existing-{suffix}@example.test");

    sqlx::query(
        r#"INSERT INTO "User" (id, name, email, "emailVerified", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW(), NOW())"#,
    )
    .bind(&user_id)
    .bind("Existing Workspace Owner")
    .bind(&email)
    .execute(&pool)
    .await
    .expect("existing user should be inserted");
    sqlx::query(
        r#"INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())"#,
    )
    .bind(&org_id)
    .bind("Existing KasiTek Workspace")
    .bind(format!("existing-kasitek-workspace-{suffix}"))
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("existing organisation should be inserted");
    sqlx::query(
        r#"INSERT INTO "OrganizationMember" (id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'OWNER'::"OrgRole", NOW(), NOW(), NOW())"#,
    )
    .bind(format!("early-access-existing-member-{suffix}"))
    .bind(&org_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .expect("existing organisation member should be inserted");
    sqlx::query(
        r#"INSERT INTO "ProductWaitlistEntry" (
            id, "businessName", "contactPerson", email, "businessType", products,
            notes, source, status, "contactConsentAt", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'professional_services', $5, $6, 'website', 'new', NOW(), NOW(), NOW())"#,
    )
    .bind(&application_id)
    .bind("Existing Account Applicant")
    .bind("Existing Workspace Owner")
    .bind(&email)
    .bind(vec!["kasitek_product_basic".to_string()])
    .bind("Grant access to the existing workspace.")
    .execute(&pool)
    .await
    .expect("test application should be inserted");

    record_submission(&pool, &application_id)
        .await
        .expect("submission event should be recorded");
    let context = approval_context(&pool, &application_id)
        .await
        .expect("approval context should load");
    assert!(context.account_exists);
    assert_eq!(context.workspaces.len(), 1);
    assert_eq!(context.workspaces[0].id, org_id);

    let approved = approve_application(
        &pool,
        &config,
        &application_id,
        "test-admin",
        ApproveRequest {
            workspace_name: Some("Ignored for existing workspace".to_string()),
            duration_days: Some(30),
            credits: Some(100),
            entitlement_keys: None,
            organization_id: Some(org_id.clone()),
            create_workspace_for_existing_account: None,
        },
    )
    .await
    .expect("application should attach to the existing workspace");
    assert_eq!(approved.status, STATUS_ACTIVE);
    assert_eq!(approved.organization_id.as_deref(), Some(org_id.as_str()));
    assert!(approved.invitation_id.is_none());
    assert!(approved.activated_at.is_some());

    let sent = resend_invitation(&pool, &config, &application_id, "test-admin")
        .await
        .expect("an active application without a redeemed invitation should be sendable");
    assert_eq!(sent.status, STATUS_ACTIVE);
    assert!(sent.invitation_id.is_some());
    assert!(sent.invitation_accepted_at.is_none());

    let user_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "User" WHERE lower(email) = lower($1)"#,
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .expect("existing account should remain queryable");
    let org_count =
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "Organization" WHERE "ownerId" = $1"#)
            .bind(&user_id)
            .fetch_one(&pool)
            .await
            .expect("existing workspace should remain queryable");
    let invitation_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "OrganizationInvitation" WHERE "orgId" = $1 AND lower(email) = lower($2)"#,
    )
    .bind(&org_id)
    .bind(&email)
    .fetch_one(&pool)
    .await
    .expect("workspace invitations should be queryable");
    assert_eq!(user_count, 1);
    assert_eq!(org_count, 1);
    assert_eq!(invitation_count, 1);

    let retried = approve_application(
        &pool,
        &config,
        &application_id,
        "test-admin",
        ApproveRequest {
            workspace_name: None,
            duration_days: None,
            credits: None,
            entitlement_keys: None,
            organization_id: None,
            create_workspace_for_existing_account: None,
        },
    )
    .await
    .expect("retrying an active approval should be idempotent");
    assert_eq!(retried.status, STATUS_ACTIVE);
    assert_eq!(retried.organization_id.as_deref(), Some(org_id.as_str()));

    sqlx::query(r#"DELETE FROM "ProductWaitlistEntry" WHERE id = $1"#)
        .bind(&application_id)
        .execute(&pool)
        .await
        .expect("test application should be removed");
    sqlx::query(r#"DELETE FROM "Organization" WHERE id = $1"#)
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("test organisation should be removed");
    sqlx::query(r#"DELETE FROM "User" WHERE id = $1"#)
        .bind(&user_id)
        .execute(&pool)
        .await
        .expect("test user should be removed");
}

#[tokio::test]
#[ignore = "requires a migrated Core PostgreSQL database"]
async fn concurrent_public_submissions_are_deduplicated() {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .expect("Core database should be reachable");
    let mut config = AppConfig::from_env().expect("Core configuration should be available");
    config.resend_api_key = None;

    let suffix = cuid2::create_id();
    let email = format!("early-access-concurrent-{suffix}@example.test");
    let make_request = || ProductWaitlistCreateRequest {
        business_name: Some("Concurrent Submission Test".to_string()),
        contact_person: Some("Concurrent Tester".to_string()),
        phone: None,
        email: Some(email.clone()),
        business_type: Some("other".to_string()),
        products: Some(vec!["kasitek_product_basic".to_string()]),
        notes: Some("Concurrency test".to_string()),
        contact_consent: Some(true),
        website: None,
    };

    let (left, right) = tokio::join!(
        website::create_waitlist_entry(&pool, &config, make_request()),
        website::create_waitlist_entry(&pool, &config, make_request()),
    );
    let left_id = left
        .expect("first concurrent submission should succeed")
        .get("id")
        .and_then(|value| value.as_str())
        .expect("first response should include an id")
        .to_string();
    let right_id = right
        .expect("second concurrent submission should be deduplicated")
        .get("id")
        .and_then(|value| value.as_str())
        .expect("second response should include an id")
        .to_string();
    assert_eq!(left_id, right_id);

    let event_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM "ProductWaitlistEvent" WHERE "waitlistEntryId" = $1"#,
    )
    .bind(&left_id)
    .fetch_one(&pool)
    .await
    .expect("submission events should be queryable");
    assert_eq!(event_count, 1);

    sqlx::query(r#"DELETE FROM "ProductWaitlistEntry" WHERE id = $1"#)
        .bind(&left_id)
        .execute(&pool)
        .await
        .expect("test application should be removed");
}
