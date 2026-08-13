use actix_multipart::Multipart;
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::time::Duration as StdDuration;

use crate::config::AppConfig;
use crate::db::models::{
    ConversationRow, ConversationUpdateRequest, InboxConversationListRow, MessageRow,
    WhatsappAudienceFilterRequest, WhatsappCampaignCreateRequest,
    WhatsappCampaignRecipientDetailRow, WhatsappCampaignRecipientRow, WhatsappCampaignRow,
    WhatsappConnectionRow, WhatsappContactRow, WhatsappListContactRow, WhatsappReactionRequest,
    WhatsappSendMessageRequest, WhatsappStartConversationRequest, WhatsappTemplateRow,
};
use crate::error::AppError;
use crate::services::agent_platform::AgentPlatformClient;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::realtime;
use crate::services::social::decrypt_social_secret;
use crate::services::whatsapp_calls;
use crate::services::{billing, customers, message_domain};

pub(crate) const GRAPH_BASE: &str = "https://graph.facebook.com/v19.0";

pub use super::whatsapp_connections::{
    complete_embedded_signup, connect_manual_connection, connection_health, list_connections,
    refresh_connection, update_connection_access_token,
};
pub(crate) use super::whatsapp_connections::{get_connection_row_for_org, select_connection_sql};
pub use super::whatsapp_contacts::{
    delete_contact_list, export_contact_list, import_contacts, list_contacts, rename_contact_list,
    update_contact,
};
pub use super::whatsapp_templates::{create_template, list_templates, sync_connection_templates};

#[derive(serde::Deserialize)]
struct GraphErrorEnvelope {
    error: Option<GraphError>,
}

#[derive(serde::Deserialize)]
struct GraphError {
    message: Option<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct GraphTemplatesResponse {
    pub(crate) data: Option<Vec<GraphTemplate>>,
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct GraphTemplate {
    pub(crate) name: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) components: Option<Vec<GraphTemplateComponent>>,
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct GraphTemplateComponent {
    #[serde(rename = "type")]
    pub(crate) component_type: Option<String>,
    pub(crate) text: Option<String>,
    pub(crate) buttons: Option<Vec<Value>>,
}

#[derive(Debug, sqlx::FromRow)]
struct PendingInboxMessageRow {
    pub id: String,
    pub conversation_id: String,
    pub user_id: String,
    pub customer_identifier: String,
    pub phone_number_id: String,
    pub access_token_encrypted: String,
    pub content: String,
}

fn whatsapp_http_timeout() -> StdDuration {
    StdDuration::from_millis(
        std::env::var("WHATSAPP_HTTP_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30_000),
    )
}

fn campaign_processing_timeout() -> ChronoDuration {
    ChronoDuration::seconds(
        std::env::var("WHATSAPP_CAMPAIGN_PROCESSING_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(120),
    )
}

fn whatsapp_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(whatsapp_http_timeout())
        .build()
        .map_err(AppError::from)
}

pub(crate) fn map_template_status(value: Option<&str>) -> String {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "APPROVED" => "APPROVED".to_string(),
        Some(value) if value == "PENDING" => "PENDING".to_string(),
        Some(value) if value == "REJECTED" => "REJECTED".to_string(),
        _ => "DISABLED".to_string(),
    }
}

pub(crate) fn map_template_category(value: Option<&str>) -> Option<String> {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "MARKETING" => Some("MARKETING".to_string()),
        Some(value) if value == "UTILITY" => Some("UTILITY".to_string()),
        Some(value) if value == "AUTHENTICATION" => Some("AUTHENTICATION".to_string()),
        _ => None,
    }
}

pub(crate) fn variables_count(body: Option<&str>) -> i32 {
    body.map(|value| {
        value
            .match_indices("{{")
            .filter(|(index, _)| value[*index..].contains("}}"))
            .count() as i32
    })
    .unwrap_or(0)
}

pub(crate) async fn fetch_graph_json<T: serde::de::DeserializeOwned>(
    _url: &str,
    init: reqwest::RequestBuilder,
) -> Result<T, AppError> {
    let response = init.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        let parsed = serde_json::from_str::<GraphErrorEnvelope>(&body).ok();
        let message = parsed
            .and_then(|value| value.error.and_then(|err| err.message))
            .unwrap_or_else(|| format!("Graph API request failed ({status})"));
        return Err(AppError::BadRequest(message));
    }
    serde_json::from_str(&body)
        .map_err(|_| AppError::Internal("Failed to decode Graph API response".to_string()))
}

fn parse_scheduled_at(value: Option<String>) -> Result<Option<chrono::DateTime<Utc>>, AppError> {
    match value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::BadRequest("Scheduled time is invalid".to_string())),
        None => Ok(None),
    }
}

pub(crate) fn has_confirmed_import_consent(
    includes_opted_in_contact: bool,
    consent_confirmed: bool,
) -> bool {
    !includes_opted_in_contact || consent_confirmed
}

#[cfg(test)]
mod tests {
    use super::has_confirmed_import_consent;

    #[test]
    fn imports_with_opted_in_contacts_require_confirmation() {
        assert!(!has_confirmed_import_consent(true, false));
        assert!(has_confirmed_import_consent(true, true));
        assert!(has_confirmed_import_consent(false, false));
    }
}

fn marketing_cooldown_days() -> i64 {
    std::env::var("WHATSAPP_MARKETING_MIN_DAYS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(10)
}

fn normalize_list_label(raw: &str) -> String {
    let trimmed = raw.trim().to_lowercase();
    let mut normalized = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch);
            last_dash = false;
        } else if !last_dash {
            normalized.push('-');
            last_dash = true;
        }
    }
    normalized.trim_matches('-').to_string()
}

pub(crate) fn sanitize_list_label(input: Option<&str>) -> String {
    let normalized = input.map(normalize_list_label).unwrap_or_default();
    if normalized.is_empty() {
        "default".to_string()
    } else {
        normalized
    }
}

pub(crate) fn extract_contact_metadata(row: &HashMap<String, String>) -> Option<Value> {
    const RESERVED: &[&str] = &[
        "phone",
        "Phone",
        "mobile",
        "Mobile",
        "whatsapp",
        "whatsappNumber",
        "number",
        "fullName",
        "name",
        "Name",
        "contactName",
        "location",
        "city",
        "province",
        "region",
        "tags",
        "segment",
        "groups",
        "notes",
        "note",
        "optIn",
        "opt_in",
        "optedIn",
        "subscribed",
        "consent",
        "optInSource",
        "consentSource",
        "listLabel",
        "list",
    ];

    let mut metadata = serde_json::Map::new();
    for (key, value) in row {
        if RESERVED
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(key))
        {
            continue;
        }
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        metadata.insert(key.trim().to_string(), Value::String(trimmed.to_string()));
    }

    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

fn metadata_string(metadata: &Option<Value>, key: &str) -> String {
    metadata
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn contact_eligible(contact: &WhatsappContactRow) -> (&'static str, bool) {
    if !contact.opt_in {
        return ("not_opted_in", false);
    }
    if contact.excluded {
        return ("excluded", false);
    }
    if let Some(last) = contact.last_marketing_sent {
        let cutoff = Utc::now() - chrono::Duration::days(marketing_cooldown_days());
        if last > cutoff {
            return ("cooldown", false);
        }
    }
    ("ok", true)
}

fn contact_matches_audience(
    contact: &WhatsappContactRow,
    audience: Option<&WhatsappAudienceFilterRequest>,
) -> bool {
    let Some(audience) = audience else {
        return true;
    };

    let search = audience
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    if let Some(search) = search {
        let tag_match = contact
            .tags
            .iter()
            .any(|tag| tag.to_lowercase().contains(&search));
        let name_match = contact
            .full_name
            .as_deref()
            .map(|value| value.to_lowercase().contains(&search))
            .unwrap_or(false);
        let phone_match = contact.phone.to_lowercase().contains(&search);
        let location_match = contact
            .location
            .as_deref()
            .map(|value| value.to_lowercase().contains(&search))
            .unwrap_or(false);

        if !(tag_match || name_match || phone_match || location_match) {
            return false;
        }
    }

    if let Some(location) = audience
        .location
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
    {
        let location_match = contact
            .location
            .as_deref()
            .map(|value| value.to_lowercase().contains(&location))
            .unwrap_or(false);
        if !location_match {
            return false;
        }
    }

    if let Some(list_label) = audience
        .list_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !contact.list_label.eq_ignore_ascii_case(list_label) {
            return false;
        }
    }

    if let Some(tags) = audience.tags.as_ref() {
        let requested = tags
            .iter()
            .map(|tag| tag.trim())
            .filter(|tag| !tag.is_empty())
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        if !requested.is_empty()
            && !contact.tags.iter().any(|tag| {
                requested
                    .iter()
                    .any(|requested_tag| tag.eq_ignore_ascii_case(requested_tag))
            })
        {
            return false;
        }
    }

    match audience.opt_in_status.as_deref().unwrap_or("all") {
        "opted_in" if !contact.opt_in => return false,
        "not_opted_in" if contact.opt_in => return false,
        _ => {}
    }

    match audience.excluded_status.as_deref().unwrap_or("active_only") {
        "active_only" if contact.excluded => return false,
        "excluded_only" if !contact.excluded => return false,
        _ => {}
    }

    match audience.cooldown_status.as_deref().unwrap_or("passed") {
        "passed" => {
            if let Some(last) = contact.last_marketing_sent {
                let cutoff = Utc::now() - chrono::Duration::days(marketing_cooldown_days());
                if last > cutoff {
                    return false;
                }
            }
        }
        "recent" => {
            let Some(last) = contact.last_marketing_sent else {
                return false;
            };
            let cutoff = Utc::now() - chrono::Duration::days(marketing_cooldown_days());
            if last <= cutoff {
                return false;
            }
        }
        _ => {}
    }

    true
}

async fn get_campaign_row(
    pool: &PgPool,
    org_id: &str,
    campaign_id: &str,
) -> Result<Option<WhatsappCampaignRow>, AppError> {
    sqlx::query_as::<_, WhatsappCampaignRow>(
        r#"
        SELECT c.id, c."userId" AS user_id, c."orgId" AS org_id, c."connectionId" AS connection_id, c."templateId" AS template_id,
               c.name, c.description, c."templateName" AS template_name, c."templateLanguage" AS template_language,
               c."variableMappings" AS variable_mappings,
               wt.header AS template_header, wt.body AS template_body, wt.footer AS template_footer, wt.buttons AS template_buttons,
               c."listLabel" AS list_label,
               c."defaultBatchSize" AS default_batch_size, c.status::text AS status,
               c."scheduledAt" AT TIME ZONE 'UTC' AS scheduled_at,
               c."launchedAt" AT TIME ZONE 'UTC' AS launched_at,
               c."completedAt" AT TIME ZONE 'UTC' AS completed_at, c."totalRecipients" AS total_recipients,
               c."sentCount" AS sent_count, c."deliveredCount" AS delivered_count, c."readCount" AS read_count,
               c."failedCount" AS failed_count, c."blockedCount" AS blocked_count, c."unsubscribedCount" AS unsubscribed_count,
               c."createdAt" AT TIME ZONE 'UTC' AS created_at, c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               wt.status::text AS template_status
        FROM "WhatsappCampaign" c
        LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
        LEFT JOIN "WhatsappTemplate" wt ON wt.id = c."templateId"
        WHERE c.id = $1 AND c."orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(campaign_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn list_campaigns(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let campaigns = sqlx::query(
        r#"
        SELECT
            c.id,
            c."userId" AS user_id,
            c."connectionId" AS connection_id,
            c."templateId" AS template_id,
            c.name,
            c.description,
            c."templateName" AS template_name,
            c."templateLanguage" AS template_language,
            c."variableMappings" AS variable_mappings,
            c."listLabel" AS list_label,
            c."defaultBatchSize" AS default_batch_size,
            c.status::text AS status,
            c."scheduledAt" AT TIME ZONE 'UTC' AS scheduled_at,
            c."launchedAt" AT TIME ZONE 'UTC' AS launched_at,
            c."completedAt" AT TIME ZONE 'UTC' AS completed_at,
            c."totalRecipients" AS total_recipients,
            c."sentCount" AS sent_count,
            c."deliveredCount" AS delivered_count,
            c."readCount" AS read_count,
            c."failedCount" AS failed_count,
            c."blockedCount" AS blocked_count,
            c."unsubscribedCount" AS unsubscribed_count,
            c."createdAt" AT TIME ZONE 'UTC' AS created_at,
            c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
            COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
            wt.status::text AS template_status
        FROM "WhatsappCampaign" c
        LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
        LEFT JOIN "WhatsappTemplate" wt ON wt.id = c."templateId"
        WHERE c."orgId" = $1
        ORDER BY c."createdAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    let campaigns = campaigns
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "userId": row.get::<String, _>("user_id"),
                "connectionId": row.get::<String, _>("connection_id"),
                "templateId": row.get::<Option<String>, _>("template_id"),
                "name": row.get::<String, _>("name"),
                "description": row.get::<Option<String>, _>("description"),
                "templateName": row.get::<String, _>("template_name"),
                "templateLanguage": row.get::<String, _>("template_language"),
                "variableMappings": row.get::<Option<Value>, _>("variable_mappings"),
                "listLabel": row.get::<Option<String>, _>("list_label"),
                "defaultBatchSize": row.get::<Option<i32>, _>("default_batch_size"),
                "status": row.get::<String, _>("status"),
                "scheduledAt": row.get::<Option<chrono::DateTime<Utc>>, _>("scheduled_at"),
                "launchedAt": row.get::<Option<chrono::DateTime<Utc>>, _>("launched_at"),
                "completedAt": row.get::<Option<chrono::DateTime<Utc>>, _>("completed_at"),
                "totalRecipients": row.get::<i32, _>("total_recipients"),
                "sentCount": row.get::<i32, _>("sent_count"),
                "deliveredCount": row.get::<i32, _>("delivered_count"),
                "readCount": row.get::<i32, _>("read_count"),
                "failedCount": row.get::<i32, _>("failed_count"),
                "blockedCount": row.get::<i32, _>("blocked_count"),
                "unsubscribedCount": row.get::<i32, _>("unsubscribed_count"),
                "createdAt": row.get::<chrono::DateTime<Utc>, _>("created_at"),
                "updatedAt": row.get::<chrono::DateTime<Utc>, _>("updated_at"),
                "connectionLabel": row.get::<Option<String>, _>("connection_label"),
                "templateStatus": row.get::<Option<String>, _>("template_status"),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "campaigns": campaigns }))
}

