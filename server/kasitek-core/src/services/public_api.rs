//! Durable public API request accounting.
//!
//! Requests are reserved before a handler runs and finalized by the `/v1`
//! middleware. The reservation is what makes the rate limit safe across
//! multiple core processes instead of relying on an in-memory counter.

use actix_web::{
    dev::ServiceRequest,
    dev::ServiceResponse,
    http::header::{HeaderName, HeaderValue},
    middleware::Next,
    Error, HttpMessage,
};
use sqlx::PgPool;

use crate::{
    bootstrap::state::AppState, error::AppError, identity::request_context::RequestContext,
};

#[derive(Clone, Debug)]
pub struct RequestAuditHandle {
    pub id: String,
    pub action: Option<String>,
    pub rate_limit: u32,
    pub rate_remaining: u32,
    pub rate_reset_seconds: u32,
    pub correlation_id: Option<String>,
}

/// Request-scoped correlation id installed before authentication so even
/// rejected public requests can be traced by the caller and in server logs.
#[derive(Clone, Debug)]
pub struct PublicCorrelationId(pub String);

/// A deployment can turn off a route without rebuilding the core binary. The
/// value is a comma-separated list of exact `/v1/...` paths; an empty or
/// missing value leaves every route enabled.
pub fn route_enabled(path: &str) -> bool {
    !std::env::var("PUBLIC_API_DISABLED_ROUTES")
        .ok()
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .any(|entry| entry == path)
        })
}

/// Apply the standard deprecation contract when an operator has configured a
/// sunset. Routes are selected by `PUBLIC_API_DEPRECATED_ROUTES`; the sunset
/// date and documentation link are supplied by `PUBLIC_API_SUNSET` and
/// `PUBLIC_API_DEPRECATION_LINK` respectively.
fn apply_deprecation_headers(path: &str, headers: &mut actix_web::http::header::HeaderMap) {
    let selected = std::env::var("PUBLIC_API_DEPRECATED_ROUTES")
        .ok()
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .any(|entry| entry == path)
        });
    if !selected {
        return;
    }
    headers.insert(
        HeaderName::from_static("deprecation"),
        HeaderValue::from_static("true"),
    );
    if let Ok(sunset) = std::env::var("PUBLIC_API_SUNSET") {
        if let Ok(value) = HeaderValue::from_str(sunset.trim()) {
            headers.insert(HeaderName::from_static("sunset"), value);
        }
    }
    if let Ok(link) = std::env::var("PUBLIC_API_DEPRECATION_LINK") {
        if let Ok(value) = HeaderValue::from_str(link.trim()) {
            headers.insert(HeaderName::from_static("link"), value);
        }
    }
}

pub async fn begin_request(
    pool: &PgPool,
    limit_per_minute: u32,
    context: &RequestContext,
    method: &str,
    route: &str,
) -> Result<RequestAuditHandle, AppError> {
    let principal_type = match context.principal.kind {
        crate::identity::principal::PrincipalKind::AgentInstallation => "agent_installation",
        crate::identity::principal::PrincipalKind::DirectUser => "direct_user",
        _ => "unknown",
    };
    let mut transaction = pool.begin().await?;
    let lock_key = format!("{}:{}", context.organization_id, context.principal.id);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(lock_key)
        .execute(&mut *transaction)
        .await?;
    let recent_requests: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM "PublicApiRequest"
        WHERE "orgId" = $1
          AND "principalId" = $2
          AND "createdAt" >= NOW() - INTERVAL '1 minute'
        "#,
    )
    .bind(&context.organization_id)
    .bind(&context.principal.id)
    .fetch_one(&mut *transaction)
    .await?;
    if recent_requests >= i64::from(limit_per_minute) {
        transaction.rollback().await?;
        return Err(AppError::TooManyRequests(
            "Public API rate limit exceeded; retry in a minute".to_string(),
        ));
    }

    let id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "PublicApiRequest"
            ("id", "orgId", "principalType", "principalId", "route", "method", "statusCode", "correlationId")
        VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
        "#,
    )
    .bind(&id)
    .bind(&context.organization_id)
    .bind(principal_type)
    .bind(&context.principal.id)
    .bind(route)
    .bind(method)
    .bind(&context.correlation_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO "UsageEvent"
            ("id", "orgId", "productKey", "metricKey", "quantity", "sourceType", "sourceId", "idempotencyKey", "metadata")
        VALUES ($1, $2, 'workspace', $3, 1, 'public_api', $4, $5, $6)
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&context.organization_id)
    .bind(crate::services::billing::meters::PUBLIC_API_REQUESTS)
    .bind(&id)
    .bind(format!("public-api:{id}"))
    .bind(serde_json::json!({
        "principalType": principal_type,
        "route": route,
        "method": method,
    }))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(RequestAuditHandle {
        id,
        action: None,
        rate_limit: limit_per_minute,
        rate_remaining: limit_per_minute.saturating_sub(recent_requests as u32 + 1),
        // The budget is a rolling one-minute window. This bounded value is
        // intentionally expressed as seconds until the next possible reset;
        // the exact oldest-request timestamp is not exposed to clients.
        rate_reset_seconds: 60,
        correlation_id: context.correlation_id.clone(),
    })
}

