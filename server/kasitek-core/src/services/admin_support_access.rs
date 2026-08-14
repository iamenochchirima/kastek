use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::db::models::AdminUser;
use crate::error::AppError;

const MAX_DURATION_MINUTES: i64 = 60;
const MIN_REASON_LENGTH: usize = 8;
const MAX_REASON_LENGTH: usize = 500;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSupportAccessRequest {
    pub admin_id: String,
    pub organization_id: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub reason: String,
    pub duration_minutes: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SupportAccessGrant {
    pub id: String,
    #[serde(rename = "adminId")]
    #[sqlx(rename = "adminId")]
    pub admin_id: String,
    #[serde(rename = "organizationId")]
    #[sqlx(rename = "organizationId")]
    pub organization_id: String,
    #[serde(rename = "resourceType")]
    #[sqlx(rename = "resourceType")]
    pub resource_type: String,
    #[serde(rename = "resourceId")]
    #[sqlx(rename = "resourceId")]
    pub resource_id: Option<String>,
    pub reason: String,
    #[serde(rename = "grantedById")]
    #[sqlx(rename = "grantedById")]
    pub granted_by_id: String,
    #[serde(rename = "expiresAt")]
    #[sqlx(rename = "expiresAt")]
    pub expires_at: DateTime<Utc>,
    #[serde(rename = "revokedAt")]
    #[sqlx(rename = "revokedAt")]
    pub revoked_at: Option<DateTime<Utc>>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
}

fn validate_request(input: &CreateSupportAccessRequest) -> Result<(), AppError> {
    let resource_type = input.resource_type.trim();
    if !matches!(
        resource_type,
        "organization" | "conversation" | "customer" | "run"
    ) {
        return Err(AppError::BadRequest(
            "resourceType must be organization, conversation, customer, or run".to_string(),
        ));
    }
    let resource_id_empty = input
        .resource_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty();
    if (resource_type == "organization") != resource_id_empty {
        return Err(AppError::BadRequest(
            "organization grants omit resourceId; narrower grants require it".to_string(),
        ));
    }
    let reason = input.reason.trim();
    if reason.len() < MIN_REASON_LENGTH || reason.len() > MAX_REASON_LENGTH {
        return Err(AppError::BadRequest(format!(
            "reason must be {MIN_REASON_LENGTH}-{MAX_REASON_LENGTH} characters"
        )));
    }
    if !(1..=MAX_DURATION_MINUTES).contains(&input.duration_minutes) {
        return Err(AppError::BadRequest(format!(
            "durationMinutes must be between 1 and {MAX_DURATION_MINUTES}"
        )));
    }
    if input.admin_id.trim().is_empty() || input.organization_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "adminId and organizationId are required".to_string(),
        ));
    }
    Ok(())
}

pub fn can_manage(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "admin" | "superadmin" | "owner"
    )
}

pub fn can_view(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "support" | "security" | "operator" | "admin" | "superadmin" | "owner"
    )
}

pub async fn create(
    pool: &PgPool,
    actor: &AdminUser,
    input: CreateSupportAccessRequest,
) -> Result<SupportAccessGrant, AppError> {
    validate_request(&input)?;
    let grant = sqlx::query_as::<_, SupportAccessGrant>(
        r#"
        INSERT INTO "AdminSupportAccessGrant"
          ("id", "adminId", "organizationId", "resourceType", "resourceId",
           "reason", "grantedById", "expiresAt")
        VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
        RETURNING "id", "adminId", "organizationId", "resourceType", "resourceId",
                  "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        "#,
    )
    .bind(cuid2::create_id())
    .bind(input.admin_id.trim())
    .bind(input.organization_id.trim())
    .bind(input.resource_type.trim())
    .bind(input.resource_id.as_deref().unwrap_or("").trim())
    .bind(input.reason.trim())
    .bind(actor.id.trim())
    .bind(Utc::now() + Duration::minutes(input.duration_minutes))
    .fetch_one(pool)
    .await?;

    record_audit(
        pool,
        &grant.id,
        &actor.id,
        "granted",
        serde_json::json!({
            "organizationId": grant.organization_id,
            "resourceType": grant.resource_type,
            "resourceId": grant.resource_id,
            "expiresAt": grant.expires_at,
        }),
    )
    .await?;
    Ok(grant)
}

