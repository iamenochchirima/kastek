use actix_web::web;

use crate::{contracts::ProcessKind, health};

/// A-01 route composition. Ingestion and reporting routes are intentionally
/// absent until their approved execution packages are implemented.
pub fn configure(cfg: &mut web::ServiceConfig, process: ProcessKind) {
    health::configure(cfg, process);
}
