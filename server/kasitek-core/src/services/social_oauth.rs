use crypto_utils::{generate_token, sha256_base64_url};

use crate::config::AppConfig;
use crate::error::AppError;

use super::social::{required_env, social_app_url};

const X_AUTHORIZE_URL: &str = "https://twitter.com/i/oauth2/authorize";
const META_AUTHORIZE_URL: &str = "https://www.facebook.com/v23.0/dialog/oauth";
const INSTAGRAM_AUTHORIZE_URL: &str = "https://www.instagram.com/oauth/authorize";
const LINKEDIN_AUTHORIZE_URL: &str = "https://www.linkedin.com/oauth/v2/authorization";
const THREADS_AUTHORIZE_URL: &str = "https://www.threads.com/oauth/authorize";
const TIKTOK_AUTHORIZE_URL: &str = "https://www.tiktok.com/v2/auth/authorize/";

#[derive(Clone)]
pub struct XOAuthState {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
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

pub fn create_threads_oauth_state() -> String {
    cuid2::create_id().replace('-', "")
}

pub fn create_tiktok_oauth_state() -> String {
    cuid2::create_id().replace('-', "")
}

pub fn build_threads_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_THREADS_APP_ID")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/threads/callback",
        social_app_url(config)
    );
    let scope = std::env::var("AUTH_THREADS_SCOPES")
        .unwrap_or_else(|_| "threads_basic,threads_content_publish".to_string());
    Ok(format!(
        "{THREADS_AUTHORIZE_URL}?client_id={}&redirect_uri={}&scope={}&response_type=code&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state)
    ))
}

pub fn build_tiktok_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_key = required_env("AUTH_TIKTOK_CLIENT_KEY")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/tiktok/callback",
        social_app_url(config)
    );
    let scope = std::env::var("AUTH_TIKTOK_SCOPES")
        .unwrap_or_else(|_| "user.info.basic,video.publish".to_string());
    Ok(format!(
        "{TIKTOK_AUTHORIZE_URL}?client_key={}&redirect_uri={}&scope={}&response_type=code&state={}",
        urlencoding::encode(&client_key),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state)
    ))
}

pub fn build_linkedin_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/linkedin/callback",
        social_app_url(config)
    );
    let scope = std::env::var("AUTH_LINKEDIN_SCOPES")
        .unwrap_or_else(|_| "openid profile email w_member_social".to_string());
    Ok(format!(
        "{LINKEDIN_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(&scope),
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

pub(crate) fn instagram_app_id() -> Result<String, AppError> {
    required_env("AUTH_INSTAGRAM_APP_ID").map_err(|_| {
        AppError::Internal(
            "AUTH_INSTAGRAM_APP_ID is required for direct Instagram Login; use the Instagram App ID from the Instagram API setup, not the Meta App ID".to_string(),
        )
    })
}

pub(crate) fn instagram_app_secret() -> Result<String, AppError> {
    required_env("AUTH_INSTAGRAM_APP_SECRET").map_err(|_| {
        AppError::Internal(
            "AUTH_INSTAGRAM_APP_SECRET is required for direct Instagram Login".to_string(),
        )
    })
}

pub fn build_instagram_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
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

#[cfg(test)]
mod tests {
    use super::create_x_oauth_state;

    #[test]
    fn x_oauth_state_contains_distinct_pkce_material() {
        let state = create_x_oauth_state();

        assert!(!state.state.is_empty());
        assert!(!state.verifier.is_empty());
        assert!(!state.challenge.is_empty());
        assert_ne!(state.state, state.verifier);
        assert_ne!(state.verifier, state.challenge);
    }
}
