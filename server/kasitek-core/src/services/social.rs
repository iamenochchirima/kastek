use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use crypto_utils::{decrypt_with_aes256_gcm, encrypt_with_aes256_gcm};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::PgPool;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::AppConfig;
use crate::db::models::SocialChannel;
use crate::error::AppError;
use crate::services::{billing, bluesky_oauth, connections, content_media, social_posts};

const X_TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const X_ME_URL: &str =
    "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url";
pub(crate) const X_POST_TWEET_URL: &str = "https://api.x.com/2/tweets";
const META_TOKEN_URL: &str = "https://graph.facebook.com/v23.0/oauth/access_token";
pub(crate) const META_GRAPH_BASE: &str = "https://graph.facebook.com/v23.0";
const META_PAGE_WEBHOOK_FIELDS: &str =
    "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads";
const META_PAGE_WEBHOOK_SUBSCRIPTION_VERSION: i32 = 2;
const META_INSTAGRAM_WEBHOOK_FIELDS: &str =
    "messages,messaging_postbacks,messaging_seen,message_reactions";
const META_INSTAGRAM_ACCOUNT_WEBHOOK_SUBSCRIPTION_VERSION: i32 = 1;
static META_INSTAGRAM_APP_WEBHOOK_CONFIGURED: AtomicBool = AtomicBool::new(false);
const INSTAGRAM_TOKEN_URL: &str = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_LONG_LIVED_TOKEN_URL: &str = "https://graph.instagram.com/access_token";
pub(crate) const INSTAGRAM_GRAPH_BASE: &str = "https://graph.instagram.com/v23.0";
const LINKEDIN_TOKEN_URL: &str = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL: &str = "https://api.linkedin.com/v2/userinfo";
pub(crate) const LINKEDIN_UGC_POSTS_URL: &str = "https://api.linkedin.com/v2/ugcPosts";
const THREADS_TOKEN_URL: &str = "https://graph.threads.com/oauth/access_token";
pub(crate) const THREADS_GRAPH_BASE: &str = "https://graph.threads.com/v1.0";
pub(crate) const TIKTOK_TOKEN_URL: &str = "https://open.tiktokapis.com/v2/oauth/token/";
// `user.info.basic` authorizes only these profile fields. Requesting `username`
// makes TikTok reject an otherwise valid sandbox authorization.
const TIKTOK_USER_URL: &str =
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name";
pub(crate) const TIKTOK_CREATOR_INFO_URL: &str =
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
pub(crate) const TIKTOK_PUBLISH_URL: &str =
    "https://open.tiktokapis.com/v2/post/publish/content/init/";
const TIKTOK_STATUS_URL: &str = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

type HmacSha256 = Hmac<Sha256>;

pub const X_STATE_COOKIE: &str = "kasitek_social_x_state";
pub const X_VERIFIER_COOKIE: &str = "kasitek_social_x_verifier";
pub const META_STATE_COOKIE: &str = "kasitek_social_meta_state";
pub const META_TARGET_COOKIE: &str = "kasitek_social_meta_target";
pub const INSTAGRAM_STATE_COOKIE: &str = "kasitek_social_instagram_state";
pub const LINKEDIN_STATE_COOKIE: &str = "kasitek_social_linkedin_state";
pub const THREADS_STATE_COOKIE: &str = "kasitek_social_threads_state";
pub const TIKTOK_STATE_COOKIE: &str = "kasitek_social_tiktok_state";

const SOCIAL_PLATFORMS: &[&str] = &[
    "FACEBOOK",
    "INSTAGRAM",
    "THREADS",
    "TIKTOK",
    "BLUESKY",
    "LINKEDIN",
    "X",
    "WHATSAPP_STATUS",
];
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

pub use super::social_channels::platform_capabilities;
pub use super::social_channels::{
    create_social_channel, delete_social_channel, get_social_channel, list_social_channels,
    update_social_channel,
};
pub use super::social_provider_connections::{
    upsert_bluesky_oauth_connection_for_org, upsert_instagram_connection_for_org,
    upsert_linkedin_connection_for_org, upsert_meta_connections_for_org,
    upsert_threads_connection_for_org, upsert_tiktok_connection_for_org,
    upsert_x_connection_for_org,
};

pub(crate) fn merge_channel_metadata_with_capabilities(
    platform: &str,
    metadata: Option<Value>,
) -> Option<Value> {
    let mut object = match metadata {
        Some(Value::Object(map)) => map,
        Some(other) => {
            return Some(json!({
                "value": other,
                "capabilities": platform_capabilities(platform),
            }))
        }
        None => serde_json::Map::new(),
    };

    object.insert("capabilities".to_string(), platform_capabilities(platform));
    Some(Value::Object(object))
}

pub use super::social_oauth::XOAuthState;

#[derive(Debug, serde::Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub iss: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct BlueskyOAuthStartQuery {
    pub handle: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct MetaOAuthStartQuery {
    pub target: Option<String>,
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SocialPostProviderDeletionResult {
    pub platform: String,
    #[serde(rename = "externalPostId")]
    pub external_post_id: Option<String>,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SocialPostDeletionResult {
    pub success: bool,
    #[serde(rename = "localDeleted")]
    pub local_deleted: bool,
    #[serde(rename = "providerResults")]
    pub provider_results: Vec<SocialPostProviderDeletionResult>,
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
    #[sqlx(rename = "org_id")]
    org_id: Option<String>,
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
    post_metadata: Option<Value>,
    #[sqlx(rename = "post_primary_channel_id")]
    post_primary_channel_id: Option<String>,
    variant_content: Option<String>,
    media: Value,
}

fn attached_media_url(media: &Value, config: &AppConfig, kind: Option<&str>) -> Option<String> {
    media.as_array()?.iter().find_map(|item| {
        let item_kind = item.get("kind").and_then(Value::as_str);
        if kind.is_some_and(|requested| item_kind != Some(requested)) {
            return None;
        }
        let asset_id = item.get("assetId").and_then(Value::as_str)?;
        Some(content_media::public_media_url(config, asset_id))
    })
}

fn has_attached_media(media: &Value) -> bool {
    media.as_array().is_some_and(|items| !items.is_empty())
}

pub fn is_valid_platform(value: &str) -> bool {
    SOCIAL_PLATFORMS.contains(&value)
}

pub fn is_valid_channel_status(value: &str) -> bool {
    SOCIAL_CHANNEL_STATUSES.contains(&value)
}

pub(crate) fn is_valid_post_status(value: &str) -> bool {
    SOCIAL_POST_STATUSES.contains(&value)
}

fn is_valid_job_status(value: &str) -> bool {
    SOCIAL_PUBLISH_JOB_STATUSES.contains(&value)
}

pub(crate) fn is_valid_variant_status(value: &str) -> bool {
    SOCIAL_VARIANT_STATUSES.contains(&value)
}

pub(crate) fn parse_optional_datetime(
    value: &Option<String>,
) -> Result<Option<DateTime<Utc>>, AppError> {
    match value.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::BadRequest("Scheduled time is invalid".to_string())),
        None => Ok(None),
    }
}

fn token_expires_within(metadata: &Option<Value>, duration: Duration) -> bool {
    metadata
        .as_ref()
        .and_then(|value| value.get("expiresAt"))
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|expires_at| expires_at.with_timezone(&Utc) <= Utc::now() + duration)
        .unwrap_or(false)
}

pub(crate) fn social_app_url(config: &AppConfig) -> String {
    config.public_api_url.trim_end_matches('/').to_string()
}

pub(crate) fn required_env(name: &str) -> Result<String, AppError> {
    std::env::var(name).map_err(|_| AppError::Internal(format!("{name} is required")))
}

fn decode_threads_signed_request(
    signed_request: &str,
    app_secret: &str,
) -> Result<String, AppError> {
    let (encoded_signature, encoded_payload) = signed_request
        .split_once('.')
        .ok_or_else(|| AppError::BadRequest("Invalid Threads signed request".to_string()))?;
    if encoded_signature.is_empty() || encoded_payload.is_empty() {
        return Err(AppError::BadRequest(
            "Invalid Threads signed request".to_string(),
        ));
    }

    let signature = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .or_else(|_| URL_SAFE.decode(encoded_signature))
        .map_err(|_| AppError::BadRequest("Invalid Threads signed request".to_string()))?;
    let mut mac = HmacSha256::new_from_slice(app_secret.as_bytes())
        .map_err(|_| AppError::Internal("Invalid Threads app secret".to_string()))?;
    mac.update(encoded_payload.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| AppError::Unauthorized)?;

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(encoded_payload)
        .or_else(|_| URL_SAFE.decode(encoded_payload))
        .map_err(|_| AppError::BadRequest("Invalid Threads signed request".to_string()))?;
    let payload: Value = serde_json::from_slice(&payload_bytes)
        .map_err(|_| AppError::BadRequest("Invalid Threads signed request".to_string()))?;
    let algorithm = payload
        .get("algorithm")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Missing Threads signature algorithm".to_string()))?;
    if !algorithm.eq_ignore_ascii_case("HMAC-SHA256") {
        return Err(AppError::BadRequest(
            "Unsupported Threads signature algorithm".to_string(),
        ));
    }

    let user_id = match payload.get("user_id") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => {
            return Err(AppError::BadRequest(
                "Missing Threads user identifier".to_string(),
            ))
        }
    };
    if user_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Missing Threads user identifier".to_string(),
        ));
    }
    Ok(user_id)
}

pub fn verify_threads_signed_request(signed_request: &str) -> Result<String, AppError> {
    decode_threads_signed_request(signed_request, &required_env("AUTH_THREADS_APP_SECRET")?)
}

pub fn threads_data_deletion_status_url(config: &AppConfig, confirmation_code: &str) -> String {
    format!(
        "{}/api/social/oauth/threads/data-deletion/status/{}",
        social_app_url(config),
        urlencoding::encode(confirmation_code)
    )
}

