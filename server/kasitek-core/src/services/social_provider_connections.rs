use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::models::SocialChannel;
use crate::error::AppError;

use super::social::{
    encrypt_social_secret, merge_channel_metadata_with_capabilities, ThreadsProfile,
    ThreadsTokenResponse, TikTokProfile, TikTokTokenResponse,
};

pub(crate) async fn get_social_channel_by_external_account(
    pool: &PgPool,
    org_id: &str,
    platform: &str,
    external_account_id: &str,
) -> Result<Option<SocialChannel>, AppError> {
    let sql = format!(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1 AND platform = '{platform}'::"SocialPlatform" AND "externalAccountId" = $2
        LIMIT 1
        "#
    );
    sqlx::query_as::<_, SocialChannel>(&sql)
        .bind(org_id)
        .bind(external_account_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub(crate) async fn upsert_provider_connection(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    platform: &str,
    display_name: &str,
    handle: Option<String>,
    external_id: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    metadata: Value,
) -> Result<SocialChannel, AppError> {
    let access = encrypt_social_secret(access_token)?;
    let refresh = match refresh_token {
        Some(value) => Some(encrypt_social_secret(value)?),
        None => None,
    };
    let sql = format!(
        r#"
        INSERT INTO "SocialChannelConnection" (id, "userId", "orgId", platform, status, "displayName", handle,
          "externalAccountId", "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,'{platform}'::"SocialPlatform",'CONNECTED'::"SocialChannelStatus",$4,$5,$6,$7,$8,$9,NOW(),NOW(),NOW())
        ON CONFLICT ("orgId", platform, "externalAccountId") DO UPDATE SET "userId"=EXCLUDED."userId",
          status='CONNECTED'::"SocialChannelStatus", "displayName"=EXCLUDED."displayName", handle=EXCLUDED.handle,
          "accessToken"=EXCLUDED."accessToken", "refreshToken"=EXCLUDED."refreshToken", metadata=EXCLUDED.metadata,
          "lastSyncedAt"=NOW(), "updatedAt"=NOW()"#
    );
    sqlx::query(&sql)
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(org_id)
        .bind(display_name)
        .bind(handle)
        .bind(external_id)
        .bind(access)
        .bind(refresh)
        .bind(merge_channel_metadata_with_capabilities(
            platform,
            Some(metadata),
        ))
        .execute(pool)
        .await?;
    get_social_channel_by_external_account(pool, org_id, platform, external_id)
        .await?
        .ok_or_else(|| AppError::Internal(format!("Failed to load saved {platform} connection")))
}

pub async fn upsert_threads_connection_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &ThreadsTokenResponse,
    profile: &ThreadsProfile,
) -> Result<SocialChannel, AppError> {
    let access = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Threads access token".to_string()))?;
    upsert_provider_connection(
        pool,
        user_id,
        org_id,
        "THREADS",
        profile
            .name
            .as_deref()
            .or(profile.username.as_deref())
            .unwrap_or("Threads account"),
        profile.username.as_ref().map(|v| format!("@{v}")),
        &profile.id,
        access,
        None,
        json!({
            "provider":"threads",
            "expiresAt":tokens.expires_in.map(|s|(Utc::now()+Duration::seconds(s)).to_rfc3339()),
            "avatarUrl":profile.threads_profile_picture_url
        }),
    )
    .await
}

pub async fn upsert_tiktok_connection_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &TikTokTokenResponse,
    profile: &TikTokProfile,
) -> Result<SocialChannel, AppError> {
    let access = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing TikTok access token".to_string()))?;
    let open_id = profile
        .open_id
        .as_deref()
        .or(tokens.open_id.as_deref())
        .ok_or_else(|| {
            AppError::BadRequest("TikTok did not return an account identifier".to_string())
        })?;
    upsert_provider_connection(
        pool,
        user_id,
        org_id,
        "TIKTOK",
        profile
            .display_name
            .as_deref()
            .or(profile.username.as_deref())
            .unwrap_or("TikTok account"),
        profile.username.as_ref().map(|v| format!("@{v}")),
        open_id,
        access,
        tokens.refresh_token.as_deref(),
        json!({
            "provider":"tiktok",
            "scope":tokens.scope,
            "expiresAt":tokens.expires_in.map(|s|(Utc::now()+Duration::seconds(s)).to_rfc3339()),
            "refreshExpiresAt":tokens.refresh_expires_in.map(|s|(Utc::now()+Duration::seconds(s)).to_rfc3339()),
            "avatarUrl":profile.avatar_url
        }),
    )
    .await
}

pub async fn upsert_bluesky_oauth_connection_for_org(
    pool: &PgPool,
    authorization: &crate::services::bluesky_oauth::CompletedAuthorization,
) -> Result<SocialChannel, AppError> {
    upsert_provider_connection(
        pool,
        &authorization.user_id,
        &authorization.org_id,
        "BLUESKY",
        &authorization.handle,
        Some(format!("@{}", authorization.handle)),
        &authorization.did,
        &authorization.access_token,
        Some(&authorization.refresh_token),
        json!({
            "provider":"bluesky",
            "authMethod":"oauth",
            "pds":authorization.pds_url,
            "authorizationServer":authorization.authorization_url,
            "dpopPrivateKey":encrypt_social_secret(&authorization.dpop_private_key)?,
            "dpopAuthorizationNonce":authorization.authorization_nonce,
            "scope":authorization.scope,
            "expiresAt":authorization.expires_in.map(|seconds|(Utc::now()+Duration::seconds(seconds)).to_rfc3339())
        }),
    )
    .await
}
