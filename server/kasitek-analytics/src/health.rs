use actix_web::{web, HttpResponse, Responder};
use chrono::Utc;
use sqlx::PgPool;

use crate::contracts::{
    DependencyStatus, LivenessResponse, ProcessKind, ReadinessDependencies, ReadinessResponse,
    SERVICE_NAME,
};
use crate::migrations::FOUNDATION_MIGRATION_VERSION;

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
    let postgres_ready = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool.get_ref())
        .await
        .is_ok();
    let migrations_ready = if postgres_ready {
        sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM pg_namespace
                WHERE nspname = 'analytics'
            )
            AND EXISTS (
                SELECT 1
                FROM _sqlx_migrations
                WHERE version = $1
                  AND success = true
            )
            "#,
        )
        .bind(FOUNDATION_MIGRATION_VERSION)
        .fetch_one(pool.get_ref())
        .await
        .unwrap_or(false)
    } else {
        false
    };
    readiness_response(**process, postgres_ready, migrations_ready)
}

fn readiness_response(
    process: ProcessKind,
    postgres_ready: bool,
    migrations_ready: bool,
) -> HttpResponse {
    let ready = postgres_ready && migrations_ready;
    let status = if ready { "ready" } else { "not_ready" };
    let response = ReadinessResponse {
        status,
        service: SERVICE_NAME,
        process: process.as_str(),
        timestamp: Utc::now(),
        dependencies: ReadinessDependencies {
            postgres: DependencyStatus {
                status: if postgres_ready {
                    "ready"
                } else {
                    "unavailable"
                },
            },
            migrations: DependencyStatus {
                status: if !postgres_ready {
                    "unavailable"
                } else if migrations_ready {
                    "ready"
                } else {
                    "pending"
                },
            },
        },
    };
    if ready {
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
    fn readiness_requires_postgres_and_applied_migrations() {
        assert_eq!(
            readiness_response(ProcessKind::Api, true, true).status(),
            StatusCode::OK
        );
        assert_eq!(
            readiness_response(ProcessKind::Api, true, false).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            readiness_response(ProcessKind::Api, false, false).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
