//! Early-access application and provisioning lifecycle.
//!
//! The waitlist row is the applicant record. This service owns the allowed
//! transitions and keeps the linked invitation, entitlement grants, credit
//! grant, and transition history together so an operator can safely retry a
//! partially completed approval.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Row};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::{billing, credits, orgs, website};

pub const STATUS_NEW: &str = "new";
pub const STATUS_REVIEWING: &str = "reviewing";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_INVITED: &str = "invited";
pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_REVOKED: &str = "revoked";
pub const COHORT_BETA: &str = "beta";

const DEFAULT_DURATION_DAYS: i64 = 30;
const DEFAULT_CREDITS: i64 = 100;
const MAX_DURATION_DAYS: i64 = 365;
const MAX_CREDITS: i64 = 1_000_000;
const DEFAULT_CAPABILITIES: &[&str] = &[
    "feature.analytics.view",
    "feature.inbox.access",
    "feature.agents.manage",
    "feature.campaigns.manage",
    "feature.content.manage",
];

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
    #[serde(rename = "invitationId")]
    #[sqlx(rename = "invitation_id")]
    pub invitation_id: Option<String>,
    #[serde(rename = "invitationAcceptedAt")]
    #[sqlx(rename = "invitation_accepted_at")]
    pub invitation_accepted_at: Option<DateTime<Utc>>,
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

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct EarlyAccessWorkspaceOption {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EarlyAccessApprovalContext {
    #[serde(rename = "accountExists")]
    pub account_exists: bool,
    pub workspaces: Vec<EarlyAccessWorkspaceOption>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    pub status: String,
    pub notes: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApproveRequest {
    #[serde(rename = "workspaceName")]
    pub workspace_name: Option<String>,
    #[serde(rename = "durationDays")]
    pub duration_days: Option<i64>,
    pub credits: Option<i64>,
    #[serde(rename = "entitlementKeys")]
    pub entitlement_keys: Option<Vec<String>>,
    #[serde(rename = "organizationId")]
    pub organization_id: Option<String>,
    #[serde(rename = "createWorkspaceForExistingAccount")]
    pub create_workspace_for_existing_account: Option<bool>,
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
               "invitationId" AS invitation_id,
               (SELECT "acceptedAt" AT TIME ZONE 'UTC'
                FROM "OrganizationInvitation"
                WHERE id = "ProductWaitlistEntry"."invitationId") AS invitation_accepted_at,
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
            | STATUS_REVIEWING
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
        (
            STATUS_NEW,
            STATUS_REVIEWING | STATUS_APPROVED | STATUS_REJECTED
        ) | (
            STATUS_REVIEWING,
            STATUS_REVIEWING | STATUS_APPROVED | STATUS_REJECTED
        ) | (
            STATUS_APPROVED,
            STATUS_INVITED | STATUS_ACTIVE | STATUS_REVOKED
        ) | (
            STATUS_INVITED,
            STATUS_ACTIVE | STATUS_REVOKED | STATUS_EXPIRED
        ) | (STATUS_ACTIVE, STATUS_EXPIRED | STATUS_REVOKED)
            | (STATUS_REVOKED, STATUS_INVITED | STATUS_ACTIVE)
            | (STATUS_REJECTED, STATUS_REVIEWING)
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

pub async fn approval_context(
    pool: &PgPool,
    application_id: &str,
) -> Result<EarlyAccessApprovalContext, AppError> {
    let application = get_application(pool, application_id).await?.0;
    let user_id = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
    )
    .bind(&application.email)
    .fetch_optional(pool)
    .await?;

    let workspaces = if let Some(user_id) = user_id.as_deref() {
        sqlx::query_as::<_, EarlyAccessWorkspaceOption>(
            r#"SELECT o.id, o.name, o.slug, m.role::text AS role
               FROM "Organization" o
               JOIN "OrganizationMember" m ON m."orgId" = o.id
               WHERE m."userId" = $1
               ORDER BY o."createdAt" ASC, o.id ASC"#,
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };

    Ok(EarlyAccessApprovalContext {
        account_exists: user_id.is_some(),
        workspaces,
    })
}

pub async fn review_application(
    pool: &PgPool,
    application_id: &str,
    actor_id: &str,
    request: ReviewRequest,
) -> Result<EarlyAccessApplication, AppError> {
    let to_status = request.status.trim().to_lowercase();
    if !matches!(to_status.as_str(), STATUS_REVIEWING | STATUS_REJECTED) {
        return Err(AppError::BadRequest(
            "Review status must be reviewing or rejected".to_string(),
        ));
    }
    let notes = bounded_text(request.notes.as_deref(), "Review notes", 4_000)?;
    let reason = bounded_text(request.reason.as_deref(), "Decision reason", 2_000)?;
    if to_status == STATUS_REJECTED && reason.is_none() {
        return Err(AppError::BadRequest(
            "A rejection reason is required".to_string(),
        ));
    }
    let (current, _) = get_application(pool, application_id).await?;
    if current.status == to_status {
        return Ok(current);
    }
    if !transition_allowed(&current.status, &to_status) {
        return Err(AppError::Conflict(format!(
            "Cannot move an early-access application from {} to {}",
            current.status, to_status
        )));
    }
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = $1, "reviewNotes" = COALESCE($2, "reviewNotes"),
               "decisionReason" = $3, "reviewedById" = $4, "reviewedAt" = NOW(),
               "updatedAt" = NOW()
           WHERE id = $5"#,
    )
    .bind(&to_status)
    .bind(notes.as_deref())
    .bind(reason.as_deref())
    .bind(actor_id)
    .bind(application_id)
    .execute(pool)
    .await?;
    record_event(
        pool,
        application_id,
        Some(&current.status),
        &to_status,
        if to_status == STATUS_REJECTED {
            "rejected"
        } else {
            "review_started"
        },
        Some(actor_id),
        reason.as_deref(),
        json!({}),
    )
    .await?;
    get_application(pool, application_id)
        .await
        .map(|(application, _)| application)
}

async fn link_organization(
    pool: &PgPool,
    application_id: &str,
    org_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET "organizationId" = COALESCE("organizationId", $1), "updatedAt" = NOW()
           WHERE id = $2"#,
    )
    .bind(org_id)
    .bind(application_id)
    .execute(pool)
    .await?;
    Ok(())
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

async fn ensure_invitation(
    pool: &PgPool,
    config: &AppConfig,
    application: &EarlyAccessApplication,
    org_id: &str,
) -> Result<String, AppError> {
    if let Some(invitation_id) = application.invitation_id.as_deref() {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                   SELECT 1 FROM "OrganizationInvitation"
                   WHERE id = $1 AND "orgId" = $2
                     AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
                     AND "expiresAt" > NOW()
               )"#,
        )
        .bind(invitation_id)
        .bind(org_id)
        .fetch_one(pool)
        .await?;
        if exists {
            return Ok(invitation_id.to_string());
        }
    }
    create_invitation(pool, config, application, org_id, false).await
}

