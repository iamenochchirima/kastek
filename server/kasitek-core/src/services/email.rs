//! Workspace-owned email provider connections.
//!
//! OAuth credentials live here, encrypted at rest, and are projected into the
//! provider-neutral ExternalConnection inventory. Agents and Inbox keep only
//! bindings to that projection; neither surface creates a second credential.

use chrono::{DateTime, Duration, Utc};
use crypto_utils::{generate_token, sha256_base64_url};
use actix_web::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::{connections, social};

const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_PROFILE_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const MICROSOFT_AUTHORIZE_URL: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_PROFILE_URL: &str = "https://graph.microsoft.com/v1.0/me";

pub const GOOGLE_PROVIDER: &str = "GOOGLE";
pub const MICROSOFT_PROVIDER: &str = "MICROSOFT";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct EmailConnectionSummary {
    pub id: String,
    pub provider: String,
    #[serde(rename = "externalAccountId")]
    #[sqlx(rename = "external_account_id")]
    pub external_account_id: String,
    #[serde(rename = "emailAddress")]
    #[sqlx(rename = "email_address")]
    pub email_address: String,
    #[serde(rename = "displayName")]
    #[sqlx(rename = "display_name")]
    pub display_name: String,
    pub status: String,
    #[serde(rename = "healthStatus")]
    #[sqlx(rename = "health_status")]
    pub health_status: String,
    #[serde(rename = "syncStatus")]
    #[sqlx(rename = "sync_status")]
    pub sync_status: String,
    #[serde(rename = "lastSyncedAt")]
    #[sqlx(rename = "last_synced_at")]
    pub last_synced_at: Option<DateTime<Utc>>,
    #[serde(rename = "lastError")]
    #[sqlx(rename = "last_error")]
    pub last_error: Option<String>,
    pub scopes: Vec<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct OAuthState {
    pub id: String,
    #[sqlx(rename = "org_id")]
    pub org_id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    pub provider: String,
    #[sqlx(rename = "redirect_uri")]
    pub redirect_uri: String,
    #[sqlx(rename = "return_path")]
    pub return_path: String,
}

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub provider: &'static str,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub authorize_url: &'static str,
    pub token_url: &'static str,
    pub scopes: &'static [&'static str],
}

const GOOGLE_SCOPES: &[&str] = &[
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
];
const MICROSOFT_SCOPES: &[&str] = &[
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.Read",
    "Mail.Send",
];

pub fn provider_config(config: &AppConfig, provider: &str) -> Result<ProviderConfig, AppError> {
    match provider.to_ascii_lowercase().as_str() {
        "google" | "gmail" => Ok(ProviderConfig {
            provider: GOOGLE_PROVIDER,
            client_id: config
                .email_google_client_id
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Google email OAuth is not configured".to_string()))?,
            client_secret: config
                .email_google_client_secret
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Google email OAuth is not configured".to_string()))?,
            redirect_uri: config
                .email_google_redirect_uri
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Google email OAuth redirect is not configured".to_string()))?,
            authorize_url: GOOGLE_AUTHORIZE_URL,
            token_url: GOOGLE_TOKEN_URL,
            scopes: GOOGLE_SCOPES,
        }),
        "microsoft" | "outlook" => Ok(ProviderConfig {
            provider: MICROSOFT_PROVIDER,
            client_id: config
                .email_microsoft_client_id
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Microsoft email OAuth is not configured".to_string()))?,
            client_secret: config
                .email_microsoft_client_secret
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Microsoft email OAuth is not configured".to_string()))?,
            redirect_uri: config
                .email_microsoft_redirect_uri
                .clone()
                .ok_or_else(|| AppError::ServiceUnavailable("Microsoft email OAuth redirect is not configured".to_string()))?,
            authorize_url: MICROSOFT_AUTHORIZE_URL,
            token_url: MICROSOFT_TOKEN_URL,
            scopes: MICROSOFT_SCOPES,
        }),
        _ => Err(AppError::BadRequest(
            "Only Google and Microsoft email accounts are supported".to_string(),
        )),
    }
}

pub fn safe_return_path(value: Option<&str>) -> String {
    let value = value.unwrap_or("/inbox").trim();
    if value.starts_with('/') && !value.starts_with("//") && !value.contains("\\") {
        value.to_string()
    } else {
        "/inbox".to_string()
    }
}

