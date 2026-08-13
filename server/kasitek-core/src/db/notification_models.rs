//! Domain-owned notification and push-subscription models.
//!
//! Notification inbox rows and browser push DTOs live beside notification
//! services while `db::models` keeps compatibility re-exports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
#[derive(Debug, Deserialize)]
pub struct NotificationListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationActionRequest {
    pub action: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct SavePushSubscriptionRequest {
    pub subscription: Option<WebPushSubscriptionRequest>,
}

#[derive(Debug, Deserialize)]
pub struct DeletePushSubscriptionRequest {
    pub endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendPushTestRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PushSubscriptionStatusResponse {
    pub configured: bool,
    #[serde(rename = "publicKey")]
    pub public_key: Option<String>,
    pub subscribed: bool,
    #[serde(rename = "subscriptionCount")]
    pub subscription_count: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct NotificationInboxRow {
    #[sqlx(rename = "notification_id")]
    pub notification_id: String,
    #[sqlx(rename = "event_id")]
    pub event_id: String,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "event_type")]
    pub event_type: String,
    pub title: String,
    pub message: String,
    pub severity: String,
    #[sqlx(rename = "entity_type")]
    pub entity_type: Option<String>,
    #[sqlx(rename = "entity_id")]
    pub entity_id: Option<String>,
    pub payload: Option<Value>,
    pub status: String,
    #[sqlx(rename = "read_at")]
    pub read_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "email_delivery_status")]
    pub email_delivery_status: Option<String>,
    #[sqlx(rename = "email_delivery_error")]
    pub email_delivery_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NotificationInboxItem {
    pub id: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "eventType")]
    pub event_type: String,
    pub title: String,
    pub message: String,
    pub severity: String,
    #[serde(rename = "entityType")]
    pub entity_type: Option<String>,
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
    pub payload: Option<Value>,
    pub status: String,
    #[serde(rename = "isUnread")]
    pub is_unread: bool,
    #[serde(rename = "emailDeliveryStatus")]
    pub email_delivery_status: Option<String>,
    #[serde(rename = "emailDeliveryError")]
    pub email_delivery_error: Option<String>,
}

impl From<NotificationInboxRow> for NotificationInboxItem {
    fn from(value: NotificationInboxRow) -> Self {
        let status = value.status;
        let is_unread = value.read_at.is_none() && status != "DISMISSED" && status != "FAILED";

        Self {
            id: value.notification_id,
            event_id: value.event_id,
            created_at: value.created_at,
            event_type: value.event_type,
            title: value.title,
            message: value.message,
            severity: value.severity,
            entity_type: value.entity_type,
            entity_id: value.entity_id,
            payload: value.payload,
            status,
            is_unread,
            email_delivery_status: value.email_delivery_status,
            email_delivery_error: value.email_delivery_error,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NotificationInboxResponse {
    pub items: Vec<NotificationInboxItem>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
}
