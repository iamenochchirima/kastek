//! HTTP transport contracts for the bookings boundary.
//!
//! These types intentionally live outside `model.rs`: persistence rows and
//! domain inputs must not become accidental wire contracts. Product and
//! internal adapters can share the response envelope while retaining their
//! distinct authentication and request handling.

use serde::{Deserialize, Serialize};

use super::model::BookingService;

#[derive(Debug, Deserialize)]
pub struct BookingServiceCreateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct BookingServiceUpdateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: Option<i32>,
    pub active: Option<bool>,
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

#[derive(Debug, Deserialize)]
pub struct BookingUpdateRequest {
    pub status: Option<String>,
    pub notes: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{BookingCreateRequest, BookingServiceCreateRequest, BookingServicesResponse};

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
}
