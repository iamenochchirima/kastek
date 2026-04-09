use actix_web::HttpRequest;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use types::TenantWorkspaceContext;

use crate::error::AppError;

#[derive(Debug, FromRow)]
struct WorkspaceApiKeyRow {
    workspace_id: String,
    workspace_slug: String,
    workspace_status: String,
    scopes: Value,
    key_id: String,
    revoked_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
}

pub fn extract_bearer_token(req: &HttpRequest) -> Result<String, AppError> {
    req.headers()
        .get("Authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or(AppError::Unauthorized)
}

pub async fn extract_workspace_context(req: &HttpRequest) -> Result<TenantWorkspaceContext, AppError> {
    let token = extract_bearer_token(req)?;
    let token_hash = crypto_utils::sha256_hex(&token);
    let pool = req
        .app_data::<actix_web::web::Data<PgPool>>()
        .map(|data| data.get_ref())
        .ok_or_else(|| AppError::BadRequest("database pool is not configured".to_string()))?;

    let record = sqlx::query_as::<_, WorkspaceApiKeyRow>(
        r#"
        SELECT
            w.id AS workspace_id,
            w.slug AS workspace_slug,
            w.status AS workspace_status,
            k.scopes AS scopes,
            k.id AS key_id,
            k.revoked_at AT TIME ZONE 'UTC' AS revoked_at,
            k.expires_at AT TIME ZONE 'UTC' AS expires_at
        FROM workspace_api_keys k
        JOIN workspaces w ON w.id = k.workspace_id
        WHERE k.key_hash = $1
        LIMIT 1
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if record.workspace_status != "active" {
        return Err(AppError::Forbidden);
    }

    if record.revoked_at.is_some() {
        return Err(AppError::Unauthorized);
    }

    if let Some(expires_at) = record.expires_at {
        if expires_at <= Utc::now() {
            return Err(AppError::Unauthorized);
        }
    }

    sqlx::query(
        r#"
        UPDATE workspace_api_keys
        SET last_used_at = NOW(), updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(&record.key_id)
    .execute(pool)
    .await?;

    Ok(TenantWorkspaceContext {
        workspace_id: record.workspace_id,
        workspace_slug: record.workspace_slug,
        scopes: parse_scopes(record.scopes),
    })
}

fn parse_scopes(value: Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect(),
        _ => Vec::new(),
    }
}
