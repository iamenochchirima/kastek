//! Server-side rollout and operational-control evaluation.
//!
//! The registry is Analytics-owned. It stores current state in PostgreSQL and records every
//! mutation in the existing immutable audit chain. Customer-facing controls fail closed when no
//! matching rule exists; operational controls remain available unless an explicit kill switch is
//! active. Callers never receive an authorization decision from browser state.

use std::{collections::HashSet, sync::Arc, time::Duration as StdDuration};

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use sqlx::{Postgres, Row, Transaction};
use thiserror::Error;

use crate::{
    config::{hex_sha256, AnalyticsConfig},
    ingestion::{AuthenticatedProducer, IngestionAuthenticator},
    metrics::{ProcessMetrics, RolloutCacheMetric},
};

pub const CONTROLS_PATH: &str = "/internal/rollouts/v1/controls";
pub const EVALUATE_PATH: &str = "/internal/rollouts/v1/evaluate";
pub const EXPIRE_PATH: &str = "/internal/rollouts/v1/expire";
const AUDIT_CHAIN: &str = "analytics.rollout_controls";
const AUDIT_POLICY_VERSION: &str = "analytics-rollout/v1";
const DECISION_CACHE_TTL_SECONDS: u64 = 15;
const DECISION_CACHE_OPERATION_TIMEOUT: StdDuration = StdDuration::from_millis(150);
const DECISION_CACHE_KEY_VERSION: u8 = 1;

const CONTROL_KEYS: &[&str] = &[
    "publish",
    "ingest",
    "project",
    "report",
    "ui",
    "agent_read",
    "export",
    "alerts",
    "scheduled_reports",
];

const CUSTOMER_CONTROL_KEYS: &[&str] = &[
    "report",
    "ui",
    "agent_read",
    "export",
    "alerts",
    "scheduled_reports",
];

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RolloutControlKind {
    #[default]
    Rollout,
    KillSwitch,
}

impl RolloutControlKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rollout => "rollout",
            Self::KillSwitch => "kill_switch",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Global,
    ProducerService,
    Domain,
    ReportingScope,
    Percentage,
}

