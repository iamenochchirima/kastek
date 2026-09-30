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
