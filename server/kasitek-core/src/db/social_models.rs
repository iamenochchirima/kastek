//! Domain-owned social channel, post, and publishing models.
//!
//! Social persistence rows and transport DTOs live beside the decomposed
//! social services while `db::models` retains compatibility re-exports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::HashMap;
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

/// A workspace-owned media asset attached to a social post. Storage keys are
/// deliberately not exposed here; clients receive a media URL only through a
/// later authorized delivery endpoint.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SocialPostMedia {
    pub id: String,
    #[sqlx(rename = "post_id")]
    pub post_id: String,
    #[sqlx(rename = "asset_id")]
    pub asset_id: String,
    pub kind: String,
    #[sqlx(rename = "mime_type")]
    pub mime_type: String,
    #[sqlx(rename = "file_name")]
    pub file_name: Option<String>,
    #[sqlx(rename = "byte_size")]
    pub byte_size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    #[sqlx(rename = "duration_ms")]
    pub duration_ms: Option<i32>,
    #[sqlx(rename = "sort_order")]
    pub sort_order: i32,
    #[sqlx(rename = "alt_text")]
    pub alt_text: Option<String>,
    #[sqlx(rename = "processing_status")]
    pub processing_status: String,
    #[sqlx(rename = "scan_status")]
    pub scan_status: String,
    pub metadata: Option<Value>,
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
    #[sqlx(rename = "delivery_snapshot")]
    #[serde(rename = "deliverySnapshot")]
    pub delivery_snapshot: Option<Value>,
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
    pub media: Vec<SocialPostMedia>,
    #[serde(rename = "publishJobs")]
    pub publish_jobs: Vec<SocialPublishJobRow>,
}

impl SocialPost {
    pub fn from_parts(
        row: SocialPostRow,
        channels: &HashMap<String, SocialChannel>,
        variants: Vec<SocialPostVariant>,
        media: Vec<SocialPostMedia>,
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
            media,
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

#[derive(Debug, Deserialize, Clone)]
pub struct SocialPostMediaInput {
    #[serde(rename = "assetId")]
    pub asset_id: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: Option<i32>,
    #[serde(rename = "altText")]
    pub alt_text: Option<String>,
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
    pub media: Option<Vec<SocialPostMediaInput>>,
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
