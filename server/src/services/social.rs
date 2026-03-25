use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;

use crate::config::AppConfig;
use crate::db::models::{
    SocialChannel, SocialPost, SocialPostRow, SocialPostUpsertRequest, SocialPostVariant,
    SocialPostVariantInput, SocialPublishJobRow,
};
use crate::error::AppError;

const X_AUTHORIZE_URL: &str = "https://twitter.com/i/oauth2/authorize";
const X_TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const X_ME_URL: &str = "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url";
const X_POST_TWEET_URL: &str = "https://api.x.com/2/tweets";
const LINKEDIN_AUTHORIZE_URL: &str = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL: &str = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL: &str = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_UGC_POSTS_URL: &str = "https://api.linkedin.com/v2/ugcPosts";

pub const X_STATE_COOKIE: &str = "kasitek_social_x_state";
pub const X_VERIFIER_COOKIE: &str = "kasitek_social_x_verifier";
pub const LINKEDIN_STATE_COOKIE: &str = "kasitek_social_linkedin_state";

const SOCIAL_PLATFORMS: &[&str] = &["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X", "WHATSAPP_STATUS"];
const SOCIAL_CHANNEL_STATUSES: &[&str] = &["CONNECTED", "DISCONNECTED", "NEEDS_REAUTH"];
const SOCIAL_POST_STATUSES: &[&str] = &["DRAFT", "SCHEDULED", "PROCESSING", "PUBLISHED", "FAILED"];
const SOCIAL_PUBLISH_JOB_STATUSES: &[&str] = &[
    "PENDING",
    "QUEUED",
    "PROCESSING",
    "PUBLISHED",
    "FAILED",
    "CANCELED",
];
const SOCIAL_VARIANT_STATUSES: &[&str] = &["DRAFT", "APPROVED", "NEEDS_EDITS"];

#[derive(Clone)]
pub struct XOAuthState {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PublishExecutionResult {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "postId")]
    pub post_id: String,
    pub platform: String,
    pub status: String,
    #[serde(rename = "externalPostId")]
    pub external_post_id: Option<String>,
}

#[allow(dead_code)]
#[derive(sqlx::FromRow)]
struct SocialChannelPrivate {
    id: String,
    #[sqlx(rename = "user_id")]
    user_id: String,
    platform: String,
    status: String,
    #[sqlx(rename = "display_name")]
    display_name: String,
    handle: Option<String>,
    #[sqlx(rename = "external_account_id")]
    external_account_id: Option<String>,
    #[sqlx(rename = "access_token")]
    access_token: Option<String>,
    #[sqlx(rename = "refresh_token")]
    refresh_token: Option<String>,
    metadata: Option<Value>,
    #[sqlx(rename = "last_synced_at")]
    last_synced_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "created_at")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(sqlx::FromRow)]
struct PublishJobLoad {
    id: String,
    #[sqlx(rename = "user_id")]
    user_id: String,
    #[sqlx(rename = "post_id")]
    post_id: String,
    #[sqlx(rename = "variant_id")]
    variant_id: Option<String>,
    #[sqlx(rename = "channel_connection_id")]
    channel_connection_id: Option<String>,
    platform: String,
    status: String,
    #[sqlx(rename = "external_post_id")]
    external_post_id: Option<String>,
    post_content: String,
    #[sqlx(rename = "post_primary_channel_id")]
    post_primary_channel_id: Option<String>,
    variant_content: Option<String>,
}

pub fn is_valid_platform(value: &str) -> bool {
    SOCIAL_PLATFORMS.contains(&value)
}

pub fn is_valid_channel_status(value: &str) -> bool {
    SOCIAL_CHANNEL_STATUSES.contains(&value)
}

fn is_valid_post_status(value: &str) -> bool {
    SOCIAL_POST_STATUSES.contains(&value)
}

fn is_valid_job_status(value: &str) -> bool {
    SOCIAL_PUBLISH_JOB_STATUSES.contains(&value)
}

fn is_valid_variant_status(value: &str) -> bool {
    SOCIAL_VARIANT_STATUSES.contains(&value)
}