impl TargetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::ProducerService => "producer_service",
            Self::Domain => "domain",
            Self::ReportingScope => "reporting_scope",
            Self::Percentage => "percentage",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RolloutTarget {
    pub kind: TargetKind,
    pub key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RolloutMutationRequest {
    pub control_key: String,
    #[serde(default)]
    pub control_kind: RolloutControlKind,
    pub target: RolloutTarget,
    pub enabled: bool,
    #[serde(default)]
    pub percentage_basis_points: Option<i32>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub issue_ref: Option<String>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolloutEvaluationQuery {
    pub control_key: String,
    #[serde(default)]
    pub control_kind: RolloutControlKind,
    #[serde(default)]
    pub source_service: Option<String>,
    #[serde(default)]
    pub source_domain: Option<String>,
    #[serde(default)]
    pub reporting_scope_id: Option<i64>,
    #[serde(default)]
    pub cohort_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct EvaluationContext {
    pub source_service: Option<String>,
    pub source_domain: Option<String>,
    pub reporting_scope_id: Option<i64>,
    pub cohort_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RolloutDecision {
    pub control_key: String,
    pub control_kind: RolloutControlKind,
    pub registry_revision: i64,
    pub allowed: bool,
    pub defaulted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_target_kind: Option<TargetKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_target_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RolloutMutationResponse {
    pub control_id: i64,
    pub control_key: String,
    pub control_kind: RolloutControlKind,
    pub target: RolloutTarget,
    pub enabled: bool,
    pub removed: bool,
    pub revision: i64,
    pub registry_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExpiryClosureResponse {
    pub closed_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<i64>,
}

#[derive(Debug, Error)]
pub enum RolloutError {
    #[error("rollout authentication failed")]
    Unauthorized,
    #[error("invalid rollout request: {0}")]
    InvalidRequest(String),
    #[error("rollout database failed: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Clone, Debug)]
pub struct RolloutAuthenticator {
    ingestion: IngestionAuthenticator,
    allowed_producers: HashSet<String>,
}

impl RolloutAuthenticator {
    pub fn from_config(config: &AnalyticsConfig) -> Self {
        Self {
            ingestion: IngestionAuthenticator::from_config(config),
            allowed_producers: config.rollout_admin_producers.iter().cloned().collect(),
        }
    }

    fn authenticate(&self, request: &HttpRequest) -> Result<AuthenticatedProducer, RolloutError> {
        let actor = self
            .ingestion
            .authenticate(request)
            .map_err(|_| RolloutError::Unauthorized)?;
        if self.allowed_producers.contains(&actor.producer_id) {
            Ok(actor)
        } else {
            Err(RolloutError::Unauthorized)
        }
    }
}

#[derive(Clone)]
pub struct RolloutDecisionCache {
    backend: Option<Arc<dyn DecisionCacheBackend>>,
    ttl_seconds: u64,
}

#[derive(Debug)]
enum DecisionCacheRead {
    Disabled,
    Miss,
    Hit(RolloutDecision),
    Stale,
    Unavailable,
}

#[derive(Deserialize, Serialize)]
struct CachedDecision {
    cached_at: DateTime<Utc>,
    decision: RolloutDecision,
}

#[async_trait]
trait DecisionCacheBackend: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, String>;
    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), String>;
}

struct RedisDecisionCacheBackend {
    client: redis::Client,
    connection: tokio::sync::Mutex<Option<redis::aio::ConnectionManager>>,
}

impl RedisDecisionCacheBackend {
    fn new(client: redis::Client) -> Self {
        Self {
            client,
            connection: tokio::sync::Mutex::new(None),
        }
    }

    async fn connection(&self) -> Result<redis::aio::ConnectionManager, String> {
        if let Some(connection) = self.connection.lock().await.clone() {
            return Ok(connection);
        }
        let config = redis::aio::ConnectionManagerConfig::new()
            .set_number_of_retries(0)
            .set_connection_timeout(DECISION_CACHE_OPERATION_TIMEOUT)
            .set_response_timeout(DECISION_CACHE_OPERATION_TIMEOUT);
        let connection =
            redis::aio::ConnectionManager::new_with_config(self.client.clone(), config)
                .await
                .map_err(|error| error.to_string())?;
        *self.connection.lock().await = Some(connection.clone());
        Ok(connection)
    }

    async fn invalidate_connection(&self) {
        *self.connection.lock().await = None;
    }
}

#[async_trait]
impl DecisionCacheBackend for RedisDecisionCacheBackend {
    async fn get(&self, key: &str) -> Result<Option<String>, String> {
        let mut connection = self.connection().await?;
        let result = tokio::time::timeout(
            DECISION_CACHE_OPERATION_TIMEOUT,
            connection.get::<_, Option<String>>(key),
        )
        .await
        .map_err(|_| "redis rollout decision read timed out".to_string())?
        .map_err(|error| error.to_string());
        if result.is_err() {
            self.invalidate_connection().await;
        }
        result
    }

    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), String> {
        let mut connection = self.connection().await?;
        let result = tokio::time::timeout(
            DECISION_CACHE_OPERATION_TIMEOUT,
            connection.set_ex::<_, _, ()>(key, value, ttl_seconds),
        )
        .await
        .map_err(|_| "redis rollout decision write timed out".to_string())?
        .map_err(|error| error.to_string());
        if result.is_err() {
            self.invalidate_connection().await;
        }
        result
    }
}

impl RolloutDecisionCache {
    pub fn from_config(config: &AnalyticsConfig) -> Self {
        let backend = config.redis_url.as_deref().and_then(|url| {
            if url.trim().is_empty() {
                return None;
            }
            match redis::Client::open(url) {
                Ok(client) => Some(Arc::new(RedisDecisionCacheBackend::new(client))
                    as Arc<dyn DecisionCacheBackend>),
                Err(error) => {
                    observability::tracing::warn!(
                        event = "dependency.unavailable",
                        service = "kasitek-analytics",
                        process = "analytics-api",
                        dependency = "rollout_cache",
                        operation = "connect",
                        reason = "invalid_configuration",
                        error_type = %std::any::type_name_of_val(&error),
                        "rollout cache disabled"
                    );
                    None
                }
            }
        });
        Self {
            backend,
            ttl_seconds: DECISION_CACHE_TTL_SECONDS,
        }
    }

    pub fn disabled() -> Self {
        Self {
            backend: None,
            ttl_seconds: DECISION_CACHE_TTL_SECONDS,
        }
    }

    #[cfg(test)]
    fn from_backend(backend: Arc<dyn DecisionCacheBackend>) -> Self {
        Self {
            backend: Some(backend),
            ttl_seconds: DECISION_CACHE_TTL_SECONDS,
        }
    }

    async fn read(&self, key: &str, now: DateTime<Utc>) -> DecisionCacheRead {
        let Some(backend) = &self.backend else {
            return DecisionCacheRead::Disabled;
        };
        let serialized = match backend.get(key).await {
            Ok(Some(value)) => value,
            Ok(None) => return DecisionCacheRead::Miss,
            Err(error) => {
                observability::tracing::warn!(
                    event = "dependency.unavailable",
                    service = "kasitek-analytics",
                    process = "analytics-api",
                    dependency = "rollout_cache",
                    operation = "get",
                    error_type = %std::any::type_name_of_val(&error),
                    "rollout cache read failed"
                );
                return DecisionCacheRead::Unavailable;
            }
        };
        let cached = match serde_json::from_str::<CachedDecision>(&serialized) {
            Ok(cached) => cached,
            Err(error) => {
                observability::tracing::warn!(
                    event = "operation.failed",
                    service = "kasitek-analytics",
                    process = "analytics-api",
                    operation = "rollout_cache.decode",
                    error_type = %std::any::type_name_of_val(&error),
                    "rollout cache value could not be decoded"
                );
                return DecisionCacheRead::Unavailable;
            }
        };
        if cached.cached_at + chrono::Duration::seconds(self.ttl_seconds as i64) <= now
            || cached
                .decision
                .expires_at
                .is_some_and(|expires_at| expires_at <= now)
        {
            DecisionCacheRead::Stale
        } else {
            DecisionCacheRead::Hit(cached.decision)
        }
    }

    async fn write(&self, key: &str, decision: &RolloutDecision, now: DateTime<Utc>) {
        let Some(backend) = &self.backend else {
            return;
        };
        let ttl_seconds = cache_ttl_seconds(decision, now, self.ttl_seconds);
        if ttl_seconds == 0 {
            return;
        }
        let value = match serde_json::to_string(&CachedDecision {
            cached_at: now,
            decision: decision.clone(),
        }) {
            Ok(value) => value,
            Err(error) => {
                observability::tracing::warn!(
                    event = "operation.failed",
                    service = "kasitek-analytics",
                    process = "analytics-api",
                    operation = "rollout_cache.encode",
                    error_type = %std::any::type_name_of_val(&error),
                    "rollout cache value could not be encoded"
                );
                return;
            }
        };
        if let Err(error) = backend.set(key, &value, ttl_seconds).await {
            observability::tracing::warn!(
                event = "dependency.unavailable",
                service = "kasitek-analytics",
                process = "analytics-api",
                dependency = "rollout_cache",
                operation = "set",
                error_type = %std::any::type_name_of_val(&error),
                "rollout cache write failed"
            );
        }
    }
}

fn cache_ttl_seconds(decision: &RolloutDecision, now: DateTime<Utc>, maximum: u64) -> u64 {
    let decision_remaining = decision
        .expires_at
        .map(|expires_at| (expires_at - now).num_seconds().max(0) as u64)
        .unwrap_or(maximum);
    maximum.min(decision_remaining)
}

#[derive(Serialize)]
struct DecisionCacheKeyPayload<'a> {
    schema_version: u8,
    registry_revision: i64,
    control_key: &'a str,
    control_kind: RolloutControlKind,
    context: &'a EvaluationContext,
}

fn decision_cache_key(
    control_key: &str,
    control_kind: RolloutControlKind,
    context: &EvaluationContext,
    registry_revision: i64,
) -> String {
    let payload = DecisionCacheKeyPayload {
        schema_version: DECISION_CACHE_KEY_VERSION,
        registry_revision,
        control_key,
        control_kind,
        context,
    };
    let serialized = serde_json::to_vec(&payload).expect("decision cache key is serializable");
    format!(
        "kasitek:analytics:rollout:v{}:{}",
        DECISION_CACHE_KEY_VERSION,
        hex_sha256(&serialized)
    )
}

#[derive(Clone, Debug, Serialize)]
struct NormalizedMutation {
    control_key: String,
    control_kind: RolloutControlKind,
    target: RolloutTarget,
    enabled: bool,
    percentage_basis_points: Option<i32>,
    reason: String,
    issue_ref: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    remove: bool,
}

#[derive(Clone, Debug)]
struct StoredControl {
    control_id: i64,
    control_key: String,
    control_kind: RolloutControlKind,
    target_kind: TargetKind,
    target_key: String,
    enabled: bool,
    percentage_basis_points: Option<i32>,
    revision: i64,
    expires_at: Option<DateTime<Utc>>,
    removed_at: Option<DateTime<Utc>>,
}

impl StoredControl {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, RolloutError> {
        Ok(Self {
            control_id: row.try_get("control_id")?,
            control_key: row.try_get("control_key")?,
            control_kind: parse_control_kind(&row.try_get::<String, _>("control_kind")?)?,
            target_kind: parse_target_kind(&row.try_get::<String, _>("target_kind")?)?,
            target_key: row.try_get("target_key")?,
            enabled: row.try_get("enabled")?,
            percentage_basis_points: row.try_get("percentage_basis_points")?,
            revision: row.try_get("revision")?,
            expires_at: row.try_get("expires_at")?,
            removed_at: row.try_get("removed_at")?,
        })
    }

    fn value(&self) -> Value {
        json!({
            "control_id": self.control_id,
            "control_key": self.control_key,
            "control_kind": self.control_kind,
            "target": {
                "kind": self.target_kind,
                "key": self.target_key,
            },
            "enabled": self.enabled,
            "percentage_basis_points": self.percentage_basis_points,
            "revision": self.revision,
            "expires_at": self.expires_at,
            "removed_at": self.removed_at,
        })
    }
}

fn parse_control_kind(value: &str) -> Result<RolloutControlKind, RolloutError> {
    match value {
        "rollout" => Ok(RolloutControlKind::Rollout),
        "kill_switch" => Ok(RolloutControlKind::KillSwitch),
        _ => Err(RolloutError::InvalidRequest(
            "stored rollout control has an invalid kind".to_string(),
        )),
    }
}

fn parse_target_kind(value: &str) -> Result<TargetKind, RolloutError> {
    match value {
        "global" => Ok(TargetKind::Global),
        "producer_service" => Ok(TargetKind::ProducerService),
        "domain" => Ok(TargetKind::Domain),
        "reporting_scope" => Ok(TargetKind::ReportingScope),
        "percentage" => Ok(TargetKind::Percentage),
        _ => Err(RolloutError::InvalidRequest(
            "stored rollout control has an invalid target".to_string(),
        )),
    }
}

fn normalize_control_key(value: &str) -> Result<String, RolloutError> {
    let value = value.trim().to_ascii_lowercase();
    if CONTROL_KEYS.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(RolloutError::InvalidRequest(
            "unknown rollout control key".to_string(),
        ))
    }
}

fn normalize_text(value: &str, field: &str) -> Result<String, RolloutError> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Err(RolloutError::InvalidRequest(format!(
            "{field} cannot be empty"
        )));
    }
    Ok(value)
}

