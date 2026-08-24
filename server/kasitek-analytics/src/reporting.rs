//! Customer reporting API and its authorization-safe query planner.
//!
//! Reporting is deliberately a read-only boundary over promoted projection generations. The
//! request is validated against the registry before SQL is assembled, and every database query
//! runs inside the grant's transaction-local RLS context. Redis response caching is optional and
//! non-authoritative; PostgreSQL remains the authorization and freshness source.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::Arc,
    time::Duration as StdDuration,
};

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use async_trait::async_trait;
use chrono::{DateTime, Duration, TimeZone, Utc};
use jwt_simple::{
    algorithms::{ECDSAP256PublicKeyLike, ES256PublicKey},
    claims::JWTClaims,
    common::VerificationOptions,
    token::Token,
};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use thiserror::Error;

use crate::{
    authorization::set_authorization_context_transaction,
    config::AnalyticsConfig,
    projections::{DEFAULT_SHARD_KEY, PROJECTION_NAME, PROJECTION_VERSION},
    registry::{DimensionDefinition, MetricDefinition, MetricSetDefinition, RegistrySnapshot},
    scope::{validate_grant, DescendantMode, PrincipalType, ReportingGrant},
};

pub const CATALOG_PATH: &str = "/v1/metrics/catalog";
pub const QUERY_PATH: &str = "/v1/reports/query";
pub const REPORTING_PERMISSION: &str = "analytics:read";
pub const DESCENDANT_PERMISSION: &str = "analytics:compare_children";
pub const MAX_METRICS: usize = 25;
pub const MAX_BREAKDOWNS: usize = 2;
pub const MAX_POINTS: usize = 2_000;
pub const MAX_FILTER_VALUES: usize = 100;
pub const MAX_AUTHORIZED_SCOPES: usize = 100;
pub const MAX_RANGE_DAYS: i64 = 366;
const REPORT_CACHE_TTL_SECONDS: u64 = 30;
const REPORT_CACHE_OPERATION_TIMEOUT: StdDuration = StdDuration::from_millis(150);
const REPORT_CACHE_KEY_VERSION: u8 = 1;

