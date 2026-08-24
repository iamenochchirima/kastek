//! Authenticated resolution from source-owned scope references to Analytics scope IDs.
//!
//! Product services know stable external identifiers such as an organization or workspace ID,
//! while the Analytics database owns its generated scope IDs. This endpoint is private to the
//! product-to-Analytics boundary and requires a source-specific bearer credential.

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};
use serde::Deserialize;
use sqlx::FromRow;

use crate::config::ReportingResolverCredential;

pub const PATH: &str = "/internal/reporting/scopes/resolve";

#[derive(Clone)]
pub struct ScopeResolverAuthenticator {
    credentials: Vec<ReportingResolverCredential>,
}

impl ScopeResolverAuthenticator {
    pub fn new(credentials: Vec<ReportingResolverCredential>) -> Self {
        Self { credentials }
    }

    fn authenticate(&self, request: &HttpRequest) -> Option<String> {
        let source_service = request
            .headers()
            .get("x-source-service")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        let token = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        let credential = self
            .credentials
            .iter()
            .find(|credential| credential.source_service == source_service)?;
        (crate::config::hex_sha256(token.as_bytes()) == credential.token_sha256)
            .then(|| source_service.to_string())
    }
}

#[derive(Debug, Deserialize)]
pub struct ScopeResolutionQuery {
    pub scope_kind: String,
    pub external_source_id: String,
}

#[derive(Debug, FromRow, serde::Serialize)]
struct ScopeResolutionRow {
    scope_id: i64,
    scope_kind: String,
    owning_source_service: String,
    external_source_id: String,
    root_scope_id: i64,
    parent_scope_id: Option<i64>,
    reporting_timezone: String,
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource(PATH).route(web::get().to(resolve_handler)));
}

async fn resolve_handler(
    request: HttpRequest,
    query: web::Query<ScopeResolutionQuery>,
    pool: web::Data<sqlx::PgPool>,
    access: web::Data<ScopeResolverAuthenticator>,
) -> impl Responder {
    let Some(source_service) = access.authenticate(&request) else {
        return HttpResponse::Unauthorized().json(serde_json::json!({
            "error": "scope resolver authentication failed"
        }));
    };
    if query.scope_kind.trim().is_empty()
        || query.scope_kind.len() > 128
        || query.external_source_id.trim().is_empty()
        || query.external_source_id.len() > 512
    {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "scope_kind and external_source_id are required"
        }));
    }

    let row = sqlx::query_as::<_, ScopeResolutionRow>(
        r#"
        SELECT
            scope_id,
            scope_kind,
            owning_source_service,
            external_source_id,
            root_scope_id,
            parent_scope_id,
            reporting_timezone
        FROM analytics.reporting_scope
        WHERE owning_source_service = $1
          AND scope_kind = $2
          AND external_source_id = $3
          AND status = 'active'
        LIMIT 1
        "#,
    )
    .bind(&source_service)
    .bind(query.scope_kind.trim())
    .bind(query.external_source_id.trim())
    .fetch_optional(pool.get_ref())
    .await;

    match row {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().json(serde_json::json!({
            "error": "reporting scope is not available"
        })),
        Err(error) => {
            log::error!("reporting scope resolution failed: {error}");
            HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "reporting scope resolution failed"
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ScopeResolverAuthenticator;
    use crate::config::ReportingResolverCredential;
    use actix_web::test::TestRequest;

    #[test]
    fn resolver_authentication_binds_the_token_to_the_declared_source_service() {
        let access = ScopeResolverAuthenticator::new(vec![ReportingResolverCredential {
            source_service: "core".to_string(),
            token_sha256: crate::config::hex_sha256(b"secret"),
        }]);
        let request = TestRequest::default()
            .insert_header(("x-source-service", "core"))
            .insert_header(("authorization", "Bearer secret"))
            .to_http_request();
        assert_eq!(access.authenticate(&request).as_deref(), Some("core"));

        let impersonating_request = TestRequest::default()
            .insert_header(("x-source-service", "tenant-platform"))
            .insert_header(("authorization", "Bearer secret"))
            .to_http_request();
        assert!(access.authenticate(&impersonating_request).is_none());
    }
}
