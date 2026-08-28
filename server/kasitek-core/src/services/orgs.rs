use bcrypt::{hash, DEFAULT_COST};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Row};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::auth::send_email;
use crate::services::credits;
use crate::services::referrals;

// ─── DB row types ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OrgRow {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub logo: Option<String>,
    #[sqlx(rename = "ownerId")]
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    #[sqlx(rename = "reportingTimezone")]
    #[serde(rename = "reportingTimezone")]
    pub reporting_timezone: String,
    #[sqlx(rename = "createdAt")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OrgMemberRow {
    pub id: String,
    #[sqlx(rename = "orgId")]
    #[serde(rename = "orgId")]
    pub org_id: String,
    #[sqlx(rename = "userId")]
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    #[sqlx(rename = "joinedAt")]
    #[serde(rename = "joinedAt")]
    pub joined_at: DateTime<Utc>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OrgInvitationRow {
    pub id: String,
    #[sqlx(rename = "orgId")]
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub email: String,
    pub role: String,
    pub token: String,
    #[sqlx(rename = "invitedById")]
    #[serde(rename = "invitedById")]
    pub invited_by_id: String,
    #[sqlx(rename = "expiresAt")]
    #[serde(rename = "expiresAt")]
    pub expires_at: DateTime<Utc>,
    #[sqlx(rename = "acceptedAt")]
    #[serde(rename = "acceptedAt")]
    pub accepted_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "invitedByName")]
    #[serde(rename = "invitedByName")]
    pub invited_by_name: Option<String>,
}

// ─── Queries ──────────────────────────────────────────────