fn parse_optional_datetime(value: &Option<String>) -> Result<Option<DateTime<Utc>>, AppError> {
    match value.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::BadRequest("Scheduled time is invalid".to_string())),
        None => Ok(None),
    }
}

fn social_app_url(config: &AppConfig) -> String {
    config.auth_url.trim_end_matches('/').to_string()
}

fn required_env(name: &str) -> Result<String, AppError> {
    std::env::var(name).map_err(|_| AppError::Internal(format!("{name} is required")))
}

fn encryption_key() -> Result<[u8; 32], AppError> {
    let secret = std::env::var("SOCIAL_TOKEN_ENCRYPTION_KEY")
        .or_else(|_| std::env::var("WHATSAPP_TOKEN_ENCRYPTION_KEY"))
        .map_err(|_| {
            AppError::Internal(
                "SOCIAL_TOKEN_ENCRYPTION_KEY or WHATSAPP_TOKEN_ENCRYPTION_KEY is required"
                    .to_string(),
            )
        })?;

    let digest = Sha256::digest(secret.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    Ok(key)
}

pub fn encrypt_social_secret(plain_text: &str) -> Result<String, AppError> {
    let key = encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Internal("Failed to initialize encryption".to_string()))?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let encrypted = cipher
        .encrypt(nonce, plain_text.as_bytes())
        .map_err(|_| AppError::Internal("Failed to encrypt token".to_string()))?;

    if encrypted.len() < 16 {
        return Err(AppError::Internal("Encrypted token payload is invalid".to_string()));
    }
    let split = encrypted.len() - 16;
    let (ciphertext, auth_tag) = encrypted.split_at(split);

    Ok(format!(
        "{}:{}:{}",
        STANDARD.encode(nonce_bytes),
        STANDARD.encode(auth_tag),
        STANDARD.encode(ciphertext)
    ))
}

pub fn decrypt_social_secret(payload: &str) -> Result<String, AppError> {
    let parts = payload.split(':').collect::<Vec<_>>();
    let (nonce_bytes, encrypted) = match parts.as_slice() {
        [nonce_b64, encrypted_b64] => {
            let nonce_bytes = STANDARD
                .decode(nonce_b64)
                .map_err(|_| AppError::Internal("Invalid encrypted token nonce".to_string()))?;
            let encrypted = STANDARD
                .decode(encrypted_b64)
                .map_err(|_| AppError::Internal("Invalid encrypted token data".to_string()))?;
            (nonce_bytes, encrypted)
        }
        [nonce_b64, auth_tag_b64, ciphertext_b64] => {
            let nonce_bytes = STANDARD
                .decode(nonce_b64)
                .map_err(|_| AppError::Internal("Invalid encrypted token nonce".to_string()))?;
            let auth_tag = STANDARD
                .decode(auth_tag_b64)
                .map_err(|_| AppError::Internal("Invalid encrypted token auth tag".to_string()))?;
            let ciphertext = STANDARD
                .decode(ciphertext_b64)
                .map_err(|_| AppError::Internal("Invalid encrypted token data".to_string()))?;
            let mut encrypted = ciphertext;
            encrypted.extend_from_slice(&auth_tag);
            (nonce_bytes, encrypted)
        }
        _ => {
            return Err(AppError::Internal("Invalid encrypted token payload".to_string()));
        }
    };

    let key = encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Internal("Failed to initialize encryption".to_string()))?;

    let decrypted = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), encrypted.as_ref())
        .map_err(|_| AppError::Internal("Failed to decrypt token".to_string()))?;

    String::from_utf8(decrypted)
        .map_err(|_| AppError::Internal("Failed to decode decrypted token".to_string()))
}