pub async fn create_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    input: &WhatsappCampaignCreateRequest,
) -> Result<Value, AppError> {
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Campaign name is required".to_string()))?;
    let connection_id = input.connection_id.as_deref().unwrap_or("");
    let template_id = input.template_id.as_deref().unwrap_or("");
    let list_label = input
        .list_label
        .as_deref()
        .map(|value| sanitize_list_label(Some(value)));
    let excluded_contact_ids = input.excluded_contact_ids.clone().unwrap_or_default();
    let default_batch_size = input.batch_size.filter(|value| *value > 0);
    let scheduled_at = parse_scheduled_at(input.scheduled_at.clone())?;

    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AT TIME ZONE 'UTC' AS last_synced, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappTemplate"
        WHERE id = $1 AND "orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(template_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Template not found".to_string()))?;

    if template.category != "MARKETING" {
        return Err(AppError::BadRequest(
            "Only MARKETING templates are allowed for campaigns".to_string(),
        ));
    }
    if template.status != "APPROVED" {
        return Err(AppError::BadRequest(
            "Only APPROVED templates can be used in campaigns".to_string(),
        ));
    }

    let contacts = if let Some(recipient_ids) = input.recipient_ids.as_ref() {
        if let Some(list_label) = list_label.as_deref() {
            sqlx::query_as::<_, WhatsappContactRow>(
                r#"
                SELECT c.id, c."userId" AS user_id, c.phone,
                       COALESCE(m."fullName", c."fullName") AS full_name,
                       COALESCE(m.tags, ARRAY[]::text[]) AS tags,
                       COALESCE(m.location, c.location) AS location,
                       m."listLabel" AS list_label,
                       COALESCE(m.metadata, c.metadata) AS metadata,
                       m."optIn" AS opt_in,
                       m."optInSource" AS opt_in_source,
                       m."optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                       c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
                       m.excluded,
                       m.notes,
                       c."createdAt" AT TIME ZONE 'UTC' AS created_at,
                       GREATEST(c."updatedAt", m."updatedAt") AT TIME ZONE 'UTC' AS updated_at
                FROM "WhatsappContact" c
                JOIN "WhatsappContactListMembership" m
                  ON m."contactId" = c.id
                 AND m."orgId" = c."orgId"
                WHERE c."orgId" = $1
                  AND c.id = ANY($2)
                  AND m."listLabel" = $3
                "#,
            )
            .bind(org_id)
            .bind(recipient_ids)
            .bind(list_label)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, WhatsappContactRow>(
                r#"
                SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, COALESCE(tags, ARRAY[]::text[]) AS tags, location,
                       COALESCE("listLabel", 'default') AS list_label, metadata,
                       "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                       "lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent, excluded, notes,
                       "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
                FROM "WhatsappContact"
                WHERE "orgId" = $1 AND id = ANY($2)
                "#,
            )
            .bind(org_id)
            .bind(recipient_ids)
            .fetch_all(pool)
            .await?
        }
    } else if let Some(list_label) = list_label.as_deref() {
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT c.id, c."userId" AS user_id, c.phone,
                   COALESCE(m."fullName", c."fullName") AS full_name,
                   COALESCE(m.tags, ARRAY[]::text[]) AS tags,
                   COALESCE(m.location, c.location) AS location,
                   m."listLabel" AS list_label,
                   COALESCE(m.metadata, c.metadata) AS metadata,
                   m."optIn" AS opt_in,
                   m."optInSource" AS opt_in_source,
                   m."optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                   c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
                   m.excluded,
                   m.notes,
                   c."createdAt" AT TIME ZONE 'UTC' AS created_at,
                   GREATEST(c."updatedAt", m."updatedAt") AT TIME ZONE 'UTC' AS updated_at
            FROM "WhatsappContact" c
            JOIN "WhatsappContactListMembership" m
              ON m."contactId" = c.id
             AND m."orgId" = c."orgId"
            WHERE c."orgId" = $1
              AND m."listLabel" = $2
            "#,
        )
        .bind(org_id)
        .bind(list_label)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, COALESCE(tags, ARRAY[]::text[]) AS tags, location,
                   COALESCE("listLabel", 'default') AS list_label, metadata,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                   "lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent, excluded, notes,
                   "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "WhatsappContact"
            WHERE "orgId" = $1
            "#,
        )
        .bind(org_id)
        .fetch_all(pool)
        .await?
    };

    let filtered_contacts = contacts
        .into_iter()
        .filter(|contact| {
            input.recipient_ids.is_some()
                || contact_matches_audience(contact, input.audience.as_ref())
        })
        .collect::<Vec<_>>();
    let filtered_contacts_by_id = filtered_contacts
        .iter()
        .map(|contact| (contact.id.clone(), contact.clone()))
        .collect::<HashMap<_, _>>();

    let mut eligible_ids = Vec::new();
    let mut skipped = json!({
        "notOptedIn": 0,
        "excluded": 0,
        "cooldown": 0
    });
    for contact in &filtered_contacts {
        if excluded_contact_ids
            .iter()
            .any(|value| value == &contact.id)
        {
            skipped["excluded"] = json!(skipped["excluded"].as_i64().unwrap_or(0) + 1);
            continue;
        }
        let (reason, eligible) = contact_eligible(contact);
        if eligible {
            eligible_ids.push(contact.id.clone());
        } else if reason == "not_opted_in" {
            skipped["notOptedIn"] = json!(skipped["notOptedIn"].as_i64().unwrap_or(0) + 1);
        } else if reason == "excluded" {
            skipped["excluded"] = json!(skipped["excluded"].as_i64().unwrap_or(0) + 1);
        } else if reason == "cooldown" {
            skipped["cooldown"] = json!(skipped["cooldown"].as_i64().unwrap_or(0) + 1);
        }
    }

    if eligible_ids.is_empty() {
        let not_opted_in = skipped["notOptedIn"].as_i64().unwrap_or(0);
        let excluded = skipped["excluded"].as_i64().unwrap_or(0);
        let cooldown = skipped["cooldown"].as_i64().unwrap_or(0);
        return Err(AppError::BadRequest(format!(
            "No eligible recipients found for this campaign. Skipped: {not_opted_in} not opted in, {excluded} excluded/manual, {cooldown} in cooldown."
        )));
    }

    let campaign_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "WhatsappCampaign" (
            id, "userId", "orgId", "connectionId", "templateId", name, description, "templateName", "templateLanguage",
            "variableMappings", "listLabel", "defaultBatchSize", status, "scheduledAt", "totalRecipients", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, CAST($13 AS "WhatsappCampaignStatus"), $14, $15, NOW(), NOW()
        )
        "#,
    )
    .bind(&campaign_id)
    .bind(user_id)
    .bind(org_id)
    .bind(&connection.id)
    .bind(&template.id)
    .bind(name)
    .bind(input.description.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()))
    .bind(&template.template_name)
    .bind(&template.language)
    .bind(&input.variable_mappings)
    .bind(list_label.as_deref())
    .bind(default_batch_size)
    .bind(if scheduled_at.map(|v| v > Utc::now()).unwrap_or(false) { "SCHEDULED" } else { "DRAFT" })
    .bind(scheduled_at)
    .bind(eligible_ids.len() as i32)
    .execute(pool)
    .await?;

    for contact_id in &eligible_ids {
        let contact = filtered_contacts_by_id.get(contact_id).ok_or_else(|| {
            AppError::Internal("Failed to snapshot campaign recipient".to_string())
        })?;
        sqlx::query(
            r#"
            INSERT INTO "WhatsappCampaignRecipient" (
                id, "campaignId", "contactId", "snapshotPhone", "snapshotFullName", "snapshotLocation",
                "snapshotListLabel", "snapshotMetadata", status, "createdAt", "updatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING'::"WhatsappRecipientStatus", NOW(), NOW())
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&campaign_id)
        .bind(contact_id)
        .bind(&contact.phone)
        .bind(contact.full_name.as_deref())
        .bind(contact.location.as_deref())
        .bind(&contact.list_label)
        .bind(contact.metadata.as_ref())
        .execute(pool)
        .await?;
    }

    for contact_id in &excluded_contact_ids {
        let contact = filtered_contacts_by_id.get(contact_id);
        sqlx::query(
            r#"
            INSERT INTO "WhatsappCampaignRecipient" (
                id, "campaignId", "contactId", "snapshotPhone", "snapshotFullName", "snapshotLocation",
                "snapshotListLabel", "snapshotMetadata", status, "errorCode", "errorMessage", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                'SKIPPED'::"WhatsappRecipientStatus", 'manual_exclude', 'Excluded before campaign launch', NOW(), NOW()
            )
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&campaign_id)
        .bind(contact_id)
        .bind(contact.map(|value| value.phone.as_str()))
        .bind(contact.and_then(|value| value.full_name.as_deref()))
        .bind(contact.and_then(|value| value.location.as_deref()))
        .bind(contact.map(|value| value.list_label.as_str()))
        .bind(contact.and_then(|value| value.metadata.as_ref()))
        .execute(pool)
        .await?;
    }

    let campaign = get_campaign_row(pool, org_id, &campaign_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload campaign".to_string()))?;

    Ok(json!({
        "campaign": campaign,
        "createdRecipients": eligible_ids.len(),
        "skipped": skipped
    }))
}

pub async fn get_campaign(
    pool: &PgPool,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let recipients = sqlx::query_as::<_, WhatsappCampaignRecipientDetailRow>(
        r#"
        SELECT r.id, r."campaignId" AS campaign_id, r."contactId" AS contact_id, r.status::text AS status,
               r."snapshotPhone" AS snapshot_phone, r."snapshotFullName" AS snapshot_full_name,
               r."snapshotLocation" AS snapshot_location, r."snapshotListLabel" AS snapshot_list_label,
               r."snapshotMetadata" AS snapshot_metadata,
               r."waMessageId" AS wa_message_id, r."sentAt" AT TIME ZONE 'UTC' AS sent_at,
               r."deliveredAt" AT TIME ZONE 'UTC' AS delivered_at,
               r."readAt" AT TIME ZONE 'UTC' AS read_at, r."failedAt" AT TIME ZONE 'UTC' AS failed_at,
               r."errorCode" AS error_code, r."errorMessage" AS error_message,
               r."createdAt" AT TIME ZONE 'UTC' AS created_at, r."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
               COALESCE(r."snapshotPhone", c.phone) AS contact_phone,
               COALESCE(r."snapshotFullName", c."fullName") AS contact_full_name,
               COALESCE(r."snapshotLocation", c.location) AS contact_location,
               COALESCE(r."snapshotListLabel", c."listLabel", 'default') AS contact_list_label,
               COALESCE(r."snapshotMetadata", c.metadata) AS contact_metadata
        FROM "WhatsappCampaignRecipient" r
        JOIN "WhatsappContact" c ON c.id = r."contactId"
        WHERE r."campaignId" = $1
        ORDER BY r."createdAt" ASC
        "#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    Ok(json!({
        "campaign": {
            "campaign": campaign,
            "recipients": recipients
        }
    }))
}

pub async fn get_campaign_summary(
    pool: &PgPool,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;

    Ok(json!({ "campaign": campaign }))
}

pub async fn launch_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
    scheduled_at: Option<String>,
    batch_size: Option<i32>,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let connection_limit = get_connection_row_for_org(pool, org_id, &campaign.connection_id)
        .await?
        .and_then(|c| c.daily_limit_estimate)
        .unwrap_or(i32::MAX);
    let max_batch = batch_size
        .filter(|value| *value > 0)
        .or(campaign.default_batch_size)
        .unwrap_or(i32::MAX);
    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "WhatsappCampaignRecipient"
        WHERE "campaignId" = $1
          AND status = 'PENDING'::"WhatsappRecipientStatus"
          AND "sentAt" IS NULL
          AND "waMessageId" IS NULL
        ORDER BY "createdAt" ASC
        LIMIT $2
        "#,
    )
    .bind(campaign_id)
    .bind(max_batch as i64)
    .fetch_all(pool)
    .await?;
    if recipient_ids.is_empty() {
        return Err(AppError::BadRequest(
            "Campaign has no recipients to launch".to_string(),
        ));
    }
    billing::require_meter_available(
        pool,
        org_id,
        billing::meters::CAMPAIGN_RECIPIENTS,
        recipient_ids.len() as i64,
    )
    .await?;
    if (recipient_ids.len() as i32) > connection_limit {
        return Err(AppError::Conflict(format!(
            "Launch batch size ({}) exceeds estimated daily portfolio limit ({})",
            recipient_ids.len(),
            connection_limit
        )));
    }
    let requested_scheduled_at = parse_scheduled_at(scheduled_at)?.or(campaign.scheduled_at);
    let should_schedule = requested_scheduled_at
        .map(|dt| dt > Utc::now())
        .unwrap_or(false);

    let queued_result = sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient"
        SET status = 'QUEUED'::"WhatsappRecipientStatus", "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = NOW()
        WHERE id = ANY($1)
        "#,
    )
    .bind(&recipient_ids)
    .execute(pool)
    .await?;

    if queued_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No recipients were queued for launch".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET status = CAST($1 AS "WhatsappCampaignStatus"),
            "scheduledAt" = $2,
            "launchedAt" = CASE WHEN $3 THEN "launchedAt" ELSE NOW() END,
            "completedAt" = NULL,
            "updatedAt" = NOW()
        WHERE id = $4
        "#,
    )
    .bind(if should_schedule {
        "SCHEDULED"
    } else {
        "SENDING"
    })
    .bind(requested_scheduled_at)
    .bind(should_schedule)
    .bind(campaign_id)
    .execute(pool)
    .await?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;

    Ok(json!({
        "campaignId": campaign_id,
        "queuedRecipients": recipient_ids.len(),
        "batchSize": if max_batch == i32::MAX { Value::Null } else { json!(max_batch) },
        "scheduledAt": requested_scheduled_at,
        "status": if should_schedule { "SCHEDULED" } else { "SENDING" }
    }))
}

pub async fn pause_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    if campaign.status != "SENDING" && campaign.status != "SCHEDULED" {
        return Err(AppError::BadRequest(
            "Only active or scheduled campaigns can be paused".to_string(),
        ));
    }
    let result = sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient"
        SET status = 'PENDING'::"WhatsappRecipientStatus", "updatedAt" = NOW()
        WHERE "campaignId" = $1 AND status = 'QUEUED'::"WhatsappRecipientStatus"
        "#,
    )
    .bind(campaign_id)
    .execute(pool)
    .await?;
    sqlx::query(r#"UPDATE "WhatsappCampaign" SET status = 'PAUSED'::"WhatsappCampaignStatus", "updatedAt" = NOW() WHERE id = $1"#)
        .bind(campaign_id)
        .execute(pool)
        .await?;
    recompute_campaign_stats(pool, campaign_id).await?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;
    Ok(
        json!({ "campaignId": campaign_id, "pausedRecipients": result.rows_affected(), "status": "PAUSED" }),
    )
}

pub async fn resume_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
    scheduled_at: Option<String>,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    if campaign.status != "PAUSED" {
        return Err(AppError::BadRequest(
            "Only paused campaigns can be resumed".to_string(),
        ));
    }
    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId" = $1 AND status = 'PENDING'::"WhatsappRecipientStatus""#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    if recipient_ids.is_empty() {
        return Err(AppError::BadRequest(
            "Campaign has no paused recipients to resume".to_string(),
        ));
    }
    let requested_scheduled_at = parse_scheduled_at(scheduled_at)?.or(campaign.scheduled_at);
    let should_schedule = requested_scheduled_at
        .map(|dt| dt > Utc::now())
        .unwrap_or(false);
    let queued_result = sqlx::query(r#"UPDATE "WhatsappCampaignRecipient" SET status = 'QUEUED'::"WhatsappRecipientStatus", "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = NOW() WHERE id = ANY($1)"#)
        .bind(&recipient_ids)
        .execute(pool)
        .await?;
    if queued_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No paused recipients were queued for resume".to_string(),
        ));
    }
    sqlx::query(r#"UPDATE "WhatsappCampaign" SET status = CAST($1 AS "WhatsappCampaignStatus"), "scheduledAt" = $2, "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $3"#)
        .bind(if should_schedule { "SCHEDULED" } else { "SENDING" })
        .bind(requested_scheduled_at)
        .bind(campaign_id)
        .execute(pool)
        .await?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;
    Ok(
        json!({ "campaignId": campaign_id, "resumedRecipients": recipient_ids.len(), "status": if should_schedule { "SCHEDULED" } else { "SENDING" } }),
    )
}