async fn create_invitation(
    pool: &PgPool,
    config: &AppConfig,
    application: &EarlyAccessApplication,
    org_id: &str,
    allow_existing_member: bool,
) -> Result<String, AppError> {
    let owner = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT id, name FROM "User" WHERE id = (SELECT "ownerId" FROM "Organization" WHERE id = $1)"#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Early-access workspace owner not found".to_string()))?;
    let invitation = if allow_existing_member {
        orgs::create_invitation_for_existing_member(
            pool,
            config,
            org_id,
            &application.business_name,
            &owner.0,
            owner
                .1
                .as_deref()
                .or(Some(application.contact_person.as_str())),
            &application.email,
            "ADMIN",
        )
        .await?
    } else {
        orgs::create_invitation(
            pool,
            config,
            org_id,
            &application.business_name,
            &owner.0,
            owner
                .1
                .as_deref()
                .or(Some(application.contact_person.as_str())),
            &application.email,
            "ADMIN",
        )
        .await?
    };
    Ok(invitation.id)
}

async fn application_capabilities(
    pool: &PgPool,
    application: &EarlyAccessApplication,
    org_id: &str,
) -> Result<Vec<String>, AppError> {
    let grant_ids = application
        .entitlement_grant_ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if grant_ids.is_empty() {
        return selected_capabilities(None);
    }

    let keys = sqlx::query_scalar::<_, String>(
        r#"SELECT key
           FROM "OrganizationEntitlementGrant"
           WHERE "orgId" = $1 AND id = ANY($2::text[])
           ORDER BY key"#,
    )
    .bind(org_id)
    .bind(&grant_ids)
    .fetch_all(pool)
    .await?;
    if keys.is_empty() {
        selected_capabilities(None)
    } else {
        selected_capabilities(Some(keys))
    }
}

