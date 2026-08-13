use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;

use crate::db::models::{
    SocialChannel, SocialPost, SocialPostRow, SocialPostUpsertRequest, SocialPostVariant,
    SocialPostVariantInput, SocialPublishJobRow,
};
use crate::error::AppError;

use super::social::{
    get_social_channel, is_valid_platform, is_valid_post_status, is_valid_variant_status,
    parse_optional_datetime,
};

fn normalize_variants(
    variants: &Option<Vec<SocialPostVariantInput>>,
    channels: &[String],
    fallback_content: &str,
) -> Vec<SocialPostVariantInput> {
    channels
        .iter()
        .map(|platform| {
            let existing = variants
                .as_ref()
                .and_then(|items| items.iter().find(|item| item.platform == *platform))
                .cloned();

            SocialPostVariantInput {
                platform: platform.clone(),
                content: existing
                    .as_ref()
                    .map(|item| item.content.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| fallback_content.to_string()),
                status: existing
                    .as_ref()
                    .and_then(|item| item.status.clone())
                    .filter(|value| is_valid_variant_status(value))
                    .or(Some("DRAFT".to_string())),
                ai_generated: existing.as_ref().and_then(|item| item.ai_generated),
                metadata: existing.and_then(|item| item.metadata),
            }
        })
        .collect()
}

async fn load_posts(
    pool: &PgPool,
    org_id: &str,
    post_id: Option<&str>,
) -> Result<Vec<SocialPost>, AppError> {
    let rows = if let Some(post_id) = post_id {
        sqlx::query_as::<_, SocialPostRow>(
            r#"
            SELECT id, "userId" AS user_id, "primaryChannelId" AS primary_channel_id, title, prompt, content,
                   ARRAY(SELECT unnest(channels)::text) AS channels,
                   status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
                   metadata, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "SocialPost"
            WHERE "orgId" = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(post_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, SocialPostRow>(
            r#"
            SELECT id, "userId" AS user_id, "primaryChannelId" AS primary_channel_id, title, prompt, content,
                   ARRAY(SELECT unnest(channels)::text) AS channels,
                   status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
                   metadata, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "SocialPost"
            WHERE "orgId" = $1
            ORDER BY "createdAt" DESC
            "#,
        )
        .bind(org_id)
        .fetch_all(pool)
        .await?
    };

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let post_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let primary_channel_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.primary_channel_id.clone())
        .collect();

    let variants = sqlx::query_as::<_, SocialPostVariant>(
        r#"
        SELECT id, "postId" AS post_id, platform::text AS platform, content, status::text AS status,
               "aiGenerated" AS ai_generated, metadata, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialPostVariant"
        WHERE "postId" = ANY($1)
        ORDER BY "createdAt" ASC
        "#,
    )
    .bind(&post_ids)
    .fetch_all(pool)
    .await?;

    let jobs = sqlx::query_as::<_, SocialPublishJobRow>(
        r#"
        SELECT id, "userId" AS user_id, "postId" AS post_id, "variantId" AS variant_id,
               "channelConnectionId" AS channel_connection_id, platform::text AS platform,
               status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
               "externalPostId" AS external_post_id, "errorMessage" AS error_message,
               metadata, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialPublishJob"
        WHERE "postId" = ANY($1)
        ORDER BY "createdAt" DESC
        "#,
    )
    .bind(&post_ids)
    .fetch_all(pool)
    .await?;

    let channels = if primary_channel_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, SocialChannel>(
            r#"
            SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
                   "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
                   metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "SocialChannelConnection"
            WHERE id = ANY($1)
            "#,
        )
        .bind(&primary_channel_ids)
        .fetch_all(pool)
        .await?
    };

    let mut variants_by_post: HashMap<String, Vec<SocialPostVariant>> = HashMap::new();
    for variant in variants {
        variants_by_post
            .entry(variant.post_id.clone())
            .or_default()
            .push(variant);
    }

    let mut jobs_by_post: HashMap<String, Vec<SocialPublishJobRow>> = HashMap::new();
    for job in jobs {
        jobs_by_post
            .entry(job.post_id.clone())
            .or_default()
            .push(job);
    }

    let channels_by_id = channels
        .into_iter()
        .map(|channel| (channel.id.clone(), channel))
        .collect::<HashMap<_, _>>();

    Ok(rows
        .into_iter()
        .map(|row| {
            SocialPost::from_parts(
                row.clone(),
                &channels_by_id,
                variants_by_post.remove(&row.id).unwrap_or_default(),
                jobs_by_post.remove(&row.id).unwrap_or_default(),
            )
        })
        .collect())
}

pub async fn list_social_posts(pool: &PgPool, org_id: &str) -> Result<Vec<SocialPost>, AppError> {
    load_posts(pool, org_id, None).await
}

pub async fn get_social_post(
    pool: &PgPool,
    org_id: &str,
    post_id: &str,
) -> Result<Option<SocialPost>, AppError> {
    Ok(load_posts(pool, org_id, Some(post_id))
        .await?
        .into_iter()
        .next())
}