pub async fn cancel_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let _campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let result = sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient"
        SET status = 'SKIPPED'::"WhatsappRecipientStatus",
            "errorCode" = 'cancelled',
            "errorMessage" = 'Campaign cancelled before send completed',
            "updatedAt" = NOW()
        WHERE "campaignId" = $1
          AND status IN (
            'PENDING'::"WhatsappRecipientStatus",
            'QUEUED'::"WhatsappRecipientStatus",
            'PROCESSING'::"WhatsappRecipientStatus",
            'FAILED'::"WhatsappRecipientStatus"
          )
        "#,
    )
    .bind(campaign_id)
    .execute(pool)
    .await?;
    sqlx::query(r#"UPDATE "WhatsappCampaign" SET status = 'FAILED'::"WhatsappCampaignStatus", "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
        .bind(campaign_id)
        .execute(pool)
        .await?;
    recompute_campaign_stats(pool, campaign_id).await?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;
    Ok(
        json!({ "campaignId": campaign_id, "cancelledRecipients": result.rows_affected(), "status": "FAILED" }),
    )
}

pub async fn retry_failed_campaign(
    pool: &PgPool,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let _campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    Err(AppError::BadRequest(
        "Retrying FAILED recipients is disabled to prevent duplicate sends in the same campaign"
            .to_string(),
    ))
}

pub async fn repair_campaign_status(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;

    recompute_campaign_stats(pool, campaign_id).await?;

    let refreshed = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;

    Ok(json!({
        "campaignId": campaign_id,
        "repaired": true,
        "previousStatus": campaign.status,
        "status": refreshed.status,
        "totalRecipients": refreshed.total_recipients,
        "sentCount": refreshed.sent_count,
        "deliveredCount": refreshed.delivered_count,
        "readCount": refreshed.read_count,
        "failedCount": refreshed.failed_count,
        "blockedCount": refreshed.blocked_count,
        "unsubscribedCount": refreshed.unsubscribed_count,
        "completedAt": refreshed.completed_at,
    }))
}

pub async fn delete_campaign(
    pool: &PgPool,
    org_id: &str,
    campaign_id: &str,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    if campaign.status == "SENDING" || campaign.status == "SCHEDULED" {
        return Err(AppError::BadRequest(
            "Cannot delete an active campaign. Pause or cancel it first.".to_string(),
        ));
    }
    // WhatsappCampaignRecipient has onDelete: Cascade, WhatsappSendEvent has onDelete: SetNull
    sqlx::query(r#"DELETE FROM "WhatsappCampaign" WHERE id = $1 AND "orgId" = $2"#)
        .bind(campaign_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    Ok(json!({ "deleted": true, "campaignId": campaign_id }))
}

pub async fn send_more_campaign(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    campaign_id: &str,
    batch_size: Option<i32>,
    excluded_contact_ids: Vec<String>,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, org_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let queued_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)::bigint
        FROM "WhatsappCampaignRecipient"
        WHERE "campaignId" = $1
          AND status IN ('QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")
        "#,
    )
    .bind(campaign_id)
    .fetch_one(pool)
    .await?;
    let allow_stale_sending = campaign.status == "SENDING" && queued_count == 0;
    if campaign.status != "COMPLETED"
        && campaign.status != "FAILED"
        && campaign.status != "PAUSED"
        && !allow_stale_sending
    {
        return Err(AppError::BadRequest(
            "Can only add recipients to completed, failed, paused, or idle sending campaigns"
                .to_string(),
        ));
    }
    let batch_size = batch_size
        .filter(|value| *value > 0)
        .or(campaign.default_batch_size)
        .unwrap_or(200) as usize;

    let pending_contact_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT r."contactId"
        FROM "WhatsappCampaignRecipient" r
        WHERE r."campaignId" = $1
          AND r.status = 'PENDING'::"WhatsappRecipientStatus"
        ORDER BY r."createdAt" ASC
        "#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;

    if pending_contact_ids.is_empty() {
        return Err(AppError::BadRequest(
            "This campaign has no pending recipients left for another batch".to_string(),
        ));
    }

    let excluded_set = excluded_contact_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let selected_contact_ids = pending_contact_ids
        .iter()
        .filter(|contact_id| !excluded_set.contains(contact_id.as_str()))
        .take(batch_size)
        .cloned()
        .collect::<Vec<_>>();

    let skipped_manual = pending_contact_ids
        .iter()
        .filter(|contact_id| excluded_set.contains(contact_id.as_str()))
        .count() as i32;

    if excluded_set.len() > 0 {
        sqlx::query(
            r#"
            UPDATE "WhatsappCampaignRecipient"
            SET status = 'SKIPPED'::"WhatsappRecipientStatus",
                "errorCode" = 'manual_exclude',
                "errorMessage" = 'Excluded from send more',
                "updatedAt" = NOW()
            WHERE "campaignId" = $1
              AND "contactId" = ANY($2)
              AND status = 'PENDING'::"WhatsappRecipientStatus"
            "#,
        )
        .bind(campaign_id)
        .bind(&excluded_set.into_iter().collect::<Vec<_>>())
        .execute(pool)
        .await?;
    }

    if selected_contact_ids.is_empty() {
        return Err(AppError::BadRequest(
            "No pending recipients selected for this batch".to_string(),
        ));
    }

    let queued_result = sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient"
        SET status = 'QUEUED'::"WhatsappRecipientStatus",
            "errorCode" = NULL,
            "errorMessage" = NULL,
            "updatedAt" = NOW()
        WHERE "campaignId" = $1
          AND "contactId" = ANY($2)
          AND status = 'PENDING'::"WhatsappRecipientStatus"
          AND "sentAt" IS NULL
          AND "waMessageId" IS NULL
        "#,
    )
    .bind(campaign_id)
    .bind(&selected_contact_ids)
    .execute(pool)
    .await?;

    if queued_result.rows_affected() == 0 {
        recompute_campaign_stats(pool, campaign_id).await?;
        publish_campaign_updated(pool, user_id, campaign_id).await?;
        return Err(AppError::BadRequest(
            "No pending recipients were queued for this batch".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET status = 'SENDING'::"WhatsappCampaignStatus",
            "launchedAt" = COALESCE("launchedAt", NOW()),
            "completedAt" = NULL,
            "updatedAt" = NOW()
        WHERE id = $1
        "#,
    )
    .bind(campaign_id)
    .execute(pool)
    .await?;
    publish_campaign_updated(pool, user_id, campaign_id).await?;

    Ok(json!({
        "campaignId": campaign_id,
        "queuedRecipients": queued_result.rows_affected(),
        "skippedManual": skipped_manual,
        "status": "SENDING"
    }))
}

async fn reconcile_active_campaigns_without_queue(
    pool: &PgPool,
) -> Result<Vec<(String, String)>, AppError> {
    let reconciled = sqlx::query_as::<_, (String, String)>(
        r#"
        UPDATE "WhatsappCampaign" c
        SET status = 'COMPLETED'::"WhatsappCampaignStatus",
            "completedAt" = COALESCE(c."completedAt", NOW()),
            "updatedAt" = NOW()
        WHERE c.status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
          AND (c."scheduledAt" IS NULL OR c."scheduledAt" <= NOW())
          AND NOT EXISTS (
            SELECT 1
            FROM "WhatsappCampaignRecipient" r
            WHERE r."campaignId" = c.id
              AND r.status IN ('QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")
          )
        RETURNING c."userId", c.id
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(reconciled)
}

pub async fn recompute_campaign_stats(pool: &PgPool, campaign_id: &str) -> Result<(), AppError> {
    let (counts, total_recipients) = tokio::try_join!(
        sqlx::query_as::<_, (String, i64)>(
            r#"
            SELECT status::text, COUNT(*)::bigint
            FROM "WhatsappCampaignRecipient"
            WHERE "campaignId" = $1
            GROUP BY status
            "#,
        )
        .bind(campaign_id)
        .fetch_all(pool),
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)::bigint
            FROM "WhatsappCampaignRecipient"
            WHERE "campaignId" = $1
            "#,
        )
        .bind(campaign_id)
        .fetch_one(pool),
    )?;
    let mut map = std::collections::HashMap::new();
    for (status, count) in counts {
        map.insert(status, count as i32);
    }
    let active_queue =
        map.get("QUEUED").copied().unwrap_or(0) + map.get("PROCESSING").copied().unwrap_or(0);
    let campaign = sqlx::query_scalar::<_, String>(
        r#"SELECT status::text FROM "WhatsappCampaign" WHERE id = $1"#,
    )
    .bind(campaign_id)
    .fetch_optional(pool)
    .await?;
    if campaign.is_none() {
        return Ok(());
    }
    sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET "totalRecipients" = $1,
            "sentCount" = $2,
            "deliveredCount" = $3,
            "readCount" = $4,
            "failedCount" = $5,
            "blockedCount" = $6,
            "unsubscribedCount" = $7,
            status = CASE
                WHEN $8 = 0 AND status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
                    THEN 'COMPLETED'::"WhatsappCampaignStatus"
                ELSE status
            END,
            "completedAt" = CASE
                WHEN $8 = 0 AND status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
                    THEN NOW()
                ELSE "completedAt"
            END,
            "updatedAt" = NOW()
        WHERE id = $9
        "#,
    )
    .bind(total_recipients as i32)
    .bind(map.get("SENT").copied().unwrap_or(0) + map.get("DELIVERED").copied().unwrap_or(0) + map.get("READ").copied().unwrap_or(0))
    .bind(map.get("DELIVERED").copied().unwrap_or(0) + map.get("READ").copied().unwrap_or(0))
    .bind(map.get("READ").copied().unwrap_or(0))
    .bind(map.get("FAILED").copied().unwrap_or(0))
    .bind(map.get("BLOCKED").copied().unwrap_or(0))
    .bind(map.get("UNSUBSCRIBED").copied().unwrap_or(0))
    .bind(active_queue)
    .bind(campaign_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn build_body_parameters(
    contact: &WhatsappContactRow,
    mappings: Option<&Vec<Value>>,
) -> Vec<String> {
    let Some(mappings) = mappings else {
        return Vec::new();
    };
    mappings
        .iter()
        .map(|mapping| {
            let source = mapping
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("contact");
            let key = mapping.get("key").and_then(|v| v.as_str()).unwrap_or("");
            if source == "static" {
                return key.to_string();
            }
            match key {
                "fullName" | "name" => contact.full_name.clone().unwrap_or_default(),
                "phone" => contact.phone.clone(),
                "location" => contact.location.clone().unwrap_or_default(),
                "tags" => contact.tags.join(", "),
                other => metadata_string(&contact.metadata, other),
            }
        })
        .collect()
}

async fn send_marketing_template(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    template_name: &str,
    language: &str,
    body_parameters: &[String],
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": "template",
        "template": {
            "name": template_name,
            "language": { "code": language },
            "components": if body_parameters.is_empty() {
                Value::Null
            } else {
                json!([{
                    "type": "body",
                    "parameters": body_parameters.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()
                }])
            }
        }
    });
    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        log::error!(
            "whatsapp campaign send rejected status={} payload={} response={}",
            status,
            payload,
            raw
        );
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    let message_id = raw
        .get("messages")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::Internal("WhatsApp Cloud API did not return a message id".to_string())
        })?;
    Ok((message_id.to_string(), raw))
}

fn parse_failure_details(error: &AppError) -> (Option<String>, String, bool) {
    let message = error.to_string();
    let code = message
        .split("(#")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(|value| value.trim().to_string());
    let lower = message.to_lowercase();
    let blocked =
        matches!(code.as_deref(), Some("131026") | Some("131048")) || lower.contains("blocked");
    (code, message, blocked)
}

async fn claim_queued_campaign_recipient(
    pool: &PgPool,
    recipient_id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient" r
        SET status = 'PROCESSING'::"WhatsappRecipientStatus",
            "errorCode" = NULL,
            "errorMessage" = NULL,
            "updatedAt" = NOW()
        FROM "WhatsappCampaign" c
        WHERE r.id = $1
          AND r."campaignId" = c.id
          AND r.status = 'QUEUED'::"WhatsappRecipientStatus"
          AND c.status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
          AND (c."scheduledAt" IS NULL OR c."scheduledAt" <= NOW())
        "#,
    )
    .bind(recipient_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() == 1)
}

