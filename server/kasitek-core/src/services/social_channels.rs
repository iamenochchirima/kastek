//! Social channel capability metadata.
//!
//! Provider connection state and channel capability descriptions are kept
//! separate from post publishing and OAuth code. This module is intentionally
//! transport-neutral so the product and capability adapters can share it.

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::models::SocialChannel;
use crate::error::AppError;

use super::social::merge_channel_metadata_with_capabilities;

pub fn platform_capabilities(platform: &str) -> Value {
    match platform {
        "FACEBOOK" | "INSTAGRAM" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": platform == "INSTAGRAM",
            "supportsComments": true,
            "supportsDMs": true,
            "supportsAnalytics": true,
            "supportsInbox": true,
            "supportsVariants": true,
            "media": { "images": { "supported": platform == "INSTAGRAM", "maxCount": 1 }, "videos": { "supported": false, "maxCount": 0 } },
        }),
        "THREADS" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
            "media": { "images": { "supported": false, "maxCount": 0 }, "videos": { "supported": false, "maxCount": 0 } },
        }),
        "TIKTOK" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
            "media": { "images": { "supported": true, "maxCount": 1 }, "videos": { "supported": true, "maxCount": 1 } },
        }),
        "BLUESKY" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
            "media": { "images": { "supported": false, "maxCount": 0 }, "videos": { "supported": false, "maxCount": 0 } },
        }),
        "LINKEDIN" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
            "media": { "images": { "supported": true, "maxCount": 1 }, "videos": { "supported": false, "maxCount": 0 } },
        }),
        "X" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": false,
            "supportsComments": true,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
            "media": { "images": { "supported": false, "maxCount": 0 }, "videos": { "supported": false, "maxCount": 0 } },
        }),
        _ => json!({
            "canPublish": false,
            "supportsManualPublish": false,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": false,
        }),
    }
}

pub async fn list_social_channels(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<SocialChannel>, AppError> {
    let mut channels = sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1
        ORDER BY platform ASC, "createdAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)?;
    for channel in &mut channels {
        sanitize_public_channel_metadata(&mut channel.metadata);
    }
    Ok(channels)
}

fn sanitize_public_channel_metadata(metadata: &mut Option<Value>) {
    let Some(Value::Object(object)) = metadata.as_mut() else {
        return;
    };
    for key in [
        "scope",
        "permissions",
        "tasks",
        "tokenType",
        "dpopPrivateKey",
        "dpopAuthorizationNonce",
    ] {
        object.remove(key);
    }
}

pub async fn get_social_channel(
    pool: &PgPool,
    org_id: &str,
    id: &str,
) -> Result<Option<SocialChannel>, AppError> {
    sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE id = $1 AND "orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn create_social_channel(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    platform: &str,
    display_name: &str,
    handle: Option<String>,
    external_account_id: Option<String>,
    status: &str,
    metadata: Option<Value>,
) -> Result<SocialChannel, AppError> {
    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId", metadata, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, CAST($4 AS "SocialPlatform"), CAST($5 AS "SocialChannelStatus"), $6, $7, $8, $9, NOW(), NOW()
        )
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(platform)
    .bind(status)
    .bind(display_name)
    .bind(handle)
    .bind(external_account_id)
    .bind(merge_channel_metadata_with_capabilities(platform, metadata))
    .execute(pool)
    .await?;

    sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 1
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await
    .map_err(AppError::from)
}

pub async fn update_social_channel(
    pool: &PgPool,
    org_id: &str,
    id: &str,
    platform: &str,
    display_name: &str,
    handle: Option<String>,
    status: &str,
    metadata: Option<Value>,
) -> Result<SocialChannel, AppError> {
    sqlx::query(
        r#"
        UPDATE "SocialChannelConnection"
        SET platform = CAST($1 AS "SocialPlatform"),
            "displayName" = $2,
            handle = $3,
            status = CAST($4 AS "SocialChannelStatus"),
            metadata = $5,
            "updatedAt" = NOW()
        WHERE id = $6 AND "orgId" = $7
        "#,
    )
    .bind(platform)
    .bind(display_name)
    .bind(handle)
    .bind(status)
    .bind(merge_channel_metadata_with_capabilities(platform, metadata))
    .bind(id)
    .bind(org_id)
    .execute(pool)
    .await?;

    get_social_channel(pool, org_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))
}

pub async fn delete_social_channel(
    pool: &PgPool,
    org_id: &str,
    id: &str,
) -> Result<bool, AppError> {
    let result =
        sqlx::query(r#"DELETE FROM "SocialChannelConnection" WHERE id = $1 AND "orgId" = $2"#)
            .bind(id)
            .bind(org_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::platform_capabilities;

    #[test]
    fn channel_capabilities_are_provider_specific_and_safe_by_default() {
        assert_eq!(platform_capabilities("INSTAGRAM")["canPublish"], true);
        assert_eq!(platform_capabilities("THREADS")["supportsDMs"], false);
        assert_eq!(platform_capabilities("unknown")["canPublish"], false);
    }
}