fn normalize_mutation(
    request: RolloutMutationRequest,
    now: DateTime<Utc>,
) -> Result<NormalizedMutation, RolloutError> {
    let control_key = normalize_control_key(&request.control_key)?;
    let target_key = match request.target.kind {
        TargetKind::Global => {
            if request.target.key.trim() != "global" {
                return Err(RolloutError::InvalidRequest(
                    "global targets must use the global key".to_string(),
                ));
            }
            "global".to_string()
        }
        TargetKind::ProducerService => normalize_text(&request.target.key, "producer service")?,
        TargetKind::Domain => normalize_text(&request.target.key, "domain")?,
        TargetKind::ReportingScope => {
            let scope_id = request
                .target
                .key
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    RolloutError::InvalidRequest(
                        "reporting scope targets require a positive numeric key".to_string(),
                    )
                })?;
            scope_id.to_string()
        }
        TargetKind::Percentage => normalize_text(&request.target.key, "percentage cohort")?,
    };
    if request.control_kind == RolloutControlKind::KillSwitch
        && request.target.kind == TargetKind::Percentage
    {
        return Err(RolloutError::InvalidRequest(
            "kill switches cannot target percentage cohorts".to_string(),
        ));
    }
    if request.target.kind == TargetKind::Percentage {
        if request
            .percentage_basis_points
            .is_none_or(|value| !(0..=10_000).contains(&value))
        {
            return Err(RolloutError::InvalidRequest(
                "percentage targets require 0 through 10000 basis points".to_string(),
            ));
        }
    } else if request.percentage_basis_points.is_some() {
        return Err(RolloutError::InvalidRequest(
            "percentage basis points require a percentage target".to_string(),
        ));
    }
    let reason = request.reason.trim().to_string();
    if reason.is_empty() {
        return Err(RolloutError::InvalidRequest(
            "rollout changes require a reason".to_string(),
        ));
    }
    let issue_ref = request
        .issue_ref
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if request
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return Err(RolloutError::InvalidRequest(
            "rollout expiry must be in the future".to_string(),
        ));
    }
    Ok(NormalizedMutation {
        control_key,
        control_kind: request.control_kind,
        target: RolloutTarget {
            kind: request.target.kind,
            key: target_key,
        },
        enabled: request.enabled,
        percentage_basis_points: request.percentage_basis_points,
        reason,
        issue_ref,
        expires_at: request.expires_at,
        remove: request.remove,
    })
}

