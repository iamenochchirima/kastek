use sqlx::PgPool;

use crate::{
    domains::bookings::{
        model::{Booking, BookingService},
        queries,
    },
    error::AppError,
    identity::request_context::RequestContext,
};

/// Private capability adapter for the bookings pilot. Transport adapters must
/// resolve a trusted context before reaching this function; the adapter itself
/// deliberately contains no SQL or HTTP concerns.
pub async fn list_booking_services(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<BookingService>, AppError> {
    queries::list_services(pool, context).await
}

pub async fn list_bookings(
    pool: &PgPool,
    context: &RequestContext,
) -> Result<Vec<Booking>, AppError> {
    queries::list_bookings(pool, context).await
}

pub async fn get_booking(
    pool: &PgPool,
    context: &RequestContext,
    booking_id: &str,
) -> Result<Option<Booking>, AppError> {
    queries::get_booking(pool, context, booking_id).await
}
