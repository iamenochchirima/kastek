use serde::{Deserialize, Serialize};
use std::env;
use thiserror::Error;
use url::{Host, Url};

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing environment variable: {0}")]
    MissingVar(&'static str),
}

pub fn env_optional(name: &str) -> Option<String> {
    env::var(name).ok().map(|value| value.trim().to_string())
}

pub fn env_required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::MissingVar(name))
}

pub fn env_string_or(name: &str, default: &str) -> String {
    env_optional(name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub fn env_u16_or(name: &str, default: u16) -> u16 {
    env_optional(name)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default)
}

pub fn env_u32_or(name: &str, default: u32) -> u32 {
    env_optional(name)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
}

pub fn env_csv(name: &str) -> Vec<String> {
    env_optional(name)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub fn env_truthy(name: &str) -> bool {
    matches!(
        env_optional(name),
        Some(value) if matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
    )
}

/// Returns true for environment names intended to run only on a developer's
/// machine. Staging and other non-production environments remain explicit.
pub fn environment_allows_loopback_origins(environment: &str) -> bool {
    matches!(
        environment.trim().to_ascii_lowercase().as_str(),
        "development" | "dev" | "local" | "test"
    )
}

/// Converts an absolute HTTP(S) URL containing only an origin into the exact
/// serialized origin browsers send in the `Origin` header. A trailing slash is
/// accepted and removed; paths, credentials, queries, and fragments are
/// rejected so deployment mistakes fail during configuration instead of CORS.
pub fn normalize_http_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;

    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    Some(parsed.origin().ascii_serialization())
}

/// Validates a serialized browser origin and accepts only HTTP(S) loopback
/// hosts. Ports are intentionally unrestricted for local frontend tooling.
pub fn is_loopback_origin(origin: &str) -> bool {
    let Ok(origin) = Url::parse(origin) else {
        return false;
    };

    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return false;
    }

    match origin.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CookieSameSitePolicy {
    Lax,
    Strict,
    None,
}

impl CookieSameSitePolicy {
    pub fn from_env(name: &str, default: Self) -> Self {
        match env_optional(name)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "strict" => Self::Strict,
            "none" => Self::None,
            "lax" => Self::Lax,
            _ => default,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TenantServerConfig {
    pub port: u16,
    pub environment: String,
    pub database_url: String,
    pub database_max_connections: u32,
    pub allowed_origins: Vec<String>,
    pub cors_allow_credentials: bool,
    pub app_base_url: Option<String>,
    pub portal_host_target: Option<String>,
    pub platform_base_domain: Option<String>,
    pub default_workspace_slug: Option<String>,
    pub session_cookie_name: String,
    pub session_cookie_domain: Option<String>,
    pub session_cookie_secure: bool,
    pub session_cookie_same_site: CookieSameSitePolicy,
    pub session_ttl_hours: u32,
    pub client_session_cookie_name: String,
    pub client_session_ttl_hours: u32,
    pub invite_ttl_hours: u32,
    pub admin_secret: Option<String>,
    pub resend_api_key: Option<String>,
    pub resend_from_email: String,
    pub shared_email_domain: String,
}

impl TenantServerConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let port = env_optional("TENANT_SERVER_PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .or_else(|| env_optional("PORT").and_then(|value| value.parse::<u16>().ok()))
            .unwrap_or(8090);

        let environment = env_string_or("TENANT_SERVER_ENVIRONMENT", "development");

        let database_url = env_optional("KASITEK_TENANTS_DATABASE_URL")
            .or_else(|| env_optional("TENANT_DATABASE_URL"))
            .ok_or(ConfigError::MissingVar(
                "tenant database url (KASITEK_TENANTS_DATABASE_URL or TENANT_DATABASE_URL)",
            ))?;

        let database_max_connections = env_optional("TENANT_DATABASE_MAX_CONNECTIONS")
            .and_then(|value| value.parse::<u32>().ok())
            .or_else(|| {
                env_optional("DATABASE_MAX_CONNECTIONS").and_then(|value| value.parse::<u32>().ok())
            })
            .unwrap_or(10);

        let allowed_origins = {
            let values = env_csv("TENANT_ALLOWED_ORIGINS");
            if values.is_empty() {
                vec![
                    "http://localhost:3000".to_string(),
                    "http://localhost:3001".to_string(),
                ]
            } else {
                values
            }
        };

        let app_base_url = env_optional("TENANT_APP_BASE_URL");
        let portal_host_target = env_optional("TENANT_PORTAL_HOST_TARGET").or_else(|| {
            app_base_url.as_ref().and_then(|url| {
                let trimmed = url
                    .trim()
                    .trim_start_matches("http://")
                    .trim_start_matches("https://");
                let host = trimmed
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .split(':')
                    .next()
                    .unwrap_or("");
                if host.is_empty() {
                    None
                } else {
                    Some(host.to_ascii_lowercase())
                }
            })
        });
        let platform_base_domain = env_optional("TENANT_PLATFORM_BASE_DOMAIN")
            .map(|value| value.trim().trim_matches('.').to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let default_workspace_slug = env_optional("TENANT_DEFAULT_WORKSPACE_SLUG");
        let cors_allow_credentials = env_optional("TENANT_CORS_ALLOW_CREDENTIALS")
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(true);
        let session_cookie_name = env_string_or("TENANT_SESSION_COOKIE_NAME", "kasitenant.session");
        let session_cookie_domain = env_optional("TENANT_SESSION_COOKIE_DOMAIN");
        let session_cookie_secure = env_optional("TENANT_SESSION_COOKIE_SECURE")
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or_else(|| environment.eq_ignore_ascii_case("production"));
        let session_cookie_same_site = CookieSameSitePolicy::from_env(
            "TENANT_SESSION_COOKIE_SAME_SITE",
            CookieSameSitePolicy::Lax,
        );
        let session_ttl_hours = env_optional("TENANT_SESSION_TTL_HOURS")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(24 * 14);
        let client_session_cookie_name = env_string_or(
            "TENANT_CLIENT_SESSION_COOKIE_NAME",
            "kasitenant.client.session",
        );
        let client_session_ttl_hours = env_optional("TENANT_CLIENT_SESSION_TTL_HOURS")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(24 * 14);
        let invite_ttl_hours = env_optional("TENANT_INVITE_TTL_HOURS")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(24 * 7);

        let admin_secret = env_optional("TENANT_ADMIN_SECRET");
        let resend_api_key =
            env_optional("TENANT_RESEND_API_KEY").or_else(|| env_optional("AUTH_RESEND_KEY"));
        let resend_from_email = env_optional("TENANT_RESEND_FROM_EMAIL")
            .or_else(|| env_optional("RESEND_FROM_EMAIL"))
            .unwrap_or_else(|| "KasiTek <onboarding@resend.dev>".to_string());
        let shared_email_domain = env_string_or("TENANT_SHARED_EMAIL_DOMAIN", "send.kasitek.co.za")
            .trim()
            .trim_matches('.')
            .to_ascii_lowercase();

        Ok(Self {
            port,
            environment,
            database_url,
            database_max_connections,
            allowed_origins,
            cors_allow_credentials,
            app_base_url,
            portal_host_target,
            platform_base_domain,
            default_workspace_slug,
            session_cookie_name,
            session_cookie_domain,
            session_cookie_secure,
            session_cookie_same_site,
            session_ttl_hours,
            client_session_cookie_name,
            client_session_ttl_hours,
            invite_ttl_hours,
            admin_secret,
            resend_api_key,
            resend_from_email,
            shared_email_domain,
        })
    }

    pub fn is_production(&self) -> bool {
        self.environment.eq_ignore_ascii_case("production")
    }
}

#[cfg(test)]
mod tests {
    use super::{environment_allows_loopback_origins, is_loopback_origin, normalize_http_origin};

    #[test]
    fn local_environment_names_enable_loopback_origins() {
        for environment in ["development", "DEV", "local", "test"] {
            assert!(environment_allows_loopback_origins(environment));
        }

        for environment in ["production", "staging", "preview", ""] {
            assert!(!environment_allows_loopback_origins(environment));
        }
    }

    #[test]
    fn loopback_origins_accept_http_or_https_on_any_port() {
        for origin in [
            "http://localhost:3000",
            "http://localhost:5173",
            "https://localhost:8443",
            "http://127.0.0.1:4200",
            "http://127.10.20.30:8080",
            "http://[::1]:3000",
        ] {
            assert!(
                is_loopback_origin(origin),
                "expected {origin} to be allowed"
            );
        }
    }

    #[test]
    fn loopback_origin_validation_rejects_lookalikes_and_non_origins() {
        for origin in [
            "https://example.com",
            "https://localhost.example.com:3000",
            "https://example.com?next=localhost",
            "ftp://localhost:3000",
            "http://user@localhost:3000",
            "http://localhost:3000/path",
            "null",
            "not a url",
        ] {
            assert!(
                !is_loopback_origin(origin),
                "expected {origin} to be denied"
            );
        }
    }

    #[test]
    fn normalizes_browser_origins() {
        assert_eq!(
            normalize_http_origin("https://app.kasitek.co.za/"),
            Some("https://app.kasitek.co.za".to_string())
        );
        assert_eq!(
            normalize_http_origin("http://localhost:3000"),
            Some("http://localhost:3000".to_string())
        );
    }

    #[test]
    fn origin_normalization_rejects_non_origins() {
        for value in [
            "app.kasitek.co.za",
            "https://app.kasitek.co.za/login",
            "https://user@app.kasitek.co.za",
            "https://app.kasitek.co.za?source=test",
        ] {
            assert_eq!(normalize_http_origin(value), None, "accepted {value}");
        }
    }
}