pub async fn list(
    pool: &PgPool,
    organization_id: Option<&str>,
) -> Result<Vec<SupportAccessGrant>, AppError> {
    Ok(sqlx::query_as::<_, SupportAccessGrant>(
        r#"
        SELECT "id", "adminId", "organizationId", "resourceType", "resourceId",
               "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
               "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        FROM "AdminSupportAccessGrant"
        WHERE ($1::text IS NULL OR "organizationId" = $1)
        ORDER BY "createdAt" DESC
        LIMIT 200
        "#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await?)
}

pub async fn revoke(
    pool: &PgPool,
    actor: &AdminUser,
    grant_id: &str,
) -> Result<SupportAccessGrant, AppError> {
    let grant = sqlx::query_as::<_, SupportAccessGrant>(
        r#"
        UPDATE "AdminSupportAccessGrant"
        SET "revokedAt" = NOW()
        WHERE "id" = $1 AND "revokedAt" IS NULL
        RETURNING "id", "adminId", "organizationId", "resourceType", "resourceId",
                  "reason", "grantedById", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        "#,
    )
    .bind(grant_id.trim())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("active support grant not found".to_string()))?;
    record_audit(
        pool,
        &grant.id,
        &actor.id,
        "revoked",
        serde_json::json!({
            "organizationId": grant.organization_id,
            "resourceType": grant.resource_type,
            "resourceId": grant.resource_id,
        }),
    )
    .await?;
    Ok(grant)
}

pub async fn allows(
    pool: &PgPool,
    admin_id: &str,
    organization_id: &str,
    resource_type: &str,
    resource_id: Option<&str>,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1
          FROM "AdminSupportAccessGrant"
          WHERE "adminId" = $1
            AND "organizationId" = $2
            AND "revokedAt" IS NULL
            AND "expiresAt" > NOW()
            AND (
              ("resourceType" = 'organization' AND "resourceId" IS NULL)
              OR ("resourceType" = $3 AND "resourceId" = $4)
            )
        )
        "#,
    )
    .bind(admin_id)
    .bind(organization_id)
    .bind(resource_type)
    .bind(resource_id)
    .fetch_one(pool)
    .await?)
}

async fn record_audit(
    pool: &PgPool,
    grant_id: &str,
    actor_id: &str,
    action: &str,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO "AdminSupportAccessAuditEvent"
           ("id", "grantId", "actorId", "action", "metadata")
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(cuid2::create_id())
    .bind(grant_id)
    .bind(actor_id)
    .bind(action)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{can_manage, can_view, validate_request, CreateSupportAccessRequest};

    #[test]
    fn separates_support_access_management_from_viewing() {
        assert!(can_manage("admin"));
        assert!(can_manage("owner"));
        assert!(!can_manage("support"));
        assert!(can_view("support"));
        assert!(!can_view("viewer"));
    }

    #[test]
    fn validates_narrow_and_time_limited_grants() {
        let base = CreateSupportAccessRequest {
            admin_id: "admin-1".to_string(),
            organization_id: "org-1".to_string(),
            resource_type: "conversation".to_string(),
            resource_id: Some("conversation-1".to_string()),
            reason: "Incident review".to_string(),
            duration_minutes: 30,
        };
        assert!(validate_request(&base).is_ok());
        assert!(validate_request(&CreateSupportAccessRequest {
            resource_id: None,
            ..base.clone()
        })
        .is_err());
        assert!(validate_request(&CreateSupportAccessRequest {
            duration_minutes: 61,
            ..base
        })
        .is_err());
    }
}
