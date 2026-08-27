//! Core's authenticated customer-analytics reporting gateway.
//!
//! The product session and organization membership are authoritative here. Analytics receives
//! only a short-lived signed grant and the server-resolved scope ID.

use std::collections::BTreeSet;

use actix_web::{web, HttpRequest, HttpResponse};
use analytics_reporting::{
    AnalyticsReportingClient, DescendantMode, ReportQueryInput, ReportingClientError,
    ReportingGrantInput, ReportingGrantIssuer, REPORTING_AUDIENCE,
};
use cuid2::create_id;

use crate::{
    config::AppConfig,
    error::AppError,
    middleware::{extract_user, resolve_active_org_id},
    services::orgs,
};

const SOURCE_SERVICE: &str = "core";
const SCOPE_KIND: &str = "core_organization";
const REPORTING_PERMISSION: &str = "analytics:read";

fn dependencies(
    config: &AppConfig,
) -> Result<(AnalyticsReportingClient, ReportingGrantIssuer), AppError> {
    let resolver_token = config
        .analytics_reporting_resolver_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::ServiceUnavailable("Customer analytics is not configured".to_string())
        })?;
    let private_key = config
        .analytics_reporting_private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::ServiceUnavailable("Customer analytics is not configured".to_string())
        })?;
    let client = AnalyticsReportingClient::new(
        config.analytics_reporting_url.clone(),
        resolver_token,
        std::time::Duration::from_millis(u64::from(config.analytics_reporting_timeout_ms)),
    )
    .map_err(map_reporting_error)?;
    let issuer = ReportingGrantIssuer::from_pem(
        private_key,
        &config.analytics_reporting_issuer,
        if config.analytics_reporting_audience.trim().is_empty() {
            REPORTING_AUDIENCE
        } else {
            &config.analytics_reporting_audience
        },
        config.analytics_reporting_key_id.clone(),
    )
    .map_err(map_reporting_error)?;
    Ok((client, issuer))
}

async fn resolve_scope(
    client: &AnalyticsReportingClient,
    organization_id: &str,
) -> Result<analytics_reporting::ScopeResolution, AppError> {
    client
        .resolve_scope(SOURCE_SERVICE, SCOPE_KIND, organization_id)
        .await
        .map_err(map_reporting_error)
}

fn issue_grant(
    issuer: &ReportingGrantIssuer,
    user_id: &str,
    scope: &analytics_reporting::ScopeResolution,
) -> Result<String, AppError> {
    issuer
        .issue(ReportingGrantInput {
            principal_id: user_id.to_string(),
            scope_id: scope.scope_id,
            root_scope_id: scope.root_scope_id,
            descendant_mode: DescendantMode::None,
            permissions: BTreeSet::from([REPORTING_PERMISSION.to_string()]),
            metric_keys: Vec::new(),
            dimension_keys: Vec::new(),
            correlation_id: Some(format!("core-{}", create_id())),
        })
        .map_err(map_reporting_error)
}

pub async fn catalog(
    request: HttpRequest,
    config: web::Data<AppConfig>,
) -> Result<HttpResponse, AppError> {
    let pool = request
        .app_data::<web::Data<sqlx::PgPool>>()
        .ok_or_else(|| AppError::Internal("database pool is not configured".to_string()))?;
    let user = extract_user(&request, pool.get_ref()).await?;
    let organization_id = resolve_active_org_id(&request, pool.get_ref(), &user.id).await?;
    orgs::require_member(pool.get_ref(), &organization_id, &user.id).await?;
    let (client, issuer) = dependencies(&config)?;
    let scope = resolve_scope(&client, &organization_id).await?;
    let grant = issue_grant(&issuer, &user.id, &scope)?;
    let response = client
        .catalog(&grant, scope.scope_id)
        .await
        .map_err(map_reporting_error)?;
    Ok(
        HttpResponse::Ok().json(analytics_reporting::redact_scope_id(
            response,
            SCOPE_KIND,
            &organization_id,
        )),
    )
}

pub async fn query(
    request: HttpRequest,
    config: web::Data<AppConfig>,
    payload: web::Json<ReportQueryInput>,
) -> Result<HttpResponse, AppError> {
    let pool = request
        .app_data::<web::Data<sqlx::PgPool>>()
        .ok_or_else(|| AppError::Internal("database pool is not configured".to_string()))?;
    let user = extract_user(&request, pool.get_ref()).await?;
    let organization_id = resolve_active_org_id(&request, pool.get_ref(), &user.id).await?;
    orgs::require_member(pool.get_ref(), &organization_id, &user.id).await?;
    if payload.include_descendants {
        return Err(AppError::BadRequest(
            "Core organization reports do not support descendant scopes".to_string(),
        ));
    }
    let (client, issuer) = dependencies(&config)?;
    let scope = resolve_scope(&client, &organization_id).await?;
    let grant = issue_grant(&issuer, &user.id, &scope)?;
    let report = payload.into_inner().with_scope(scope.scope_id);
    let response = client
        .report(&grant, &report)
        .await
        .map_err(map_reporting_error)?;
    Ok(
        HttpResponse::Ok().json(analytics_reporting::redact_scope_id(
            response,
            SCOPE_KIND,
            &organization_id,
        )),
    )
}

fn map_reporting_error(error: ReportingClientError) -> AppError {
    match error {
        ReportingClientError::Configuration(_message) => {
            observability::tracing::error!(
                event = "dependency.unavailable",
                dependency = "customer_analytics",
                operation = "configuration",
                error_type = "configuration",
                "customer analytics gateway configuration failed"
            );
            AppError::ServiceUnavailable("Customer analytics is not configured".to_string())
        }
        ReportingClientError::Signing(_message) => {
            observability::tracing::error!(
                event = "operation.failed",
                operation = "customer_analytics.grant_signing",
                error_type = "signing",
                "customer analytics grant signing failed"
            );
            AppError::Internal("Customer analytics authorization failed".to_string())
        }
        ReportingClientError::Request(error) => {
            observability::tracing::warn!(
                event = "dependency.unavailable",
                dependency = "customer_analytics",
                operation = "request",
                error_type = %std::any::type_name_of_val(&error),
                "customer analytics request failed"
            );
            AppError::ServiceUnavailable(
                "Customer analytics is temporarily unavailable".to_string(),
            )
        }
        ReportingClientError::Upstream {
            status,
            body: _body,
        } => {
            observability::tracing::warn!(
                event = "provider.call.failed",
                provider = "customer_analytics",
                operation = "report",
                status,
                "customer analytics upstream rejected gateway request"
            );
            if status == 400 || status == 422 {
                AppError::BadRequest("Customer analytics rejected the report request".to_string())
            } else if status == 401 || status == 403 {
                AppError::BadGateway("Customer analytics authorization failed".to_string())
            } else if status == 404 {
                AppError::ServiceUnavailable("Customer analytics scope is not ready".to_string())
            } else {
                AppError::ServiceUnavailable(
                    "Customer analytics is temporarily unavailable".to_string(),
                )
            }
        }
        ReportingClientError::InvalidResponse(_message) => {
            observability::tracing::error!(
                event = "provider.call.failed",
                provider = "customer_analytics",
                operation = "report",
                error_type = "invalid_response",
                "customer analytics returned invalid response"
            );
            AppError::BadGateway("Customer analytics returned an invalid response".to_string())
        }
    }
}
