//! Route registration for the `website` boundary.

use actix_web::{http::Method, web};

#[allow(unused_imports)]
use crate::controllers::{
    admin, admin_billing, admin_conversations, admin_invoices, admin_leads, admin_notifications,
    admin_outreach, admin_quotations, admin_web_services, agent_internal, agent_platform, ai, auth,
    billing, bookings, calls, connections, customers, health, inbox, notifications, onboarding,
    orgs, product_tour, profile, public_v1, realtime, social, website, whatsapp, whatsapp_calls,
    workspace,
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route(
        "/api/widget/v1/loader.js",
        web::get().to(website::agent_website_chat_loader),
    );
    cfg.route(
        "/api/widget/v1/frame.html",
        web::get().to(website::agent_website_chat_frame),
    );
    cfg.route(
        "/api/widget/v1/share/{publicId}",
        web::get().to(website::agent_website_chat_share),
    );
    cfg.route(
        "/api/widget/v1/deployments/{publicId}",
        web::get().to(website::get_agent_website_chat_config),
    );
    cfg.route(
        "/api/widget/v1/deployments/{publicId}/sessions",
        web::post().to(website::create_agent_website_chat_session),
    );
    cfg.route(
        "/api/widget/v1/deployments/{publicId}/sessions",
        web::method(Method::OPTIONS).to(website::agent_website_chat_preflight),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/messages",
        web::post().to(website::send_agent_website_chat_message),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/messages",
        web::method(Method::OPTIONS).to(website::agent_website_chat_preflight),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio",
        web::post().to(website::send_agent_website_chat_audio),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio/{jobId}",
        web::get().to(website::get_agent_website_chat_audio_status),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio/{jobId}/retry",
        web::post().to(website::retry_agent_website_chat_audio),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio/{jobId}/retry",
        web::method(Method::OPTIONS).to(website::agent_website_chat_preflight),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio/{jobId}",
        web::method(Method::OPTIONS).to(website::agent_website_chat_preflight),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/audio",
        web::method(Method::OPTIONS).to(website::agent_website_chat_preflight),
    );
    cfg.route(
        "/api/widget/v1/sessions/{sessionId}/deliveries",
        web::get().to(website::list_agent_website_chat_deliveries),
    );
    cfg.route(
        "/api/quote-requests",
        web::post().to(website::create_quote_request),
    );
    cfg.service(
        web::resource("/api/waitlist")
            .app_data(web::JsonConfig::default().limit(32 * 1024))
            .route(web::post().to(website::create_waitlist_entry)),
    );
}