pub use super::social_webhooks::{
    parse_tiktok_webhook_envelope, record_tiktok_webhook_event, verify_tiktok_webhook_signature,
};

fn encryption_secret() -> Result<String, AppError> {
    std::env::var("SOCIAL_TOKEN_ENCRYPTION_KEY")
        .or_else(|_| std::env::var("WHATSAPP_TOKEN_ENCRYPTION_KEY"))
        .map_err(|_| {
            AppError::Internal(
                "SOCIAL_TOKEN_ENCRYPTION_KEY or WHATSAPP_TOKEN_ENCRYPTION_KEY is required"
                    .to_string(),
            )
        })
}

pub fn encrypt_social_secret(plain_text: &str) -> Result<String, AppError> {
    let secret = encryption_secret()?;
    encrypt_with_aes256_gcm(&secret, plain_text)
        .map_err(|error| AppError::Internal(format!("Failed to encrypt token: {error}")))
}

pub fn decrypt_social_secret(payload: &str) -> Result<String, AppError> {
    let secret = encryption_secret()?;
    decrypt_with_aes256_gcm(&secret, payload)
        .map_err(|error| AppError::Internal(format!("Failed to decrypt token: {error}")))
}

pub use super::social_oauth::{
    build_instagram_authorize_url, build_linkedin_authorize_url, build_meta_authorize_url,
    build_threads_authorize_url, build_tiktok_authorize_url, build_x_authorize_url,
    create_instagram_oauth_state, create_linkedin_oauth_state, create_meta_oauth_state,
    create_threads_oauth_state, create_tiktok_oauth_state, create_x_oauth_state,
};
pub(crate) use super::social_oauth::{instagram_app_id, instagram_app_secret};

pub(crate) async fn fetch_json<T: serde::de::DeserializeOwned>(
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
            .or_else(|| {
                parsed
                    .as_ref()
                    .and_then(|value| value.get("message").and_then(|v| v.as_str()))
            })
            .or_else(|| {
                parsed
                    .as_ref()
                    .and_then(|value| value.get("error").and_then(|v| v.as_str()))
            })
            .or_else(|| {
                parsed
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(|value| value.get("message"))
                    .and_then(|value| value.as_str())
            })
            .unwrap_or(fallback);
        return Err(AppError::BadRequest(message.to_string()));
    }

    serde_json::from_str(&body)
        .map_err(|_| AppError::Internal("Failed to decode provider response".to_string()))
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

pub async fn exchange_x_code_for_tokens(
    config: &AppConfig,
    code: &str,
    code_verifier: &str,
) -> Result<XTokenResponse, AppError> {
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

pub async fn exchange_linkedin_code_for_tokens(
    config: &AppConfig,
    code: &str,
) -> Result<LinkedInTokenResponse, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let client_secret = required_env("AUTH_LINKEDIN_CLIENT_SECRET")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/linkedin/callback",
        social_app_url(config)
    );
    let tokens: LinkedInTokenResponse = fetch_json(
        reqwest::Client::new()
            .post(LINKEDIN_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
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

#[derive(Clone, serde::Deserialize)]
pub struct ThreadsTokenResponse {
    pub access_token: Option<String>,
    pub expires_in: Option<i64>,
}

#[derive(Clone, serde::Deserialize)]
pub struct ThreadsProfile {
    pub id: String,
    pub username: Option<String>,
    pub name: Option<String>,
    pub threads_profile_picture_url: Option<String>,
}

pub async fn exchange_threads_code_for_token(
    config: &AppConfig,
    code: &str,
) -> Result<ThreadsTokenResponse, AppError> {
    let client_id = required_env("AUTH_THREADS_APP_ID")?;
    let client_secret = required_env("AUTH_THREADS_APP_SECRET")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/threads/callback",
        social_app_url(config)
    );
    let short: ThreadsTokenResponse = fetch_json(
        reqwest::Client::new().post(THREADS_TOKEN_URL).form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", redirect_uri),
            ("code", code.to_string()),
        ]),
        "Threads OAuth exchange failed",
    )
    .await?;
    let access = short.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Threads did not return an access token".to_string())
    })?;
    let long_url = format!("https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret={}&access_token={}",
        urlencoding::encode(&required_env("AUTH_THREADS_APP_SECRET")?), urlencoding::encode(access));
    fetch_json(
        reqwest::Client::new().get(long_url),
        "Threads long-lived token exchange failed",
    )
    .await
}

pub async fn fetch_threads_profile(access_token: &str) -> Result<ThreadsProfile, AppError> {
    fetch_json(
        reqwest::Client::new()
            .get(format!(
                "{THREADS_GRAPH_BASE}/me?fields=id,username,name,threads_profile_picture_url"
            ))
            .bearer_auth(access_token),
        "Failed to fetch Threads profile",
    )
    .await
}

#[derive(Clone, serde::Deserialize)]
pub struct TikTokTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub open_id: Option<String>,
    pub expires_in: Option<i64>,
    pub refresh_expires_in: Option<i64>,
    pub scope: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
pub struct TikTokProfile {
    pub open_id: Option<String>,
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(serde::Deserialize)]
struct TikTokUserEnvelope {
    data: Option<TikTokUserData>,
    error: Option<Value>,
}
#[derive(serde::Deserialize)]
struct TikTokUserData {
    user: Option<TikTokProfile>,
}

pub async fn exchange_tiktok_code_for_tokens(
    config: &AppConfig,
    code: &str,
) -> Result<TikTokTokenResponse, AppError> {
    let redirect_uri = format!(
        "{}/api/social/oauth/tiktok/callback",
        social_app_url(config)
    );
    fetch_json(
        reqwest::Client::new().post(TIKTOK_TOKEN_URL).form(&[
            ("client_key", required_env("AUTH_TIKTOK_CLIENT_KEY")?),
            ("client_secret", required_env("AUTH_TIKTOK_CLIENT_SECRET")?),
            ("code", code.to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", redirect_uri),
        ]),
        "TikTok OAuth exchange failed",
    )
    .await
}

pub async fn fetch_tiktok_profile(access_token: &str) -> Result<TikTokProfile, AppError> {
    let envelope: TikTokUserEnvelope = fetch_json(
        reqwest::Client::new()
            .get(TIKTOK_USER_URL)
            .bearer_auth(access_token),
        "Failed to fetch TikTok profile",
    )
    .await?;
    if let Some(error) = envelope.error.as_ref() {
        let code = error.get("code").and_then(Value::as_str).unwrap_or("ok");
        if code != "ok" {
            return Err(AppError::BadRequest(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(code)
                    .to_string(),
            ));
        }
    }
    envelope
        .data
        .and_then(|data| data.user)
        .ok_or_else(|| AppError::BadRequest("TikTok did not return a user profile".to_string()))
}

#[derive(Clone, serde::Deserialize)]
pub struct MetaTokenResponse {
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
}

#[derive(Clone, serde::Deserialize)]
pub struct InstagramTokenResponse {
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
    pub permissions: Option<Vec<String>>,
}

#[derive(Clone, serde::Deserialize)]
pub struct InstagramProfile {
    pub id: Option<String>,
    pub user_id: Option<Value>,
    pub username: Option<String>,
    pub name: Option<String>,
    pub profile_picture_url: Option<String>,
    pub followers_count: Option<i64>,
    pub follows_count: Option<i64>,
    pub media_count: Option<i64>,
    pub account_type: Option<String>,
}

impl InstagramProfile {
    pub fn account_id(&self) -> Option<String> {
        value_as_identifier(self.user_id.as_ref()).or_else(|| self.id.clone())
    }
}

pub(crate) fn value_as_identifier(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct MetaPictureData {
    pub(crate) url: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct MetaPicture {
    pub(crate) data: Option<MetaPictureData>,
}

#[derive(Clone, serde::Deserialize)]
pub struct MetaInstagramAccount {
    pub(crate) id: String,
    pub(crate) username: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) profile_picture_url: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
pub struct MetaPageAccount {
    pub id: String,
    pub(crate) name: Option<String>,
    pub(crate) username: Option<String>,
    pub access_token: Option<String>,
    pub(crate) tasks: Option<Vec<String>>,
    pub(crate) picture: Option<MetaPicture>,
    pub(crate) connected_instagram_account: Option<MetaInstagramAccount>,
    pub(crate) instagram_business_account: Option<MetaInstagramAccount>,
}

#[derive(serde::Deserialize)]
struct MetaAccountsResponse {
    data: Option<Vec<MetaPageAccount>>,
}

pub async fn exchange_meta_code_for_tokens(
    config: &AppConfig,
    code: &str,
) -> Result<MetaTokenResponse, AppError> {
    let client_id = required_env("AUTH_META_APP_ID")?;
    let client_secret = required_env("AUTH_META_APP_SECRET")?;
    let redirect_uri = format!("{}/api/social/oauth/meta/callback", social_app_url(config));

    let tokens: MetaTokenResponse = fetch_json(
        reqwest::Client::new().get(META_TOKEN_URL).query(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code", code),
        ]),
        "Meta OAuth exchange failed",
    )
    .await?;

    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "Meta OAuth exchange did not return an access token".to_string(),
        ));
    }

    Ok(tokens)
}

pub async fn exchange_meta_for_long_lived_token(
    short_lived_access_token: &str,
) -> Result<MetaTokenResponse, AppError> {
    let client_id = required_env("AUTH_META_APP_ID")?;
    let client_secret = required_env("AUTH_META_APP_SECRET")?;

    let tokens: MetaTokenResponse = fetch_json(
        reqwest::Client::new().get(META_TOKEN_URL).query(&[
            ("grant_type", "fb_exchange_token"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("fb_exchange_token", short_lived_access_token),
        ]),
        "Meta long-lived token exchange failed",
    )
    .await?;

    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "Meta long-lived token exchange did not return an access token".to_string(),
        ));
    }

    Ok(tokens)
}

