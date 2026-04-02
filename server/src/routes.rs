use actix_web::web;

use crate::controllers::{
    admin, ai, auth, bots, chat, health, notifications, profile, public, realtime, social,
    whatsapp, whatsapp_calls, workspace,
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/", web::get().to(health::root))
        .route("/health", web::get().to(health::health_check))
        .service(
            web::scope("/api/realtime")
                .route("/whatsapp", web::get().to(realtime::whatsapp_stream)),
        )
        .service(
            web::scope("/api/bots")
                .route("", web::post().to(bots::create))
                .route("/{id}", web::get().to(bots::get))
                .route("/{id}", web::patch().to(bots::patch))
                .route("/{id}", web::delete().to(bots::delete)),
        )
        .route("/api/chat", web::post().to(chat::post))
        .route("/api/workspace/summary", web::get().to(workspace::summary))
        .service(
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
                .route("/send-otp", web::post().to(auth::send_otp))
                .route("/verify-otp", web::post().to(auth::verify_otp))
                .route("/verify-email", web::get().to(auth::verify_email))
                .route(
                    "/request-password-setup",
                    web::post().to(auth::request_password_setup),
                )
                .route("/set-password", web::post().to(auth::set_password)),
        )
        .service(
            web::scope("/api/profile")
                .route("", web::get().to(profile::get))
                .route("", web::patch().to(profile::patch))
                .route("/email", web::post().to(profile::request_email_change))
                .route("/email/verify", web::get().to(profile::verify_email_change))
                .route("/password", web::patch().to(profile::change_password)),
        )
        .service(
            web::scope("/api/onboarding")
                .route("/phone", web::post().to(profile::save_onboarding_phone)),
        )
        .service(
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
        )
        .service(
            web::scope("/api/social")
                .service(
                    web::scope("/oauth")
                        .route("/x/start", web::get().to(social::start_x_oauth))
                        .route("/x/callback", web::get().to(social::x_oauth_callback))
                        .route(
                            "/linkedin/start",
                            web::get().to(social::start_linkedin_oauth),
                        )
                        .route(
                            "/linkedin/callback",
                            web::get().to(social::linkedin_oauth_callback),
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
        )
        .service(
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
                            "/media/{message_id}",
                            web::get().to(whatsapp::download_message_media),
                        ),
                )
                .service(
                    web::scope("/calls")
                        .route("", web::get().to(whatsapp_calls::list_calls))
                        .route(
                            "/bridge/contract",
                            web::get().to(whatsapp_calls::get_bridge_contract),
                        )
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
        )
        .service(
            web::scope("/api/webhooks/whatsapp")
                .route("", web::get().to(whatsapp::verify_webhook))
                .route("", web::post().to(whatsapp::receive_webhook))
                .route(
                    "/calls/bridge",
                    web::post().to(whatsapp_calls::receive_bridge_event),
                ),
        )
        .route(
            "/api/quote-requests",
            web::post().to(public::create_quote_request),
        )
        .route(
            "/api/waitlist",
            web::post().to(public::create_waitlist_entry),
        )
        .service(
            web::scope("/api/admin")
                .route("/login", web::post().to(admin::login))
                .route("/logout", web::post().to(admin::logout))
                .route("/me", web::get().to(admin::me))
                .route("/stats", web::get().to(admin::stats)),
        );
}
