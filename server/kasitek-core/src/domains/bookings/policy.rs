use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::{error::AppError, identity::request_context::RequestContext, services::orgs};

pub const VALID_BOOKING_STATUSES: [&str; 5] = [
    "SCHEDULED",
    "CONFIRMED",
    "COMPLETED",
    "CANCELLED",
    "NO_SHOW",
];

pub fn normalize_required_text(value: &str, label: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::BadRequest(format!("{label} is required")));
    }
    Ok(value.to_string())
}

pub fn validate_duration_minutes(value: i32) -> Result<(), AppError> {
    if (5..=1_440).contains(&value) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Duration must be between 5 and 1440 minutes".to_string(),
        ))
    }
}

pub fn validate_future_start(value: DateTime<Utc>) -> Result<(), AppError> {
    if value > Utc::now() {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Bookings must be scheduled in the future".to_string(),
        ))
    }
}

pub fn validate_status(value: &str) -> Result<(), AppError> {
    if VALID_BOOKING_STATUSES.contains(&value) {
        Ok(())
    } else {
        Err(AppError::BadRequest("Invalid booking status".to_string()))
    }
}

pub async fn require_workspace_admin(
    context: &RequestContext,
    pool: &PgPool,
) -> Result<(), AppError> {
    let user_id = context.user_id.as_deref().ok_or_else(|| {
        AppError::Forbidden("Booking service administration requires a workspace user".to_string())
    })?;
    orgs::require_admin(pool, &context.organization_id, user_id).await
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::{
        normalize_required_text, validate_duration_minutes, validate_future_start, validate_status,
    };

    #[test]
    fn normalizes_required_text_and_rejects_blank_values() {
        assert_eq!(
            normalize_required_text("  Consultation  ", "Service name").unwrap(),
            "Consultation"
        );
        assert!(normalize_required_text("  ", "Service name").is_err());
    }

    #[test]
    fn validates_duration_boundaries() {
        assert!(validate_duration_minutes(5).is_ok());
        assert!(validate_duration_minutes(1_440).is_ok());
        assert!(validate_duration_minutes(4).is_err());
        assert!(validate_duration_minutes(1_441).is_err());
    }

    #[test]
    fn validates_future_start_and_status_values() {
        assert!(validate_future_start(Utc::now() + Duration::minutes(5)).is_ok());
        assert!(validate_future_start(Utc::now() - Duration::minutes(1)).is_err());
        assert!(validate_status("CONFIRMED").is_ok());
        assert!(validate_status("PUBLISHED").is_err());
    }
}
