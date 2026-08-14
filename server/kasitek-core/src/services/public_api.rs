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