async fn release_processing_campaign_recipient(
    pool: &PgPool,
    recipient_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient" r
        SET status = CASE
                WHEN c.status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
                    THEN 'QUEUED'::"WhatsappRecipientStatus"
                ELSE 'PENDING'::"WhatsappRecipientStatus"
            END,
            "updatedAt" = NOW()
        FROM "WhatsappCampaign" c
        WHERE r.id = $1
          AND r."campaignId" = c.id
          AND r.status = 'PROCESSING'::"WhatsappRecipientStatus"
        "#,
    )
    .bind(recipient_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn recover_stuck_processing_campaign_recipients(
    pool: &PgPool,
) -> Result<Vec<(String, String)>, AppError> {
    let stale_before = Utc::now() - campaign_processing_timeout();
    let recovered = sqlx::query_as::<_, (String, String, String)>(
        r#"
        UPDATE "WhatsappCampaignRecipient" r
        SET status = CASE
                WHEN c.status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
                    THEN 'QUEUED'::"WhatsappRecipientStatus"
                ELSE 'PENDING'::"WhatsappRecipientStatus"
            END,
            "updatedAt" = NOW()
        FROM "WhatsappCampaign" c
        WHERE r."campaignId" = c.id
          AND r.status = 'PROCESSING'::"WhatsappRecipientStatus"
          AND r."updatedAt" < $1
        RETURNING c."userId", c.id, r.id
        "#,
    )
    .bind(stale_before)
    .fetch_all(pool)
    .await?;

    if !recovered.is_empty() {
        log::warn!(
            "[whatsapp-marketing-worker] recovered {} stale processing recipient(s) older than {} seconds",
            recovered.len(),
            campaign_processing_timeout().num_seconds()
        );
    }

    Ok(recovered
        .into_iter()
        .map(|(user_id, campaign_id, recipient_id)| {
            log::warn!(
                "[whatsapp-marketing-worker] recovered stale processing recipient recipient_id={} campaign_id={} user_id={}",
                recipient_id,
                campaign_id,
                user_id
            );
            (user_id, campaign_id)
        })
        .collect())
}

async fn process_claimed_campaign_recipient(
    pool: &PgPool,
    recipient_id: &str,
) -> Result<Option<(String, String)>, AppError> {
    let recipient = match sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
        r#"
        SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
               "snapshotPhone" AS snapshot_phone, "snapshotFullName" AS snapshot_full_name,
               "snapshotLocation" AS snapshot_location, "snapshotListLabel" AS snapshot_list_label,
               "snapshotMetadata" AS snapshot_metadata,
               "waMessageId" AS wa_message_id, "sentAt" AT TIME ZONE 'UTC' AS sent_at, "deliveredAt" AT TIME ZONE 'UTC' AS delivered_at,
               "readAt" AT TIME ZONE 'UTC' AS read_at, "failedAt" AT TIME ZONE 'UTC' AS failed_at, "errorCode" AS error_code,
               "errorMessage" AS error_message, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCampaignRecipient"
        WHERE id = $1
        "#,
    )
    .bind(recipient_id)
    .fetch_optional(pool)
    .await?
    {
        Some(recipient) => recipient,
        None => return Ok(None),
    };

    if recipient.status != "PROCESSING" {
        return Ok(None);
    }

    let campaign = sqlx::query_as::<_, WhatsappCampaignRow>(
        r#"
        SELECT c.id, c."userId" AS user_id, c."orgId" AS org_id, c."connectionId" AS connection_id, c."templateId" AS template_id,
               c.name, c.description, c."templateName" AS template_name, c."templateLanguage" AS template_language,
               c."variableMappings" AS variable_mappings,
               wt.header AS template_header, wt.body AS template_body, wt.footer AS template_footer, wt.buttons AS template_buttons,
               c."listLabel" AS list_label,
               c."defaultBatchSize" AS default_batch_size, c.status::text AS status, c."scheduledAt" AT TIME ZONE 'UTC' AS scheduled_at,
               c."launchedAt" AT TIME ZONE 'UTC' AS launched_at, c."completedAt" AT TIME ZONE 'UTC' AS completed_at, c."totalRecipients" AS total_recipients,
               c."sentCount" AS sent_count, c."deliveredCount" AS delivered_count, c."readCount" AS read_count,
               c."failedCount" AS failed_count, c."blockedCount" AS blocked_count, c."unsubscribedCount" AS unsubscribed_count,
               c."createdAt" AT TIME ZONE 'UTC' AS created_at, c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               wt.status::text AS template_status
        FROM "WhatsappCampaign" c
        LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
        LEFT JOIN "WhatsappTemplate" wt ON wt.id = c."templateId"
        WHERE c.id = $1
        "#,
    )
    .bind(&recipient.campaign_id)
    .fetch_one(pool)
    .await?;

    let org_id = campaign
        .org_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("Campaign is not assigned to a workspace".to_string()))?;
    let contact = select_campaign_contact_row(pool, org_id, &recipient.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign contact not found".to_string()))?;

    let existing_send_message_id = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT "whatsappMessageId"
        FROM "WhatsappSendEvent"
        WHERE "campaignId" = $1
          AND "contactId" = $2
          AND status IN ('SENT'::"WhatsappRecipientStatus", 'DELIVERED'::"WhatsappRecipientStatus", 'READ'::"WhatsappRecipientStatus")
        ORDER BY "createdAt" DESC
        LIMIT 1
        "#,
    )
    .bind(&recipient.campaign_id)
    .bind(&contact.id)
    .fetch_optional(pool)
    .await?
    .flatten();

    if let Some(existing_message_id) = existing_send_message_id {
        sqlx::query(
            r#"
            UPDATE "WhatsappCampaignRecipient"
            SET status = 'SENT'::"WhatsappRecipientStatus",
                "waMessageId" = COALESCE("waMessageId", $1),
                "sentAt" = COALESCE("sentAt", NOW()),
                "errorCode" = NULL,
                "errorMessage" = NULL,
                "updatedAt" = NOW()
            WHERE id = $2
            "#,
        )
        .bind(existing_message_id)
        .bind(recipient_id)
        .execute(pool)
        .await?;

        recompute_campaign_stats(pool, &recipient.campaign_id).await?;
        return Ok(Some((
            campaign.user_id.clone(),
            recipient.campaign_id.clone(),
        )));
    }

    let (reason, eligible) = contact_eligible(&contact);
    if !eligible {
        sqlx::query(
            r#"
            UPDATE "WhatsappCampaignRecipient"
            SET status = CAST($1 AS "WhatsappRecipientStatus"),
                "errorCode" = $2,
                "errorMessage" = $3,
                "updatedAt" = NOW()
            WHERE id = $4
            "#,
        )
        .bind(if reason == "excluded" {
            "UNSUBSCRIBED"
        } else {
            "SKIPPED"
        })
        .bind(reason)
        .bind("Recipient no longer matches marketing safety requirements")
        .bind(recipient_id)
        .execute(pool)
        .await?;

        recompute_campaign_stats(pool, &recipient.campaign_id).await?;
        return Ok(Some((
            campaign.user_id.clone(),
            recipient.campaign_id.clone(),
        )));
    }

    if let Err(error) =
        billing::require_capability(pool, org_id, billing::capabilities::CAMPAIGNS_SEND).await
    {
        sqlx::query(
            r#"
            UPDATE "WhatsappCampaignRecipient"
            SET status = 'FAILED'::"WhatsappRecipientStatus",
                "failedAt" = NOW(),
                "errorCode" = 'entitlement_required',
                "errorMessage" = $1,
                "updatedAt" = NOW()
            WHERE id = $2
            "#,
        )
        .bind(error.to_string())
        .bind(recipient_id)
        .execute(pool)
        .await?;
        recompute_campaign_stats(pool, &recipient.campaign_id).await?;
        return Ok(Some((
            campaign.user_id.clone(),
            recipient.campaign_id.clone(),
        )));
    }

    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!(
        "{} WHERE id = $1 AND \"orgId\" = $2",
        select_connection_sql()
    ))
    .bind(&campaign.connection_id)
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let mappings = campaign
        .variable_mappings
        .as_ref()
        .and_then(|v| v.as_array());
    let body_parameters = build_body_parameters(&contact, mappings);

    log::info!(
        "[campaign-send] attempting campaign_id={} recipient_id={} contact_id={} phone={} template={} language={} body_parameters={}",
        campaign.id,
        recipient_id,
        contact.id,
        contact.phone,
        campaign.template_name,
        campaign.template_language,
        serde_json::to_string(&body_parameters).unwrap_or_else(|_| "[]".to_string())
    );

    match send_marketing_template(
        &connection.phone_number_id,
        &access_token,
        &contact.phone,
        &campaign.template_name,
        &campaign.template_language,
        &body_parameters,
    )
    .await
    {
        Ok((message_id, raw)) => {
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = 'SENT'::"WhatsappRecipientStatus",
                    "waMessageId" = $1,
                    "sentAt" = NOW(),
                    "errorCode" = NULL,
                    "errorMessage" = NULL,
                    "updatedAt" = NOW()
                WHERE id = $2
                "#,
            )
            .bind(&message_id)
            .bind(recipient_id)
            .execute(pool)
            .await?;
            sqlx::query(
                r#"UPDATE "WhatsappContact" SET "lastMarketingSent" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
            )
            .bind(&contact.id)
            .execute(pool)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO "WhatsappSendEvent" (
                    id, "userId", "orgId", "connectionId", "campaignId", "recipientId", "contactId", phone, "templateName",
                    status, "whatsappMessageId", "requestPayload", "responsePayload", "createdAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                        'SENT'::"WhatsappRecipientStatus", $10, $11, $12, NOW())
                "#,
            )
            .bind(cuid2::create_id())
            .bind(&campaign.user_id)
            .bind(org_id)
            .bind(&campaign.connection_id)
            .bind(&campaign.id)
            .bind(recipient_id)
            .bind(&contact.id)
            .bind(&contact.phone)
            .bind(&campaign.template_name)
            .bind(&message_id)
            .bind(json!({
                "templateName": campaign.template_name,
                "language": campaign.template_language,
                "bodyParameters": body_parameters
            }))
            .bind(raw)
            .execute(pool)
            .await?;

            billing::record_meter_usage(
                pool,
                org_id,
                billing::meters::CAMPAIGN_RECIPIENTS,
                1,
                "campaign_recipient",
                recipient_id,
                &format!("reach-campaign-recipient:{recipient_id}"),
            )
            .await?;

            log::info!(
                "[campaign-send] accepted campaign_id={} recipient_id={} contact_id={} phone={} wa_message_id={}",
                campaign.id,
                recipient_id,
                contact.id,
                contact.phone,
                message_id
            );
        }
        Err(error) => {
            let request_payload = json!({
                "templateName": campaign.template_name,
                "language": campaign.template_language,
                "bodyParameters": body_parameters
            });
            let response_payload = json!({
                "error": error.to_string()
            });
            let (code, message, blocked) = parse_failure_details(&error);
            let status = if blocked { "BLOCKED" } else { "FAILED" };

            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"),
                    "failedAt" = NOW(),
                    "errorCode" = $2,
                    "errorMessage" = $3,
                    "updatedAt" = NOW()
                WHERE id = $4
                "#,
            )
            .bind(status)
            .bind(code.as_deref())
            .bind(&message)
            .bind(recipient_id)
            .execute(pool)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO "WhatsappSendEvent" (
                    id, "userId", "orgId", "connectionId", "campaignId", "recipientId", "contactId", phone, "templateName",
                    status, "requestPayload", "responsePayload", "errorCode", "errorMessage", "createdAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                        CAST($10 AS "WhatsappRecipientStatus"), $11, $12, $13, $14, NOW())
                "#,
            )
            .bind(cuid2::create_id())
            .bind(&campaign.user_id)
            .bind(org_id)
            .bind(&campaign.connection_id)
            .bind(&campaign.id)
            .bind(recipient_id)
            .bind(&contact.id)
            .bind(&contact.phone)
            .bind(&campaign.template_name)
            .bind(status)
            .bind(&request_payload)
            .bind(&response_payload)
            .bind(code.as_deref())
            .bind(&message)
            .execute(pool)
            .await?;

            log::error!(
                "[campaign-send] request failed campaign_id={} recipient_id={} contact_id={} phone={} code={:?} message={} request_payload={} response_payload={}",
                campaign.id,
                recipient_id,
                contact.id,
                contact.phone,
                code,
                message,
                request_payload,
                response_payload
            );
        }
    }

    recompute_campaign_stats(pool, &recipient.campaign_id).await?;
    Ok(Some((
        campaign.user_id.clone(),
        recipient.campaign_id.clone(),
    )))
}

pub async fn process_queued_campaign_recipients(
    pool: &PgPool,
    limit: i64,
) -> Result<i64, AppError> {
    let recovered_campaigns = recover_stuck_processing_campaign_recipients(pool).await?;
    let mut changed_campaigns = recovered_campaigns
        .into_iter()
        .collect::<std::collections::HashSet<(String, String)>>();

    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT r.id
        FROM "WhatsappCampaignRecipient" r
        JOIN "WhatsappCampaign" c ON c.id = r."campaignId"
        WHERE r.status = 'QUEUED'::"WhatsappRecipientStatus"
          AND c.status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus")
          AND (c."scheduledAt" IS NULL OR c."scheduledAt" <= NOW())
        ORDER BY r."createdAt" ASC
        LIMIT $1
        "#,
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;

    if recipient_ids.is_empty() {
        let reconciled = reconcile_active_campaigns_without_queue(pool).await?;
        for (user_id, campaign_id) in reconciled {
            changed_campaigns.insert((user_id, campaign_id));
        }
        for (user_id, campaign_id) in changed_campaigns {
            if let Err(error) = publish_campaign_updated(pool, &user_id, &campaign_id).await {
                log::warn!(
                    "failed to publish campaign realtime update campaign_id={} user_id={}: {}",
                    campaign_id,
                    user_id,
                    error
                );
            }
        }
        return Ok(0);
    }

    let mut processed = 0;

    for recipient_id in recipient_ids {
        if !claim_queued_campaign_recipient(pool, &recipient_id).await? {
            continue;
        }

        match process_claimed_campaign_recipient(pool, &recipient_id).await {
            Ok(Some(changed_campaign)) => {
                changed_campaigns.insert(changed_campaign);
                processed += 1;
            }
            Ok(None) => {}
            Err(error) => {
                if let Err(release_error) =
                    release_processing_campaign_recipient(pool, &recipient_id).await
                {
                    log::error!(
                        "failed to release claimed campaign recipient recipient_id={} after error: {}",
                        recipient_id,
                        release_error
                    );
                }
                return Err(error);
            }
        }
    }

    for (user_id, campaign_id) in changed_campaigns {
        if let Err(error) = publish_campaign_updated(pool, &user_id, &campaign_id).await {
            log::warn!(
                "failed to publish campaign realtime update campaign_id={} user_id={}: {}",
                campaign_id,
                user_id,
                error
            );
        }
    }

    Ok(processed)
}

fn build_conversation_identifier(connection_id: &str, phone: &str) -> String {
    format!("wa:{connection_id}:{phone}")
}

fn parse_conversation_identifier(identifier: &str) -> Option<(String, String)> {
    let parts: Vec<_> = identifier.split(':').collect();
    if parts.len() < 3 || parts[0] != "wa" {
        return None;
    }
    Some((parts[1].to_string(), parts[2..].join(":")))
}

async fn find_or_create_conversation(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
    phone: &str,
    customer_name: Option<&str>,
) -> Result<(String, i32, chrono::DateTime<Utc>, String), AppError> {
    let identifier = build_conversation_identifier(connection_id, phone);
    let customer_id =
        customers::ensure_whatsapp_customer(pool, org_id, phone, customer_name, None).await?;
    let existing = sqlx::query_as::<_, (String, i32, chrono::DateTime<Utc>)>(
        r#"
        SELECT
            id,
            "unreadCount",
            "lastMessageAt" AT TIME ZONE 'UTC'
        FROM "Conversation"
        WHERE "orgId" = $1 AND channel = 'whatsapp' AND "customerIdentifier" = $2
        LIMIT 1
        "#,
    )
    .bind(org_id)
    .bind(&identifier)
    .fetch_optional(pool)
    .await?;
    if let Some((id, unread_count, last_message_at)) = existing {
        sqlx::query(
            r#"
            UPDATE "Conversation"
            SET "customerName" = COALESCE($1, "customerName"),
                "orgId" = $2,
                "customerId" = COALESCE("customerId", $5),
                "externalConnectionId" = COALESCE(
                    "externalConnectionId",
                    (SELECT id FROM "ExternalConnection"
                     WHERE "orgId" = $2 AND "sourceType" = 'WHATSAPP' AND "sourceId" = $4
                     LIMIT 1)
                )
            WHERE id = $3
            "#,
        )
        .bind(customer_name)
        .bind(org_id)
        .bind(&id)
        .bind(connection_id)
        .bind(&customer_id)
        .execute(pool)
        .await?;
        return Ok((id, unread_count, last_message_at, customer_id));
    }
    let id = cuid2::create_id();
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO "Conversation" (
            id, "orgId", channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "externalConnectionId", "customerId",
            "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, 'whatsapp', $3, $4, 'active', $5, 0,
            (SELECT id FROM "ExternalConnection"
             WHERE "orgId" = $2 AND "sourceType" = 'WHATSAPP' AND "sourceId" = $6
             LIMIT 1),
            $7, NOW(), NOW()
        )
        "#,
    )
    .bind(&id)
    .bind(org_id)
    .bind(&identifier)
    .bind(customer_name)
    .bind(now)
    .bind(connection_id)
    .bind(&customer_id)
    .execute(pool)
    .await?;
    Ok((id, 0, now, customer_id))
}

pub(crate) fn normalize_phone(raw: &str) -> String {
    let cleaned = raw
        .trim()
        .chars()
        .filter(|ch| !matches!(ch, ' ' | '(' | ')' | '-'))
        .collect::<String>();
    if cleaned.is_empty() {
        return String::new();
    }
    if cleaned.starts_with('+') {
        return if valid_e164(&cleaned) {
            cleaned
        } else {
            String::new()
        };
    }
    if let Some(rest) = cleaned.strip_prefix("00") {
        let candidate = format!("+{rest}");
        return if valid_e164(&candidate) {
            candidate
        } else {
            String::new()
        };
    }
    let digits = cleaned
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return String::new();
    }
    let default_country =
        std::env::var("WHATSAPP_DEFAULT_COUNTRY_CODE").unwrap_or_else(|_| "+27".to_string());
    let candidate = if let Some(rest) = digits.strip_prefix('0') {
        format!("{default_country}{rest}")
    } else {
        format!("+{digits}")
    };
    if valid_e164(&candidate) {
        candidate
    } else {
        String::new()
    }
}

