//! Domain-owned WhatsApp persistence rows and transport DTOs.
//!
//! These types are kept beside the WhatsApp service boundaries rather than in
//! the global product model file. `db::models` re-exports them temporarily for
//! existing controller and adapter imports during the migration.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

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
    #[serde(rename = "customerId")]
    #[sqlx(rename = "customer_id")]
    pub customer_id: Option<String>,
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
pub struct WhatsappEmbeddedSignupRequest {
    pub code: Option<String>,
    #[serde(rename = "wabaId")]
    pub waba_id: Option<String>,
    #[serde(rename = "phoneNumberId")]
    pub phone_number_id: Option<String>,
}
