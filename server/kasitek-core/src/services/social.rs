use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use crypto_utils::{
    decrypt_with_aes256_gcm, encrypt_with_aes256_gcm, generate_token, sha256_base64_url,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;

use crate::config::AppConfig;
use crate::db::models::{
    SocialChannel, SocialPost, SocialPostRow, SocialPostUpsertRequest, SocialPostVariant,
    SocialPostVariantInput, SocialPublishJobRow,
};
use crate::error::AppError;
use crate::services::billing;

const X_AUTHORIZE_URL: &str = "https://twitter.com/i/oauth2/authorize";
const X_TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const X_ME_URL: &str =
    "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url";
const X_POST_TWEET_URL: &str = "https://api.x.com/2/tweets";
const META_AUTHORIZE_URL: &str = "https://www.facebook.com/v23.0/dialog/oauth";
const META_TOKEN_URL: &str = "https://graph.facebook.com/v23.0/oauth/access_token";
const META_GRAPH_BASE: &str = "https://graph.facebook.com/v23.0";
const META_PAGE_WEBHOOK_FIELDS: &str =
    "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads";
const META_PAGE_WEBHOOK_SUBSCRIPTION_VERSION: i32 = 2;
const INSTAGRAM_AUTHORIZE_URL: &str = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL: &str = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_LONG_LIVED_TOKEN_URL: &str = "https://graph.instagram.com/access_token";
const INSTAGRAM_GRAPH_BASE: &str = "https://graph.instagram.com/v23.0";
const LINKEDIN_AUTHORIZE_URL: &str = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL: &str = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL: &str = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_UGC_POSTS_URL: &str = "https://api.linkedin.com/v2/ugcPosts";

pub const X_STATE_COOKIE: &str = "kasitek_social_x_state";
pub const X_VERIFIER_COOKIE: &str = "kasitek_social_x_verifier";
pub const META_STATE_COOKIE: &str = "kasitek_social_meta_state";
pub const META_TARGET_COOKIE: &str = "kasitek_social_meta_target";
pub const INSTAGRAM_STATE_COOKIE: &str = "kasitek_social_instagram_state";
pub const LINKEDIN_STATE_COOKIE: &str = "kasitek_social_linkedin_state";

const SOCIAL_PLATFORMS: &[&str] = &[
    "FACEBOOK",
    "INSTAGRAM",
    "THREADS",
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

pub fn platform_capabilities(platform: &str) -> Value {
    match platform {
        "FACEBOOK" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": true,
            "supportsDMs": true,
            "supportsAnalytics": true,
            "supportsInbox": true,
            "supportsVariants": true,
        }),
        "INSTAGRAM" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": true,
            "supportsDMs": true,
            "supportsAnalytics": true,
            "supportsInbox": true,
            "supportsVariants": true,
        }),
        "THREADS" => json!({
            "canPublish": true,
            "supportsManualPublish": false,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": true,
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
        }),
        "X" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": true,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "WHATSAPP_STATUS" => json!({
            "canPublish": true,
            "supportsManualPublish": false,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": false,
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

fn merge_channel_metadata_with_capabilities(
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

pub fn create_x_oauth_state() -> XOAuthState {
    let verifier = generate_token(48);
    let state = generate_token(24);
    let challenge = sha256_base64_url(&verifier);

    XOAuthState {
        state,
        verifier,
        challenge,
    }
}

pub fn build_x_authorize_url(
    config: &AppConfig,
    state: &str,
    challenge: &str,
) -> Result<String, AppError> {
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

pub fn create_meta_oauth_state() -> String {
    cuid2::create_id().replace('-', "")
}

pub fn create_instagram_oauth_state() -> String {
    cuid2::create_id().replace('-', "")
}

pub fn build_linkedin_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/linkedin/callback",
        social_app_url(config)
    );
    let scope = "openid profile email w_member_social";
    Ok(format!(
        "{LINKEDIN_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(scope),
    ))
}

pub fn build_meta_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_META_APP_ID")?;
    let redirect_uri = format!("{}/api/social/oauth/meta/callback", social_app_url(config));
    let scope = std::env::var("AUTH_META_SCOPES").unwrap_or_else(|_| {
        [
            "pages_show_list",
            "pages_manage_metadata",
            "pages_read_engagement",
            "pages_manage_posts",
            "pages_messaging",
            "instagram_basic",
            "instagram_content_publish",
            "instagram_manage_messages",
        ]
        .join(",")
    });

    Ok(format!(
        "{META_AUTHORIZE_URL}?client_id={}&redirect_uri={}&state={}&response_type=code&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(&scope),
    ))
}

fn instagram_app_id() -> Result<String, AppError> {
    required_env("AUTH_INSTAGRAM_APP_ID").map_err(|_| {
        AppError::Internal(
            "AUTH_INSTAGRAM_APP_ID is required for direct Instagram Login; use the Instagram App ID from the Instagram API setup, not the Meta App ID".to_string(),
        )
    })
}

