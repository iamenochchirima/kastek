//! Durable public API request accounting.
//!
//! Requests are reserved before a handler runs and finalized by the `/v1`
//! middleware. The reservation is what makes the rate limit safe across
//! multiple core processes instead of relying on an in-memory counter.

use actix_web::{dev::ServiceRequest, dev::ServiceResponse, middleware::Next, Error, HttpMessage};
use sqlx::PgPool;

use crate::{
    bootstrap::state::AppState, error::AppError, identity::request_context::RequestContext,
};

#[derive(Clone, Debug)]
pub struct RequestAuditHandle {
    pub id: String,
    pub action: Option<String>,
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
    Ok(RequestAuditHandle { id, action: None })
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
    let response = next.call(request).await?;
    let handle = response
        .request()
        .extensions()
        .get::<RequestAuditHandle>()
        .cloned();
    if let (Some(handle), Some(state)) = (
        handle,
        response
            .request()
            .app_data::<actix_web::web::Data<AppState>>(),
    ) {
        if let Err(error) = finish_request(&state.pool, &handle, response.status().as_u16()).await {
            log::warn!(
                "failed to finalize public API audit {}: {}",
                handle.id,
                error
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
