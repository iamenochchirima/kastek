use actix_web::web;

use crate::{contracts::ProcessKind, health, ingestion, reconciliation};

pub fn configure(cfg: &mut web::ServiceConfig, process: ProcessKind) {
    health::configure(cfg, process);
    cfg.route("/internal/metrics", web::get().to(crate::metrics::endpoint));
    if matches!(process, ProcessKind::Api) {
        cfg.service(
            web::resource(ingestion::INGESTION_PATH).route(web::post().to(ingestion::handler)),
        );
        cfg.service(
            web::resource(reconciliation::RECONCILIATION_PATH)
                .route(web::post().to(reconciliation::handler)),
        );
    }
}