fn normalized_context(context: &EvaluationContext) -> EvaluationContext {
    EvaluationContext {
        source_service: context
            .source_service
            .as_deref()
            .and_then(|value| normalize_text(value, "source service").ok()),
        source_domain: context
            .source_domain
            .as_deref()
            .and_then(|value| normalize_text(value, "source domain").ok()),
        reporting_scope_id: context.reporting_scope_id.filter(|value| *value > 0),
        cohort_key: context
            .cohort_key
            .as_deref()
            .and_then(|value| normalize_text(value, "cohort key").ok()),
    }
}

fn stable_cohort_enabled(
    control_key: &str,
    target_key: &str,
    cohort_key: &str,
    basis_points: i32,
) -> bool {
    let digest =
        sha2::Sha256::digest(format!("{control_key}\0{target_key}\0{cohort_key}").as_bytes());
    let bucket = u16::from_be_bytes([digest[0], digest[1]]) as i32 % 10_000;
    bucket < basis_points
}

fn target_rank(
    control: &StoredControl,
    control_key: &str,
    context: &EvaluationContext,
) -> Option<u8> {
    match control.target_kind {
        TargetKind::Global if control.target_key == "global" => Some(10),
        TargetKind::ProducerService
            if context.source_service.as_deref() == Some(control.target_key.as_str()) =>
        {
            Some(30)
        }
        TargetKind::Domain
            if context.source_domain.as_deref() == Some(control.target_key.as_str()) =>
        {
            Some(40)
        }
        TargetKind::ReportingScope
            if context.reporting_scope_id.map(|value| value.to_string())
                == Some(control.target_key.clone()) =>
        {
            Some(50)
        }
        TargetKind::Percentage
            if context.cohort_key.as_deref().is_some_and(|cohort_key| {
                stable_cohort_enabled(
                    control_key,
                    &control.target_key,
                    cohort_key,
                    control.percentage_basis_points.unwrap_or_default(),
                )
            }) =>
        {
            Some(20)
        }
        _ => None,
    }
}

fn default_allowed(control_key: &str, control_kind: RolloutControlKind) -> bool {
    match control_kind {
        RolloutControlKind::KillSwitch => true,
        RolloutControlKind::Rollout => !CUSTOMER_CONTROL_KEYS.contains(&control_key),
    }
}

fn evaluate_candidates(
    control_key: String,
    control_kind: RolloutControlKind,
    context: &EvaluationContext,
    candidates: impl IntoIterator<Item = StoredControl>,
) -> RolloutDecision {
    let context = normalized_context(context);
    let selected = candidates
        .into_iter()
        .filter(|control| control.removed_at.is_none())
        .filter_map(|control| {
            target_rank(&control, &control_key, &context).map(|rank| (rank, control))
        })
        .max_by(|(left_rank, left), (right_rank, right)| {
            (*left_rank, left.revision).cmp(&(*right_rank, right.revision))
        })
        .map(|(_, control)| control);

    match selected {
        Some(control) => RolloutDecision {
            control_key,
            control_kind,
            registry_revision: 0,
            allowed: match control_kind {
                RolloutControlKind::Rollout => control.enabled,
                RolloutControlKind::KillSwitch => !control.enabled,
            },
            defaulted: false,
            matched_target_kind: Some(control.target_kind),
            matched_target_key: Some(control.target_key),
            revision: Some(control.revision),
            expires_at: control.expires_at,
        },
        None => RolloutDecision {
            allowed: default_allowed(&control_key, control_kind),
            control_key,
            control_kind,
            registry_revision: 0,
            defaulted: true,
            matched_target_kind: None,
            matched_target_key: None,
            revision: None,
            expires_at: None,
        },
    }
}

async fn current_registry_revision(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<i64, RolloutError> {
    sqlx::query_scalar::<_, i64>(
        "SELECT revision FROM analytics.analytics_rollout_registry WHERE registry_name = 'default'",
    )
    .fetch_one(&mut **transaction)
    .await
    .map_err(RolloutError::Database)
}

async fn bump_registry_revision(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<i64, RolloutError> {
    sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO analytics.analytics_rollout_registry (registry_name, revision)
           VALUES ('default', 1)
           ON CONFLICT (registry_name)
           DO UPDATE SET revision = analytics.analytics_rollout_registry.revision + 1
           RETURNING revision"#,
    )
    .fetch_one(&mut **transaction)
    .await
    .map_err(RolloutError::Database)
}

struct RolloutAuditInput<'a> {
    principal_id: &'a str,
    reporting_scope_id: Option<i64>,
    operation: &'a str,
    request_hash: String,
    correlation_id: Option<&'a str>,
    policy_version: &'a str,
    safe_metadata: Value,
    occurred_at: DateTime<Utc>,
}

