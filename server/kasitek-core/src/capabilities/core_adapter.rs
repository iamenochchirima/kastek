use sqlx::PgPool;

use crate::{
    domains::bookings::{model::BookingService, queries},
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
