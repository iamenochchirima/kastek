use chrono::Utc;
use sqlx::PgPool;

use crate::{error::AppError, identity::request_context::RequestContext};

use super::{
    model::{
        Booking, BookingService, CreateBookingInput, CreateServiceInput, UpdateBookingInput,
        UpdateServiceInput,
    },
    policy, postgres,
};

const VALID_BOOKING_STATUSES: [&str; 5] = [
    "SCHEDULED",
    "CONFIRMED",
    "COMPLETED",
    "CANCELLED",
    "NO_SHOW",
];

pub async fn create_service(
    pool: &PgPool,
    context: &RequestContext,
    input: CreateServiceInput,
) -> Result<BookingService, AppError> {
    policy::require_workspace_admin(context, pool).await?;
    if input.name.trim().is_empty() {
        return Err(AppError::BadRequest("Service name is required".to_string()));
    }
    if !(5..=1_440).contains(&input.duration_minutes) {
        return Err(AppError::BadRequest(
            "Duration must be between 5 and 1440 minutes".to_string(),
        ));
    }
    postgres::create_service(
        pool,
        &context.organization_id,
        input.name.trim(),
        input.description.as_deref(),
        input.duration_minutes,
    )
    .await
}

pub async fn update_service(
    pool: &PgPool,
    context: &RequestContext,
    service_id: &str,
    input: UpdateServiceInput,
) -> Result<BookingService, AppError> {
    policy::require_workspace_admin(context, pool).await?;
    if input
        .name
        .as_deref()
        .is_some_and(|name| name.trim().is_empty())
    {
        return Err(AppError::BadRequest("Service name is required".to_string()));
    }
    if input
        .duration_minutes
        .is_some_and(|value| !(5..=1_440).contains(&value))
    {
        return Err(AppError::BadRequest(
            "Duration must be between 5 and 1440 minutes".to_string(),
        ));
    }
    postgres::update_service(
        pool,
        &context.organization_id,
        service_id,
        input.name.as_deref().map(str::trim),
        input.description.as_ref().map(|value| value.as_deref()),
        input.duration_minutes,
        input.active,
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Booking service not found".to_string()))
}

pub async fn create_booking(
    pool: &PgPool,
    context: &RequestContext,
    input: CreateBookingInput,
) -> Result<Booking, AppError> {
    if input.service_id.trim().is_empty() || input.contact_name.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Service and contact name are required".to_string(),
        ));
    }
    if input.scheduled_start <= Utc::now() {
        return Err(AppError::BadRequest(
            "Bookings must be scheduled in the future".to_string(),
        ));
    }
    let user_id = context.user_id.as_deref().ok_or_else(|| {
        AppError::Forbidden("Booking creation requires a workspace user".to_string())
    })?;
    postgres::create_booking(
        pool,
        &context.organization_id,
        user_id,
        input.service_id.trim(),
        input.customer_id.as_deref(),
        input.contact_name.trim(),
        input.contact_phone.as_deref(),
        input.scheduled_start,
        &input.timezone,
        input.notes.as_deref(),
    )
    .await
}

pub async fn update_booking(
    pool: &PgPool,
    context: &RequestContext,
    booking_id: &str,
    input: UpdateBookingInput,
) -> Result<Booking, AppError> {
    if input
        .status
        .as_deref()
        .is_some_and(|status| !VALID_BOOKING_STATUSES.contains(&status))
    {
        return Err(AppError::BadRequest("Invalid booking status".to_string()));
    }
    postgres::update_booking(
        pool,
        &context.organization_id,
        booking_id,
        input.status.as_deref(),
        input.notes.as_ref().map(|value| value.as_deref()),
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Booking not found".to_string()))
}