async fn append_rollout_audit(
    transaction: &mut Transaction<'_, Postgres>,
    input: RolloutAuditInput<'_>,
) -> Result<(), RolloutError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(AUDIT_CHAIN)
        .execute(&mut **transaction)
        .await?;
    let previous_record_hash = sqlx::query_scalar::<_, String>(
        "SELECT record_hash FROM analytics.analytics_audit_record WHERE chain_name = $1 ORDER BY chain_sequence DESC LIMIT 1",
    )
    .bind(AUDIT_CHAIN)
    .fetch_optional(&mut **transaction)
    .await?;
    let audit_hash_payload = json!({
        "chain_name": AUDIT_CHAIN,
        "previous_record_hash": previous_record_hash,
        "principal_type": "service",
        "principal_id": input.principal_id,
        "reporting_scope_id": input.reporting_scope_id,
        "permission": Value::Null,
        "operation": input.operation,
        "metric_keys": [],
        "request_hash": input.request_hash,
        "filter_hash": Value::Null,
        "outcome": "accepted",
        "correlation_id": input.correlation_id,
        "policy_version": input.policy_version,
        "safe_metadata": input.safe_metadata,
        "occurred_at": input.occurred_at,
        "created_at": input.occurred_at,
    });
    let record_hash = hex_sha256(
        &serde_json::to_vec(&audit_hash_payload).expect("audit hash payload is serializable"),
    );
    sqlx::query(
        r#"INSERT INTO analytics.analytics_audit_record (
             chain_name, previous_record_hash, record_hash, principal_type, principal_id,
             reporting_scope_id, operation, request_hash, outcome, correlation_id,
             policy_version, safe_metadata, occurred_at, created_at
           ) VALUES ($1,$2,$3,'service',$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12)"#,
    )
    .bind(AUDIT_CHAIN)
    .bind(previous_record_hash)
    .bind(record_hash)
    .bind(input.principal_id)
    .bind(input.reporting_scope_id)
    .bind(input.operation)
    .bind(input.request_hash)
    .bind(input.correlation_id)
    .bind(input.policy_version)
    .bind(input.safe_metadata)
    .bind(input.occurred_at)
    .bind(input.occurred_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub async fn evaluate_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    control_key: &str,
    control_kind: RolloutControlKind,
    context: &EvaluationContext,
    now: DateTime<Utc>,
) -> Result<RolloutDecision, RolloutError> {
    let control_key = normalize_control_key(control_key)?;
    let registry_revision = current_registry_revision(transaction).await?;
    let rows = sqlx::query(
        r#"SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,
                  percentage_basis_points, revision, expires_at, removed_at
           FROM analytics.analytics_rollout_control
           WHERE control_key = $1
             AND control_kind = $2
             AND removed_at IS NULL
             AND (expires_at IS NULL OR expires_at > $3)"#,
    )
    .bind(&control_key)
    .bind(control_kind.as_str())
    .bind(now)
    .fetch_all(&mut **transaction)
    .await?;
    let candidates = rows
        .iter()
        .map(StoredControl::from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let mut decision = evaluate_candidates(control_key, control_kind, context, candidates);
    decision.registry_revision = registry_revision;
    Ok(decision)
}

pub async fn upsert_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuthenticatedProducer,
    request: RolloutMutationRequest,
    now: DateTime<Utc>,
    correlation_id: Option<&str>,
) -> Result<RolloutMutationResponse, RolloutError> {
    let normalized = normalize_mutation(request, now)?;
    let previous = sqlx::query(
        r#"SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,
                  percentage_basis_points, revision, expires_at, removed_at
           FROM analytics.analytics_rollout_control
           WHERE control_key = $1 AND control_kind = $2 AND target_kind = $3 AND target_key = $4
           FOR UPDATE"#,
    )
    .bind(&normalized.control_key)
    .bind(normalized.control_kind.as_str())
    .bind(normalized.target.kind.as_str())
    .bind(&normalized.target.key)
    .fetch_optional(&mut **transaction)
    .await?
    .map(|row| StoredControl::from_row(&row))
    .transpose()?;
    let revision = previous.as_ref().map_or(1, |control| control.revision + 1);
    let removed_at = normalized.remove.then_some(now);
    let enabled = normalized.enabled && !normalized.remove;
    let control_id = if previous.is_some() {
        sqlx::query_scalar::<_, i64>(
            r#"UPDATE analytics.analytics_rollout_control
               SET enabled = $1, percentage_basis_points = $2, revision = $3,
                   actor_type = 'service', actor_id = $4, reason = $5, issue_ref = $6,
                   expires_at = $7, removed_at = $8
               WHERE control_key = $9 AND control_kind = $10 AND target_kind = $11 AND target_key = $12
               RETURNING control_id"#,
        )
        .bind(enabled)
        .bind(normalized.percentage_basis_points)
        .bind(revision)
        .bind(&actor.producer_id)
        .bind(&normalized.reason)
        .bind(&normalized.issue_ref)
        .bind(normalized.expires_at)
        .bind(removed_at)
        .bind(&normalized.control_key)
        .bind(normalized.control_kind.as_str())
        .bind(normalized.target.kind.as_str())
        .bind(&normalized.target.key)
        .fetch_one(&mut **transaction)
        .await?
    } else {
        sqlx::query_scalar::<_, i64>(
            r#"INSERT INTO analytics.analytics_rollout_control (
                 control_key, control_kind, target_kind, target_key, enabled,
                 percentage_basis_points, revision, actor_type, actor_id, reason, issue_ref,
                 expires_at, removed_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'service',$8,$9,$10,$11,$12)
               RETURNING control_id"#,
        )
        .bind(&normalized.control_key)
        .bind(normalized.control_kind.as_str())
        .bind(normalized.target.kind.as_str())
        .bind(&normalized.target.key)
        .bind(enabled)
        .bind(normalized.percentage_basis_points)
        .bind(revision)
        .bind(&actor.producer_id)
        .bind(&normalized.reason)
        .bind(&normalized.issue_ref)
        .bind(normalized.expires_at)
        .bind(removed_at)
        .fetch_one(&mut **transaction)
        .await?
    };

    let registry_revision = bump_registry_revision(transaction).await?;

    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(AUDIT_CHAIN)
        .execute(&mut **transaction)
        .await?;
    let previous_record_hash = sqlx::query_scalar::<_, String>(
        "SELECT record_hash FROM analytics.analytics_audit_record WHERE chain_name = $1 ORDER BY chain_sequence DESC LIMIT 1",
    )
    .bind(AUDIT_CHAIN)
    .fetch_optional(&mut **transaction)
    .await?;
    let previous_value = previous.as_ref().map_or(Value::Null, StoredControl::value);
    let principal_id = format!("{}:{}", actor.source_service, actor.producer_id);
    let reporting_scope_id = (normalized.target.kind == TargetKind::ReportingScope).then(|| {
        normalized
            .target
            .key
            .parse::<i64>()
            .expect("normalized scope key")
    });
    let safe_metadata = json!({
        "source_service": actor.source_service,
        "control_id": control_id,
        "registry_revision": registry_revision,
        "control_key": normalized.control_key,
        "control_kind": normalized.control_kind,
        "target": normalized.target,
        "enabled": enabled,
        "remove": normalized.remove,
        "percentage_basis_points": normalized.percentage_basis_points,
        "revision": revision,
        "reason": normalized.reason,
        "issue_ref": normalized.issue_ref,
        "expires_at": normalized.expires_at,
        "removed_at": removed_at,
        "previous_value": previous_value,
    });
    let request_hash = hex_sha256(
        &serde_json::to_vec(&normalized).expect("normalized rollout request is serializable"),
    );
    let audit_hash_payload = json!({
        "chain_name": AUDIT_CHAIN,
        "previous_record_hash": previous_record_hash,
        "principal_type": "service",
        "principal_id": principal_id,
        "reporting_scope_id": reporting_scope_id,
        "permission": Value::Null,
        "operation": "rollout_control.upsert",
        "metric_keys": [],
        "request_hash": request_hash,
        "filter_hash": Value::Null,
        "outcome": "accepted",
        "correlation_id": correlation_id,
        "policy_version": AUDIT_POLICY_VERSION,
        "safe_metadata": safe_metadata,
        "occurred_at": now,
        "created_at": now,
    });
    let record_hash = hex_sha256(
        &serde_json::to_vec(&audit_hash_payload).expect("audit hash payload is serializable"),
    );
    sqlx::query(
        r#"INSERT INTO analytics.analytics_audit_record (
             chain_name, previous_record_hash, record_hash, principal_type, principal_id,
             reporting_scope_id, operation, request_hash, outcome, correlation_id,
             policy_version, safe_metadata, occurred_at, created_at
           ) VALUES ($1,$2,$3,'service',$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12)"#,
    )
    .bind(AUDIT_CHAIN)
    .bind(previous_record_hash)
    .bind(record_hash)
    .bind(principal_id)
    .bind(reporting_scope_id)
    .bind("rollout_control.upsert")
    .bind(request_hash)
    .bind(correlation_id)
    .bind(AUDIT_POLICY_VERSION)
    .bind(safe_metadata)
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await?;

    Ok(RolloutMutationResponse {
        control_id,
        control_key: normalized.control_key,
        control_kind: normalized.control_kind,
        target: normalized.target,
        enabled,
        removed: normalized.remove,
        revision,
        registry_revision,
        expires_at: normalized.expires_at,
    })
}