async fn restore_organization(
    pool: &PgPool,
    config: &AppConfig,
    application: &EarlyAccessApplication,
) -> Result<String, AppError> {
    if let Some(org_id) = application.organization_id.as_deref() {
        if orgs::get_org(pool, org_id).await?.is_some() {
            return Ok(org_id.to_string());
        }
    }

    let existing_user_id = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
    )
    .bind(&application.email)
    .fetch_optional(pool)
    .await?;
    let user_id = if let Some(user_id) = existing_user_id {
        user_id
    } else {
        let user_id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "User" (id, name, email, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, NOW(), NOW())"#,
        )
        .bind(&user_id)
        .bind(&application.contact_person)
        .bind(&application.email)
        .execute(pool)
        .await?;
        user_id
    };

    if let Some(org) = orgs::list_orgs_for_user(pool, &user_id)
        .await?
        .into_iter()
        .next()
    {
        link_organization(pool, &application.id, &org.id).await?;
        return Ok(org.id);
    }

    let workspace_name = application.business_name.trim();
    let workspace_name = if workspace_name.is_empty() {
        "KasiTek workspace".to_string()
    } else {
        workspace_name.to_string()
    };
    let base_slug = orgs::slugify(&workspace_name);
    let slug = orgs::unique_slug(pool, &base_slug).await?;
    let org = orgs::create_org(
        pool,
        &user_id,
        &workspace_name,
        &slug,
        None,
        config.trial_credits,
        config.trial_duration_days,
    )
    .await?;
    link_organization(pool, &application.id, &org.id).await?;
    Ok(org.id)
}

async fn application_has_activated_access(
    pool: &PgPool,
    application: &EarlyAccessApplication,
    org_id: &str,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
               SELECT 1 FROM "ProductWaitlistEvent"
               WHERE "waitlistEntryId" = $1
                 AND action IN ('activated', 'workspace_access_granted')
           ) OR EXISTS(
               SELECT 1 FROM "OrganizationInvitation"
               WHERE "orgId" = $2
                 AND lower(email) = lower($3)
                 AND "acceptedAt" IS NOT NULL
           )"#,
    )
    .bind(&application.id)
    .bind(org_id)
    .bind(&application.email)
    .fetch_one(pool)
    .await?)
}

