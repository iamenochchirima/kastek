//! Workspace-owned developer API keys.
//!
//! Raw key material is returned only during creation/rotation. The database
//! stores a SHA-256 digest of a high-entropy secret and a safe display prefix.
//! These keys authenticate the direct public REST API and the MCP gateway. MCP
//! keeps its internal installation boundary, but the workspace key remains the
//! only user-facing credential.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};

use crate::error::AppError;

const KEY_PREFIX: &str = "kst_";
const DEFAULT_SCOPES: [&str; 2] = ["api:read", "api:write"];
type OldKeyRow = (String, Option<DateTime<Utc>>);

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DeveloperApiKeyRow {
    pub id: String,
    #[sqlx(rename = "orgId")]
    pub org_id: String,
    pub name: String,
    pub prefix: String,
    pub scopes: Vec<String>,
    pub status: String,
    #[sqlx(rename = "createdById")]
    pub created_by_id: String,
    #[sqlx(rename = "lastUsedAt")]
    pub last_used_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "revokedAt")]
    pub revoked_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeveloperApiKeyMetadata {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub scopes: Vec<String>,
    pub status: String,
    #[serde(rename = "createdById")]
    pub created_by_id: String,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<DateTime<Utc>>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<DateTime<Utc>>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatedDeveloperApiKey {
    pub key: DeveloperApiKeyMetadata,
    /// Copy-once raw secret. Never store this value in logs or subsequent DTOs.
    pub secret: String,
}

#[derive(Debug, Clone)]
pub struct DeveloperApiKeyAuth {
    pub id: String,
    pub organization_id: String,
    pub created_by_id: String,
    pub scopes: Vec<String>,
}

fn metadata(row: DeveloperApiKeyRow) -> DeveloperApiKeyMetadata {
    DeveloperApiKeyMetadata {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        status: row.status,
        created_by_id: row.created_by_id,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn hash_secret(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn generate_secret() -> (String, String, String) {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    let prefix = secret.chars().take(12).collect::<String>();
    let hash = hash_secret(&secret);
    (secret, prefix, hash)
}

pub fn valid_secret_shape(secret: &str) -> bool {
    secret.len() >= 40
        && secret.starts_with(KEY_PREFIX)
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn secret_digest(secret: &str) -> String {
    hash_secret(secret)
}

pub async fn list(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<DeveloperApiKeyMetadata>, AppError> {
    let rows = sqlx::query_as::<_, DeveloperApiKeyRow>(
        r#"
        SELECT id, "orgId", name, prefix, scopes,
               CASE WHEN status = 'ACTIVE' AND "expiresAt" IS NOT NULL AND "expiresAt" <= NOW()
                    THEN 'EXPIRED' ELSE status END AS status,
               "createdById",
               "lastUsedAt" AT TIME ZONE 'UTC' AS "lastUsedAt",
               "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
               "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
               "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "DeveloperApiKey"
        WHERE "orgId" = $1
        ORDER BY "createdAt" DESC
        "#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(metadata).collect())
}

pub async fn create(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    name: &str,
    expires_at: Option<DateTime<Utc>>,
) -> Result<CreatedDeveloperApiKey, AppError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::BadRequest(
            "API key name must be between 1 and 80 characters".to_string(),
        ));
    }
    if expires_at.is_some_and(|value| value <= Utc::now()) {
        return Err(AppError::BadRequest(
            "API key expiry must be in the future".to_string(),
        ));
    }

    let (secret, prefix, key_hash) = generate_secret();
    let row = sqlx::query_as::<_, DeveloperApiKeyRow>(
        r#"
        INSERT INTO "DeveloperApiKey"
          (id, "orgId", name, prefix, "keyHash", scopes, status, "createdById", "expiresAt", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, NOW(), NOW())
        RETURNING id, "orgId", name, prefix, scopes, status, "createdById",
                  "lastUsedAt" AT TIME ZONE 'UTC' AS "lastUsedAt",
                  "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                  "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        "#,
    )
    .bind(cuid2::create_id())
    .bind(organization_id)
    .bind(name)
    .bind(&prefix)
    .bind(&key_hash)
    .bind(DEFAULT_SCOPES.as_slice())
    .bind(actor_id)
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok(CreatedDeveloperApiKey {
        key: metadata(row),
        secret,
    })
}

pub async fn revoke(pool: &PgPool, organization_id: &str, key_id: &str) -> Result<(), AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "DeveloperApiKey"
        SET status = 'REVOKED', "revokedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1 AND "orgId" = $2 AND status = 'ACTIVE'
        "#,
    )
    .bind(key_id)
    .bind(organization_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Active API key not found".to_string()));
    }
    Ok(())
}

pub async fn rotate(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    key_id: &str,
) -> Result<CreatedDeveloperApiKey, AppError> {
    let mut transaction = pool.begin().await?;
    let old = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "DeveloperApiKey" WHERE id = $1 AND "orgId" = $2 AND status = 'ACTIVE' FOR UPDATE"#,
    )
    .bind(key_id)
    .bind(organization_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| AppError::NotFound("Active API key not found".to_string()))?;

    let old_row = sqlx::query_as::<_, OldKeyRow>(
        r#"SELECT name, "expiresAt" AT TIME ZONE 'UTC' FROM "DeveloperApiKey" WHERE id = $1"#,
    )
    .bind(&old)
    .fetch_one(&mut *transaction)
    .await?;
    let (secret, prefix, key_hash) = generate_secret();
    sqlx::query(
        r#"UPDATE "DeveloperApiKey" SET status = 'REVOKED', "revokedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&old)
    .execute(&mut *transaction)
    .await?;
    let new_row = sqlx::query_as::<_, DeveloperApiKeyRow>(
        r#"
        INSERT INTO "DeveloperApiKey"
          (id, "orgId", name, prefix, "keyHash", scopes, status, "createdById", "expiresAt", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, NOW(), NOW())
        RETURNING id, "orgId", name, prefix, scopes, status, "createdById",
                  "lastUsedAt" AT TIME ZONE 'UTC' AS "lastUsedAt",
                  "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
                  "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt",
                  "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
                  "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        "#,
    )
    .bind(cuid2::create_id())
    .bind(organization_id)
    .bind(format!("{} (rotated)", old_row.0).chars().take(80).collect::<String>())
    .bind(&prefix)
    .bind(&key_hash)
    .bind(DEFAULT_SCOPES.as_slice())
    .bind(actor_id)
    .bind(old_row.1)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(CreatedDeveloperApiKey {
        key: metadata(new_row),
        secret,
    })
}

pub async fn authenticate(
    pool: &PgPool,
    secret: &str,
) -> Result<Option<DeveloperApiKeyAuth>, AppError> {
    if !valid_secret_shape(secret) {
        return Ok(None);
    }
    let key_hash = hash_secret(secret);
    let row = sqlx::query_as::<_, (String, String, String, Vec<String>)>(
        r#"
        SELECT id, "orgId", "createdById", scopes
        FROM "DeveloperApiKey"
        WHERE "keyHash" = $1
          AND status = 'ACTIVE'
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        "#,
    )
    .bind(key_hash)
    .fetch_optional(pool)
    .await?;
    let Some((id, organization_id, created_by_id, scopes)) = row else {
        return Ok(None);
    };
    sqlx::query(
        r#"UPDATE "DeveloperApiKey" SET "lastUsedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&id)
    .execute(pool)
    .await?;
    Ok(Some(DeveloperApiKeyAuth {
        id,
        organization_id,
        created_by_id,
        scopes,
    }))
}

#[cfg(test)]
mod tests {
    use super::{hash_secret, valid_secret_shape, KEY_PREFIX};

    #[test]
    fn generated_key_shape_is_bounded_and_hashes_without_plaintext() {
        let secret = format!("{KEY_PREFIX}{}", "a".repeat(48));
        assert!(valid_secret_shape(&secret));
        assert!(!hash_secret(&secret).contains(&secret));
        assert_eq!(hash_secret(&secret).len(), 64);
    }

    #[test]
    fn malformed_or_short_values_are_not_treated_as_api_keys() {
        assert!(!valid_secret_shape("session-token"));
        assert!(!valid_secret_shape("kst_short"));
        assert!(!valid_secret_shape(
            format!("kst_{}", "a".repeat(10)).as_str()
        ));
    }
}
