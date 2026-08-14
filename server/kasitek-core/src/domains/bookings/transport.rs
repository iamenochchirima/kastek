//! HTTP transport contracts for the bookings boundary.
//!
//! These types intentionally live outside `model.rs`: persistence rows and
//! domain inputs must not become accidental wire contracts. Product and
//! internal adapters can share the response envelope while retaining their
//! distinct authentication and request handling.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

use super::{
    model::{
        Booking, BookingService, CreateBookingInput, CreateServiceInput, UpdateBookingInput,
        UpdateServiceInput,
    },
    policy,
};

#[derive(Debug, Deserialize)]
pub struct BookingServiceCreateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: Option<i32>,
}

impl BookingServiceCreateRequest {
    pub fn into_input(self) -> Result<CreateServiceInput, AppError> {
        let name = policy::normalize_required_text(
            self.name.as_deref().unwrap_or_default(),
            "Service name",
        )?;
        let duration_minutes = self.duration_minutes.ok_or_else(|| {
            AppError::BadRequest("Duration must be between 5 and 1440 minutes".to_string())
        })?;
        policy::validate_duration_minutes(duration_minutes)?;
        Ok(CreateServiceInput {
            name,
            description: self
                .description
                .as_deref()
                .and_then(normalize_optional_text),
            duration_minutes,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct BookingServiceUpdateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: Option<i32>,
    pub active: Option<bool>,
}

impl BookingServiceUpdateRequest {
    pub fn into_input(self) -> Result<UpdateServiceInput, AppError> {
        let name = self
            .name
            .as_deref()
            .map(|value| policy::normalize_required_text(value, "Service name"))
            .transpose()?;
        if let Some(duration_minutes) = self.duration_minutes {
            policy::validate_duration_minutes(duration_minutes)?;
        }
        Ok(UpdateServiceInput {
            name,
            description: self
                .description
                .map(|value| normalize_optional_text(value.as_str())),
            duration_minutes: self.duration_minutes,
            active: self.active,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct BookingCreateRequest {
    #[serde(rename = "serviceId")]
    pub service_id: Option<String>,
    #[serde(rename = "customerId")]
    pub customer_id: Option<String>,
    #[serde(rename = "contactName")]
    pub contact_name: Option<String>,
    #[serde(rename = "contactPhone")]
    pub contact_phone: Option<String>,
    #[serde(rename = "scheduledStart")]
    pub scheduled_start: Option<String>,
    pub timezone: Option<String>,
    pub notes: Option<String>,
}

impl BookingCreateRequest {
    pub fn into_input(self) -> Result<CreateBookingInput, AppError> {
        let service_id = policy::normalize_required_text(
            self.service_id.as_deref().unwrap_or_default(),
            "Service",
        )?;
        let contact_name = policy::normalize_required_text(
            self.contact_name.as_deref().unwrap_or_default(),
            "Contact name",
        )?;
        let scheduled_start = policy::normalize_required_text(
            self.scheduled_start.as_deref().unwrap_or_default(),
            "Start time",
        )?
        .parse::<DateTime<Utc>>()
        .map_err(|_| {
            AppError::BadRequest("Start time must be a valid ISO-8601 timestamp".to_string())
        })?;
        policy::validate_future_start(scheduled_start)?;
        Ok(CreateBookingInput {
            service_id,
            customer_id: self
                .customer_id
                .as_deref()
                .and_then(normalize_optional_text),
            contact_name,
            contact_phone: self
                .contact_phone
                .as_deref()
                .and_then(normalize_optional_text),
            scheduled_start,
            timezone: self
                .timezone
                .as_deref()
                .and_then(normalize_optional_text)
                .unwrap_or_else(|| "Africa/Johannesburg".to_string()),
            notes: self.notes.as_deref().and_then(normalize_optional_text),
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct BookingUpdateRequest {
    pub status: Option<String>,
    pub notes: Option<String>,
}

impl BookingUpdateRequest {
    pub fn into_input(self) -> Result<UpdateBookingInput, AppError> {
        let status = self
            .status
            .as_deref()
            .and_then(normalize_optional_text)
            .map(|status| status.to_ascii_uppercase());
        if let Some(status) = status.as_deref() {
            policy::validate_status(status)?;
        }
        Ok(UpdateBookingInput {
            status,
            notes: self
                .notes
                .map(|value| normalize_optional_text(value.as_str())),
        })
    }
}

#[derive(Debug, Serialize)]
pub struct BookingServicesResponse {
    pub services: Vec<BookingService>,
}

impl BookingServicesResponse {
    pub fn new(services: Vec<BookingService>) -> Self {
        Self { services }
    }
}

#[derive(Debug, Serialize)]
pub struct BookingListResponse {
    pub bookings: Vec<Booking>,
}

impl BookingListResponse {
    pub fn new(bookings: Vec<Booking>) -> Self {
        Self { bookings }
    }
}

fn normalize_optional_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use crate::domains::bookings::model::{Booking, BookingService};

    use super::{
        BookingCreateRequest, BookingListResponse, BookingServiceCreateRequest,
        BookingServiceUpdateRequest, BookingServicesResponse, BookingUpdateRequest,
    };

    #[test]
    fn transport_requests_keep_camel_case_wire_names() {
        let service: BookingServiceCreateRequest = serde_json::from_value(serde_json::json!({
            "name": "Consultation",
            "durationMinutes": 60,
        }))
        .expect("service request should deserialize");
        assert_eq!(service.duration_minutes, Some(60));

        let booking: BookingCreateRequest = serde_json::from_value(serde_json::json!({
            "serviceId": "service-1",
            "contactName": "Ada",
            "scheduledStart": "2030-01-01T12:00:00Z",
        }))
        .expect("booking request should deserialize");
        assert_eq!(booking.service_id.as_deref(), Some("service-1"));
        assert_eq!(booking.contact_name.as_deref(), Some("Ada"));
    }

    #[test]
    fn shared_service_response_envelope_preserves_product_internal_parity() {
        let payload = serde_json::to_value(BookingServicesResponse::new(Vec::new()))
            .expect("service response should serialize");
        assert_eq!(payload, serde_json::json!({ "services": [] }));
    }

    #[test]
    fn shared_booking_response_envelope_preserves_product_internal_parity() {
        let payload = serde_json::to_value(BookingListResponse::new(Vec::new()))
            .expect("booking response should serialize");
        assert_eq!(payload, serde_json::json!({ "bookings": [] }));
    }

    #[test]
    fn request_conversion_centralizes_normalization_and_defaults() {
        let input = BookingCreateRequest {
            service_id: Some(" service-1 ".to_string()),
            customer_id: Some(" ".to_string()),
            contact_name: Some(" Ada Lovelace ".to_string()),
            contact_phone: Some(" +27 11 555 0100 ".to_string()),
            scheduled_start: Some("2030-01-01T12:00:00Z".to_string()),
            timezone: Some(" ".to_string()),
            notes: Some("  Notes  ".to_string()),
        }
        .into_input()
        .expect("valid booking request");

        assert_eq!(input.service_id, "service-1");
        assert_eq!(input.customer_id, None);
        assert_eq!(input.contact_name, "Ada Lovelace");
        assert_eq!(input.contact_phone.as_deref(), Some("+27 11 555 0100"));
        assert_eq!(input.timezone, "Africa/Johannesburg");
        assert_eq!(input.notes.as_deref(), Some("Notes"));
    }

    #[test]
    fn request_conversion_rejects_invalid_values_before_domain_io() {
        let invalid_timestamp = BookingCreateRequest {
            service_id: Some("service-1".to_string()),
            customer_id: None,
            contact_name: Some("Ada".to_string()),
            contact_phone: None,
            scheduled_start: Some("not-a-timestamp".to_string()),
            timezone: None,
            notes: None,
        };
        assert!(invalid_timestamp.into_input().is_err());

        let invalid_duration = BookingServiceCreateRequest {
            name: Some("Consultation".to_string()),
            description: None,
            duration_minutes: Some(1),
        };
        assert!(invalid_duration.into_input().is_err());

        let invalid_status = BookingUpdateRequest {
            status: Some("published".to_string()),
            notes: None,
        };
        assert!(invalid_status.into_input().is_err());
    }

    #[test]
    fn update_conversion_normalizes_status_and_optional_fields() {
        let input = BookingUpdateRequest {
            status: Some(" confirmed ".to_string()),
            notes: Some("  Confirmed by client  ".to_string()),
        }
        .into_input()
        .expect("valid update request");
        assert_eq!(input.status.as_deref(), Some("CONFIRMED"));
        assert_eq!(
            input.notes.as_ref().and_then(|value| value.as_deref()),
            Some("Confirmed by client")
        );

        let service = BookingServiceUpdateRequest {
            name: Some("  Consultation  ".to_string()),
            description: Some(" ".to_string()),
            duration_minutes: Some(60),
            active: Some(true),
        }
        .into_input()
        .expect("valid service update");
        assert_eq!(service.name.as_deref(), Some("Consultation"));
        assert_eq!(service.description, Some(None));
    }

    #[test]
    fn response_envelopes_serialize_the_same_for_real_rows() {
        let timestamp = Utc.with_ymd_and_hms(2030, 1, 1, 12, 0, 0).unwrap();
        let service = BookingService {
            id: "service-1".to_string(),
            org_id: "org-1".to_string(),
            name: "Consultation".to_string(),
            description: None,
            duration_minutes: 60,
            active: true,
            created_at: timestamp,
            updated_at: timestamp,
        };
        let service_payload = serde_json::to_value(BookingServicesResponse::new(vec![service]))
            .expect("service response should serialize");
        assert_eq!(service_payload["services"][0]["durationMinutes"], 60);

        let booking = Booking {
            id: "booking-1".to_string(),
            org_id: "org-1".to_string(),
            service_id: "service-1".to_string(),
            service_name: "Consultation".to_string(),
            customer_id: None,
            customer_name: None,
            contact_name: "Ada".to_string(),
            contact_phone: None,
            scheduled_start: timestamp,
            scheduled_end: timestamp + chrono::Duration::hours(1),
            timezone: "UTC".to_string(),
            status: "SCHEDULED".to_string(),
            notes: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        let booking_payload = serde_json::to_value(BookingListResponse::new(vec![booking]))
            .expect("booking response should serialize");
        assert_eq!(
            booking_payload["bookings"][0]["scheduledStart"],
            "2030-01-01T12:00:00Z"
        );
    }
}
