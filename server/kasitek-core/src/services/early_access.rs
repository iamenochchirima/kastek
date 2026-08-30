//! Early-access application and activation lifecycle.
//!
//! The waitlist row is the applicant record. This service owns the allowed
//! transitions and keeps the signup invitation, entitlement grants, credit
//! grant, and transition history together so an operator can safely retry an
//! approval.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Row};
use std::sync::OnceLock;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::{auth, billing, credits, orgs, website};

pub const STATUS_NEW: &str = "new";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_INVITED: &str = "invited";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_REVOKED: &str = "revoked";
pub const COHORT_BETA: &str = "beta";

const DEFAULT_DURATION_DAYS: i64 = 30;
const DEFAULT_CREDITS: i64 = 1_000;
const BETA_PACKAGE_KEY: &str = "beta-2026-01";
const INVITATION_DAYS: i64 = 7;
const MAX_DURATION_DAYS: i64 = 365;
const MAX_CREDITS: i64 = 1_000_000;
const DEFAULT_CAPABILITIES: &[&str] = &[
    "feature.analytics.view",
    "feature.inbox.access",
    "feature.agents.manage",
    "feature.campaigns.manage",
    "feature.content.manage",
];

// Activation performs several idempotent database writes and external email is not involved.
// Serialize it within this Core process so two requests cannot redeem one invitation between
// the pending check and the final application update.
static ACTIVATION_GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct EarlyAccessApplication {
    pub id: String,
    #[serde(rename = "businessName")]
    #[sqlx(rename = "business_name")]
    pub business_name: String,
    #[serde(rename = "contactPerson")]
    #[sqlx(rename = "contact_person")]
    pub contact_person: String,
    pub phone: Option<String>,
    pub email: String,
    #[serde(rename = "businessType")]
    #[sqlx(rename = "business_type")]
    pub business_type: Option<String>,
    pub products: Vec<String>,
    pub notes: Option<String>,
    pub source: String,
    pub status: String,
    pub cohort: String,
    #[serde(rename = "reviewNotes")]
    #[sqlx(rename = "review_notes")]
    pub review_notes: Option<String>,
    #[serde(rename = "decisionReason")]
    #[sqlx(rename = "decision_reason")]
    pub decision_reason: Option<String>,
    #[serde(rename = "reviewedById")]
    #[sqlx(rename = "reviewed_by_id")]
    pub reviewed_by_id: Option<String>,
    #[serde(rename = "reviewedAt")]
    #[sqlx(rename = "reviewed_at")]
    pub reviewed_at: Option<DateTime<Utc>>,
    #[serde(rename = "approvedById")]
    #[sqlx(rename = "approved_by_id")]
    pub approved_by_id: Option<String>,
    #[serde(rename = "approvedAt")]
    #[sqlx(rename = "approved_at")]
    pub approved_at: Option<DateTime<Utc>>,
    #[serde(rename = "organizationId")]
    #[sqlx(rename = "organization_id")]
    pub organization_id: Option<String>,
    #[serde(rename = "earlyAccessInvitationId")]
    #[sqlx(rename = "early_access_invitation_id")]
    pub early_access_invitation_id: Option<String>,
    #[serde(rename = "invitationStatus")]
    #[sqlx(rename = "invitation_status")]
    pub invitation_status: Option<String>,
    #[serde(rename = "invitationDeliveryStatus")]
    #[sqlx(rename = "invitation_delivery_status")]
    pub invitation_delivery_status: Option<String>,
    #[serde(rename = "invitationExpiresAt")]
    #[sqlx(rename = "invitation_expires_at")]
    pub invitation_expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "packageKey")]
    #[sqlx(rename = "package_key")]
    pub package_key: Option<String>,
    #[serde(rename = "packageSnapshot")]
    #[sqlx(rename = "package_snapshot")]
    pub package_snapshot: Option<Value>,
    #[serde(rename = "activatedAt")]
    #[sqlx(rename = "activated_at")]
    pub activated_at: Option<DateTime<Utc>>,
    #[serde(rename = "earlyAccessEndsAt")]
    #[sqlx(rename = "early_access_ends_at")]
    pub early_access_ends_at: Option<DateTime<Utc>>,
    #[serde(rename = "entitlementGrantIds")]
    #[sqlx(rename = "entitlement_grant_ids")]
    pub entitlement_grant_ids: Value,
    #[serde(rename = "creditGrantId")]
    #[sqlx(rename = "credit_grant_id")]
    pub credit_grant_id: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct EarlyAccessEvent {
    pub id: String,
    #[serde(rename = "waitlistEntryId")]
    #[sqlx(rename = "waitlist_entry_id")]
    pub waitlist_entry_id: String,
    #[serde(rename = "fromStatus")]
    #[sqlx(rename = "from_status")]
    pub from_status: Option<String>,
    #[serde(rename = "toStatus")]
    #[sqlx(rename = "to_status")]
    pub to_status: String,
    pub action: String,
    #[serde(rename = "actorId")]
    #[sqlx(rename = "actor_id")]
    pub actor_id: Option<String>,
    pub reason: Option<String>,
    pub metadata: Value,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ApplicationQuery {
    pub status: Option<String>,
    pub search: Option<String>,
    pub cohort: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RejectRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApproveRequest {
    #[serde(rename = "packageKey")]
    pub package_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BatchApproveRequest {
    #[serde(rename = "applicationIds")]
    pub application_ids: Vec<String>,
    #[serde(rename = "packageKey")]
    pub package_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchApproveResult {
    pub id: String,
    pub outcome: String,
    pub status: String,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchApproveResponse {
    pub requested: usize,
    pub approved: usize,
    pub invited: usize,
    #[serde(rename = "alreadyProcessed")]
    pub already_processed: usize,
    pub failed: usize,
    pub results: Vec<BatchApproveResult>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct SignupInvitationPreview {
    pub email: String,
    pub status: String,
    #[serde(rename = "expiresAt")]
    #[sqlx(rename = "expires_at")]
    pub expires_at: DateTime<Utc>,
    #[serde(rename = "businessName")]
    #[sqlx(rename = "business_name")]
    pub business_name: String,
}

#[derive(Debug, Deserialize)]
pub struct ActivateSignupInvitationRequest {
    #[serde(rename = "organizationId")]
    pub organization_id: Option<String>,
    #[serde(rename = "workspaceName")]
    pub workspace_name: Option<String>,
}

fn application_select() -> &'static str {
    r#"
        SELECT id,
               "businessName" AS business_name,
               "contactPerson" AS contact_person,
               phone,
               email,
               "businessType" AS business_type,
               COALESCE(products, ARRAY[]::text[]) AS products,
               notes,
               source,
               status,
               cohort,
               "reviewNotes" AS review_notes,
               "decisionReason" AS decision_reason,
               "reviewedById" AS reviewed_by_id,
               "reviewedAt" AT TIME ZONE 'UTC' AS reviewed_at,
               "approvedById" AS approved_by_id,
               "approvedAt" AT TIME ZONE 'UTC' AS approved_at,
               "organizationId" AS organization_id,
               "earlyAccessInvitationId" AS early_access_invitation_id,
               (SELECT status FROM "EarlyAccessInvitation" WHERE id = "ProductWaitlistEntry"."earlyAccessInvitationId") AS invitation_status,
               (SELECT "deliveryStatus" FROM "EarlyAccessInvitation" WHERE id = "ProductWaitlistEntry"."earlyAccessInvitationId") AS invitation_delivery_status,
               (SELECT "expiresAt" FROM "EarlyAccessInvitation" WHERE id = "ProductWaitlistEntry"."earlyAccessInvitationId") AS invitation_expires_at,
               "packageKey" AS package_key,
               "packageSnapshot" AS package_snapshot,
               "activatedAt" AT TIME ZONE 'UTC' AS activated_at,
               "earlyAccessEndsAt" AT TIME ZONE 'UTC' AS early_access_ends_at,
               "entitlementGrantIds" AS entitlement_grant_ids,
               "creditGrantId" AS credit_grant_id,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ProductWaitlistEntry"
    "#
}

fn valid_status(status: &str) -> bool {
    matches!(
        status,
        STATUS_NEW
            | STATUS_APPROVED
            | STATUS_INVITED
            | STATUS_ACTIVE
            | STATUS_REJECTED
            | STATUS_EXPIRED
            | STATUS_REVOKED
    )
}

fn transition_allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        (STATUS_NEW, STATUS_APPROVED | STATUS_REJECTED)
            | (
                STATUS_APPROVED,
                STATUS_INVITED | STATUS_ACTIVE | STATUS_REVOKED
            )
            | (
                STATUS_INVITED,
                STATUS_ACTIVE | STATUS_REVOKED | STATUS_EXPIRED
            )
            | (STATUS_ACTIVE, STATUS_EXPIRED | STATUS_REVOKED)
            | (
                STATUS_REVOKED,
                STATUS_APPROVED | STATUS_INVITED | STATUS_ACTIVE
            )
    )
}

fn bounded_text(value: Option<&str>, field: &str, max: usize) -> Result<Option<String>, AppError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if value.as_ref().is_some_and(|value| value.len() > max) {
        return Err(AppError::BadRequest(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(value)
}

fn required_text(value: Option<&str>, field: &str, max: usize) -> Result<String, AppError> {
    bounded_text(value, field, max)?
        .ok_or_else(|| AppError::BadRequest(format!("{field} is required")))
}

fn selected_capabilities(keys: Option<Vec<String>>) -> Result<Vec<String>, AppError> {
    let keys = keys.unwrap_or_else(|| {
        DEFAULT_CAPABILITIES
            .iter()
            .map(|key| (*key).to_string())
            .collect()
    });
    let mut result = Vec::with_capacity(keys.len());
    for key in keys {
        let key = key.trim().to_string();
        if key.is_empty() || result.contains(&key) {
            continue;
        }
        if !DEFAULT_CAPABILITIES.contains(&key.as_str()) {
            return Err(AppError::BadRequest(format!(
                "Unsupported early-access capability: {key}"
            )));
        }
        result.push(key);
    }
    if result.is_empty() {
        return Err(AppError::BadRequest(
            "At least one capability is required".to_string(),
        ));
    }
    Ok(result)
}

pub async fn record_submission(pool: &PgPool, application_id: &str) -> Result<(), AppError> {
    record_event(
        pool,
        application_id,
        None,
        STATUS_NEW,
        "submitted",
        None,
        None,
        json!({}),
    )
    .await
}

async fn expire_due_invitations(pool: &PgPool) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE "EarlyAccessInvitation"
           SET status = 'expired', "updatedAt" = NOW()
           WHERE status = 'pending' AND "expiresAt" <= NOW()"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn record_event(
    pool: &PgPool,
    application_id: &str,
    from_status: Option<&str>,
    to_status: &str,
    action: &str,
    actor_id: Option<&str>,
    reason: Option<&str>,
    metadata: Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO "ProductWaitlistEvent"
           (id, "waitlistEntryId", "fromStatus", "toStatus", action, "actorId", reason, metadata, "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())"#,
    )
    .bind(cuid2::create_id())
    .bind(application_id)
    .bind(from_status)
    .bind(to_status)
    .bind(action)
    .bind(actor_id)
    .bind(reason)
    .bind(metadata)
    .execute(pool)
    .await?;
    observability::tracing::info!(
        event = "early_access.lifecycle.transition",
        application_id = %application_id,
        from_status = from_status.unwrap_or("none"),
        to_status = %to_status,
        action = %action,
        actor_present = actor_id.is_some(),
        "early-access lifecycle transition recorded"
    );
    Ok(())
}

pub async fn list_applications(
    pool: &PgPool,
    query: &ApplicationQuery,
) -> Result<Vec<EarlyAccessApplication>, AppError> {
    expire_due_invitations(pool).await?;
    expire_due_access(pool).await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(status) = status {
        if !valid_status(status) {
            return Err(AppError::BadRequest(
                "Invalid early-access status filter".to_string(),
            ));
        }
    }
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let cohort = query
        .cohort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(cohort) = cohort {
        if cohort.len() > 80
            || !cohort
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
        {
            return Err(AppError::BadRequest(
                "Invalid early-access cohort filter".to_string(),
            ));
        }
    }
    let sql = format!(
        "{} WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR \"businessName\" ILIKE '%' || $2 || '%' OR \"contactPerson\" ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR cohort = $3) ORDER BY \"createdAt\" DESC LIMIT $4",
        application_select()
    );
    Ok(sqlx::query_as::<_, EarlyAccessApplication>(&sql)
        .bind(status)
        .bind(search)
        .bind(cohort)
        .bind(limit)
        .fetch_all(pool)
        .await?)
}

pub async fn get_application(
    pool: &PgPool,
    application_id: &str,
) -> Result<(EarlyAccessApplication, Vec<EarlyAccessEvent>), AppError> {
    let application = sqlx::query_as::<_, EarlyAccessApplication>(&format!(
        "{} WHERE id = $1",
        application_select()
    ))
    .bind(application_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Early-access application not found".to_string()))?;
    let events = sqlx::query_as::<_, EarlyAccessEvent>(
        r#"SELECT id, "waitlistEntryId" AS waitlist_entry_id,
                  "fromStatus" AS from_status, "toStatus" AS to_status,
                  action, "actorId" AS actor_id, reason, metadata,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at
           FROM "ProductWaitlistEvent"
           WHERE "waitlistEntryId" = $1
           ORDER BY "createdAt" ASC, id ASC"#,
    )
    .bind(application_id)
    .fetch_all(pool)
    .await?;
    Ok((application, events))
}

pub async fn reject_application(
    pool: &PgPool,
    application_id: &str,
    actor_id: &str,
    request: RejectRequest,
) -> Result<EarlyAccessApplication, AppError> {
    let reason = required_text(request.reason.as_deref(), "Rejection reason", 2_000)?;
    let (current, _) = get_application(pool, application_id).await?;
    if current.status == STATUS_REJECTED {
        return Ok(current);
    }
    if !transition_allowed(&current.status, STATUS_REJECTED) {
        return Err(AppError::Conflict(format!(
            "Cannot reject an early-access application from {}",
            current.status
        )));
    }
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = $1, "decisionReason" = $2, "reviewedById" = $3,
               "reviewedAt" = NOW(), "updatedAt" = NOW()
           WHERE id = $4"#,
    )
    .bind(STATUS_REJECTED)
    .bind(&reason)
    .bind(actor_id)
    .bind(application_id)
    .execute(pool)
    .await?;
    record_event(
        pool,
        application_id,
        Some(&current.status),
        STATUS_REJECTED,
        "rejected",
        Some(actor_id),
        Some(&reason),
        json!({}),
    )
    .await?;
    get_application(pool, application_id)
        .await
        .map(|(application, _)| application)
}

async fn ensure_entitlement_grant(
    pool: &PgPool,
    org_id: &str,
    key: &str,
    ends_at: DateTime<Utc>,
    reason: &str,
    actor_id: &str,
) -> Result<String, AppError> {
    if let Some(id) = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "OrganizationEntitlementGrant"
           WHERE "orgId" = $1 AND key = $2 AND source = 'MANUAL'::"EntitlementSource" AND reason = $3
             AND ("endsAt" IS NULL OR "endsAt" > NOW())
           ORDER BY "createdAt" DESC LIMIT 1"#,
    )
    .bind(org_id)
    .bind(key)
    .bind(reason)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    Ok(billing::create_manual_grant(
        pool,
        org_id,
        key,
        json!(true),
        Some(ends_at),
        reason,
        actor_id,
    )
    .await?
    .id)
}

fn beta_package_snapshot() -> Value {
    json!({
        "key": BETA_PACKAGE_KEY,
        "durationDays": DEFAULT_DURATION_DAYS,
        "credits": DEFAULT_CREDITS,
        "capabilities": DEFAULT_CAPABILITIES,
    })
}

fn valid_package_key(value: Option<&str>) -> Result<&'static str, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some(BETA_PACKAGE_KEY) => Ok(BETA_PACKAGE_KEY),
        Some(_) => Err(AppError::BadRequest(
            "Unsupported early-access package".to_string(),
        )),
    }
}

fn package_parameters(snapshot: Option<&Value>) -> Result<(i64, i64, Vec<String>), AppError> {
    let snapshot = snapshot.ok_or_else(|| {
        AppError::Conflict("The approved early-access package is missing".to_string())
    })?;
    let key = snapshot.get("key").and_then(Value::as_str).ok_or_else(|| {
        AppError::Conflict("The approved early-access package is invalid".to_string())
    })?;
    valid_package_key(Some(key))?;
    let duration_days = snapshot
        .get("durationDays")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Conflict("The early-access duration is invalid".to_string()))?;
    if !(1..=MAX_DURATION_DAYS).contains(&duration_days) {
        return Err(AppError::Conflict(
            "The early-access duration is invalid".to_string(),
        ));
    }
    let credits = snapshot
        .get("credits")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            AppError::Conflict("The early-access credit allocation is invalid".to_string())
        })?;
    if !(1..=MAX_CREDITS).contains(&credits) {
        return Err(AppError::Conflict(
            "The early-access credit allocation is invalid".to_string(),
        ));
    }
    let capabilities = snapshot
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Conflict("The early-access capabilities are invalid".to_string()))?
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect();
    Ok((
        duration_days,
        credits,
        selected_capabilities(Some(capabilities))?,
    ))
}

