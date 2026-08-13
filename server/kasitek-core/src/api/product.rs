//! Route registration for the `product` boundary.

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
    cfg.route("/", web::get().to(health::root));
    cfg.route("/health", web::get().to(health::health_check));
    cfg.service(
        web::scope("/v1")
            .route("/health", web::get().to(public_v1::health))
            .route("/openapi.json", web::get().to(public_v1::openapi))
            .route("/capabilities", web::get().to(public_v1::capabilities))
            .route(
                "/content/posts",
                web::get().to(public_v1::list_content_posts),
            )
            .route(
                "/content/posts",
                web::post().to(public_v1::create_content_draft),
            )
            .route(
                "/content/posts/{id}",
                web::get().to(public_v1::get_content_post),
            ),
    );
    cfg.route("/api/workspace/summary", web::get().to(workspace::summary));
    cfg.service(
        web::scope("/api/calls")
            .route("", web::get().to(calls::list_calls))
            .route("/summary", web::get().to(calls::call_summary))
            .route("/providers", web::get().to(calls::provider_status))
            .route(
                "/twilio/browser-token",
                web::post().to(calls::twilio_browser_token),
            )
            .route(
                "/providers/twilio/connections",
                web::post().to(calls::create_twilio_connection),
            ),
    );
    cfg.service(web::scope("/api/customers").route("/{id}", web::get().to(customers::get)));
    cfg.service(
        web::scope("/api/billing")
            .route("/summary", web::get().to(billing::summary))
            .route("/plans", web::get().to(billing::plans))
            .route("/checkout", web::post().to(billing::checkout))
            .route(
                "/checkout/{reference}/verify",
                web::post().to(billing::verify_checkout),
            )
            .route(
                "/subscriptions/{id}/{action}",
                web::post().to(billing::set_subscription_enabled),
            ),
    );
    cfg.service(
        web::scope("/api/orgs")
            .route("", web::get().to(orgs::list_orgs))
            .route("", web::post().to(orgs::create_org))
            .route("/{id}", web::get().to(orgs::get_org))
            .route("/{id}", web::patch().to(orgs::update_org))
            .route("/{id}", web::delete().to(orgs::delete_org))
            .route("/{id}/members", web::get().to(orgs::list_members))
            .route(
                "/{id}/members/{userId}",
                web::patch().to(orgs::update_member),
            )
            .route(
                "/{id}/members/{userId}",
                web::delete().to(orgs::remove_member),
            )
            .route("/{id}/invitations", web::get().to(orgs::list_invitations))
            .route("/{id}/invitations", web::post().to(orgs::invite_member))
            .route(
                "/{id}/invitations/{invId}",
                web::delete().to(orgs::revoke_invitation),
            ),
    );
    cfg.service(
        web::scope("/api/invitations")
            .route("/{token}", web::get().to(orgs::get_invitation_preview))
            .route(
                "/{token}/activate",
                web::post().to(orgs::activate_invitation),
            )
            .route("/{token}/accept", web::post().to(orgs::accept_invitation)),
    );
    cfg.service(
        web::scope("/api/auth")
            .route("/signup", web::post().to(auth::signup))
            .route("/login", web::post().to(auth::login))
            .route("/logout", web::post().to(auth::logout))
            .route("/me", web::get().to(auth::me))
            .route("/google/start", web::get().to(auth::start_google_oauth))
            .route(
                "/google/callback",
                web::get().to(auth::google_oauth_callback),
            )
            .route("/account-check", web::post().to(auth::account_check))
            .route(
                "/resend-verification",
                web::post().to(auth::resend_verification),
            )
            .route("/send-otp", web::post().to(auth::send_otp))
            .route("/verify-otp", web::post().to(auth::verify_otp))
            .route("/verify-email", web::get().to(auth::verify_email))
            .route(
                "/request-password-setup",
                web::post().to(auth::request_password_setup),
            )
            .route("/set-password", web::post().to(auth::set_password)),
    );
    cfg.service(
        web::scope("/api/profile")
            .route("", web::get().to(profile::get))
            .route("", web::patch().to(profile::patch))
            .route("/email", web::post().to(profile::request_email_change))
            .route("/email/verify", web::get().to(profile::verify_email_change))
            .route("/password", web::patch().to(profile::change_password)),
    );
    cfg.service(
        web::scope("/api/onboarding")
            .route("", web::get().to(onboarding::get))
            .route("", web::patch().to(onboarding::update))
            .route("/phone", web::post().to(profile::save_onboarding_phone)),
    );
    cfg.service(
        web::scope("/api/product-tour")
            .route("", web::get().to(product_tour::get))
            .route("", web::patch().to(product_tour::update)),
    );
    cfg.service(
        web::scope("/api/notifications")
            .route("", web::get().to(notifications::list))
            .route("", web::post().to(notifications::action))
            .route("/unread", web::get().to(notifications::unread))
            .route("/push", web::get().to(notifications::push_status))
            .route(
                "/push/subscribe",
                web::post().to(notifications::push_subscribe),
            )
            .route(
                "/push/unsubscribe",
                web::post().to(notifications::push_unsubscribe),
            )
            .route("/push/test", web::post().to(notifications::push_test))
            .route("/{id}", web::patch().to(notifications::mark_read)),
    );
    cfg.service(
        web::scope("/api/connections")
            .route("", web::get().to(connections::list))
            .route("/{id}/status", web::patch().to(connections::update_status)),
    );
    cfg.service(
        web::scope("/api/social")
            .service(
                web::scope("/oauth")
                    .route("/meta/start", web::get().to(social::start_meta_oauth))
                    .route("/meta/callback", web::get().to(social::meta_oauth_callback))
                    .route(
                        "/instagram/start",
                        web::get().to(social::start_instagram_oauth),
                    )
                    .route(
                        "/instagram/callback",
                        web::get().to(social::instagram_oauth_callback),
                    )
                    .route("/x/start", web::get().to(social::start_x_oauth))
                    .route("/x/callback", web::get().to(social::x_oauth_callback))
                    .route(
                        "/linkedin/start",
                        web::get().to(social::start_linkedin_oauth),
                    )
                    .route(
                        "/linkedin/callback",
                        web::get().to(social::linkedin_oauth_callback),
                    )
                    .route("/threads/start", web::get().to(social::start_threads_oauth))
                    .route(
                        "/threads/callback",
                        web::get().to(social::threads_oauth_callback),
                    )
                    .route(
                        "/threads/uninstall",
                        web::post().to(social::threads_uninstall_callback),
                    )
                    .route(
                        "/threads/data-deletion",
                        web::post().to(social::threads_data_deletion_callback),
                    )
                    .route(
                        "/threads/data-deletion/status/{confirmation_code}",
                        web::get().to(social::threads_data_deletion_status),
                    )
                    .route("/tiktok/start", web::get().to(social::start_tiktok_oauth))
                    .route(
                        "/tiktok/callback",
                        web::get().to(social::tiktok_oauth_callback),
                    )
                    .route(
                        "/bluesky/client-metadata",
                        web::get().to(social::bluesky_client_metadata),
                    )
                    .route(
                        "/bluesky/readiness",
                        web::get().to(social::bluesky_oauth_readiness),
                    )
                    .route("/bluesky/start", web::get().to(social::start_bluesky_oauth))
                    .route(
                        "/bluesky/callback",
                        web::get().to(social::bluesky_oauth_callback),
                    ),
            )
            .service(
                web::scope("/ai")
                    .route("/ideas", web::post().to(ai::social_ideas))
                    .route("/caption", web::post().to(ai::social_caption)),
            )
            .service(
                web::scope("/channels")
                    .route("", web::get().to(social::list_channels))
                    .route("", web::post().to(social::create_channel))
                    .route(
                        "/{id}/identity",
                        web::post().to(social::refresh_channel_identity),
                    )
                    .route(
                        "/{id}/tiktok-creator-info",
                        web::get().to(social::tiktok_creator_info),
                    )
                    .route("/{id}", web::patch().to(social::update_channel))
                    .route("/{id}", web::delete().to(social::delete_channel)),
            )
            .service(
                web::scope("/posts")
                    .route("", web::get().to(social::list_posts))
                    .route("", web::post().to(social::create_post))
                    .route("/{id}", web::get().to(social::get_post))
                    .route("/{id}", web::patch().to(social::update_post))
                    .route("/{id}", web::delete().to(social::delete_post))
                    .route("/{id}/publish", web::post().to(social::publish_post)),
            )
            .service(
                web::scope("/publish-jobs")
                    .route("/{id}", web::patch().to(social::update_publish_job)),
            ),
    );
    cfg.service(
        web::scope("/api/bookings")
            .route("", web::get().to(bookings::list_bookings))
            .route("", web::post().to(bookings::create_booking))
            .route("/{id}", web::patch().to(bookings::update_booking))
            .service(
                web::scope("/services")
                    .route("", web::get().to(bookings::list_services))
                    .route("", web::post().to(bookings::create_service))
                    .route("/{id}", web::patch().to(bookings::update_service)),
            ),
    );
    cfg.service(
        web::scope("/api/inbox")
            .route("/conversations", web::get().to(inbox::list_conversations))
            .route("/{id}/messages", web::get().to(inbox::list_messages))
            .route("/{id}/messages", web::post().to(inbox::send_message))
            .route(
                "/{id}/messages/{message_id}/retry",
                web::post().to(inbox::retry_message),
            )
            .route(
                "/messages/{message_id}/attachments/{attachment_id}",
                web::get().to(inbox::download_attachment),
            )
            .route("/{id}/read", web::post().to(inbox::mark_read)),
    );
    cfg.service(
        web::scope("/api/whatsapp")
            .service(
                web::scope("/connections")
                    .route("", web::get().to(whatsapp::list_connections))
                    .route("", web::post().to(whatsapp::create_connection))
                    .route(
                        "/{id}/token",
                        web::post().to(whatsapp::update_connection_token),
                    )
                    .route(
                        "/{id}/refresh",
                        web::post().to(whatsapp::refresh_connection),
                    )
                    .route("/{id}/health", web::get().to(whatsapp::connection_health))
                    .route(
                        "/{id}/templates/sync",
                        web::post().to(whatsapp::sync_connection_templates),
                    ),
            )
            .service(
                web::scope("/onboarding")
                    .route("/complete", web::post().to(whatsapp::complete_onboarding)),
            )
            .service(
                web::scope("/contacts")
                    .route("", web::get().to(whatsapp::list_contacts))
                    .route("/import", web::post().to(whatsapp::import_contacts))
                    .route(
                        "/lists/{label}/export",
                        web::get().to(whatsapp::export_contact_list),
                    )
                    .route(
                        "/lists/{label}",
                        web::patch().to(whatsapp::rename_contact_list),
                    )
                    .route(
                        "/lists/{label}",
                        web::delete().to(whatsapp::delete_contact_list),
                    )
                    .route("/{id}", web::patch().to(whatsapp::update_contact)),
            )
            .route("/templates", web::get().to(whatsapp::list_templates))
            .route("/templates", web::post().to(whatsapp::create_template))
            .service(
                web::scope("/inbox")
                    .route(
                        "/conversations",
                        web::get().to(whatsapp::list_inbox_conversations),
                    )
                    .route(
                        "/conversations",
                        web::post().to(whatsapp::start_inbox_conversation),
                    )
                    .route("/unread-count", web::get().to(whatsapp::inbox_unread_count))
                    .route(
                        "/{id}/messages",
                        web::get().to(whatsapp::list_conversation_messages),
                    )
                    .route("/{id}", web::patch().to(whatsapp::update_conversation))
                    .route("/{id}", web::delete().to(whatsapp::delete_conversation))
                    .route(
                        "/{id}/messages",
                        web::post().to(whatsapp::send_conversation_message),
                    )
                    .route(
                        "/{id}/messages/media",
                        web::post().to(whatsapp::send_conversation_media),
                    )
                    .route(
                        "/{id}/read",
                        web::post().to(whatsapp::mark_conversation_read),
                    )
                    .route(
                        "/{id}/messages/{message_id}/reaction",
                        web::post().to(whatsapp::send_message_reaction),
                    )
                    .route(
                        "/{id}/messages/{message_id}",
                        web::delete().to(whatsapp::delete_conversation_message),
                    )
                    .route(
                        "/media/{message_id}/attachments/{attachment_id}",
                        web::get().to(whatsapp::download_message_attachment),
                    ),
            )
            .service(
                web::scope("/calls")
                    .route("", web::get().to(whatsapp_calls::list_calls))
                    .route("/summary", web::get().to(whatsapp_calls::call_summary))
                    .route("/{id}", web::get().to(whatsapp_calls::get_call))
                    .route(
                        "/{id}/signals",
                        web::get().to(whatsapp_calls::list_call_signals),
                    )
                    .route(
                        "/{id}/signals",
                        web::post().to(whatsapp_calls::post_call_signal),
                    )
                    .route(
                        "/{id}/media-session",
                        web::get().to(whatsapp_calls::get_call_media_session),
                    )
                    .route(
                        "/{id}/action",
                        web::post().to(whatsapp_calls::apply_call_action),
                    ),
            )
            .service(
                web::scope("/campaigns")
                    .route("", web::get().to(whatsapp::list_campaigns))
                    .route("", web::post().to(whatsapp::create_campaign))
                    .route(
                        "/{id}/summary",
                        web::get().to(whatsapp::get_campaign_summary),
                    )
                    .route("/{id}", web::get().to(whatsapp::get_campaign))
                    .route("/{id}", web::patch().to(whatsapp::update_campaign))
                    .route("/{id}", web::delete().to(whatsapp::delete_campaign))
                    .route("/{id}/launch", web::post().to(whatsapp::launch_campaign)),
            ),
    );
}
