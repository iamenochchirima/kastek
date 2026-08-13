use sqlx::PgPool;

use crate::{error::AppError, identity::request_context::RequestContext};

use super::{
    model::{
        Booking, BookingService, CreateBookingInput, CreateServiceInput, UpdateBookingInput,
        UpdateServiceInput,
    },
    policy, postgres,
};

pub async fn create_service(
    pool: &PgPool,
    context: &RequestContext,
    input: CreateServiceInput,
) -> Result<BookingService, AppError> {
    policy::require_workspace_admin(context, pool).await?;
    let name = policy::normalize_required_text(&input.name, "Service name")?;
    policy::validate_duration_minutes(input.duration_minutes)?;
    postgres::create_service(
        pool,
        &context.organization_id,
        &name,
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
    let name = input
        .name
        .as_deref()
        .map(|name| policy::normalize_required_text(name, "Service name"))
        .transpose()?;
    if let Some(value) = input.duration_minutes {
        policy::validate_duration_minutes(value)?;
    }
    postgres::update_service(
        pool,
        &context.organization_id,
        service_id,
        name.as_deref(),
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
    let service_id = policy::normalize_required_text(&input.service_id, "Service")?;
    let contact_name = policy::normalize_required_text(&input.contact_name, "Contact name")?;
    policy::validate_future_start(input.scheduled_start)?;
    let user_id = context.user_id.as_deref().ok_or_else(|| {
        AppError::Forbidden("Booking creation requires a workspace user".to_string())
    })?;
    postgres::create_booking(
        pool,
        &context.organization_id,
        user_id,
        &service_id,
        input.customer_id.as_deref(),
        &contact_name,
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
    if let Some(status) = input.status.as_deref() {
        policy::validate_status(status)?;
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
