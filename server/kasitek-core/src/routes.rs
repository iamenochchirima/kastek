//! Compatibility entry point for the modular route registry.

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    crate::api::product::configure(cfg);
    crate::api::internal::configure(cfg);
    crate::api::provider_webhooks::configure(cfg);
    crate::api::website::configure(cfg);
    crate::api::admin::configure(cfg);
}

#[cfg(test)]
mod tests {
    use actix_web::{http::Method, test, App};

    #[actix_web::test]
    async fn representative_legacy_routes_remain_mounted_after_split() {
        let routes = [
            (Method::GET, "/health"),
            (Method::GET, "/v1/health"),
            (Method::GET, "/v1/openapi.json"),
            (Method::GET, "/api/bookings"),
            (Method::POST, "/api/bookings"),
            (Method::GET, "/api/social/posts"),
            (Method::POST, "/api/webhooks/whatsapp"),
            (Method::POST, "/api/internal/agents/v1/content/posts"),
            (Method::GET, "/api/agents"),
            (Method::GET, "/api/admin/me"),
            (Method::POST, "/api/quote-requests"),
        ];
        let app = test::init_service(App::new().configure(super::configure)).await;
        for (method, path) in routes {
            let response = test::call_service(
                &app,
                test::TestRequest::default()
                    .method(method.clone())
                    .uri(path)
                    .to_request(),
            )
            .await;
            assert_ne!(
                response.status(),
                actix_web::http::StatusCode::NOT_FOUND,
                "route was not mounted: {method} {path}"
            );
        }
    }
}