pub async fn exchange_instagram_code_for_token(
    config: &AppConfig,
    code: &str,
) -> Result<InstagramTokenResponse, AppError> {
    let client_id = instagram_app_id()?;
    let client_secret = instagram_app_secret()?;
    let redirect_uri = format!(
        "{}/api/social/oauth/instagram/callback",
        social_app_url(config)
    );

    let tokens: InstagramTokenResponse = fetch_json(
        reqwest::Client::new().post(INSTAGRAM_TOKEN_URL).form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", redirect_uri),
            ("code", code.to_string()),
        ]),
        "Instagram OAuth exchange failed",
    )
    .await?;

    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "Instagram OAuth exchange did not return an access token".to_string(),
        ));
    }
    Ok(tokens)
}

pub async fn exchange_instagram_for_long_lived_token(
    short_lived_access_token: &str,
) -> Result<InstagramTokenResponse, AppError> {
    let client_secret = instagram_app_secret()?;
    let tokens: InstagramTokenResponse = fetch_json(
        reqwest::Client::new()
            .get(INSTAGRAM_LONG_LIVED_TOKEN_URL)
            .query(&[
                ("grant_type", "ig_exchange_token"),
                ("client_secret", client_secret.as_str()),
                ("access_token", short_lived_access_token),
            ]),
        "Instagram long-lived token exchange failed",
    )
    .await?;

    if tokens.access_token.is_none() {
        return Err(AppError::BadRequest(
            "Instagram long-lived token exchange did not return an access token".to_string(),
        ));
    }
    Ok(tokens)
}

pub async fn fetch_instagram_profile(access_token: &str) -> Result<InstagramProfile, AppError> {
    let profile: InstagramProfile = fetch_json(
        reqwest::Client::new()
            .get(format!("{INSTAGRAM_GRAPH_BASE}/me"))
            .query(&[(
                "fields",
                "id,user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,account_type",
            )])
            .bearer_auth(access_token),
        "Failed to load the Instagram professional account",
    )
    .await?;

    if profile.account_id().is_none() {
        return Err(AppError::BadRequest(
            "Instagram account lookup did not return an account identifier".to_string(),
        ));
    }
    Ok(profile)
}

pub async fn subscribe_instagram_webhooks(
    access_token: &str,
    instagram_account_id: &str,
) -> Result<(), AppError> {
    let _: Value = fetch_json(
        reqwest::Client::new()
            .post(format!(
                "{INSTAGRAM_GRAPH_BASE}/{instagram_account_id}/subscribed_apps"
            ))
            .bearer_auth(access_token)
            .form(&[("subscribed_fields", META_INSTAGRAM_WEBHOOK_FIELDS)]),
        "Failed to subscribe the Instagram account to webhooks",
    )
    .await?;
    Ok(())
}

pub async fn ensure_instagram_account_webhook_subscriptions(
    pool: &PgPool,
    org_id: &str,
) -> Result<usize, AppError> {
    let channels = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT id, "externalAccountId", "accessToken"
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1
          AND platform = 'INSTAGRAM'::"SocialPlatform"
          AND status = 'CONNECTED'::"SocialChannelStatus"
          AND "externalAccountId" IS NOT NULL
          AND "accessToken" IS NOT NULL
          AND metadata->>'authMethod' = 'instagram_login'
          AND COALESCE(metadata->>'instagramWebhookSubscriptionVersion', '0') <> $2
        "#,
    )
    .bind(org_id)
    .bind(META_INSTAGRAM_ACCOUNT_WEBHOOK_SUBSCRIPTION_VERSION.to_string())
    .fetch_all(pool)
    .await?;

    let mut refreshed = 0;
    for (channel_id, instagram_account_id, encrypted_access_token) in channels {
        let access_token = match decrypt_social_secret(&encrypted_access_token) {
            Ok(token) => token,
            Err(error) => {
                log::warn!(
                    "failed to decrypt Instagram token while refreshing webhooks channel_id={}: {}",
                    channel_id,
                    error
                );
                continue;
            }
        };
        if let Err(error) = subscribe_instagram_webhooks(&access_token, &instagram_account_id).await
        {
            log::warn!(
                "failed to refresh Instagram webhook fields channel_id={} instagram_account_id={}: {}",
                channel_id,
                instagram_account_id,
                error
            );
            continue;
        }

        sqlx::query(
            r#"
            UPDATE "SocialChannelConnection"
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('instagramWebhookSubscriptionVersion', $1::int),
                "lastSyncedAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(META_INSTAGRAM_ACCOUNT_WEBHOOK_SUBSCRIPTION_VERSION)
        .bind(&channel_id)
        .bind(org_id)
        .execute(pool)
        .await?;
        refreshed += 1;
    }

    Ok(refreshed)
}

pub async fn fetch_meta_pages(access_token: &str) -> Result<Vec<MetaPageAccount>, AppError> {
    let response: MetaAccountsResponse = fetch_json(
        reqwest::Client::new()
            .get(format!("{META_GRAPH_BASE}/me/accounts"))
            .query(&[(
                "fields",
                "id,name,username,access_token,tasks,picture{url},connected_instagram_account{id,username,name,profile_picture_url},instagram_business_account{id,username,name,profile_picture_url}",
            )])
            .bearer_auth(access_token),
        "Failed to load connected Meta Pages",
    )
    .await?;

    Ok(response.data.unwrap_or_default())
}

pub async fn fetch_page_instagram_account(
    page_access_token: &str,
    page_id: &str,
) -> Result<Option<MetaInstagramAccount>, AppError> {
    let response: MetaPageAccount = fetch_json(
        reqwest::Client::new()
            .get(format!("{META_GRAPH_BASE}/{page_id}"))
            .query(&[(
                "fields",
                "connected_instagram_account{id,username,name,profile_picture_url},instagram_business_account{id,username,name,profile_picture_url}",
            )])
            .bearer_auth(page_access_token),
        "Failed to load connected Instagram account",
    )
    .await?;

    Ok(response
        .connected_instagram_account
        .or(response.instagram_business_account))
}

async fn fetch_meta_page_identity(
    access_token: &str,
    page_id: &str,
) -> Result<MetaPageAccount, AppError> {
    fetch_json(
        reqwest::Client::new()
            .get(format!("{META_GRAPH_BASE}/{page_id}"))
            .query(&[("fields", "id,name,username,picture{url}")])
            .bearer_auth(access_token),
        "Failed to load Facebook Page profile",
    )
    .await
}

async fn fetch_meta_instagram_identity(
    access_token: &str,
    instagram_account_id: &str,
) -> Result<MetaInstagramAccount, AppError> {
    fetch_json(
        reqwest::Client::new()
            .get(format!("{META_GRAPH_BASE}/{instagram_account_id}"))
            .query(&[("fields", "id,username,name,profile_picture_url")])
            .bearer_auth(access_token),
        "Failed to load Instagram profile",
    )
    .await
}

pub async fn subscribe_meta_page_webhooks(
    page_access_token: &str,
    page_id: &str,
) -> Result<(), AppError> {
    let _: Value = fetch_json(
        reqwest::Client::new()
            .post(format!("{META_GRAPH_BASE}/{page_id}/subscribed_apps"))
            .bearer_auth(page_access_token)
            .form(&[("subscribed_fields", META_PAGE_WEBHOOK_FIELDS)]),
        "Failed to subscribe the Meta Page to messaging webhooks",
    )
    .await?;
    Ok(())
}

pub async fn subscribe_meta_instagram_app_webhooks(config: &AppConfig) -> Result<(), AppError> {
    let app_id = required_env("AUTH_META_APP_ID")?;
    let app_secret = required_env("AUTH_META_APP_SECRET")?;
    let verify_token = std::env::var("META_WEBHOOK_VERIFY_TOKEN")
        .or_else(|_| std::env::var("AUTH_META_WEBHOOK_VERIFY_TOKEN"))
        .map_err(|_| {
            AppError::Internal(
                "META_WEBHOOK_VERIFY_TOKEN or AUTH_META_WEBHOOK_VERIFY_TOKEN is required"
                    .to_string(),
            )
        })?;
    let callback_url = format!("{}/api/webhooks/meta", social_app_url(config));
    let app_access_token = format!("{app_id}|{app_secret}");

    let _: Value = fetch_json(
        reqwest::Client::new()
            .post(format!("{META_GRAPH_BASE}/{app_id}/subscriptions"))
            .form(&[
                ("object", "instagram"),
                ("callback_url", callback_url.as_str()),
                ("verify_token", verify_token.as_str()),
                ("fields", META_INSTAGRAM_WEBHOOK_FIELDS),
                ("include_values", "true"),
                ("access_token", app_access_token.as_str()),
            ]),
        "Failed to configure Instagram messaging webhooks for the Meta app",
    )
    .await?;
    META_INSTAGRAM_APP_WEBHOOK_CONFIGURED.store(true, Ordering::Release);
    Ok(())
}

pub async fn ensure_meta_instagram_app_webhooks(
    pool: &PgPool,
    org_id: &str,
    config: &AppConfig,
) -> Result<bool, AppError> {
    if META_INSTAGRAM_APP_WEBHOOK_CONFIGURED.load(Ordering::Acquire) {
        return Ok(false);
    }

    let has_page_linked_instagram = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM "SocialChannelConnection"
            WHERE "orgId" = $1
              AND platform = 'INSTAGRAM'::"SocialPlatform"
              AND status = 'CONNECTED'::"SocialChannelStatus"
              AND metadata->>'provider' = 'meta'
        )
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;

    if !has_page_linked_instagram {
        return Ok(false);
    }

    subscribe_meta_instagram_app_webhooks(config).await?;
    Ok(true)
}