async fn mark_invitation_delivery(
    pool: &PgPool,
    invitation_id: &str,
    delivered: bool,
) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE "EarlyAccessInvitation"
           SET "deliveryStatus" = $1, "deliveryAttempts" = "deliveryAttempts" + 1,
               "lastDeliveryAttemptAt" = NOW(), "lastDeliveryErrorCode" = $2, "updatedAt" = NOW()
           WHERE id = $3"#,
    )
    .bind(if delivered { "sent" } else { "failed" })
    .bind(if delivered {
        None
    } else {
        Some("EMAIL_DELIVERY_FAILED")
    })
    .bind(invitation_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn release_activation_claim(pool: &PgPool, invitation_id: &str) {
    let _ = sqlx::query(
        r#"UPDATE "EarlyAccessInvitation"
           SET status = 'pending', "acceptedAt" = NULL, "updatedAt" = NOW()
           WHERE id = $1 AND status = 'accepted'"#,
    )
    .bind(invitation_id)
    .execute(pool)
    .await;
}

async fn cleanup_activation_workspace(pool: &PgPool, org_id: &str, application_id: &str) {
    if let Err(error) = orgs::delete_org(pool, org_id).await {
        observability::tracing::error!(
            event = "operation.failed",
            operation = "early_access.activation_workspace_cleanup",
            application_id = %application_id,
            organization_id = %org_id,
            error_type = %std::any::type_name_of_val(&error),
            "failed to clean up workspace after early-access activation failure"
        );
    }
}

async fn create_signup_invitation(
    pool: &PgPool,
    config: &AppConfig,
    application: &EarlyAccessApplication,
    actor_id: &str,
) -> Result<EarlyAccessApplication, AppError> {
    if !config.early_access_self_service_enabled {
        return Err(AppError::Conflict(
            "Early-access self-service is disabled".to_string(),
        ));
    }
    sqlx::query(
        r#"UPDATE "EarlyAccessInvitation" SET status = 'revoked', "revokedAt" = NOW(), "updatedAt" = NOW()
           WHERE "waitlistEntryId" = $1 AND status = 'pending'"#,
    )
    .bind(&application.id)
    .execute(pool)
    .await?;
    let token = crypto_utils::generate_token(48);
    let invitation_id = cuid2::create_id();
    let expires_at = Utc::now() + Duration::days(INVITATION_DAYS);
    sqlx::query(
        r#"INSERT INTO "EarlyAccessInvitation"
           (id, "waitlistEntryId", email, "tokenHash", status, "deliveryStatus", "expiresAt", "createdById", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'pending', 'pending', $5, $6, NOW(), NOW())"#,
    )
    .bind(&invitation_id)
    .bind(&application.id)
    .bind(&application.email)
    .bind(crypto_utils::sha256_hex(&token))
    .bind(expires_at)
    .bind(actor_id)
    .execute(pool)
    .await?;
    let from_status = application.status.clone();
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = CASE WHEN status IN ('approved', 'invited') THEN status ELSE 'approved' END,
               "approvedById" = $1, "approvedAt" = COALESCE("approvedAt", NOW()),
               "reviewedById" = COALESCE("reviewedById", $1), "reviewedAt" = COALESCE("reviewedAt", NOW()),
               "earlyAccessInvitationId" = $2, "packageKey" = $3, "packageSnapshot" = $4,
               "updatedAt" = NOW() WHERE id = $5"#,
    )
    .bind(actor_id)
    .bind(&invitation_id)
    .bind(BETA_PACKAGE_KEY)
    .bind(beta_package_snapshot())
    .bind(&application.id)
    .execute(pool)
    .await?;
    if !matches!(from_status.as_str(), STATUS_APPROVED | STATUS_INVITED) {
        record_event(
            pool,
            &application.id,
            Some(&from_status),
            STATUS_APPROVED,
            if from_status == STATUS_REVOKED {
                "restored"
            } else {
                "approved"
            },
            Some(actor_id),
            None,
            json!({"packageKey": BETA_PACKAGE_KEY}),
        )
        .await?;
    }
    let invite_url = format!(
        "{}/early-access/{}",
        config.frontend_url.trim_end_matches('/'),
        token
    );
    let delivery = auth::send_email(config, &application.email, "Your KasiTek early access is approved", &format!("Your early access is approved. Create or sign in to your account here:\n{}\n\nThis link expires in 7 days.", invite_url)).await;
    let delivered = delivery.is_ok();
    mark_invitation_delivery(pool, &invitation_id, delivered).await?;
    if delivered {
        sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = 'invited', "updatedAt" = NOW() WHERE id = $1"#)
            .bind(&application.id).execute(pool).await?;
        record_event(
            pool,
            &application.id,
            Some(if from_status == STATUS_INVITED {
                STATUS_INVITED
            } else {
                STATUS_APPROVED
            }),
            STATUS_INVITED,
            if from_status == STATUS_INVITED {
                "invite_resent"
            } else {
                "invited"
            },
            Some(actor_id),
            None,
            json!({"invitationId": invitation_id}),
        )
        .await?;
    }
    get_application(pool, &application.id)
        .await
        .map(|(application, _)| application)
}