pub async fn close_expired_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &AuthenticatedProducer,
    now: DateTime<Utc>,
    correlation_id: Option<&str>,
) -> Result<ExpiryClosureResponse, RolloutError> {
    let rows = sqlx::query(
        r#"SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,
                  percentage_basis_points, revision, expires_at, removed_at
           FROM analytics.analytics_rollout_control
           WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1
           ORDER BY control_id
           FOR UPDATE SKIP LOCKED"#,
    )
    .bind(now)
    .fetch_all(&mut **transaction)
    .await?;
    let mut closed_count = 0_u64;
    let mut registry_revision = None;
    for row in rows {
        let control = StoredControl::from_row(&row)?;
        let reporting_scope_id = (control.target_kind == TargetKind::ReportingScope).then(|| {
            control
                .target_key
                .parse::<i64>()
                .expect("normalized scope key")
        });
        sqlx::query(
            r#"UPDATE analytics.analytics_rollout_control
               SET enabled = FALSE, actor_type = 'service', actor_id = $1,
                   reason = 'expired automatically', issue_ref = NULL, removed_at = $2
               WHERE control_id = $3"#,
        )
        .bind(&actor.producer_id)
        .bind(now)
        .bind(control.control_id)
        .execute(&mut **transaction)
        .await?;
        let next_registry_revision = bump_registry_revision(transaction).await?;
        let safe_metadata = json!({
            "source_service": actor.source_service,
            "control_id": control.control_id,
            "registry_revision": next_registry_revision,
            "control_key": control.control_key,
            "control_kind": control.control_kind,
            "target": {
                "kind": control.target_kind,
                "key": control.target_key,
            },
            "enabled": false,
            "remove": true,
            "reason": "expired automatically",
            "expires_at": control.expires_at,
            "removed_at": now,
            "previous_value": control.value(),
        });
        let request_hash = hex_sha256(
            &serde_json::to_vec(&json!({
                "operation": "rollout_control.expire",
                "control_id": control.control_id,
                "removed_at": now,
            }))
            .expect("expiry request is serializable"),
        );
        let principal_id = format!("{}:{}", actor.source_service, actor.producer_id);
        append_rollout_audit(
            transaction,
            RolloutAuditInput {
                principal_id: &principal_id,
                reporting_scope_id,
                operation: "rollout_control.expire",
                request_hash,
                correlation_id,
                policy_version: AUDIT_POLICY_VERSION,
                safe_metadata,
                occurred_at: now,
            },
        )
        .await?;
        closed_count += 1;
        registry_revision = Some(next_registry_revision);
    }
    Ok(ExpiryClosureResponse {
        closed_count,
        registry_revision,
    })
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource(CONTROLS_PATH).route(web::post().to(upsert_handler)));
    cfg.service(web::resource(EVALUATE_PATH).route(web::get().to(evaluate_handler)));
    cfg.service(web::resource(EXPIRE_PATH).route(web::post().to(expire_handler)));
}

async fn upsert_handler(
    request: HttpRequest,
    body: web::Json<RolloutMutationRequest>,
    pool: web::Data<sqlx::PgPool>,
    access: web::Data<RolloutAuthenticator>,
) -> impl Responder {
    let actor = match access.authenticate(&request) {
        Ok(actor) => actor,
        Err(error) => return error_response(error),
    };
    let correlation_id = request
        .headers()
        .get("X-Correlation-ID")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 512);
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => return error_response(RolloutError::Database(error)),
    };
    let response = match upsert_transaction(
        &mut transaction,
        &actor,
        body.into_inner(),
        Utc::now(),
        correlation_id,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return error_response(error),
    };
    if let Err(error) = transaction.commit().await {
        return error_response(RolloutError::Database(error));
    }
    HttpResponse::Ok().json(response)
}

async fn expire_handler(
    request: HttpRequest,
    pool: web::Data<sqlx::PgPool>,
    access: web::Data<RolloutAuthenticator>,
    metrics: web::Data<ProcessMetrics>,
) -> impl Responder {
    let actor = match access.authenticate(&request) {
        Ok(actor) => actor,
        Err(error) => return error_response(error),
    };
    let correlation_id = request
        .headers()
        .get("X-Correlation-ID")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 512);
    let now = Utc::now();
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => return error_response(RolloutError::Database(error)),
    };
    let response =
        match close_expired_transaction(&mut transaction, &actor, now, correlation_id).await {
            Ok(response) => response,
            Err(error) => return error_response(error),
        };
    if let Err(error) = transaction.commit().await {
        return error_response(RolloutError::Database(error));
    }
    metrics.record_expired_controls_closed(response.closed_count);
    HttpResponse::Ok().json(response)
}

