use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::models::SocialChannel;
use crate::error::AppError;

use super::social::{
    encrypt_social_secret, fetch_page_instagram_account, merge_channel_metadata_with_capabilities,
    value_as_identifier, InstagramProfile, InstagramTokenResponse, LinkedInPage, LinkedInProfile,
    LinkedInTokenResponse, MetaPageAccount, MetaTokenResponse, ThreadsProfile,
    ThreadsTokenResponse, TikTokProfile, TikTokTokenResponse, XMeData, XTokenResponse,
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
            "scope":tokens.scope,
            "expiresAt":tokens.expires_in.map(|s|(Utc::now()+Duration::seconds(s)).to_rfc3339()),
            "avatarUrl":profile.threads_profile_picture_url
        }),
    )
    .await
}
pub async fn upsert_meta_connections_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    user_tokens: &MetaTokenResponse,
    pages: &[MetaPageAccount],
    granted_permissions: Option<&[String]>,
    include_facebook_pages: bool,
    include_instagram_accounts: bool,
) -> Result<Vec<SocialChannel>, AppError> {
    let user_access_token = user_tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Meta access token".to_string()))?;
    let encrypted_user_access_token = encrypt_social_secret(user_access_token)?;
    let user_token_expires_at = user_tokens
        .expires_in
        .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    let mut saved = Vec::new();

    for page in pages {
        let page_access_token = match page.access_token.as_deref() {
            Some(value) if !value.trim().is_empty() => value,
            _ => continue,
        };
        let encrypted_page_access_token = encrypt_social_secret(page_access_token)?;
        let page_metadata = json!({
            "provider": "meta",
            "authMethod": "meta_login",
            "assetType": "facebook_page",
            "pageId": page.id,
            "username": page.username,
            "pictureUrl": page.picture.as_ref().and_then(|picture| picture.data.as_ref()).and_then(|data| data.url.clone()),
            "tasks": page.tasks.clone().unwrap_or_default(),
            "userTokenExpiresAt": user_token_expires_at,
            "tokenType": user_tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
            "permissions": granted_permissions.unwrap_or_default(),
            "permissionsInspected": granted_permissions.is_some(),
        });

        if include_facebook_pages {
            sqlx::query(
                r#"
            INSERT INTO "SocialChannelConnection" (
                id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
                "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, 'FACEBOOK'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
                $7, $8, $9, NOW(), NOW(), NOW()
            )
            ON CONFLICT ("orgId", platform, "externalAccountId")
            DO UPDATE SET
                status = 'CONNECTED'::"SocialChannelStatus",
                "displayName" = EXCLUDED."displayName",
                handle = EXCLUDED.handle,
                "accessToken" = EXCLUDED."accessToken",
                "refreshToken" = EXCLUDED."refreshToken",
                metadata = EXCLUDED.metadata,
                "lastSyncedAt" = NOW(),
                "updatedAt" = NOW()
                "#,
            )
            .bind(cuid2::create_id())
            .bind(user_id)
            .bind(org_id)
            .bind(
                page.name
                    .clone()
                    .unwrap_or_else(|| "Facebook Page".to_string()),
            )
            .bind(page.username.as_ref().map(|username| format!("@{username}")))
            .bind(&page.id)
            .bind(&encrypted_page_access_token)
            .bind(Some(encrypted_user_access_token.clone()))
            .bind(merge_channel_metadata_with_capabilities(
                "FACEBOOK",
                Some(page_metadata),
            ))
            .execute(pool)
            .await?;

            if let Some(channel) =
                get_social_channel_by_external_account(pool, org_id, "FACEBOOK", &page.id).await?
            {
                saved.push(channel);
            }
        }

        if !include_instagram_accounts {
            continue;
        }

        let instagram = match page
            .connected_instagram_account
            .clone()
            .or(page.instagram_business_account.clone())
        {
            Some(account) => Some(account),
            None => fetch_page_instagram_account(page_access_token, &page.id).await?,
        };

        if let Some(instagram) = instagram {
            let instagram_metadata = json!({
                "provider": "meta",
                "authMethod": "meta_login",
                "assetType": "instagram_professional_account",
                "instagramAccountId": instagram.id,
                "pageId": page.id,
                "pageName": page.name,
                "profilePictureUrl": instagram.profile_picture_url,
                "userTokenExpiresAt": user_token_expires_at,
                "tokenType": user_tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
                "permissions": granted_permissions.unwrap_or_default(),
                "permissionsInspected": granted_permissions.is_some(),
            });

            sqlx::query(
                r#"
                INSERT INTO "SocialChannelConnection" (
                    id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
                    "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
                )
                VALUES (
                    $1, $2, $3, 'INSTAGRAM'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
                    $7, $8, $9, NOW(), NOW(), NOW()
                )
                ON CONFLICT ("orgId", platform, "externalAccountId")
                DO UPDATE SET
                    status = 'CONNECTED'::"SocialChannelStatus",
                    "displayName" = EXCLUDED."displayName",
                    handle = EXCLUDED.handle,
                    "accessToken" = EXCLUDED."accessToken",
                    "refreshToken" = EXCLUDED."refreshToken",
                    metadata = EXCLUDED.metadata,
                    "lastSyncedAt" = NOW(),
                    "updatedAt" = NOW()
                "#,
            )
            .bind(cuid2::create_id())
            .bind(user_id)
            .bind(org_id)
            .bind(
                instagram
                    .name
                    .clone()
                    .or(instagram.username.clone())
                    .unwrap_or_else(|| "Instagram account".to_string()),
            )
            .bind(
                instagram
                    .username
                    .as_ref()
                    .map(|username| format!("@{username}")),
            )
            .bind(&instagram.id)
            .bind(&encrypted_page_access_token)
            .bind(Some(encrypted_user_access_token.clone()))
            .bind(merge_channel_metadata_with_capabilities(
                "INSTAGRAM",
                Some(instagram_metadata),
            ))
            .execute(pool)
            .await?;

            if let Some(channel) =
                get_social_channel_by_external_account(pool, org_id, "INSTAGRAM", &instagram.id)
                    .await?
            {
                saved.push(channel);
            }
        }
    }

    Ok(saved)
}

