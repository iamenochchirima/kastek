//! Route registration for the `website` boundary.

use actix_web::web;

#[allow(unused_imports)]
use crate::controllers::{
    admin, admin_billing, admin_conversations, admin_invoices, admin_leads, admin_notifications,
    admin_outreach, admin_quotations, admin_web_services, agent_internal, agent_platform, ai, auth,
    billing, bookings, calls, connections, customers, health, inbox, notifications, onboarding,
    orgs, product_tour, profile, public, public_v1, realtime, social, whatsapp, whatsapp_calls,
    workspace,
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route(
        "/api/quote-requests",
        web::post().to(public::create_quote_request),
    );
    cfg.route(
        "/api/waitlist",
        web::post().to(public::create_waitlist_entry),
    );
}