async fn evaluate_handler(
    request: HttpRequest,
    query: web::Query<RolloutEvaluationQuery>,
    pool: web::Data<sqlx::PgPool>,
    access: web::Data<RolloutAuthenticator>,
    cache: web::Data<RolloutDecisionCache>,
    metrics: web::Data<ProcessMetrics>,
) -> impl Responder {
    if let Err(error) = access.authenticate(&request) {
        return error_response(error);
    }
    let query = query.into_inner();
    let context = EvaluationContext {
        source_service: query.source_service,
        source_domain: query.source_domain,
        reporting_scope_id: query.reporting_scope_id,
        cohort_key: query.cohort_key,
    };
    let control_key = match normalize_control_key(&query.control_key) {
        Ok(control_key) => control_key,
        Err(error) => return error_response(error),
    };
    let now = Utc::now();
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => return error_response(RolloutError::Database(error)),
    };
    let registry_revision = match current_registry_revision(&mut transaction).await {
        Ok(revision) => revision,
        Err(error) => return error_response(error),
    };
    let cache_key = decision_cache_key(
        &control_key,
        query.control_kind,
        &context,
        registry_revision,
    );
    match cache.read(&cache_key, now).await {
        DecisionCacheRead::Hit(decision) if decision.registry_revision == registry_revision => {
            metrics.record_rollout_cache(RolloutCacheMetric::Hit);
            metrics.record_rollout_evaluation(decision.allowed, decision.defaulted);
            if let Err(error) = transaction.commit().await {
                return error_response(RolloutError::Database(error));
            }
            return HttpResponse::Ok().json(decision);
        }
        DecisionCacheRead::Hit(_) => metrics.record_rollout_cache(RolloutCacheMetric::Stale),
        DecisionCacheRead::Miss => metrics.record_rollout_cache(RolloutCacheMetric::Miss),
        DecisionCacheRead::Stale => metrics.record_rollout_cache(RolloutCacheMetric::Stale),
        DecisionCacheRead::Unavailable => {
            metrics.record_rollout_cache(RolloutCacheMetric::Unavailable)
        }
        DecisionCacheRead::Disabled => metrics.record_rollout_cache(RolloutCacheMetric::Disabled),
    }
    let decision = match evaluate_transaction(
        &mut transaction,
        &control_key,
        query.control_kind,
        &context,
        now,
    )
    .await
    {
        Ok(decision) => decision,
        Err(error) => return error_response(error),
    };
    metrics.record_rollout_evaluation(decision.allowed, decision.defaulted);
    if let Err(error) = transaction.commit().await {
        return error_response(RolloutError::Database(error));
    }
    cache.write(&cache_key, &decision, now).await;
    HttpResponse::Ok().json(decision)
}