pub async fn get_org(pool: &PgPool, org_id: &str) -> Result<Option<OrgRow>, AppError> {
    Ok(sqlx::query_as::<_, OrgRow>(
        r#"SELECT id, name, slug, logo, "ownerId", "reportingTimezone",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                  "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
           FROM "Organization" WHERE id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list_orgs_for_user(pool: &PgPool, user_id: &str) -> Result<Vec<OrgRow>, AppError> {
    Ok(sqlx::query_as::<_, OrgRow>(
        r#"SELECT o.id, o.name, o.slug, o.logo, o."ownerId", o."reportingTimezone",
                  o."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                  o."updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
           FROM "Organization" o
           JOIN "OrganizationMember" m ON m."orgId" = o.id
           WHERE m."userId" = $1
           ORDER BY o."createdAt" ASC"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?)
}

pub async fn get_member_role(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT role::text FROM "OrganizationMember" WHERE "orgId" = $1 AND "userId" = $2"#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

/// Require user to be a member, return their role. Returns Forbidden if not a member.
pub async fn require_member(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
) -> Result<String, AppError> {
    get_member_role(pool, org_id, user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organisation".to_string()))
}

/// Require OWNER or ADMIN role.
pub async fn require_admin(pool: &PgPool, org_id: &str, user_id: &str) -> Result<(), AppError> {
    let role = require_member(pool, org_id, user_id).await?;
    if role == "OWNER" || role == "ADMIN" {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Admin or Owner role required".to_string(),
        ))
    }
}

/// Require OWNER role.
pub async fn require_owner(pool: &PgPool, org_id: &str, user_id: &str) -> Result<(), AppError> {
    let role = require_member(pool, org_id, user_id).await?;
    if role == "OWNER" {
        Ok(())
    } else {
        Err(AppError::Forbidden("Owner role required".to_string()))
    }
}

pub async fn create_org(
    pool: &PgPool,
    user_id: &str,
    name: &str,
    slug: &str,
    logo: Option<&str>,
    trial_credits: i64,
    trial_duration_days: i64,
) -> Result<OrgRow, AppError> {
    let org_id = cuid2::create_id();

    let mut transaction = pool.begin().await?;
    let org = sqlx::query_as::<_, OrgRow>(
        r#"INSERT INTO "Organization" (id, name, slug, logo, "ownerId", "reportingTimezone", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'UTC', NOW(), NOW())
           RETURNING id, name, slug, logo, "ownerId", "reportingTimezone",
                     "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                     "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt""#,
    )
    .bind(&org_id)
    .bind(name)
    .bind(slug)
    .bind(logo)
    .bind(user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("An organisation with that slug already exists".to_string())
        } else {
            AppError::from(e)
        }
    })?;

    // Add owner as OWNER member
    sqlx::query(
        r#"INSERT INTO "OrganizationMember" (id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'OWNER'::"OrgRole", NOW(), NOW(), NOW())"#,
    )
    .bind(cuid2::create_id())
    .bind(&org_id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;

    crate::analytics::enqueue_organization_scope_definition(
        &mut transaction,
        &org.id,
        org.created_at.timestamp_millis().max(1),
        &org.reporting_timezone,
        "active",
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!(
            "failed to queue organization Analytics scope: {error}"
        ))
    })?;

    transaction.commit().await?;

    referrals::ensure_referral_code(pool, &org_id).await?;

    credits::grant_system_credits(
        pool,
        &org_id,
        trial_credits,
        "TRIAL",
        Some(Utc::now() + Duration::days(trial_duration_days)),
        "Initial workspace trial credits",
        Some(&format!("trial:{org_id}")),
        Some(&serde_json::json!({
            "trialDurationDays": trial_duration_days,
        })),
        &format!("trial-grant:{org_id}"),
    )
    .await?;

    Ok(org)
}

pub async fn update_org(
    pool: &PgPool,
    org_id: &str,
    name: Option<&str>,
    logo: Option<Option<&str>>,
) -> Result<OrgRow, AppError> {
    Ok(sqlx::query_as::<_, OrgRow>(
        r#"UPDATE "Organization"
           SET name = COALESCE($1, name),
               logo = CASE WHEN $2 THEN $3 ELSE logo END,
               "updatedAt" = NOW()
           WHERE id = $4
           RETURNING id, name, slug, logo, "ownerId",
                     "reportingTimezone",
                     "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                     "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt""#,
    )
    .bind(name)
    .bind(logo.is_some())
    .bind(logo.flatten())
    .bind(org_id)
    .fetch_one(pool)
    .await?)
}

pub async fn delete_org(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    sqlx::query(r#"DELETE FROM "Organization" WHERE id = $1"#)
        .bind(org_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_members(pool: &PgPool, org_id: &str) -> Result<Vec<OrgMemberRow>, AppError> {
    Ok(sqlx::query_as::<_, OrgMemberRow>(
        r#"SELECT m.id, m."orgId", m."userId", m.role::text AS role,
                  m."joinedAt" AT TIME ZONE 'UTC' AS "joinedAt",
                  u.name, u.email, u.image
           FROM "OrganizationMember" m
           JOIN "User" u ON u.id = m."userId"
           WHERE m."orgId" = $1
           ORDER BY m."joinedAt" ASC"#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?)
}

pub async fn update_member_role(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    role: &str,
) -> Result<(), AppError> {
    let valid_roles = ["OWNER", "ADMIN", "MEMBER"];
    if !valid_roles.contains(&role) {
        return Err(AppError::BadRequest(format!("Invalid role: {}", role)));
    }

    let updated = sqlx::query(
        r#"UPDATE "OrganizationMember" SET role = $1::"OrgRole", "updatedAt" = NOW()
           WHERE "orgId" = $2 AND "userId" = $3"#,
    )
    .bind(role)
    .bind(org_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound("Member not found".to_string()));
    }

    // If promoting to OWNER, demote previous owner to ADMIN
    if role == "OWNER" {
        sqlx::query(
            r#"UPDATE "OrganizationMember"
               SET role = 'ADMIN'::"OrgRole", "updatedAt" = NOW()
               WHERE "orgId" = $1 AND "userId" != $2 AND role = 'OWNER'::"OrgRole""#,
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await?;

        sqlx::query(
            r#"UPDATE "Organization" SET "ownerId" = $1, "updatedAt" = NOW() WHERE id = $2"#,
        )
        .bind(user_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub async fn remove_member(pool: &PgPool, org_id: &str, user_id: &str) -> Result<(), AppError> {
    // Cannot remove the owner
    let role = get_member_role(pool, org_id, user_id).await?;
    if role.as_deref() == Some("OWNER") {
        return Err(AppError::BadRequest(
            "Cannot remove the organisation owner. Transfer ownership first.".to_string(),
        ));
    }

    sqlx::query(r#"DELETE FROM "OrganizationMember" WHERE "orgId" = $1 AND "userId" = $2"#)
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn list_invitations(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<OrgInvitationRow>, AppError> {
    Ok(sqlx::query_as::<_, OrgInvitationRow>(
        r#"SELECT i.id, i."orgId", i.email, i.role::text AS role, ''::text AS token,
                  i."invitedById", i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt",
                  i."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                  u.name AS "invitedByName"
           FROM "OrganizationInvitation" i
           JOIN "User" u ON u.id = i."invitedById"
           WHERE i."orgId" = $1 AND i."revokedAt" IS NULL
           ORDER BY i."createdAt" DESC"#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?)
}

pub async fn create_invitation(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    org_name: &str,
    invited_by_id: &str,
    invited_by_name: Option<&str>,
    email: &str,
    role: &str,
) -> Result<OrgInvitationRow, AppError> {
    let valid_roles = ["ADMIN", "MEMBER"];
    if !valid_roles.contains(&role) {
        return Err(AppError::BadRequest(format!(
            "Invalid role '{}'. Must be ADMIN or MEMBER.",
            role
        )));
    }

    // Check if already a member
    let already_active_member = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1 FROM "OrganizationMember" m
             JOIN "User" u ON u.id = m."userId"
             WHERE m."orgId" = $1 AND LOWER(u.email) = LOWER($2)
               AND (u.password IS NOT NULL OR u."emailVerified" IS NOT NULL)
           )"#,
    )
    .bind(org_id)
    .bind(email)
    .fetch_one(pool)
    .await?;

    if already_active_member {
        return Err(AppError::Conflict(
            "That person is already a member of this organisation".to_string(),
        ));
    }

    let token = crypto_utils::generate_token(48);
    let token_hash = crypto_utils::sha256_hex(&token);
    let expires_at = Utc::now() + Duration::days(7);

    // Upsert: if a pending invite exists for this email+org, replace it
    sqlx::query(
        r#"DELETE FROM "OrganizationInvitation"
           WHERE "orgId" = $1 AND LOWER(email) = LOWER($2) AND "acceptedAt" IS NULL"#,
    )
    .bind(org_id)
    .bind(email)
    .execute(pool)
    .await?;

    let inv = sqlx::query_as::<_, OrgInvitationRow>(
        r#"INSERT INTO "OrganizationInvitation"
             (id, "orgId", email, role, "tokenHash", "invitedById", "expiresAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4::"OrgRole", $5, $6, $7, NOW(), NOW())
           RETURNING
             id, "orgId", email, role::text AS role, ''::text AS token, "invitedById",
             "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
             "acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt",
             "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
             $8 AS "invitedByName""#,
    )
    .bind(cuid2::create_id())
    .bind(org_id)
    .bind(email)
    .bind(role)
    .bind(&token_hash)
    .bind(invited_by_id)
    .bind(expires_at)
    .bind(invited_by_name)
    .fetch_one(pool)
    .await?;

    let invite_url = format!("{}/invite/{}", config.auth_url, token);
    let sender_label = invited_by_name.unwrap_or("A team member");
    if let Err(error) = send_email(
        config,
        email,
        &format!("You're invited to join {} on KasiTek", org_name),
        &format!(
            "{} has invited you to join the \"{}\" organisation on KasiTek.\n\nAccept the invitation here:\n{}\n\nThis link expires in 7 days.",
            sender_label, org_name, invite_url
        ),
    )
    .await
    {
        // The invitation is durable and can be resent by an operator. Email
        // delivery must not turn a successful approval into an unknown state.
        observability::tracing::error!(
            event = "provider.call.failed",
            provider = "resend",
            operation = "organization_invitation.email",
            invitation_id = %inv.id,
            error_type = %std::any::type_name_of_val(&error),
            "invitation email delivery failed"
        );
    }

    Ok(inv)
}

pub async fn accept_invitation(
    pool: &PgPool,
    token: &str,
    user_id: &str,
) -> Result<OrgRow, AppError> {
    let token_hash = crypto_utils::sha256_hex(token);
    let inv = sqlx::query(
        r#"SELECT i.id, i."orgId", i.email, i.role::text AS role,
                  i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt"
           FROM "OrganizationInvitation" i
           WHERE i."tokenHash" = $1 AND i."revokedAt" IS NULL"#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Invitation not found".to_string()))?;

    let accepted_at: Option<DateTime<Utc>> = inv.try_get("acceptedAt").unwrap_or(None);
    if accepted_at.is_some() {
        return Err(AppError::BadRequest(
            "This invitation has already been accepted".to_string(),
        ));
    }

    let expires_at: DateTime<Utc> = inv.try_get("expiresAt").unwrap_or(Utc::now());
    if expires_at < Utc::now() {
        return Err(AppError::BadRequest(
            "This invitation has expired".to_string(),
        ));
    }

    let org_id: String = inv.try_get("orgId").unwrap_or_default();
    let role: String = inv.try_get("role").unwrap_or_else(|_| "MEMBER".to_string());
    let inv_id: String = inv.try_get("id").unwrap_or_default();

    let invited_email: String = inv.try_get("email").unwrap_or_default();
    let user_email =
        sqlx::query_scalar::<_, Option<String>>(r#"SELECT email FROM "User" WHERE id = $1"#)
            .bind(user_id)
            .fetch_one(pool)
            .await?
            .unwrap_or_default();
    if !user_email.eq_ignore_ascii_case(&invited_email) {
        return Err(AppError::Forbidden(
            "Sign in with the email address that received this invitation".to_string(),
        ));
    }

    // Add member (ignore if already exists)
    sqlx::query(
        r#"INSERT INTO "OrganizationMember"
             (id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4::"OrgRole", NOW(), NOW(), NOW())
           ON CONFLICT ("orgId", "userId") DO NOTHING"#,
    )
    .bind(cuid2::create_id())
    .bind(&org_id)
    .bind(user_id)
    .bind(&role)
    .execute(pool)
    .await?;

    // Mark invitation accepted
    sqlx::query(
        r#"UPDATE "OrganizationInvitation" SET "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&inv_id)
    .execute(pool)
    .await?;

    let org = get_org(pool, &org_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Organisation not found".to_string()))?;

    Ok(org)
}

pub async fn activate_invitation_with_new_user(
    pool: &PgPool,
    token: &str,
    name: Option<&str>,
    password: &str,
) -> Result<(OrgRow, String), AppError> {
    let token_hash = crypto_utils::sha256_hex(token);
    let mut tx = pool.begin().await?;
    let invitation = sqlx::query(
        r#"SELECT id, "orgId", email, role::text AS role,
                  "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt"
           FROM "OrganizationInvitation"
           WHERE "tokenHash" = $1 AND "revokedAt" IS NULL
           FOR UPDATE"#,
    )
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Invitation not found".to_string()))?;

    let accepted_at: Option<DateTime<Utc>> = invitation.try_get("acceptedAt").unwrap_or(None);
    let expires_at: DateTime<Utc> = invitation.try_get("expiresAt").unwrap_or(Utc::now());
    if accepted_at.is_some() || expires_at <= Utc::now() {
        return Err(AppError::BadRequest(
            "This invitation is no longer valid".to_string(),
        ));
    }

    let email: String = invitation.try_get("email").unwrap_or_default();
    let existing_user = sqlx::query(
        r#"SELECT id,
                  password IS NOT NULL AS "hasPassword",
                  EXISTS(SELECT 1 FROM "Account" a WHERE a."userId" = "User".id) AS "hasAccount"
           FROM "User" WHERE lower(email) = lower($1) LIMIT 1"#,
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await?;
    let password_hash = hash(password, DEFAULT_COST)?;
    let user_id = if let Some(existing_user) = existing_user {
        let has_password: bool = existing_user.try_get("hasPassword").unwrap_or(false);
        let has_account: bool = existing_user.try_get("hasAccount").unwrap_or(false);
        if has_password || has_account {
            return Err(AppError::Conflict(
                "An account already exists for this email. Sign in with that email to accept the invitation.".to_string(),
            ));
        }
        let user_id: String = existing_user.try_get("id").unwrap_or_default();
        sqlx::query(
            r#"UPDATE "User" SET name = COALESCE($1, name), password = $2, "emailVerified" = NOW(), "updatedAt" = NOW() WHERE id = $3"#,
        )
        .bind(name)
        .bind(password_hash)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
        user_id
    } else {
        let user_id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "User" (id, name, email, password, "emailVerified", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())"#,
        )
        .bind(&user_id)
        .bind(name)
        .bind(&email)
        .bind(password_hash)
        .execute(&mut *tx)
        .await?;
        user_id
    };

    let org_id: String = invitation.try_get("orgId").unwrap_or_default();
    let role: String = invitation
        .try_get("role")
        .unwrap_or_else(|_| "MEMBER".to_string());
    sqlx::query(
        r#"INSERT INTO "OrganizationMember" (id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4::"OrgRole", NOW(), NOW(), NOW())
           ON CONFLICT ("orgId", "userId") DO UPDATE SET role = EXCLUDED.role, "updatedAt" = NOW()"#,
    )
    .bind(cuid2::create_id())
    .bind(&org_id)
    .bind(&user_id)
    .bind(role)
    .execute(&mut *tx)
    .await?;

    let invitation_id: String = invitation.try_get("id").unwrap_or_default();
    sqlx::query(r#"UPDATE "OrganizationInvitation" SET "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
        .bind(invitation_id)
        .execute(&mut *tx)
        .await?;

    let org = sqlx::query_as::<_, OrgRow>(
        r#"SELECT id, name, slug, logo, "ownerId", "reportingTimezone", "createdAt" AT TIME ZONE 'UTC' AS "createdAt", "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
           FROM "Organization" WHERE id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((org, user_id))
}

pub async fn revoke_invitation(pool: &PgPool, org_id: &str, inv_id: &str) -> Result<(), AppError> {
    let revoked = sqlx::query(
        r#"UPDATE "OrganizationInvitation"
           SET "revokedAt" = NOW(), "updatedAt" = NOW()
           WHERE id = $1 AND "orgId" = $2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL"#,
    )
    .bind(inv_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    if revoked.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Pending invitation not found".to_string(),
        ));
    }

    Ok(())
}

pub async fn get_invitation_by_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<serde_json::Value>, AppError> {
    let token_hash = crypto_utils::sha256_hex(token);
    let row = sqlx::query(
        r#"SELECT i.id, i."orgId", i.email, i.role::text AS role,
                  i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt",
                  o.name AS "orgName", o.logo AS "orgLogo",
                  u.name AS "invitedByName"
           FROM "OrganizationInvitation" i
           JOIN "Organization" o ON o.id = i."orgId"
           JOIN "User" u ON u.id = i."invitedById"
           WHERE i."tokenHash" = $1 AND i."revokedAt" IS NULL"#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        serde_json::json!({
            "id": r.get::<String, _>("id"),
            "orgId": r.get::<String, _>("orgId"),
            "orgName": r.get::<String, _>("orgName"),
            "orgLogo": r.get::<Option<String>, _>("orgLogo"),
            "email": r.get::<String, _>("email"),
            "role": r.get::<String, _>("role"),
            "expiresAt": r.get::<DateTime<Utc>, _>("expiresAt"),
            "acceptedAt": r.get::<Option<DateTime<Utc>>, _>("acceptedAt"),
            "invitedByName": r.get::<Option<String>, _>("invitedByName"),
        })
    }))
}

/// Slugify a name: lowercase, replace spaces/special chars with hyphens, truncate to 48 chars.
pub fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    slug.chars().take(48).collect()
}

/// Ensure slug is unique by appending a suffix if needed.
pub async fn unique_slug(pool: &PgPool, base: &str) -> Result<String, AppError> {
    let mut candidate = base.to_string();
    let mut suffix = 2u32;
    loop {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(SELECT 1 FROM "Organization" WHERE slug = $1)"#,
        )
        .bind(&candidate)
        .fetch_one(pool)
        .await?;
        if !exists {
            return Ok(candidate);
        }
        candidate = format!("{}-{}", base, suffix);
        suffix += 1;
    }
}
