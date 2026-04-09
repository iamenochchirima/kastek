use actix_web::{HttpResponse, Responder};
use chrono::Utc;
use types::HealthResponse;

pub async fn root() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        service: "kasitek-core",
        status: "ok",
        timestamp: Utc::now(),
    })
}

pub async fn health_check() -> impl Responder {
    root().await
}
