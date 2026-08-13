//! Route registration for the `provider_webhooks` boundary.

use actix_web::web;

#[allow(unused_imports)]
use crate::controllers::{
    admin, admin_billing, admin_conversations, admin_invoices, admin_leads, admin_notifications,
    admin_outreach, admin_quotations, admin_web_services, agent_internal, agent_platform, ai, auth,
    billing, bookings, calls, connections, customers, health, inbox, notifications, onboarding,
    orgs, product_tour, profile, public_v1, realtime, social, whatsapp, whatsapp_calls, workspace,
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route(
        "/api/webhooks/paystack",
        web::post().to(billing::paystack_webhook),
    );
    cfg.service(
        web::scope("/api/webhooks/whatsapp")
            .route("", web::get().to(whatsapp::verify_webhook))
            .route("", web::post().to(whatsapp::receive_webhook)),
    );
    cfg.service(
        web::scope("/api/webhooks/meta")
            .route("", web::get().to(inbox::verify_meta_webhook))
            .route("", web::post().to(inbox::receive_meta_webhook)),
    );
    cfg.route(
        "/api/webhooks/tiktok",
        web::post().to(social::receive_tiktok_webhook),
    );
    cfg.service(
        web::scope("/api/webhooks/twilio")
            .route(
                "/voice",
                web::post().to(calls::receive_twilio_voice_webhook),
            )
            .route(
                "/status",
                web::post().to(calls::receive_twilio_status_webhook),
            )
            .route(
                "/browser",
                web::post().to(calls::receive_twilio_browser_webhook),
            ),
    );
}
