use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

pub use super::call_models::*;
pub use super::inbox_models::*;
pub use super::social_models::*;
pub use super::whatsapp_models::*;

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

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AdminUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub password: String,
    pub role: String,
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

#[derive(Debug, Serialize)]
pub struct UserProfileResponse {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
    #[serde(rename = "emailVerified")]
    pub email_verified: Option<DateTime<Utc>>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

impl From<User> for UserProfileResponse {
    fn from(value: User) -> Self {
        Self {
            id: value.id,
            name: value.name,
            email: value.email,
            phone: value.phone,
            image: value.image,
            email_verified: value.email_verified,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AdminUserResponse {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

impl From<AdminUser> for AdminUserResponse {
    fn from(value: AdminUser) -> Self {
        Self {
            id: value.id,
            name: value.name,
            email: value.email,
            role: value.role,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub name: Option<String>,
    pub phone: Option<String>,
    #[serde(rename = "phoneVerified")]
    pub phone_verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct AccountCheckRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResendVerificationRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendOtpRequest {
    pub phone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyOtpRequest {
    pub phone: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PasswordSetupRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetPasswordRequest {
    pub email: Option<String>,
    pub token: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub name: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProfileBootstrapResponse {
    pub user: UserProfileResponse,
    #[serde(rename = "hasPassword")]
    pub has_password: bool,
}

#[derive(Debug, Deserialize)]
pub struct OnboardingPhoneRequest {
    pub phone: Option<String>,
    #[serde(rename = "phoneVerified")]
    pub phone_verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChangeEmailRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(rename = "currentPassword")]
    pub current_password: Option<String>,
    #[serde(rename = "nextPassword")]
    pub next_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminForgotPasswordRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminResetPasswordRequest {
    pub email: Option<String>,
    pub token: Option<String>,
    pub password: Option<String>,
}

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

#[derive(Debug, Deserialize)]
pub struct SocialIdeasRequest {
    pub topic: Option<String>,
    pub objective: Option<String>,
    pub channels: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SocialCaptionRequest {
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub channels: Option<Vec<String>>,
    #[serde(rename = "currentContent")]
    pub current_content: Option<String>,
}
