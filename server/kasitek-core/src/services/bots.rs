use serde_json::Value;
use sqlx::PgPool;

use crate::db::models::{BotConfigurationRow, BotCreateRequest};
use crate::error::AppError;

fn select_bot_sql() -> &'static str {
    r#"
    SELECT id, "userId" AS user_id, name, type AS bot_type, status,
           "greetingMessage" AS greeting_message, personality, language,
           capabilities, "knowledgeBase" AS knowledge_base,
           "integrationConfig" AS integration_config,
           "createdAt" AS created_at, "updatedAt" AS updated_at
    FROM "BotConfiguration"
    "#
}

pub async fn create_bot(
    pool: &PgPool,
    user_id: &str,
    input: BotCreateRequest,
) -> Result<BotConfigurationRow, AppError> {
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Name and type are required".to_string()))?;
    let bot_type = input
        .bot_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Name and type are required".to_string()))?;
    if !matches!(bot_type, "starter" | "growth") {
        return Err(AppError::BadRequest(
            "Type must be 'starter' or 'growth'".to_string(),
        ));
    }
    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "BotConfiguration" (
            id, "userId", name, type, status, language, "knowledgeBase", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, 'draft', $5, $6, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(user_id)
    .bind(name)
    .bind(bot_type)
    .bind(input.language.as_deref().unwrap_or("en"))
    .bind(input.business_details)
    .execute(pool)
    .await?;

    get_bot(pool, user_id, &id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload bot".to_string()))
}

pub async fn get_bot(
    pool: &PgPool,
    user_id: &str,
    bot_id: &str,
) -> Result<Option<BotConfigurationRow>, AppError> {
    let sql = format!(
        "{} WHERE id = $1 AND \"userId\" = $2 LIMIT 1",
        select_bot_sql()
    );
    sqlx::query_as::<_, BotConfigurationRow>(&sql)
        .bind(bot_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn update_bot(
    pool: &PgPool,
    user_id: &str,
    bot_id: &str,
    body: Value,
) -> Result<BotConfigurationRow, AppError> {
    if get_bot(pool, user_id, bot_id).await?.is_none() {
        return Err(AppError::NotFound("Bot not found".to_string()));
    }
    sqlx::query(
        r#"
        UPDATE "BotConfiguration"
        SET name = COALESCE($1, name),
            type = COALESCE($2, type),
            status = COALESCE($3, status),
            "greetingMessage" = COALESCE($4, "greetingMessage"),
            personality = COALESCE($5, personality),
            language = COALESCE($6, language),
            capabilities = COALESCE($7, capabilities),
            "knowledgeBase" = COALESCE($8, "knowledgeBase"),
            "integrationConfig" = COALESCE($9, "integrationConfig"),
            "updatedAt" = NOW()
        WHERE id = $10 AND "userId" = $11
        "#,
    )
    .bind(
        body.get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("type")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("status")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("greetingMessage")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("personality")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        body.get("language")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(body.get("capabilities").cloned())
    .bind(body.get("knowledgeBase").cloned())
    .bind(body.get("integrationConfig").cloned())
    .bind(bot_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    get_bot(pool, user_id, bot_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload bot".to_string()))
}

pub async fn delete_bot(pool: &PgPool, user_id: &str, bot_id: &str) -> Result<(), AppError> {
    let result = sqlx::query(r#"DELETE FROM "BotConfiguration" WHERE id = $1 AND "userId" = $2"#)
        .bind(bot_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Bot not found".to_string()));
    }
    Ok(())
}