async fn application_credit_amount(
    pool: &PgPool,
    application: &EarlyAccessApplication,
    org_id: &str,
) -> Result<i64, AppError> {
    let amount = if let Some(grant_id) = application.credit_grant_id.as_deref() {
        sqlx::query_scalar::<_, i64>(
            r#"SELECT amount FROM "CreditGrant" WHERE id = $1 AND "orgId" = $2"#,
        )
        .bind(grant_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or(DEFAULT_CREDITS)
    } else {
        DEFAULT_CREDITS
    };
    if !(1..=MAX_CREDITS).contains(&amount) {
        return Err(AppError::Conflict(
            "The original early-access credit allocation is outside the supported limits"
                .to_string(),
        ));
    }
    Ok(amount)
}

async fn latest_revocation_event_id(
    pool: &PgPool,
    application_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "ProductWaitlistEvent"
           WHERE "waitlistEntryId" = $1 AND action = 'revoked'
           ORDER BY "createdAt" DESC, id DESC LIMIT 1"#,
    )
    .bind(application_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn approve_application(
    pool: &PgPool,
    config: &AppConfig,
    application_id: &str,
    actor_id: &str,
    request: ApproveRequest,
) -> Result<EarlyAccessApplication, AppError> {
    let duration_days = request.duration_days.unwrap_or(DEFAULT_DURATION_DAYS);
    if !(1..=MAX_DURATION_DAYS).contains(&duration_days) {
        return Err(AppError::BadRequest(format!(
            "Duration must be between 1 and {MAX_DURATION_DAYS} days"
        )));
    }
    let credits_amount = request.credits.unwrap_or(DEFAULT_CREDITS);
    if !(1..=MAX_CREDITS).contains(&credits_amount) {
        return Err(AppError::BadRequest(format!(
            "Credits must be between 1 and {MAX_CREDITS}"
        )));
    }
    let capabilities = selected_capabilities(request.entitlement_keys)?;
    let workspace_name = request
        .workspace_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("KasiTek workspace")
        .to_string();
    if workspace_name.len() > 160 {
        return Err(AppError::BadRequest(
            "Workspace name is too long".to_string(),
        ));
    }

    let mut application = get_application(pool, application_id).await?.0;
    if application.status == STATUS_ACTIVE {
        return Ok(application);
    }
    if matches!(
        application.status.as_str(),
        STATUS_REJECTED | STATUS_REVOKED | STATUS_EXPIRED
    ) {
        return Err(AppError::Conflict(format!(
            "Cannot approve an application in {} state",
            application.status
        )));
    }
    if application.status == STATUS_NEW || application.status == STATUS_REVIEWING {
        if !transition_allowed(&application.status, STATUS_APPROVED) {
            return Err(AppError::Conflict(
                "Application cannot be approved from its current state".to_string(),
            ));
        }
        let from_status = application.status.clone();
        sqlx::query(
            r#"UPDATE "ProductWaitlistEntry"
               SET status = 'approved', "approvedById" = $1, "approvedAt" = NOW(),
                   "reviewedById" = COALESCE("reviewedById", $1), "reviewedAt" = COALESCE("reviewedAt", NOW()),
                   "updatedAt" = NOW()
               WHERE id = $2 AND status = $3"#,
        )
        .bind(actor_id)
        .bind(application_id)
        .bind(&from_status)
        .execute(pool)
        .await?;
        record_event(
            pool,
            application_id,
            Some(&from_status),
            STATUS_APPROVED,
            "approved",
            Some(actor_id),
            None,
            json!({
                "durationDays": duration_days,
                "credits": credits_amount,
                "capabilities": capabilities,
            }),
        )
        .await?;
        application = get_application(pool, application_id).await?.0;
    }

    let requested_org_id = request
        .organization_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let create_workspace_for_existing_account = request
        .create_workspace_for_existing_account
        .unwrap_or(false);
    if requested_org_id.is_some() && create_workspace_for_existing_account {
        return Err(AppError::BadRequest(
            "Choose an existing workspace or create a new one, not both".to_string(),
        ));
    }
    if let (Some(linked_org_id), Some(requested_org_id)) =
        (application.organization_id.as_deref(), requested_org_id)
    {
        if linked_org_id != requested_org_id {
            return Err(AppError::Conflict(
                "This application is already linked to another workspace".to_string(),
            ));
        }
    }

    let existing_user_id = if application.organization_id.is_none() {
        sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
        )
        .bind(&application.email)
        .fetch_optional(pool)
        .await?
    } else {
        None
    };
    let mut existing_account_access = false;
    let org_id = if let Some(org_id) = application.organization_id.clone() {
        org_id
    } else if let Some(requested_org_id) = requested_org_id {
        let user_id = existing_user_id.as_deref().ok_or_else(|| {
            AppError::Conflict(
                "The applicant account is no longer available. Reload the workspace options and try again.".to_string(),
            )
        })?;
        let belongs_to_account = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                   SELECT 1 FROM "Organization" o
                   WHERE o.id = $1
                     AND (o."ownerId" = $2 OR EXISTS(
                         SELECT 1 FROM "OrganizationMember" m
                         WHERE m."orgId" = o.id AND m."userId" = $2
                     ))
               )"#,
        )
        .bind(requested_org_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        if !belongs_to_account {
            return Err(AppError::Conflict(
                "The selected workspace is not associated with the applicant account".to_string(),
            ));
        }
        existing_account_access = true;
        link_organization(pool, application_id, requested_org_id).await?;
        requested_org_id.to_string()
    } else if let Some(user_id) = existing_user_id.as_deref() {
        if !create_workspace_for_existing_account {
            return Err(AppError::Conflict(
                "Choose an existing workspace or select Create new workspace for this account"
                    .to_string(),
            ));
        }
        existing_account_access = true;
        let base_slug = orgs::slugify(&workspace_name);
        let slug = orgs::unique_slug(pool, &base_slug).await?;
        let org = orgs::create_org(
            pool,
            user_id,
            &workspace_name,
            &slug,
            None,
            config.trial_credits,
            config.trial_duration_days,
        )
        .await?;
        link_organization(pool, application_id, &org.id).await?;
        org.id
    } else {
        if create_workspace_for_existing_account {
            return Err(AppError::Conflict(
                "The applicant account is no longer available. Reload the workspace options and try again.".to_string(),
            ));
        }
        let user_id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "User" (id, name, email, "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())"#,
        )
        .bind(&user_id)
        .bind(&application.contact_person)
        .bind(&application.email)
        .execute(pool)
        .await?;
        let base_slug = orgs::slugify(&workspace_name);
        let slug = orgs::unique_slug(pool, &base_slug).await?;
        let org = orgs::create_org(
            pool,
            &user_id,
            &workspace_name,
            &slug,
            None,
            config.trial_credits,
            config.trial_duration_days,
        )
        .await?;
        link_organization(pool, application_id, &org.id).await?;
        org.id
    };
    application = get_application(pool, application_id).await?.0;

    let ends_at = application
        .early_access_ends_at
        .unwrap_or_else(|| Utc::now() + Duration::days(duration_days));
    let grant_reason = format!("Early-access approval {}", application.id);
    let mut entitlement_ids = application
        .entitlement_grant_ids
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    for key in &capabilities {
        let grant_id =
            ensure_entitlement_grant(pool, &org_id, key, ends_at, &grant_reason, actor_id).await?;
        if !entitlement_ids.contains(&grant_id) {
            entitlement_ids.push(grant_id);
        }
    }
    let credit_result = credits::grant_system_credits(
        pool,
        &org_id,
        credits_amount,
        "EARLY_ACCESS",
        Some(ends_at),
        &grant_reason,
        Some(&format!("early-access:{}", application.id)),
        Some(&json!({ "applicationId": application.id, "capabilities": capabilities })),
        &format!("early-access-credits:{}", application.id),
    )
    .await?;
    let target_status = if existing_account_access {
        STATUS_ACTIVE
    } else {
        STATUS_INVITED
    };
    let invitation_id = if existing_account_access {
        None
    } else {
        Some(ensure_invitation(pool, config, &application, &org_id).await?)
    };
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = $1, "organizationId" = $2, "invitationId" = $3,
               "earlyAccessEndsAt" = $4, "entitlementGrantIds" = $5,
               "creditGrantId" = COALESCE("creditGrantId", $6),
               "activatedAt" = CASE WHEN $1 = 'active' THEN COALESCE("activatedAt", NOW()) ELSE "activatedAt" END,
               "updatedAt" = NOW()
           WHERE id = $7"#,
    )
    .bind(target_status)
    .bind(&org_id)
    .bind(invitation_id.as_deref())
    .bind(ends_at)
    .bind(json!(entitlement_ids))
    .bind(credit_result.grant_id.as_deref())
    .bind(application_id)
    .execute(pool)
    .await?;
    if application.status != target_status {
        record_event(
            pool,
            application_id,
            Some(&application.status),
            target_status,
            if existing_account_access {
                "workspace_access_granted"
            } else {
                "invited"
            },
            Some(actor_id),
            None,
            json!({
                "organizationId": org_id,
                "invitationId": invitation_id,
                "existingAccount": existing_account_access,
            }),
        )
        .await?;
        let _ = website::publish_admin_notification(
            pool,
            if existing_account_access {
                "early_access.granted"
            } else {
                "early_access.invited"
            },
            if existing_account_access {
                "Early access granted"
            } else {
                "Early-access invitation sent"
            },
            &if existing_account_access {
                format!(
                    "{} was granted early access in an existing workspace.",
                    application.business_name
                )
            } else {
                format!(
                    "{} was approved for early access.",
                    application.business_name
                )
            },
            "product_waitlist_entry",
            application_id,
            json!({ "organizationId": org_id, "invitationId": invitation_id }),
            &format!(
                "early_access.{}:{application_id}",
                if existing_account_access {
                    "granted"
                } else {
                    "invited"
                }
            ),
        )
        .await;
    }
    get_application(pool, application_id)
        .await
        .map(|(application, _)| application)
}

