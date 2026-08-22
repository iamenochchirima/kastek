//! Customer reporting API and its authorization-safe query planner.
//!
//! Reporting is deliberately a read-only boundary over promoted projection generations. The
//! request is validated against the registry before SQL is assembled, and every database query
//! runs inside the grant's transaction-local RLS context. Redis and response caching belong to a
//! later slice; they must not become an alternate authorization or freshness source.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use chrono::{DateTime, Duration, TimeZone, Utc};
use jwt_simple::{
    algorithms::{ECDSAP256PublicKeyLike, ES256PublicKey},
    claims::JWTClaims,
    common::VerificationOptions,
    token::Token,
};
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComparisonRequest {
    pub kind: String,
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

#[derive(Clone, Debug, Serialize)]
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
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
pub struct ReportPoint {
    pub bucket_start: DateTime<Utc>,
    pub bucket_end: DateTime<Utc>,
    pub dimensions: Value,
    pub value: Option<f64>,
    pub numerator: Option<f64>,
    pub denominator: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AvailabilitySummary {
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CoverageSummary {
    pub state: String,
    pub included_points: usize,
    pub expected_points: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
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
    let response =
        match execute_report(&mut transaction, &registry, &grant, &authorized, &payload).await {
            Ok(response) => response,
            Err(error) => return error_response(error),
        };
    if let Err(error) = transaction.commit().await {
        return error_response(ReportingError::Database(error));
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
    if let Some(comparison) = &request.comparison {
        return Err(ReportingError::InvalidRequest(format!(
            "comparison kind {} is reserved for the comparison query slice",
            comparison.kind
        )));
    }

    let metrics = select_metrics(registry, grant, scope, request)?;
    let interval = select_interval(request, &metrics)?;
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

    let mut results = Vec::with_capacity(metrics.len());
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
        global_data_as_of = max_datetime(global_data_as_of, source.latest_timestamp);
        let mut warnings = Vec::new();
        let mut series = Vec::new();
        let mut coverage_state = if source.state == "available" {
            "available"
        } else {
            "partial"
        };
        if let Some(generation) = &generation {
            if generation.registry_sha256 != registry.sha256 {
                coverage_state = "stale";
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
            series = query_metric_series(
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
        } else {
            coverage_state = "unknown";
            warnings.push("no promoted projection generation is available".to_string());
        }
        global_data_as_of = max_datetime(
            global_data_as_of,
            series.iter().map(|point| point.bucket_end).max(),
        );
        let reported_state = if source.state == "not_instrumented" && !series.is_empty() {
            "available".to_string()
        } else {
            source.state.clone()
        };
        if reported_state != "available" {
            warnings.push(
                source
                    .reason
                    .clone()
                    .unwrap_or_else(|| format!("source availability is {}", source.state)),
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
            },
            freshness: FreshnessSummary {
                state: source.state.clone(),
                latest_source_timestamp: source.latest_timestamp,
                max_age_seconds: metric.freshness.max_age_seconds,
            },
            warnings,
            series,
        });
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
    Ok(())
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

async fn query_metric_series(
    transaction: &mut Transaction<'_, Postgres>,
    query_spec: SeriesQuery<'_>,
) -> Result<Vec<ReportPoint>, ReportingError> {
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
        "r.bucket_start >= $8".to_string(),
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
        "count" | "distinct_count" => "SUM(r.value_count)::double precision".to_string(),
        _ => "SUM(r.value_sum)::double precision".to_string(),
    };
    let sql = format!(
        "SELECT r.bucket_start, r.bucket_end, {projection} AS dimensions, {value_expression} AS value, SUM(r.numerator)::double precision AS numerator, SUM(r.denominator)::double precision AS denominator FROM analytics.analytics_projection_rollup AS r WHERE {} GROUP BY {group_by} ORDER BY r.bucket_start, dimensions LIMIT {}",
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
    rows.into_iter()
        .map(|row| {
            Ok(ReportPoint {
                bucket_start: row.try_get("bucket_start")?,
                bucket_end: row.try_get("bucket_end")?,
                dimensions: row.try_get("dimensions")?,
                value: row.try_get("value")?,
                numerator: row.try_get("numerator")?,
                denominator: row.try_get("denominator")?,
            })
        })
        .collect()
}

async fn query_distinct_metric_series(
    transaction: &mut Transaction<'_, Postgres>,
    query_spec: &SeriesQuery<'_>,
) -> Result<Vec<ReportPoint>, ReportingError> {
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
        "SELECT {bucket_start} AS bucket_start, {bucket_end} AS bucket_end, {projection} AS dimensions, COUNT(DISTINCT c.deduplication_key)::double precision AS value, NULL::double precision AS numerator, NULL::double precision AS denominator FROM analytics.analytics_projection_contribution AS c WHERE {} GROUP BY 1, 2, 3 ORDER BY 1, 3 LIMIT {}",
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
    rows.into_iter()
        .map(|row| {
            Ok(ReportPoint {
                bucket_start: row.try_get("bucket_start")?,
                bucket_end: row.try_get("bucket_end")?,
                dimensions: row.try_get("dimensions")?,
                value: row.try_get("value")?,
                numerator: None,
                denominator: None,
            })
        })
        .collect()
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