pub async fn upsert_instagram_connection_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &InstagramTokenResponse,
    granted_permissions: Option<&[String]>,
    profile: &InstagramProfile,
) -> Result<SocialChannel, AppError> {
    let account_id = profile.account_id().ok_or_else(|| {
        AppError::BadRequest(
            "Instagram account lookup did not return an account identifier".to_string(),
        )
    })?;
    let app_scoped_account_id = profile.id.clone();
    let instagram_user_id = value_as_identifier(profile.user_id.as_ref());
    let access_token = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing Instagram access token".to_string()))?;
    let encrypted_access_token = encrypt_social_secret(access_token)?;
    let expires_at = tokens
        .expires_in
        .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    let permissions = granted_permissions
        .map(|values| values.to_vec())
        .or_else(|| tokens.permissions.clone())
        .unwrap_or_default();
    let display_name = profile
        .name
        .clone()
        .or(profile.username.clone())
        .unwrap_or_else(|| "Instagram account".to_string());
    let handle = profile
        .username
        .as_ref()
        .map(|username| format!("@{username}"));
    let metadata = json!({
        "provider": "instagram",
        "authMethod": "instagram_login",
        "assetType": "instagram_professional_account",
        "apiHost": "graph.instagram.com",
        "instagramAccountId": account_id,
        "instagramUserId": instagram_user_id,
        "instagramAppScopedId": app_scoped_account_id,
        "username": profile.username,
        "profilePictureUrl": profile.profile_picture_url,
        "accountType": profile.account_type,
        "followersCount": profile.followers_count,
        "followsCount": profile.follows_count,
        "mediaCount": profile.media_count,
        "permissions": permissions,
        "permissionsInspected": true,
        "tokenType": tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
        "tokenExpiresAt": expires_at,
    });

    let mut tx = pool.begin().await?;
    if let Some(app_scoped_account_id) = app_scoped_account_id
        .as_deref()
        .filter(|value| *value != account_id)
    {
        let canonical_connection_exists = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM "SocialChannelConnection"
                WHERE "orgId" = $1
                  AND platform = 'INSTAGRAM'::"SocialPlatform"
                  AND "externalAccountId" = $2
            )
            "#,
        )
        .bind(org_id)
        .bind(&account_id)
        .fetch_one(tx.as_mut())
        .await?;

        if !canonical_connection_exists {
            sqlx::query(
                r#"
                UPDATE "SocialChannelConnection"
                SET "externalAccountId" = $1,
                    "updatedAt" = NOW()
                WHERE "orgId" = $2
                  AND platform = 'INSTAGRAM'::"SocialPlatform"
                  AND metadata->>'authMethod' = 'instagram_login'
                  AND (
                      "externalAccountId" = $3
                      OR metadata->>'instagramAppScopedId' = $3
                  )
                "#,
            )
            .bind(&account_id)
            .bind(org_id)
            .bind(app_scoped_account_id)
            .execute(tx.as_mut())
            .await?;
        }
    }

    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'INSTAGRAM'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
            $7, NULL, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            "userId" = EXCLUDED."userId",
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = NULL,
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(display_name)
    .bind(handle)
    .bind(&account_id)
    .bind(encrypted_access_token)
    .bind(merge_channel_metadata_with_capabilities(
        "INSTAGRAM",
        Some(metadata),
    ))
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;

    get_social_channel_by_external_account(pool, org_id, "INSTAGRAM", &account_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to save Instagram connection".to_string()))
}