fn base64_url_random(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

pub fn create_x_oauth_state() -> XOAuthState {
    let verifier = base64_url_random(48);
    let state = base64_url_random(24);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    XOAuthState {
        state,
        verifier,
        challenge,
    }
}

pub fn build_x_authorize_url(config: &AppConfig, state: &str, challenge: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_X_CLIENT_ID")?;
    let redirect_uri = format!("{}/api/social/oauth/x/callback", social_app_url(config));
    let scope = "tweet.read tweet.write users.read offline.access";
    Ok(format!(
        "{X_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(state),
        urlencoding::encode(challenge),
    ))
}

pub fn create_linkedin_oauth_state() -> String {
    cuid2::create_id().replace('-', "")
}

pub fn build_linkedin_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let redirect_uri = format!("{}/api/social/oauth/linkedin/callback", social_app_url(config));
    let scope = "openid profile email w_member_social";
    Ok(format!(
        "{LINKEDIN_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(scope),
    ))
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
    fallback: &str,
) -> Result<T, AppError> {
    let response = request.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        let parsed: Option<Value> = serde_json::from_str(&body).ok();
        let message = parsed
            .as_ref()
            .and_then(|value| value.get("detail").and_then(|v| v.as_str()))
            .or_else(|| parsed.as_ref().and_then(|value| value.get("message").and_then(|v| v.as_str())))
            .or_else(|| parsed.as_ref().and_then(|value| value.get("error").and_then(|v| v.as_str())))
            .unwrap_or(fallback);
        return Err(AppError::BadRequest(message.to_string()));
    }

    serde_json::from_str(&body).map_err(|_| AppError::Internal("Failed to decode provider response".to_string()))
}

#[derive(serde::Deserialize)]
pub struct XTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
}

#[derive(serde::Deserialize)]
struct XMeResponse {
    data: Option<XMeData>,
}

#[derive(Clone, serde::Deserialize)]
pub struct XMeData {
    pub id: String,
    pub name: Option<String>,
    pub username: Option<String>,
    pub profile_image_url: Option<String>,
}

pub async fn exchange_x_code_for_tokens(config: &AppConfig, code: &str, code_verifier: &str) -> Result<XTokenResponse, AppError> {
    let client_id = required_env("AUTH_X_CLIENT_ID")?;
    let client_secret = std::env::var("AUTH_X_CLIENT_SECRET").unwrap_or_default();
    let redirect_uri = format!("{}/api/social/oauth/x/callback", social_app_url(config));

    let mut request = reqwest::Client::new()
        .post(X_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("code", code.to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("client_id", client_id.clone()),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier.to_string()),
        ]);

    if !client_secret.is_empty() {
        let basic = STANDARD.encode(format!("{client_id}:{client_secret}"));
        request = request.header("Authorization", format!("Basic {basic}"));
    }

    let tokens: XTokenResponse = fetch_json(request, "X OAuth exchange failed").await?;
    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "X OAuth exchange did not return an access token".to_string(),
        ));
    }
    Ok(tokens)
}

pub async fn fetch_x_me(access_token: &str) -> Result<XMeData, AppError> {
    let response: XMeResponse = fetch_json(
        reqwest::Client::new()
            .get(X_ME_URL)
            .bearer_auth(access_token),
        "Failed to fetch X profile",
    )
    .await?;

    response
        .data
        .ok_or_else(|| AppError::BadRequest("X account lookup did not return a user".to_string()))
}

#[derive(serde::Deserialize)]
pub struct LinkedInTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
pub struct LinkedInProfile {
    pub sub: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub email: Option<String>,
}

pub async fn exchange_linkedin_code_for_tokens(config: &AppConfig, code: &str) -> Result<LinkedInTokenResponse, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let client_secret = required_env("AUTH_LINKEDIN_CLIENT_SECRET")?;
    let redirect_uri = format!("{}/api/social/oauth/linkedin/callback", social_app_url(config));
    let basic = STANDARD.encode(format!("{client_id}:{client_secret}"));

    let tokens: LinkedInTokenResponse = fetch_json(
        reqwest::Client::new()
            .post(LINKEDIN_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Authorization", format!("Basic {basic}"))
            .form(&[
                ("grant_type", "authorization_code".to_string()),
                ("code", code.to_string()),
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("redirect_uri", redirect_uri),
            ]),
        "LinkedIn OAuth exchange failed",
    )
    .await?;

    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "LinkedIn OAuth exchange did not return an access token".to_string(),
        ));
    }

    Ok(tokens)
}

