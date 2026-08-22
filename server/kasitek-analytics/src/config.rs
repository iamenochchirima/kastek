use std::{collections::HashSet, env};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnalyticsConfig {
    pub environment: String,
    pub api_host: String,
    pub api_port: u16,
    pub database_url: String,
    pub redis_url: Option<String>,
    pub metrics_token: Option<String>,
    pub ingestion_credentials: Vec<IngestionCredential>,
    pub database_max_connections: u32,
    pub database_acquire_timeout_ms: u64,
    pub database_connect_timeout_ms: u64,
    pub log_filter: String,
}

/// The analytics API keeps only a digest of each ingestion token in memory. The clear token is
/// supplied by the deployment environment and is never included in configuration debug output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IngestionCredential {
    pub source_service: String,
    pub producer_id: String,
    pub token_sha256: String,
}

#[derive(Debug, Deserialize)]
struct RawIngestionCredential {
    source_service: String,
    producer_id: String,
    token: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("missing environment variable: {0}")]
    Missing(&'static str),
    #[error("invalid value for {variable}: {value}")]
    Invalid {
        variable: &'static str,
        value: String,
    },
}

impl AnalyticsConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    pub(crate) fn from_lookup<F>(get: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let environment = non_empty_or(get("ANALYTICS_ENVIRONMENT"), "development");
        let api_host = non_empty_or(get("ANALYTICS_API_HOST"), "0.0.0.0");
        let api_port = parse_u16(
            "ANALYTICS_API_PORT",
            get("ANALYTICS_API_PORT").or_else(|| get("PORT")),
            4300,
        )?;
        let database_url = required(get("ANALYTICS_DATABASE_URL"), "ANALYTICS_DATABASE_URL")?;
        let redis_url = optional(get("ANALYTICS_REDIS_URL"));
        let metrics_token = optional(get("ANALYTICS_METRICS_TOKEN"));
        let ingestion_credentials =
            parse_ingestion_credentials(optional(get("ANALYTICS_INGESTION_CREDENTIALS_JSON")))?;
        let database_max_connections = parse_u32(
            "ANALYTICS_DATABASE_MAX_CONNECTIONS",
            get("ANALYTICS_DATABASE_MAX_CONNECTIONS"),
            10,
        )?;
        let database_acquire_timeout_ms = parse_u64(
            "ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS",
            get("ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS"),
            5_000,
        )?;
        let database_connect_timeout_ms = parse_u64(
            "ANALYTICS_DATABASE_CONNECT_TIMEOUT_MS",
            get("ANALYTICS_DATABASE_CONNECT_TIMEOUT_MS"),
            5_000,
        )?;
        let log_filter = non_empty_or(
            get("ANALYTICS_LOG_FILTER").or_else(|| get("RUST_LOG")),
            "info",
        );

        Ok(Self {
            environment,
            api_host,
            api_port,
            database_url,
            redis_url,
            metrics_token,
            ingestion_credentials,
            database_max_connections,
            database_acquire_timeout_ms,
            database_connect_timeout_ms,
            log_filter,
        })
    }
}

fn parse_ingestion_credentials(
    value: Option<String>,
) -> Result<Vec<IngestionCredential>, ConfigError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let parsed = serde_json::from_str::<Vec<RawIngestionCredential>>(&value).map_err(|_| {
        ConfigError::Invalid {
            variable: "ANALYTICS_INGESTION_CREDENTIALS_JSON",
            value: "invalid credential configuration".to_string(),
        }
    })?;
    let mut identities = HashSet::new();
    let mut token_digests = HashSet::new();
    let mut credentials = Vec::with_capacity(parsed.len());
    for raw in parsed {
        let source_service = raw.source_service.trim().to_string();
        let producer_id = raw.producer_id.trim().to_string();
        if !matches!(
            source_service.as_str(),
            "core" | "agent-platform" | "tenant-platform"
        ) || producer_id.is_empty()
            || raw.token.trim().is_empty()
            || !identities.insert((source_service.clone(), producer_id.clone()))
        {
            return Err(ConfigError::Invalid {
                variable: "ANALYTICS_INGESTION_CREDENTIALS_JSON",
                value: "invalid credential configuration".to_string(),
            });
        }
        let token_sha256 = hex_sha256(raw.token.trim().as_bytes());
        if !token_digests.insert(token_sha256.clone()) {
            return Err(ConfigError::Invalid {
                variable: "ANALYTICS_INGESTION_CREDENTIALS_JSON",
                value: "invalid credential configuration".to_string(),
            });
        }
        credentials.push(IngestionCredential {
            source_service,
            producer_id,
            token_sha256,
        });
    }
    Ok(credentials)
}

pub(crate) fn hex_sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn required(value: Option<String>, name: &'static str) -> Result<String, ConfigError> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::Missing(name))
}

fn non_empty_or(value: Option<String>, default: &str) -> String {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_u16(
    variable: &'static str,
    value: Option<String>,
    default: u16,
) -> Result<u16, ConfigError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(default);
    };
    value
        .parse::<u16>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ConfigError::Invalid { variable, value })
}

fn parse_u32(
    variable: &'static str,
    value: Option<String>,
    default: u32,
) -> Result<u32, ConfigError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(default);
    };
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ConfigError::Invalid { variable, value })
}

fn parse_u64(
    variable: &'static str,
    value: Option<String>,
    default: u64,
) -> Result<u64, ConfigError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(default);
    };
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ConfigError::Invalid { variable, value })
}