fn valid_e164(phone: &str) -> bool {
    let Some(digits) = phone.strip_prefix('+') else {
        return false;
    };
    let len = digits.len();
    (8..=15).contains(&len)
        && digits.chars().all(|ch| ch.is_ascii_digit())
        && !digits.starts_with('0')
}

pub(crate) fn sanitize_tags(tags: &[String]) -> Vec<String> {
    let mut deduped = Vec::new();
    for tag in tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
    {
        if !deduped.iter().any(|existing| existing == tag) {
            deduped.push(tag.to_string());
        }
    }
    deduped
}

pub(crate) fn parse_bool_like(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" => Some(true),
        "false" | "0" | "no" | "n" => Some(false),
        _ => None,
    }
}

pub(crate) fn pick_first<'a>(row: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| row.get(*key))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

pub(crate) fn parse_csv_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub(crate) async fn select_list_contact_row(
    pool: &PgPool,
    org_id: &str,
    membership_id: &str,
) -> Result<Option<WhatsappListContactRow>, AppError> {
    sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
            c."customerId" AS customer_id,
            m."userId" AS user_id,
            c.phone,
            COALESCE(m."fullName", c."fullName") AS full_name,
            COALESCE(m.tags, ARRAY[]::text[]) AS tags,
            COALESCE(m.location, c.location) AS location,
            m."listLabel" AS list_label,
            m.metadata,
            m."optIn" AS opt_in,
            m."optInSource" AS opt_in_source,
            m."optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
            c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
            m.excluded,
            m.notes,
            m."createdAt" AT TIME ZONE 'UTC' AS created_at,
            m."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappContactListMembership" m
        JOIN "WhatsappContact" c ON c.id = m."contactId"
        WHERE m.id = $1 AND m."orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(membership_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn select_campaign_contact_row(
    pool: &PgPool,
    org_id: &str,
    recipient_id: &str,
) -> Result<Option<WhatsappContactRow>, AppError> {
    sqlx::query_as::<_, WhatsappContactRow>(
        r#"
        SELECT c.id, c."userId" AS user_id,
               COALESCE(r."snapshotPhone", c.phone) AS phone,
               COALESCE(r."snapshotFullName", c."fullName") AS full_name,
               COALESCE(m.tags, ARRAY[]::text[]) AS tags,
               COALESCE(r."snapshotLocation", m.location, c.location) AS location,
               COALESCE(r."snapshotListLabel", m."listLabel", c."listLabel", 'default') AS list_label,
               COALESCE(r."snapshotMetadata", m.metadata, c.metadata) AS metadata,
               COALESCE(m."optIn", c."optIn") AS opt_in,
               COALESCE(m."optInSource", c."optInSource") AS opt_in_source,
               COALESCE(m."optInDate", c."optInDate") AT TIME ZONE 'UTC' AS opt_in_date,
               c."lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent,
               COALESCE(m.excluded, c.excluded) AS excluded,
               COALESCE(m.notes, c.notes) AS notes,
               c."createdAt" AT TIME ZONE 'UTC' AS created_at,
               GREATEST(c."updatedAt", COALESCE(m."updatedAt", c."updatedAt"), r."updatedAt") AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCampaignRecipient" r
        JOIN "WhatsappContact" c ON c.id = r."contactId"
        LEFT JOIN "WhatsappContactListMembership" m
          ON m."contactId" = c.id
         AND m."orgId" = c."orgId"
         AND m."listLabel" = COALESCE(r."snapshotListLabel", c."listLabel", 'default')
        WHERE r.id = $1 AND c."orgId" = $2
        LIMIT 1
        "#,
    )
    .bind(recipient_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

fn get_inbound_text(message: &Value) -> Option<String> {
    message
        .get("text")
        .and_then(|v| v.get("body"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            message
                .get("button")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

struct IncomingWhatsappMedia {
    kind: String,
    media_id: String,
    mime_type: Option<String>,
    caption: Option<String>,
    filename: Option<String>,
    sha256: Option<String>,
}

fn get_incoming_media(message: &Value) -> Option<IncomingWhatsappMedia> {
    for kind in ["image", "video", "audio", "document", "sticker"] {
        if let Some(media) = message.get(kind) {
            if let Some(media_id) = media.get("id").and_then(|v| v.as_str()) {
                return Some(IncomingWhatsappMedia {
                    kind: kind.to_string(),
                    media_id: media_id.to_string(),
                    mime_type: media
                        .get("mime_type")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    caption: media
                        .get("caption")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    filename: media
                        .get("filename")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    sha256: media
                        .get("sha256")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                });
            }
        }
    }
    None
}

fn parse_status_failure_details(status_payload: &Value) -> (Option<String>, Option<String>) {
    let Some(error) = status_payload
        .get("errors")
        .and_then(|value| value.as_array())
        .and_then(|errors| errors.first())
    else {
        return (None, None);
    };

    let code = error
        .get("code")
        .and_then(|value| value.as_i64())
        .map(|value| value.to_string())
        .or_else(|| {
            error
                .get("code")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });

    let message = [
        error.get("title").and_then(|value| value.as_str()),
        error.get("message").and_then(|value| value.as_str()),
        error
            .get("error_data")
            .and_then(|value| value.get("details"))
            .and_then(|value| value.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" | ");

    let message = if message.is_empty() {
        None
    } else {
        Some(message)
    };

    (code, message)
}

async fn handle_status(pool: &PgPool, status_payload: &Value) -> Result<(), AppError> {
    let Some(message_id) = status_payload.get("id").and_then(|v| v.as_str()) else {
        return Ok(());
    };
    let next_status = match status_payload.get("status").and_then(|v| v.as_str()) {
        Some("sent") => "SENT",
        Some("delivered") => "DELIVERED",
        Some("read") => "READ",
        Some("failed") => "FAILED",
        _ => return Ok(()),
    };
    let timestamp = status_payload
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(|secs| chrono::DateTime::<Utc>::from_timestamp(secs, 0))
        .unwrap_or_else(Utc::now);
    let (failure_code, failure_message) = if next_status == "FAILED" {
        parse_status_failure_details(status_payload)
    } else {
        (None, None)
    };
    log::info!(
        "[whatsapp-status] received message_id={} next_status={} timestamp={} code={:?} message={:?}",
        message_id,
        next_status,
        timestamp,
        failure_code,
        failure_message
    );

    if let Some(recipient) = sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
        r#"
        SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
               "snapshotPhone" AS snapshot_phone, "snapshotFullName" AS snapshot_full_name,
               "snapshotLocation" AS snapshot_location, "snapshotListLabel" AS snapshot_list_label,
               "snapshotMetadata" AS snapshot_metadata,
               "waMessageId" AS wa_message_id,
               "sentAt" AT TIME ZONE 'UTC' AS sent_at,
               "deliveredAt" AT TIME ZONE 'UTC' AS delivered_at,
               "readAt" AT TIME ZONE 'UTC' AS read_at,
               "failedAt" AT TIME ZONE 'UTC' AS failed_at,
               "errorCode" AS error_code,
               "errorMessage" AS error_message,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCampaignRecipient" WHERE "waMessageId" = $1 LIMIT 1
        "#,
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?
    {
        if recipient.status != next_status {
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"),
                    "deliveredAt" = CASE WHEN $1 = 'DELIVERED' THEN $2 ELSE "deliveredAt" END,
                    "readAt" = CASE WHEN $1 = 'READ' THEN $2 ELSE "readAt" END,
                    "failedAt" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $2 ELSE "failedAt" END,
                    "errorCode" = CASE WHEN $1 = 'FAILED' THEN $3 ELSE "errorCode" END,
                    "errorMessage" = CASE WHEN $1 = 'FAILED' THEN $4 ELSE "errorMessage" END,
                    "updatedAt" = NOW()
                WHERE id = $5
                "#,
            )
            .bind(next_status)
            .bind(timestamp)
            .bind(failure_code.as_deref())
            .bind(failure_message.as_deref())
            .bind(&recipient.id)
            .execute(pool)
            .await?;
            if next_status == "FAILED" {
                let campaign = sqlx::query_as::<_, WhatsappCampaignRow>(
                    r#"
                    SELECT c.id, c."userId" AS user_id, c."orgId" AS org_id, c."connectionId" AS connection_id, c."templateId" AS template_id,
                           c.name, c.description, c."templateName" AS template_name, c."templateLanguage" AS template_language,
                           c."variableMappings" AS variable_mappings,
                           wt.header AS template_header, wt.body AS template_body, wt.footer AS template_footer, wt.buttons AS template_buttons,
                           c."listLabel" AS list_label, c."defaultBatchSize" AS default_batch_size, c.status::text AS status,
                           c."scheduledAt" AT TIME ZONE 'UTC' AS scheduled_at, c."launchedAt" AT TIME ZONE 'UTC' AS launched_at,
                           c."completedAt" AT TIME ZONE 'UTC' AS completed_at, c."totalRecipients" AS total_recipients,
                           c."sentCount" AS sent_count, c."deliveredCount" AS delivered_count, c."readCount" AS read_count,
                           c."failedCount" AS failed_count, c."blockedCount" AS blocked_count, c."unsubscribedCount" AS unsubscribed_count,
                           c."createdAt" AT TIME ZONE 'UTC' AS created_at, c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
                           COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
                           wt.status::text AS template_status
                    FROM "WhatsappCampaign" c
                    LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
                    LEFT JOIN "WhatsappTemplate" wt ON wt.id = c."templateId"
                    WHERE c.id = $1
                    LIMIT 1
                    "#,
                )
                .bind(&recipient.campaign_id)
                .fetch_optional(pool)
                .await?;

                if let Some(campaign) = campaign {
                    let phone = recipient.snapshot_phone.clone().unwrap_or_default();
                    sqlx::query(
                        r#"
                        INSERT INTO "WhatsappSendEvent" (
                            id, "userId", "connectionId", "campaignId", "recipientId", "contactId", phone, "templateName",
                            status, "whatsappMessageId", "responsePayload", "errorCode", "errorMessage", "createdAt"
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                                'FAILED'::"WhatsappRecipientStatus", $9, $10, $11, $12, NOW())
                        "#,
                    )
                    .bind(cuid2::create_id())
                    .bind(&campaign.user_id)
                    .bind(&campaign.connection_id)
                    .bind(&campaign.id)
                    .bind(&recipient.id)
                    .bind(&recipient.contact_id)
                    .bind(&phone)
                    .bind(&campaign.template_name)
                    .bind(message_id)
                    .bind(status_payload)
                    .bind(failure_code.as_deref())
                    .bind(failure_message.as_deref())
                    .execute(pool)
                    .await?;

                    log::error!(
                        "[whatsapp-status] campaign delivery failed campaign_id={} recipient_id={} message_id={} code={:?} message={:?} payload={}",
                        campaign.id,
                        recipient.id,
                        message_id,
                        failure_code,
                        failure_message,
                        status_payload
                    );
                } else {
                    log::error!(
                        "[whatsapp-status] failed status for campaign recipient without campaign row recipient_id={} message_id={} code={:?} message={:?} payload={}",
                        recipient.id,
                        message_id,
                        failure_code,
                        failure_message,
                        status_payload
                    );
                }
            }
            log::info!(
                "[whatsapp-status] mapped to campaign recipient recipient_id={} campaign_id={} prior_status={} next_status={} wa_message_id={}",
                recipient.id,
                recipient.campaign_id,
                recipient.status,
                next_status,
                message_id
            );
            recompute_campaign_stats(pool, &recipient.campaign_id).await?;
            if let Some(user_id) = sqlx::query_scalar::<_, String>(
                r#"SELECT "userId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
            )
            .bind(&recipient.campaign_id)
            .fetch_optional(pool)
            .await?
            {
                publish_campaign_updated(pool, &user_id, &recipient.campaign_id).await?;
            }
        }
        return Ok(());
    }

    sqlx::query(
        r#"
        UPDATE "Message"
        SET "whatsappStatus" = $1
        WHERE "whatsappMessageId" = $2 AND sender = 'bot'
        "#,
    )
    .bind(next_status)
    .bind(message_id)
    .execute(pool)
    .await?;

    let rows = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "whatsappMessageId" = $1 AND sender = 'bot'
        "#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    for row in rows {
        message_domain::record_event(
            pool,
            &row.conversation_id,
            Some(&row.id),
            row.whatsapp_message_id
                .as_deref()
                .map(|provider_id| format!("whatsapp:status:{provider_id}:{next_status}"))
                .as_deref(),
            &format!("STATUS_{next_status}"),
            json!({ "provider": "whatsapp", "status": next_status }),
        )
        .await?;
        if let Some(conversation) = load_conversation_by_id(pool, &row.conversation_id).await? {
            if let Some((connection_id, _)) =
                parse_conversation_identifier(&conversation.customer_identifier)
            {
                let user_id = sqlx::query_scalar::<_, String>(
                    r#"SELECT "userId" FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&connection_id)
                .fetch_optional(pool)
                .await?;
                if let Some(user_id) = user_id {
                    publish_message_updated(
                        pool,
                        &user_id,
                        &row.conversation_id,
                        &row.id,
                        next_status,
                        row.error_code.as_deref(),
                        row.error_message.as_deref(),
                    )
                    .await;
                }
            }
        }
    }
    Ok(())
}

async fn handle_incoming_messages(
    pool: &PgPool,
    config: &AppConfig,
    value: &Value,
) -> Result<(), AppError> {
    let phone_number_id = value
        .get("metadata")
        .and_then(|v| v.get("phone_number_id"))
        .and_then(|v| v.as_str());
    let Some(phone_number_id) = phone_number_id else {
        return Ok(());
    };
    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!(
        "{} WHERE \"phoneNumberId\" = $1 LIMIT 1",
        select_connection_sql()
    ))
    .bind(phone_number_id)
    .fetch_optional(pool)
    .await?;
    let Some(connection) = connection else {
        return Ok(());
    };
    let Some(org_id) = connection.org_id.as_deref() else {
        log::warn!(
            "ignoring WhatsApp webhook for connection without organisation: {}",
            connection.id
        );
        return Ok(());
    };
    let contacts = value
        .get("contacts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let messages = value
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let contact_wa_ids = contacts
        .iter()
        .filter_map(|contact| contact.get("wa_id").and_then(|v| v.as_str()))
        .collect::<std::collections::HashSet<_>>();
    for message in messages {
        let from = message.get("from").and_then(|v| v.as_str()).unwrap_or("");
        if from.trim().is_empty() {
            continue;
        }
        if !contact_wa_ids.contains(from) {
            // Ignore message payloads that are not mapped to an inbound customer contact.
            continue;
        }
        let normalized_phone = normalize_phone(from);
        if normalized_phone.is_empty() {
            continue;
        }
        let text = get_inbound_text(&message);
        let media = get_incoming_media(&message);
        if text.is_none() && media.is_none() {
            continue;
        }
        if let Some(pairing_token) = text.as_deref().map(str::trim).filter(|value| {
            value.starts_with("kasiai_pair_") && !value.chars().any(char::is_whitespace)
        }) {
            let paired = if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                agent_client
                    .consume_channel_pairing(
                        org_id,
                        &connection.user_id,
                        pairing_token,
                        &normalized_phone,
                    )
                    .await
                    .is_ok()
            } else {
                false
            };
            let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
            let acknowledgement = if paired {
                "WhatsApp is now connected to your KasiAi conversation."
            } else {
                "That KasiAi pairing code is invalid or expired. Create a new code in KasiTek and try again."
            };
            if let Err(error) = send_text_message(
                &connection.phone_number_id,
                &access_token,
                &normalized_phone,
                acknowledgement,
                message.get("id").and_then(Value::as_str),
            )
            .await
            {
                log::warn!("KasiAi WhatsApp pairing acknowledgement failed: {}", error);
            }
            // Pairing tokens are credentials. Never persist them in the business
            // Inbox or forward them into model-visible conversation history.
            continue;
        }
        let profile_name = contacts
            .iter()
            .find(|contact| contact.get("wa_id").and_then(|v| v.as_str()) == Some(from))
            .and_then(|contact| contact.get("profile"))
            .and_then(|profile| profile.get("name"))
            .and_then(|v| v.as_str());
        let (conversation_id, unread_count, _last, customer_id) = find_or_create_conversation(
            pool,
            org_id,
            &connection.id,
            &normalized_phone,
            profile_name,
        )
        .await?;
        let contact_id = {
            let existing = sqlx::query_scalar::<_, String>(
                r#"SELECT id FROM "WhatsappContact" WHERE "orgId" = $1 AND phone = $2 LIMIT 1"#,
            )
            .bind(org_id)
            .bind(&normalized_phone)
            .fetch_optional(pool)
            .await?;
            match existing {
                Some(id) => {
                    sqlx::query(r#"UPDATE "WhatsappContact" SET "fullName" = COALESCE($1, "fullName"), "updatedAt" = NOW() WHERE id = $2"#)
                        .bind(profile_name)
                        .bind(&id)
                        .execute(pool)
                        .await?;
                    id
                }
                None => {
                    let id = cuid2::create_id();
                    sqlx::query(
                        r#"
                        INSERT INTO "WhatsappContact" (id, "userId", "orgId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
                        VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, NOW(), NOW())
                        "#,
                    )
                    .bind(&id)
                    .bind(&connection.user_id)
                    .bind(org_id)
                    .bind(&normalized_phone)
                    .bind(profile_name)
                    .execute(pool)
                    .await?;
                    id
                }
            }
        };
        sqlx::query(
            r#"
            UPDATE "WhatsappContact"
            SET "customerId" = $1, "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(&customer_id)
        .bind(&contact_id)
        .bind(org_id)
        .execute(pool)
        .await?;
        let content = text
            .clone()
            .or_else(|| media.as_ref().and_then(|value| value.caption.clone()))
            .unwrap_or_default();
        let message_id = cuid2::create_id();
        let wa_message_id = message.get("id").and_then(|v| v.as_str());
        sqlx::query(
            r#"
            INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", timestamp)
            VALUES ($1, $2, 'customer', $3, $4, $5, NOW())
            "#,
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&content)
        .bind(if media.is_some() { "MEDIA" } else { "TEXT" })
        .bind(wa_message_id)
        .execute(pool)
        .await?;
        if let Some(media) = media {
            message_domain::create_attachment(
                pool,
                &message_id,
                Some(&media.media_id),
                &media.kind,
                media.mime_type.as_deref(),
                media.filename.as_deref(),
                media.sha256.as_deref(),
                json!({ "source": "whatsapp_webhook" }),
            )
            .await?;
        }
        sqlx::query(
            r#"
            UPDATE "Conversation"
            SET "lastMessageAt" = NOW(), status = 'active', "unreadCount" = $1 + 1, "updatedAt" = NOW()
            WHERE id = $2
            "#,
        )
        .bind(unread_count)
        .bind(&conversation_id)
        .execute(pool)
        .await?;
        publish_message_created(pool, &connection.user_id, &message_id).await?;
        publish_conversation_updated(pool, &connection.user_id, &conversation_id).await?;
        if let (Some(inbound_text), Some(provider_message_id)) = (text.as_deref(), wa_message_id) {
            if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                let payload = json!({
                    "channelType": "whatsapp",
                    "provider": "meta-whatsapp",
                    "providerEventId": provider_message_id,
                    "providerMessageId": provider_message_id,
                    "externalIdentity": normalized_phone,
                    "externalConversationId": conversation_id,
                    "messageType": "text",
                    "content": { "text": inbound_text },
                    "displayName": profile_name,
                });
                if let Err(error) = agent_client
                    .ingest_channel_message(org_id, &connection.user_id, payload)
                    .await
                {
                    log::debug!(
                        "WhatsApp message was not routed to KasiAi conversation_id={}: {}",
                        conversation_id,
                        error
                    );
                }
            }
        }
        if let Err(error) = send_push_notification_to_user(
            pool,
            config,
            &connection.user_id,
            PushNotificationPayload {
                title: "New WhatsApp message".to_string(),
                body: format!(
                    "{}: {}",
                    profile_name
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(normalized_phone.as_str()),
                    preview_text(&content, 120)
                ),
                url: "/inbox".to_string(),
                tag: Some(format!("conversation:{conversation_id}")),
            },
        )
        .await
        {
            log::warn!(
                "failed to send push notification for incoming whatsapp message conversation_id={} user_id={}: {}",
                conversation_id,
                connection.user_id,
                error
            );
        }

        let stop = text
            .as_deref()
            .map(|t| {
                ["stop", "unsubscribe", "cancel", "end", "optout", "opt-out"]
                    .contains(&t.trim().to_lowercase().as_str())
            })
            .unwrap_or(false);
        if stop {
            sqlx::query(r#"UPDATE "WhatsappContact" SET excluded = true, "optIn" = false, notes = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(format!("Unsubscribed via STOP keyword on {}", Utc::now().to_rfc3339()))
                .bind(&contact_id)
                .execute(pool)
                .await?;
            let campaign_ids = sqlx::query_scalar::<_, String>(
                r#"SELECT "campaignId" FROM "WhatsappCampaignRecipient" WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")"#,
            )
            .bind(&contact_id)
            .fetch_all(pool)
            .await?;
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = 'UNSUBSCRIBED'::"WhatsappRecipientStatus",
                    "errorCode" = 'unsubscribed',
                    "errorMessage" = 'Contact unsubscribed via inbound keyword',
                    "updatedAt" = NOW()
                WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'PROCESSING'::"WhatsappRecipientStatus")
                "#,
            )
            .bind(&contact_id)
            .execute(pool)
            .await?;
            for campaign_id in campaign_ids {
                recompute_campaign_stats(pool, &campaign_id).await?;
                if let Some(user_id) = sqlx::query_scalar::<_, String>(
                    r#"SELECT "userId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&campaign_id)
                .fetch_optional(pool)
                .await?
                {
                    publish_campaign_updated(pool, &user_id, &campaign_id).await?;
                }
            }
        }
    }
    Ok(())
}

pub async fn process_webhook_payload(
    pool: &PgPool,
    config: &AppConfig,
    payload: Value,
) -> Result<(), AppError> {
    let entries = payload
        .get("entry")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in entries {
        let changes = entry
            .get("changes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for change in changes {
            let value = change.get("value").cloned().unwrap_or(Value::Null);
            let statuses = value
                .get("statuses")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for status in statuses {
                handle_status(pool, &status).await?;
                let phone_number_id = value
                    .get("metadata")
                    .and_then(|metadata| metadata.get("phone_number_id"))
                    .and_then(Value::as_str);
                let provider_message_id = status.get("id").and_then(Value::as_str);
                let provider_status = status.get("status").and_then(Value::as_str);
                if let (Some(phone_number_id), Some(provider_message_id), Some(provider_status)) =
                    (phone_number_id, provider_message_id, provider_status)
                {
                    let connection_scope = sqlx::query_as::<_, (String, String)>(
                        r#"SELECT "orgId", "userId" FROM "WhatsappConnection"
                           WHERE "phoneNumberId" = $1 AND "orgId" IS NOT NULL LIMIT 1"#,
                    )
                    .bind(phone_number_id)
                    .fetch_optional(pool)
                    .await?;
                    if let Some((org_id, user_id)) = connection_scope {
                        if let Ok(agent_client) = AgentPlatformClient::from_config(config) {
                            let normalized_status =
                                match provider_status.to_ascii_lowercase().as_str() {
                                    "sent" => "sent",
                                    "delivered" => "delivered",
                                    "read" => "read",
                                    "failed" => "failed",
                                    _ => "unknown",
                                };
                            let (failure_code, failure_message) =
                                parse_status_failure_details(&status);
                            let mut payload = json!({
                                "providerMessageId": provider_message_id,
                                "status": normalized_status,
                            });
                            if normalized_status == "failed" {
                                payload["error"] =
                                    json!({ "code": failure_code, "message": failure_message });
                            }
                            if let Err(error) = agent_client
                                .update_channel_delivery_status(&org_id, &user_id, payload)
                                .await
                            {
                                log::debug!(
                                    "WhatsApp status did not map to a KasiAi delivery message_id={}: {}",
                                    provider_message_id,
                                    error
                                );
                            }
                        }
                    }
                }
            }
            whatsapp_calls::ingest_webhook_calls(pool, config, &value).await?;
            handle_incoming_messages(pool, config, &value).await?;
        }
    }
    Ok(())
}

async fn org_connection_ids(pool: &PgPool, org_id: &str) -> Result<Vec<String>, AppError> {
    sqlx::query_scalar::<_, String>(r#"SELECT id FROM "WhatsappConnection" WHERE "orgId" = $1"#)
        .bind(org_id)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

async fn scoped_conversation(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Option<ConversationRow>, AppError> {
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT c.id, c.channel, c."customerIdentifier" AS customer_identifier, c."customerName" AS customer_name,
               c.status,
               c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
               c.starred,
               c."unreadCount" AS unread_count,
               c."createdAt" AT TIME ZONE 'UTC' AS created_at,
               c."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation" c
        WHERE c.id = $1
          AND c."orgId" = $2
          AND c.channel = 'whatsapp'
          AND c."customerIdentifier" LIKE 'wa:%'
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn load_conversation_by_id(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Option<ConversationRow>, AppError> {
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,
               status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
               starred,
               "unreadCount" AS unread_count,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation"
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn load_message_by_id(
    pool: &PgPool,
    message_id: &str,
) -> Result<Option<MessageRow>, AppError> {
    sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1
        LIMIT 1
        "#,
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn publish_event_best_effort(org_id: &str, event: Value) {
    if let Err(error) = realtime::publish_whatsapp_event(org_id, &event).await {
        log::warn!("failed to publish whatsapp realtime event: {}", error);
    }
}

async fn conversation_org_id(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Option<String>, AppError> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT "orgId" FROM "Conversation" WHERE id = $1 AND "orgId" IS NOT NULL"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn publish_campaign_updated(
    pool: &PgPool,
    _user_id: &str,
    campaign_id: &str,
) -> Result<(), AppError> {
    let org_id = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT "orgId" FROM "WhatsappCampaign" WHERE id = $1 LIMIT 1"#,
    )
    .bind(campaign_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    let Some(org_id) = org_id else {
        return Ok(());
    };
    let Some(campaign) = get_campaign_row(pool, &org_id, campaign_id).await? else {
        return Ok(());
    };

    publish_event_best_effort(
        &org_id,
        json!({
            "type": "campaign.updated",
            "campaignId": campaign.id,
            "campaign": {
                "id": campaign.id,
                "status": campaign.status,
                "totalRecipients": campaign.total_recipients,
                "sentCount": campaign.sent_count,
                "deliveredCount": campaign.delivered_count,
                "readCount": campaign.read_count,
                "failedCount": campaign.failed_count,
                "blockedCount": campaign.blocked_count,
                "unsubscribedCount": campaign.unsubscribed_count,
                "updatedAt": campaign.updated_at,
            }
        }),
    )
    .await;

    Ok(())
}

async fn publish_conversation_updated(
    pool: &PgPool,
    _user_id: &str,
    conversation_id: &str,
) -> Result<(), AppError> {
    let Some(conversation) = load_conversation_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let Some(org_id) = conversation_org_id(pool, &conversation.id).await? else {
        return Ok(());
    };
    let (connection_id, phone) = parse_conversation_identifier(&conversation.customer_identifier)
        .unwrap_or_else(|| ("".to_string(), conversation.customer_identifier.clone()));
    let connection_label = if connection_id.is_empty() {
        None
    } else {
        sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
        )
        .bind(&connection_id)
        .fetch_optional(pool)
        .await?
        .flatten()
    };
    publish_event_best_effort(
        &org_id,
        json!({
            "type": "conversation.updated",
            "conversationId": conversation.id,
            "conversation": {
                "id": conversation.id,
                "customerName": conversation.customer_name,
                "phone": phone,
                "connectionId": if connection_id.is_empty() { None::<String> } else { Some(connection_id) },
                "connectionLabel": connection_label,
                "lastMessageAt": conversation.last_message_at,
                "unreadCount": conversation.unread_count,
                "starred": conversation.starred
            }
        }),
    )
    .await;
    Ok(())
}

async fn publish_message_created(
    pool: &PgPool,
    _user_id: &str,
    message_id: &str,
) -> Result<(), AppError> {
    let Some(message) = load_message_by_id(pool, message_id).await? else {
        return Ok(());
    };
    let conversation = load_conversation_by_id(pool, &message.conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let Some(org_id) = conversation_org_id(pool, &conversation.id).await? else {
        return Ok(());
    };
    let structured_message = message_domain::list_timeline_messages(pool, &conversation.id)
        .await?
        .into_iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(message_id));
    let Some(mut structured_message) = structured_message else {
        return Ok(());
    };
    let can_react = structured_message
        .get("providerMessageId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
        && structured_message
            .get("deletedAt")
            .is_some_and(Value::is_null);
    if let Some(object) = structured_message.as_object_mut() {
        object.insert("canReact".to_string(), json!(can_react));
    }
    let (connection_id, phone) = parse_conversation_identifier(&conversation.customer_identifier)
        .unwrap_or_else(|| ("".to_string(), conversation.customer_identifier.clone()));
    let connection_label = if connection_id.is_empty() {
        None
    } else {
        sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
        )
        .bind(&connection_id)
        .fetch_optional(pool)
        .await?
        .flatten()
    };
    publish_event_best_effort(
        &org_id,
        json!({
            "type": "message.created",
            "conversationId": conversation.id,
            "conversation": {
                "customerName": conversation.customer_name,
                "phone": phone,
                "connectionId": if connection_id.is_empty() { None::<String> } else { Some(connection_id) },
                "connectionLabel": connection_label,
                "unreadCount": conversation.unread_count,
                "lastMessageAt": conversation.last_message_at,
            },
            "message": structured_message,
        }),
    )
    .await;
    Ok(())
}

async fn publish_message_updated(
    pool: &PgPool,
    _user_id: &str,
    conversation_id: &str,
    message_id: &str,
    whatsapp_status: &str,
    error_code: Option<&str>,
    error_message: Option<&str>,
) {
    let Some(org_id) = conversation_org_id(pool, conversation_id)
        .await
        .ok()
        .flatten()
    else {
        return;
    };
    publish_event_best_effort(
        &org_id,
        json!({
            "type": "message.updated",
            "conversationId": conversation_id,
            "message": {
                "id": message_id,
                "whatsappStatus": whatsapp_status,
                "errorCode": error_code,
                "errorMessage": error_message,
            }
        }),
    )
    .await;
}

async fn publish_message_send_failed(
    pool: &PgPool,
    _user_id: &str,
    conversation_id: &str,
    error: &str,
    text: Option<&str>,
) {
    let Some(org_id) = conversation_org_id(pool, conversation_id)
        .await
        .ok()
        .flatten()
    else {
        return;
    };
    publish_event_best_effort(
        &org_id,
        json!({
            "type": "message.send_failed",
            "conversationId": conversation_id,
            "error": error,
            "text": text,
        }),
    )
    .await;
}

fn display_text(content: &str) -> String {
    content.to_string()
}

fn preview_text(content: &str, max: usize) -> String {
    let text = display_text(content);
    if text.len() > max {
        format!("{}...", &text[..max])
    } else {
        text
    }
}

pub(crate) fn sanitize_filename(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn media_kind_from_upload(filename: Option<&str>, mime_type: Option<&str>) -> &'static str {
    let mime = mime_type.unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("image/") {
        return "image";
    }
    if mime.starts_with("video/") {
        return "video";
    }
    if mime.starts_with("audio/") {
        return "audio";
    }

    let extension = filename
        .and_then(|name| name.rsplit('.').next())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" => "image",
        "mp4" | "mov" | "webm" | "mkv" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "aac" => "audio",
        _ => "document",
    }
}

async fn send_text_message(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    text: &str,
    context_message_id: Option<&str>,
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": "text",
        "text": { "body": text },
        "context": context_message_id.map(|id| json!({"message_id": id}))
    });
    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API text send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    let message_id = raw
        .get("messages")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::Internal(
                "WhatsApp Cloud API text send did not return a message id".to_string(),
            )
        })?;
    Ok((message_id.to_string(), raw))
}

/// Deliver a KasiAi reply through an existing, organization-scoped WhatsApp
/// inbox conversation. The Agent Platform owns the canonical agent message;
/// this boundary only resolves the connected account and performs transport.
pub async fn deliver_agent_message(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    text: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp conversation not found".to_string()))?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid WhatsApp conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (provider_message_id, _) = send_text_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        text,
        None,
    )
    .await?;
    Ok(json!({
        "providerMessageId": provider_message_id,
        "status": "sent",
    }))
}

async fn upload_whatsapp_media(
    phone_number_id: &str,
    access_token: &str,
    bytes: Vec<u8>,
    filename: &str,
    mime_type: Option<&str>,
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/media");
    let part = {
        let base = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        match mime_type.filter(|value| !value.trim().is_empty()) {
            Some(value) => base
                .mime_str(value)
                .map_err(|_| AppError::BadRequest("Attachment mime type is invalid".to_string()))?,
            None => base,
        }
    };
    let form = reqwest::multipart::Form::new()
        .text("messaging_product", "whatsapp")
        .part("file", part);

    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .multipart(form)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API media upload failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }

    let media_id = raw
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            AppError::Internal("WhatsApp media upload did not return a media id".to_string())
        })?;

    Ok((media_id.to_string(), raw))
}

async fn send_media_message(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    kind: &str,
    media_id: &str,
    caption: Option<&str>,
    filename: Option<&str>,
    context_message_id: Option<&str>,
) -> Result<(String, Value), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let media_payload = match kind {
        "image" => json!({ "id": media_id, "caption": caption }),
        "video" => json!({ "id": media_id, "caption": caption }),
        "audio" => json!({ "id": media_id }),
        _ => json!({ "id": media_id, "caption": caption, "filename": filename }),
    };
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": kind,
        kind: media_payload,
        "context": context_message_id.map(|id| json!({"message_id": id}))
    });

    let response = whatsapp_http_client()?
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp Cloud API media send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }

    let message_id = raw
        .get("messages")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AppError::Internal(
                "WhatsApp Cloud API media send did not return a message id".to_string(),
            )
        })?;
    Ok((message_id.to_string(), raw))
}

