use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
    pub password: Option<String>,
    #[sqlx(rename = "emailVerified")]
    pub email_verified: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SessionRecord {
    pub id: String,
    #[sqlx(rename = "sessionToken")]
    pub session_token: String,
    #[sqlx(rename = "userId")]
    pub user_id: String,
    pub expires: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebPushSubscriptionKeysRequest {
    pub p256dh: Option<String>,
    pub auth: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebPushSubscriptionRequest {
    pub endpoint: Option<String>,
    #[serde(rename = "expirationTime")]
    pub expiration_time: Option<i64>,
    pub keys: Option<WebPushSubscriptionKeysRequest>,
}

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

#[derive(Debug, Deserialize, Serialize)]
pub struct WhatsappCallBridgeEventRequest {
    #[serde(rename = "callId")]
    pub call_id: Option<String>,
    #[serde(rename = "waCallId")]
    pub wa_call_id: Option<String>,
    #[serde(rename = "eventType")]
    pub event_type: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "signalKind")]
    pub signal_kind: Option<String>,
    #[serde(rename = "signalPayload")]
    pub signal_payload: Option<Value>,
    pub payload: Option<Value>,
    pub source: Option<String>,
}