#[cfg(test)]
mod tests {
    use super::AnalyticsConfig;
    use std::collections::HashMap;

    fn config(values: &[(&str, &str)]) -> AnalyticsConfig {
        let values = values
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<HashMap<_, _>>();
        AnalyticsConfig::from_lookup(|name| values.get(name).cloned()).unwrap()
    }

    #[test]
    fn requires_the_dedicated_analytics_database_url() {
        let error = AnalyticsConfig::from_lookup(|_| None).unwrap_err();
        assert_eq!(error, super::ConfigError::Missing("ANALYTICS_DATABASE_URL"));
    }

    #[test]
    fn uses_analytics_defaults_without_reusing_database_url() {
        let config = config(&[("ANALYTICS_DATABASE_URL", "postgres://localhost/analytics")]);
        assert_eq!(config.environment, "development");
        assert_eq!(config.api_host, "0.0.0.0");
        assert_eq!(config.api_port, 4300);
        assert_eq!(config.redis_url, None);
        assert_eq!(config.metrics_token, None);
        assert!(config.ingestion_credentials.is_empty());
        assert_eq!(config.database_max_connections, 10);
        assert_eq!(config.database_acquire_timeout_ms, 5_000);
        assert_eq!(config.database_connect_timeout_ms, 5_000);
        assert_eq!(config.log_filter, "info");
    }

    #[test]
    fn analytics_port_takes_precedence_over_generic_port() {
        let config = config(&[
            ("ANALYTICS_DATABASE_URL", "postgres://localhost/analytics"),
            ("PORT", "4999"),
            ("ANALYTICS_API_PORT", "4301"),
        ]);
        assert_eq!(config.api_port, 4301);
    }

    #[test]
    fn preserves_the_optional_analytics_redis_boundary() {
        let config = config(&[
            ("ANALYTICS_DATABASE_URL", "postgres://localhost/analytics"),
            ("ANALYTICS_REDIS_URL", "redis://localhost/6379"),
        ]);
        assert_eq!(config.redis_url.as_deref(), Some("redis://localhost/6379"));
    }

    #[test]
    fn preserves_the_optional_metrics_token_boundary() {
        let config = config(&[
            ("ANALYTICS_DATABASE_URL", "postgres://localhost/analytics"),
            ("ANALYTICS_METRICS_TOKEN", "local-metrics-token"),
        ]);
        assert_eq!(config.metrics_token.as_deref(), Some("local-metrics-token"));
    }

    #[test]
    fn parses_ingestion_credentials_without_retaining_clear_tokens() {
        let config = config(&[
            ("ANALYTICS_DATABASE_URL", "postgres://localhost/analytics"),
            (
                "ANALYTICS_INGESTION_CREDENTIALS_JSON",
                r#"[{"source_service":"core","producer_id":"core-customer-analytics","token":"secret"}]"#,
            ),
        ]);
        assert_eq!(config.ingestion_credentials.len(), 1);
        assert_eq!(config.ingestion_credentials[0].source_service, "core");
        assert_eq!(
            config.ingestion_credentials[0].producer_id,
            "core-customer-analytics"
        );
        assert_eq!(
            config.ingestion_credentials[0].token_sha256,
            super::hex_sha256(b"secret")
        );
        assert!(!format!("{:?}", config).contains("secret"));
    }

    #[test]
    fn rejects_duplicate_or_invalid_ingestion_credentials() {
        let values = HashMap::from([
            (
                "ANALYTICS_DATABASE_URL".to_string(),
                "postgres://localhost/analytics".to_string(),
            ),
            (
                "ANALYTICS_INGESTION_CREDENTIALS_JSON".to_string(),
                "[{\"source_service\":\"core\",\"producer_id\":\"p\",\"token\":\"a\"},{\"source_service\":\"core\",\"producer_id\":\"p\",\"token\":\"b\"}]".to_string(),
            ),
        ]);
        assert!(matches!(
            AnalyticsConfig::from_lookup(|name| values.get(name).cloned()),
            Err(super::ConfigError::Invalid {
                variable: "ANALYTICS_INGESTION_CREDENTIALS_JSON",
                ..
            })
        ));
    }

    #[test]
    fn rejects_a_token_that_could_authenticate_two_source_identities() {
        let values = HashMap::from([
            (
                "ANALYTICS_DATABASE_URL".to_string(),
                "postgres://localhost/analytics".to_string(),
            ),
            (
                "ANALYTICS_INGESTION_CREDENTIALS_JSON".to_string(),
                "[{\"source_service\":\"core\",\"producer_id\":\"core\",\"token\":\"same\"},{\"source_service\":\"agent-platform\",\"producer_id\":\"agent\",\"token\":\"same\"}]".to_string(),
            ),
        ]);
        assert!(AnalyticsConfig::from_lookup(|name| values.get(name).cloned()).is_err());
    }

    #[test]
    fn rejects_non_positive_pool_configuration() {
        let values = HashMap::from([
            (
                "ANALYTICS_DATABASE_URL".to_string(),
                "postgres://localhost/analytics".to_string(),
            ),
            (
                "ANALYTICS_DATABASE_MAX_CONNECTIONS".to_string(),
                "0".to_string(),
            ),
        ]);
        let error = AnalyticsConfig::from_lookup(|name| values.get(name).cloned()).unwrap_err();
        assert_eq!(
            error,
            super::ConfigError::Invalid {
                variable: "ANALYTICS_DATABASE_MAX_CONNECTIONS",
                value: "0".to_string(),
            }
        );
    }
}
