//! Public `/v1` transport contracts. Route mounting remains separate from the
//! legacy `/api/*` composition so the migration can be reviewed independently.

use actix_web::{web, HttpResponse};
use serde_json::json;

use crate::bootstrap::state::AppState;

pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "status": "ok",
        "service": "kasitek-core",
        "apiVersion": "v1",
        "actionCatalogSize": state.action_registry.definitions().count(),
    }))
}

pub async fn capabilities(state: web::Data<AppState>) -> HttpResponse {
    let actions = state
        .action_registry
        .definitions()
        .filter(|definition| definition.lifecycle == actions::ActionLifecycle::Public)
        .collect::<Vec<_>>();
    HttpResponse::Ok().json(json!({ "version": "v1", "actions": actions }))
}
