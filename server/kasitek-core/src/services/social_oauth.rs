use crypto_utils::{generate_token, sha256_base64_url};

use crate::config::AppConfig;
use crate::error::AppError;

use super::connection_permission_providers::adapter_for;
use super::connection_permissions::{instagram_scopes_for_request, meta_scopes_for_request};
use super::social::{required_env, social_app_url};

const X_AUTHORIZE_URL: &str = "https://twitter.com/i/oauth2/authorize";
const META_AUTHORIZE_URL: &str = "https://www.facebook.com/v23.0/dialog/oauth";
const INSTAGRAM_AUTHORIZE_URL: &str = "https://www.instagram.com/oauth/authorize";
const LINKEDIN_AUTHORIZE_URL: &str = "https://www.linkedin.com/oauth/v2/authorization";
const THREADS_AUTHORIZE_URL: &str = "https://www.threads.com/oauth/authorize";
const TIKTOK_AUTHORIZE_URL: &str = "https://www.tiktok.com/v2/auth/authorize/";

fn linkedin_scopes(configured_scopes: &str) -> String {
    let mut scopes = configured_scopes
        .split_whitespace()
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for required_scope in ["openid", "profile", "email", "w_member_social"] {
        if !scopes.iter().any(|scope| scope == required_scope) {
            scopes.push(required_scope.to_string());
        }
    }
    scopes.join(" ")
}

pub fn linkedin_organization_scopes_configured() -> bool {
    let configured_scopes = std::env::var("AUTH_LINKEDIN_SCOPES").unwrap_or_default();
    configured_scopes
        .split_whitespace()
        .any(|scope| matches!(scope, "r_organization_admin" | "w_organization_social"))
}

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
    build_x_authorize_url_for_request(config, state, challenge, &[])
}

pub fn build_x_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    challenge: &str,
    requested_capabilities: &[String],
) -> Result<String, AppError> {
    let client_id = required_env("AUTH_X_CLIENT_ID")?;
    let redirect_uri = format!("{}/api/social/oauth/x/callback", social_app_url(config));
    let scope = if requested_capabilities.is_empty() {
        std::env::var("AUTH_X_SCOPES")
            .unwrap_or_else(|_| "tweet.read tweet.write users.read offline.access".to_string())
    } else {
        let mut scopes = adapter_for("X", None, None).required_scopes(requested_capabilities, None);
        for baseline in ["tweet.read", "users.read", "offline.access"] {
            if !scopes.iter().any(|scope| scope == baseline) {
                scopes.push(baseline.to_string());
            }
        }
        scopes.join(" ")
    };
    Ok(format!(
        "{X_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
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
    build_threads_authorize_url_for_request(config, state, &[])
}

pub fn build_threads_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    requested_capabilities: &[String],
) -> Result<String, AppError> {
    let client_id = required_env("AUTH_THREADS_APP_ID")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/threads/callback",
        social_app_url(config)
    );
    let scope = threads_scopes_for_request(requested_capabilities).join(",");
    Ok(format!(
        "{THREADS_AUTHORIZE_URL}?client_id={}&redirect_uri={}&scope={}&response_type=code&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state)
    ))
}

pub(crate) fn threads_scopes_for_request(requested_capabilities: &[String]) -> Vec<String> {
    let mut scopes = if requested_capabilities.is_empty() {
        std::env::var("AUTH_THREADS_SCOPES")
            .unwrap_or_else(|_| "threads_basic,threads_content_publish".to_string())
            .split([',', ' '])
            .map(str::trim)
            .filter(|scope| !scope.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        adapter_for("THREADS", None, None).required_scopes(requested_capabilities, None)
    };
    if !requested_capabilities.is_empty() && !scopes.iter().any(|scope| scope == "threads_basic") {
        scopes.insert(0, "threads_basic".to_string());
    }
    scopes
}

pub fn build_tiktok_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    build_tiktok_authorize_url_for_request(config, state, &[])
}

pub(crate) fn tiktok_scopes_for_request(requested_capabilities: &[String]) -> Vec<String> {
    if requested_capabilities.is_empty() {
        return vec!["user.info.basic".to_string()];
    }

    let mut scopes =
        adapter_for("TIKTOK", None, None).required_scopes(requested_capabilities, None);
    if !scopes.iter().any(|scope| scope == "user.info.basic") {
        scopes.insert(0, "user.info.basic".to_string());
    }
    scopes
}

pub fn build_tiktok_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    requested_capabilities: &[String],
) -> Result<String, AppError> {
    let client_key = required_env("AUTH_TIKTOK_CLIENT_KEY")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/tiktok/callback",
        social_app_url(config)
    );
    let scope = tiktok_scopes_for_request(requested_capabilities).join(",");
    Ok(format!(
        "{TIKTOK_AUTHORIZE_URL}?client_key={}&redirect_uri={}&scope={}&response_type=code&state={}",
        urlencoding::encode(&client_key),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        urlencoding::encode(state)
    ))
}