pub async fn create_oauth_state(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    provider: &ProviderConfig,
    return_path: &str,
) -> Result<String, AppError> {
    let state = generate_token(48);
    let state_hash = sha256_base64_url(&state);
    sqlx::query(
        r#"INSERT INTO "EmailOAuthState" (
             "id", "orgId", "userId", "provider", "stateHash", "redirectUri", "returnPath", "expiresAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"#,
    )
    .bind(cuid2::create_id())
    .bind(org_id)
    .bind(user_id)
    .bind(provider.provider)
    .bind(&state_hash)
    .bind(&provider.redirect_uri)
    .bind(return_path)
    .bind(Utc::now() + Duration::minutes(10))
    .execute(pool)
    .await?;
    Ok(state)
}

pub async fn consume_oauth_state(
    pool: &PgPool,
    state: &str,
) -> Result<Option<OAuthState>, AppError> {
    let state_hash = sha256_base64_url(state);
    sqlx::query_as::<_, OAuthState>(
        r#"DELETE FROM "EmailOAuthState"
           WHERE "stateHash" = $1 AND "expiresAt" > NOW() AND "consumedAt" IS NULL
           RETURNING id, "orgId" AS org_id, "userId" AS user_id, provider,
                     "redirectUri" AS redirect_uri, "returnPath" AS return_path"#,
    )
    .bind(state_hash)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub fn authorization_url(provider: &ProviderConfig, state: &str) -> String {
    let scope = provider.scopes.join(" ");
    let mut params = vec![
        ("client_id", provider.client_id.as_str()),
        ("redirect_uri", provider.redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", scope.as_str()),
        ("state", state),
    ];
    if provider.provider == GOOGLE_PROVIDER {
        params.extend([
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "true"),
        ]);
    } else {
        params.push(("response_mode", "query"));
    }
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{}={}", urlencoding::encode(key), urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{}?{}", provider.authorize_url, query)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleProfile {
    sub: Option<String>,
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MicrosoftProfile {
    id: Option<String>,
    mail: Option<String>,
    user_principal_name: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Clone)]
struct ProviderProfile {
    external_account_id: String,
    email_address: String,
    display_name: String,
}

/// Store a provider token in the workspace-owned source of truth and refresh
/// the provider-neutral connection projection used by Inbox and Agents.
/// Callers must be trusted server boundaries; raw tokens never leave this
/// function or appear in the returned summary.
pub async fn upsert_connection_from_tokens(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    provider: &str,
    external_account_id: &str,
    email_address: &str,
    display_name: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    expires_at: Option<DateTime<Utc>>,
    scopes: &[String],
    source: &str,
) -> Result<EmailConnectionSummary, AppError> {
    let provider = normalize_provider(provider)?;
    if access_token.trim().is_empty() {
        return Err(AppError::BadRequest("Email access token is required".to_string()));
    }
    let encrypted_access = social::encrypt_social_secret(access_token)?;
    let encrypted_refresh = refresh_token
        .filter(|token| !token.trim().is_empty())
        .map(social::encrypt_social_secret)
        .transpose()?;
    let id = cuid2::create_id();
    sqlx::query(
        r#"INSERT INTO "EmailConnection" (
             "id", "orgId", "userId", "provider", "externalAccountId", "emailAddress", "displayName",
             "accessToken", "refreshToken", "tokenExpiresAt", "scopes", "status", "healthStatus", "syncStatus", "metadata", "updatedAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONNECTED','HEALTHY','READY',$12,NOW())
           ON CONFLICT ("orgId", "provider", "externalAccountId") DO UPDATE SET
             "userId" = EXCLUDED."userId", "emailAddress" = EXCLUDED."emailAddress", "displayName" = EXCLUDED."displayName",
             "accessToken" = EXCLUDED."accessToken", "refreshToken" = COALESCE(EXCLUDED."refreshToken", "EmailConnection"."refreshToken"),
             "tokenExpiresAt" = EXCLUDED."tokenExpiresAt", "scopes" = EXCLUDED."scopes", "status" = 'CONNECTED',
             "healthStatus" = 'HEALTHY', "syncStatus" = 'READY', "lastError" = NULL, "updatedAt" = NOW()
           RETURNING "id""#,
    )
    .bind(&id)
    .bind(org_id)
    .bind(user_id)
    .bind(provider)
    .bind(external_account_id)
    .bind(email_address)
    .bind(display_name)
    .bind(encrypted_access)
    .bind(encrypted_refresh)
    .bind(expires_at)
    .bind(scopes)
    .bind(serde_json::json!({ "provider": provider, "source": source }))
    .fetch_one(pool)
    .await?;

    connections::sync_org_connections(pool, org_id).await?;
    let connection = get_connection(pool, org_id, provider, external_account_id)
        .await?
        .ok_or_else(|| AppError::Internal("Email connection projection was not created".to_string()))?;
    observability::tracing::info!(
        event = "email.connection.upserted",
        operation = "email.connection.upsert",
        organization_id = %org_id,
        connection_id = %connection.id,
        provider = %connection.provider,
        source = %source,
        "workspace email connection upserted"
    );
    Ok(connection)
}

pub async fn finish_oauth(
    pool: &PgPool,
    config: &AppConfig,
    state: OAuthState,
    code: &str,
) -> Result<EmailConnectionSummary, AppError> {
    let provider = provider_config(config, &state.provider)?;
    if state.redirect_uri != provider.redirect_uri {
        return Err(AppError::BadRequest("Email OAuth redirect does not match the request".to_string()));
    }
    let token = reqwest::Client::new()
        .post(provider.token_url)
        .form(&[
            ("code", code),
            ("client_id", provider.client_id.as_str()),
            ("client_secret", provider.client_secret.as_str()),
            ("redirect_uri", provider.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|error| AppError::BadGateway(format!("Email token exchange failed: {error}")))?;
    let status = token.status();
    let body = token.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Upstream {
            code: "email_oauth_token_exchange_failed",
            message: "The email provider rejected the OAuth exchange".to_string(),
            status: if status.is_server_error() { StatusCode::BAD_GATEWAY } else { StatusCode::BAD_REQUEST },
        });
    }
    let token: TokenResponse = serde_json::from_str(&body)
        .map_err(|_| AppError::BadGateway("Email provider returned an invalid token response".to_string()))?;
    let access_token = token.access_token.ok_or_else(|| AppError::BadGateway("Email provider did not return an access token".to_string()))?;
    let profile = load_profile(&provider, &access_token).await?;
    let configured_scopes = provider.scopes.join(" ");
    let scopes = token
        .scope
        .as_deref()
        .unwrap_or(configured_scopes.as_str())
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let expires_at = token.expires_in.map(|seconds| Utc::now() + Duration::seconds(seconds.max(0)));
    upsert_connection_from_tokens(
        pool,
        &state.org_id,
        &state.user_id,
        provider.provider,
        &profile.external_account_id,
        &profile.email_address,
        &profile.display_name,
        &access_token,
        token.refresh_token.as_deref(),
        expires_at,
        &scopes,
        "workspace_email_oauth",
    )
    .await
}

async fn load_profile(provider: &ProviderConfig, access_token: &str) -> Result<ProviderProfile, AppError> {
    let response = reqwest::Client::new()
        .get(if provider.provider == GOOGLE_PROVIDER { GOOGLE_PROFILE_URL } else { MICROSOFT_PROFILE_URL })
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| AppError::BadGateway(format!("Email profile lookup failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::BadGateway("Email provider profile lookup failed".to_string()));
    }
    if provider.provider == GOOGLE_PROVIDER {
        let profile: GoogleProfile = serde_json::from_str(&body).map_err(|_| AppError::BadGateway("Invalid Google profile response".to_string()))?;
        let email = profile.email.ok_or_else(|| AppError::BadGateway("Google did not return an email address".to_string()))?;
        Ok(ProviderProfile { external_account_id: profile.sub.unwrap_or_else(|| email.clone()), email_address: email.clone(), display_name: profile.name.unwrap_or(email) })
    } else {
        let profile: MicrosoftProfile = serde_json::from_str(&body).map_err(|_| AppError::BadGateway("Invalid Microsoft profile response".to_string()))?;
        let email = profile.mail.or(profile.user_principal_name).ok_or_else(|| AppError::BadGateway("Microsoft did not return an email address".to_string()))?;
        Ok(ProviderProfile { external_account_id: profile.id.unwrap_or_else(|| email.clone()), email_address: email.clone(), display_name: profile.display_name.unwrap_or(email) })
    }
}

pub async fn list(pool: &PgPool, org_id: &str) -> Result<Vec<EmailConnectionSummary>, AppError> {
    sqlx::query_as::<_, EmailConnectionSummary>(
        r#"SELECT id, provider, "externalAccountId" AS external_account_id, "emailAddress" AS email_address,
                  "displayName" AS display_name, status, "healthStatus" AS health_status,
                  "syncStatus" AS sync_status, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  "lastError" AS last_error, scopes,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
           FROM "EmailConnection" WHERE "orgId" = $1 ORDER BY provider, "emailAddress""#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn get_connection(
    pool: &PgPool,
    org_id: &str,
    provider: &str,
    external_account_id: &str,
) -> Result<Option<EmailConnectionSummary>, AppError> {
    sqlx::query_as::<_, EmailConnectionSummary>(
        r#"SELECT id, provider, "externalAccountId" AS external_account_id, "emailAddress" AS email_address,
                  "displayName" AS display_name, status, "healthStatus" AS health_status,
                  "syncStatus" AS sync_status, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  "lastError" AS last_error, scopes,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
           FROM "EmailConnection"
           WHERE "orgId" = $1 AND provider = $2 AND "externalAccountId" = $3"#,
    )
    .bind(org_id)
    .bind(provider)
    .bind(external_account_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

/// Return one workspace email connection by its opaque canonical id. This is
/// used by trusted product boundaries when creating an agent or Inbox binding;
/// it never returns encrypted credentials.
pub async fn get_connection_by_id(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Option<EmailConnectionSummary>, AppError> {
    sqlx::query_as::<_, EmailConnectionSummary>(
        r#"SELECT id, provider, "externalAccountId" AS external_account_id, "emailAddress" AS email_address,
                  "displayName" AS display_name, status, "healthStatus" AS health_status,
                  "syncStatus" AS sync_status, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  "lastError" AS last_error, scopes,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
           FROM "EmailConnection"
           WHERE "orgId" = $1 AND id = $2"#,
    )
    .bind(org_id)
    .bind(connection_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub fn oauth_error_path(state: Option<&OAuthState>, code: &str) -> String {
    let path = state.map(|item| item.return_path.as_str()).unwrap_or("/inbox");
    let separator = if path.contains('?') { '&' } else { '?' };
    format!("{path}{separator}email=error&code={}", urlencoding::encode(code))
}

pub fn oauth_success_path(state: &OAuthState, provider: &str) -> String {
    let separator = if state.return_path.contains('?') { '&' } else { '?' };
    format!("{}{}email=connected&provider={}", state.return_path, separator, urlencoding::encode(provider))
}

pub fn frontend_redirect(config: &AppConfig, path: &str) -> String {
    format!("{}{}", config.frontend_url.trim_end_matches('/'), path)
}

pub fn normalize_provider(provider: &str) -> Result<&'static str, AppError> {
    match provider.to_ascii_lowercase().as_str() {
        "google" | "gmail" => Ok(GOOGLE_PROVIDER),
        "microsoft" | "outlook" => Ok(MICROSOFT_PROVIDER),
        _ => Err(AppError::BadRequest("Only Google and Microsoft email accounts are supported".to_string())),
    }
}

#[derive(Debug, Serialize)]
pub struct EmailProviderOption {
    pub id: &'static str,
    pub name: &'static str,
    pub status: &'static str,
    pub capabilities: &'static [&'static str],
}

pub fn provider_options() -> [EmailProviderOption; 3] {
    [
        EmailProviderOption { id: "google", name: "Google", status: "available", capabilities: &["read", "search", "reply"] },
        EmailProviderOption { id: "microsoft", name: "Microsoft", status: "available", capabilities: &["read", "search", "reply"] },
        EmailProviderOption { id: "custom", name: "Custom Email", status: "coming_soon", capabilities: &[] },
    ]
}

/// Small helper used by internal callers to make sure a request is not being
/// routed through a provider-specific account accidentally.
pub fn provider_for_connection(summary: &EmailConnectionSummary) -> &str {
    summary.provider.as_str()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailOperation {
    Search,
    Read,
    Send,
    Reply,
}

impl EmailOperation {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "search" => Ok(Self::Search),
            "read" => Ok(Self::Read),
            "send" => Ok(Self::Send),
            "reply" => Ok(Self::Reply),
            _ => Err(AppError::BadRequest("Unsupported email operation".to_string())),
        }
    }
}

#[derive(Debug, Clone, FromRow)]
struct EmailCredentialRow {
    id: String,
    provider: String,
    #[sqlx(rename = "email_address")]
    email_address: String,
    #[sqlx(rename = "access_token")]
    access_token: String,
    #[sqlx(rename = "refresh_token")]
    refresh_token: Option<String>,
    #[sqlx(rename = "token_expires_at")]
    token_expires_at: Option<DateTime<Utc>>,
}

async fn resolve_email_credential(
    pool: &PgPool,
    org_id: &str,
    provider: Option<&str>,
    account: Option<&str>,
) -> Result<EmailCredentialRow, AppError> {
    let provider = provider.map(|value| value.to_ascii_uppercase());
    let account = account.map(str::trim).filter(|value| !value.is_empty());
    let rows = sqlx::query_as::<_, EmailCredentialRow>(
        r#"SELECT id, provider, "emailAddress" AS email_address,
                  "accessToken" AS access_token, "refreshToken" AS refresh_token,
                  "tokenExpiresAt" AT TIME ZONE 'UTC' AS token_expires_at
           FROM "EmailConnection"
           WHERE "orgId" = $1 AND status = 'CONNECTED'
             AND ($2::text IS NULL OR provider = $2)
             AND ($3::text IS NULL OR lower("emailAddress") = lower($3) OR lower("displayName") = lower($3))
           ORDER BY provider, "emailAddress""#,
    )
    .bind(org_id)
    .bind(provider.as_deref())
    .bind(account)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [row] => Ok(row.clone()),
        [] => Err(AppError::NotFound("No connected email account matches the request".to_string())),
        _ => Err(AppError::Conflict("More than one email account matches; specify the provider or account".to_string())),
    }
}

async fn access_token(
    pool: &PgPool,
    config: &AppConfig,
    row: &EmailCredentialRow,
) -> Result<String, AppError> {
    let access = social::decrypt_social_secret(&row.access_token)?;
    let Some(expires_at) = row.token_expires_at else { return Ok(access); };
    if expires_at > Utc::now() + Duration::seconds(30) || row.refresh_token.is_none() {
        return Ok(access);
    }
    let refresh = social::decrypt_social_secret(row.refresh_token.as_deref().unwrap_or_default())?;
    let provider = provider_config(config, &row.provider)?;
    let mut form = vec![
        ("client_id", provider.client_id),
        ("client_secret", provider.client_secret),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh),
    ];
    if provider.provider == MICROSOFT_PROVIDER {
        form.push(("scope", provider.scopes.join(" ")));
    }
    let response = reqwest::Client::new().post(provider.token_url).form(&form).send().await.map_err(|error| AppError::BadGateway(format!("Email token refresh failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let token: TokenResponse = response.json().await.map_err(|_| AppError::BadGateway("Email provider returned an invalid refresh response".to_string()))?;
    let next_access = token.access_token.ok_or(AppError::Unauthorized)?;
    let encrypted_access = social::encrypt_social_secret(&next_access)?;
    let encrypted_refresh = token.refresh_token.as_deref().map(social::encrypt_social_secret).transpose()?;
    sqlx::query(r#"UPDATE "EmailConnection" SET "accessToken" = $1, "refreshToken" = COALESCE($2, "refreshToken"), "tokenExpiresAt" = $3, "updatedAt" = NOW() WHERE id = $4"#)
        .bind(encrypted_access)
        .bind(encrypted_refresh)
        .bind(token.expires_in.map(|seconds| Utc::now() + Duration::seconds(seconds.max(0))))
        .bind(&row.id)
        .execute(pool)
        .await?;
    Ok(next_access)
}

async fn provider_request(
    pool: &PgPool,
    config: &AppConfig,
    row: &EmailCredentialRow,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let token = access_token(pool, config, row).await?;
    let base = if row.provider == GOOGLE_PROVIDER { "https://gmail.googleapis.com/gmail/v1" } else { "https://graph.microsoft.com/v1.0" };
    let response = reqwest::Client::new()
        .request(method.clone(), format!("{base}{path}"))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .header("consistencylevel", "eventual");
    let request = if method == reqwest::Method::GET {
        response
    } else {
        response.json(&body.unwrap_or_else(|| serde_json::json!({})))
    };
    let response = request.send()
        .await
        .map_err(|error| AppError::BadGateway(format!("Email provider request failed: {error}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT { return Ok(serde_json::json!({})); }
    let payload = response.json::<Value>().await.unwrap_or_else(|_| serde_json::json!({}));
    if !status.is_success() {
        return Err(if status == reqwest::StatusCode::UNAUTHORIZED { AppError::Unauthorized } else { AppError::BadGateway("Email provider request failed".to_string()) });
    }
    Ok(payload)
}

pub async fn execute(
    pool: &PgPool,
    config: &AppConfig,
    org_id: &str,
    operation: EmailOperation,
    input: &Value,
) -> Result<Value, AppError> {
    let provider = input.get("provider").and_then(Value::as_str);
    let account = input.get("account").and_then(Value::as_str);
    let row = resolve_email_credential(pool, org_id, provider, account).await?;
    let provider_name = row.provider.to_ascii_lowercase();
    observability::tracing::info!(
        event = "email.operation.started",
        operation = "email.operation",
        organization_id = %org_id,
        connection_id = %row.id,
        provider = %provider_name,
        email_operation = ?operation,
        "workspace email operation started"
    );
    match (row.provider.as_str(), operation) {
        (GOOGLE_PROVIDER, EmailOperation::Search) => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(10).clamp(1, 50);
            let query = urlencoding::encode(query);
            let payload = provider_request(pool, config, &row, reqwest::Method::GET, &format!("/users/me/messages?q={query}&maxResults={limit}"), None).await?;
            Ok(serde_json::json!({"provider": provider_name, "account": row.email_address, "messages": payload.get("messages").cloned().unwrap_or_else(|| serde_json::json!([])), "nextPageToken": payload.get("nextPageToken")}))
        }
        (MICROSOFT_PROVIDER, EmailOperation::Search) => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("").replace('\'', "''");
            let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(10).clamp(1, 50);
            let payload = provider_request(pool, config, &row, reqwest::Method::GET, &format!("/me/messages?$top={limit}&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview&$filter=contains(subject,'{}')", urlencoding::encode(&query)), None).await?;
            Ok(serde_json::json!({"provider": provider_name, "account": row.email_address, "messages": payload.get("value").cloned().unwrap_or_else(|| serde_json::json!([])), "nextPageToken": Value::Null}))
        }
        (_, EmailOperation::Read) => {
            let message_id = input.get("messageId").and_then(Value::as_str).ok_or_else(|| AppError::BadRequest("messageId is required".to_string()))?;
            let path = if row.provider == GOOGLE_PROVIDER { format!("/users/me/messages/{}?format=full", urlencoding::encode(message_id)) } else { format!("/me/messages/{}?$select=id,conversationId,subject,from,toRecipients,body,receivedDateTime,isRead", urlencoding::encode(message_id)) };
            let payload = provider_request(pool, config, &row, reqwest::Method::GET, &path, None).await?;
            Ok(serde_json::json!({"provider": provider_name, "account": row.email_address, "message": payload}))
        }
        (_, EmailOperation::Send) | (_, EmailOperation::Reply) => {
            let body = input.get("body").and_then(Value::as_str).ok_or_else(|| AppError::BadRequest("body is required".to_string()))?;
            let subject = input.get("subject").and_then(Value::as_str).unwrap_or("");
            let recipients = input.get("to").cloned().unwrap_or_else(|| serde_json::json!([]));
            let payload = if row.provider == GOOGLE_PROVIDER {
                let recipients = recipients.as_array().map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default().join(", ");
                let raw = format!("To: {recipients}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}");
                provider_request(pool, config, &row, reqwest::Method::POST, "/users/me/messages/send", Some(serde_json::json!({"raw": base64_url(raw.as_bytes()), "threadId": input.get("threadId")}))).await?
            } else if operation == EmailOperation::Reply {
                let message_id = input.get("messageId").and_then(Value::as_str).ok_or_else(|| AppError::BadRequest("messageId is required".to_string()))?;
                provider_request(pool, config, &row, reqwest::Method::POST, &format!("/me/messages/{}/reply", urlencoding::encode(message_id)), Some(serde_json::json!({"comment": body}))).await?
            } else {
                let to = recipients.as_array().map(|items| items.iter().filter_map(Value::as_str).map(|address| serde_json::json!({"emailAddress": {"address": address}})).collect::<Vec<_>>()).unwrap_or_default();
                provider_request(pool, config, &row, reqwest::Method::POST, "/me/sendMail", Some(serde_json::json!({"message": {"subject": subject, "body": {"contentType": "Text", "content": body}, "toRecipients": to}, "saveToSentItems": true}))).await?
            };
            Ok(serde_json::json!({"provider": provider_name, "account": row.email_address, "status": "sent", "messageId": payload.get("id")}))
        }
        (_, EmailOperation::Search) => Err(AppError::BadRequest("Unsupported email provider".to_string())),
    }
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(bytes)
}
