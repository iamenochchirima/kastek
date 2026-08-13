//! Compatibility entry point for the modular route registry.

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    crate::api::product::configure(cfg);
    crate::api::public_v1::configure(cfg);
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
        let product_routes = include_str!("api/product.rs");
        let website_routes = include_str!("api/website.rs");
        let public_v1_routes = include_str!("api/public_v1.rs");
        assert!(!product_routes.contains("scope(\"/v1\")"));
        assert!(!website_routes.contains("scope(\"/v1\")"));
        assert!(public_v1_routes.contains("scope(\"/v1\")"));
        let routes = [
            (Method::GET, "/health"),
            (Method::GET, "/v1/health"),
            (Method::GET, "/v1/openapi.json"),
            (Method::PATCH, "/v1/content/posts/post-1"),
            (Method::GET, "/api/bookings"),
            (Method::POST, "/api/bookings"),
            (Method::GET, "/api/social/posts"),
            (Method::POST, "/api/webhooks/whatsapp"),
            (Method::GET, "/api/internal/agents/v1/bookings/services"),
            (Method::POST, "/api/internal/agents/v1/content/posts"),
            (
                Method::PATCH,
                "/api/internal/agents/v1/content/posts/post-1",
            ),
            (
                Method::POST,
                "/api/internal/agents/v1/content/posts/post-1/unschedule",
            ),
            (
                Method::DELETE,
                "/api/internal/agents/v1/content/posts/post-1",
            ),
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
