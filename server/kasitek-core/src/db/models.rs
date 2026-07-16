use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::HashMap;

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
pub struct WhatsappConnectionRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[serde(rename = "orgId")]
    #[sqlx(rename = "org_id")]
    pub org_id: Option<String>,
    #[sqlx(rename = "phone_number_id")]
    pub phone_number_id: String,
    #[sqlx(rename = "phone_display_number")]
    pub phone_display_number: Option<String>,
    #[sqlx(rename = "access_token_encrypted")]
    pub access_token_encrypted: String,
    #[sqlx(rename = "waba_id")]
    pub waba_id: String,
    #[sqlx(rename = "current_quality_rating")]
    pub current_quality_rating: String,
    #[sqlx(rename = "daily_limit_estimate")]
    pub daily_limit_estimate: Option<i32>,
    pub verified: bool,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhatsappConnectionPublic {
    pub id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "phoneNumberId")]
    pub phone_number_id: String,
    #[serde(rename = "phoneDisplayNumber")]
    pub phone_display_number: Option<String>,
    #[serde(rename = "wabaId")]
    pub waba_id: String,
    #[serde(rename = "currentQualityRating")]
    pub current_quality_rating: String,
    #[serde(rename = "dailyLimitEstimate")]
    pub daily_limit_estimate: Option<i32>,
    pub verified: bool,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