async fn claim_queued_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    message_id: Option<&str>,
) -> Result<Option<PendingInboxMessageRow>, AppError> {
    let row = if let Some(message_id) = message_id {
        sqlx::query_as::<_, PendingInboxMessageRow>(
            r#"
            SELECT
                m.id,
                m."conversationId" AS conversation_id,
                wc."userId" AS user_id,
                c."customerIdentifier" AS customer_identifier,
                wc."phoneNumberId" AS phone_number_id,
                wc."accessTokenEncrypted" AS access_token_encrypted,
                m.content
            FROM "Message" m
            INNER JOIN "Conversation" c ON c.id = m."conversationId"
            INNER JOIN "WhatsappConnection" wc
                ON c.channel = 'whatsapp'
               AND c."customerIdentifier" LIKE ('wa:' || wc.id || ':%')
            WHERE m.id = $1
              AND m.sender = 'bot'
              AND m."whatsappMessageId" IS NULL
              AND COALESCE(m."whatsappStatus", 'QUEUED') = 'QUEUED'
            FOR UPDATE OF m SKIP LOCKED
            "#,
        )
        .bind(message_id)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        sqlx::query_as::<_, PendingInboxMessageRow>(
            r#"
            SELECT
                m.id,
                m."conversationId" AS conversation_id,
                wc."userId" AS user_id,
                c."customerIdentifier" AS customer_identifier,
                wc."phoneNumberId" AS phone_number_id,
                wc."accessTokenEncrypted" AS access_token_encrypted,
                m.content
            FROM "Message" m
            INNER JOIN "Conversation" c ON c.id = m."conversationId"
            INNER JOIN "WhatsappConnection" wc
                ON c.channel = 'whatsapp'
               AND c."customerIdentifier" LIKE ('wa:' || wc.id || ':%')
            WHERE m.sender = 'bot'
              AND m."whatsappMessageId" IS NULL
              AND COALESCE(m."whatsappStatus", 'QUEUED') = 'QUEUED'
            ORDER BY m.timestamp ASC
            FOR UPDATE OF m SKIP LOCKED
            LIMIT 1
            "#,
        )
        .fetch_optional(&mut **tx)
        .await?
    };

    let Some(row) = row else {
        return Ok(None);
    };

    sqlx::query(
        r#"
        UPDATE "Message"
        SET "whatsappStatus" = 'PROCESSING', "errorCode" = NULL, "errorMessage" = NULL
        WHERE id = $1
        "#,
    )
    .bind(&row.id)
    .execute(&mut **tx)
    .await?;

    Ok(Some(row))
}

