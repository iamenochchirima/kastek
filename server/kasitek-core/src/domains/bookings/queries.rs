use sqlx::PgPool;

use crate::{error::AppError, identity::request_context::RequestContext};

use super::{
    model::{Booking, BookingService},
    postgres,
};

pub async fn list_services(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<BookingService>, AppError> {
    postgres::list_services(pool, &context.organization_id).await
}

pub async fn list_bookings(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<Booking>, AppError> {
    postgres::list_bookings(pool, &context.organization_id).await
}

pub async fn get_booking(
    pool: &PgPool,
    context: &RequestContext,
    booking_id: &str,
) -> Result<Option<Booking>, AppError> {
    postgres::get_booking(pool, &context.organization_id, booking_id).await
}
