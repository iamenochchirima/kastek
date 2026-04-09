use actix_web::web;

use crate::controllers::{agents, conversations, health, usage, workspace};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/", web::get().to(health::root))
        .route("/health", web::get().to(health::health_check))
        .service(
            web::scope("/api/workspace")
                .route("", web::get().to(workspace::get_workspace))
                .route("/branding", web::get().to(workspace::get_branding)),
        )
        .service(
            web::scope("/api/agents")
                .route("", web::get().to(agents::list_agents))
                .route("/{id}", web::get().to(agents::get_agent)),
        )
        .service(
            web::scope("/api/conversations")
                .route("", web::get().to(conversations::list_conversations))
                .route("/{id}", web::get().to(conversations::get_conversation))
                .route("/{id}/messages", web::get().to(conversations::list_messages)),
        )
        .service(web::scope("/api/usage").route("", web::get().to(usage::get_usage)));
}
