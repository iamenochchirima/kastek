use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::db::models::{
    BookingCreateRequest, BookingServiceCreateRequest, BookingServiceUpdateRequest,
    BookingUpdateRequest,
};
use crate::error::AppError;
use crate::middleware::{extract_user, resolve_active_org_id};
use crate::services::{bookings, orgs};

const VALID_BOOKING_STATUSES: [&str; 5] = [
    "SCHEDULED",
    "CONFIRMED",
    "COMPLETED",
    "CANCELLED",
    "NO_SHOW",
];

fn optional_trimmed(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_trimmed(value: Option<&String>, label: &str) -> Result<String, AppError> {
    optional_trimmed(value).ok_or_else(|| AppError::BadRequest(format!("{label} is required")))
}

async fn request_scope(pool: &PgPool, req: &HttpRequest) -> Result<(String, String), AppError> {
    let user = extract_user(req, pool).await?;
    let org_id = resolve_active_org_id(req, pool, &user.id).await?;
    Ok((user.id, org_id))
}

pub async fn list_services(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (_, org_id) = request_scope(pool.get_ref(), &req).await?;
    let services = bookings::list_services(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "services": services })))
}

pub async fn create_service(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<BookingServiceCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let (user_id, org_id) = request_scope(pool.get_ref(), &req).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user_id).await?;
    let name = required_trimmed(body.name.as_ref(), "Service name")?;
    let duration_minutes = body
        .duration_minutes
        .filter(|value| (5..=1_440).contains(value))
        .ok_or_else(|| {
            AppError::BadRequest("Duration must be between 5 and 1440 minutes".to_string())
        })?;
    let description = optional_trimmed(body.description.as_ref());
    let service = bookings::create_service(
        pool.get_ref(),
        &org_id,
        &name,
        description.as_deref(),
        duration_minutes,
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "service": service })))
}

pub async fn update_service(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BookingServiceUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let (user_id, org_id) = request_scope(pool.get_ref(), &req).await?;
    orgs::require_admin(pool.get_ref(), &org_id, &user_id).await?;
    if body
        .duration_minutes
        .is_some_and(|value| !(5..=1_440).contains(&value))
    {
        return Err(AppError::BadRequest(
            "Duration must be between 5 and 1440 minutes".to_string(),
        ));
    }
    let name = match body.name.as_ref() {
        Some(_) => Some(required_trimmed(body.name.as_ref(), "Service name")?),
        None => None,
    };
    let description = body
        .description
        .as_ref()
        .map(|value| optional_trimmed(Some(value)));
    let service = bookings::update_service(
        pool.get_ref(),
        &org_id,
        &path,
        name.as_deref(),
        description.as_ref().map(|value| value.as_deref()),
        body.duration_minutes,
        body.active,
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Booking service not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "service": service })))
}

pub async fn list_bookings(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let (_, org_id) = request_scope(pool.get_ref(), &req).await?;
    let bookings = bookings::list_bookings(pool.get_ref(), &org_id).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "bookings": bookings })))
}

pub async fn create_booking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<BookingCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let (user_id, org_id) = request_scope(pool.get_ref(), &req).await?;
    let service_id = required_trimmed(body.service_id.as_ref(), "Service")?;
    let contact_name = required_trimmed(body.contact_name.as_ref(), "Contact name")?;
    let scheduled_start = required_trimmed(body.scheduled_start.as_ref(), "Start time")?
        .parse::<DateTime<Utc>>()
        .map_err(|_| {
            AppError::BadRequest("Start time must be a valid ISO-8601 timestamp".to_string())
        })?;
    if scheduled_start <= Utc::now() {
        return Err(AppError::BadRequest(
            "Bookings must be scheduled in the future".to_string(),
        ));
    }
    let timezone = optional_trimmed(body.timezone.as_ref())
        .unwrap_or_else(|| "Africa/Johannesburg".to_string());
    let customer_id = optional_trimmed(body.customer_id.as_ref());
    let contact_phone = optional_trimmed(body.contact_phone.as_ref());
    let notes = optional_trimmed(body.notes.as_ref());
    let booking = bookings::create_booking(
        pool.get_ref(),
        &org_id,
        &user_id,
        &service_id,
        customer_id.as_deref(),
        &contact_name,
        contact_phone.as_deref(),
        scheduled_start,
        &timezone,
        notes.as_deref(),
    )
    .await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "booking": booking })))
}

pub async fn update_booking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<BookingUpdateRequest>,
) -> Result<HttpResponse, AppError> {
    let (_, org_id) = request_scope(pool.get_ref(), &req).await?;
    let status = optional_trimmed(body.status.as_ref()).map(|value| value.to_ascii_uppercase());
    if status
        .as_deref()
        .is_some_and(|value| !VALID_BOOKING_STATUSES.contains(&value))
    {
        return Err(AppError::BadRequest("Invalid booking status".to_string()));
    }
    let notes = body
        .notes
        .as_ref()
        .map(|value| optional_trimmed(Some(value)));
    let booking = bookings::update_booking(
        pool.get_ref(),
        &org_id,
        &path,
        status.as_deref(),
        notes.as_ref().map(|value| value.as_deref()),
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Booking not found".to_string()))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "booking": booking })))
}