pub async fn approve_self_service_application(
    pool: &PgPool,
    config: &AppConfig,
    application_id: &str,
    actor_id: &str,
    request: ApproveRequest,
) -> Result<EarlyAccessApplication, AppError> {
    valid_package_key(request.package_key.as_deref())?;
    let application = get_application(pool, application_id).await?.0;
    if application.status == STATUS_REJECTED
        || application.status == STATUS_REVOKED
        || application.status == STATUS_EXPIRED
    {
        return Err(AppError::Conflict(format!(
            "Cannot approve an application in {} state",
            application.status
        )));
    }
    if application.status == STATUS_ACTIVE {
        return Ok(application);
    }
    if let Some(invitation_id) = application.early_access_invitation_id.as_deref() {
        let pending = sqlx::query_scalar::<_, bool>(r#"SELECT EXISTS(SELECT 1 FROM "EarlyAccessInvitation" WHERE id = $1 AND status = 'pending' AND "expiresAt" > NOW())"#)
            .bind(invitation_id).fetch_one(pool).await?;
        if pending {
            return Ok(application);
        }
    }
    create_signup_invitation(pool, config, &application, actor_id).await
}

pub async fn batch_approve_self_service(
    pool: &PgPool,
    config: &AppConfig,
    actor_id: &str,
    request: BatchApproveRequest,
) -> Result<BatchApproveResponse, AppError> {
    valid_package_key(request.package_key.as_deref())?;
    if request.application_ids.is_empty() || request.application_ids.len() > 100 {
        return Err(AppError::BadRequest(
            "Select between 1 and 100 applications".to_string(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if request
        .application_ids
        .iter()
        .any(|id| id.trim().is_empty() || !seen.insert(id))
    {
        return Err(AppError::BadRequest(
            "Application IDs must be unique".to_string(),
        ));
    }
    let requested = request.application_ids.len();
    let mut results = Vec::with_capacity(requested);
    let mut approved = 0;
    let mut invited = 0;
    let mut already_processed = 0;
    let mut failed = 0;
    for id in request.application_ids {
        match approve_self_service_application(
            pool,
            config,
            &id,
            actor_id,
            ApproveRequest {
                package_key: Some(BETA_PACKAGE_KEY.to_string()),
            },
        )
        .await
        {
            Ok(application) => {
                if application.invitation_delivery_status.as_deref() == Some("failed") {
                    failed += 1;
                } else if application.status == STATUS_INVITED {
                    invited += 1;
                } else {
                    approved += 1;
                }
                results.push(BatchApproveResult {
                    id,
                    outcome: if application.invitation_delivery_status.as_deref() == Some("failed")
                    {
                        "failed"
                    } else if application.status == STATUS_INVITED {
                        "invited"
                    } else {
                        "approved"
                    }
                    .to_string(),
                    status: application.status,
                    error_code: (application.invitation_delivery_status.as_deref()
                        == Some("failed"))
                    .then_some("EMAIL_DELIVERY_FAILED".to_string()),
                });
            }
            Err(AppError::Conflict(_)) => {
                already_processed += 1;
                results.push(BatchApproveResult {
                    id,
                    outcome: "skipped".to_string(),
                    status: "unchanged".to_string(),
                    error_code: Some("NOT_APPROVABLE".to_string()),
                });
            }
            Err(_) => {
                failed += 1;
                results.push(BatchApproveResult {
                    id,
                    outcome: "failed".to_string(),
                    status: "unchanged".to_string(),
                    error_code: Some("APPROVAL_FAILED".to_string()),
                });
            }
        }
    }
    Ok(BatchApproveResponse {
        requested,
        approved,
        invited,
        already_processed,
        failed,
        results,
    })
}

pub async fn resend_self_service_invitation(
    pool: &PgPool,
    config: &AppConfig,
    application_id: &str,
    actor_id: &str,
) -> Result<EarlyAccessApplication, AppError> {
    let application = get_application(pool, application_id).await?.0;
    if !matches!(
        application.status.as_str(),
        STATUS_APPROVED | STATUS_INVITED
    ) {
        return Err(AppError::Conflict(
            "Only approved or invited applications can be resent".to_string(),
        ));
    }
    create_signup_invitation(pool, config, &application, actor_id).await
}

pub async fn signup_invitation_preview(
    pool: &PgPool,
    token: &str,
) -> Result<SignupInvitationPreview, AppError> {
    expire_due_invitations(pool).await?;
    let hash = crypto_utils::sha256_hex(token);
    let preview = sqlx::query_as::<_, SignupInvitationPreview>(r#"SELECT i.email, i.status, i."expiresAt" AS expires_at, w."businessName" AS business_name FROM "EarlyAccessInvitation" i JOIN "ProductWaitlistEntry" w ON w.id = i."waitlistEntryId" WHERE i."tokenHash" = $1"#)
        .bind(hash).fetch_optional(pool).await?.ok_or_else(|| AppError::NotFound("Early-access invitation not found".to_string()))?;
    Ok(preview)
}

pub async fn activate_signup_invitation(
    pool: &PgPool,
    token: &str,
    user_id: &str,
    request: ActivateSignupInvitationRequest,
) -> Result<EarlyAccessApplication, AppError> {
    let _activation_guard = ACTIVATION_GUARD
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    expire_due_invitations(pool).await?;
    let hash = crypto_utils::sha256_hex(token);
    let row = sqlx::query_as::<_, (String, String, String, String, DateTime<Utc>)>(
        r#"SELECT i.id, i."waitlistEntryId", i.email, i.status,
                  i."expiresAt" AS expires_at
           FROM "EarlyAccessInvitation" i
           WHERE i."tokenHash" = $1"#,
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::Conflict("This invitation is invalid, expired, or already used".to_string())
    })?;
    let user_email = sqlx::query_scalar::<_, String>(r#"SELECT email FROM "User" WHERE id = $1"#)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    if !user_email.eq_ignore_ascii_case(&row.2) {
        return Err(AppError::Forbidden(
            "Sign in with the approved email address".to_string(),
        ));
    }

    let application = get_application(pool, &row.1).await?.0;
    if row.3 == "accepted" {
        if application.status == STATUS_ACTIVE && application.organization_id.is_some() {
            return Ok(application);
        }
        return Err(AppError::Conflict(
            "This invitation was accepted but activation did not complete".to_string(),
        ));
    }
    if row.3 != "pending" || row.4 <= Utc::now() {
        return Err(AppError::Conflict(
            "This invitation is invalid, expired, or already used".to_string(),
        ));
    }

    let (existing_org_id, new_workspace) = if let Some(org_id) = request
        .organization_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        orgs::require_admin(pool, org_id, user_id).await?;
        (Some(org_id.to_string()), None)
    } else {
        let name = required_text(request.workspace_name.as_deref(), "Workspace name", 80)?;
        let slug = orgs::unique_slug(pool, &orgs::slugify(&name)).await?;
        (None, Some((name, slug)))
    };
    let (duration_days, credits_amount, capabilities) =
        package_parameters(application.package_snapshot.as_ref())?;

    let claimed = sqlx::query_scalar::<_, String>(
        r#"UPDATE "EarlyAccessInvitation"
           SET status = 'accepted', "acceptedAt" = NOW(), "updatedAt" = NOW()
           WHERE id = $1 AND status = 'pending' AND "expiresAt" > NOW()
           RETURNING id"#,
    )
    .bind(&row.0)
    .fetch_optional(pool)
    .await?;
    if claimed.is_none() {
        return Err(AppError::Conflict(
            "This invitation is invalid, expired, or already used".to_string(),
        ));
    }

    let (org_id, created_workspace) = if let Some(org_id) = existing_org_id {
        (org_id, false)
    } else {
        let (name, slug) = new_workspace
            .ok_or_else(|| AppError::Conflict("Workspace name is required".to_string()))?;
        match orgs::create_org(pool, user_id, &name, &slug, None, 0, duration_days).await {
            Ok(org) => (org.id, true),
            Err(error) => {
                release_activation_claim(pool, &row.0).await;
                return Err(error);
            }
        }
    };
    let ends_at = Utc::now() + Duration::days(duration_days);
    let reason = format!("Early-access package {}", BETA_PACKAGE_KEY);
    let grants_result: Result<Vec<String>, AppError> = async {
        let mut grants = Vec::new();
        for key in &capabilities {
            grants.push(
                ensure_entitlement_grant(pool, &org_id, key, ends_at, &reason, user_id).await?,
            );
        }
        Ok(grants)
    }
    .await;
    let grants = match grants_result {
        Ok(grants) => grants,
        Err(error) => {
            if created_workspace {
                cleanup_activation_workspace(pool, &org_id, &application.id).await;
            }
            release_activation_claim(pool, &row.0).await;
            return Err(error);
        }
    };
    let credit = match credits::grant_system_credits(
        pool,
        &org_id,
        credits_amount,
        "EARLY_ACCESS",
        Some(ends_at),
        &reason,
        Some(user_id),
        Some(&json!({"applicationId": application.id, "packageKey": BETA_PACKAGE_KEY})),
        &format!("early-access-credits:{}", application.id),
    )
    .await
    {
        Ok(credit) => credit,
        Err(error) => {
            if created_workspace {
                cleanup_activation_workspace(pool, &org_id, &application.id).await;
            }
            release_activation_claim(pool, &row.0).await;
            return Err(error);
        }
    };
    let application_update = sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = 'active', "organizationId" = $1, "activatedAt" = NOW(), "earlyAccessEndsAt" = $2, "entitlementGrantIds" = $3, "creditGrantId" = $4, "updatedAt" = NOW() WHERE id = $5 AND status IN ('approved', 'invited')"#)
        .bind(&org_id).bind(ends_at).bind(json!(grants)).bind(credit.grant_id).bind(&application.id).execute(pool).await?;
    if application_update.rows_affected() != 1 {
        if created_workspace {
            cleanup_activation_workspace(pool, &org_id, &application.id).await;
        }
        release_activation_claim(pool, &row.0).await;
        return Err(AppError::Conflict(
            "This application is no longer available for activation".to_string(),
        ));
    }
    if let Err(error) = record_event(
        pool,
        &application.id,
        Some(&application.status),
        STATUS_ACTIVE,
        "activated",
        Some(user_id),
        None,
        json!({"organizationId": org_id, "packageKey": BETA_PACKAGE_KEY}),
    )
    .await
    {
        observability::tracing::error!(
            event = "operation.failed",
            operation = "early_access.activation_audit",
            application_id = %application.id,
            invitation_id = %row.0,
            error_type = %std::any::type_name_of_val(&error),
            "early-access activation succeeded but audit event recording failed"
        );
    }
    get_application(pool, &application.id)
        .await
        .map(|(application, _)| application)
}

pub async fn restore_application(
    pool: &PgPool,
    config: &AppConfig,
    application_id: &str,
    actor_id: &str,
    reason: &str,
) -> Result<EarlyAccessApplication, AppError> {
    let reason = required_text(Some(reason), "Restoration reason", 2_000)?;
    let application = get_application(pool, application_id).await?.0;
    if application.status != STATUS_REVOKED {
        return Err(AppError::Conflict(
            "Only revoked applications can have access restored".to_string(),
        ));
    }

    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = 'approved', "decisionReason" = $1, "updatedAt" = NOW()
           WHERE id = $2 AND status = 'revoked'"#,
    )
    .bind(&reason)
    .bind(application_id)
    .execute(pool)
    .await?;
    record_event(
        pool,
        application_id,
        Some(STATUS_REVOKED),
        STATUS_APPROVED,
        "restored",
        Some(actor_id),
        Some(&reason),
        json!({}),
    )
    .await?;

    let application = get_application(pool, application_id).await?.0;
    create_signup_invitation(pool, config, &application, actor_id).await
}

pub async fn revoke_application(
    pool: &PgPool,
    application_id: &str,
    actor_id: &str,
    reason: &str,
) -> Result<EarlyAccessApplication, AppError> {
    let reason = required_text(Some(reason), "Revocation reason", 2_000)?;
    let application = get_application(pool, application_id).await?.0;
    if application.status == STATUS_REVOKED {
        return Ok(application);
    }
    if !matches!(
        application.status.as_str(),
        STATUS_APPROVED | STATUS_INVITED | STATUS_ACTIVE
    ) {
        return Err(AppError::Conflict(
            "Only approved, invited, or active access can be revoked".to_string(),
        ));
    }
    sqlx::query(
        r#"UPDATE "EarlyAccessInvitation"
           SET status = 'revoked', "revokedAt" = NOW(), "updatedAt" = NOW()
           WHERE "waitlistEntryId" = $1 AND status = 'pending'"#,
    )
    .bind(application_id)
    .execute(pool)
    .await?;
    if let Some(org_id) = application.organization_id.as_deref() {
        for grant_id in application
            .entitlement_grant_ids
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let _ = billing::expire_manual_grant(pool, org_id, grant_id).await;
        }
        if let Some(credit_grant_id) = application.credit_grant_id.as_deref() {
            let _ = credits::revoke_unspent_system_grant(
                pool,
                org_id,
                credit_grant_id,
                &reason,
                &format!("early-access-revoke:{application_id}:{credit_grant_id}"),
            )
            .await;
        }
    }
    sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = 'revoked', "decisionReason" = $1, "updatedAt" = NOW() WHERE id = $2"#)
        .bind(&reason)
        .bind(application_id)
        .execute(pool)
        .await?;
    record_event(
        pool,
        application_id,
        Some(&application.status),
        STATUS_REVOKED,
        "revoked",
        Some(actor_id),
        Some(&reason),
        json!({}),
    )
    .await?;
    let _ = website::publish_admin_notification(
        pool,
        "early_access.revoked",
        "Early access revoked",
        &format!(
            "Early access for {} was revoked.",
            application.business_name
        ),
        "product_waitlist_entry",
        application_id,
        json!({ "organizationId": application.organization_id }),
        &format!("early_access.revoked:{application_id}"),
    )
    .await;
    get_application(pool, application_id)
        .await
        .map(|(application, _)| application)
}

pub async fn status_for_org(pool: &PgPool, org_id: &str) -> Result<Option<Value>, AppError> {
    expire_due_access(pool).await?;
    let row = sqlx::query(
        r#"SELECT id, status, "earlyAccessEndsAt", "activatedAt", "createdAt"
           FROM "ProductWaitlistEntry"
           WHERE "organizationId" = $1 AND status IN ('approved', 'invited', 'active', 'expired', 'revoked')
           ORDER BY "createdAt" DESC LIMIT 1"#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| {
        json!({
            "applicationId": row.try_get::<String, _>("id").unwrap_or_default(),
            "status": row.try_get::<String, _>("status").unwrap_or_default(),
            "endsAt": row.try_get::<Option<DateTime<Utc>>, _>("earlyAccessEndsAt").unwrap_or(None),
            "activatedAt": row.try_get::<Option<DateTime<Utc>>, _>("activatedAt").unwrap_or(None),
        })
    }))
}