pub async fn resend_invitation(
    pool: &PgPool,
    config: &AppConfig,
    application_id: &str,
    actor_id: &str,
) -> Result<EarlyAccessApplication, AppError> {
    let application = get_application(pool, application_id).await?.0;
    if !matches!(
        application.status.as_str(),
        STATUS_APPROVED | STATUS_INVITED | STATUS_ACTIVE
    ) {
        return Err(AppError::Conflict(
            "Only approved, invited, or active applications without a redeemed invitation can be resent".to_string(),
        ));
    }
    if application.status == STATUS_ACTIVE && application.invitation_accepted_at.is_some() {
        return Err(AppError::Conflict(
            "This early-access invitation has already been redeemed".to_string(),
        ));
    }
    let org_id = application.organization_id.as_deref().ok_or_else(|| {
        AppError::Conflict("This application has not finished workspace provisioning".to_string())
    })?;
    let invitation_id = create_invitation(pool, config, &application, org_id, true).await?;
    let target_status = if application.status == STATUS_ACTIVE {
        STATUS_ACTIVE
    } else {
        STATUS_INVITED
    };
    sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = $1, "invitationId" = $2, "updatedAt" = NOW() WHERE id = $3"#)
        .bind(target_status)
        .bind(&invitation_id)
        .bind(application_id)
        .execute(pool)
        .await?;
    record_event(
        pool,
        application_id,
        Some(&application.status),
        target_status,
        "invite_resent",
        Some(actor_id),
        None,
        json!({ "invitationId": invitation_id }),
    )
    .await?;
    get_application(pool, application_id)
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
    let org_id = restore_organization(pool, config, &application).await?;
    let now = Utc::now();
    let ends_at = application
        .early_access_ends_at
        .filter(|value| *value > now)
        .unwrap_or_else(|| now + Duration::days(DEFAULT_DURATION_DAYS));
    let capabilities = application_capabilities(pool, &application, &org_id).await?;
    let grant_reason = format!("Early-access restoration {}", application.id);
    let mut entitlement_ids = application
        .entitlement_grant_ids
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    for key in &capabilities {
        let grant_id =
            ensure_entitlement_grant(pool, &org_id, key, ends_at, &grant_reason, actor_id).await?;
        if !entitlement_ids.contains(&grant_id) {
            entitlement_ids.push(grant_id);
        }
    }

    let revocation_event_id = latest_revocation_event_id(pool, application_id)
        .await?
        .unwrap_or_else(|| application.updated_at.timestamp_millis().to_string());
    let credit_amount = application_credit_amount(pool, &application, &org_id).await?;
    let activated_access = application_has_activated_access(pool, &application, &org_id).await?;
    let credit_grant_id = credits::grant_system_credits(
        pool,
        &org_id,
        credit_amount,
        "EARLY_ACCESS",
        Some(ends_at),
        &grant_reason,
        Some(&format!("early-access:{application_id}")),
        Some(&json!({
            "applicationId": application_id,
            "capabilities": capabilities,
            "restoredFromCreditGrantId": application.credit_grant_id.clone(),
            "revocationEventId": revocation_event_id.clone(),
        })),
        &format!("early-access-restore-credits:{application_id}:{revocation_event_id}"),
    )
    .await?
    .grant_id
    .ok_or_else(|| AppError::Conflict("Restored credit grant was not created".to_string()))?;

    let target_status = if activated_access {
        STATUS_ACTIVE
    } else {
        STATUS_INVITED
    };
    let invitation_id = if target_status == STATUS_INVITED {
        Some(create_invitation(pool, config, &application, &org_id, true).await?)
    } else {
        application.invitation_id.clone()
    };
    if !transition_allowed(&application.status, target_status) {
        return Err(AppError::Conflict(
            "Early-access access cannot be restored from its current state".to_string(),
        ));
    }
    sqlx::query(
        r#"UPDATE "ProductWaitlistEntry"
           SET status = $1, "decisionReason" = $2, "invitationId" = $3,
               "earlyAccessEndsAt" = $4, "entitlementGrantIds" = $5,
               "creditGrantId" = $6,
               "activatedAt" = CASE WHEN $1 = 'active' THEN COALESCE("activatedAt", NOW()) ELSE NULL END,
               "updatedAt" = NOW()
           WHERE id = $7 AND status = 'revoked'"#,
    )
    .bind(target_status)
    .bind(&reason)
    .bind(invitation_id.as_deref())
    .bind(ends_at)
    .bind(json!(entitlement_ids))
    .bind(&credit_grant_id)
    .bind(application_id)
    .execute(pool)
    .await?;
    record_event(
        pool,
        application_id,
        Some(STATUS_REVOKED),
        target_status,
        "restored",
        Some(actor_id),
        Some(&reason),
        json!({
            "organizationId": org_id,
            "invitationId": invitation_id.clone(),
            "creditGrantId": credit_grant_id.clone(),
            "restoredFromRevocationEventId": revocation_event_id.clone(),
        }),
    )
    .await?;
    let _ = website::publish_admin_notification(
        pool,
        "early_access.restored",
        "Early access restored",
        &format!(
            "Early access for {} was restored.",
            application.business_name
        ),
        "product_waitlist_entry",
        application_id,
        json!({ "organizationId": org_id, "invitationId": invitation_id }),
        &format!("early_access.restored:{application_id}:{revocation_event_id}"),
    )
    .await;
    get_application(pool, application_id)
        .await
        .map(|(application, _)| application)
}