pub async fn ensure_meta_page_webhook_subscriptions(
    pool: &PgPool,
    org_id: &str,
) -> Result<usize, AppError> {
    let channels = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT id, "externalAccountId", "accessToken"
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1
          AND platform = 'FACEBOOK'::"SocialPlatform"
          AND status = 'CONNECTED'::"SocialChannelStatus"
          AND "externalAccountId" IS NOT NULL
          AND "accessToken" IS NOT NULL
          AND COALESCE(metadata->>'metaWebhookSubscriptionVersion', '0') <> $2
        "#,
    )
    .bind(org_id)
    .bind(META_PAGE_WEBHOOK_SUBSCRIPTION_VERSION.to_string())
    .fetch_all(pool)
    .await?;

    let mut refreshed = 0;
    for (channel_id, page_id, encrypted_access_token) in channels {
        let access_token = match decrypt_social_secret(&encrypted_access_token) {
            Ok(token) => token,
            Err(error) => {
                log::warn!(
                    "failed to decrypt Meta Page token while refreshing webhooks channel_id={}: {}",
                    channel_id,
                    error
                );
                continue;
            }
        };
        if let Err(error) = subscribe_meta_page_webhooks(&access_token, &page_id).await {
            log::warn!(
                "failed to refresh Meta Page webhook fields channel_id={} page_id={}: {}",
                channel_id,
                page_id,
                error
            );
            continue;
        }

        sqlx::query(
            r#"
            UPDATE "SocialChannelConnection"
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('metaWebhookSubscriptionVersion', $1::int),
                "lastSyncedAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(META_PAGE_WEBHOOK_SUBSCRIPTION_VERSION)
        .bind(&channel_id)
        .bind(org_id)
        .execute(pool)
        .await?;
        refreshed += 1;
    }

    Ok(refreshed)
}

async fn get_social_channel_private_by_id(
    pool: &PgPool,
    org_id: &str,
    id: &str,
) -> Result<Option<SocialChannelPrivate>, AppError> {
    sqlx::query_as::<_, SocialChannelPrivate>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               "accessToken" AS access_token, "refreshToken" AS refresh_token,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
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

pub async fn refresh_social_channel_identity(
    pool: &PgPool,
    org_id: &str,
    channel_id: &str,
) -> Result<SocialChannel, AppError> {
    let channel = get_social_channel_private_by_id(pool, org_id, channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))?;
    let encrypted_access_token = channel.access_token.as_deref().ok_or_else(|| {
        AppError::BadRequest("Reconnect this account to refresh its profile image".to_string())
    })?;
    let access_token = decrypt_social_secret(encrypted_access_token)?;
    let external_account_id = channel.external_account_id.as_deref().ok_or_else(|| {
        AppError::BadRequest(
            "This account does not have a provider identity to refresh".to_string(),
        )
    })?;

    let mut display_name = channel.display_name.clone();
    let mut handle = channel.handle.clone();
    let mut metadata = channel.metadata.clone().unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    let (avatar_key, avatar_url) = match channel.platform.as_str() {
        "FACEBOOK" => {
            let profile = fetch_meta_page_identity(&access_token, external_account_id).await?;
            if let Some(name) = profile.name.filter(|value| !value.trim().is_empty()) {
                display_name = name;
            }
            handle = profile
                .username
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("@{value}"));
            (
                "pictureUrl",
                profile
                    .picture
                    .and_then(|picture| picture.data)
                    .and_then(|data| data.url),
            )
        }
        "INSTAGRAM" => {
            let uses_instagram_login = channel
                .metadata
                .as_ref()
                .and_then(|value| value.get("authMethod"))
                .and_then(Value::as_str)
                == Some("instagram_login");
            if uses_instagram_login {
                let profile = fetch_instagram_profile(&access_token).await?;
                if let Some(name) = profile.name.filter(|value| !value.trim().is_empty()) {
                    display_name = name;
                }
                handle = profile
                    .username
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!("@{value}"));
                ("profilePictureUrl", profile.profile_picture_url)
            } else {
                let profile =
                    fetch_meta_instagram_identity(&access_token, external_account_id).await?;
                if let Some(name) = profile.name.filter(|value| !value.trim().is_empty()) {
                    display_name = name;
                }
                handle = profile
                    .username
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!("@{value}"));
                ("profilePictureUrl", profile.profile_picture_url)
            }
        }
        "X" => {
            let profile = fetch_x_me(&access_token).await?;
            if let Some(name) = profile.name.filter(|value| !value.trim().is_empty()) {
                display_name = name;
            }
            handle = profile
                .username
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("@{value}"));
            ("avatarUrl", profile.profile_image_url)
        }
        "LINKEDIN" => {
            let profile = fetch_linkedin_profile(&access_token).await?;
            if let Some(name) = profile.name.filter(|value| !value.trim().is_empty()) {
                display_name = name;
            }
            ("picture", profile.picture)
        }
        _ => {
            return Err(AppError::BadRequest(
                "This connection does not provide a profile image".to_string(),
            ));
        }
    };

    if let Some(avatar_url) = avatar_url.filter(|value| !value.trim().is_empty()) {
        metadata
            .as_object_mut()
            .expect("metadata object is ensured above")
            .insert(avatar_key.to_string(), Value::String(avatar_url));
    }

    let metadata = merge_channel_metadata_with_capabilities(&channel.platform, Some(metadata));
    sqlx::query(
        r#"
        UPDATE "SocialChannelConnection"
        SET "displayName" = $1,
            handle = $2,
            metadata = $3,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()
        WHERE id = $4 AND "orgId" = $5
        "#,
    )
    .bind(display_name)
    .bind(handle)
    .bind(metadata)
    .bind(channel_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    get_social_channel(pool, org_id, channel_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to load refreshed social account".to_string()))
}

pub async fn remove_threads_connection_data(
    pool: &PgPool,
    external_user_id: &str,
    confirmation_code: Option<&str>,
) -> Result<Vec<String>, AppError> {
    let mut tx = pool.begin().await?;
    let org_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT DISTINCT "orgId"
        FROM "SocialChannelConnection"
        WHERE platform = 'THREADS'::"SocialPlatform"
          AND "externalAccountId" = $1
          AND "orgId" IS NOT NULL
        "#,
    )
    .bind(external_user_id)
    .fetch_all(tx.as_mut())
    .await?;

    // Keep user-authored Content records, but remove identifiers and metadata returned by Threads.
    sqlx::query(
        r#"
        UPDATE "SocialPost"
        SET "primaryChannelId" = CASE
                WHEN "primaryChannelId" IN (
                    SELECT id
                    FROM "SocialChannelConnection"
                    WHERE platform = 'THREADS'::"SocialPlatform"
                      AND "externalAccountId" = $1
                ) THEN NULL
                ELSE "primaryChannelId"
            END,
            metadata = CASE
                WHEN metadata->>'latestPublishedPlatform' = 'THREADS'
                    THEN metadata - 'latestPublishedPostId' - 'latestPublishedPlatform'
                ELSE metadata
            END,
            "updatedAt" = NOW()
        WHERE "primaryChannelId" IN (
                  SELECT id
                  FROM "SocialChannelConnection"
                  WHERE platform = 'THREADS'::"SocialPlatform"
                    AND "externalAccountId" = $1
              )
           OR id IN (
                  SELECT job."postId"
                  FROM "SocialPublishJob" job
                  JOIN "SocialChannelConnection" channel
                    ON channel.id = job."channelConnectionId"
                  WHERE channel.platform = 'THREADS'::"SocialPlatform"
                    AND channel."externalAccountId" = $1
              )
        "#,
    )
    .bind(external_user_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        UPDATE "SocialPublishJob"
        SET "externalPostId" = NULL,
            metadata = NULL,
            "channelConnectionId" = NULL,
            "updatedAt" = NOW()
        WHERE "channelConnectionId" IN (
            SELECT id
            FROM "SocialChannelConnection"
            WHERE platform = 'THREADS'::"SocialPlatform"
              AND "externalAccountId" = $1
        )
        "#,
    )
    .bind(external_user_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        DELETE FROM "SocialChannelConnection"
        WHERE platform = 'THREADS'::"SocialPlatform"
          AND "externalAccountId" = $1
        "#,
    )
    .bind(external_user_id)
    .execute(tx.as_mut())
    .await?;

    if let Some(code) = confirmation_code {
        sqlx::query(
            r#"
            INSERT INTO "SocialDataDeletionRequest"
                (id, provider, "confirmationCode", status, "completedAt", "createdAt", "updatedAt")
            VALUES ($1, 'THREADS', $2, 'COMPLETED', NOW(), NOW(), NOW())
            "#,
        )
        .bind(cuid2::create_id())
        .bind(code)
        .execute(tx.as_mut())
        .await?;
    }

    tx.commit().await?;
    Ok(org_ids)
}

pub async fn threads_data_deletion_status(
    pool: &PgPool,
    confirmation_code: &str,
) -> Result<Option<String>, AppError> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT status
        FROM "SocialDataDeletionRequest"
        WHERE provider = 'THREADS' AND "confirmationCode" = $1
        LIMIT 1
        "#,
    )
    .bind(confirmation_code)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

#[derive(sqlx::FromRow)]
struct SocialWebhookEventRow {
    id: String,
    event_type: String,
    external_account_id: Option<String>,
    payload: Value,
    attempts: i32,
}

#[derive(sqlx::FromRow)]
struct TikTokWebhookJob {
    id: String,
    org_id: String,
    external_post_id: Option<String>,
}