pub async fn fetch_linkedin_profile(access_token: &str) -> Result<LinkedInProfile, AppError> {
    let profile: LinkedInProfile = fetch_json(
        reqwest::Client::new()
            .get(LINKEDIN_USERINFO_URL)
            .bearer_auth(access_token),
        "Failed to fetch LinkedIn profile",
    )
    .await?;

    if profile.sub.is_none() {
        return Err(AppError::BadRequest(
            "LinkedIn profile lookup did not return a member identifier".to_string(),
        ));
    }

    Ok(profile)
}

pub async fn upsert_x_connection_for_user(
    pool: &PgPool,
    user_id: &str,
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
    let expires_at = tokens.expires_in.map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, 'X'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $3, $4, $5,
            $6, $7, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("userId", platform, "externalAccountId")
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
    .bind(profile.name.clone().or(profile.username.clone()).unwrap_or_else(|| "X account".to_string()))
    .bind(profile.username.as_ref().map(|username| format!("@{username}")))
    .bind(&profile.id)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(json!({
        "provider": "x",
        "tokenType": tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
        "scope": tokens.scope.clone().unwrap_or_else(|| "tweet.read tweet.write users.read offline.access".to_string()),
        "expiresAt": expires_at,
        "avatarUrl": profile.profile_image_url,
    }))
    .execute(pool)
    .await?;

    get_social_channel_by_external_account(pool, user_id, "X", &profile.id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load saved X connection".to_string()))
}

pub async fn upsert_linkedin_connection_for_user(
    pool: &PgPool,
    user_id: &str,
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
    let expires_at = tokens.expires_in.map(|seconds| (Utc::now() + Duration::seconds(seconds)).to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO "SocialChannelConnection" (
            id, "userId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, 'LINKEDIN'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $3, NULL, $4,
            $5, $6, $7, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("userId", platform, "externalAccountId")
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
    .bind(profile.name.clone().unwrap_or_else(|| "LinkedIn profile".to_string()))
    .bind(profile_sub)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(json!({
        "provider": "linkedin",
        "scope": tokens.scope.clone().unwrap_or_else(|| "openid profile email w_member_social".to_string()),
        "expiresAt": expires_at,
        "picture": profile.picture,
        "email": profile.email,
        "actorUrn": format!("urn:li:person:{profile_sub}")
    }))
    .execute(pool)
    .await?;

    get_social_channel_by_external_account(pool, user_id, "LINKEDIN", profile_sub)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load saved LinkedIn connection".to_string()))
}

async fn get_social_channel_by_external_account(
    pool: &PgPool,
    user_id: &str,
    platform: &str,
    external_account_id: &str,
) -> Result<Option<SocialChannel>, AppError> {
    let sql = format!(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialChannelConnection"
        WHERE "userId" = $1 AND platform = '{platform}'::"SocialPlatform" AND "externalAccountId" = $2
        LIMIT 1
        "#
    );
    sqlx::query_as::<_, SocialChannel>(&sql)
        .bind(user_id)
        .bind(external_account_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn list_social_channels(pool: &PgPool, user_id: &str) -> Result<Vec<SocialChannel>, AppError> {
    sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialChannelConnection"
        WHERE "userId" = $1
        ORDER BY platform ASC, "createdAt" DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn get_social_channel(pool: &PgPool, user_id: &str, id: &str) -> Result<Option<SocialChannel>, AppError> {
    sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialChannelConnection"
        WHERE id = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn create_social_channel(
    pool: &PgPool,
    user_id: &str,
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
            id, "userId", platform, status, "displayName", handle, "externalAccountId", metadata, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, CAST($3 AS "SocialPlatform"), CAST($4 AS "SocialChannelStatus"), $5, $6, $7, $8, NOW(), NOW()
        )
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(platform)
    .bind(status)
    .bind(display_name)
    .bind(handle)
    .bind(external_account_id)
    .bind(metadata)
    .execute(pool)
    .await?;

    let created = sqlx::query_as::<_, SocialChannel>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialChannelConnection"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(created)
}

pub async fn update_social_channel(
    pool: &PgPool,
    user_id: &str,
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
        WHERE id = $6 AND "userId" = $7
        "#,
    )
    .bind(platform)
    .bind(display_name)
    .bind(handle)
    .bind(status)
    .bind(metadata)
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await?;

    get_social_channel(pool, user_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))
}

pub async fn delete_social_channel(pool: &PgPool, user_id: &str, id: &str) -> Result<bool, AppError> {
    let result = sqlx::query(r#"DELETE FROM "SocialChannelConnection" WHERE id = $1 AND "userId" = $2"#)
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}

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

async fn load_posts(pool: &PgPool, user_id: &str, post_id: Option<&str>) -> Result<Vec<SocialPost>, AppError> {
    let rows = if let Some(post_id) = post_id {
        sqlx::query_as::<_, SocialPostRow>(
            r#"
            SELECT id, "userId" AS user_id, "primaryChannelId" AS primary_channel_id, title, prompt, content,
                   ARRAY(SELECT unnest(channels)::text) AS channels,
                   status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
                   metadata, "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "SocialPost"
            WHERE "userId" = $1 AND id = $2
            "#,
        )
        .bind(user_id)
        .bind(post_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, SocialPostRow>(
            r#"
            SELECT id, "userId" AS user_id, "primaryChannelId" AS primary_channel_id, title, prompt, content,
                   ARRAY(SELECT unnest(channels)::text) AS channels,
                   status::text AS status, "scheduledFor" AS scheduled_for, "publishedAt" AS published_at,
                   metadata, "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "SocialPost"
            WHERE "userId" = $1
            ORDER BY "createdAt" DESC
            "#,
        )
        .bind(user_id)
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
               "aiGenerated" AS ai_generated, metadata, "createdAt" AS created_at, "updatedAt" AS updated_at
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
               metadata, "createdAt" AS created_at, "updatedAt" AS updated_at
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
                   metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
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
        jobs_by_post.entry(job.post_id.clone()).or_default().push(job);
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

pub async fn list_social_posts(pool: &PgPool, user_id: &str) -> Result<Vec<SocialPost>, AppError> {
    load_posts(pool, user_id, None).await
}

pub async fn get_social_post(pool: &PgPool, user_id: &str, post_id: &str) -> Result<Option<SocialPost>, AppError> {
    Ok(load_posts(pool, user_id, Some(post_id)).await?.into_iter().next())
}

async fn validate_primary_channel(pool: &PgPool, user_id: &str, primary_channel_id: &Option<String>) -> Result<Option<String>, AppError> {
    let Some(primary_channel_id) = primary_channel_id.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let exists = get_social_channel(pool, user_id, primary_channel_id).await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Primary channel was not found".to_string()));
    }
    Ok(Some(primary_channel_id.to_string()))
}

async fn create_variants_and_jobs(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    post_id: &str,
    variants: &[SocialPostVariantInput],
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
                id, "userId", "postId", "variantId", platform, status, "scheduledFor", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, CAST($5 AS "SocialPlatform"),
                CAST($6 AS "SocialPublishJobStatus"), $7, NOW(), NOW()
            )
            "#,
        )
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(post_id)
        .bind(variant_id)
        .bind(&variant.platform)
        .bind(if post_status == "SCHEDULED" { "QUEUED" } else { "PENDING" })
        .bind(scheduled_for)
        .execute(tx.as_mut())
        .await?;
    }

    Ok(())
}

pub async fn create_social_post(
    pool: &PgPool,
    user_id: &str,
    request: &SocialPostUpsertRequest,
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

    let status = request.status.clone().unwrap_or_else(|| "DRAFT".to_string());
    if !is_valid_post_status(&status) {
        return Err(AppError::BadRequest("Invalid post status".to_string()));
    }

    let scheduled_for = parse_optional_datetime(&request.scheduled_for)?;
    let primary_channel_id = validate_primary_channel(pool, user_id, &request.primary_channel_id).await?;
    let variants = normalize_variants(&request.variants, &channels, &content);
    let post_id = cuid2::create_id();

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO "SocialPost" (
            id, "userId", "primaryChannelId", title, prompt, content, channels, status,
            "scheduledFor", metadata, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, ARRAY(SELECT unnest($7::text[])::"SocialPlatform"),
            CAST($8 AS "SocialPostStatus"), $9, $10, NOW(), NOW()
        )
        "#,
    )
    .bind(&post_id)
    .bind(user_id)
    .bind(primary_channel_id)
    .bind(request.title.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()))
    .bind(request.prompt.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()))
    .bind(&content)
    .bind(&channels)
    .bind(&status)
    .bind(scheduled_for)
    .bind(&request.metadata)
    .execute(tx.as_mut())
    .await?;

    create_variants_and_jobs(&mut tx, user_id, &post_id, &variants, &status, scheduled_for).await?;
    tx.commit().await?;

    get_social_post(pool, user_id, &post_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load created social post".to_string()))
}

pub async fn update_social_post(
    pool: &PgPool,
    user_id: &str,
    post_id: &str,
    request: &SocialPostUpsertRequest,
) -> Result<SocialPost, AppError> {
    let existing = get_social_post(pool, user_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;

    let row = existing.row;
    let content = match request.content.as_ref() {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(AppError::BadRequest("Post content cannot be empty".to_string()));
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
    let primary_channel_id = validate_primary_channel(pool, user_id, &primary_channel_request).await?;
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
        WHERE id = $9 AND "userId" = $10
        "#,
    )
    .bind(primary_channel_id)
    .bind(request.title.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()).or(row.title.as_deref()))
    .bind(request.prompt.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()).or(row.prompt.as_deref()))
    .bind(&content)
    .bind(&channels)
    .bind(&status)
    .bind(scheduled_for)
    .bind(request.metadata.clone().or(row.metadata.clone()))
    .bind(post_id)
    .bind(user_id)
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

    create_variants_and_jobs(&mut tx, user_id, post_id, &variants, &status, scheduled_for).await?;
    tx.commit().await?;

    get_social_post(pool, user_id, post_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load updated social post".to_string()))
}

pub async fn delete_social_post(pool: &PgPool, user_id: &str, post_id: &str) -> Result<bool, AppError> {
    let result = sqlx::query(r#"DELETE FROM "SocialPost" WHERE id = $1 AND "userId" = $2"#)
        .bind(post_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}

async fn resolve_connected_channel_for_platform(
    pool: &PgPool,
    user_id: &str,
    platform: &str,
    channel_connection_id: &Option<String>,
) -> Result<SocialChannelPrivate, AppError> {
    if let Some(channel_id) = channel_connection_id.as_ref() {
        let sql = format!(
            r#"
            SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
                   "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
                   "accessToken" AS access_token, "refreshToken" AS refresh_token,
                   metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "SocialChannelConnection"
            WHERE id = $1 AND "userId" = $2 AND platform = '{platform}'::"SocialPlatform" AND status = 'CONNECTED'::"SocialChannelStatus"
            LIMIT 1
            "#
        );
        if let Some(channel) = sqlx::query_as::<_, SocialChannelPrivate>(&sql)
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await? {
            if channel.access_token.is_some() {
                return Ok(channel);
            }
        }
    }

    let sql = format!(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               "accessToken" AS access_token, "refreshToken" AS refresh_token,
               metadata, "lastSyncedAt" AS last_synced_at, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "SocialChannelConnection"
        WHERE "userId" = $1 AND platform = '{platform}'::"SocialPlatform" AND status = 'CONNECTED'::"SocialChannelStatus"
        ORDER BY "updatedAt" DESC
        LIMIT 1
        "#
    );
    let channel = sqlx::query_as::<_, SocialChannelPrivate>(&sql)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::BadRequest(format!("Connect a {} account before publishing", platform.to_lowercase())))?;

    if channel.access_token.is_none() {
        return Err(AppError::BadRequest(format!(
            "Connect a {} account before publishing",
            platform.to_lowercase()
        )));
    }

    Ok(channel)
}

async fn publish_post_to_x(access_token_encrypted: &str, text: &str) -> Result<(String, String), AppError> {
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let result: Value = fetch_json(
        reqwest::Client::new()
            .post(X_POST_TWEET_URL)
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .json(&json!({ "text": text })),
        "Failed to publish to X",
    )
    .await?;

    let id = result
        .get("data")
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::BadRequest("X publish did not return a post id".to_string()))?;
    let published_text = result
        .get("data")
        .and_then(|value| value.get("text"))
        .and_then(|value| value.as_str())
        .unwrap_or(text);
    Ok((id.to_string(), published_text.to_string()))
}

async fn publish_post_to_linkedin(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    metadata: &Option<Value>,
    text: &str,
) -> Result<(Option<String>, String), AppError> {
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let actor_urn = metadata
        .as_ref()
        .and_then(|value| value.get("actorUrn"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| external_account_id.as_ref().map(|value| format!("urn:li:person:{value}")))
        .ok_or_else(|| AppError::BadRequest("LinkedIn connection is missing a member identifier".to_string()))?;

    let response = reqwest::Client::new()
        .post(LINKEDIN_UGC_POSTS_URL)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("X-Restli-Protocol-Version", "2.0.0")
        .json(&json!({
            "author": actor_urn,
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": {
                    "shareCommentary": { "text": text },
                    "shareMediaCategory": "NONE"
                }
            },
            "visibility": {
                "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
            }
        }))
        .send()
        .await?;

    let headers = response.headers().clone();
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::BadRequest(body));
    }

    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let external_post_id = headers
        .get("x-restli-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .or_else(|| payload.get("id").and_then(|value| value.as_str()).map(|value| value.to_string()));
    Ok((external_post_id, text.to_string()))
}

