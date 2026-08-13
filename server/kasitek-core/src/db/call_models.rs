//! Domain-owned call persistence rows and transport DTOs.
//!
//! Voice/WhatsApp call state stays beside the call services while
//! `db::models` re-exports the types for existing callers.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappCallSessionRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[serde(rename = "connectionId")]
    #[sqlx(rename = "connection_id")]
    pub connection_id: String,
    #[serde(rename = "conversationId")]
    #[sqlx(rename = "conversation_id")]
    pub conversation_id: Option<String>,
    pub direction: String,
    pub status: String,
    #[serde(rename = "waCallId")]
    #[sqlx(rename = "wa_call_id")]
    pub wa_call_id: Option<String>,
    #[serde(rename = "fromPhone")]
    #[sqlx(rename = "from_phone")]
    pub from_phone: String,
    #[serde(rename = "toPhone")]
    #[sqlx(rename = "to_phone")]
    pub to_phone: String,
    #[serde(rename = "agentLabel")]
    #[sqlx(rename = "agent_label")]
    pub agent_label: Option<String>,
    #[serde(rename = "startedAt")]
    #[sqlx(rename = "started_at")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(rename = "answeredAt")]
    #[sqlx(rename = "answered_at")]
    pub answered_at: Option<DateTime<Utc>>,
    #[serde(rename = "endedAt")]
    #[sqlx(rename = "ended_at")]
    pub ended_at: Option<DateTime<Utc>>,
    #[serde(rename = "durationSeconds")]
    #[sqlx(rename = "duration_seconds")]
    pub duration_seconds: Option<i32>,
    #[serde(rename = "errorCode")]
    #[sqlx(rename = "error_code")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    #[serde(rename = "rawPayload")]
    #[sqlx(rename = "raw_payload")]
    pub raw_payload: Option<Value>,
    #[serde(rename = "conversationCustomerName")]
    #[sqlx(rename = "conversation_customer_name")]
    pub conversation_customer_name: Option<String>,
    #[serde(rename = "connectionLabel")]
    #[sqlx(rename = "connection_label")]
    pub connection_label: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappCallEventRow {
    pub id: String,
    #[serde(rename = "sessionId")]
    #[sqlx(rename = "session_id")]
    pub session_id: String,
    #[serde(rename = "eventType")]
    #[sqlx(rename = "event_type")]
    pub event_type: String,
    pub status: Option<String>,
    pub payload: Option<Value>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WhatsappCallActionRequest {
    pub action: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WhatsappCallSignalRequest {
    pub kind: Option<String>,
    pub payload: Option<Value>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct CommunicationCallRow {
    pub id: String,
    pub provider: String,
    #[serde(rename = "providerCallId")]
    #[sqlx(rename = "provider_call_id")]
    pub provider_call_id: Option<String>,
    #[serde(rename = "connectionId")]
    #[sqlx(rename = "connection_id")]
    pub connection_id: Option<String>,
    #[serde(rename = "conversationId")]
    #[sqlx(rename = "conversation_id")]
    pub conversation_id: Option<String>,
    pub direction: String,
    pub status: String,
    #[serde(rename = "fromPhone")]
    #[sqlx(rename = "from_phone")]
    pub from_phone: String,
    #[serde(rename = "toPhone")]
    #[sqlx(rename = "to_phone")]
    pub to_phone: String,
    #[serde(rename = "agentLabel")]
    #[sqlx(rename = "agent_label")]
    pub agent_label: Option<String>,
    #[serde(rename = "startedAt")]
    #[sqlx(rename = "started_at")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(rename = "answeredAt")]
    #[sqlx(rename = "answered_at")]
    pub answered_at: Option<DateTime<Utc>>,
    #[serde(rename = "endedAt")]
    #[sqlx(rename = "ended_at")]
    pub ended_at: Option<DateTime<Utc>>,
    #[serde(rename = "durationSeconds")]
    #[sqlx(rename = "duration_seconds")]
    pub duration_seconds: Option<i32>,
    #[serde(rename = "errorCode")]
    #[sqlx(rename = "error_code")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    #[serde(rename = "connectionLabel")]
    #[sqlx(rename = "connection_label")]
    pub connection_label: Option<String>,
    #[serde(rename = "conversationCustomerName")]
    #[sqlx(rename = "conversation_customer_name")]
    pub conversation_customer_name: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct VoiceConnectionCreateRequest {
    #[serde(rename = "phoneNumber")]
    pub phone_number: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}
