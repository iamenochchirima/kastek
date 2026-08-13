//! Domain-owned website and business-profile request models.
//!
//! Public quote/waitlist DTOs and the business profile row stay beside the
//! website/product controllers while `db::models` retains re-exports.

use serde::Deserialize;
use sqlx::FromRow;

#[derive(Debug, Deserialize)]
pub struct QuoteRequestCreateRequest {
    #[serde(rename = "businessName")]
    pub business_name: Option<String>,
    #[serde(rename = "contactPerson")]
    pub contact_person: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    #[serde(rename = "businessType")]
    pub business_type: Option<String>,
    pub services: Option<Vec<String>>,
    pub description: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct ProductWaitlistCreateRequest {
    #[serde(rename = "businessName")]
    pub business_name: Option<String>,
    #[serde(rename = "contactPerson")]
    pub contact_person: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    #[serde(rename = "businessType")]
    pub business_type: Option<String>,
    pub products: Option<Vec<String>>,
    pub notes: Option<String>,
}
#[derive(Debug, Clone, FromRow)]
pub struct BusinessProfileRow {
    #[sqlx(rename = "businessName")]
    pub business_name: String,
    #[sqlx(rename = "businessType")]
    pub business_type: String,
    pub industry: Option<String>,
    pub description: Option<String>,
    pub city: Option<String>,
    pub province: Option<String>,
    pub country: String,
    pub website: Option<String>,
}
