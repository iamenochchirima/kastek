use actix_web::web;

/// Application-level route composition. The binary owns process startup and
/// middleware; this module owns only the testable application route assembly.
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    super::routes::configure(cfg);
}