async fn process_claimed_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job: PendingInboxMessageRow,
) -> Result<(String, String, String, Option<String>), AppError> {
    let (_, phone) = parse_conversation_identifier(&job.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation identifier".to_string()))?;
    let access_token = decrypt_social_secret(&job.access_token_encrypted)?;
    let reply_to_whatsapp_message_id = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT COALESCE(reference."referencedProviderMessageId", target."whatsappMessageId")
        FROM "MessageReference" reference
        LEFT JOIN "Message" target ON target.id = reference."referencedMessageId"
        WHERE reference."messageId" = $1
        LIMIT 1
        "#,
    )
    .bind(&job.id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    log::info!(
        "[whatsapp-inbox-worker] sending queued message message_id={} conversation_id={} phone_number_id={} recipient_phone={} reply_to={:?}",
        job.id,
        job.conversation_id,
        job.phone_number_id,
        phone,
        reply_to_whatsapp_message_id
    );
    let (whatsapp_message_id, _) = send_text_message(
        &job.phone_number_id,
        &access_token,
        &phone,
        &job.content,
        reply_to_whatsapp_message_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE "Message"
        SET
            "whatsappMessageId" = $2,
            "whatsappStatus" = 'SENT',
            "errorCode" = NULL,
            "errorMessage" = NULL
        WHERE id = $1
        "#,
    )
    .bind(&job.id)
    .bind(&whatsapp_message_id)
    .execute(&mut **tx)
    .await?;

    Ok((
        job.user_id,
        job.conversation_id,
        job.id,
        Some(whatsapp_message_id),
    ))
}

async fn fail_claimed_inbox_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    message_id: &str,
    error: &AppError,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "Message"
        SET
            "whatsappStatus" = 'FAILED',
            "errorCode" = 'SEND_FAILED',
            "errorMessage" = $2
        WHERE id = $1
        "#,
    )
    .bind(message_id)
    .bind(error.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn process_single_queued_inbox_message(
    pool: &PgPool,
    explicit_message_id: Option<&str>,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let Some(job) = claim_queued_inbox_message(&mut tx, explicit_message_id).await? else {
        tx.rollback().await?;
        return Ok(false);
    };

    let message_id = job.id.clone();
    let conversation_id = job.conversation_id.clone();
    let user_id = job.user_id.clone();
    let text = display_text(&job.content);
    log::info!(
        "[whatsapp-inbox-worker] claimed queued message message_id={} conversation_id={} explicit={:?}",
        message_id,
        conversation_id,
        explicit_message_id
    );

    match process_claimed_inbox_message(&mut tx, job).await {
        Ok((_user_id, _conversation_id, _message_id, _whatsapp_message_id)) => {
            tx.commit().await?;
            log::info!(
                "[whatsapp-inbox-worker] completed queued message message_id={} conversation_id={}",
                message_id,
                conversation_id
            );
            publish_message_updated(
                pool,
                &user_id,
                &conversation_id,
                &message_id,
                "SENT",
                None,
                None,
            )
            .await;
            publish_conversation_updated(pool, &user_id, &conversation_id).await?;
            Ok(true)
        }
        Err(error) => {
            fail_claimed_inbox_message(&mut tx, &message_id, &error).await?;
            tx.commit().await?;
            log::error!(
                "[whatsapp-inbox-worker] failed queued message message_id={} conversation_id={} error={}",
                message_id,
                conversation_id,
                error
            );
            publish_message_updated(
                pool,
                &user_id,
                &conversation_id,
                &message_id,
                "FAILED",
                Some("SEND_FAILED"),
                Some(&error.to_string()),
            )
            .await;
            publish_message_send_failed(
                pool,
                &user_id,
                &conversation_id,
                &error.to_string(),
                Some(&text),
            )
            .await;
            Ok(true)
        }
    }
}

pub async fn process_queued_inbox_messages(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
    if limit <= 0 {
        return Ok(0);
    }

    let max_items = limit as usize;
    let mut processed = 0_i64;
    let mut seen = HashSet::new();

    for message_id in realtime::drain_whatsapp_inbox_queue(max_items).await? {
        if !seen.insert(message_id.clone()) {
            continue;
        }
        if process_single_queued_inbox_message(pool, Some(&message_id)).await? {
            processed += 1;
            if processed >= limit {
                return Ok(processed);
            }
        }
    }

    while processed < limit {
        if !process_single_queued_inbox_message(pool, None).await? {
            break;
        }
        processed += 1;
    }

    Ok(processed)
}

async fn send_reaction_message(
    phone_number_id: &str,
    access_token: &str,
    recipient_phone: &str,
    target_message_id: &str,
    emoji: &str,
) -> Result<Value, AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let payload = json!({
        "messaging_product": "whatsapp",
        "to": recipient_phone,
        "type": "reaction",
        "reaction": {
            "message_id": target_message_id,
            "emoji": emoji,
        }
    });
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp reaction send failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(raw)
}

async fn mark_message_read_api(
    phone_number_id: &str,
    access_token: &str,
    message_id: &str,
) -> Result<(), AppError> {
    let url = format!("{GRAPH_BASE}/{phone_number_id}/messages");
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(access_token)
        .json(&json!({
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id
        }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let raw: Value = response.json().await.unwrap_or(Value::Null);
        return Err(AppError::BadRequest(format!(
            "WhatsApp mark-as-read failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    Ok(())
}

async fn get_media_metadata(
    access_token: &str,
    media_id: &str,
) -> Result<(String, Option<String>), AppError> {
    let url = format!("{GRAPH_BASE}/{media_id}");
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = response.status();
    let raw: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "WhatsApp media lookup failed ({}): {}",
            status,
            raw.get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
        )));
    }
    let download_url = raw.get("url").and_then(|v| v.as_str()).ok_or_else(|| {
        AppError::Internal("WhatsApp media lookup did not return a download URL".to_string())
    })?;
    let mime_type = raw
        .get("mime_type")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    Ok((download_url.to_string(), mime_type))
}

async fn download_media_bytes(
    access_token: &str,
    media_id: &str,
) -> Result<(Vec<u8>, String), AppError> {
    let (download_url, mime_type) = get_media_metadata(access_token, media_id).await?;
    let response = reqwest::Client::new()
        .get(download_url)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(AppError::BadRequest(format!(
            "WhatsApp media download failed ({}): {}",
            status,
            if raw.is_empty() {
                "Unknown error"
            } else {
                &raw
            }
        )));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .or(mime_type)
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = response.bytes().await?.to_vec();
    Ok((bytes, content_type))
}

pub async fn list_inbox_conversations(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let conversations = sqlx::query_as::<_, InboxConversationListRow>(
        r#"
        SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c.starred,
            c."unreadCount" AS unread_count,
            c."createdAt" AT TIME ZONE 'UTC' AS created_at,
            c."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
            NULLIF(split_part(c."customerIdentifier", ':', 2), '') AS connection_id,
            NULLIF(substring(c."customerIdentifier" from '^[^:]+:[^:]+:(.*)$'), '') AS phone,
            COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
            last_message.content AS last_message_content
        FROM "Conversation" c
        JOIN "WhatsappConnection" wc
          ON wc.id = split_part(c."customerIdentifier", ':', 2)
        LEFT JOIN LATERAL (
            SELECT m.content
            FROM "Message" m
            WHERE m."conversationId" = c.id
            ORDER BY m.timestamp DESC
            LIMIT 1
        ) last_message ON true
        WHERE c.channel = 'whatsapp'
          AND c."orgId" = $1
          AND c."customerIdentifier" LIKE 'wa:%'
        ORDER BY c."lastMessageAt" DESC
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    let mut result = Vec::with_capacity(conversations.len());
    for conversation in conversations {
        result.push(json!({
            "id": conversation.id,
            "channel": conversation.channel,
            "customerName": conversation.customer_name,
            "phone": conversation.phone.unwrap_or_else(|| conversation.customer_identifier.clone()),
            "status": conversation.status,
            "lastMessageAt": conversation.last_message_at,
            "unreadCount": conversation.unread_count,
            "starred": conversation.starred,
            "connectionId": conversation.connection_id,
            "connectionLabel": conversation.connection_label,
            "lastMessage": conversation.last_message_content
                .as_deref()
                .map(|content| preview_text(content, 180))
                .unwrap_or_else(|| "No messages yet".to_string()),
        }));
    }
    Ok(json!({ "conversations": result }))
}

pub async fn inbox_unread_count(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let count = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        SELECT COALESCE(SUM(c."unreadCount")::bigint, 0)
        FROM "Conversation" c
        JOIN "WhatsappConnection" wc
          ON wc.id = split_part(c."customerIdentifier", ':', 2)
        WHERE c.channel = 'whatsapp'
          AND c."orgId" = $1
          AND c."customerIdentifier" LIKE 'wa:%'
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?
    .unwrap_or(0);
    Ok(json!({ "unreadCount": count }))
}

pub async fn start_inbox_conversation(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    input: &WhatsappStartConversationRequest,
) -> Result<Value, AppError> {
    let connection_id = input.connection_id.as_deref().unwrap_or("");
    let template_id = input.template_id.as_deref().unwrap_or("");
    let normalized_phone = normalize_phone(input.phone.as_deref().unwrap_or(""));
    if connection_id.is_empty() || template_id.is_empty() || normalized_phone.is_empty() {
        return Err(AppError::BadRequest(
            "Connection, template, and recipient phone are required".to_string(),
        ));
    }
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AT TIME ZONE 'UTC' AS last_synced, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappTemplate"
        WHERE id = $1 AND "orgId" = $2 AND status = 'APPROVED'::"WhatsappTemplateStatus"
        LIMIT 1
        "#
    )
    .bind(template_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Approved template not found".to_string()))?;
    if template
        .connection_id
        .as_deref()
        .is_some_and(|id| id != connection.id)
    {
        return Err(AppError::BadRequest(
            "Selected template does not belong to this WhatsApp connection".to_string(),
        ));
    }
    let body_parameters = input.body_parameters.clone().unwrap_or_default();
    if body_parameters.len() as i32 != template.variables_count {
        return Err(AppError::BadRequest(format!(
            "This template expects {} variable{}.",
            template.variables_count,
            if template.variables_count == 1 {
                ""
            } else {
                "s"
            }
        )));
    }
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (message_id, _) = send_marketing_template(
        &connection.phone_number_id,
        &access_token,
        &normalized_phone,
        &template.template_name,
        &template.language,
        &body_parameters,
    )
    .await?;
    let (conversation_id, _, _, customer_id) = find_or_create_conversation(
        pool,
        org_id,
        &connection.id,
        &normalized_phone,
        input.customer_name.as_deref(),
    )
    .await?;
    let contact_id = if let Some(id) = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappContact" WHERE "orgId" = $1 AND phone = $2 LIMIT 1"#,
    )
    .bind(org_id)
    .bind(&normalized_phone)
    .fetch_optional(pool)
    .await?
    {
        id
    } else {
        let id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "WhatsappContact" (id, "userId", "orgId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, NOW(), NOW())"#,
        )
        .bind(&id)
        .bind(user_id)
        .bind(org_id)
        .bind(&normalized_phone)
        .bind(input.customer_name.as_deref())
        .execute(pool)
        .await?;
        id
    };
    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "customerId" = $1, "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(&customer_id)
    .bind(&contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;
    let rendered = template
        .body
        .clone()
        .unwrap_or_else(|| "Template message sent.".to_string());
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappMessageId", timestamp)
        VALUES ($1, $2, 'bot', $3, $4, NOW())
        "#
    )
    .bind(cuid2::create_id())
    .bind(&conversation_id)
    .bind(rendered)
    .bind(&message_id)
    .execute(pool)
    .await?;
    sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "customerName" = COALESCE($1, "customerName"), "updatedAt" = NOW() WHERE id = $2"#)
        .bind(input.customer_name.as_deref())
        .bind(&conversation_id)
        .execute(pool)
        .await?;
    publish_message_created(pool, user_id, &message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation_id).await?;
    Ok(json!({
        "success": true,
        "conversationId": conversation_id,
        "messageId": message_id,
        "category": template.category,
        "contactId": contact_id,
    }))
}

pub async fn list_conversation_messages(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let mut mapped = message_domain::list_timeline_messages(pool, &conversation.id).await?;
    for message in &mut mapped {
        let can_react = message
            .get("providerMessageId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
            && message.get("deletedAt").is_some_and(Value::is_null);
        if let Some(object) = message.as_object_mut() {
            object.insert("canReact".to_string(), json!(can_react));
        }
    }
    Ok(json!({
        "messages": mapped,
        "capabilities": message_domain::channel_capabilities("whatsapp"),
    }))
}

pub async fn send_conversation_message(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    input: WhatsappSendMessageRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let text = input
        .text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Reply text or media file is required".to_string()))?;
    parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let reply_target = if let Some(reply_to_message_id) = input
        .reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let reply_target = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
                   timestamp AT TIME ZONE 'UTC' AS timestamp
            FROM "Message"
            WHERE id = $1 AND "conversationId" = $2
            LIMIT 1
            "#
        )
        .bind(reply_to_message_id)
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Reply target not found".to_string()))?;
        let target_wa_id = reply_target.whatsapp_message_id.clone().ok_or_else(|| {
            AppError::BadRequest(
                "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
            )
        })?;
        Some((reply_target, target_wa_id))
    } else {
        None
    };
    let created_message_id = cuid2::create_id();
    log::info!(
        "[whatsapp-inbox-api] queueing message message_id={} conversation_id={} user_id={} has_reply={}",
        created_message_id,
        conversation.id,
        user_id,
        input.reply_to_message_id.as_deref().is_some_and(|value| !value.trim().is_empty())
    );
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'QUEUED', NOW())
        "#,
    )
    .bind(&created_message_id)
    .bind(&conversation.id)
    .bind(text)
    .execute(pool)
    .await?;
    if let Some((target, target_wa_id)) = reply_target {
        message_domain::create_reference(
            pool,
            &created_message_id,
            &target.id,
            Some(&target_wa_id),
            Some(&preview_text(&target.content, 180)),
            Some("TEXT"),
        )
        .await?;
    }
    sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    publish_message_created(pool, user_id, &created_message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation.id).await?;
    if let Err(error) = realtime::enqueue_whatsapp_inbox_message(&created_message_id).await {
        log::warn!(
            "failed to enqueue whatsapp inbox message {}: {}",
            created_message_id,
            error
        );
    }
    Ok(json!({ "success": true, "queued": true, "messageId": created_message_id }))
}