pub async fn revoke_application(
    pool: &PgPool,
    application_id: &str,
    actor_id: &str,
    reason: &str,
) -> Result<EarlyAccessApplication, AppError> {
    let reason = required_text(Some(reason), "Revocation reason", 2_000)?;
    let application = get_application(pool, application_id).await?.0;
    if !matches!(
        application.status.as_str(),
        STATUS_APPROVED | STATUS_INVITED | STATUS_ACTIVE
    ) {
        return Err(AppError::Conflict(
            "Only approved, invited, or active access can be revoked".to_string(),
        ));
    }
    if let (Some(org_id), Some(invitation_id)) = (
        application.organization_id.as_deref(),
        application.invitation_id.as_deref(),
    ) {
        let _ = orgs::revoke_invitation(pool, org_id, invitation_id).await;
    }
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

pub async fn mark_activated(pool: &PgPool, org_id: &str, user_id: &str) -> Result<(), AppError> {
    expire_due_access(pool).await?;
    let applications = sqlx::query_as::<_, (String, String)>(
        r#"SELECT id, status FROM "ProductWaitlistEntry"
           WHERE "organizationId" = $1 AND status = 'invited'"#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    for (application_id, status) in applications {
        sqlx::query(r#"UPDATE "ProductWaitlistEntry" SET status = 'active', "activatedAt" = COALESCE("activatedAt", NOW()), "updatedAt" = NOW() WHERE id = $1 AND status = 'invited'"#)
            .bind(&application_id)
            .execute(pool)
            .await?;
        record_event(
            pool,
            &application_id,
            Some(&status),
            STATUS_ACTIVE,
            "activated",
            Some(user_id),
            None,
            json!({ "organizationId": org_id }),
        )
        .await?;
    }
    Ok(())
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
    use super::{selected_capabilities, transition_allowed};

    #[test]
    fn lifecycle_transitions_allow_review_approval_activation_and_reversal() {
        assert!(transition_allowed("new", "reviewing"));
        assert!(transition_allowed("new", "approved"));
        assert!(transition_allowed("reviewing", "rejected"));
        assert!(transition_allowed("approved", "invited"));
        assert!(transition_allowed("invited", "active"));
        assert!(transition_allowed("active", "expired"));
        assert!(transition_allowed("active", "revoked"));
        assert!(transition_allowed("revoked", "invited"));
        assert!(transition_allowed("revoked", "active"));
        assert!(transition_allowed("rejected", "reviewing"));
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
}
