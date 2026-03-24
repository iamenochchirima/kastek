use actix_web::{HttpResponse, Responder};

pub async fn root() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({
        "service": "server",
        "status": "ok"
    }))
}

pub async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({ "ok": true }))
}