impl From<WhatsappConnectionRow> for WhatsappConnectionPublic {
    fn from(value: WhatsappConnectionRow) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id,
            phone_number_id: value.phone_number_id,
            phone_display_number: value.phone_display_number,
            waba_id: value.waba_id,
            current_quality_rating: value.current_quality_rating,
            daily_limit_estimate: value.daily_limit_estimate,
            verified: value.verified,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappTemplateRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[sqlx(rename = "connection_id")]
    pub connection_id: Option<String>,
    #[sqlx(rename = "template_name")]
    pub template_name: String,
    pub language: String,
    pub category: String,
    pub header: Option<String>,
    pub body: Option<String>,
    pub footer: Option<String>,
    pub buttons: Option<Value>,
    #[sqlx(rename = "variables_count")]
    pub variables_count: i32,
    pub status: String,
    #[sqlx(rename = "last_synced")]
    pub last_synced: Option<DateTime<Utc>>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappConnectionCreateRequest {
    #[serde(rename = "wabaId")]
    pub waba_id: Option<String>,
    #[serde(rename = "phoneNumberId")]
    pub phone_number_id: Option<String>,
    #[serde(rename = "accessToken")]
    pub access_token: Option<String>,
    #[serde(rename = "phoneDisplayNumber")]
    pub phone_display_number: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappConnectionTokenRequest {
    #[serde(rename = "accessToken")]
    pub access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappTemplateCreateRequest {
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[serde(rename = "templateName")]
    pub template_name: Option<String>,
    pub language: Option<String>,
    pub category: Option<String>,
    pub header: Option<String>,
    pub body: Option<String>,
    pub footer: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappCampaignRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    #[serde(rename = "orgId")]
    #[sqlx(rename = "org_id")]
    pub org_id: Option<String>,
    #[sqlx(rename = "connection_id")]
    pub connection_id: String,
    #[sqlx(rename = "template_id")]
    pub template_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    #[sqlx(rename = "template_name")]
    pub template_name: String,
    #[sqlx(rename = "template_language")]
    pub template_language: String,
    #[serde(rename = "variableMappings")]
    #[sqlx(rename = "variable_mappings")]
    pub variable_mappings: Option<Value>,
    #[serde(rename = "templateHeader")]
    #[sqlx(rename = "template_header")]
    pub template_header: Option<String>,
    #[serde(rename = "templateBody")]
    #[sqlx(rename = "template_body")]
    pub template_body: Option<String>,
    #[serde(rename = "templateFooter")]
    #[sqlx(rename = "template_footer")]
    pub template_footer: Option<String>,
    #[serde(rename = "templateButtons")]
    #[sqlx(rename = "template_buttons")]
    pub template_buttons: Option<Value>,
    #[serde(rename = "listLabel")]
    #[sqlx(rename = "list_label")]
    pub list_label: Option<String>,
    #[serde(rename = "defaultBatchSize")]
    #[sqlx(rename = "default_batch_size")]
    pub default_batch_size: Option<i32>,
    pub status: String,
    #[sqlx(rename = "scheduled_at")]
    pub scheduled_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "launched_at")]
    pub launched_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "completed_at")]
    pub completed_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "total_recipients")]
    pub total_recipients: i32,
    #[sqlx(rename = "sent_count")]
    pub sent_count: i32,
    #[sqlx(rename = "delivered_count")]
    pub delivered_count: i32,
    #[sqlx(rename = "read_count")]
    pub read_count: i32,
    #[sqlx(rename = "failed_count")]
    pub failed_count: i32,
    #[sqlx(rename = "blocked_count")]
    pub blocked_count: i32,
    #[sqlx(rename = "unsubscribed_count")]
    pub unsubscribed_count: i32,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "connectionLabel")]
    #[sqlx(rename = "connection_label")]
    pub connection_label: Option<String>,
    #[serde(rename = "templateStatus")]
    #[sqlx(rename = "template_status")]
    pub template_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappCampaignRecipientRow {
    pub id: String,
    #[sqlx(rename = "campaign_id")]
    pub campaign_id: String,
    #[sqlx(rename = "contact_id")]
    pub contact_id: String,
    #[serde(rename = "snapshotPhone")]
    #[sqlx(rename = "snapshot_phone")]
    pub snapshot_phone: Option<String>,
    #[serde(rename = "snapshotFullName")]
    #[sqlx(rename = "snapshot_full_name")]
    pub snapshot_full_name: Option<String>,
    #[serde(rename = "snapshotLocation")]
    #[sqlx(rename = "snapshot_location")]
    pub snapshot_location: Option<String>,
    #[serde(rename = "snapshotListLabel")]
    #[sqlx(rename = "snapshot_list_label")]
    pub snapshot_list_label: Option<String>,
    #[serde(rename = "snapshotMetadata")]
    #[sqlx(rename = "snapshot_metadata")]
    pub snapshot_metadata: Option<Value>,
    pub status: String,
    #[sqlx(rename = "wa_message_id")]
    pub wa_message_id: Option<String>,
    #[sqlx(rename = "sent_at")]
    pub sent_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "delivered_at")]
    pub delivered_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "read_at")]
    pub read_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "failed_at")]
    pub failed_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "error_code")]
    pub error_code: Option<String>,
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappCampaignRecipientDetailRow {
    pub id: String,
    #[sqlx(rename = "campaign_id")]
    pub campaign_id: String,
    #[sqlx(rename = "contact_id")]
    pub contact_id: String,
    #[serde(rename = "snapshotPhone")]
    #[sqlx(rename = "snapshot_phone")]
    pub snapshot_phone: Option<String>,
    #[serde(rename = "snapshotFullName")]
    #[sqlx(rename = "snapshot_full_name")]
    pub snapshot_full_name: Option<String>,
    #[serde(rename = "snapshotLocation")]
    #[sqlx(rename = "snapshot_location")]
    pub snapshot_location: Option<String>,
    #[serde(rename = "snapshotListLabel")]
    #[sqlx(rename = "snapshot_list_label")]
    pub snapshot_list_label: Option<String>,
    #[serde(rename = "snapshotMetadata")]
    #[sqlx(rename = "snapshot_metadata")]
    pub snapshot_metadata: Option<Value>,
    pub status: String,
    #[serde(rename = "waMessageId")]
    #[sqlx(rename = "wa_message_id")]
    pub wa_message_id: Option<String>,
    #[serde(rename = "sentAt")]
    #[sqlx(rename = "sent_at")]
    pub sent_at: Option<DateTime<Utc>>,
    #[serde(rename = "deliveredAt")]
    #[sqlx(rename = "delivered_at")]
    pub delivered_at: Option<DateTime<Utc>>,
    #[serde(rename = "readAt")]
    #[sqlx(rename = "read_at")]
    pub read_at: Option<DateTime<Utc>>,
    #[serde(rename = "failedAt")]
    #[sqlx(rename = "failed_at")]
    pub failed_at: Option<DateTime<Utc>>,
    #[serde(rename = "errorCode")]
    #[sqlx(rename = "error_code")]
    pub error_code: Option<String>,
    #[serde(rename = "errorMessage")]
    #[sqlx(rename = "error_message")]
    pub error_message: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "contactPhone")]
    #[sqlx(rename = "contact_phone")]
    pub contact_phone: String,
    #[serde(rename = "contactFullName")]
    #[sqlx(rename = "contact_full_name")]
    pub contact_full_name: Option<String>,
    #[serde(rename = "contactLocation")]
    #[sqlx(rename = "contact_location")]
    pub contact_location: Option<String>,
    #[serde(rename = "contactListLabel")]
    #[sqlx(rename = "contact_list_label")]
    pub contact_list_label: String,
    #[serde(rename = "contactMetadata")]
    pub contact_metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappListContactRow {
    pub id: String,
    #[serde(rename = "contactId")]
    #[sqlx(rename = "contact_id")]
    pub contact_id: String,
    #[serde(rename = "userId")]
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    pub phone: String,
    #[serde(rename = "fullName")]
    #[sqlx(rename = "full_name")]
    pub full_name: Option<String>,
    pub tags: Vec<String>,
    pub location: Option<String>,
    #[serde(rename = "listLabel")]
    #[sqlx(rename = "list_label")]
    pub list_label: String,
    pub metadata: Option<Value>,
    #[serde(rename = "optIn")]
    #[sqlx(rename = "opt_in")]
    pub opt_in: bool,
    #[serde(rename = "optInSource")]
    #[sqlx(rename = "opt_in_source")]
    pub opt_in_source: Option<String>,
    #[serde(rename = "optInDate")]
    #[sqlx(rename = "opt_in_date")]
    pub opt_in_date: Option<DateTime<Utc>>,
    #[serde(rename = "lastMarketingSent")]
    #[sqlx(rename = "last_marketing_sent")]
    pub last_marketing_sent: Option<DateTime<Utc>>,
    pub excluded: bool,
    pub notes: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WhatsappContactRow {
    pub id: String,
    #[serde(rename = "userId")]
    #[sqlx(rename = "user_id")]
    pub user_id: String,
    pub phone: String,
    #[serde(rename = "fullName")]
    #[sqlx(rename = "full_name")]
    pub full_name: Option<String>,
    pub tags: Vec<String>,
    pub location: Option<String>,
    #[serde(rename = "listLabel")]
    #[sqlx(rename = "list_label")]
    pub list_label: String,
    pub metadata: Option<Value>,
    #[serde(rename = "optIn")]
    #[sqlx(rename = "opt_in")]
    pub opt_in: bool,
    #[serde(rename = "optInSource")]
    #[sqlx(rename = "opt_in_source")]
    pub opt_in_source: Option<String>,
    #[serde(rename = "optInDate")]
    #[sqlx(rename = "opt_in_date")]
    pub opt_in_date: Option<DateTime<Utc>>,
    #[serde(rename = "lastMarketingSent")]
    #[sqlx(rename = "last_marketing_sent")]
    pub last_marketing_sent: Option<DateTime<Utc>>,
    pub excluded: bool,
    pub notes: Option<String>,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappContactListQuery {
    pub q: Option<String>,
    #[serde(rename = "optIn")]
    pub opt_in: Option<String>,
    pub excluded: Option<String>,
    pub tag: Option<String>,
    pub location: Option<String>,
    #[serde(rename = "listLabel")]
    pub list_label: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappTemplateListQuery {
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappAudienceFilterRequest {
    pub tags: Option<Vec<String>>,
    pub location: Option<String>,
    pub search: Option<String>,
    #[serde(rename = "listLabel")]
    pub list_label: Option<String>,
    #[serde(rename = "optInStatus")]
    pub opt_in_status: Option<String>,
    #[serde(rename = "excludedStatus")]
    pub excluded_status: Option<String>,
    #[serde(rename = "cooldownStatus")]
    pub cooldown_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappCampaignCreateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[serde(rename = "templateId")]
    pub template_id: Option<String>,
    #[serde(rename = "recipientIds")]
    pub recipient_ids: Option<Vec<String>>,
    #[serde(rename = "excludedContactIds")]
    pub excluded_contact_ids: Option<Vec<String>>,
    #[serde(rename = "listLabel")]
    pub list_label: Option<String>,
    #[serde(rename = "batchSize")]
    pub batch_size: Option<i32>,
    #[serde(rename = "scheduledAt")]
    pub scheduled_at: Option<String>,
    #[serde(rename = "variableMappings")]
    pub variable_mappings: Option<Value>,
    pub audience: Option<WhatsappAudienceFilterRequest>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappCampaignActionRequest {
    pub action: Option<String>,
    #[serde(rename = "batchSize")]
    pub batch_size: Option<i32>,
    #[serde(rename = "excludedContactIds")]
    pub excluded_contact_ids: Option<Vec<String>>,
    #[serde(rename = "scheduledAt")]
    pub scheduled_at: Option<String>,
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
pub struct WhatsappStartConversationRequest {
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[serde(rename = "templateId")]
    pub template_id: Option<String>,
    pub phone: Option<String>,
    #[serde(rename = "customerName")]
    pub customer_name: Option<String>,
    #[serde(rename = "bodyParameters")]
    pub body_parameters: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappSendMessageRequest {
    pub text: Option<String>,
    #[serde(rename = "replyToMessageId")]
    pub reply_to_message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappReactionRequest {
    pub emoji: Option<String>,
    pub remove: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappContactUpdateRequest {
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    pub phone: Option<String>,
    pub location: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    #[serde(rename = "listLabel")]
    pub list_label: Option<String>,
    pub metadata: Option<Value>,
    #[serde(rename = "optIn")]
    pub opt_in: Option<bool>,
    pub excluded: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct WhatsappContactListRenameRequest {
    #[serde(rename = "nextLabel")]
    pub next_label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WhatsappContactImportInvalidRow {
    pub index: usize,
    pub error: String,
    pub row: std::collections::HashMap<String, String>,
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

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BotConfigurationRow {
    pub id: String,
    #[sqlx(rename = "user_id")]
    #[serde(rename = "userId")]
    pub user_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub bot_type: String,
    pub status: String,
    #[sqlx(rename = "greeting_message")]
    #[serde(rename = "greetingMessage")]
    pub greeting_message: Option<String>,
    pub personality: Option<String>,
    pub language: String,
    pub capabilities: Option<Value>,
    #[sqlx(rename = "knowledge_base")]
    #[serde(rename = "knowledgeBase")]
    pub knowledge_base: Option<Value>,
    #[sqlx(rename = "integration_config")]
    #[serde(rename = "integrationConfig")]
    pub integration_config: Option<Value>,
    #[sqlx(rename = "created_at")]
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updated_at")]
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
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
pub struct BotCreateRequest {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub bot_type: Option<String>,
    #[serde(rename = "autoProvision")]
    pub auto_provision: Option<bool>,
    pub language: Option<String>,
    #[serde(rename = "greetingMessage")]
    pub greeting_message: Option<String>,
    pub personality: Option<String>,
    pub capabilities: Option<Value>,
    #[serde(rename = "integrationConfig")]
    pub integration_config: Option<Value>,
    #[serde(rename = "businessDetails")]
    pub business_details: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct BotEventCreateRequest {
    #[serde(rename = "eventType")]
    pub event_type: Option<String>,
    pub channel: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    #[serde(rename = "responseTimeMs")]
    pub response_time_ms: Option<i32>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct BotActionRequest {
    pub action: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BotDeploymentCallbackRequest {
    pub status: Option<String>,
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    pub message: Option<String>,
    pub payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub metadata: Option<Value>,
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

#[derive(Debug, Deserialize)]
pub struct WhatsappEmbeddedSignupRequest {
    pub code: Option<String>,
    #[serde(rename = "wabaId")]
    pub waba_id: Option<String>,
    #[serde(rename = "phoneNumberId")]
    pub phone_number_id: Option<String>,
}
