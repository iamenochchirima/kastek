use actix_web::web;

use crate::controllers::{
    agents, auth, client_auth, client_portal, clients, conversations, dashboard, health, session,
    usage, workspace,
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/", web::get().to(health::root))
        .route("/health", web::get().to(health::health_check))
        .service(web::scope("/api/public").route(
            "/tenant-context",
            web::get().to(workspace::get_public_tenant_context),
        ))
        .service(
            web::scope("/api/auth")
                .route("/login", web::post().to(auth::login))
                .route("/logout", web::post().to(auth::logout))
                .route("/me", web::get().to(auth::me))
                .route("/session", web::get().to(session::get))
                .route("/session/login", web::post().to(session::login))
                .route("/session/logout", web::post().to(session::logout)),
        )
        .service(
            web::scope("/api/client-auth")
                .route("/invite", web::get().to(client_auth::get_invite))
                .route("/accept-invite", web::post().to(client_auth::accept_invite))
                .route("/login", web::post().to(client_auth::login))
                .route("/logout", web::post().to(client_auth::logout))
                .route("/me", web::get().to(client_auth::me)),
        )
        .service(
            web::scope("/api/client")
                .route("/overview", web::get().to(client_portal::get_overview))
                .route(
                    "/conversations",
                    web::get().to(client_portal::list_conversations),
                )
                .route(
                    "/conversations/{id}",
                    web::get().to(client_portal::get_conversation),
                )
                .route(
                    "/conversations/{id}/messages",
                    web::get().to(client_portal::list_messages),
                ),
        )
        .service(
            web::scope("/api/workspace")
                .route("", web::get().to(workspace::get_workspace))
                .route("/branding", web::get().to(workspace::get_branding)),
        )
        .service(
            web::scope("/api/clients")
                .route("", web::get().to(clients::list_clients))
                .route("", web::post().to(clients::create_client))
                .route("/{id}/users", web::get().to(clients::list_client_users))
                .route("/{id}/invites", web::post().to(clients::invite_client_user)),
        )
        .service(
            web::scope("/api/dashboard")
                .route("/summary", web::get().to(dashboard::get_summary))
                .route("/activity", web::get().to(dashboard::get_activity))
                .route("/services", web::get().to(dashboard::list_services)),
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
                .route(
                    "/{id}/messages",
                    web::get().to(conversations::list_messages),
                ),
        )
        .service(web::scope("/api/usage").route("", web::get().to(usage::get_usage)));
}
