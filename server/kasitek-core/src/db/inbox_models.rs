//! Domain-owned inbox conversation and message models.
//!
//! Shared inbox persistence rows remain reusable across social and WhatsApp
//! transports while `db::models` keeps compatibility re-exports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ConversationRow {
    pub id: String,
    pub channel: String,
    #[sqlx(rename = "customer_identifier")]
    pub customer_identifier: String,
    #[sqlx(rename = "customer_name")]
    pub customer_name: Option<String>,
    pub status: String,
    #[sqlx(rename = "last_message_at")]
    pub last_message_at: DateTime<Utc>,
    #[sqlx(rename = "last_read_at")]
    pub last_read_at: Option<DateTime<Utc>>,
    pub starred: bool,
    #[sqlx(rename = "unread_count")]
    pub unread_count: i32,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct InboxConversationListRow {
    pub id: String,
    pub channel: String,
    #[sqlx(rename = "customer_identifier")]
    pub customer_identifier: String,
    #[sqlx(rename = "customer_name")]
    pub customer_name: Option<String>,
    pub status: String,
    #[sqlx(rename = "last_message_at")]
    pub last_message_at: DateTime<Utc>,
    #[sqlx(rename = "last_read_at")]
    pub last_read_at: Option<DateTime<Utc>>,
    pub starred: bool,
    #[sqlx(rename = "unread_count")]
    pub unread_count: i32,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "connection_id")]
    pub connection_id: Option<String>,
    pub phone: Option<String>,
    #[sqlx(rename = "connection_label")]
    pub connection_label: Option<String>,
    #[sqlx(rename = "last_message_content")]
    pub last_message_content: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct ConversationUpdateRequest {
    pub starred: Option<bool>,
}
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MessageRow {
    pub id: String,
    #[sqlx(rename = "conversation_id")]
    pub conversation_id: String,
    pub sender: String,
    pub content: String,
    #[sqlx(rename = "whatsapp_message_id")]
    pub whatsapp_message_id: Option<String>,
    #[sqlx(rename = "whatsapp_status")]
    pub whatsapp_status: Option<String>,
    #[sqlx(rename = "error_code")]
    pub error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    pub timestamp: DateTime<Utc>,
}
