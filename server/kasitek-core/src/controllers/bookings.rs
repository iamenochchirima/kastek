use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::domains::bookings::{commands, queries, transport};
use crate::error::AppError;
use crate::identity::{product_session, request_context::RequestContext};

pub use transport::{
    BookingCreateRequest, BookingServiceCreateRequest, BookingServiceUpdateRequest,
    BookingUpdateRequest,
};

async fn request_scope(pool: &PgPool, req: &HttpRequest) -> Result<RequestContext, AppError> {
    product_session::resolve(req, pool).await
}

pub async fn list_services(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let services = queries::list_services(pool.get_ref(), &context).await?;
    Ok(HttpResponse::Ok().json(transport::BookingServicesResponse::new(services)))
}

pub async fn create_service(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<transport::BookingServiceCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let service =
        commands::create_service(pool.get_ref(), &context, body.into_inner().into_input()?).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "service": service })))
}

pub async fn update_service(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<transport::BookingServiceUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let service = commands::update_service(
        pool.get_ref(),
        &context,
        &path,
        body.into_inner().into_input()?,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "service": service })))
}

pub async fn list_bookings(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let bookings = queries::list_bookings(pool.get_ref(), &context).await?;
    Ok(HttpResponse::Ok().json(transport::BookingListResponse::new(bookings)))
}

pub async fn create_booking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<transport::BookingCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let booking =
        commands::create_booking(pool.get_ref(), &context, body.into_inner().into_input()?).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "booking": booking })))
}

pub async fn update_booking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<transport::BookingUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let context = request_scope(pool.get_ref(), &req).await?;
    let booking = commands::update_booking(
        pool.get_ref(),
        &context,
        &path,
        body.into_inner().into_input()?,
    )
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "booking": booking })))
}