async fn claim_tiktok_webhook_event(
    pool: &PgPool,
) -> Result<Option<SocialWebhookEventRow>, AppError> {
    sqlx::query_as::<_, SocialWebhookEventRow>(r#"
        UPDATE "SocialWebhookEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "updatedAt" = NOW()
        WHERE id = (
            SELECT id FROM "SocialWebhookEvent"
            WHERE provider = 'TIKTOK'
              AND ((status IN ('RECEIVED', 'FAILED') AND "nextAttemptAt" <= NOW())
                OR (status = 'PROCESSING' AND "updatedAt" < NOW() - INTERVAL '5 minutes'))
            ORDER BY "receivedAt" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id, "eventType" AS event_type, "externalAccountId" AS external_account_id, payload, attempts
    "#).fetch_optional(pool).await.map_err(AppError::from)
}

async fn finish_tiktok_webhook_event(
    pool: &PgPool,
    id: &str,
    status: &str,
    error: Option<&str>,
    retry: bool,
) -> Result<(), AppError> {
    sqlx::query(r#"
        UPDATE "SocialWebhookEvent"
        SET status = $2,
            "errorMessage" = $3,
            "processedAt" = CASE WHEN $2 IN ('PROCESSED', 'IGNORED') THEN NOW() ELSE NULL END,
            "nextAttemptAt" = CASE WHEN $4 THEN NOW() + INTERVAL '30 seconds' ELSE "nextAttemptAt" END,
            "updatedAt" = NOW()
        WHERE id = $1
    "#).bind(id).bind(status).bind(error).bind(retry).execute(pool).await?;
    Ok(())
}

async fn find_tiktok_webhook_job(
    pool: &PgPool,
    publish_id: &str,
    user_openid: Option<&str>,
) -> Result<Option<TikTokWebhookJob>, AppError> {
    sqlx::query_as::<_, TikTokWebhookJob>(
        r#"
        SELECT job.id, job."orgId" AS org_id,
               job."externalPostId" AS external_post_id
        FROM "SocialPublishJob" job
        JOIN "SocialChannelConnection" channel ON channel.id = job."channelConnectionId"
        WHERE job.platform = 'TIKTOK'::"SocialPlatform"
          AND (job."externalPostId" = $1 OR job.metadata->>'publishId' = $1)
          AND ($2::text IS NULL OR channel."externalAccountId" = $2)
          AND job."orgId" IS NOT NULL
        ORDER BY job."updatedAt" DESC
        LIMIT 1
    "#,
    )
    .bind(publish_id)
    .bind(user_openid)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn complete_tiktok_job_from_webhook(
    pool: &PgPool,
    job: &TikTokWebhookJob,
    public_post_id: Option<&str>,
    event_type: &str,
    event_content: &Value,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let final_post_id = public_post_id.or(job.external_post_id.as_deref());
    let updated = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "SocialPublishJob"
        SET status = 'PUBLISHED'::"SocialPublishJobStatus", "publishedAt" = NOW(),
            "externalPostId" = COALESCE($2, "externalPostId"), "errorMessage" = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3, "updatedAt" = NOW()
        WHERE id = $1 AND status = 'PROCESSING'::"SocialPublishJobStatus"
        RETURNING "postId"
    "#,
    )
    .bind(&job.id)
    .bind(public_post_id)
    .bind(json!({"tiktokWebhookEvent": event_type, "tiktokWebhookContent": event_content}))
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(post_id) = updated else {
        tx.commit().await?;
        return Ok(false);
    };
    sqlx::query(r#"
        UPDATE "SocialPost"
        SET status = 'PUBLISHED'::"SocialPostStatus", "publishedAt" = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb) || $1, "updatedAt" = NOW()
        WHERE id = $2
    "#).bind(json!({"latestPublishedPostId": final_post_id, "latestPublishedPlatform":"TIKTOK", "tiktokWebhookEvent":event_type}))
        .bind(&post_id).execute(tx.as_mut()).await?;
    tx.commit().await?;
    billing::record_meter_usage(
        pool,
        &job.org_id,
        billing::meters::SOCIAL_PUBLISHES,
        1,
        "social_publish_job",
        &job.id,
        &format!("social-publish:{}", job.id),
    )
    .await?;
    Ok(true)
}

async fn fail_tiktok_job_from_webhook(
    pool: &PgPool,
    job: &TikTokWebhookJob,
    reason: &str,
    event_content: &Value,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "SocialPublishJob"
        SET status = 'FAILED'::"SocialPublishJobStatus", "errorMessage" = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3, "updatedAt" = NOW()
        WHERE id = $1 AND status = 'PROCESSING'::"SocialPublishJobStatus"
        RETURNING "postId"
    "#,
    )
    .bind(&job.id)
    .bind(reason)
    .bind(json!({"tiktokWebhookEvent":"post.publish.failed", "tiktokWebhookContent":event_content}))
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(post_id) = updated else {
        tx.commit().await?;
        return Ok(false);
    };
    sqlx::query(
        r#"UPDATE "SocialPost" SET status='FAILED'::"SocialPostStatus",
        metadata=COALESCE(metadata, '{}'::jsonb)||$1, "updatedAt"=NOW() WHERE id=$2"#,
    )
    .bind(json!({"failedAt":Utc::now().to_rfc3339(),"failureReason":reason}))
    .bind(post_id)
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(true)
}

async fn process_tiktok_webhook_event(
    pool: &PgPool,
    event: &SocialWebhookEventRow,
) -> Result<bool, AppError> {
    let content = event
        .payload
        .get("content")
        .and_then(Value::as_str)
        .map(|value| serde_json::from_str::<Value>(value).unwrap_or_else(|_| json!({"raw": value})))
        .unwrap_or(Value::Null);
    match event.event_type.as_str() {
        "post.publish.complete" | "post.publish.publicly_available" => {
            let publish_id = content
                .get("publish_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::BadRequest("TikTok publish webhook is missing publish_id".to_string())
                })?;
            let job =
                find_tiktok_webhook_job(pool, publish_id, event.external_account_id.as_deref())
                    .await?
                    .ok_or_else(|| {
                        AppError::NotFound("TikTok publish job was not found".to_string())
                    })?;
            let public_post_id = content.get("post_id").and_then(Value::as_str);
            complete_tiktok_job_from_webhook(
                pool,
                &job,
                public_post_id,
                &event.event_type,
                &content,
            )
            .await
        }
        "post.publish.failed" => {
            let publish_id = content
                .get("publish_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::BadRequest("TikTok publish webhook is missing publish_id".to_string())
                })?;
            let job =
                find_tiktok_webhook_job(pool, publish_id, event.external_account_id.as_deref())
                    .await?
                    .ok_or_else(|| {
                        AppError::NotFound("TikTok publish job was not found".to_string())
                    })?;
            let reason = content
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("TikTok rejected the post");
            fail_tiktok_job_from_webhook(pool, &job, reason, &content).await
        }
        "post.publish.no_longer_publicaly_available" | "post.publish.inbox_delivered" => Ok(false),
        "authorization.removed" => {
            let Some(open_id) = event.external_account_id.as_deref() else {
                return Ok(false);
            };
            let org_ids = sqlx::query_scalar::<_, String>(r#"
                UPDATE "SocialChannelConnection" SET status='NEEDS_REAUTH'::"SocialChannelStatus",
                    "accessToken"=NULL, "refreshToken"=NULL,
                    metadata=COALESCE(metadata, '{}'::jsonb)||$1, "updatedAt"=NOW()
                WHERE platform='TIKTOK'::"SocialPlatform" AND "externalAccountId"=$2 AND "orgId" IS NOT NULL
                RETURNING "orgId"
            "#).bind(json!({"tiktokAuthorizationRemovedAt":Utc::now().to_rfc3339()})).bind(open_id)
                .fetch_all(pool).await?;
            for org_id in org_ids {
                connections::sync_org_connections(pool, &org_id).await?;
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub async fn process_tiktok_webhook_events(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    let mut processed = 0;
    for _ in 0..limit.max(1) {
        let Some(event) = claim_tiktok_webhook_event(pool).await? else {
            break;
        };
        match process_tiktok_webhook_event(pool, &event).await {
            Ok(true) => {
                finish_tiktok_webhook_event(pool, &event.id, "PROCESSED", None, false).await?
            }
            Ok(false) => {
                finish_tiktok_webhook_event(pool, &event.id, "IGNORED", None, false).await?
            }
            Err(error) => {
                let retry = event.attempts < 8;
                finish_tiktok_webhook_event(
                    pool,
                    &event.id,
                    "FAILED",
                    Some(&error.to_string()),
                    retry,
                )
                .await?;
            }
        }
        processed += 1;
    }
    Ok(processed)
}

pub use super::social_posts::{
    create_social_post, create_social_post_idempotent, delete_social_post, get_social_post,
    list_social_posts, update_social_post,
};
async fn resolve_connected_channel_for_platform(
    pool: &PgPool,
    org_id: &str,
    platform: &str,
    channel_connection_id: &Option<String>,
) -> Result<SocialChannelPrivate, AppError> {
    if let Some(channel_id) = channel_connection_id.as_ref() {
        let sql = format!(
            r#"
            SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
                   "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
                   "accessToken" AS access_token, "refreshToken" AS refresh_token,
                   metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "SocialChannelConnection"
            WHERE id = $1 AND "orgId" = $2 AND platform = '{platform}'::"SocialPlatform" AND status = 'CONNECTED'::"SocialChannelStatus"
            LIMIT 1
            "#
        );
        if let Some(channel) = sqlx::query_as::<_, SocialChannelPrivate>(&sql)
            .bind(channel_id)
            .bind(org_id)
            .fetch_optional(pool)
            .await?
        {
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
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1 AND platform = '{platform}'::"SocialPlatform" AND status = 'CONNECTED'::"SocialChannelStatus"
        ORDER BY "updatedAt" DESC
        LIMIT 1
        "#
    );
    let channel = sqlx::query_as::<_, SocialChannelPrivate>(&sql)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "Connect a {} account before publishing",
                platform.to_lowercase()
            ))
        })?;

    if channel.access_token.is_none() {
        return Err(AppError::BadRequest(format!(
            "Connect a {} account before publishing",
            platform.to_lowercase()
        )));
    }

    Ok(channel)
}

pub(crate) use super::social_publishing::{
    delete_post_from_provider, publish_post_to_facebook, publish_post_to_instagram,
    publish_post_to_linkedin, publish_post_to_threads, publish_post_to_tiktok, publish_post_to_x,
    refresh_threads_token, refresh_tiktok_token, save_rotated_tokens,
};

async fn resolve_channel_for_post_deletion(
    pool: &PgPool,
    org_id: &str,
    platform: &str,
    channel_connection_id: &str,
) -> Result<SocialChannelPrivate, AppError> {
    sqlx::query_as::<_, SocialChannelPrivate>(
        r#"
        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               "accessToken" AS access_token, "refreshToken" AS refresh_token,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE id = $1 AND "orgId" = $2 AND platform = $3::"SocialPlatform"
          AND status = 'CONNECTED'::"SocialChannelStatus"
        LIMIT 1
        "#,
    )
    .bind(channel_connection_id)
    .bind(org_id)
    .bind(platform)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::BadRequest(format!(
            "Reconnect the {} account before deleting its post",
            platform.to_lowercase()
        ))
    })
}

