//! Domain-owned website and business-profile request models.
//!
//! Public quote/waitlist DTOs and the business profile row stay beside the
//! website/product controllers while `db::models` retains re-exports.

use serde::{Deserialize, Serialize};
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
    #[serde(rename = "contactConsent")]
    pub contact_consent: Option<bool>,
    /// Honeypot field for low-cost bot rejection. Real clients never render it.
    pub website: Option<String>,
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

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebsiteDeploymentRow {
    pub id: String,
    pub public_id: String,
    pub org_id: String,
    pub installation_id: String,
    pub channel_connection_id: String,
    pub status: String,
    pub allowed_origins: Vec<String>,
    pub display_name: Option<String>,
    pub welcome_text: Option<String>,
    pub launcher_position: String,
    pub color_preset: String,
    pub appearance: serde_json::Value,
    pub avatar_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    pub created_by_id: String,
    pub published_at: Option<chrono::DateTime<chrono::Utc>>,
    pub paused_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebsiteAppearanceInput {
    pub primary_color: Option<String>,
    pub launcher_size: Option<i32>,
    pub window_width: Option<i32>,
    pub window_height: Option<i32>,
    pub border_radius: Option<i32>,
    pub launcher_offset: Option<i32>,
    pub show_branding: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentWebsiteDeploymentRequest {
    pub allowed_origins: Option<Vec<String>>,
    pub display_name: Option<String>,
    pub welcome_text: Option<String>,
    pub launcher_position: Option<String>,
    pub color_preset: Option<String>,
    pub avatar_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    pub appearance: Option<AgentWebsiteAppearanceInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentWebsiteDeploymentRequest {
    pub allowed_origins: Option<Vec<String>>,
    pub display_name: Option<String>,
    pub welcome_text: Option<String>,
    pub launcher_position: Option<String>,
    pub color_preset: Option<String>,
    pub avatar_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    pub appearance: Option<AgentWebsiteAppearanceInput>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebsiteVisitorSessionRow {
    pub id: String,
    pub public_session_id: String,
    pub deployment_id: String,
    pub origin: String,
    pub external_identity: String,
    pub external_conversation_id: String,
    pub status: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebsiteVisitorMessageRequest {
    pub idempotency_key: String,
    pub text: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebsiteDeliveryEventRow {
    pub id: String,
    pub event_key: String,
    pub message_text: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