fn error_response(error: RolloutError) -> HttpResponse {
    match error {
        RolloutError::Unauthorized => HttpResponse::Unauthorized()
            .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
            .json(json!({ "error": "unauthorized" })),
        RolloutError::InvalidRequest(message) => HttpResponse::UnprocessableEntity()
            .json(json!({ "error": "invalid_request", "message": message })),
        RolloutError::Database(error) => {
            observability::tracing::error!(
                event = "dependency.unavailable",
                service = "kasitek-analytics",
                process = "analytics-api",
                dependency = "postgres",
                operation = "rollout",
                error_type = %std::any::type_name_of_val(&error),
                "rollout database operation failed"
            );
            HttpResponse::ServiceUnavailable().json(json!({ "error": "analytics_unavailable" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use actix_web::test as actix_test;
    use chrono::Duration;
    use serde_json::json;

    use super::{
        decision_cache_key, evaluate_candidates, normalize_mutation, stable_cohort_enabled,
        EvaluationContext, RolloutAuthenticator, RolloutControlKind, RolloutDecision,
        RolloutDecisionCache, RolloutMutationRequest, RolloutTarget, StoredControl, TargetKind,
    };
    use crate::config::AnalyticsConfig;

    fn stored(
        control_key: &str,
        control_kind: RolloutControlKind,
        target_kind: TargetKind,
        target_key: &str,
        enabled: bool,
        revision: i64,
    ) -> StoredControl {
        StoredControl {
            control_id: revision,
            control_key: control_key.to_string(),
            control_kind,
            target_kind,
            target_key: target_key.to_string(),
            enabled,
            percentage_basis_points: (target_kind == TargetKind::Percentage).then_some(5_000),
            revision,
            expires_at: None,
            removed_at: None,
        }
    }

    #[test]
    fn customer_controls_default_closed_and_operational_controls_default_open() {
        let context = EvaluationContext::default();
        assert!(
            !evaluate_candidates(
                "report".to_string(),
                RolloutControlKind::Rollout,
                &context,
                Vec::<StoredControl>::new()
            )
            .allowed
        );
        assert!(
            evaluate_candidates(
                "project".to_string(),
                RolloutControlKind::Rollout,
                &context,
                Vec::<StoredControl>::new()
            )
            .allowed
        );
        assert!(
            evaluate_candidates(
                "publish".to_string(),
                RolloutControlKind::KillSwitch,
                &context,
                Vec::<StoredControl>::new()
            )
            .allowed
        );
    }

    #[test]
    fn scope_target_overrides_global_target() {
        let context = EvaluationContext {
            reporting_scope_id: Some(42),
            ..EvaluationContext::default()
        };
        let decision = evaluate_candidates(
            "ui".to_string(),
            RolloutControlKind::Rollout,
            &context,
            [
                stored(
                    "ui",
                    RolloutControlKind::Rollout,
                    TargetKind::Global,
                    "global",
                    true,
                    1,
                ),
                stored(
                    "ui",
                    RolloutControlKind::Rollout,
                    TargetKind::ReportingScope,
                    "42",
                    false,
                    2,
                ),
            ],
        );
        assert!(!decision.allowed);
        assert_eq!(
            decision.matched_target_kind,
            Some(TargetKind::ReportingScope)
        );
        assert_eq!(decision.revision, Some(2));
    }

    #[test]
    fn kill_switch_is_separate_from_rollout_enablement() {
        let context = EvaluationContext::default();
        let decision = evaluate_candidates(
            "publish".to_string(),
            RolloutControlKind::KillSwitch,
            &context,
            [stored(
                "publish",
                RolloutControlKind::KillSwitch,
                TargetKind::Global,
                "global",
                true,
                1,
            )],
        );
        assert!(!decision.allowed);
        assert!(!decision.defaulted);
    }

    #[test]
    fn percentage_cohort_hash_is_stable() {
        let first = stable_cohort_enabled("ui", "beta", "scope-42", 5_000);
        let second = stable_cohort_enabled("ui", "beta", "scope-42", 5_000);
        assert_eq!(first, second);
    }

    #[test]
    fn mutation_normalizes_targets_and_rejects_expired_changes() {
        let now = chrono::Utc::now();
        let request = RolloutMutationRequest {
            control_key: " UI ".to_string(),
            control_kind: RolloutControlKind::Rollout,
            target: RolloutTarget {
                kind: TargetKind::Domain,
                key: " Campaigns ".to_string(),
            },
            enabled: true,
            percentage_basis_points: None,
            reason: "enable staged reporting".to_string(),
            issue_ref: Some("INC-12".to_string()),
            expires_at: Some(now + Duration::hours(1)),
            remove: false,
        };
        let normalized = normalize_mutation(request, now).expect("normalized request");
        assert_eq!(normalized.control_key, "ui");
        assert_eq!(normalized.target.key, "campaigns");
        assert_eq!(normalized.issue_ref.as_deref(), Some("INC-12"));

        let expired = RolloutMutationRequest {
            expires_at: Some(now - Duration::seconds(1)),
            reason: "expired".to_string(),
            ..RolloutMutationRequest {
                control_key: "report".to_string(),
                control_kind: RolloutControlKind::Rollout,
                target: RolloutTarget {
                    kind: TargetKind::Global,
                    key: "global".to_string(),
                },
                enabled: true,
                percentage_basis_points: None,
                reason: "expired".to_string(),
                issue_ref: None,
                expires_at: None,
                remove: false,
            }
        };
        assert!(normalize_mutation(expired, now).is_err());
    }

    #[test]
    fn stored_value_is_safe_metadata_shape() {
        let value = stored(
            "ui",
            RolloutControlKind::Rollout,
            TargetKind::Global,
            "global",
            true,
            1,
        )
        .value();
        assert_eq!(value["target"]["key"], json!("global"));
        assert_eq!(value["revision"], json!(1));
    }

    #[derive(Default)]
    struct MemoryDecisionCache {
        values: tokio::sync::Mutex<HashMap<String, String>>,
    }

    #[async_trait::async_trait]
    impl super::DecisionCacheBackend for MemoryDecisionCache {
        async fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().await.get(key).cloned())
        }

        async fn set(&self, key: &str, value: &str, _ttl_seconds: u64) -> Result<(), String> {
            self.values
                .lock()
                .await
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
    }

    fn cached_decision(
        registry_revision: i64,
        expires_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> RolloutDecision {
        RolloutDecision {
            control_key: "ui".to_string(),
            control_kind: RolloutControlKind::Rollout,
            registry_revision,
            allowed: true,
            defaulted: false,
            matched_target_kind: Some(TargetKind::Global),
            matched_target_key: Some("global".to_string()),
            revision: Some(1),
            expires_at,
        }
    }

    #[tokio::test]
    async fn decision_cache_hits_and_separates_registry_revisions() {
        let backend = Arc::new(MemoryDecisionCache::default());
        let cache = RolloutDecisionCache::from_backend(backend);
        let context = EvaluationContext::default();
        let now = chrono::Utc::now();
        let key = decision_cache_key("ui", RolloutControlKind::Rollout, &context, 7);
        cache.write(&key, &cached_decision(7, None), now).await;
        let hit = cache.read(&key, now).await;
        assert!(matches!(hit, super::DecisionCacheRead::Hit(_)));

        let other_revision = decision_cache_key("ui", RolloutControlKind::Rollout, &context, 8);
        assert!(matches!(
            cache.read(&other_revision, now).await,
            super::DecisionCacheRead::Miss
        ));
    }

    #[tokio::test]
    async fn decision_cache_rejects_decisions_past_their_control_expiry() {
        let backend = Arc::new(MemoryDecisionCache::default());
        let cache = RolloutDecisionCache::from_backend(backend);
        let now = chrono::Utc::now();
        let key = decision_cache_key(
            "ui",
            RolloutControlKind::Rollout,
            &EvaluationContext::default(),
            1,
        );
        cache
            .write(
                &key,
                &cached_decision(1, Some(now + Duration::seconds(1))),
                now,
            )
            .await;
        assert!(matches!(
            cache.read(&key, now + Duration::seconds(2)).await,
            super::DecisionCacheRead::Stale
        ));
    }

    #[tokio::test]
    async fn disabled_decision_cache_is_non_authoritative() {
        let cache = RolloutDecisionCache::disabled();
        assert!(matches!(
            cache.read("unused", chrono::Utc::now()).await,
            super::DecisionCacheRead::Disabled
        ));
    }

    #[test]
    fn rollout_endpoints_require_an_allowlisted_authenticated_producer() {
        let config = AnalyticsConfig::from_lookup(|name| match name {
            "ANALYTICS_DATABASE_URL" => Some("postgres://localhost/analytics".to_string()),
            "ANALYTICS_INGESTION_CREDENTIALS_JSON" => Some(
                r#"[{"source_service":"core","producer_id":"rollout-admin","token":"secret"}]"#
                    .to_string(),
            ),
            "ANALYTICS_ROLLOUT_ADMIN_PRODUCERS" => Some("rollout-admin".to_string()),
            _ => None,
        })
        .expect("test config");
        let access = RolloutAuthenticator::from_config(&config);
        let request = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer secret"))
            .to_http_request();
        assert!(access.authenticate(&request).is_ok());

        let denied = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer other"))
            .to_http_request();
        assert!(access.authenticate(&denied).is_err());
    }
}
