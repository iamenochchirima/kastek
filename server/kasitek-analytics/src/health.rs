use actix_web::{web, HttpResponse, Responder};
use chrono::Utc;
use sqlx::PgPool;

use crate::contracts::{
    DependencyStatus, LivenessResponse, ProcessKind, ReadinessDependencies, ReadinessResponse,
    SERVICE_NAME,
};

pub fn configure(cfg: &mut web::ServiceConfig, process: ProcessKind) {
    cfg.app_data(web::Data::new(process))
        .route("/health", web::get().to(liveness))
        .route("/health/live", web::get().to(liveness))
        .route("/health/ready", web::get().to(readiness));
}

async fn liveness(process: web::Data<ProcessKind>) -> impl Responder {
    HttpResponse::Ok().json(LivenessResponse {
        status: "ok",
        service: SERVICE_NAME,
        process: process.as_ref().as_str(),
        timestamp: Utc::now(),
    })
}

async fn readiness(pool: web::Data<PgPool>, process: web::Data<ProcessKind>) -> impl Responder {
    let database_ready = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool.get_ref())
        .await
        .is_ok();
    readiness_response(**process, database_ready)
}

fn readiness_response(process: ProcessKind, database_ready: bool) -> HttpResponse {
    let status = if database_ready { "ready" } else { "not_ready" };
    let response = ReadinessResponse {
        status,
        service: SERVICE_NAME,
        process: process.as_str(),
        timestamp: Utc::now(),
        dependencies: ReadinessDependencies {
            postgres: DependencyStatus {
                status: if database_ready {
                    "ready"
                } else {
                    "unavailable"
                },
            },
        },
    };
    if database_ready {
        HttpResponse::Ok().json(response)
    } else {
        HttpResponse::ServiceUnavailable().json(response)
    }
}

#[cfg(test)]
mod tests {
    use actix_web::http::StatusCode;

    use super::{readiness_response, ProcessKind};

    #[test]
    fn readiness_is_successful_only_when_postgres_is_ready() {
        assert_eq!(
            readiness_response(ProcessKind::Api, true).status(),
            StatusCode::OK
        );
        assert_eq!(
            readiness_response(ProcessKind::Api, false).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
