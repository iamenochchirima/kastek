//! Route registration for the `admin` boundary.

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
    cfg.service(
        web::scope("/api/admin")
            .route("/login", web::post().to(admin::login))
            .route("/logout", web::post().to(admin::logout))
            .route("/me", web::get().to(admin::me))
            .route(
                "/forgot-password",
                web::post().to(admin::request_password_reset),
            )
            .route("/reset-password", web::post().to(admin::reset_password))
            .route("/password", web::patch().to(admin::change_password))
            .route("/stats", web::get().to(admin::stats))
            .route("/access", web::get().to(admin::list_launch_access))
            .route("/access", web::post().to(admin::provision_launch_user))
            .route(
                "/access/{id}/resend",
                web::post().to(admin::resend_launch_access),
            )
            .route(
                "/access/{id}/revoke",
                web::post().to(admin::revoke_launch_access),
            )
            .route(
                "/billing/reconcile/paystack",
                web::post().to(admin_billing::reconcile_paystack),
            )
            .route(
                "/billing/reconciliation-issues",
                web::get().to(admin_billing::list_reconciliation_issues),
            )
            .route("/billing/catalog", web::get().to(admin_billing::catalog))
            .route(
                "/billing/products",
                web::post().to(admin_billing::upsert_product),
            )
            .route("/billing/plans", web::post().to(admin_billing::upsert_plan))
            .route(
                "/billing/entitlements",
                web::post().to(admin_billing::upsert_entitlement),
            )
            .service(
                web::scope("/billing/orgs/{orgId}/grants")
                    .route("", web::get().to(admin_billing::list_grants))
                    .route("", web::post().to(admin_billing::create_grant))
                    .route(
                        "/{grantId}/expire",
                        web::post().to(admin_billing::expire_grant),
                    ),
            )
            .service(
                web::scope("/leads")
                    .route("", web::get().to(admin_leads::list_leads))
                    .route("", web::post().to(admin_leads::create_lead))
                    .route("/{id}", web::get().to(admin_leads::get_lead))
                    .route("/{id}", web::patch().to(admin_leads::update_lead))
                    .route("/{id}", web::delete().to(admin_leads::delete_lead))
                    .route("/{id}/notes", web::post().to(admin_leads::add_note)),
            )
            .service(
                web::scope("/web-services")
                    .route("", web::get().to(admin_web_services::list))
                    .route("", web::post().to(admin_web_services::create))
                    .route("/import", web::post().to(admin_web_services::import))
                    .route("/{id}", web::get().to(admin_web_services::get))
                    .route("/{id}", web::patch().to(admin_web_services::update))
                    .route("/{id}", web::delete().to(admin_web_services::delete)),
            )
            .service(
                web::scope("/conversations")
                    .route("", web::get().to(admin_conversations::list_conversations))
                    .route(
                        "/{id}",
                        web::get().to(admin_conversations::get_conversation),
                    ),
            )
            .service(
                web::scope("/quotations")
                    .route("", web::get().to(admin_quotations::list_quotations))
                    .route("", web::post().to(admin_quotations::create_quotation))
                    .route("/{id}", web::get().to(admin_quotations::get_quotation))
                    .route("/{id}", web::patch().to(admin_quotations::update_quotation))
                    .route(
                        "/{id}",
                        web::delete().to(admin_quotations::delete_quotation),
                    ),
            )
            .service(
                web::scope("/invoices")
                    .route("", web::get().to(admin_invoices::list_invoices))
                    .route("", web::post().to(admin_invoices::create_invoice))
                    .route("/{id}", web::get().to(admin_invoices::get_invoice))
                    .route("/{id}", web::patch().to(admin_invoices::update_invoice))
                    .route(
                        "/{id}/runs/{run_id}/actions",
                        web::post().to(admin_invoices::invoice_run_action),
                    )
                    .route("/{id}", web::delete().to(admin_invoices::delete_invoice)),
            )
            .service(
                web::scope("/outreach")
                    .route("", web::get().to(admin_outreach::list_campaigns))
                    .route("", web::post().to(admin_outreach::create_campaign))
                    .route("", web::delete().to(admin_outreach::delete_all_campaigns))
                    .route("/import", web::post().to(admin_outreach::import_campaign))
                    .route(
                        "/delivery",
                        web::get().to(admin_outreach::list_delivery_logs),
                    )
                    .route("/{id}", web::get().to(admin_outreach::get_campaign))
                    .route("/{id}", web::patch().to(admin_outreach::update_campaign))
                    .route("/{id}", web::delete().to(admin_outreach::delete_campaign))
                    .route(
                        "/delivery-logs",
                        web::post().to(admin_outreach::create_delivery_logs),
                    )
                    .route("/{id}/leads", web::get().to(admin_outreach::list_leads))
                    .route("/{id}/leads", web::post().to(admin_outreach::create_lead))
                    .route(
                        "/{id}/leads/{lead_id}",
                        web::get().to(admin_outreach::get_lead),
                    )
                    .route(
                        "/{id}/leads/{lead_id}",
                        web::patch().to(admin_outreach::update_lead),
                    )
                    .route(
                        "/{id}/leads/{lead_id}",
                        web::delete().to(admin_outreach::delete_lead),
                    ),
            )
            .service(
                web::scope("/notifications")
                    .route("", web::get().to(admin_notifications::list_notifications))
                    .route("", web::post().to(admin_notifications::mark_all_read))
                    .route("/unread", web::get().to(admin_notifications::unread_count))
                    .route(
                        "/{id}",
                        web::patch().to(admin_notifications::mark_notification_read),
                    ),
            ),
    );
}