pub async fn send_conversation_media(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    mut payload: Multipart,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;

    let mut file_bytes = Vec::new();
    let mut filename: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut caption: Option<String> = None;
    let mut reply_to_message_id: Option<String> = None;

    while let Some(field) = payload.next().await {
        let mut field = field
            .map_err(|_| AppError::BadRequest("Failed to read multipart payload".to_string()))?;
        let Some(name) = field.name() else { continue };
        let name = name.to_string();
        if name == "file" {
            if let Some(disposition) = field.content_disposition() {
                filename = disposition.get_filename().map(sanitize_filename);
            }
            mime_type = field
                .content_type()
                .map(|value| value.essence_str().to_string());
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk
                .map_err(|_| AppError::BadRequest("Failed to read multipart field".to_string()))?;
            bytes.extend_from_slice(&chunk);
        }

        match name.as_str() {
            "file" => file_bytes = bytes,
            "caption" => {
                let value = String::from_utf8(bytes).unwrap_or_default();
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    caption = Some(trimmed);
                }
            }
            "replyToMessageId" => {
                let value = String::from_utf8(bytes).unwrap_or_default();
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    reply_to_message_id = Some(trimmed);
                }
            }
            _ => {}
        }
    }

    if file_bytes.is_empty() {
        return Err(AppError::BadRequest(
            "Attachment file is required in form-data field: file".to_string(),
        ));
    }

    let final_filename = filename
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("attachment-{}.bin", Utc::now().timestamp()));
    let media_kind = media_kind_from_upload(Some(&final_filename), mime_type.as_deref());

    let reply_target = if let Some(reply_target_message_id) = reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let reply_target = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
                   timestamp AT TIME ZONE 'UTC' AS timestamp
            FROM "Message"
            WHERE id = $1 AND "conversationId" = $2
            LIMIT 1
            "#,
        )
        .bind(reply_target_message_id)
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Reply target not found".to_string()))?;
        let target_wa_id = reply_target.whatsapp_message_id.clone().ok_or_else(|| {
            AppError::BadRequest(
                "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
            )
        })?;
        Some((reply_target, target_wa_id))
    } else {
        None
    };

    let (uploaded_media_id, upload_raw) = upload_whatsapp_media(
        &connection.phone_number_id,
        &access_token,
        file_bytes,
        &final_filename,
        mime_type.as_deref(),
    )
    .await?;
    let sha256 = upload_raw
        .get("sha256")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    let (whatsapp_message_id, _) = send_media_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        media_kind,
        &uploaded_media_id,
        caption.as_deref(),
        Some(&final_filename),
        reply_target
            .as_ref()
            .map(|(_, provider_id)| provider_id.as_str()),
    )
    .await?;

    let message_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "whatsappMessageId", "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, 'MEDIA', $4, 'SENT', NOW())
        "#,
    )
    .bind(&message_id)
    .bind(&conversation.id)
    .bind(caption.as_deref().unwrap_or_default())
    .bind(&whatsapp_message_id)
    .execute(pool)
    .await?;
    message_domain::create_attachment(
        pool,
        &message_id,
        Some(&uploaded_media_id),
        media_kind,
        mime_type.as_deref(),
        Some(&final_filename),
        sha256.as_deref(),
        json!({ "source": "whatsapp_upload" }),
    )
    .await?;
    if let Some((target, target_wa_id)) = reply_target {
        message_domain::create_reference(
            pool,
            &message_id,
            &target.id,
            Some(&target_wa_id),
            Some(&preview_text(&target.content, 180)),
            Some("TEXT"),
        )
        .await?;
    }
    sqlx::query(
        r#"UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1"#,
    )
    .bind(&conversation.id)
    .execute(pool)
    .await?;
    publish_message_created(pool, user_id, &message_id).await?;
    publish_conversation_updated(pool, user_id, &conversation.id).await?;

    Ok(json!({
        "success": true,
        "messageId": message_id,
        "mediaId": uploaded_media_id,
        "status": "SENT"
    }))
}

pub async fn update_conversation(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
    input: ConversationUpdateRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    if let Some(starred) = input.starred {
        sqlx::query(r#"UPDATE "Conversation" SET starred = $1, "updatedAt" = NOW() WHERE id = $2"#)
            .bind(starred)
            .bind(&conversation.id)
            .execute(pool)
            .await?;
    }

    publish_conversation_updated(pool, user_id, &conversation.id).await?;

    let refreshed = load_conversation_by_id(pool, &conversation.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    Ok(json!({
        "success": true,
        "conversationId": refreshed.id,
        "starred": refreshed.starred,
    }))
}

pub async fn delete_conversation(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;

    sqlx::query(r#"DELETE FROM "Message" WHERE "conversationId" = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    sqlx::query(r#"DELETE FROM "Conversation" WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;

    Ok(json!({
        "success": true,
        "conversationId": conversation.id,
        "deleted": true
    }))
}

pub async fn mark_conversation_read(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    conversation_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    sqlx::query(r#"UPDATE "Conversation" SET "unreadCount" = 0, "lastReadAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id).await?;
    let unread_messages = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "conversationId" = $1 AND sender = 'customer' AND "whatsappMessageId" IS NOT NULL
          AND ("whatsappStatus" IS NULL OR "whatsappStatus" <> 'READ')
        ORDER BY timestamp ASC
        "#
    )
    .bind(&conversation.id)
    .fetch_all(pool)
    .await?;
    if let Some(connection) = connection {
        match decrypt_social_secret(&connection.access_token_encrypted) {
            Ok(access_token) => {
                for message in &unread_messages {
                    if let Some(wa_id) = message.whatsapp_message_id.as_deref() {
                        let _ = mark_message_read_api(
                            &connection.phone_number_id,
                            &access_token,
                            wa_id,
                        )
                        .await;
                    }
                }
            }
            Err(error) => {
                log::warn!(
                    "[whatsapp-inbox-api] failed to decrypt token while marking conversation {} read: {}",
                    conversation.id,
                    error
                );
            }
        }
    }
    let ids = unread_messages
        .into_iter()
        .map(|m| m.id)
        .collect::<Vec<_>>();
    if !ids.is_empty() {
        sqlx::query(r#"UPDATE "Message" SET "whatsappStatus" = 'READ' WHERE id = ANY($1)"#)
            .bind(&ids)
            .execute(pool)
            .await?;
    }
    publish_conversation_updated(pool, user_id, &conversation.id).await?;
    Ok(json!({ "success": true }))
}

pub async fn send_message_reaction(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    message_id: &str,
    input: WhatsappReactionRequest,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let remove = input.remove.unwrap_or(false);
    let emoji = input.emoji.unwrap_or_default().trim().to_string();
    if !remove && emoji.is_empty() {
        return Err(AppError::BadRequest("Emoji is required".to_string()));
    }
    let target_message = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1 AND "conversationId" = $2
        LIMIT 1
        "#
    )
    .bind(message_id)
    .bind(&conversation.id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Target message not found".to_string()))?;
    let target_wa_id = target_message.whatsapp_message_id.clone().ok_or_else(|| {
        AppError::BadRequest("Target message is not available for reactions yet".to_string())
    })?;
    let (connection_id, phone) =
        parse_conversation_identifier(&conversation.customer_identifier)
            .ok_or_else(|| AppError::BadRequest("Invalid conversation identifier".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let _ = send_reaction_message(
        &connection.phone_number_id,
        &access_token,
        &phone,
        &target_wa_id,
        if remove { "" } else { &emoji },
    )
    .await?;
    message_domain::upsert_reaction(
        pool,
        &target_message.id,
        &format!("workspace:{}", connection.id),
        if remove { None } else { Some(emoji.as_str()) },
        !remove,
        None,
        json!({
            "provider": "whatsapp",
            "targetProviderMessageId": target_wa_id,
            "source": "workspace",
        }),
    )
    .await?;
    message_domain::record_event(
        pool,
        &conversation.id,
        Some(&target_message.id),
        None,
        if remove {
            "REACTION_REMOVED"
        } else {
            "REACTION_ADDED"
        },
        json!({ "provider": "whatsapp", "emoji": if remove { "" } else { &emoji } }),
    )
    .await?;
    Ok(json!({ "success": true }))
}

pub async fn delete_conversation_message(
    pool: &PgPool,
    org_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, org_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let result = sqlx::query(r#"DELETE FROM "Message" WHERE id = $1 AND "conversationId" = $2"#)
        .bind(message_id)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Message not found".to_string()));
    }
    if let Some(last_timestamp) = sqlx::query_scalar::<_, chrono::DateTime<Utc>>(
        r#"SELECT timestamp AT TIME ZONE 'UTC' FROM "Message" WHERE "conversationId" = $1 ORDER BY timestamp DESC LIMIT 1"#
    )
    .bind(&conversation.id)
    .fetch_optional(pool)
    .await? {
        sqlx::query(r#"UPDATE "Conversation" SET "lastMessageAt" = $1, "updatedAt" = NOW() WHERE id = $2"#)
            .bind(last_timestamp)
            .bind(&conversation.id)
            .execute(pool)
            .await?;
    }
    Ok(json!({ "success": true }))
}

pub async fn download_message_attachment(
    pool: &PgPool,
    org_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<actix_web::HttpResponse, AppError> {
    let connection_ids = org_connection_ids(pool, org_id).await?;
    if connection_ids.is_empty() {
        return Err(AppError::NotFound("Media message not found".to_string()));
    }
    let attachment = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>)>(
        r#"
        SELECT m."conversationId", attachment."providerMediaId", attachment."mimeType", attachment."fileName"
        FROM "Message" m
        JOIN "MessageAttachment" attachment ON attachment."messageId" = m.id
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE m.id = $1
          AND attachment.id = $2
          AND c.channel = 'whatsapp'
          AND EXISTS (
            SELECT 1 FROM unnest($3::text[]) AS connection_id
            WHERE c."customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        LIMIT 1
        "#
    )
    .bind(message_id)
    .bind(attachment_id)
    .bind(&connection_ids)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Media message not found".to_string()))?;
    let (message_conversation_id, media_id, mime_type, attachment_filename) = attachment;
    let media_id = media_id.ok_or_else(|| {
        AppError::BadRequest("Message attachment is not available from WhatsApp".to_string())
    })?;
    let conversation_identifier = sqlx::query_scalar::<_, String>(
        r#"SELECT "customerIdentifier" FROM "Conversation" WHERE id = $1"#,
    )
    .bind(&message_conversation_id)
    .fetch_one(pool)
    .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (bytes, content_type) = download_media_bytes(&access_token, &media_id).await?;
    let extension = mime_type
        .as_deref()
        .and_then(|v| v.split('/').nth(1))
        .unwrap_or("bin");
    let fallback_name = format!("whatsapp-media-{}.{}", message_id, extension);
    let filename = sanitize_filename(attachment_filename.as_deref().unwrap_or(&fallback_name));
    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", content_type))
        .append_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}