pub async fn expire_due_access(pool: &PgPool) -> Result<(), AppError> {
    let applications = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, status, "businessName" FROM "ProductWaitlistEntry"
           WHERE "earlyAccessEndsAt" IS NOT NULL AND "earlyAccessEndsAt" <= NOW()
             AND status IN ('approved', 'invited', 'active')"#,
    )
    .fetch_all(pool)
    .await?;
    for (application_id, current_status, business_name) in applications {
        if !transition_allowed(&current_status, STATUS_EXPIRED) {
            continue;
        }
        sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = 'expired', "updatedAt" = NOW() WHERE id = $1 AND status = $2"#)
            .bind(&application_id)
            .bind(&current_status)
            .execute(pool)
            .await?;
        record_event(
            pool,
            &application_id,
            Some(&current_status),
            STATUS_EXPIRED,
            "expired",
            None,
            Some("Early-access period ended"),
            json!({}),
        )
        .await?;
        let _ = website::publish_admin_notification(
            pool,
            "early_access.expired",
            "Early access expired",
            &format!("Early access for {business_name} has ended."),
            "product_waitlist_entry",
            &application_id,
            json!({}),
            &format!("early_access.expired:{application_id}"),
        )
        .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        application_select, beta_package_snapshot, package_parameters, selected_capabilities,
        transition_allowed,
    };

    #[test]
    fn invitation_expiry_projection_preserves_postgres_timestamp_type() {
        let select = application_select();
        assert!(select.contains(
            "(SELECT \"expiresAt\" FROM \"EarlyAccessInvitation\" WHERE id = \"ProductWaitlistEntry\".\"earlyAccessInvitationId\") AS invitation_expires_at"
        ));
        assert!(!select.contains("\"expiresAt\" AT TIME ZONE 'UTC'"));
    }

    #[test]
    fn lifecycle_transitions_allow_approval_activation_and_reversal() {
        assert!(transition_allowed("new", "approved"));
        assert!(transition_allowed("new", "rejected"));
        assert!(transition_allowed("approved", "invited"));
        assert!(transition_allowed("invited", "active"));
        assert!(transition_allowed("active", "expired"));
        assert!(transition_allowed("active", "revoked"));
        assert!(transition_allowed("revoked", "invited"));
        assert!(transition_allowed("revoked", "active"));
        assert!(!transition_allowed("rejected", "approved"));
        assert!(!transition_allowed("active", "approved"));
    }

    #[test]
    fn capabilities_default_and_reject_unregistered_keys() {
        let defaults = selected_capabilities(None).expect("defaults should be valid");
        assert_eq!(defaults.len(), 5);
        assert!(selected_capabilities(Some(vec!["feature.inbox.access".to_string()])).is_ok());
        assert!(selected_capabilities(Some(vec!["feature.admin.root".to_string()])).is_err());
    }

    #[test]
    fn beta_package_snapshot_is_the_activation_source() {
        let snapshot = beta_package_snapshot();
        let (duration_days, credits, capabilities) =
            package_parameters(Some(&snapshot)).expect("beta package should be valid");
        assert_eq!(duration_days, 30);
        assert_eq!(credits, 1_000);
        assert_eq!(capabilities.len(), 5);
    }

    #[test]
    fn invalid_package_snapshots_are_rejected() {
        let invalid = serde_json::json!({
            "key": "beta-unknown",
            "durationDays": 30,
            "credits": 1_000,
            "capabilities": ["feature.analytics.view"]
        });
        assert!(package_parameters(Some(&invalid)).is_err());
        assert!(package_parameters(None).is_err());
    }
}