fn instagram_app_secret() -> Result<String, AppError> {
    required_env("AUTH_INSTAGRAM_APP_SECRET").map_err(|_| {
        AppError::Internal(
            "AUTH_INSTAGRAM_APP_SECRET is required for direct Instagram Login".to_string(),
        )
    })
}

pub fn build_instagram_authorize_url(
    config: &AppConfig,
    state: &str,
) -> Result<String, AppError> {
    let client_id = instagram_app_id()?;
    let redirect_uri = format!(
        "{}/api/social/oauth/instagram/callback",
        social_app_url(config)
    );
    let scope = std::env::var("AUTH_INSTAGRAM_SCOPES").unwrap_or_else(|_| {
        [
            "instagram_business_basic",
            "instagram_business_content_publish",
            "instagram_business_manage_messages",
            "instagram_business_manage_comments",
            "instagram_business_manage_insights",
        ]
        .join(",")
    });

    Ok(format!(
        "{INSTAGRAM_AUTHORIZE_URL}?force_reauth=true&client_id={}&redirect_uri={}&response_type=code&scope={}&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state),
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
        self.id
            .clone()
            .or_else(|| value_as_identifier(self.user_id.as_ref()))
    }
}

fn value_as_identifier(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

#[derive(Clone, serde::Deserialize)]
struct MetaPictureData {
    url: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
struct MetaPicture {
    data: Option<MetaPictureData>,
}

#[derive(Clone, serde::Deserialize)]
pub struct MetaInstagramAccount {
    id: String,
    username: Option<String>,
    name: Option<String>,
    profile_picture_url: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
pub struct MetaPageAccount {
    pub id: String,
    name: Option<String>,
    username: Option<String>,
    pub access_token: Option<String>,
    tasks: Option<Vec<String>>,
    picture: Option<MetaPicture>,
    connected_instagram_account: Option<MetaInstagramAccount>,
    instagram_business_account: Option<MetaInstagramAccount>,
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
        reqwest::Client::new()
            .post(INSTAGRAM_TOKEN_URL)
            .form(&[
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

pub async fn fetch_instagram_profile(
    access_token: &str,
) -> Result<InstagramProfile, AppError> {
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
            .form(&[(
                "subscribed_fields",
                "messages,messaging_postbacks,messaging_optins,message_reactions,comments,live_comments",
            )]),
        "Failed to subscribe the Instagram account to webhooks",
    )
    .await?;
    Ok(())
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

pub async fn subscribe_meta_page_webhooks(
    page_access_token: &str,
    page_id: &str,
) -> Result<(), AppError> {
    let _: Value = fetch_json(
        reqwest::Client::new()
            .post(format!("{META_GRAPH_BASE}/{page_id}/subscribed_apps"))
            .bearer_auth(page_access_token)
            .form(&[(
                "subscribed_fields",
                META_PAGE_WEBHOOK_FIELDS,
            )]),
        "Failed to subscribe the Meta Page to messaging webhooks",
    )
    .await?;
    Ok(())
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

pub async fn upsert_meta_connections_for_org(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    user_tokens: &MetaTokenResponse,
    pages: &[MetaPageAccount],
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
            "assetType": "facebook_page",
            "pageId": page.id,
            "username": page.username,
            "pictureUrl": page.picture.as_ref().and_then(|picture| picture.data.as_ref()).and_then(|data| data.url.clone()),
            "tasks": page.tasks.clone().unwrap_or_default(),
            "userTokenExpiresAt": user_token_expires_at,
            "tokenType": user_tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
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
                "assetType": "instagram_professional_account",
                "instagramAccountId": instagram.id,
                "pageId": page.id,
                "pageName": page.name,
                "profilePictureUrl": instagram.profile_picture_url,
                "userTokenExpiresAt": user_token_expires_at,
                "tokenType": user_tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
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
        "username": profile.username,
        "profilePictureUrl": profile.profile_picture_url,
        "accountType": profile.account_type,
        "followersCount": profile.followers_count,
        "followsCount": profile.follows_count,
        "mediaCount": profile.media_count,
        "permissions": permissions,
        "tokenType": tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
        "tokenExpiresAt": expires_at,
    });

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
    .execute(pool)
    .await?;

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
    .bind(profile.name.clone().or(profile.username.clone()).unwrap_or_else(|| "X account".to_string()))
    .bind(profile.username.as_ref().map(|username| format!("@{username}")))
    .bind(&profile.id)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(merge_channel_metadata_with_capabilities("X", Some(json!({
        "provider": "x",
        "tokenType": tokens.token_type.clone().unwrap_or_else(|| "bearer".to_string()),
        "scope": tokens.scope.clone().unwrap_or_else(|| "tweet.read tweet.write users.read offline.access".to_string()),
        "expiresAt": expires_at,
        "avatarUrl": profile.profile_image_url,
    }))))
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
            "scope": tokens.scope.clone().unwrap_or_else(|| "openid profile email w_member_social".to_string()),
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

async fn get_social_channel_by_external_account(
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

pub async fn list_social_channels(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<SocialChannel>, AppError> {
    sqlx::query_as::<_, SocialChannel>(
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
    .map_err(AppError::from)
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

    let created = sqlx::query_as::<_, SocialChannel>(
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
    .await?;

    Ok(created)
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
                id, "userId", "orgId", "postId", "variantId", platform, status, "scheduledFor", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, CAST($6 AS "SocialPlatform"),
                CAST($7 AS "SocialPublishJobStatus"), $8, NOW(), NOW()
            )
            "#,
        )
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(org_id)
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
    org_id: &str,
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
    let variants = normalize_variants(&request.variants, &channels, &content);
    let post_id = cuid2::create_id();

    let mut tx = pool.begin().await?;

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
    .bind(&request.metadata)
    .execute(tx.as_mut())
    .await?;

    create_variants_and_jobs(
        &mut tx,
        user_id,
        org_id,
        &post_id,
        &variants,
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

async fn publish_post_to_x(
    access_token_encrypted: &str,
    text: &str,
) -> Result<(String, String), AppError> {
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
        .or_else(|| {
            external_account_id
                .as_ref()
                .map(|value| format!("urn:li:person:{value}"))
        })
        .ok_or_else(|| {
            AppError::BadRequest("LinkedIn connection is missing a member identifier".to_string())
        })?;

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
        .or_else(|| {
            payload
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });
    Ok((external_post_id, text.to_string()))
}

async fn publish_post_to_facebook(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    text: &str,
) -> Result<(String, String), AppError> {
    let page_id = external_account_id.as_deref().ok_or_else(|| {
        AppError::BadRequest("Facebook connection is missing a Page identifier".to_string())
    })?;
    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let result: Value = fetch_json(
        reqwest::Client::new()
            .post(format!("{META_GRAPH_BASE}/{page_id}/feed"))
            .bearer_auth(access_token)
            .form(&[("message", text.to_string())]),
        "Failed to publish to Facebook",
    )
    .await?;

    let id = result
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            AppError::BadRequest("Facebook publish did not return a post id".to_string())
        })?;
    Ok((id.to_string(), text.to_string()))
}

async fn publish_post_to_instagram(
    access_token_encrypted: &str,
    external_account_id: &Option<String>,
    connection_metadata: &Option<Value>,
    image_url: &str,
    caption: &str,
) -> Result<(String, String), AppError> {
    let account_id = external_account_id.as_deref().ok_or_else(|| {
        AppError::BadRequest("Instagram connection is missing an account identifier".to_string())
    })?;
    let parsed_image_url = reqwest::Url::parse(image_url)
        .map_err(|_| AppError::BadRequest("Instagram image URL is invalid".to_string()))?;
    if parsed_image_url.scheme() != "https" {
        return Err(AppError::BadRequest(
            "Instagram requires a public HTTPS image URL".to_string(),
        ));
    }

    let access_token = decrypt_social_secret(access_token_encrypted)?;
    let uses_instagram_login = connection_metadata
        .as_ref()
        .and_then(|value| value.get("authMethod"))
        .and_then(Value::as_str)
        == Some("instagram_login");
    let graph_base = if uses_instagram_login {
        INSTAGRAM_GRAPH_BASE
    } else {
        META_GRAPH_BASE
    };
    let client = reqwest::Client::new();
    let container: Value = fetch_json(
        client
            .post(format!("{graph_base}/{account_id}/media"))
            .bearer_auth(&access_token)
            .form(&[
                ("image_url", image_url.to_string()),
                ("caption", caption.to_string()),
            ]),
        "Failed to create the Instagram media container",
    )
    .await?;
    let creation_id = container
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::BadRequest(
                "Instagram did not return a media container identifier".to_string(),
            )
        })?;
    let published: Value = fetch_json(
        client
            .post(format!("{graph_base}/{account_id}/media_publish"))
            .bearer_auth(access_token)
            .form(&[("creation_id", creation_id)]),
        "Failed to publish the Instagram post",
    )
    .await?;
    let post_id = published
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::BadRequest("Instagram did not return a published media id".to_string())
        })?;
    Ok((post_id.to_string(), caption.to_string()))
}

async fn mark_job_failed(
    pool: &PgPool,
    job_id: &str,
    post_id: &str,
    message: &str,
) -> Result<(), AppError> {
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
        billing::require_capability(pool, org_id, billing::capabilities::CONTENT_PUBLISH).await?;
        billing::require_meter_available(pool, org_id, billing::meters::SOCIAL_PUBLISHES, 1)
            .await?;

        if job.platform == "FACEBOOK" {
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
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "Add a public HTTPS image URL before publishing to Instagram".to_string(),
                    )
                })?;
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
                image_url,
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
            return Err(AppError::BadRequest(
                "Threads publishing is planned but not wired yet.".to_string(),
            ));
        } else if job.platform == "X" {
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