async fn save_bluesky_deletion_nonce(
    pool: &PgPool,
    channel_id: &str,
    authorization_nonce: Option<&str>,
    resource_nonce: Option<&str>,
) -> Result<(), AppError> {
    let mut metadata = serde_json::Map::new();
    if let Some(value) = authorization_nonce {
        metadata.insert(
            "dpopAuthorizationNonce".to_string(),
            Value::String(value.to_string()),
        );
    }
    if let Some(value) = resource_nonce {
        metadata.insert(
            "dpopResourceNonce".to_string(),
            Value::String(value.to_string()),
        );
    }
    if metadata.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE "SocialChannelConnection"
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1, "updatedAt" = NOW()
           WHERE id = $2"#,
    )
    .bind(Value::Object(metadata))
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn delete_bluesky_post(
    pool: &PgPool,
    config: &AppConfig,
    channel: &SocialChannelPrivate,
    external_post_id: &str,
) -> Result<(), AppError> {
    let metadata = channel.metadata.as_ref().ok_or_else(|| {
        AppError::BadRequest("Reconnect Bluesky using OAuth before deleting posts".to_string())
    })?;
    let pds = metadata
        .get("pds")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("Bluesky connection is missing its PDS".to_string()))?;
    let did = channel
        .external_account_id
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Bluesky connection is missing its DID".to_string()))?;
    let dpop_private_key = decrypt_social_secret(
        metadata
            .get("dpopPrivateKey")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::BadRequest("Bluesky connection is missing its DPoP key".to_string())
            })?,
    )?;
    let access_token =
        decrypt_social_secret(channel.access_token.as_deref().ok_or_else(|| {
            AppError::BadRequest("Reconnect Bluesky before deleting posts".to_string())
        })?)?;
    let resource_nonce = metadata.get("dpopResourceNonce").and_then(Value::as_str);

    match bluesky_oauth::delete_post(
        pds,
        did,
        external_post_id,
        &access_token,
        &dpop_private_key,
        resource_nonce,
    )
    .await
    {
        Ok(resource_nonce) => {
            save_bluesky_deletion_nonce(pool, &channel.id, None, resource_nonce.as_deref()).await
        }
        Err(first_error) => {
            let Some(refresh_token) = channel.refresh_token.as_deref() else {
                return Err(first_error);
            };
            let authorization_server = metadata
                .get("authorizationServer")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "Bluesky connection is missing its authorization server".to_string(),
                    )
                })?;
            let refresh_token = decrypt_social_secret(refresh_token)?;
            let session = bluesky_oauth::refresh(
                config,
                &refresh_token,
                authorization_server,
                &dpop_private_key,
                metadata
                    .get("dpopAuthorizationNonce")
                    .and_then(Value::as_str),
            )
            .await
            .map_err(|refresh_error| {
                AppError::BadRequest(format!(
                    "Bluesky deletion failed: {}; token refresh failed: {}",
                    first_error, refresh_error
                ))
            })?;
            save_rotated_tokens(
                pool,
                &channel.id,
                &session.access_token,
                Some(&session.refresh_token),
                session.expires_in,
            )
            .await?;
            let resource_nonce = bluesky_oauth::delete_post(
                pds,
                did,
                external_post_id,
                &session.access_token,
                &dpop_private_key,
                resource_nonce,
            )
            .await?;
            save_bluesky_deletion_nonce(
                pool,
                &channel.id,
                session.authorization_nonce.as_deref(),
                resource_nonce.as_deref(),
            )
            .await
        }
    }
}

pub async fn delete_social_post_from_platforms(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    post_id: &str,
) -> Result<SocialPostDeletionResult, AppError> {
    let post = social_posts::get_social_post(pool, org_id, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".to_string()))?;
    let mut provider_results = Vec::new();

    for job in post
        .publish_jobs
        .iter()
        .filter(|job| job.status == "PUBLISHED")
    {
        let external_post_id = job.external_post_id.clone();
        let mut result = SocialPostProviderDeletionResult {
            platform: job.platform.clone(),
            external_post_id: external_post_id.clone(),
            status: "FAILED".to_string(),
            message: None,
        };

        let Some(external_post_id) = external_post_id else {
            result.message =
                Some("No provider post ID was saved for this published job".to_string());
            provider_results.push(result);
            continue;
        };
        let Some(channel_connection_id) = job.channel_connection_id.as_deref() else {
            result.message = Some("The published job has no channel connection".to_string());
            provider_results.push(result);
            continue;
        };

        let deletion_result = async {
            let channel = resolve_channel_for_post_deletion(
                pool,
                org_id,
                &job.platform,
                channel_connection_id,
            )
            .await?;
            if job.platform == "BLUESKY" {
                delete_bluesky_post(pool, config, &channel, &external_post_id).await
            } else {
                let access_token = channel.access_token.as_deref().ok_or_else(|| {
                    AppError::BadRequest(format!(
                        "Reconnect the {} account before deleting its post",
                        job.platform.to_lowercase()
                    ))
                })?;
                delete_post_from_provider(
                    &job.platform,
                    access_token,
                    &channel.external_account_id,
                    &channel.metadata,
                    &external_post_id,
                )
                .await
            }
        }
        .await;

        match deletion_result {
            Ok(()) => {
                result.status = "DELETED".to_string();
            }
            Err(error) => {
                result.message = Some(error.to_string());
            }
        }
        provider_results.push(result);
    }

    let all_provider_deletes_succeeded = provider_results
        .iter()
        .all(|result| result.status == "DELETED");
    if !all_provider_deletes_succeeded {
        return Ok(SocialPostDeletionResult {
            success: false,
            local_deleted: false,
            provider_results,
        });
    }

    let local_deleted = social_posts::delete_social_post(pool, org_id, post_id).await?;
    if !local_deleted {
        return Err(AppError::NotFound("Post not found".to_string()));
    }
    Ok(SocialPostDeletionResult {
        success: true,
        local_deleted: true,
        provider_results,
    })
}
pub async fn get_tiktok_creator_info(
    pool: &PgPool,
    org_id: &str,
    channel_id: &str,
) -> Result<Value, AppError> {
    let channel = resolve_connected_channel_for_platform(
        pool,
        org_id,
        "TIKTOK",
        &Some(channel_id.to_string()),
    )
    .await?;
    let access = if token_expires_within(&channel.metadata, Duration::minutes(5)) {
        let refresh = channel.refresh_token.as_deref().ok_or_else(|| {
            AppError::BadRequest("Reconnect TikTok to refresh creator settings".to_string())
        })?;
        let tokens = refresh_tiktok_token(refresh).await?;
        let access = tokens.access_token.as_deref().ok_or_else(|| {
            AppError::BadRequest("TikTok refresh did not return an access token".to_string())
        })?;
        save_rotated_tokens(
            pool,
            &channel.id,
            access,
            tokens.refresh_token.as_deref(),
            tokens.expires_in,
        )
        .await?;
        access.to_string()
    } else {
        decrypt_social_secret(channel.access_token.as_deref().ok_or_else(|| {
            AppError::BadRequest("Reconnect TikTok to load creator settings".to_string())
        })?)?
    };
    let result: Value = fetch_json(
        reqwest::Client::new()
            .post(TIKTOK_CREATOR_INFO_URL)
            .bearer_auth(&access)
            .header("Content-Type", "application/json")
            .json(&json!({})),
        "Failed to query TikTok creator settings",
    )
    .await?;
    let code = result
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("ok");
    if code != "ok" {
        return Err(AppError::BadRequest(
            result
                .get("error")
                .and_then(|v| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or(code)
                .to_string(),
        ));
    }
    result
        .get("data")
        .cloned()
        .ok_or_else(|| AppError::BadRequest("TikTok did not return creator settings".to_string()))
}

async fn mark_job_failed(
    pool: &PgPool,
    job_id: &str,
    post_id: &str,
    message: &str,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let result = sqlx::query(
        r#"
        UPDATE "SocialPublishJob"
        SET status = 'FAILED'::"SocialPublishJobStatus", "errorMessage" = $1, "updatedAt" = NOW()
        WHERE id = $2
          AND status IN (
              'PENDING'::"SocialPublishJobStatus",
              'QUEUED'::"SocialPublishJobStatus",
              'PROCESSING'::"SocialPublishJobStatus"
          )
        "#,
    )
    .bind(message)
    .bind(job_id)
    .execute(tx.as_mut())
    .await?;
    if result.rows_affected() == 0 {
        tx.commit().await?;
        return Ok(());
    }
    sqlx::query(
        r#"
        UPDATE "SocialPost"
        SET status = 'FAILED'::"SocialPostStatus",
            metadata = COALESCE(metadata, '{}'::jsonb) || $1,
            "updatedAt" = NOW()
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
        SELECT j.id, j."userId" AS user_id, j."orgId" AS org_id, j."postId" AS post_id, j."variantId" AS variant_id,
               j."channelConnectionId" AS channel_connection_id, j.platform::text AS platform,
               j.status::text AS status, j."externalPostId" AS external_post_id,
               p.content AS post_content, p.metadata AS post_metadata,
               p."primaryChannelId" AS post_primary_channel_id,
               v.content AS variant_content,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'assetId', pm."assetId",
                       'kind', a.kind::text,
                       'mimeType', a."mimeType",
                       'sortOrder', pm."sortOrder"
                   ) ORDER BY pm."sortOrder" ASC)
                   FROM "SocialPostMedia" pm
                   JOIN "ContentMediaAsset" a ON a.id = pm."assetId"
                   WHERE pm."postId" = p.id
               ), '[]'::jsonb) AS media
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

