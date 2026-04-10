use serde::{Deserialize, Serialize};
use std::env;
use thiserror::Error;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TenantServerConfig {
    pub port: u16,
    pub environment: String,
    pub database_url: String,
    pub database_max_connections: u32,
    pub allowed_origins: Vec<String>,
    pub app_base_url: Option<String>,
    pub default_workspace_slug: Option<String>,
    pub session_cookie_name: String,
    pub session_cookie_domain: Option<String>,
    pub session_cookie_secure: bool,
    pub session_ttl_hours: u32,
    pub client_session_cookie_name: String,
    pub client_session_ttl_hours: u32,
    pub invite_ttl_hours: u32,
}

impl TenantServerConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let port = env_optional("TENANT_SERVER_PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .or_else(|| env_optional("PORT").and_then(|value| value.parse::<u16>().ok()))
            .unwrap_or(8090);

        let environment = env_string_or("TENANT_SERVER_ENVIRONMENT", "development");

        let database_url = env_optional("TENANT_DATABASE_URL")
            .or_else(|| env_optional("DATABASE_URL"))
            .ok_or(ConfigError::MissingVar("TENANT_DATABASE_URL"))?;

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
        let default_workspace_slug = env_optional("TENANT_DEFAULT_WORKSPACE_SLUG");
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

        Ok(Self {
            port,
            environment,
            database_url,
            database_max_connections,
            allowed_origins,
            app_base_url,
            default_workspace_slug,
            session_cookie_name,
            session_cookie_domain,
            session_cookie_secure,
            session_ttl_hours,
            client_session_cookie_name,
            client_session_ttl_hours,
            invite_ttl_hours,
        })
    }

    pub fn is_production(&self) -> bool {
        self.environment.eq_ignore_ascii_case("production")
    }
}