async fn mark_job_failed(pool: &PgPool, job_id: &str, post_id: &str, message: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE "SocialPublishJob"
        SET status = 'FAILED'::"SocialPublishJobStatus", "errorMessage" = $1, "updatedAt" = NOW()
        WHERE id = $2
        "#,
    )
    .bind(message)
    .bind(job_id)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        r#"
        UPDATE "SocialPost"
        SET status = 'FAILED'::"SocialPostStatus", metadata = $1, "updatedAt" = NOW()
        WHERE id = $2
        "#,
    )
    .bind(json!({
        "failedAt": Utc::now().to_rfc3339(),
        "failureReason": message
    }))
    .bind(post_id)
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn load_publish_job(pool: &PgPool, job_id: &str) -> Result<Option<PublishJobLoad>, AppError> {
    sqlx::query_as::<_, PublishJobLoad>(
        r#"
        SELECT j.id, j."userId" AS user_id, j."postId" AS post_id, j."variantId" AS variant_id,
               j."channelConnectionId" AS channel_connection_id, j.platform::text AS platform,
               j.status::text AS status, j."externalPostId" AS external_post_id,
               p.content AS post_content, p."primaryChannelId" AS post_primary_channel_id,
               v.content AS variant_content
        FROM "SocialPublishJob" j
        JOIN "SocialPost" p ON p.id = j."postId"
        LEFT JOIN "SocialPostVariant" v ON v.id = j."variantId"
        WHERE j.id = $1
        LIMIT 1
        "#,
    )
    .bind(job_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn claim_publish_job(pool: &PgPool, job_id: &str, allowed_statuses: &[&str]) -> Result<bool, AppError> {
    if allowed_statuses.iter().any(|status| !is_valid_job_status(status)) {
        return Err(AppError::BadRequest("Invalid publish job status".to_string()));
    }
    let result = sqlx::query(
        r#"
        UPDATE "SocialPublishJob"
        SET status = 'PROCESSING'::"SocialPublishJobStatus", "errorMessage" = NULL, "updatedAt" = NOW()
        WHERE id = $1 AND status = ANY(ARRAY(SELECT unnest($2::text[])::"SocialPublishJobStatus"))
        "#,
    )
    .bind(job_id)
    .bind(allowed_statuses)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn execute_social_publish_job(pool: &PgPool, job_id: &str) -> Result<PublishExecutionResult, AppError> {
    let job = load_publish_job(pool, job_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Publish job not found".to_string()))?;

    if job.status == "CANCELED" {
        return Err(AppError::BadRequest("Publish job is canceled".to_string()));
    }

    if job.status == "PUBLISHED" && job.external_post_id.is_some() {
        return Ok(PublishExecutionResult {
            job_id: job.id,
            post_id: job.post_id,
            platform: job.platform,
            status: "PUBLISHED".to_string(),
            external_post_id: job.external_post_id,
        });
    }

    let publish_text = job
        .variant_content
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(job.post_content.trim())
        .to_string();

    let result = async {
        if job.platform == "X" {
            if publish_text.chars().count() > 280 {
                return Err(AppError::BadRequest(
                    "X posts are currently limited to 280 characters".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(pool, &job.user_id, "X", &job.channel_connection_id).await?;
            let access = channel
                .access_token
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("Connect an X account before publishing".to_string()))?;
            let (external_post_id, published_text) = publish_post_to_x(access, &publish_text).await?;
            Ok((channel.id, Some(external_post_id), "x".to_string(), published_text))
        } else if job.platform == "LINKEDIN" {
            if publish_text.chars().count() > 3000 {
                return Err(AppError::BadRequest(
                    "LinkedIn posts are currently limited to 3000 characters".to_string(),
                ));
            }
            let channel =
                resolve_connected_channel_for_platform(pool, &job.user_id, "LINKEDIN", &job.channel_connection_id).await?;
            let access = channel
                .access_token
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("Connect a linkedin account before publishing".to_string()))?;
            let (external_post_id, published_text) =
                publish_post_to_linkedin(access, &channel.external_account_id, &channel.metadata, &publish_text).await?;
            Ok((channel.id, external_post_id, "linkedin".to_string(), published_text))
        } else {
            Err(AppError::BadRequest(format!(
                "Publishing is not implemented yet for {}",
                job.platform
            )))
        }
    }
    .await;

    match result {
        Ok((connection_id, external_post_id, provider, published_text)) => {
            let now = Utc::now();
            let mut tx = pool.begin().await?;
            sqlx::query(
                r#"
                UPDATE "SocialPublishJob"
                SET status = 'PUBLISHED'::"SocialPublishJobStatus",
                    "publishedAt" = $1,
                    "externalPostId" = $2,
                    "errorMessage" = NULL,
                    "channelConnectionId" = $3,
                    metadata = $4,
                    "updatedAt" = NOW()
                WHERE id = $5
                "#,
            )
            .bind(now)
            .bind(&external_post_id)
            .bind(&connection_id)
            .bind(json!({
                "provider": provider,
                "publishedText": published_text,
            }))
            .bind(&job.id)
            .execute(tx.as_mut())
            .await?;
            sqlx::query(
                r#"
                UPDATE "SocialPost"
                SET status = 'PUBLISHED'::"SocialPostStatus",
                    "publishedAt" = $1,
                    "primaryChannelId" = COALESCE("primaryChannelId", $2),
                    metadata = $3,
                    "updatedAt" = NOW()
                WHERE id = $4
                "#,
            )
            .bind(now)
            .bind(connection_id)
            .bind(json!({
                "latestPublishedPostId": external_post_id,
                "latestPublishedPlatform": job.platform,
            }))
            .bind(&job.post_id)
            .execute(tx.as_mut())
            .await?;
            tx.commit().await?;

            Ok(PublishExecutionResult {
                job_id: job.id,
                post_id: job.post_id,
                platform: job.platform,
                status: "PUBLISHED".to_string(),
                external_post_id,
            })
        }
        Err(error) => {
            let message = error.to_string();
            let detail = message.split(": ").last().unwrap_or(&message).to_string();
            mark_job_failed(pool, &job.id, &job.post_id, &detail).await?;
            Err(error)
        }
    }
}

#[allow(dead_code)]
pub async fn process_due_social_publish_jobs(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    let due_jobs = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "SocialPublishJob"
        WHERE status = 'QUEUED'::"SocialPublishJobStatus"
          AND ("scheduledFor" IS NULL OR "scheduledFor" <= NOW())
        ORDER BY "scheduledFor" ASC NULLS FIRST, "createdAt" ASC
        LIMIT $1
        "#,
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;

    let mut processed = 0;
    for job_id in due_jobs {
        if !claim_publish_job(pool, &job_id, &["QUEUED"]).await? {
            continue;
        }
        let _ = execute_social_publish_job(pool, &job_id).await;
        processed += 1;
    }

    Ok(processed)
}
