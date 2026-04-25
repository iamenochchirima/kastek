use actix_web::web;

use crate::controllers::{health, whatsapp_calls};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/", web::get().to(health::root))
        .route("/health", web::get().to(health::health_check))
        .service(
            web::scope("/api/whatsapp/calls")
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
            web::scope("/api/webhooks/whatsapp")
                .route(
                    "/calls/provider",
                    web::post().to(whatsapp_calls::receive_provider_call_webhook),
                )
                .route(
                    "/calls/bridge",
                    web::post().to(whatsapp_calls::receive_bridge_event),
                ),
        );
}
