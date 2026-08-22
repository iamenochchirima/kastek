use actix_web::web;

use crate::{
    contracts::ProcessKind, health, ingestion, maintenance, reconciliation, reporting, rollout,
};

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
        cfg.service(
            web::resource(maintenance::RECONCILIATION_WORK_PATH)
                .route(web::get().to(maintenance::reconciliation_work_handler)),
        );
        cfg.service(
            web::resource(maintenance::QUARANTINE_WORK_PATH)
                .route(web::get().to(maintenance::quarantine_work_handler)),
        );
        cfg.service(
            web::resource(maintenance::BACKFILL_WORK_PATH)
                .route(web::get().to(maintenance::backfill_work_handler)),
        );
        reporting::configure(cfg);
        rollout::configure(cfg);
    }
}