pub fn build_linkedin_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    build_linkedin_authorize_url_for_request(config, state, &[], false)
}

pub fn build_linkedin_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    requested_capabilities: &[String],
    organization: bool,
) -> Result<String, AppError> {
    let client_id = required_env("AUTH_LINKEDIN_CLIENT_ID")?;
    let redirect_uri = format!(
        "{}/api/social/oauth/linkedin/callback",
        social_app_url(config)
    );
    let scope = if requested_capabilities.is_empty() {
        let configured_scopes = std::env::var("AUTH_LINKEDIN_SCOPES").unwrap_or_default();
        linkedin_scopes(&configured_scopes)
    } else {
        let adapter = if organization {
            adapter_for(
                "LINKEDIN",
                None,
                Some(&serde_json::json!({"accountType":"organization"})),
            )
        } else {
            adapter_for("LINKEDIN", None, None)
        };
        let mut scopes = adapter.required_scopes(requested_capabilities, None);
        for baseline in ["openid", "profile", "email"] {
            if !scopes.iter().any(|scope| scope == baseline) {
                scopes.insert(0, baseline.to_string());
            }
        }
        scopes.join(" ")
    };
    Ok(format!(
        "{LINKEDIN_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(&scope),
    ))
}

pub fn build_meta_authorize_url(config: &AppConfig, state: &str) -> Result<String, AppError> {
    build_meta_authorize_url_for_request(config, state, "facebook", &[])
}

pub fn build_meta_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    target: &str,
    requested_capabilities: &[String],
) -> Result<String, AppError> {
    let client_id = required_env("AUTH_META_APP_ID")?;
    let redirect_uri = format!("{}/api/social/oauth/meta/callback", social_app_url(config));
    let scope = if requested_capabilities.is_empty() {
        std::env::var("AUTH_META_SCOPES")
            .unwrap_or_else(|_| meta_scopes_for_request(target, &[]).join(","))
    } else {
        meta_scopes_for_request(target, requested_capabilities).join(",")
    };

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
    build_instagram_authorize_url_for_request(config, state, &[])
}

pub fn build_instagram_authorize_url_for_request(
    config: &AppConfig,
    state: &str,
    requested_capabilities: &[String],
) -> Result<String, AppError> {
    let client_id = instagram_app_id()?;
    let redirect_uri = format!(
        "{}/api/social/oauth/instagram/callback",
        social_app_url(config)
    );
    let scope = if requested_capabilities.is_empty() {
        std::env::var("AUTH_INSTAGRAM_SCOPES")
            .unwrap_or_else(|_| instagram_scopes_for_request(&[]).join(","))
    } else {
        instagram_scopes_for_request(requested_capabilities).join(",")
    };

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
    use super::{
        create_x_oauth_state, linkedin_scopes, threads_scopes_for_request,
        tiktok_scopes_for_request,
    };

    #[test]
    fn x_oauth_state_contains_distinct_pkce_material() {
        let state = create_x_oauth_state();

        assert!(!state.state.is_empty());
        assert!(!state.verifier.is_empty());
        assert!(!state.challenge.is_empty());
        assert_ne!(state.state, state.verifier);
        assert_ne!(state.verifier, state.challenge);
    }

    #[test]
    fn linkedin_oauth_defaults_to_member_scopes() {
        let scopes = linkedin_scopes("openid profile email w_member_social");

        assert!(!scopes.contains("r_organization_admin"));
        assert!(!scopes.contains("w_organization_social"));
        assert_eq!(scopes.matches("openid").count(), 1);
    }

    #[test]
    fn linkedin_oauth_preserves_explicit_organization_scopes() {
        let scopes = linkedin_scopes(
            "openid profile email w_member_social r_organization_admin w_organization_social",
        );

        assert!(scopes.contains("r_organization_admin"));
        assert!(scopes.contains("w_organization_social"));
    }

    #[test]
    fn threads_requested_capabilities_produce_a_scope_inventory() {
        let scopes = threads_scopes_for_request(&[
            "SOCIAL_PUBLISH".to_string(),
            "SOCIAL_POST_DELETE".to_string(),
        ]);

        assert_eq!(
            scopes,
            vec![
                "threads_basic".to_string(),
                "threads_content_publish".to_string(),
                "threads_delete".to_string()
            ]
        );
    }

    #[test]
    fn tiktok_initial_authorization_requests_only_the_login_baseline_scope() {
        assert_eq!(
            tiktok_scopes_for_request(&[]),
            vec!["user.info.basic".to_string()]
        );
    }

    #[test]
    fn tiktok_requested_capabilities_add_only_their_provider_scopes() {
        let scopes = tiktok_scopes_for_request(&[
            "SOCIAL_PUBLISH".to_string(),
            "MEDIA_PUBLISH".to_string(),
            "SOCIAL_ANALYTICS".to_string(),
        ]);

        assert_eq!(
            scopes,
            vec![
                "user.info.basic".to_string(),
                "video.publish".to_string(),
                "video.upload".to_string(),
                "user.info.stats".to_string(),
            ]
        );
    }
}