pub async fn upsert_x_connection_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &XTokenResponse,
    profile: &XMeData,
) -> Result<SocialChannel, AppError> {
    let encrypted_access = encrypt_social_secret(
        tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing X access token".to_string()))?,
    )?;
    let encrypted_refresh = match tokens.refresh_token.as_deref() {
        Some(value) => Some(encrypt_social_secret(value)?),
        None => None,
    };
    let expires_at = tokens
        .expires_in
        .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'X'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
            $7, $8, $9, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = EXCLUDED."refreshToken",
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(
        profile
            .name
            .clone()
            .or(profile.username.clone())
            .unwrap_or_else(|| "X account".to_string()),
    )
    .bind(
        profile
            .username
            .as_ref()
            .map(|username| format!("@{username}")),
    )
    .bind(&profile.id)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(merge_channel_metadata_with_capabilities(
        "X",
        Some(json!({
            "provider": "x",
            "tokenType": tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
            "scope": tokens.scope,
            "expiresAt": expires_at,
            "avatarUrl": profile.profile_image_url,
        })),
    ))
    .execute(pool)
    .await?;

    get_social_channel_by_external_account(pool, org_id, "X", &profile.id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load saved X connection".to_string()))
}

pub async fn upsert_linkedin_connection_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &LinkedInTokenResponse,
    profile: &LinkedInProfile,
) -> Result<SocialChannel, AppError> {
    let profile_sub = profile
        .sub
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing LinkedIn member identifier".to_string()))?;
    let encrypted_access = encrypt_social_secret(
        tokens
            .access_token
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("Missing LinkedIn access token".to_string()))?,
    )?;
    let encrypted_refresh = match tokens.refresh_token.as_deref() {
        Some(value) => Some(encrypt_social_secret(value)?),
        None => None,
    };
    let expires_at = tokens
        .expires_in
        .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'LINKEDIN'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, NULL, $5,
            $6, $7, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = EXCLUDED."refreshToken",
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(profile.name.clone().unwrap_or_else(|| "LinkedIn profile".to_string()))
    .bind(profile_sub)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(merge_channel_metadata_with_capabilities(
        "LINKEDIN",
        Some(json!({
            "provider": "linkedin",
            "accountType": "member",
            "actorType": "person",
            "scope": tokens.scope,
            "expiresAt": expires_at,
            "picture": profile.picture,
            "email": profile.email,
            "actorUrn": format!("urn:li:person:{profile_sub}")
        })),
    ))
    .execute(pool)
    .await?;

    get_social_channel_by_external_account(pool, org_id, "LINKEDIN", profile_sub)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load saved LinkedIn connection".to_string()))
}

pub async fn upsert_linkedin_page_connections_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    tokens: &LinkedInTokenResponse,
    pages: &[LinkedInPage],
) -> Result<Vec<SocialChannel>, AppError> {
    let access_token = tokens
        .access_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing LinkedIn access token".to_string()))?;
    let expires_at = tokens
        .expires_in
        .map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    let mut saved = Vec::with_capacity(pages.len());

    for page in pages {
        let channel = upsert_provider_connection(
            pool,
            user_id,
            org_id,
            "LINKEDIN",
            &page.name,
            page.vanity_name
                .as_ref()
                .map(|vanity| format!("linkedin.com/company/{vanity}")),
            &page.id,
            access_token,
            tokens.refresh_token.as_deref(),
            json!({
                "provider": "linkedin",
                "accountType": "organization",
                "actorType": "organization",
                "organizationId": page.id,
                "actorUrn": page.urn,
                "role": page.role,
                "vanityName": page.vanity_name,
                "scope": tokens.scope,
                "expiresAt": expires_at.clone(),
            }),
        )
        .await?;
        saved.push(channel);
    }

    Ok(saved)
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
            "authMethod":"bluesky_oauth",
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
