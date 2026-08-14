//! Versioned public REST API route registration.

use actix_web::{middleware, web};

use crate::controllers::public_v1;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/v1")
            .wrap(middleware::from_fn(crate::services::public_api::middleware))
            .route("/health", web::get().to(public_v1::health))
            .route("/openapi.json", web::get().to(public_v1::openapi))
            .route("/metrics", web::get().to(public_v1::metrics))
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
            )
            .route(
                "/content/posts/{id}/activity",
                web::get().to(public_v1::get_content_post_activity),
            )
            .route(
                "/content/posts/{id}",
                web::patch().to(public_v1::update_content_draft),
            )
            .route("/contacts", web::get().to(public_v1::list_contacts))
            .route(
                "/inbox/conversations",
                web::get().to(public_v1::list_inbox_conversations),
            )
            .route(
                "/inbox/conversations/{id}/messages",
                web::get().to(public_v1::list_inbox_messages),
            )
            .route("/bookings", web::get().to(public_v1::list_bookings))
            .route("/campaigns", web::get().to(public_v1::list_campaigns))
            .route(
                "/campaigns/{id}",
                web::get().to(public_v1::get_campaign_summary),
            )
            .route("/templates", web::get().to(public_v1::list_templates)),
    );
}
