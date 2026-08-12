use std::collections::BTreeSet;

use actix_web::HttpRequest;
use sqlx::PgPool;

use crate::{
    error::AppError,
    identity::{principal::Principal, request_context::RequestContext},
    middleware::{extract_user, resolve_active_org_id},
};

fn optional_header(req: &HttpRequest, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
}

/// Builds direct-product context from a verified user session. Deliberately do
/// not read organization scope from a request header: the active-workspace
/// cookie is only a preference and durable membership is always rechecked.
pub async fn resolve(req: &HttpRequest, pool: &PgPool) -> Result<RequestContext, AppError> {
    let user = extract_user(req, pool).await?;
    let organization_id = resolve_active_org_id(req, pool, &user.id).await?;
    Ok(RequestContext {
        principal: Principal::direct_user(user.id.clone()),
        organization_id,
        user_id: Some(user.id),
        client_id: None,
        installation_id: None,
        effective_grants: BTreeSet::new(),
        correlation_id: optional_header(req, "x-correlation-id"),
        causation_id: optional_header(req, "x-causation-id"),
        idempotency_key: optional_header(req, "idempotency-key"),
    })
}

#[cfg(test)]
mod tests {
    use super::optional_header;
    use actix_web::test::TestRequest;

    #[test]
    fn rejects_empty_and_oversized_trace_headers() {
        let empty = TestRequest::default()
            .insert_header(("x-correlation-id", " "))
            .to_http_request();
        assert_eq!(optional_header(&empty, "x-correlation-id"), None);

        let oversized = TestRequest::default()
            .insert_header(("x-correlation-id", "a".repeat(257)))
            .to_http_request();
        assert_eq!(optional_header(&oversized, "x-correlation-id"), None);
    }
}