pub async fn claim_publish_job(
    pool: &PgPool,
    job_id: &str,
    allowed_statuses: &[&str],
) -> Result<bool, AppError> {
    if allowed_statuses
        .iter()
        .any(|status| !is_valid_job_status(status))
    {
        return Err(AppError::BadRequest(
            "Invalid publish job status".to_string(),
        ));
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

pub async fn execute_social_publish_job(
    pool: &PgPool,
    job_id: &str,
) -> Result<PublishExecutionResult, AppError> {
    let job = load_publish_job(pool, job_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Publish job not found".to_string()))?;
    let org_id = job.org_id.as_deref().ok_or_else(|| {
        AppError::Internal(
            "Social publish job does not have an organisation assignment".to_string(),
        )
    })?;
    let config = AppConfig::from_env().map_err(|_| {
        AppError::Internal("Failed to load content media configuration".to_string())
    })?;

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
        if job.platform == "FACEBOOK" {
            if has_attached_media(&job.media) {
                return Err(AppError::BadRequest(
                    "Facebook media publishing is not enabled for this connection yet; remove the attachment or use a text-only version".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "FACEBOOK",
                &job.channel_connection_id,
            )
            .await?;
            let access = channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Connect a Facebook Page before publishing".to_string())
            })?;
            let (external_post_id, published_text) =
                publish_post_to_facebook(access, &channel.external_account_id, &publish_text)
                    .await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "meta-facebook".to_string(),
                published_text,
            ))
        } else if job.platform == "INSTAGRAM" {
            let image_url = job
                .post_metadata
                .as_ref()
                .and_then(|value| value.get("instagramImageUrl"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| attached_media_url(&job.media, &config, Some("IMAGE")))
                .ok_or_else(|| AppError::BadRequest("Attach an image or add a public HTTPS image URL before publishing to Instagram".to_string()))?;
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "INSTAGRAM",
                &job.channel_connection_id,
            )
            .await?;
            let access = channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Connect an Instagram account before publishing".to_string())
            })?;
            let (external_post_id, published_text) = publish_post_to_instagram(
                access,
                &channel.external_account_id,
                &channel.metadata,
                &image_url,
                &publish_text,
            )
            .await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "instagram".to_string(),
                published_text,
            ))
        } else if job.platform == "THREADS" {
            if has_attached_media(&job.media) {
                return Err(AppError::BadRequest(
                    "Threads media publishing is not enabled for this connection yet; remove the attachment or use a text-only version".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "THREADS",
                &job.channel_connection_id,
            )
            .await?;
            let access = channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Connect a Threads account before publishing".to_string())
            })?;
            let publish_access = if token_expires_within(&channel.metadata, Duration::days(7)) {
                let refreshed = refresh_threads_token(access).await?;
                let refreshed_access = refreshed.access_token.as_deref().ok_or_else(|| {
                    AppError::BadRequest(
                        "Threads refresh did not return an access token".to_string(),
                    )
                })?;
                save_rotated_tokens(
                    pool,
                    &channel.id,
                    refreshed_access,
                    None,
                    refreshed.expires_in,
                )
                .await?;
                encrypt_social_secret(refreshed_access)?
            } else {
                access.to_string()
            };
            let user_id = channel.external_account_id.as_deref().ok_or_else(|| {
                AppError::BadRequest(
                    "Threads connection is missing its account identifier".to_string(),
                )
            })?;
            let (external_post_id, published_text) =
                publish_post_to_threads(&publish_access, user_id, &publish_text).await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "threads".to_string(),
                published_text,
            ))
        } else if job.platform == "TIKTOK" {
            if job
                .media
                .as_array()
                .is_some_and(|items| items.len() > 1)
            {
                return Err(AppError::BadRequest(
                    "The current TikTok adapter accepts one uploaded image or video per post".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "TIKTOK",
                &job.channel_connection_id,
            )
            .await?;
            let access = if token_expires_within(&channel.metadata, Duration::minutes(5)) {
                let refresh = channel.refresh_token.as_deref().ok_or_else(|| {
                    AppError::BadRequest(
                        "Reconnect TikTok to refresh publishing access".to_string(),
                    )
                })?;
                let tokens = refresh_tiktok_token(refresh).await?;
                let access = tokens.access_token.as_deref().ok_or_else(|| {
                    AppError::BadRequest(
                        "TikTok refresh did not return an access token".to_string(),
                    )
                })?;
                save_rotated_tokens(
                    pool,
                    &channel.id,
                    access,
                    tokens.refresh_token.as_deref(),
                    tokens.expires_in,
                )
                .await?;
                access.to_string()
            } else {
                decrypt_social_secret(channel.access_token.as_deref().ok_or_else(|| {
                    AppError::BadRequest("Connect a TikTok account before publishing".to_string())
                })?)?
            };
            let mut tiktok_metadata = job.post_metadata.clone().unwrap_or_else(|| json!({}));
            let tiktok_metadata_object = tiktok_metadata.as_object_mut().ok_or_else(|| {
                AppError::BadRequest("TikTok post metadata must be an object".to_string())
            })?;
            if tiktok_metadata_object
                .get("tiktokMediaUrl")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                let media_kind = tiktok_metadata_object
                    .get("tiktokMediaType")
                    .and_then(Value::as_str)
                    .map(|value| if value == "PHOTO" { "IMAGE" } else { "VIDEO" });
                if let Some(media_url) = attached_media_url(&job.media, &config, media_kind) {
                    tiktok_metadata_object.insert("tiktokMediaUrl".to_string(), Value::String(media_url));
                    tiktok_metadata_object.insert(
                        "tiktokMediaType".to_string(),
                        Value::String(if media_kind == Some("IMAGE") { "PHOTO" } else { "VIDEO" }.to_string()),
                    );
                }
            }
            let (external_post_id, published_text) =
                publish_post_to_tiktok(&access, &Some(tiktok_metadata), &publish_text).await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "tiktok".to_string(),
                published_text,
            ))
        } else if job.platform == "BLUESKY" {
            if has_attached_media(&job.media) {
                return Err(AppError::BadRequest(
                    "Bluesky media publishing is not enabled for this connection yet; remove the attachment or use a text-only version".to_string(),
                ));
            }
            if publish_text.chars().count() > 300 {
                return Err(AppError::BadRequest("Bluesky posts are limited to 300 characters".to_string()));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "BLUESKY",
                &job.channel_connection_id,
            )
            .await?;
            let metadata=channel.metadata.as_ref().ok_or_else(||AppError::BadRequest("Reconnect Bluesky using OAuth before publishing".to_string()))?;
            if metadata.get("authMethod").and_then(Value::as_str)!=Some("oauth") {
                return Err(AppError::BadRequest("Reconnect Bluesky using the new authorization flow".to_string()));
            }
            let refresh = decrypt_social_secret(channel.refresh_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Reconnect Bluesky to refresh publishing access".to_string())
            })?)?;
            let pds=metadata.get("pds").and_then(Value::as_str).ok_or_else(||AppError::BadRequest("Bluesky connection is missing its PDS".to_string()))?;
            let authorization_server=metadata.get("authorizationServer").and_then(Value::as_str).ok_or_else(||AppError::BadRequest("Bluesky connection is missing its authorization server".to_string()))?;
            let dpop_private_key=decrypt_social_secret(metadata.get("dpopPrivateKey").and_then(Value::as_str).ok_or_else(||AppError::BadRequest("Bluesky connection is missing its DPoP key".to_string()))?)?;
            let auth_nonce=metadata.get("dpopAuthorizationNonce").and_then(Value::as_str);
            let session = match bluesky_oauth::refresh(&config,&refresh,authorization_server,&dpop_private_key,auth_nonce).await {
                Ok(session) => session,
                Err(error) => {
                    let invalid_grant = matches!(&error, AppError::BadRequest(message) if message.contains("invalid_grant") || message.contains("Invalid refresh token") || message.contains("Token was not issued to this client"));
                    if invalid_grant {
                        sqlx::query(
                            r#"UPDATE "SocialChannelConnection"
                               SET status='NEEDS_REAUTH'::"SocialChannelStatus",
                                   metadata=COALESCE(metadata,'{}'::jsonb)||$1,
                                   "updatedAt"=NOW()
                               WHERE id=$2 AND "orgId"=$3"#,
                        )
                        .bind(json!({"reauthReason":"invalid_refresh_token","reauthRequiredAt":Utc::now().to_rfc3339()}))
                        .bind(&channel.id)
                        .bind(org_id)
                        .execute(pool)
                        .await?;
                        connections::sync_org_connections(pool, org_id).await?;
                        return Err(AppError::BadRequest(
                            "Bluesky connection expired. Reconnect Bluesky before publishing"
                                .to_string(),
                        ));
                    }
                    return Err(error);
                }
            };
            save_rotated_tokens(
                pool,
                &channel.id,
                &session.access_token,
                Some(&session.refresh_token),
                session.expires_in,
            )
            .await?;
            let did = channel.external_account_id.as_deref().ok_or_else(|| {
                AppError::BadRequest("Bluesky connection is missing its DID".to_string())
            })?;
            let resource_nonce=metadata.get("dpopResourceNonce").and_then(Value::as_str);
            let (external_post_id,resource_nonce)=bluesky_oauth::create_post(pds,did,&publish_text,&session.access_token,&dpop_private_key,resource_nonce).await?;
            sqlx::query(r#"UPDATE "SocialChannelConnection" SET metadata=COALESCE(metadata,'{}'::jsonb)||$1,"updatedAt"=NOW() WHERE id=$2"#)
                .bind(json!({"dpopAuthorizationNonce":session.authorization_nonce,"dpopResourceNonce":resource_nonce})).bind(&channel.id).execute(pool).await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "bluesky".to_string(),
                publish_text,
            ))
        } else if job.platform == "X" {
            if has_attached_media(&job.media) {
                return Err(AppError::BadRequest(
                    "X media publishing is not enabled for this connection yet; remove the attachment or use a text-only version".to_string(),
                ));
            }
            if publish_text.chars().count() > 280 {
                return Err(AppError::BadRequest(
                    "X posts are currently limited to 280 characters".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "X",
                &job.channel_connection_id,
            )
            .await?;
            let access = channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Connect an X account before publishing".to_string())
            })?;
            let (external_post_id, published_text) =
                publish_post_to_x(access, &publish_text).await?;
            Ok((
                channel.id,
                Some(external_post_id),
                "x".to_string(),
                published_text,
            ))
        } else if job.platform == "LINKEDIN" {
            if has_attached_media(&job.media) {
                return Err(AppError::BadRequest(
                    "LinkedIn media publishing is not enabled for this connection yet; remove the attachment or use a text-only version".to_string(),
                ));
            }
            if publish_text.chars().count() > 3000 {
                return Err(AppError::BadRequest(
                    "LinkedIn posts are currently limited to 3000 characters".to_string(),
                ));
            }
            let channel = resolve_connected_channel_for_platform(
                pool,
                org_id,
                "LINKEDIN",
                &job.channel_connection_id,
            )
            .await?;
            let access = channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Connect a linkedin account before publishing".to_string())
            })?;
            let (external_post_id, published_text) = publish_post_to_linkedin(
                access,
                &channel.external_account_id,
                &channel.metadata,
                &publish_text,
            )
            .await?;
            Ok((
                channel.id,
                external_post_id,
                "linkedin".to_string(),
                published_text,
            ))
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
            if provider == "tiktok" {
                sqlx::query(r#"UPDATE "SocialPublishJob" SET status='PROCESSING'::"SocialPublishJobStatus",
                    "externalPostId"=$1, "channelConnectionId"=$2, metadata=$3, "updatedAt"=NOW() WHERE id=$4"#)
                    .bind(&external_post_id).bind(&connection_id)
                    .bind(json!({"provider":"tiktok","publishId":external_post_id,"submittedText":published_text}))
                    .bind(&job.id).execute(pool).await?;
                sqlx::query(r#"UPDATE "SocialPost" SET status='PROCESSING'::"SocialPostStatus", "updatedAt"=NOW() WHERE id=$1"#)
                    .bind(&job.post_id).execute(pool).await?;
                return Ok(PublishExecutionResult {
                    job_id: job.id,
                    post_id: job.post_id,
                    platform: job.platform,
                    status: "PROCESSING".to_string(),
                    external_post_id,
                });
            }
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
                    metadata = COALESCE(metadata, '{}'::jsonb) || $3,
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

            billing::record_meter_usage(
                pool,
                org_id,
                billing::meters::SOCIAL_PUBLISHES,
                1,
                "social_publish_job",
                &job.id,
                &format!("social-publish:{}", job.id),
            )
            .await?;

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
    let webhook_events = process_tiktok_webhook_events(pool, limit).await?;
    let reconciled = reconcile_tiktok_publish_jobs(pool, limit).await?;
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

    Ok(processed + reconciled + webhook_events)
}

#[derive(sqlx::FromRow)]
struct TikTokPendingJob {
    id: String,
    post_id: String,
    org_id: String,
    channel_connection_id: String,
    publish_id: String,
}

async fn reconcile_tiktok_publish_jobs(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    let jobs = sqlx::query_as::<_, TikTokPendingJob>(r#"
        SELECT job.id, job."postId" AS post_id, job."orgId" AS org_id,
               job."channelConnectionId" AS channel_connection_id, job."externalPostId" AS publish_id
        FROM "SocialPublishJob" job
        WHERE job.status='PROCESSING'::"SocialPublishJobStatus" AND job.platform='TIKTOK'::"SocialPlatform"
          AND job."externalPostId" IS NOT NULL AND job."channelConnectionId" IS NOT NULL AND job."orgId" IS NOT NULL
        ORDER BY job."updatedAt" ASC LIMIT $1"#)
        .bind(limit.max(1)).fetch_all(pool).await?;
    let mut handled = 0;
    for job in jobs {
        let channel = resolve_connected_channel_for_platform(
            pool,
            &job.org_id,
            "TIKTOK",
            &Some(job.channel_connection_id.clone()),
        )
        .await?;
        let access = if token_expires_within(&channel.metadata, Duration::minutes(5)) {
            let refresh = channel.refresh_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Reconnect TikTok to check publish status".to_string())
            })?;
            let tokens = refresh_tiktok_token(refresh).await?;
            let access = tokens.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("TikTok refresh did not return an access token".to_string())
            })?;
            save_rotated_tokens(
                pool,
                &channel.id,
                access,
                tokens.refresh_token.as_deref(),
                tokens.expires_in,
            )
            .await?;
            access.to_string()
        } else {
            decrypt_social_secret(channel.access_token.as_deref().ok_or_else(|| {
                AppError::BadRequest("Reconnect TikTok to check publish status".to_string())
            })?)?
        };
        let result: Value = fetch_json(
            reqwest::Client::new()
                .post(TIKTOK_STATUS_URL)
                .bearer_auth(&access)
                .json(&json!({"publish_id":job.publish_id})),
            "Failed to check TikTok publish status",
        )
        .await?;
        let code = result
            .get("error")
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("ok");
        if code != "ok" {
            continue;
        }
        let data = result.get("data").cloned().unwrap_or(Value::Null);
        match data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("PROCESSING")
        {
            "PUBLISH_COMPLETE" => {
                let post_id = data
                    .get("publicaly_available_post_id")
                    .and_then(Value::as_array)
                    .and_then(|ids| ids.first())
                    .and_then(Value::as_str)
                    .unwrap_or(&job.publish_id);
                let now = Utc::now();
                let mut tx = pool.begin().await?;
                let updated = sqlx::query(r#"UPDATE "SocialPublishJob" SET status='PUBLISHED'::"SocialPublishJobStatus",
                    "publishedAt"=$1,"externalPostId"=$2,metadata=COALESCE(metadata,'{}'::jsonb)||$3,"updatedAt"=NOW()
                    WHERE id=$4 AND status='PROCESSING'::"SocialPublishJobStatus""#)
                    .bind(now).bind(post_id).bind(json!({"tiktokStatus":data})).bind(&job.id)
                    .execute(tx.as_mut()).await?;
                if updated.rows_affected() == 0 {
                    tx.commit().await?;
                    continue;
                }
                sqlx::query(r#"UPDATE "SocialPost" SET status='PUBLISHED'::"SocialPostStatus","publishedAt"=$1,
                    metadata=COALESCE(metadata,'{}'::jsonb)||$2,"updatedAt"=NOW() WHERE id=$3"#)
                    .bind(now).bind(json!({"latestPublishedPostId":post_id,"latestPublishedPlatform":"TIKTOK"})).bind(&job.post_id).execute(tx.as_mut()).await?;
                tx.commit().await?;
                billing::record_meter_usage(
                    pool,
                    &job.org_id,
                    billing::meters::SOCIAL_PUBLISHES,
                    1,
                    "social_publish_job",
                    &job.id,
                    &format!("social-publish:{}", job.id),
                )
                .await?;
                handled += 1;
            }
            "FAILED" => {
                let reason = data
                    .get("fail_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("TikTok rejected the post");
                mark_job_failed(pool, &job.id, &job.post_id, reason).await?;
                handled += 1;
            }
            _ => {}
        }
    }
    Ok(handled)
}

#[cfg(test)]
mod tests {
    use super::{decode_threads_signed_request, HmacSha256, InstagramProfile, Value};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use hmac::Mac;
    use serde_json::json;

    fn profile(id: Option<&str>, user_id: Option<Value>) -> InstagramProfile {
        InstagramProfile {
            id: id.map(str::to_string),
            user_id,
            username: None,
            name: None,
            profile_picture_url: None,
            followers_count: None,
            follows_count: None,
            media_count: None,
            account_type: None,
        }
    }

    #[test]
    fn instagram_profile_prefers_webhook_routing_user_id() {
        let profile = profile(
            Some("app-scoped-id"),
            Some(Value::String("instagram-user-id".to_string())),
        );

        assert_eq!(profile.account_id().as_deref(), Some("instagram-user-id"));
    }

    #[test]
    fn instagram_profile_accepts_numeric_webhook_routing_user_id() {
        let profile = profile(
            Some("app-scoped-id"),
            Some(Value::Number(17841404705725617_u64.into())),
        );

        assert_eq!(profile.account_id().as_deref(), Some("17841404705725617"));
    }

    #[test]
    fn instagram_profile_falls_back_to_app_scoped_id() {
        let profile = profile(Some("app-scoped-id"), None);

        assert_eq!(profile.account_id().as_deref(), Some("app-scoped-id"));
    }

    fn threads_signed_request(payload: Value, secret: &str) -> String {
        let encoded_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(encoded_payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signature}.{encoded_payload}")
    }

    #[test]
    fn threads_signed_request_verifies_and_returns_user_id() {
        let secret = "test-threads-secret";
        let request = threads_signed_request(
            json!({"algorithm":"HMAC-SHA256","user_id":"2415783455549474"}),
            secret,
        );

        assert_eq!(
            decode_threads_signed_request(&request, secret).unwrap(),
            "2415783455549474"
        );
    }

    #[test]
    fn threads_signed_request_accepts_numeric_user_id() {
        let secret = "test-threads-secret";
        let request = threads_signed_request(
            json!({"algorithm":"HMAC-SHA256","user_id":2415783455549474_u64}),
            secret,
        );

        assert_eq!(
            decode_threads_signed_request(&request, secret).unwrap(),
            "2415783455549474"
        );
    }

    #[test]
    fn threads_signed_request_rejects_tampering() {
        let secret = "test-threads-secret";
        let request = threads_signed_request(
            json!({"algorithm":"HMAC-SHA256","user_id":"original-user"}),
            secret,
        );
        let tampered = format!("{request}A");

        assert!(decode_threads_signed_request(&tampered, secret).is_err());
    }
}
