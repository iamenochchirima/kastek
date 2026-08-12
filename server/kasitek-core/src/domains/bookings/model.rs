use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BookingService {
    pub id: String,
    #[sqlx(rename = "org_id")]
    #[serde(rename = "orgId")]
    pub org_id: String,
    pub name: String,
    pub description: Option<String>,
    #[sqlx(rename = "duration_minutes")]
    #[serde(rename = "durationMinutes")]
    pub duration_minutes: i32,
    pub active: bool,
    #[sqlx(rename = "created_at")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Booking {
    pub id: String,
    #[sqlx(rename = "org_id")]
    #[serde(rename = "orgId")]
    pub org_id: String,
    #[sqlx(rename = "service_id")]
    #[serde(rename = "serviceId")]
    pub service_id: String,
    #[sqlx(rename = "service_name")]
    #[serde(rename = "serviceName")]
    pub service_name: String,
    #[sqlx(rename = "customer_id")]
    #[serde(rename = "customerId")]
    pub customer_id: Option<String>,
    #[sqlx(rename = "customer_name")]
    #[serde(rename = "customerName")]
    pub customer_name: Option<String>,
    #[sqlx(rename = "contact_name")]
    #[serde(rename = "contactName")]
    pub contact_name: String,
    #[sqlx(rename = "contact_phone")]
    #[serde(rename = "contactPhone")]
    pub contact_phone: Option<String>,
    #[sqlx(rename = "scheduled_start")]
    #[serde(rename = "scheduledStart")]
    pub scheduled_start: DateTime<Utc>,
    #[sqlx(rename = "scheduled_end")]
    #[serde(rename = "scheduledEnd")]
    pub scheduled_end: DateTime<Utc>,
    pub timezone: String,
    pub status: String,
    pub notes: Option<String>,
    #[sqlx(rename = "created_at")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateServiceInput {
    pub name: String,
    pub description: Option<String>,
    pub duration_minutes: i32,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateServiceInput {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub duration_minutes: Option<i32>,
    pub active: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct CreateBookingInput {
    pub service_id: String,
    pub customer_id: Option<String>,
    pub contact_name: String,
    pub contact_phone: Option<String>,
    pub scheduled_start: DateTime<Utc>,
    pub timezone: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateBookingInput {
    pub status: Option<String>,
    pub notes: Option<Option<String>>,
}