#[derive(Clone)]
pub struct ReportingAuthenticator {
    legacy_key: Option<ES256PublicKey>,
    keyed_keys: BTreeMap<String, ES256PublicKey>,
    allowed_issuers: HashSet<String>,
    audience: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReportingGrantClaims {
    principal_type: PrincipalType,
    scope_id: i64,
    root_scope_id: i64,
    descendant_mode: DescendantMode,
    #[serde(default)]
    explicit_descendant_scope_ids: Vec<i64>,
    #[serde(default)]
    permissions: BTreeSet<String>,
    #[serde(default)]
    metric_keys: Vec<String>,
    #[serde(default)]
    dimension_keys: Vec<String>,
    policy_version: String,
    #[serde(default)]
    correlation_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum ReportingError {
    #[error("reporting authorization failed")]
    Unauthorized,
    #[error("reporting scope is not authorized")]
    Forbidden,
    #[error("invalid reporting request: {0}")]
    InvalidRequest(String),
    #[error("reporting data is unavailable: {0}")]
    Unavailable(String),
    #[error("reporting database failed: {0}")]
    Database(#[from] sqlx::Error),
}

impl ReportingAuthenticator {
    pub fn from_config(config: &AnalyticsConfig) -> Result<Self, String> {
        let legacy_key = config
            .reporting_public_key
            .as_deref()
            .map(ES256PublicKey::from_pem)
            .transpose()
            .map_err(|error| format!("invalid ANALYTICS_REPORTING_PUBLIC_KEY: {error}"))?;

        let keyed_keys = if let Some(value) = config.reporting_public_keys_json.as_deref() {
            let values =
                serde_json::from_str::<BTreeMap<String, String>>(value).map_err(|error| {
                    format!("invalid ANALYTICS_REPORTING_PUBLIC_KEYS_JSON: {error}")
                })?;
            if values.is_empty() {
                return Err("ANALYTICS_REPORTING_PUBLIC_KEYS_JSON must contain a key".to_string());
            }
            values
                .into_iter()
                .map(|(key_id, pem)| {
                    if key_id.trim().is_empty() {
                        return Err("reporting public key ids cannot be empty".to_string());
                    }
                    ES256PublicKey::from_pem(&pem)
                        .map(|key| (key_id.clone(), key.with_key_id(&key_id)))
                        .map_err(|error| format!("invalid reporting key {key_id}: {error}"))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            legacy_key,
            keyed_keys,
            allowed_issuers: config.reporting_issuers.iter().cloned().collect(),
            audience: config.reporting_audience.clone(),
        })
    }

    pub fn authenticate(&self, request: &HttpRequest) -> Result<ReportingGrant, ReportingError> {
        let token = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.trim().is_empty())
            .ok_or(ReportingError::Unauthorized)?;
        self.authenticate_token(token)
    }

    fn authenticate_token(&self, token: &str) -> Result<ReportingGrant, ReportingError> {
        let metadata = Token::decode_metadata(token).map_err(|_| ReportingError::Unauthorized)?;
        let key = match metadata.key_id() {
            Some(key_id) => self
                .keyed_keys
                .get(key_id)
                .ok_or(ReportingError::Unauthorized)?,
            None => self
                .legacy_key
                .as_ref()
                .ok_or(ReportingError::Unauthorized)?,
        };
        let options = VerificationOptions {
            allowed_issuers: Some(self.allowed_issuers.clone()),
            allowed_audiences: Some(HashSet::from([self.audience.clone()])),
            max_validity: Some(jwt_simple::reexports::coarsetime::Duration::from_secs(120)),
            time_tolerance: Some(jwt_simple::reexports::coarsetime::Duration::from_secs(5)),
            ..VerificationOptions::default()
        };
        let claims = key
            .verify_token::<ReportingGrantClaims>(token, Some(options))
            .map_err(|_| ReportingError::Unauthorized)?;
        self.grant_from_claims(claims)
    }

    fn grant_from_claims(
        &self,
        claims: JWTClaims<ReportingGrantClaims>,
    ) -> Result<ReportingGrant, ReportingError> {
        let issued_at = timestamp(claims.issued_at).ok_or(ReportingError::Unauthorized)?;
        let not_before = timestamp(claims.invalid_before).unwrap_or(issued_at);
        let expires_at = timestamp(claims.expires_at).ok_or(ReportingError::Unauthorized)?;
        let issuer = claims.issuer.ok_or(ReportingError::Unauthorized)?;
        let principal_id = claims.subject.ok_or(ReportingError::Unauthorized)?;
        let grant_id = claims.jwt_id.ok_or(ReportingError::Unauthorized)?;
        let audience = claims
            .audiences
            .map(|audiences| audiences.into_set())
            .filter(|audiences| audiences.contains(&self.audience))
            .map(|_| self.audience.clone())
            .ok_or(ReportingError::Unauthorized)?;
        let custom = claims.custom;
        let grant = ReportingGrant {
            grant_id,
            issuer,
            audience,
            principal_type: custom.principal_type,
            principal_id,
            scope_id: custom.scope_id,
            root_scope_id: custom.root_scope_id,
            descendant_mode: custom.descendant_mode,
            explicit_descendant_scope_ids: custom.explicit_descendant_scope_ids,
            permissions: custom.permissions,
            metric_keys: custom.metric_keys,
            dimension_keys: custom.dimension_keys,
            policy_version: custom.policy_version,
            issued_at,
            not_before,
            expires_at,
            correlation_id: custom.correlation_id,
            revoked_at: None,
        };
        validate_grant(&grant, &self.audience, Utc::now())
            .map_err(|_| ReportingError::Unauthorized)?;
        Ok(grant)
    }
}

fn timestamp(
    value: Option<jwt_simple::reexports::coarsetime::UnixTimeStamp>,
) -> Option<DateTime<Utc>> {
    value.and_then(|value| Utc.timestamp_opt(value.as_secs() as i64, 0).single())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogQuery {
    pub reporting_scope_id: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportQueryRequest {
    pub reporting_scope_id: i64,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComparisonRequest {
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReportComparison {
    pub kind: String,
    pub range_start: DateTime<Utc>,
    pub range_end: DateTime<Utc>,
    pub metrics: Vec<ComparisonMetricResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ComparisonMetricResult {
    pub key: String,
    pub version: u32,
    pub series: Vec<ReportPoint>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogResponse {
    pub scope_id: i64,
    pub scope_kind: String,
    pub timezone: String,
    pub registry_version: String,
    pub registry_sha256: String,
    pub metrics: Vec<MetricDefinition>,
    pub dimensions: Vec<DimensionDefinition>,
    pub metric_sets: Vec<MetricSetDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReportResponse {
    pub scope_id: i64,
    pub scope_kind: String,
    pub range_start: DateTime<Utc>,
    pub range_end: DateTime<Utc>,
    pub interval: String,
    pub timezone: String,
    pub generated_at: DateTime<Utc>,
    pub data_as_of: Option<DateTime<Utc>>,
    pub generation_id: Option<i64>,
    pub projection_version: String,
    pub registry_sha256: String,
    pub metrics: Vec<MetricResult>,
    pub comparison: Option<ReportComparison>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetricResult {
    pub key: String,
    pub version: u32,
    pub unit: String,
    pub value_type: String,
    pub exactness: String,
    pub availability: AvailabilitySummary,
    pub coverage: CoverageSummary,
    pub freshness: FreshnessSummary,
    pub warnings: Vec<String>,
    pub series: Vec<ReportPoint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReportPoint {
    pub bucket_start: DateTime<Utc>,
    pub bucket_end: DateTime<Utc>,
    pub dimensions: Value,
    pub value: Option<f64>,
    pub numerator: Option<f64>,
    pub denominator: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AvailabilitySummary {
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageSummary {
    pub state: String,
    pub included_points: usize,
    pub expected_points: Option<usize>,
    pub evidence_layer: Option<String>,
    pub window_start: Option<DateTime<Utc>>,
    pub window_end: Option<DateTime<Utc>>,
    pub complete_through: Option<DateTime<Utc>>,
    pub projection_state: String,
    pub projection_source_state: String,
    pub required_sources: Vec<String>,
    pub dimension_state: String,
    pub missing_dimension_points: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FreshnessSummary {
    pub state: String,
    pub latest_source_timestamp: Option<DateTime<Utc>>,
    pub max_age_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct AuthorizedScope {
    requested_scope_id: i64,
    authorized_scope_ids: Vec<i64>,
    scope_kind: String,
    timezone: String,
}

#[derive(Clone, Debug)]
struct GenerationInfo {
    generation_id: i64,
    projection_version: String,
    registry_sha256: String,
    processing_status: String,
}

#[derive(Clone, Debug)]
struct SourceAvailability {
    state: String,
    reason: Option<String>,
    latest_timestamp: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
struct CoverageAvailability {
    state: String,
    reason: Option<String>,
    evidence_layer: Option<String>,
    window_start: Option<DateTime<Utc>>,
    window_end: Option<DateTime<Utc>>,
    complete_through: Option<DateTime<Utc>>,
    observed_at: Option<DateTime<Utc>>,
}

struct CoverageCheckpointInput {
    evidence_layer: String,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    coverage_state: String,
    complete_through: Option<DateTime<Utc>>,
    observed_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct ReportingCache {
    backend: Option<Arc<dyn CacheBackend>>,
    ttl_seconds: u64,
}

#[derive(Debug)]
enum CacheRead {
    Disabled,
    Miss,
    Hit(Box<ReportResponse>),
    Stale,
    Unavailable,
}

#[derive(Serialize, Deserialize)]
struct CachedReport {
    cached_at: DateTime<Utc>,
    response: ReportResponse,
}

#[async_trait]
trait CacheBackend: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, String>;
    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), String>;
}

struct RedisCacheBackend {
    client: redis::Client,
    connection: tokio::sync::Mutex<Option<redis::aio::ConnectionManager>>,
}

impl RedisCacheBackend {
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
            .set_connection_timeout(REPORT_CACHE_OPERATION_TIMEOUT)
            .set_response_timeout(REPORT_CACHE_OPERATION_TIMEOUT);
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
impl CacheBackend for RedisCacheBackend {
    async fn get(&self, key: &str) -> Result<Option<String>, String> {
        let mut connection = self.connection().await?;
        let result = tokio::time::timeout(
            REPORT_CACHE_OPERATION_TIMEOUT,
            connection.get::<_, Option<String>>(key),
        )
        .await
        .map_err(|_| "redis cache read timed out".to_string())?
        .map_err(|error| error.to_string());
        if result.is_err() {
            self.invalidate_connection().await;
        }
        result
    }

    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), String> {
        let mut connection = self.connection().await?;
        let result = tokio::time::timeout(
            REPORT_CACHE_OPERATION_TIMEOUT,
            connection.set_ex::<_, _, ()>(key, value, ttl_seconds),
        )
        .await
        .map_err(|_| "redis cache write timed out".to_string())?
        .map_err(|error| error.to_string());
        if result.is_err() {
            self.invalidate_connection().await;
        }
        result
    }
}

impl ReportingCache {
    pub fn from_config(config: &AnalyticsConfig) -> Self {
        let backend = config.redis_url.as_deref().and_then(|url| {
            if url.trim().is_empty() {
                return None;
            }
            match redis::Client::open(url) {
                Ok(client) => Some(Arc::new(RedisCacheBackend::new(client)) as Arc<dyn CacheBackend>),
                Err(error) => {
                    log::warn!(
                        "service=kasitek-analytics process=analytics-api reporting_cache=disabled reason=invalid_redis_url error={error}"
                    );
                    None
                }
            }
        });
        Self {
            backend,
            ttl_seconds: REPORT_CACHE_TTL_SECONDS,
        }
    }

    pub fn disabled() -> Self {
        Self {
            backend: None,
            ttl_seconds: REPORT_CACHE_TTL_SECONDS,
        }
    }

    fn enabled(&self) -> bool {
        self.backend.is_some()
    }

    async fn read(&self, key: &str) -> CacheRead {
        let Some(backend) = &self.backend else {
            return CacheRead::Disabled;
        };
        let serialized = match backend.get(key).await {
            Ok(Some(value)) => value,
            Ok(None) => return CacheRead::Miss,
            Err(error) => {
                log::warn!(
                    "service=kasitek-analytics process=analytics-api reporting_cache=unavailable operation=get error={error}"
                );
                return CacheRead::Unavailable;
            }
        };
        let cached = match serde_json::from_str::<CachedReport>(&serialized) {
            Ok(cached) => cached,
            Err(error) => {
                log::warn!(
                    "service=kasitek-analytics process=analytics-api reporting_cache=unavailable operation=decode error={error}"
                );
                return CacheRead::Unavailable;
            }
        };
        let stale_after = cached.cached_at + Duration::seconds(self.ttl_seconds as i64);
        if stale_after <= Utc::now() {
            CacheRead::Stale
        } else {
            CacheRead::Hit(Box::new(cached.response))
        }
    }

    async fn write(&self, key: &str, response: &ReportResponse, ttl_seconds: u64) {
        let Some(backend) = &self.backend else {
            return;
        };
        if ttl_seconds == 0 {
            return;
        }
        let value = match serde_json::to_string(&CachedReport {
            cached_at: Utc::now(),
            response: response.clone(),
        }) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "service=kasitek-analytics process=analytics-api reporting_cache=unavailable operation=encode error={error}"
                );
                return;
            }
        };
        if let Err(error) = backend.set(key, &value, ttl_seconds).await {
            log::warn!(
                "service=kasitek-analytics process=analytics-api reporting_cache=unavailable operation=set error={error}"
            );
        }
    }
}

#[derive(Serialize)]
struct ReportCacheKeyPayload<'a> {
    schema_version: u8,
    grant: &'a ReportingGrant,
    requested_scope_id: i64,
    authorized_scope_ids: &'a [i64],
    generation_id: Option<i64>,
    projection_version: &'a str,
    generation_registry_sha256: &'a str,
    request: &'a ReportQueryRequest,
}

fn generation_identity<'a>(
    generation: Option<&'a GenerationInfo>,
    registry: &'a RegistrySnapshot,
) -> (Option<i64>, &'a str, &'a str) {
    generation
        .map(|generation| {
            (
                Some(generation.generation_id),
                generation.projection_version.as_str(),
                generation.registry_sha256.as_str(),
            )
        })
        .unwrap_or((None, PROJECTION_VERSION, registry.sha256.as_str()))
}

fn report_cache_key(
    grant: &ReportingGrant,
    scope: &AuthorizedScope,
    request: &ReportQueryRequest,
    generation_id: Option<i64>,
    projection_version: &str,
    generation_registry_sha256: &str,
) -> String {
    let payload = ReportCacheKeyPayload {
        schema_version: REPORT_CACHE_KEY_VERSION,
        grant,
        requested_scope_id: scope.requested_scope_id,
        authorized_scope_ids: &scope.authorized_scope_ids,
        generation_id,
        projection_version,
        generation_registry_sha256,
        request,
    };
    let serialized =
        serde_json::to_vec(&payload).expect("report cache key payload is serializable");
    format!(
        "kasitek:analytics:report:v{}:{}",
        REPORT_CACHE_KEY_VERSION,
        crate::config::hex_sha256(&serialized)
    )
}

fn cache_ttl_seconds(grant: &ReportingGrant) -> u64 {
    let remaining = (grant.expires_at - Utc::now()).num_seconds().max(0) as u64;
    REPORT_CACHE_TTL_SECONDS.min(remaining)
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource(CATALOG_PATH).route(web::get().to(catalog_handler)));
    cfg.service(web::resource(QUERY_PATH).route(web::post().to(report_handler)));
}

async fn catalog_handler(
    request: HttpRequest,
    query: web::Query<CatalogQuery>,
    pool: web::Data<sqlx::PgPool>,
    registry: web::Data<RegistrySnapshot>,
    access: web::Data<ReportingAuthenticator>,
) -> impl Responder {
    let grant = match access.authenticate(&request) {
        Ok(grant) => grant,
        Err(error) => return error_response(error),
    };
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => return error_response(ReportingError::Database(error)),
    };
    let authorized =
        match authorize_transaction(&mut transaction, &grant, query.reporting_scope_id).await {
            Ok(authorized) => authorized,
            Err(error) => return error_response(error),
        };
    let response = catalog_response(&registry, &grant, &authorized);
    if let Err(error) = transaction.commit().await {
        return error_response(ReportingError::Database(error));
    }
    HttpResponse::Ok().json(response)
}

fn authorization_context_error(
    error: crate::authorization::AuthorizationContextErrorOrDatabase,
) -> ReportingError {
    match error {
        crate::authorization::AuthorizationContextErrorOrDatabase::Database(error) => {
            ReportingError::Database(error)
        }
        crate::authorization::AuthorizationContextErrorOrDatabase::Context(error) => {
            ReportingError::InvalidRequest(error.to_string())
        }
    }
}

async fn report_handler(
    request: HttpRequest,
    payload: web::Json<ReportQueryRequest>,
    pool: web::Data<sqlx::PgPool>,
    registry: web::Data<RegistrySnapshot>,
    access: web::Data<ReportingAuthenticator>,
    cache: web::Data<ReportingCache>,
) -> impl Responder {
    let grant = match access.authenticate(&request) {
        Ok(grant) => grant,
        Err(error) => return error_response(error),
    };
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => return error_response(ReportingError::Database(error)),
    };
    let authorized =
        match authorize_transaction(&mut transaction, &grant, payload.reporting_scope_id).await {
            Ok(authorized) => authorized,
            Err(error) => return error_response(error),
        };

    let cache_key = if cache.enabled() {
        match load_generation(&mut transaction, authorized.requested_scope_id).await {
            Ok(generation) => {
                let (generation_id, projection_version, generation_registry_sha256) =
                    generation_identity(generation.as_ref(), &registry);
                Some(report_cache_key(
                    &grant,
                    &authorized,
                    &payload,
                    generation_id,
                    projection_version,
                    generation_registry_sha256,
                ))
            }
            Err(error) => {
                log::warn!(
                    "service=kasitek-analytics process=analytics-api reporting_cache=bypassed reason=generation_lookup_failed error={error}"
                );
                None
            }
        }
    } else {
        None
    };
    if let Some(key) = &cache_key {
        if let CacheRead::Hit(response) = cache.read(key).await {
            if let Err(error) = transaction.commit().await {
                return error_response(ReportingError::Database(error));
            }
            return HttpResponse::Ok().json(response);
        }
    }
    let response =
        match execute_report(&mut transaction, &registry, &grant, &authorized, &payload).await {
            Ok(response) => response,
            Err(error) => return error_response(error),
        };
    let write_key = if cache.enabled() {
        Some(report_cache_key(
            &grant,
            &authorized,
            &payload,
            response.generation_id,
            &response.projection_version,
            &response.registry_sha256,
        ))
    } else {
        None
    };
    if let Err(error) = transaction.commit().await {
        return error_response(ReportingError::Database(error));
    }
    if let Some(key) = write_key {
        cache
            .write(&key, &response, cache_ttl_seconds(&grant))
            .await;
    }
    HttpResponse::Ok().json(response)
}

fn error_response(error: ReportingError) -> HttpResponse {
    match error {
        ReportingError::Unauthorized => HttpResponse::Unauthorized()
            .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
            .json(json!({"error":"unauthorized"})),
        ReportingError::Forbidden => HttpResponse::Forbidden().json(json!({"error":"forbidden"})),
        ReportingError::InvalidRequest(message) => HttpResponse::UnprocessableEntity()
            .json(json!({"error":"invalid_request","message":message})),
        ReportingError::Unavailable(message) => HttpResponse::ServiceUnavailable()
            .json(json!({"error":"unavailable","message":message})),
        ReportingError::Database(error) => {
            log::error!(
                "service=kasitek-analytics process=analytics-api reporting_database_error={error}"
            );
            HttpResponse::InternalServerError().json(json!({"error":"internal_error"}))
        }
    }
}

pub async fn authorize_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    grant: &ReportingGrant,
    requested_scope_id: i64,
) -> Result<AuthorizedScope, ReportingError> {
    validate_grant(grant, &grant.audience, Utc::now()).map_err(|_| ReportingError::Unauthorized)?;
    if !grant.permissions.contains(REPORTING_PERMISSION) {
        return Err(ReportingError::Forbidden);
    }
    if requested_scope_id <= 0 || grant.scope_id <= 0 {
        return Err(ReportingError::Forbidden);
    }
    if grant.explicit_descendant_scope_ids.len() > MAX_AUTHORIZED_SCOPES {
        return Err(ReportingError::InvalidRequest(format!(
            "authorization covers more than {MAX_AUTHORIZED_SCOPES} scopes"
        )));
    }
    set_authorization_context_transaction(transaction, &[grant.scope_id], &grant.grant_id)
        .await
        .map_err(authorization_context_error)?;

    let grant_row = sqlx::query(
        r#"SELECT g.audience, g.principal_type, g.principal_id, g.scope_id, g.root_scope_id,
                  g.descendant_mode, g.explicit_descendant_scope_ids, g.permissions,
                  g.metric_keys, g.dimension_keys, g.policy_version, g.issued_at,
                  g.not_before, g.expires_at, g.correlation_id, g.revoked_at, si.issuer
           FROM analytics.reporting_grant AS g
           JOIN analytics.service_identity AS si
             ON si.service_identity_id = g.issuer_service_identity_id
           WHERE g.grant_id = $1"#,
    )
    .bind(&grant.grant_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(ReportingError::Unauthorized)?;
    let database_grant: String = grant_row.try_get("audience")?;
    let database_issuer: String = grant_row.try_get("issuer")?;
    let database_scope_id: i64 = grant_row.try_get("scope_id")?;
    let database_root_scope_id: i64 = grant_row.try_get("root_scope_id")?;
    let revoked_at: Option<DateTime<Utc>> = grant_row.try_get("revoked_at")?;
    let expires_at: DateTime<Utc> = grant_row.try_get("expires_at")?;
    let database_principal_type: String = grant_row.try_get("principal_type")?;
    let database_descendant_mode: String = grant_row.try_get("descendant_mode")?;
    let database_explicit_descendants: Value =
        grant_row.try_get("explicit_descendant_scope_ids")?;
    let database_permissions: Value = grant_row.try_get("permissions")?;
    let database_metric_keys: Value = grant_row.try_get("metric_keys")?;
    let database_dimension_keys: Value = grant_row.try_get("dimension_keys")?;
    if database_grant != grant.audience
        || database_issuer != grant.issuer
        || database_scope_id != grant.scope_id
        || database_root_scope_id != grant.root_scope_id
        || database_principal_type
            != serde_json::to_string(&grant.principal_type)
                .unwrap_or_default()
                .trim_matches('"')
        || database_descendant_mode
            != serde_json::to_string(&grant.descendant_mode)
                .unwrap_or_default()
                .trim_matches('"')
        || database_explicit_descendants
            != serde_json::to_value(&grant.explicit_descendant_scope_ids).unwrap_or(Value::Null)
        || database_permissions != serde_json::to_value(&grant.permissions).unwrap_or(Value::Null)
        || database_metric_keys != serde_json::to_value(&grant.metric_keys).unwrap_or(Value::Null)
        || database_dimension_keys
            != serde_json::to_value(&grant.dimension_keys).unwrap_or(Value::Null)
        || revoked_at.is_some()
        || expires_at <= Utc::now()
        || grant_row.try_get::<String, _>("principal_id")? != grant.principal_id
        || grant_row.try_get::<String, _>("policy_version")? != grant.policy_version
    {
        return Err(ReportingError::Unauthorized);
    }

    let mut inspection_scope_ids = vec![grant.scope_id, requested_scope_id];
    inspection_scope_ids.extend(grant.explicit_descendant_scope_ids.iter().copied());
    if inspection_scope_ids.iter().any(|scope_id| *scope_id <= 0) {
        return Err(ReportingError::Forbidden);
    }
    set_authorization_context_transaction(transaction, &inspection_scope_ids, &grant.grant_id)
        .await
        .map_err(authorization_context_error)?;

    let scope_row = sqlx::query(
        r#"SELECT scope_id, scope_kind, root_scope_id, status, reporting_timezone
           FROM analytics.reporting_scope
           WHERE scope_id = $1"#,
    )
    .bind(requested_scope_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(ReportingError::Forbidden)?;
    let scope_status: String = scope_row.try_get("status")?;
    let scope_root: i64 = scope_row.try_get("root_scope_id")?;
    if scope_status != "active" || scope_root != grant.root_scope_id {
        return Err(ReportingError::Forbidden);
    }
    let grant_scope_active: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM analytics.reporting_scope WHERE scope_id = $1 AND root_scope_id = $2 AND status = 'active')",
    )
    .bind(grant.scope_id)
    .bind(grant.root_scope_id)
    .fetch_one(&mut **transaction)
    .await?;
    if !grant_scope_active {
        return Err(ReportingError::Forbidden);
    }

    let is_descendant: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM analytics.scope_ancestor WHERE ancestor_scope_id = $1 AND descendant_scope_id = $2)",
    )
    .bind(grant.scope_id)
    .bind(requested_scope_id)
    .fetch_one(&mut **transaction)
    .await?;
    if !is_descendant {
        return Err(ReportingError::Forbidden);
    }

    let mut authorized_scope_ids = match grant.descendant_mode {
        DescendantMode::None => {
            if requested_scope_id != grant.scope_id {
                return Err(ReportingError::Forbidden);
            }
            vec![grant.scope_id]
        }
        DescendantMode::Explicit => {
            if requested_scope_id != grant.scope_id
                && !grant
                    .explicit_descendant_scope_ids
                    .contains(&requested_scope_id)
            {
                return Err(ReportingError::Forbidden);
            }
            let mut ids = vec![grant.scope_id];
            ids.extend(grant.explicit_descendant_scope_ids.iter().copied());
            for descendant_scope_id in &grant.explicit_descendant_scope_ids {
                let valid_descendant: bool = sqlx::query_scalar(
                    r#"SELECT EXISTS (
                         SELECT 1
                         FROM analytics.scope_ancestor AS hierarchy
                         JOIN analytics.reporting_scope AS scope
                           ON scope.scope_id = hierarchy.descendant_scope_id
                         WHERE hierarchy.ancestor_scope_id = $1
                           AND hierarchy.descendant_scope_id = $2
                           AND scope.root_scope_id = $3
                           AND scope.status = 'active'
                       )"#,
                )
                .bind(grant.scope_id)
                .bind(descendant_scope_id)
                .bind(grant.root_scope_id)
                .fetch_one(&mut **transaction)
                .await?;
                if !valid_descendant {
                    return Err(ReportingError::Forbidden);
                }
            }
            ids
        }
        DescendantMode::All => {
            if !grant.permissions.contains(DESCENDANT_PERMISSION)
                && requested_scope_id != grant.scope_id
            {
                return Err(ReportingError::Forbidden);
            }
            sqlx::query_scalar::<_, i64>(
                r#"SELECT scope_id
                   FROM analytics.authorized_active_descendant_scope_ids($1)
                   LIMIT $2"#,
            )
            .bind(grant.scope_id)
            .bind((MAX_AUTHORIZED_SCOPES + 1) as i64)
            .fetch_all(&mut **transaction)
            .await?
        }
    };
    authorized_scope_ids.sort_unstable();
    authorized_scope_ids.dedup();
    if authorized_scope_ids.len() > MAX_AUTHORIZED_SCOPES {
        return Err(ReportingError::InvalidRequest(format!(
            "authorization covers more than {MAX_AUTHORIZED_SCOPES} scopes"
        )));
    }
    if !authorized_scope_ids.contains(&requested_scope_id) {
        return Err(ReportingError::Forbidden);
    }
    set_authorization_context_transaction(transaction, &authorized_scope_ids, &grant.grant_id)
        .await
        .map_err(authorization_context_error)?;

    Ok(AuthorizedScope {
        requested_scope_id,
        authorized_scope_ids,
        scope_kind: scope_row.try_get("scope_kind")?,
        timezone: scope_row.try_get("reporting_timezone")?,
    })
}

fn catalog_response(
    registry: &RegistrySnapshot,
    grant: &ReportingGrant,
    scope: &AuthorizedScope,
) -> CatalogResponse {
    let visible = |identity: &str| {
        grant.metric_keys.is_empty() || grant.metric_keys.iter().any(|key| key == identity)
    };
    let metrics = registry
        .metrics
        .iter()
        .filter(|metric| {
            visible(&metric_identity(metric))
                && metric
                    .scope_kinds
                    .iter()
                    .any(|kind| kind == &scope.scope_kind)
                && metric
                    .permissions
                    .iter()
                    .any(|permission| permission == REPORTING_PERMISSION)
        })
        .cloned()
        .collect::<Vec<_>>();
    let dimensions = registry
        .dimensions
        .iter()
        .filter(|dimension| {
            (grant.dimension_keys.is_empty() || grant.dimension_keys.contains(&dimension.key))
                && dimension
                    .permissions
                    .iter()
                    .any(|permission| permission == REPORTING_PERMISSION)
                && metrics
                    .iter()
                    .any(|metric| metric.dimensions.contains(&dimension.key))
        })
        .cloned()
        .collect::<Vec<_>>();
    let metric_sets = registry
        .metric_sets
        .iter()
        .filter(|set| {
            set.scope_kinds.iter().any(|kind| kind == &scope.scope_kind)
                && set
                    .permissions
                    .iter()
                    .any(|permission| permission == REPORTING_PERMISSION)
                && set.metrics.iter().all(|metric| visible(metric))
        })
        .cloned()
        .collect::<Vec<_>>();
    CatalogResponse {
        scope_id: scope.requested_scope_id,
        scope_kind: scope.scope_kind.clone(),
        timezone: scope.timezone.clone(),
        registry_version: registry.metrics_registry_version.clone(),
        registry_sha256: registry.sha256.clone(),
        metrics,
        dimensions,
        metric_sets,
    }
}

pub async fn execute_report(
    transaction: &mut Transaction<'_, Postgres>,
    registry: &RegistrySnapshot,
    grant: &ReportingGrant,
    scope: &AuthorizedScope,
    request: &ReportQueryRequest,
) -> Result<ReportResponse, ReportingError> {
    validate_request_shape(request)?;
    if request.timezone != scope.timezone {
        return Err(ReportingError::InvalidRequest(
            "timezone must match the reporting scope timezone".to_string(),
        ));
    }
    if request.include_descendants
        && scope.authorized_scope_ids.len() == 1
        && grant.descendant_mode == DescendantMode::None
    {
        return Err(ReportingError::Forbidden);
    }
    if request.include_descendants && !grant.permissions.contains(DESCENDANT_PERMISSION) {
        return Err(ReportingError::Forbidden);
    }

    let metrics = select_metrics(registry, grant, scope, request)?;
    let interval = select_interval(request, &metrics)?;
    let comparison_range = request
        .comparison
        .as_ref()
        .map(|comparison| previous_period_range(request, comparison))
        .transpose()?;
    let breakdowns = validate_dimensions(registry, grant, &metrics, &request.breakdowns, true)?;
    let _filters = validate_dimensions(
        registry,
        grant,
        &metrics,
        &request.filters.keys().cloned().collect::<Vec<_>>(),
        false,
    )?;
    let generation = load_generation(transaction, scope.requested_scope_id).await?;
    let source_availability =
        load_source_availability(transaction, &scope.authorized_scope_ids, &metrics).await?;
    let coverage_availability = load_coverage_availability(
        transaction,
        &scope.authorized_scope_ids,
        &metrics,
        request.range_start,
        request.range_end,
    )
    .await?;

    let mut results = Vec::with_capacity(metrics.len());
    let mut comparison_results = Vec::with_capacity(metrics.len());
    let mut global_data_as_of = None;
    for metric in metrics {
        let source = source_availability
            .get(&metric.key)
            .cloned()
            .unwrap_or(SourceAvailability {
                state: "not_instrumented".to_string(),
                reason: Some("no source state has been recorded for this metric".to_string()),
                latest_timestamp: None,
            });
        let coverage = coverage_availability
            .get(&metric.domain)
            .cloned()
            .unwrap_or_else(|| unknown_coverage("no temporal coverage evidence has been recorded"));
        global_data_as_of = max_datetime(global_data_as_of, source.latest_timestamp);
        let mut warnings = Vec::new();
        let mut series = Vec::new();
        let mut projection_source_state = "unknown".to_string();
        let mut coverage_state = coverage.state.clone();
        if let Some(generation) = &generation {
            if generation.registry_sha256 != registry.sha256 {
                coverage_state = "stale".to_string();
                warnings.push(
                    "projection generation was built from a different metric registry".to_string(),
                );
            }
            if generation.processing_status != "idle" {
                warnings.push(format!(
                    "projection checkpoint is {}",
                    generation.processing_status
                ));
            }
            let queried_series = query_metric_series(
                transaction,
                SeriesQuery {
                    generation_id: generation.generation_id,
                    metric,
                    range_start: request.range_start,
                    range_end: request.range_end,
                    interval: &interval,
                    requested_scope_id: scope.requested_scope_id,
                    authorized_scope_ids: &scope.authorized_scope_ids,
                    include_descendants: request.include_descendants,
                    breakdowns: &breakdowns,
                    filters: &request.filters,
                },
            )
            .await?;
            projection_source_state = queried_series.projection_source_state;
            series = queried_series.points;
        } else {
            coverage_state = "unknown".to_string();
            warnings.push("no promoted projection generation is available".to_string());
        }
        let comparison_series = if let (Some(generation), Some(&(range_start, range_end))) =
            (&generation, comparison_range.as_ref())
        {
            query_metric_series(
                transaction,
                SeriesQuery {
                    generation_id: generation.generation_id,
                    metric,
                    range_start,
                    range_end,
                    interval: &interval,
                    requested_scope_id: scope.requested_scope_id,
                    authorized_scope_ids: &scope.authorized_scope_ids,
                    include_descendants: request.include_descendants,
                    breakdowns: &breakdowns,
                    filters: &request.filters,
                },
            )
            .await?
            .points
        } else {
            Vec::new()
        };
        global_data_as_of = max_datetime(
            global_data_as_of,
            series.iter().map(|point| point.bucket_end).max(),
        );
        let projection_state = projection_coverage_state(generation.as_ref());
        let (dimension_state, missing_dimension_points) =
            dimension_coverage_state(&series, &breakdowns);
        let mut reported_state = report_availability_state(
            &source.state,
            &coverage_state,
            &projection_state,
            !series.is_empty(),
        );
        if reported_state == "available" && projection_source_state == "partial" {
            reported_state = "partial".to_string();
            warnings.push("projection source coverage metadata is partial".to_string());
        }
        if reported_state != "available" {
            warnings.push(
                coverage
                    .reason
                    .clone()
                    .or_else(|| source.reason.clone())
                    .unwrap_or_else(|| format!("report availability is {reported_state}")),
            );
        }
        results.push(MetricResult {
            key: metric.key.clone(),
            version: metric.version,
            unit: metric.unit.clone(),
            value_type: metric.value_type.clone(),
            exactness: metric.exactness.clone(),
            availability: AvailabilitySummary {
                state: if generation.is_none() && reported_state == "not_instrumented" {
                    "not_instrumented".to_string()
                } else {
                    reported_state
                },
                reason: source.reason,
            },
            coverage: CoverageSummary {
                state: if series.is_empty() && coverage_state == "available" {
                    "unknown".to_string()
                } else {
                    coverage_state.to_string()
                },
                included_points: series.len(),
                expected_points: Some(expected_points(
                    &request.range_start,
                    &request.range_end,
                    &interval,
                )),
                evidence_layer: coverage.evidence_layer,
                window_start: coverage.window_start,
                window_end: coverage.window_end,
                complete_through: coverage.complete_through,
                projection_state,
                projection_source_state,
                required_sources: metric.coverage.required_sources.clone(),
                dimension_state,
                missing_dimension_points,
            },
            freshness: FreshnessSummary {
                state: source.state.clone(),
                latest_source_timestamp: source.latest_timestamp,
                max_age_seconds: metric.freshness.max_age_seconds,
            },
            warnings,
            series,
        });
        if comparison_range.is_some() {
            comparison_results.push(ComparisonMetricResult {
                key: metric.key.clone(),
                version: metric.version,
                series: comparison_series,
            });
        }
    }

    Ok(ReportResponse {
        scope_id: scope.requested_scope_id,
        scope_kind: scope.scope_kind.clone(),
        range_start: request.range_start,
        range_end: request.range_end,
        interval,
        timezone: request.timezone.clone(),
        generated_at: Utc::now(),
        data_as_of: global_data_as_of,
        generation_id: generation
            .as_ref()
            .map(|generation| generation.generation_id),
        projection_version: generation
            .as_ref()
            .map(|generation| generation.projection_version.clone())
            .unwrap_or_else(|| PROJECTION_VERSION.to_string()),
        registry_sha256: registry.sha256.clone(),
        metrics: results,
        comparison: comparison_range.map(|(range_start, range_end)| ReportComparison {
            kind: request
                .comparison
                .as_ref()
                .map(|comparison| comparison.kind.clone())
                .unwrap_or_else(|| "previous_period".to_string()),
            range_start,
            range_end,
            metrics: comparison_results,
        }),
    })
}

fn validate_request_shape(request: &ReportQueryRequest) -> Result<(), ReportingError> {
    if request.reporting_scope_id <= 0 {
        return Err(ReportingError::InvalidRequest(
            "reporting_scope_id must be positive".to_string(),
        ));
    }
    if request.range_end <= request.range_start {
        return Err(ReportingError::InvalidRequest(
            "range_end must be after range_start".to_string(),
        ));
    }
    if request.range_end - request.range_start > Duration::days(MAX_RANGE_DAYS) {
        return Err(ReportingError::InvalidRequest(format!(
            "range cannot exceed {MAX_RANGE_DAYS} days"
        )));
    }
    if request.timezone.trim().is_empty() || request.timezone.len() > 128 {
        return Err(ReportingError::InvalidRequest(
            "timezone must be a non-empty IANA timezone name".to_string(),
        ));
    }
    if request.breakdowns.len() > MAX_BREAKDOWNS {
        return Err(ReportingError::InvalidRequest(format!(
            "at most {MAX_BREAKDOWNS} breakdowns are allowed"
        )));
    }
    if request.filters.len() > MAX_BREAKDOWNS {
        return Err(ReportingError::InvalidRequest(format!(
            "at most {MAX_BREAKDOWNS} filter dimensions are allowed"
        )));
    }
    if request
        .filters
        .values()
        .any(|values| values.is_empty() || values.len() > MAX_FILTER_VALUES)
    {
        return Err(ReportingError::InvalidRequest(format!(
            "each filter must contain 1-{MAX_FILTER_VALUES} values"
        )));
    }
    if request.metric_set.is_some() && !request.metrics.is_empty() {
        return Err(ReportingError::InvalidRequest(
            "metrics and metric_set are mutually exclusive".to_string(),
        ));
    }
    if let Some(comparison) = &request.comparison {
        previous_period_range(request, comparison)?;
    }
    Ok(())
}

fn previous_period_range(
    request: &ReportQueryRequest,
    comparison: &ComparisonRequest,
) -> Result<(DateTime<Utc>, DateTime<Utc>), ReportingError> {
    if comparison.kind != "previous_period" {
        return Err(ReportingError::InvalidRequest(format!(
            "comparison kind {} is not supported",
            comparison.kind
        )));
    }
    let duration = request.range_end - request.range_start;
    Ok((request.range_start - duration, request.range_start))
}

fn select_metrics<'a>(
    registry: &'a RegistrySnapshot,
    grant: &ReportingGrant,
    scope: &AuthorizedScope,
    request: &ReportQueryRequest,
) -> Result<Vec<&'a MetricDefinition>, ReportingError> {
    let identities = if let Some(metric_set) = &request.metric_set {
        let set = registry
            .metric_sets
            .iter()
            .find(|set| metric_set_identity(set) == *metric_set)
            .ok_or_else(|| {
                ReportingError::InvalidRequest(format!("metric set {metric_set} is not registered"))
            })?;
        set.metrics.clone()
    } else {
        request.metrics.clone()
    };
    if identities.is_empty() {
        return Err(ReportingError::InvalidRequest(
            "at least one metric or metric_set is required".to_string(),
        ));
    }
    if identities.len() > MAX_METRICS {
        return Err(ReportingError::InvalidRequest(format!(
            "at most {MAX_METRICS} metrics are allowed"
        )));
    }
    let mut seen = HashSet::new();
    identities
        .iter()
        .map(|identity| {
            if !seen.insert(identity) {
                return Err(ReportingError::InvalidRequest(format!(
                    "metric {identity} is duplicated"
                )));
            }
            if !grant.metric_keys.is_empty() && !grant.metric_keys.iter().any(|key| key == identity)
            {
                return Err(ReportingError::Forbidden);
            }
            let metric = registry
                .metrics
                .iter()
                .find(|metric| metric_identity(metric) == *identity)
                .ok_or_else(|| {
                    ReportingError::InvalidRequest(format!("metric {identity} is not registered"))
                })?;
            if !metric
                .scope_kinds
                .iter()
                .any(|kind| kind == &scope.scope_kind)
                || !metric
                    .permissions
                    .iter()
                    .any(|permission| permission == REPORTING_PERMISSION)
            {
                return Err(ReportingError::Forbidden);
            }
            Ok(metric)
        })
        .collect()
}

fn select_interval(
    request: &ReportQueryRequest,
    metrics: &[&MetricDefinition],
) -> Result<String, ReportingError> {
    let supported = |interval: &str| {
        ["hour", "day", "month"].contains(&interval)
            && metrics.iter().all(|metric| {
                metric
                    .supported_intervals
                    .iter()
                    .any(|value| value == interval)
            })
    };
    let interval = if let Some(interval) = &request.interval {
        if !supported(interval) {
            return Err(ReportingError::InvalidRequest(format!(
                "interval {interval} is not available for all selected metrics"
            )));
        }
        interval.clone()
    } else {
        let range = request.range_end - request.range_start;
        if range <= Duration::days(2) && supported("hour") {
            "hour".to_string()
        } else if range <= Duration::days(62) && supported("day") {
            "day".to_string()
        } else if supported("month") {
            "month".to_string()
        } else if supported("day") {
            "day".to_string()
        } else {
            return Err(ReportingError::InvalidRequest(
                "no common projected interval is available".to_string(),
            ));
        }
    };
    let points = expected_points(&request.range_start, &request.range_end, &interval);
    if points > MAX_POINTS {
        return Err(ReportingError::InvalidRequest(format!(
            "query would return more than {MAX_POINTS} points"
        )));
    }
    Ok(interval)
}

fn validate_dimensions(
    registry: &RegistrySnapshot,
    grant: &ReportingGrant,
    metrics: &[&MetricDefinition],
    requested: &[String],
    groupable: bool,
) -> Result<Vec<String>, ReportingError> {
    let mut seen = HashSet::new();
    requested
        .iter()
        .map(|key| {
            if !seen.insert(key) {
                return Err(ReportingError::InvalidRequest(format!(
                    "dimension {key} is duplicated"
                )));
            }
            if !grant.dimension_keys.is_empty()
                && !grant.dimension_keys.iter().any(|allowed| allowed == key)
            {
                return Err(ReportingError::Forbidden);
            }
            let dimension = registry
                .dimensions
                .iter()
                .find(|dimension| dimension.key == *key)
                .ok_or_else(|| {
                    ReportingError::InvalidRequest(format!("dimension {key} is not registered"))
                })?;
            if (groupable && !dimension.groupable) || (!groupable && !dimension.filterable) {
                return Err(ReportingError::InvalidRequest(format!(
                    "dimension {key} cannot be used in this position"
                )));
            }
            if !metrics.iter().all(|metric| metric.dimensions.contains(key)) {
                return Err(ReportingError::InvalidRequest(format!(
                    "dimension {key} is not compatible with every selected metric"
                )));
            }
            Ok(key.clone())
        })
        .collect()
}

async fn load_generation(
    transaction: &mut Transaction<'_, Postgres>,
    scope_id: i64,
) -> Result<Option<GenerationInfo>, ReportingError> {
    let row = sqlx::query(
        r#"SELECT checkpoint.generation_id, checkpoint.processing_status,
                  generation.projection_version, generation.metric_registry_sha256
           FROM analytics.analytics_projection_checkpoint AS checkpoint
           JOIN analytics.analytics_projection_generation AS generation
             ON generation.generation_id = checkpoint.generation_id
           WHERE checkpoint.projection_name = $1
             AND checkpoint.projection_version = $2
             AND checkpoint.reporting_scope_id = $3
             AND checkpoint.shard_key = $4
             AND generation.generation_status = 'promoted'"#,
    )
    .bind(PROJECTION_NAME)
    .bind(PROJECTION_VERSION)
    .bind(scope_id)
    .bind(DEFAULT_SHARD_KEY)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|row| {
        Ok(GenerationInfo {
            generation_id: row.try_get("generation_id")?,
            projection_version: row.try_get("projection_version")?,
            registry_sha256: row.try_get("metric_registry_sha256")?,
            processing_status: row.try_get("processing_status")?,
        })
    })
    .transpose()
}

async fn load_source_availability(
    transaction: &mut Transaction<'_, Postgres>,
    scope_ids: &[i64],
    metrics: &[&MetricDefinition],
) -> Result<HashMap<String, SourceAvailability>, ReportingError> {
    let metric_keys = metrics
        .iter()
        .map(|metric| metric.key.clone())
        .collect::<Vec<_>>();
    let rows = sqlx::query(
        r#"SELECT metric_scope, availability_state, safe_failure_code, latest_source_timestamp
           FROM analytics.analytics_source_state
           WHERE reporting_scope_id = ANY($1::bigint[])
             AND metric_scope = ANY($2::text[])
           ORDER BY updated_at DESC"#,
    )
    .bind(scope_ids)
    .bind(&metric_keys)
    .fetch_all(&mut **transaction)
    .await?;
    let mut output = HashMap::new();
    for row in rows {
        let key: String = row.try_get("metric_scope")?;
        let state: String = row.try_get("availability_state")?;
        let candidate = SourceAvailability {
            state: state.clone(),
            reason: row.try_get::<Option<String>, _>("safe_failure_code")?,
            latest_timestamp: row.try_get("latest_source_timestamp")?,
        };
        let replace = output
            .get(&key)
            .map(|current: &SourceAvailability| {
                availability_rank(&state) > availability_rank(&current.state)
            })
            .unwrap_or(true);
        if replace {
            output.insert(key, candidate);
        }
    }
    Ok(output)
}

async fn load_coverage_availability(
    transaction: &mut Transaction<'_, Postgres>,
    scope_ids: &[i64],
    metrics: &[&MetricDefinition],
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> Result<HashMap<String, CoverageAvailability>, ReportingError> {
    let mut domains = metrics
        .iter()
        .map(|metric| metric.domain.clone())
        .collect::<Vec<_>>();
    domains.sort();
    domains.dedup();
    if scope_ids.is_empty() || domains.is_empty() {
        return Ok(HashMap::new());
    }

    let checkpoint_rows = sqlx::query(
        r#"SELECT source_domain, reporting_scope_id, coverage_layer, window_start, window_end,
                  coverage_state, complete_through, observed_at
           FROM analytics.analytics_coverage_checkpoint
           WHERE reporting_scope_id = ANY($1::bigint[])
             AND source_domain = ANY($2::text[])
             AND window_end > $3
             AND window_start < $4
             AND coverage_layer IN ('temporal', 'reconciliation')
           ORDER BY source_domain, reporting_scope_id,
                    CASE coverage_layer WHEN 'temporal' THEN 2 ELSE 1 END DESC,
                    observed_at DESC"#,
    )
    .bind(scope_ids)
    .bind(&domains)
    .bind(range_start)
    .bind(range_end)
    .fetch_all(&mut **transaction)
    .await?;

    let mut checkpoints: HashMap<(String, i64), CoverageAvailability> = HashMap::new();
    for row in checkpoint_rows {
        let domain: String = row.try_get("source_domain")?;
        let scope_id: i64 = row.try_get("reporting_scope_id")?;
        let candidate = coverage_checkpoint_candidate(
            CoverageCheckpointInput {
                evidence_layer: row.try_get("coverage_layer")?,
                window_start: row.try_get("window_start")?,
                window_end: row.try_get("window_end")?,
                coverage_state: row.try_get("coverage_state")?,
                complete_through: row.try_get("complete_through")?,
                observed_at: row.try_get("observed_at")?,
            },
            range_start,
            range_end,
        );
        let key = (domain, scope_id);
        let replace = checkpoints
            .get(&key)
            .map(|current| coverage_candidate_is_better(&candidate, current))
            .unwrap_or(true);
        if replace {
            checkpoints.insert(key, candidate);
        }
    }

    let active_backfill_rows = sqlx::query(
        r#"SELECT source_domain, reporting_scope_id, requested_range_start, requested_range_end
           FROM analytics.analytics_backfill_job
           WHERE reporting_scope_id = ANY($1::bigint[])
             AND source_domain = ANY($2::text[])
             AND job_status IN ('queued', 'running', 'paused')
             AND requested_range_end > $3
             AND requested_range_start < $4"#,
    )
    .bind(scope_ids)
    .bind(&domains)
    .bind(range_start)
    .bind(range_end)
    .fetch_all(&mut **transaction)
    .await?;
    let active_backfills: HashMap<(String, i64), CoverageAvailability> = active_backfill_rows
        .into_iter()
        .map(|row| {
            let domain = row.try_get::<String, _>("source_domain")?;
            let scope_id = row.try_get::<i64, _>("reporting_scope_id")?;
            Ok::<_, sqlx::Error>((
                (domain, scope_id),
                CoverageAvailability {
                    state: "backfilling".to_string(),
                    reason: Some("historical backfill is in progress".to_string()),
                    evidence_layer: Some("backfill".to_string()),
                    window_start: Some(row.try_get("requested_range_start")?),
                    window_end: Some(row.try_get("requested_range_end")?),
                    complete_through: None,
                    observed_at: None,
                },
            ))
        })
        .collect::<Result<_, _>>()?;

    let mut output = HashMap::new();
    for domain in domains {
        let mut per_scope = Vec::with_capacity(scope_ids.len());
        for scope_id in scope_ids {
            if let Some(backfill) = active_backfills.get(&(domain.clone(), *scope_id)) {
                per_scope.push(backfill.clone());
            } else if let Some(checkpoint) = checkpoints.get(&(domain.clone(), *scope_id)) {
                per_scope.push(checkpoint.clone());
            } else {
                per_scope.push(unknown_coverage("requested range has no temporal evidence"));
            }
        }
        output.insert(domain, combine_scope_coverage(per_scope));
    }
    Ok(output)
}

fn coverage_checkpoint_candidate(
    input: CoverageCheckpointInput,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> CoverageAvailability {
    let state = if input.coverage_state == "available"
        && input.window_start <= range_start
        && input.window_end >= range_end
        && input
            .complete_through
            .is_some_and(|complete_through| complete_through >= range_end)
    {
        "available"
    } else if input.coverage_state == "stale" {
        "stale"
    } else if input.coverage_state == "unavailable" {
        "unavailable"
    } else {
        "partial"
    };
    let reason = match state {
        "available" => None,
        "stale" => Some("temporal coverage evidence is stale".to_string()),
        "unavailable" => Some("temporal coverage evidence is unavailable".to_string()),
        _ => Some("temporal coverage does not fully cover the requested range".to_string()),
    };
    CoverageAvailability {
        state: state.to_string(),
        reason,
        evidence_layer: Some(input.evidence_layer),
        window_start: Some(input.window_start),
        window_end: Some(input.window_end),
        complete_through: input.complete_through,
        observed_at: Some(input.observed_at),
    }
}

fn coverage_candidate_is_better(
    candidate: &CoverageAvailability,
    current: &CoverageAvailability,
) -> bool {
    let candidate_layer = coverage_layer_rank(candidate.evidence_layer.as_deref());
    let current_layer = coverage_layer_rank(current.evidence_layer.as_deref());
    (candidate_layer, candidate.observed_at) > (current_layer, current.observed_at)
}

fn combine_scope_coverage(scopes: Vec<CoverageAvailability>) -> CoverageAvailability {
    let has_available = scopes.iter().any(|coverage| coverage.state == "available");
    let has_unknown = scopes.iter().any(|coverage| coverage.state == "unknown");
    let state = if scopes
        .iter()
        .any(|coverage| coverage.state == "backfilling")
    {
        "backfilling"
    } else if scopes
        .iter()
        .any(|coverage| coverage.state == "unavailable")
    {
        "unavailable"
    } else if scopes.iter().any(|coverage| coverage.state == "stale") {
        "stale"
    } else if scopes.iter().any(|coverage| coverage.state == "partial")
        || (has_available && has_unknown)
    {
        "partial"
    } else if has_available {
        "available"
    } else {
        "unknown"
    }
    .to_string();
    let reason = scopes
        .iter()
        .find(|coverage| coverage.state == state)
        .and_then(|coverage| coverage.reason.clone())
        .or_else(|| {
            (state == "partial").then(|| "one or more authorized scopes are incomplete".to_string())
        });
    let evidence_layer = scopes
        .iter()
        .filter_map(|coverage| coverage.evidence_layer.as_deref())
        .collect::<HashSet<_>>();
    let evidence_layer = match evidence_layer.len() {
        0 => None,
        1 => evidence_layer.into_iter().next().map(str::to_string),
        _ => Some("mixed".to_string()),
    };
    let window_start = scopes
        .iter()
        .filter_map(|coverage| coverage.window_start)
        .max();
    let window_end = scopes
        .iter()
        .filter_map(|coverage| coverage.window_end)
        .min();
    let complete_through = scopes
        .iter()
        .filter_map(|coverage| coverage.complete_through)
        .min();
    CoverageAvailability {
        state,
        reason,
        evidence_layer,
        window_start,
        window_end,
        complete_through,
        observed_at: None,
    }
}

fn unknown_coverage(reason: &str) -> CoverageAvailability {
    CoverageAvailability {
        state: "unknown".to_string(),
        reason: Some(reason.to_string()),
        evidence_layer: None,
        window_start: None,
        window_end: None,
        complete_through: None,
        observed_at: None,
    }
}

fn coverage_layer_rank(layer: Option<&str>) -> u8 {
    match layer {
        Some("temporal") => 2,
        Some("reconciliation") => 1,
        _ => 0,
    }
}

fn report_availability_state(
    source_state: &str,
    coverage_state: &str,
    projection_state: &str,
    has_series: bool,
) -> String {
    if coverage_state == "backfilling" {
        return "backfilling".to_string();
    }
    if projection_state == "unavailable" {
        return "unavailable".to_string();
    }
    if source_state == "available" {
        return if projection_state != "available" {
            "partial".to_string()
        } else {
            match coverage_state {
                "available" => "available".to_string(),
                "stale" => "stale".to_string(),
                "unavailable" => "unavailable".to_string(),
                _ => "partial".to_string(),
            }
        };
    }
    if source_state == "not_instrumented"
        && has_series
        && coverage_state == "available"
        && projection_state == "available"
    {
        return "available".to_string();
    }
    source_state.to_string()
}

fn projection_coverage_state(generation: Option<&GenerationInfo>) -> String {
    match generation.map(|generation| generation.processing_status.as_str()) {
        None => "unknown".to_string(),
        Some("idle") => "available".to_string(),
        Some("failed") => "unavailable".to_string(),
        Some(_) => "partial".to_string(),
    }
}

fn projection_source_coverage_state(
    coverage_values: &[Value],
    required_sources: &[String],
) -> String {
    if coverage_values.is_empty() {
        return "unknown".to_string();
    }
    let required_sources = required_sources.iter().cloned().collect::<BTreeSet<_>>();
    if coverage_values.iter().all(|coverage| {
        coverage.get("coverage_state").and_then(Value::as_str) == Some("observed")
            && coverage
                .get("required_sources")
                .and_then(Value::as_array)
                .and_then(|sources| {
                    sources
                        .iter()
                        .map(|source| Value::as_str(source).map(str::to_string))
                        .collect::<Option<BTreeSet<_>>>()
                })
                .is_some_and(|sources| sources == required_sources)
    }) {
        "available".to_string()
    } else {
        "partial".to_string()
    }
}

fn dimension_coverage_state(
    series: &[ReportPoint],
    requested_dimensions: &[String],
) -> (String, usize) {
    if requested_dimensions.is_empty() {
        return ("not_requested".to_string(), 0);
    }
    if series.is_empty() {
        return ("unknown".to_string(), 0);
    }
    let missing_points = series
        .iter()
        .filter(|point| {
            requested_dimensions.iter().any(|dimension| {
                point
                    .dimensions
                    .get(dimension)
                    .is_none_or(serde_json::Value::is_null)
            })
        })
        .count();
    if missing_points == 0 {
        ("available".to_string(), 0)
    } else {
        ("partial".to_string(), missing_points)
    }
}

struct SeriesQuery<'a> {
    generation_id: i64,
    metric: &'a MetricDefinition,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
    interval: &'a str,
    requested_scope_id: i64,
    authorized_scope_ids: &'a [i64],
    include_descendants: bool,
    breakdowns: &'a [String],
    filters: &'a BTreeMap<String, Vec<String>>,
}

struct SeriesResult {
    points: Vec<ReportPoint>,
    projection_source_state: String,
}

async fn query_metric_series(
    transaction: &mut Transaction<'_, Postgres>,
    query_spec: SeriesQuery<'_>,
) -> Result<SeriesResult, ReportingError> {
    if query_spec.metric.default_aggregation == "distinct_count" {
        return query_distinct_metric_series(transaction, &query_spec).await;
    }
    let projection = dimensions_projection("r", query_spec.breakdowns);
    let mut where_clauses = vec![
        "r.generation_id = $1".to_string(),
        "r.projection_name = $2".to_string(),
        "r.projection_version = $3".to_string(),
        "r.metric_key = $4".to_string(),
        "r.metric_version = $5".to_string(),
        "r.target_scope_id = $6".to_string(),
        "r.interval = $7".to_string(),
        "r.bucket_end > $8".to_string(),
        "r.bucket_start < $9".to_string(),
    ];
    if query_spec.include_descendants {
        where_clauses.push("r.source_scope_id = ANY($10::bigint[])".to_string());
    } else {
        where_clauses.push("r.source_scope_id = $6".to_string());
    }
    for (index, key) in query_spec.filters.keys().enumerate() {
        let parameter = if query_spec.include_descendants {
            11 + index
        } else {
            10 + index
        };
        where_clauses.push(format!(
            "r.dimensions ->> '{}' = ANY(${parameter}::text[])",
            sql_literal(key)
        ));
    }
    let group_by = format!("r.bucket_start, r.bucket_end, {projection}");
    let value_expression = match query_spec.metric.default_aggregation.as_str() {
        "ratio_of_sums" => {
            "SUM(r.numerator)::double precision / NULLIF(SUM(r.denominator)::double precision, 0)"
                .to_string()
        }
        "weighted_average" => {
            "SUM(r.value_sum)::double precision / NULLIF(SUM(r.value_count)::double precision, 0)"
                .to_string()
        }
        "count" | "distinct_count" => "SUM(r.value_count)::double precision".to_string(),
        _ => "SUM(r.value_sum)::double precision".to_string(),
    };
    let sql = format!(
        "SELECT r.bucket_start, r.bucket_end, {projection} AS dimensions, {value_expression} AS value, SUM(r.numerator)::double precision AS numerator, SUM(r.denominator)::double precision AS denominator, jsonb_agg(r.coverage) AS coverage FROM analytics.analytics_projection_rollup AS r WHERE {} GROUP BY {group_by} ORDER BY r.bucket_start, dimensions LIMIT {}",
        where_clauses.join(" AND "),
        MAX_POINTS + 1
    );
    let mut query = sqlx::query(&sql)
        .bind(query_spec.generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(&query_spec.metric.key)
        .bind(query_spec.metric.version as i32)
        .bind(query_spec.requested_scope_id)
        .bind(query_spec.interval)
        .bind(query_spec.range_start)
        .bind(query_spec.range_end);
    if query_spec.include_descendants {
        query = query.bind(query_spec.authorized_scope_ids);
    }
    for values in query_spec.filters.values() {
        query = query.bind(values);
    }
    let rows = query.fetch_all(&mut **transaction).await?;
    if rows.len() > MAX_POINTS {
        return Err(ReportingError::InvalidRequest(format!(
            "query would return more than {MAX_POINTS} points"
        )));
    }
    let mut coverage_values = Vec::with_capacity(rows.len());
    let points = rows
        .into_iter()
        .map(|row| {
            let coverage: Value = row.try_get("coverage")?;
            if let Some(values) = coverage.as_array() {
                coverage_values.extend(values.iter().cloned());
            } else {
                coverage_values.push(coverage);
            }
            Ok(ReportPoint {
                bucket_start: row.try_get("bucket_start")?,
                bucket_end: row.try_get("bucket_end")?,
                dimensions: row.try_get("dimensions")?,
                value: row.try_get("value")?,
                numerator: row.try_get("numerator")?,
                denominator: row.try_get("denominator")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(SeriesResult {
        points,
        projection_source_state: projection_source_coverage_state(
            &coverage_values,
            &query_spec.metric.coverage.required_sources,
        ),
    })
}

async fn query_distinct_metric_series(
    transaction: &mut Transaction<'_, Postgres>,
    query_spec: &SeriesQuery<'_>,
) -> Result<SeriesResult, ReportingError> {
    let projection = dimensions_projection("c", query_spec.breakdowns);
    let (bucket_start, bucket_end) = contribution_bucket_expressions(query_spec.interval);
    let mut where_clauses = vec![
        "c.generation_id = $1".to_string(),
        "c.projection_name = $2".to_string(),
        "c.projection_version = $3".to_string(),
        "c.metric_key = $4".to_string(),
        "c.metric_version = $5".to_string(),
        "c.target_scope_id = $6".to_string(),
        "c.bucket_end > $7".to_string(),
        "c.bucket_start < $8".to_string(),
        "c.deduplication_key IS NOT NULL".to_string(),
    ];
    if query_spec.include_descendants {
        where_clauses.push("c.source_scope_id = ANY($9::bigint[])".to_string());
    } else {
        where_clauses.push("c.source_scope_id = $6".to_string());
    }
    for (index, key) in query_spec.filters.keys().enumerate() {
        let parameter = if query_spec.include_descendants {
            10 + index
        } else {
            9 + index
        };
        where_clauses.push(format!(
            "c.dimensions ->> '{}' = ANY(${parameter}::text[])",
            sql_literal(key)
        ));
    }
    let sql = format!(
        "SELECT {bucket_start} AS bucket_start, {bucket_end} AS bucket_end, {projection} AS dimensions, COUNT(DISTINCT c.deduplication_key)::double precision AS value, NULL::double precision AS numerator, NULL::double precision AS denominator, jsonb_agg(c.coverage) AS coverage FROM analytics.analytics_projection_contribution AS c WHERE {} GROUP BY 1, 2, 3 ORDER BY 1, 3 LIMIT {}",
        where_clauses.join(" AND "),
        MAX_POINTS + 1
    );
    let mut query = sqlx::query(&sql)
        .bind(query_spec.generation_id)
        .bind(PROJECTION_NAME)
        .bind(PROJECTION_VERSION)
        .bind(&query_spec.metric.key)
        .bind(query_spec.metric.version as i32)
        .bind(query_spec.requested_scope_id)
        .bind(query_spec.range_start)
        .bind(query_spec.range_end);
    if query_spec.include_descendants {
        query = query.bind(query_spec.authorized_scope_ids);
    }
    for values in query_spec.filters.values() {
        query = query.bind(values);
    }
    let rows = query.fetch_all(&mut **transaction).await?;
    if rows.len() > MAX_POINTS {
        return Err(ReportingError::InvalidRequest(format!(
            "query would return more than {MAX_POINTS} points"
        )));
    }
    let mut coverage_values = Vec::with_capacity(rows.len());
    let points = rows
        .into_iter()
        .map(|row| {
            let coverage: Value = row.try_get("coverage")?;
            if let Some(values) = coverage.as_array() {
                coverage_values.extend(values.iter().cloned());
            } else {
                coverage_values.push(coverage);
            }
            Ok(ReportPoint {
                bucket_start: row.try_get("bucket_start")?,
                bucket_end: row.try_get("bucket_end")?,
                dimensions: row.try_get("dimensions")?,
                value: row.try_get("value")?,
                numerator: None,
                denominator: None,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(SeriesResult {
        points,
        projection_source_state: projection_source_coverage_state(
            &coverage_values,
            &query_spec.metric.coverage.required_sources,
        ),
    })
}

fn contribution_bucket_expressions(interval: &str) -> (String, String) {
    match interval {
        "hour" => ("c.bucket_start".to_string(), "c.bucket_end".to_string()),
        "day" => (
            "date_trunc('day', c.bucket_start AT TIME ZONE c.timezone_name) AT TIME ZONE c.timezone_name".to_string(),
            "(date_trunc('day', c.bucket_start AT TIME ZONE c.timezone_name) + INTERVAL '1 day') AT TIME ZONE c.timezone_name".to_string(),
        ),
        "month" => (
            "date_trunc('month', c.bucket_start AT TIME ZONE c.timezone_name) AT TIME ZONE c.timezone_name".to_string(),
            "(date_trunc('month', c.bucket_start AT TIME ZONE c.timezone_name) + INTERVAL '1 month') AT TIME ZONE c.timezone_name".to_string(),
        ),
        _ => unreachable!("interval was validated before the query planner"),
    }
}

fn dimensions_projection(alias: &str, breakdowns: &[String]) -> String {
    if breakdowns.is_empty() {
        return "'{}'::jsonb".to_string();
    }
    let pairs = breakdowns
        .iter()
        .map(|key| {
            format!(
                "'{}', {alias}.dimensions -> '{}'",
                sql_literal(key),
                sql_literal(key)
            )
        })
        .collect::<Vec<_>>();
    format!("jsonb_build_object({})", pairs.join(", "))
}

fn sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn metric_identity(metric: &MetricDefinition) -> String {
    format!("{}@{}", metric.key, metric.version)
}

fn metric_set_identity(set: &MetricSetDefinition) -> String {
    format!("{}@{}", set.key, set.version)
}

fn expected_points(start: &DateTime<Utc>, end: &DateTime<Utc>, interval: &str) -> usize {
    let seconds = (end.timestamp() - start.timestamp()).max(1) as f64;
    let width = match interval {
        "hour" => 3_600.0,
        "day" => 86_400.0,
        "month" => 2_629_800.0,
        _ => 86_400.0,
    };
    (seconds / width).ceil() as usize
}

fn availability_rank(state: &str) -> u8 {
    match state {
        "unavailable" => 8,
        "backfilling" => 7,
        "stale" => 6,
        "partial" => 5,
        "unsupported" => 4,
        "not_instrumented" => 3,
        "not_applicable" => 2,
        "available" => 1,
        _ => 0,
    }
}

fn max_datetime(
    left: Option<DateTime<Utc>>,
    right: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AnalyticsConfig;
    use actix_web::{test as actix_test, web, App};
    use jwt_simple::{
        algorithms::ECDSAP256KeyPairLike,
        prelude::{Claims, Duration as JwtDuration, ES256KeyPair},
    };
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryCacheBackend {
        values: Mutex<BTreeMap<String, String>>,
    }

    #[async_trait]
    impl CacheBackend for MemoryCacheBackend {
        async fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self
                .values
                .lock()
                .expect("memory cache lock")
                .get(key)
                .cloned())
        }

        async fn set(&self, key: &str, value: &str, _ttl_seconds: u64) -> Result<(), String> {
            self.values
                .lock()
                .expect("memory cache lock")
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
    }

    struct FailingCacheBackend;

    #[async_trait]
    impl CacheBackend for FailingCacheBackend {
        async fn get(&self, _key: &str) -> Result<Option<String>, String> {
            Err("redis unavailable".to_string())
        }

        async fn set(&self, _key: &str, _value: &str, _ttl_seconds: u64) -> Result<(), String> {
            Err("redis unavailable".to_string())
        }
    }

    fn memory_cache(backend: Arc<dyn CacheBackend>) -> ReportingCache {
        ReportingCache {
            backend: Some(backend),
            ttl_seconds: REPORT_CACHE_TTL_SECONDS,
        }
    }

    fn sample_response() -> ReportResponse {
        let start = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        ReportResponse {
            scope_id: 1,
            scope_kind: "core_organization".to_string(),
            range_start: start,
            range_end: start + Duration::days(1),
            interval: "day".to_string(),
            timezone: "UTC".to_string(),
            generated_at: start,
            data_as_of: Some(start),
            generation_id: Some(7),
            projection_version: PROJECTION_VERSION.to_string(),
            registry_sha256: "registry".to_string(),
            metrics: Vec::new(),
            comparison: None,
        }
    }

    fn sample_grant() -> ReportingGrant {
        let issued_at = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        ReportingGrant {
            grant_id: "grant-1".to_string(),
            issuer: "kasitek-core".to_string(),
            audience: "kasitek-analytics-reporting".to_string(),
            principal_type: PrincipalType::User,
            principal_id: "user-1".to_string(),
            scope_id: 1,
            root_scope_id: 1,
            descendant_mode: DescendantMode::None,
            explicit_descendant_scope_ids: Vec::new(),
            permissions: BTreeSet::from([REPORTING_PERMISSION.to_string()]),
            metric_keys: Vec::new(),
            dimension_keys: Vec::new(),
            policy_version: "v1".to_string(),
            issued_at,
            not_before: issued_at,
            expires_at: issued_at + Duration::minutes(1),
            correlation_id: None,
            revoked_at: None,
        }
    }

    fn sample_scope() -> AuthorizedScope {
        AuthorizedScope {
            requested_scope_id: 1,
            authorized_scope_ids: vec![1],
            scope_kind: "core_organization".to_string(),
            timezone: "UTC".to_string(),
        }
    }

    fn sample_request() -> ReportQueryRequest {
        let start = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        ReportQueryRequest {
            reporting_scope_id: 1,
            range_start: start,
            range_end: start + Duration::days(1),
            timezone: "UTC".to_string(),
            interval: Some("day".to_string()),
            metrics: vec!["agent.runs.completed@1".to_string()],
            metric_set: None,
            breakdowns: Vec::new(),
            filters: BTreeMap::new(),
            include_descendants: false,
            comparison: None,
        }
    }

    #[test]
    fn temporal_coverage_requires_a_complete_boundary_for_available_state() {
        let range_start = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        let range_end = range_start + Duration::days(1);
        let available = coverage_checkpoint_candidate(
            CoverageCheckpointInput {
                evidence_layer: "temporal".to_string(),
                window_start: range_start,
                window_end: range_end,
                coverage_state: "available".to_string(),
                complete_through: Some(range_end),
                observed_at: range_end,
            },
            range_start,
            range_end,
        );
        assert_eq!(available.state, "available");

        let incomplete = coverage_checkpoint_candidate(
            CoverageCheckpointInput {
                evidence_layer: "temporal".to_string(),
                window_start: range_start,
                window_end: range_end,
                coverage_state: "available".to_string(),
                complete_through: None,
                observed_at: range_end,
            },
            range_start,
            range_end,
        );
        assert_eq!(incomplete.state, "partial");
    }

    #[test]
    fn missing_authorized_scope_coverage_downgrades_the_aggregate() {
        let unknown = unknown_coverage("unused");
        let mut complete = unknown.clone();
        complete.state = "available".to_string();
        complete.evidence_layer = Some("temporal".to_string());
        let combined = combine_scope_coverage(vec![complete, unknown]);
        assert_eq!(combined.state, "partial");
        assert_eq!(
            report_availability_state("available", &combined.state, "available", true),
            "partial"
        );
    }

    #[test]
    fn active_backfill_dominates_completed_coverage() {
        assert_eq!(
            report_availability_state("available", "backfilling", "available", true),
            "backfilling"
        );
        assert_eq!(
            report_availability_state("available", "available", "unavailable", true),
            "unavailable"
        );
    }

    #[test]
    fn projection_processing_status_maps_to_a_separate_layer_state() {
        let generation = GenerationInfo {
            generation_id: 1,
            projection_version: PROJECTION_VERSION.to_string(),
            registry_sha256: "registry".to_string(),
            processing_status: "idle".to_string(),
        };
        assert_eq!(projection_coverage_state(Some(&generation)), "available");
        let mut rebuilding = generation.clone();
        rebuilding.processing_status = "rebuilding".to_string();
        assert_eq!(projection_coverage_state(Some(&rebuilding)), "partial");
        assert_eq!(projection_coverage_state(None), "unknown");
    }

    #[test]
    fn projection_source_coverage_requires_observed_matching_metadata() {
        let required = vec!["agent.run.completed@1".to_string()];
        let observed = json!({
            "coverage_state": "observed",
            "required_sources": ["agent.run.completed@1"]
        });
        assert_eq!(
            projection_source_coverage_state(&[observed], &required),
            "available"
        );
        assert_eq!(
            projection_source_coverage_state(&[json!({"coverage_state": "observed"})], &required),
            "partial"
        );
        assert_eq!(
            projection_source_coverage_state(
                &[json!({
                    "coverage_state": "observed",
                    "required_sources": ["other.source@1"]
                })],
                &required
            ),
            "partial"
        );
        assert_eq!(projection_source_coverage_state(&[], &required), "unknown");
    }

    #[test]
    fn missing_requested_dimension_values_are_partial() {
        let point = ReportPoint {
            bucket_start: Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap(),
            bucket_end: Utc.with_ymd_and_hms(2026, 8, 2, 0, 0, 0).unwrap(),
            dimensions: json!({"channel": null}),
            value: Some(1.0),
            numerator: None,
            denominator: None,
        };
        assert_eq!(
            dimension_coverage_state(&[point], &["channel".to_string()]),
            ("partial".to_string(), 1)
        );
        assert_eq!(
            dimension_coverage_state(&[], &["channel".to_string()]),
            ("unknown".to_string(), 0)
        );
        assert_eq!(
            dimension_coverage_state(&[], &[]),
            ("not_requested".to_string(), 0)
        );
    }

    fn config(public_key: Option<&str>) -> AnalyticsConfig {
        AnalyticsConfig::from_lookup(|name| match name {
            "ANALYTICS_DATABASE_URL" => Some("postgres://localhost/analytics".to_string()),
            "ANALYTICS_REPORTING_PUBLIC_KEY" => public_key.map(str::to_string),
            _ => None,
        })
        .expect("config")
    }

    #[test]
    fn rejects_missing_reporting_keys_by_rejecting_every_token() {
        let access = ReportingAuthenticator::from_config(&config(None)).expect("authenticator");
        let request = actix_web::test::TestRequest::default()
            .insert_header(("Authorization", "Bearer invalid"))
            .to_http_request();
        assert!(matches!(
            access.authenticate(&request),
            Err(ReportingError::Unauthorized)
        ));
    }

    #[test]
    fn verifies_es256_grant_claims_and_enforces_the_short_lifetime() {
        let pair = ES256KeyPair::generate();
        let claims = Claims::with_custom_claims(
            ReportingGrantClaims {
                principal_type: PrincipalType::User,
                scope_id: 1,
                root_scope_id: 1,
                descendant_mode: DescendantMode::None,
                explicit_descendant_scope_ids: Vec::new(),
                permissions: BTreeSet::from([REPORTING_PERMISSION.to_string()]),
                metric_keys: Vec::new(),
                dimension_keys: Vec::new(),
                policy_version: "v1".to_string(),
                correlation_id: None,
            },
            JwtDuration::from_secs(30),
        )
        .with_issuer("kasitek-core")
        .with_audience("kasitek-analytics-reporting")
        .with_subject("user-1")
        .with_jwt_id("grant-1");
        let token = pair.sign(claims).expect("token");
        let mut config = config(Some(&pair.public_key().to_pem().expect("pem")));
        config.reporting_audience = "kasitek-analytics-reporting".to_string();
        let access = ReportingAuthenticator::from_config(&config).expect("authenticator");
        let grant = access.authenticate_token(&token).expect("grant");
        assert_eq!(grant.grant_id, "grant-1");
        assert_eq!(grant.scope_id, 1);
    }

    #[test]
    fn bounds_report_requests_before_query_planning() {
        let request = ReportQueryRequest {
            reporting_scope_id: 1,
            range_start: Utc::now(),
            range_end: Utc::now() + Duration::days(MAX_RANGE_DAYS + 1),
            timezone: "UTC".to_string(),
            interval: None,
            metrics: vec!["agent.runs.completed@1".to_string()],
            metric_set: None,
            breakdowns: Vec::new(),
            filters: BTreeMap::new(),
            include_descendants: false,
            comparison: None,
        };
        assert!(matches!(
            validate_request_shape(&request),
            Err(ReportingError::InvalidRequest(_))
        ));
    }

    #[test]
    fn supports_equal_previous_period_ranges_and_rejects_unknown_comparisons() {
        let mut request = sample_request();
        request.comparison = Some(ComparisonRequest {
            kind: "previous_period".to_string(),
        });
        let (previous_start, previous_end) =
            previous_period_range(&request, request.comparison.as_ref().expect("comparison"))
                .expect("previous period");
        assert_eq!(previous_end, request.range_start);
        assert_eq!(
            previous_end - previous_start,
            request.range_end - request.range_start
        );
        assert!(validate_request_shape(&request).is_ok());

        request.comparison = Some(ComparisonRequest {
            kind: "rolling_window".to_string(),
        });
        assert!(matches!(
            validate_request_shape(&request),
            Err(ReportingError::InvalidRequest(message)) if message.contains("not supported")
        ));
    }

    #[test]
    fn report_cache_key_separates_authorization_and_query_identity() {
        let grant = sample_grant();
        let scope = sample_scope();
        let request = sample_request();
        let first = report_cache_key(
            &grant,
            &scope,
            &request,
            Some(7),
            PROJECTION_VERSION,
            "registry",
        );

        let mut other_grant = grant.clone();
        other_grant.grant_id = "grant-2".to_string();
        assert_ne!(
            first,
            report_cache_key(
                &other_grant,
                &scope,
                &request,
                Some(7),
                PROJECTION_VERSION,
                "registry",
            )
        );

        let mut other_scope = scope.clone();
        other_scope.authorized_scope_ids = vec![1, 2];
        assert_ne!(
            first,
            report_cache_key(
                &grant,
                &other_scope,
                &request,
                Some(7),
                PROJECTION_VERSION,
                "registry",
            )
        );

        let mut comparison_request = request;
        comparison_request.comparison = Some(ComparisonRequest {
            kind: "previous_period".to_string(),
        });
        assert_ne!(
            first,
            report_cache_key(
                &grant,
                &scope,
                &comparison_request,
                Some(7),
                PROJECTION_VERSION,
                "registry",
            )
        );
    }

    #[tokio::test]
    async fn report_cache_returns_hit_and_expired_entries_fall_back() {
        let backend = Arc::new(MemoryCacheBackend::default());
        let cache = memory_cache(backend.clone());
        let response = sample_response();
        cache
            .write("hit", &response, REPORT_CACHE_TTL_SECONDS)
            .await;
        assert!(matches!(cache.read("hit").await, CacheRead::Hit(value) if value.scope_id == 1));

        backend.values.lock().expect("memory cache lock").insert(
            "stale".to_string(),
            serde_json::to_string(&CachedReport {
                cached_at: Utc::now() - Duration::seconds(REPORT_CACHE_TTL_SECONDS as i64 + 1),
                response,
            })
            .expect("cached response"),
        );
        assert!(matches!(cache.read("stale").await, CacheRead::Stale));
    }

    #[tokio::test]
    async fn unavailable_cache_backend_is_non_authoritative() {
        let cache = memory_cache(Arc::new(FailingCacheBackend));
        assert!(matches!(
            cache.read("missing").await,
            CacheRead::Unavailable
        ));
        cache.write("missing", &sample_response(), 10).await;
    }

    #[tokio::test]
    async fn configured_redis_cache_backend_round_trips() {
        let Ok(redis_url) = std::env::var("ANALYTICS_REDIS_URL") else {
            return;
        };
        if redis_url.trim().is_empty() {
            return;
        }

        let client = redis::Client::open(redis_url).expect("configured Redis URL");
        let backend = RedisCacheBackend::new(client);
        let key = format!("kasitek:test:analytics-cache:{}", std::process::id());
        backend
            .set(&key, "redis-round-trip", 30)
            .await
            .expect("Redis cache write");
        assert_eq!(
            backend.get(&key).await.expect("Redis cache read"),
            Some("redis-round-trip".to_string())
        );

        let mut connection = backend.connection().await.expect("Redis connection");
        let _: () = connection.del(&key).await.expect("Redis cache cleanup");
    }

    #[actix_web::test]
    async fn reporting_routes_reject_requests_without_a_signed_grant() {
        let registry = crate::registry::load_registry().expect("registry");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/analytics")
            .expect("lazy pool");
        let access = ReportingAuthenticator::from_config(&config(None)).expect("authenticator");
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool))
                .app_data(web::Data::new(registry))
                .app_data(web::Data::new(access))
                .configure(configure),
        )
        .await;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/v1/metrics/catalog?reporting_scope_id=1")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::UNAUTHORIZED);
    }
}
