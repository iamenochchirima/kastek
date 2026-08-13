//! Versioned public REST API route registration.

use actix_web::web;

use crate::controllers::public_v1;

pub fn configure(cfg: &mut web::ServiceConfig) {
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
            )
            .route(
                "/content/posts/{id}",
                web::patch().to(public_v1::update_content_draft),
            ),
    );
}
