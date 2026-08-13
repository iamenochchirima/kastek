use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::HashMap;

pub use super::call_models::*;
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

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SocialChannel {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    pub platform: String,
    pub status: String,
    #[sqlx(rename = "display_name")]
    pub display_name: String,
    pub handle: Option<String>,
    #[sqlx(rename = "external_account_id")]
    pub external_account_id: Option<String>,
    pub metadata: Option<Value>,
    #[sqlx(rename = "last_synced_at")]
    pub last_synced_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SocialPostRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[sqlx(rename = "primary_channel_id")]
    pub primary_channel_id: Option<String>,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub content: String,
    pub channels: Vec<String>,
    pub status: String,
    #[sqlx(rename = "scheduled_for")]
    pub scheduled_for: Option<DateTime<Utc>>,
    #[sqlx(rename = "published_at")]
    pub published_at: Option<DateTime<Utc>>,
    pub metadata: Option<Value>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SocialPostVariant {
    pub id: String,
    #[sqlx(rename = "post_id")]
    pub post_id: String,
    pub platform: String,
    pub content: String,
    pub status: String,
    #[sqlx(rename = "ai_generated")]
    pub ai_generated: bool,
    pub metadata: Option<Value>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SocialPublishJobRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[sqlx(rename = "post_id")]
    pub post_id: String,
    #[sqlx(rename = "variant_id")]
    pub variant_id: Option<String>,
    #[sqlx(rename = "channel_connection_id")]
    pub channel_connection_id: Option<String>,
    pub platform: String,
    pub status: String,
    #[sqlx(rename = "scheduled_for")]
    pub scheduled_for: Option<DateTime<Utc>>,
    #[sqlx(rename = "published_at")]
    pub published_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "external_post_id")]
    pub external_post_id: Option<String>,
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    pub metadata: Option<Value>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SocialPost {
    #[serde(flatten)]
    pub row: SocialPostRow,
    #[serde(rename = "primaryChannel")]
    pub primary_channel: Option<SocialChannel>,
    pub variants: Vec<SocialPostVariant>,
    #[serde(rename = "publishJobs")]
    pub publish_jobs: Vec<SocialPublishJobRow>,
}

impl SocialPost {
    pub fn from_parts(
        row: SocialPostRow,
        channels: &HashMap<String, SocialChannel>,
        variants: Vec<SocialPostVariant>,
        publish_jobs: Vec<SocialPublishJobRow>,
    ) -> Self {
        let primary_channel = row
            .primary_channel_id
            .as_ref()
            .and_then(|id| channels.get(id))
            .cloned();

        Self {
            row,
            primary_channel,
            variants,
            publish_jobs,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SocialChannelCreateRequest {
    pub platform: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub handle: Option<String>,
    #[serde(rename = "externalAccountId")]
    pub external_account_id: Option<String>,
    pub status: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SocialChannelUpdateRequest {
    pub platform: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub handle: Option<String>,
    pub status: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ExternalConnection {
    pub id: String,
    pub provider: String,
    #[sqlx(rename = "external_account_id")]
    #[serde(rename = "externalAccountId")]
    pub external_account_id: Option<String>,
    #[sqlx(rename = "display_name")]
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub handle: Option<String>,
    pub status: String,
    #[sqlx(rename = "credential_status")]
    #[serde(rename = "credentialStatus")]
    pub credential_status: String,
    #[sqlx(rename = "health_status")]
    #[serde(rename = "healthStatus")]
    pub health_status: String,
    #[sqlx(rename = "webhook_status")]
    #[serde(rename = "webhookStatus")]
    pub webhook_status: String,
    #[sqlx(rename = "last_checked_at")]
    #[serde(rename = "lastCheckedAt")]
    pub last_checked_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "last_error")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    pub metadata: Option<Value>,
    pub capabilities: Value,
    pub consumers: Value,
    #[sqlx(rename = "created_at")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ExternalConnectionStatusRequest {
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SocialPostVariantInput {
    pub platform: String,
    pub content: String,
    pub status: Option<String>,
    #[serde(rename = "aiGenerated")]
    pub ai_generated: Option<bool>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SocialPostUpsertRequest {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub content: Option<String>,
    pub channels: Option<Vec<String>>,
    pub status: Option<String>,
    #[serde(rename = "scheduledFor")]
    pub scheduled_for: Option<String>,
    #[serde(rename = "primaryChannelId")]
    pub primary_channel_id: Option<String>,
    #[serde(rename = "channelSelections")]
    pub channel_selections: Option<HashMap<String, String>>,
    pub variants: Option<Vec<SocialPostVariantInput>>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SocialPublishRequest {
    pub platform: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SocialPublishJobActionRequest {
    pub action: Option<String>,
}

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