pub async fn finish_request(
    pool: &PgPool,
    handle: &RequestAuditHandle,
    status_code: u16,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "PublicApiRequest"
        SET "statusCode" = $2, "action" = COALESCE($3, "action"), "updatedAt" = NOW()
        WHERE "id" = $1
        "#,
    )
    .bind(&handle.id)
    .bind(i32::from(status_code))
    .bind(handle.action.as_deref())
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns a one-hour, principal-scoped public API readout. It deliberately
/// excludes request paths, payloads, and other organization data so the
/// endpoint is safe for an authenticated installation to inspect its own use.
pub async fn metrics(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<serde_json::Value, AppError> {
    let (total, successful, client_errors, server_errors, in_flight) =
        sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
            r#"
        SELECT
            COUNT(*)::BIGINT,
            COUNT(*) FILTER (WHERE "statusCode" BETWEEN 200 AND 399)::BIGINT,
            COUNT(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::BIGINT,
            COUNT(*) FILTER (WHERE "statusCode" >= 500)::BIGINT,
            COUNT(*) FILTER (WHERE "statusCode" = 0)::BIGINT
        FROM "PublicApiRequest"
        WHERE "orgId" = $1
          AND "principalId" = $2
          AND "createdAt" >= NOW() - INTERVAL '1 hour'
        "#,
        )
        .bind(&context.organization_id)
        .bind(&context.principal.id)
        .fetch_one(pool)
        .await?;
    Ok(metrics_payload(
        context,
        (total, successful, client_errors, server_errors, in_flight),
    ))
}

fn metrics_payload(
    context: &RequestContext,
    (total, successful, client_errors, server_errors, in_flight): (i64, i64, i64, i64, i64),
) -> serde_json::Value {
    serde_json::json!({
        "schema": "kasitek-public-metrics-v1",
        "windowSeconds": 3_600,
        "principal": {
            "kind": match context.principal.kind {
                crate::identity::principal::PrincipalKind::AgentInstallation => "agent_installation",
                crate::identity::principal::PrincipalKind::DirectUser => "direct_user",
                _ => "unknown",
            },
        },
        "requests": {
            "total": total,
            "successful": successful,
            "clientErrors": client_errors,
            "serverErrors": server_errors,
            "inFlight": in_flight,
        },
    })
}

/// Captures the outcome of every authenticated `/v1` request whose handler
/// called `public_context`, including authorization and downstream failures.
pub async fn middleware(
    request: ServiceRequest,
    next: Next<impl actix_web::body::MessageBody>,
) -> Result<ServiceResponse<impl actix_web::body::MessageBody>, Error> {
    let correlation_id = request
        .headers()
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
        .unwrap_or_else(cuid2::create_id);
    request
        .extensions_mut()
        .insert(PublicCorrelationId(correlation_id.clone()));

    let mut response = next.call(request).await?;
    let handle = response
        .request()
        .extensions()
        .get::<RequestAuditHandle>()
        .cloned();
    let state = response
        .request()
        .app_data::<actix_web::web::Data<AppState>>()
        .cloned();
    let public_rate_limit = state
        .as_ref()
        .map(|state| state.config.public_api_rate_limit_per_minute);
    if let (Some(handle), Some(state)) = (handle.as_ref(), state.as_ref()) {
        if let Err(error) = finish_request(&state.pool, &handle, response.status().as_u16()).await {
            log::warn!(
                "failed to finalize public API audit {}: {}",
                handle.id,
                error
            );
        }
        // Do not emit a webhook about webhook administration itself. Every
        // other authenticated request is a durable, signed event source.
        if !response.request().path().starts_with("/v1/webhooks") {
            if let Err(error) = crate::services::public_webhooks::enqueue_request_event(
                &state.pool,
                &handle.id,
                response.status().as_u16(),
            )
            .await
            {
                log::warn!(
                    "failed to enqueue public webhook event for {}: {}",
                    handle.id,
                    error
                );
            }
        }
    }

    let request_path = response.request().path().to_string();
    apply_deprecation_headers(&request_path, response.response_mut().headers_mut());

    // These headers are part of the public transport contract and are added
    // centrally so success, validation, authorization, and database errors
    // expose the same tracing/version metadata.
    response.response_mut().headers_mut().insert(
        HeaderName::from_static("x-api-version"),
        HeaderValue::from_static("v1"),
    );
    if response.headers().get("x-correlation-id").is_none() {
        if let Ok(value) = HeaderValue::from_str(&correlation_id) {
            response
                .response_mut()
                .headers_mut()
                .insert(HeaderName::from_static("x-correlation-id"), value);
        }
    }
    if let Some(handle) = handle {
        let headers = response.response_mut().headers_mut();
        if let Ok(value) = HeaderValue::from_str(&handle.rate_limit.to_string()) {
            headers.insert(HeaderName::from_static("x-ratelimit-limit"), value);
        }
        if let Ok(value) = HeaderValue::from_str(&handle.rate_remaining.to_string()) {
            headers.insert(HeaderName::from_static("x-ratelimit-remaining"), value);
        }
        if let Ok(value) = HeaderValue::from_str(&handle.rate_reset_seconds.to_string()) {
            headers.insert(HeaderName::from_static("x-ratelimit-reset"), value);
        }
    } else if response.status() == actix_web::http::StatusCode::TOO_MANY_REQUESTS {
        if let Some(public_rate_limit) = public_rate_limit {
            let headers = response.response_mut().headers_mut();
            if let Ok(value) = HeaderValue::from_str(&public_rate_limit.to_string()) {
                headers.insert(HeaderName::from_static("x-ratelimit-limit"), value);
            }
            headers.insert(
                HeaderName::from_static("x-ratelimit-remaining"),
                HeaderValue::from_static("0"),
            );
            headers.insert(
                HeaderName::from_static("x-ratelimit-reset"),
                HeaderValue::from_static("60"),
            );
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::metrics_payload;
    use crate::identity::{
        principal::{Principal, PrincipalKind},
        request_context::RequestContext,
    };

    #[test]
    fn metrics_payload_is_principal_scoped_and_does_not_include_request_data() {
        let context = RequestContext {
            principal: Principal {
                kind: PrincipalKind::AgentInstallation,
                id: "install-1".to_string(),
                subject_user_id: None,
                client_id: Some("credential-1".to_string()),
            },
            organization_id: "org-1".to_string(),
            user_id: None,
            client_id: None,
            installation_id: Some("install-1".to_string()),
            effective_grants: Default::default(),
            correlation_id: Some("corr-1".to_string()),
            causation_id: None,
            idempotency_key: None,
        };
        let payload = metrics_payload(&context, (12, 8, 2, 1, 1));
        assert_eq!(payload["schema"], "kasitek-public-metrics-v1");
        assert_eq!(payload["principal"]["kind"], "agent_installation");
        assert_eq!(payload["requests"]["total"], 12);
        assert!(payload.get("route").is_none());
        assert!(payload.get("organizationId").is_none());
    }
}
