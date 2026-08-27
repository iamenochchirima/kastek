//! Shared transport and grant-issuing primitives for product-to-Analytics reporting gateways.
//!
//! Product services remain responsible for browser authentication and scope policy. This crate
//! only carries the narrow internal contract needed to resolve an Analytics scope, issue a
//! short-lived grant, and call the explicit reporting endpoints.

use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use chrono::{DateTime, Utc};
use jwt_simple::{
    algorithms::ECDSAP256KeyPairLike,
    prelude::{Claims, Duration as JwtDuration, ES256KeyPair},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const CATALOG_PATH: &str = "/v1/metrics/catalog";
pub const QUERY_PATH: &str = "/v1/reports/query";
pub const SCOPE_RESOLVE_PATH: &str = "/internal/reporting/scopes/resolve";
pub const REPORTING_AUDIENCE: &str = "kasitek-analytics-reporting";
pub const REPORTING_POLICY_VERSION: &str = "customer-reporting-v1";
pub const MAX_GRANT_SECONDS: u64 = 120;

/// Removes the Analytics database identifier before a reporting response crosses back to a
/// product API. Product consumers receive the source-owned external reference instead.
pub fn redact_scope_id(mut response: Value, scope_kind: &str, external_source_id: &str) -> Value {
    if let Value::Object(object) = &mut response {
        object.remove("scope_id");
        object.insert(
            "scope".to_string(),
            serde_json::json!({
                "kind": scope_kind,
                "externalId": external_source_id,
            }),
        );
    }
    response
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalType {
    User,
    ServiceIdentity,
    AgentInstallation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DescendantMode {
    None,
    All,
    Explicit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReportingGrantClaims {
    pub principal_type: PrincipalType,
    pub scope_id: i64,
    pub root_scope_id: i64,
    pub descendant_mode: DescendantMode,
    #[serde(default)]
    pub explicit_descendant_scope_ids: Vec<i64>,
    #[serde(default)]
    pub permissions: BTreeSet<String>,
    #[serde(default)]
    pub metric_keys: Vec<String>,
    #[serde(default)]
    pub dimension_keys: Vec<String>,
    pub policy_version: String,
    #[serde(default)]
    pub correlation_id: Option<String>,
}

pub struct ReportingGrantIssuer {
    key_pair: ES256KeyPair,
    issuer: String,
    audience: String,
    key_id: Option<String>,
    policy_version: String,
}

pub struct ReportingGrantInput {
    pub principal_id: String,
    pub scope_id: i64,
    pub root_scope_id: i64,
    pub descendant_mode: DescendantMode,
    pub permissions: BTreeSet<String>,
    pub metric_keys: Vec<String>,
    pub dimension_keys: Vec<String>,
    pub correlation_id: Option<String>,
}

impl ReportingGrantIssuer {
    pub fn from_pem(
        private_key_pem: &str,
        issuer: impl Into<String>,
        audience: impl Into<String>,
        key_id: Option<String>,
    ) -> Result<Self, ReportingClientError> {
        let issuer = issuer.into();
        let audience = audience.into();
        let key_id = key_id.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        if issuer.trim().is_empty() || audience.trim().is_empty() {
            return Err(ReportingClientError::Configuration(
                "reporting issuer and audience cannot be empty".to_string(),
            ));
        }
        let mut key_pair = ES256KeyPair::from_pem(private_key_pem).map_err(|error| {
            ReportingClientError::Configuration(format!("invalid reporting private key: {error}"))
        })?;
        if let Some(key_id) = key_id.as_deref() {
            key_pair = key_pair.with_key_id(key_id);
        }
        Ok(Self {
            key_pair,
            issuer,
            audience,
            key_id,
            policy_version: REPORTING_POLICY_VERSION.to_string(),
        })
    }

    pub fn issue(&self, input: ReportingGrantInput) -> Result<String, ReportingClientError> {
        if input.principal_id.trim().is_empty() || input.scope_id <= 0 || input.root_scope_id <= 0 {
            return Err(ReportingClientError::Configuration(
                "reporting scope IDs must be positive".to_string(),
            ));
        }
        if matches!(input.descendant_mode, DescendantMode::Explicit) {
            return Err(ReportingClientError::Configuration(
                "explicit descendant grants require a bounded scope list".to_string(),
            ));
        }
        let custom = ReportingGrantClaims {
            principal_type: PrincipalType::User,
            scope_id: input.scope_id,
            root_scope_id: input.root_scope_id,
            descendant_mode: input.descendant_mode,
            explicit_descendant_scope_ids: Vec::new(),
            permissions: input.permissions,
            metric_keys: input.metric_keys,
            dimension_keys: input.dimension_keys,
            policy_version: self.policy_version.clone(),
            correlation_id: input.correlation_id,
        };
        let claims = Claims::with_custom_claims(custom, JwtDuration::from_secs(MAX_GRANT_SECONDS))
            .with_issuer(&self.issuer)
            .with_audience(&self.audience)
            .with_subject(input.principal_id)
            .with_jwt_id(Uuid::new_v4().to_string());
        self.key_pair
            .sign(claims)
            .map_err(|error| ReportingClientError::Signing(error.to_string()))
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn audience(&self) -> &str {
        &self.audience
    }

    pub fn key_id(&self) -> Option<&str> {
        self.key_id.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScopeResolution {
    pub scope_id: i64,
    pub scope_kind: String,
    pub owning_source_service: String,
    pub external_source_id: String,
    pub root_scope_id: i64,
    pub parent_scope_id: Option<i64>,
    pub reporting_timezone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportQueryInput {
    pub range_start: DateTime<Utc>,
    pub range_end: DateTime<Utc>,
    pub timezone: String,
    #[serde(default)]
    pub interval: Option<String>,
    #[serde(default)]
    pub metrics: Vec<String>,
    #[serde(default)]
    pub metric_set: Option<String>,
    #[serde(default)]
    pub breakdowns: Vec<String>,
    #[serde(default)]
    pub filters: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub include_descendants: bool,
    #[serde(default)]
    pub comparison: Option<ComparisonRequest>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReportQueryRequest {
    pub reporting_scope_id: i64,
    pub range_start: DateTime<Utc>,
    pub range_end: DateTime<Utc>,
    pub timezone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    pub metrics: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_set: Option<String>,
    pub breakdowns: Vec<String>,
    pub filters: BTreeMap<String, Vec<String>>,
    pub include_descendants: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<ComparisonRequest>,
}

impl ReportQueryInput {
    pub fn with_scope(self, reporting_scope_id: i64) -> ReportQueryRequest {
        ReportQueryRequest {
            reporting_scope_id,
            range_start: self.range_start,
            range_end: self.range_end,
            timezone: self.timezone,
            interval: self.interval,
            metrics: self.metrics,
            metric_set: self.metric_set,
            breakdowns: self.breakdowns,
            filters: self.filters,
            include_descendants: self.include_descendants,
            comparison: self.comparison,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComparisonRequest {
    pub kind: String,
}

#[derive(Debug, Error)]
pub enum ReportingClientError {
    #[error("analytics reporting is not configured: {0}")]
    Configuration(String),
    #[error("analytics reporting grant signing failed: {0}")]
    Signing(String),
    #[error("analytics reporting request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("analytics reporting returned HTTP {status}: {body}")]
    Upstream { status: u16, body: String },
    #[error("analytics reporting returned an invalid response: {0}")]
    InvalidResponse(String),
}

#[derive(Clone)]
pub struct AnalyticsReportingClient {
    base_url: String,
    resolver_token: String,
    http: reqwest::Client,
}

impl AnalyticsReportingClient {
    pub fn new(
        base_url: impl Into<String>,
        resolver_token: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, ReportingClientError> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err(ReportingClientError::Configuration(
                "analytics reporting URL cannot be empty".to_string(),
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(ReportingClientError::Request)?;
        Ok(Self {
            base_url,
            resolver_token: resolver_token.into(),
            http,
        })
    }

    pub async fn resolve_scope(
        &self,
        source_service: &str,
        scope_kind: &str,
        external_source_id: &str,
    ) -> Result<ScopeResolution, ReportingClientError> {
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "reporting.resolve_scope",
            || async {
                let mut trace_headers = reqwest::header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.http
                    .get(self.endpoint(SCOPE_RESOLVE_PATH))
                    .bearer_auth(&self.resolver_token)
                    .header("x-source-service", source_service)
                    .headers(trace_headers)
                    .query(&[
                        ("scope_kind", scope_kind),
                        ("external_source_id", external_source_id),
                    ])
                    .send()
                    .await
            },
        )
        .await?;
        decode_json(response).await
    }

    pub async fn catalog(&self, grant: &str, scope_id: i64) -> Result<Value, ReportingClientError> {
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "reporting.catalog",
            || async {
                let mut trace_headers = reqwest::header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.http
                    .get(self.endpoint(CATALOG_PATH))
                    .bearer_auth(grant)
                    .headers(trace_headers)
                    .query(&[("reporting_scope_id", scope_id)])
                    .send()
                    .await
            },
        )
        .await?;
        decode_json(response).await
    }

    pub async fn report(
        &self,
        grant: &str,
        request: &ReportQueryRequest,
    ) -> Result<Value, ReportingClientError> {
        let response = observability::provider_result_span_with(
            "kasitek-analytics",
            "reporting.query",
            || async {
                let mut trace_headers = reqwest::header::HeaderMap::new();
                observability::inject_trace_context(&mut trace_headers);
                self.http
                    .post(self.endpoint(QUERY_PATH))
                    .bearer_auth(grant)
                    .headers(trace_headers)
                    .json(request)
                    .send()
                    .await
            },
        )
        .await?;
        decode_json(response).await
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

async fn decode_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, ReportingClientError> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(ReportingClientError::Upstream {
            status: status.as_u16(),
            body: if body.chars().count() > 500 {
                body.chars().take(500).collect()
            } else {
                body
            },
        });
    }
    serde_json::from_str(&body)
        .map_err(|error| ReportingClientError::InvalidResponse(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        redact_scope_id, DescendantMode, ReportingGrantInput, ReportingGrantIssuer,
        REPORTING_AUDIENCE, REPORTING_POLICY_VERSION,
    };
    use jwt_simple::{algorithms::ECDSAP256PublicKeyLike, prelude::Token};
    use std::collections::BTreeSet;

    #[test]
    fn issues_a_short_lived_grant_with_the_expected_claim_shape() {
        let key_pair = jwt_simple::prelude::ES256KeyPair::generate();
        let private_key = key_pair.to_pem().expect("private key");
        let issuer = ReportingGrantIssuer::from_pem(
            &private_key,
            "kasitek-core",
            REPORTING_AUDIENCE,
            Some("test-key".to_string()),
        )
        .expect("issuer");
        let token = issuer
            .issue(ReportingGrantInput {
                principal_id: "user-1".to_string(),
                scope_id: 42,
                root_scope_id: 42,
                descendant_mode: DescendantMode::None,
                permissions: BTreeSet::from(["analytics:read".to_string()]),
                metric_keys: Vec::new(),
                dimension_keys: Vec::new(),
                correlation_id: Some("correlation-1".to_string()),
            })
            .expect("token");
        assert_eq!(
            Token::decode_metadata(&token).unwrap().key_id(),
            Some("test-key")
        );
        let claims = key_pair
            .public_key()
            .verify_token::<super::ReportingGrantClaims>(&token, None)
            .expect("claims");
        assert_eq!(claims.custom.scope_id, 42);
        assert_eq!(claims.custom.root_scope_id, 42);
        assert_eq!(claims.custom.policy_version, REPORTING_POLICY_VERSION);
        assert!(claims.expires_at.is_some());
    }

    #[test]
    fn treats_a_blank_key_id_as_legacy_key_mode() {
        let key_pair = jwt_simple::prelude::ES256KeyPair::generate();
        let issuer = ReportingGrantIssuer::from_pem(
            &key_pair.to_pem().unwrap(),
            "kasitek-core",
            REPORTING_AUDIENCE,
            Some("   ".to_string()),
        )
        .unwrap();
        let token = issuer
            .issue(ReportingGrantInput {
                principal_id: "user-1".to_string(),
                scope_id: 1,
                root_scope_id: 1,
                descendant_mode: DescendantMode::None,
                permissions: BTreeSet::from(["analytics:read".to_string()]),
                metric_keys: vec![],
                dimension_keys: vec![],
                correlation_id: None,
            })
            .unwrap();
        assert_eq!(
            jwt_simple::prelude::Token::decode_metadata(&token)
                .unwrap()
                .key_id(),
            None
        );
    }

    #[test]
    fn rejects_invalid_scope_ids_and_unbounded_explicit_mode() {
        let key_pair = jwt_simple::prelude::ES256KeyPair::generate();
        let issuer = ReportingGrantIssuer::from_pem(
            &key_pair.to_pem().unwrap(),
            "kasitek-core",
            REPORTING_AUDIENCE,
            None,
        )
        .unwrap();
        let permissions = BTreeSet::from(["analytics:read".to_string()]);
        assert!(issuer
            .issue(ReportingGrantInput {
                principal_id: "user-1".to_string(),
                scope_id: 0,
                root_scope_id: 1,
                descendant_mode: DescendantMode::None,
                permissions: permissions.clone(),
                metric_keys: vec![],
                dimension_keys: vec![],
                correlation_id: None,
            })
            .is_err());
        assert!(issuer
            .issue(ReportingGrantInput {
                principal_id: "user-1".to_string(),
                scope_id: 1,
                root_scope_id: 1,
                descendant_mode: DescendantMode::Explicit,
                permissions,
                metric_keys: vec![],
                dimension_keys: vec![],
                correlation_id: None,
            })
            .is_err());
    }

    #[test]
    fn redacts_internal_scope_ids_at_the_product_boundary() {
        let response = redact_scope_id(
            serde_json::json!({"scope_id": 42, "metrics": []}),
            "core_organization",
            "org-1",
        );
        assert_eq!(response.get("scope_id"), None);
        assert_eq!(
            response
                .get("scope")
                .and_then(|scope| scope.get("externalId")),
            Some(&serde_json::json!("org-1"))
        );
    }
}