async fn validate_primary_channel(
    pool: &PgPool,
    org_id: &str,
    primary_channel_id: &Option<String>,
) -> Result<Option<String>, AppError> {
    let Some(primary_channel_id) = primary_channel_id
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    let exists = get_social_channel(pool, org_id, primary_channel_id).await?;
    if exists.is_none() {
        return Err(AppError::NotFound(
            "Primary channel was not found".to_string(),
        ));
    }
    Ok(Some(primary_channel_id.to_string()))
}

async fn create_variants_and_jobs(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    org_id: &str,
    post_id: &str,
    variants: &[SocialPostVariantInput],
    channel_selections: &HashMap<String, String>,
    post_status: &str,
    scheduled_for: Option<DateTime<Utc>>,
) -> Result<(), AppError> {
    for variant in variants {
        let variant_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO "SocialPostVariant" (
                id, "postId", platform, content, status, "aiGenerated", metadata, "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, CAST($3 AS "SocialPlatform"), $4, CAST($5 AS "SocialVariantStatus"), $6, $7, NOW(), NOW()
            )
            "#,
        )
        .bind(&variant_id)
        .bind(post_id)
        .bind(&variant.platform)
        .bind(&variant.content)
        .bind(variant.status.clone().unwrap_or_else(|| "DRAFT".to_string()))
        .bind(variant.ai_generated.unwrap_or(false))
        .bind(&variant.metadata)
        .execute(tx.as_mut())
        .await?;

        sqlx::query(
            r#"
            INSERT INTO "SocialPublishJob" (
                id, "userId", "orgId", "postId", "variantId", "channelConnectionId", platform, status, "scheduledFor", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, CAST($7 AS "SocialPlatform"),
                CAST($8 AS "SocialPublishJobStatus"), $9, NOW(), NOW()
            )
            "#,
        )
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(org_id)
        .bind(post_id)
        .bind(variant_id)
        .bind(channel_selections.get(&variant.platform))
        .bind(&variant.platform)
        .bind(if post_status == "SCHEDULED" { "QUEUED" } else { "PENDING" })
        .bind(scheduled_for)
        .execute(tx.as_mut())
        .await?;
    }

    Ok(())
}

async fn validate_channel_selections(
    pool: &PgPool,
    org_id: &str,
    channels: &[String],
    selections: &Option<HashMap<String, String>>,
) -> Result<HashMap<String, String>, AppError> {
    let selections = selections.clone().unwrap_or_default();
    let mut validated = HashMap::new();

    for platform in channels {
        let channel_id = selections
            .get(platform)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "Choose a connected {} account before saving",
                    platform.to_lowercase()
                ))
            })?;
        let channel = get_social_channel(pool, org_id, channel_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Selected channel was not found".to_string()))?;
        if channel.status != "CONNECTED" || channel.platform != *platform {
            return Err(AppError::BadRequest(format!(
                "Choose a connected {} account before saving",
                platform.to_lowercase()
            )));
        }
        validated.insert(platform.clone(), channel.id);
    }

    Ok(validated)
}

pub async fn create_social_post(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    create_social_post_idempotent(pool, user_id, org_id, request, None).await
}

pub async fn create_social_post_idempotent(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    request: &SocialPostUpsertRequest,
    idempotency_key: Option<&str>,
) -> Result<SocialPost, AppError> {
    let content = request
        .content
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("Post content is required".to_string()))?;
    let channels = request
        .channels
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|channel| is_valid_platform(channel))
        .collect::<Vec<_>>();

    if channels.is_empty() {
        return Err(AppError::BadRequest(
            "At least one publishing channel is required".to_string(),
        ));
    }

    let status = request
        .status
        .clone()
        .unwrap_or_else(|| "DRAFT".to_string());
    if !is_valid_post_status(&status) {
        return Err(AppError::BadRequest("Invalid post status".to_string()));
    }

    let scheduled_for = parse_optional_datetime(&request.scheduled_for)?;
    let primary_channel_id =
        validate_primary_channel(pool, org_id, &request.primary_channel_id).await?;
    let channel_selections =
        validate_channel_selections(pool, org_id, &channels, &request.channel_selections).await?;
    let variants = normalize_variants(&request.variants, &channels, &content);

    let idempotency_key = idempotency_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(key) = idempotency_key {
        if key.len() > 240 {
            return Err(AppError::BadRequest(
                "Content draft idempotency key is too long".to_string(),
            ));
        }
        if let Some(existing_id) = sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "SocialPost" WHERE "orgId" = $1 AND metadata->>'_kasitek_agent_idempotency_key' = $2 LIMIT 1"#,
        )
        .bind(org_id)
        .bind(key)
        .fetch_optional(pool)
        .await?
        {
            return get_social_post(pool, org_id, &existing_id)
                .await?
                .ok_or_else(|| AppError::Internal("Idempotent content draft disappeared".to_string()));
        }
    }

    let metadata = if let Some(key) = idempotency_key {
        let mut metadata = request.metadata.clone().unwrap_or_else(|| json!({}));
        let object = metadata.as_object_mut().ok_or_else(|| {
            AppError::BadRequest("Content metadata must be a JSON object".to_string())
        })?;
        object.insert(
            "_kasitek_agent_idempotency_key".to_string(),
            Value::String(key.to_string()),
        );
        Some(metadata)
    } else {
        request.metadata.clone()
    };
    let post_id = cuid2::create_id();

    let mut tx = pool.begin().await?;
    if let Some(key) = idempotency_key {
        let lock_key = format!("kasitek.content.draft:{org_id}:{key}");
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await?;
        if let Some(existing_id) = sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM "SocialPost" WHERE "orgId" = $1 AND metadata->>'_kasitek_agent_idempotency_key' = $2 LIMIT 1"#,
        )
        .bind(org_id)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.rollback().await?;
            return get_social_post(pool, org_id, &existing_id)
                .await?
                .ok_or_else(|| AppError::Internal("Idempotent content draft disappeared".to_string()));
        }
    }

    sqlx::query(
        r#"
        INSERT INTO "SocialPost" (
            id, "userId", "orgId", "primaryChannelId", title, prompt, content, channels, status,
            "scheduledFor", metadata, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, ARRAY(SELECT unnest($8::text[])::"SocialPlatform"),
            CAST($9 AS "SocialPostStatus"), $10, $11, NOW(), NOW()
        )
        "#,
    )
    .bind(&post_id)
    .bind(user_id)
    .bind(org_id)
    .bind(primary_channel_id)
    .bind(
        request
            .title
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty()),
    )
    .bind(
        request
            .prompt
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty()),
    )
    .bind(&content)
    .bind(&channels)
    .bind(&status)
    .bind(scheduled_for)
    .bind(&metadata)
    .execute(tx.as_mut())
    .await?;
    create_variants_and_jobs(
        &mut tx,
        user_id,
        org_id,
        &post_id,
        &variants,
        &channel_selections,
        &status,
        scheduled_for,
    )
    .await?;
    tx.commit().await?;

    get_social_post(pool, org_id, &post_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load created social post".to_string()))
}

