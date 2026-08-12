use actix_web::web;

/// Temporary bridge while existing route groups move into `api::*` modules.
/// Keeping composition here lets each group migrate without changing process
/// startup or the externally visible route table.
pub fn configure(cfg: &mut web::ServiceConfig) {
    crate::routes::configure(cfg);
}
