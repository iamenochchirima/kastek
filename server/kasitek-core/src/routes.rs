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
        let internal_routes = include_str!("api/internal.rs");
        assert!(!product_routes.contains("scope(\"/v1\")"));
        assert!(!website_routes.contains("scope(\"/v1\")"));
        assert!(public_v1_routes.contains("scope(\"/v1\")"));
        let live_route = internal_routes
            .find("\"/conversations/live\"")
            .expect("live conversation route");
        let dynamic_conversation_route = internal_routes
            .find("\"/conversations/{conversationId}\",\n                web::get().to(agent_platform::get_conversation)")
            .expect("dynamic conversation route");
        let conversation_feed_route = internal_routes
            .find("\"/conversations/events/stream\"")
            .expect("conversation feed route");
        assert!(
            live_route < dynamic_conversation_route,
            "the literal live route must be registered before the dynamic conversation route"
        );
        assert!(
            conversation_feed_route < dynamic_conversation_route,
            "the literal conversation feed route must be registered before the dynamic conversation route"
        );
        let routes = [
            (Method::GET, "/health"),
            (Method::GET, "/v1/health"),
            (Method::GET, "/v1/whoami"),
            (Method::GET, "/v1/openapi.json"),
            (Method::PATCH, "/v1/content/posts/post-1"),
            (Method::GET, "/v1/contacts"),
            (Method::GET, "/v1/inbox/conversations"),
            (
                Method::GET,
                "/v1/inbox/conversations/conversation-1/messages",
            ),
            (Method::GET, "/v1/bookings"),
            (Method::GET, "/v1/campaigns"),
            (Method::GET, "/v1/campaigns/campaign-1"),
            (Method::GET, "/v1/templates"),
            (Method::GET, "/api/bookings"),
            (Method::POST, "/api/bookings"),
            (Method::GET, "/api/social/posts"),
            (Method::POST, "/api/webhooks/whatsapp"),
            (Method::GET, "/api/internal/agents/v1/bookings/services"),
            (Method::GET, "/api/internal/agents/v1/bookings"),
            (Method::GET, "/api/internal/agents/v1/bookings/booking-1"),
            (Method::GET, "/api/internal/agents/v1/credits/usage"),
            (Method::GET, "/api/internal/agents/v1/campaigns"),
            (Method::GET, "/api/internal/agents/v1/campaigns/campaign-1"),
            (Method::GET, "/api/internal/agents/v1/templates"),
            (Method::GET, "/api/internal/agents/v1/contacts"),
            (Method::GET, "/api/internal/agents/v1/inbox/conversations"),
            (
                Method::GET,
                "/api/internal/agents/v1/inbox/conversations/conversation-1/messages",
            ),
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
                Method::GET,
                "/api/internal/agents/v1/content/posts/post-1/publish-batch/preflight",
            ),
            (
                Method::POST,
                "/api/internal/agents/v1/content/posts/post-1/publish-batch",
            ),
            (
                Method::GET,
                "/api/internal/agents/v1/content/publish-batches/batch-1",
            ),
            (
                Method::POST,
                "/api/internal/agents/v1/content/publish-batches/batch-1/retry",
            ),
            (Method::POST, "/api/social/posts/post-1/publish-batch"),
            (Method::GET, "/api/social/posts/post-1/publish-batch"),
            (
                Method::GET,
                "/api/social/posts/post-1/publish-batch/preflight",
            ),
            (Method::POST, "/api/social/publish-batches/batch-1/retry"),
            (
                Method::DELETE,
                "/api/internal/agents/v1/content/posts/post-1",
            ),
            (Method::GET, "/api/agents"),
            (Method::POST, "/api/agents/studio"),
            (Method::GET, "/api/agents/conversations/events/stream"),
            (Method::GET, "/api/agents/integrations/mcp/oauth/callback"),
            (
                Method::GET,
                "/api/agents/integrations/google/oauth/callback",
            ),
            (Method::PATCH, "/api/agents/agent-1"),
            (Method::GET, "/api/agents/knowledge/sources/source-1"),
            (Method::GET, "/api/developers"),
            (Method::POST, "/api/agents/runs/run-1/retry"),
            (Method::POST, "/api/agents/runs/run-1/approval-group"),
            (Method::GET, "/api/admin/me"),
            (Method::GET, "/api/admin/operations/webhooks/deliveries"),
            (Method::POST, "/api/admin/operations/webhooks/replays"),
            (
                Method::POST,
                "/api/admin/operations/webhooks/replays/replay-1/approve",
            ),
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