pub async fn update_social_post(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    post_id: &str,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    let existing = get_social_post(pool, org_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;

    let row = existing.row;
    let content = match request.content.as_ref() {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(AppError::BadRequest(
                    "Post content cannot be empty".to_string(),
                ));
            }
            trimmed.to_string()
        }
        None => row.content.clone(),
    };

    let channels = request
        .channels
        .clone()
        .unwrap_or_else(|| row.channels.clone())
        .into_iter()
        .filter(|channel| is_valid_platform(channel))
        .collect::<Vec<_>>();
    if channels.is_empty() {
        return Err(AppError::BadRequest(
            "At least one publishing channel is required".to_string(),
        ));
    }

    let status = request.status.clone().unwrap_or_else(|| row.status.clone());
    if !is_valid_post_status(&status) {
        return Err(AppError::BadRequest("Invalid post status".to_string()));
    }

    let scheduled_for = if request.scheduled_for.is_some() {
        parse_optional_datetime(&request.scheduled_for)?
    } else {
        row.scheduled_for
    };

    let primary_channel_request = if request.primary_channel_id.is_some() {
        request.primary_channel_id.clone()
    } else {
        row.primary_channel_id.clone()
    };
    let primary_channel_id =
        validate_primary_channel(pool, org_id, &primary_channel_request).await?;
    let channel_selections =
        validate_channel_selections(pool, org_id, &channels, &request.channel_selections).await?;
    let variants = normalize_variants(&request.variants, &channels, &content);

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE "SocialPost"
        SET "primaryChannelId" = $1,
            title = $2,
            prompt = $3,
            content = $4,
            channels = ARRAY(SELECT unnest($5::text[])::"SocialPlatform"),
            status = CAST($6 AS "SocialPostStatus"),
            "scheduledFor" = $7,
            metadata = $8,
            "updatedAt" = NOW()
        WHERE id = $9 AND "orgId" = $10
        "#,
    )
    .bind(primary_channel_id)
    .bind(
        request
            .title
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .or(row.title.as_deref()),
    )
    .bind(
        request
            .prompt
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .or(row.prompt.as_deref()),
    )
    .bind(&content)
    .bind(&channels)
    .bind(&status)
    .bind(scheduled_for)
    .bind(request.metadata.clone().or(row.metadata.clone()))
    .bind(post_id)
    .bind(org_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(r#"DELETE FROM "SocialPublishJob" WHERE "postId" = $1"#)
        .bind(post_id)
        .execute(tx.as_mut())
        .await?;
    sqlx::query(r#"DELETE FROM "SocialPostVariant" WHERE "postId" = $1"#)
        .bind(post_id)
        .execute(tx.as_mut())
        .await?;

    create_variants_and_jobs(
        &mut tx,
        user_id,
        org_id,
        post_id,
        &variants,
        &channel_selections,
        &status,
        scheduled_for,
    )
    .await?;
    tx.commit().await?;

    get_social_post(pool, org_id, post_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load updated social post".to_string()))
}

pub async fn delete_social_post(
    pool: &PgPool,
    org_id: &str,
    post_id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query(r#"DELETE FROM "SocialPost" WHERE id = $1 AND "orgId" = $2"#)
        .bind(post_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}
