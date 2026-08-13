use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration as StdDuration;

use crate::db::models::{
    ConversationRow, MessageRow, WhatsappAudienceFilterRequest, WhatsappContactRow,
    WhatsappListContactRow,
};
use crate::error::AppError;
use crate::services::realtime;
use crate::services::{customers, message_domain};

pub(crate) const GRAPH_BASE: &str = "https://graph.facebook.com/v19.0";

pub use super::whatsapp_campaigns::{
    cancel_campaign, create_campaign, delete_campaign, get_campaign, get_campaign_summary,
    launch_campaign, list_campaigns, pause_campaign, process_queued_campaign_recipients,
    recompute_campaign_stats, repair_campaign_status, resume_campaign, retry_failed_campaign,
    send_more_campaign,
};
pub(crate) use super::whatsapp_campaigns::{get_campaign_row, send_marketing_template};
pub use super::whatsapp_connections::{
    complete_embedded_signup, connect_manual_connection, connection_health, list_connections,
    refresh_connection, update_connection_access_token,
};
pub(crate) use super::whatsapp_connections::{get_connection_row_for_org, select_connection_sql};
pub use super::whatsapp_contacts::{
    delete_contact_list, export_contact_list, import_contacts, list_contacts, rename_contact_list,
    update_contact,
};
pub use super::whatsapp_inbox::{
    delete_conversation, delete_conversation_message, deliver_agent_message,
    download_message_attachment, inbox_unread_count, list_conversation_messages,
    list_inbox_conversations, mark_conversation_read, process_queued_inbox_messages,
    send_conversation_media, send_conversation_message, send_message_reaction,
    start_inbox_conversation, update_conversation,
};
pub use super::whatsapp_templates::{create_template, list_templates, sync_connection_templates};
pub use super::whatsapp_webhooks::process_webhook_payload;

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
pub(crate) struct PendingInboxMessageRow {
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

pub(crate) fn campaign_processing_timeout() -> ChronoDuration {
    ChronoDuration::seconds(
        std::env::var("WHATSAPP_CAMPAIGN_PROCESSING_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(120),
    )
}

pub(crate) fn whatsapp_http_client() -> Result<reqwest::Client, AppError> {
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

pub(crate) fn parse_scheduled_at(
    value: Option<String>,
) -> Result<Option<chrono::DateTime<Utc>>, AppError> {
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

pub(crate) fn marketing_cooldown_days() -> i64 {
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

pub(crate) fn metadata_string(metadata: &Option<Value>, key: &str) -> String {
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

pub(crate) fn contact_eligible(contact: &WhatsappContactRow) -> (&'static str, bool) {
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

pub(crate) fn contact_matches_audience(
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

fn build_conversation_identifier(connection_id: &str, phone: &str) -> String {
    format!("wa:{connection_id}:{phone}")
}

pub(crate) fn parse_conversation_identifier(identifier: &str) -> Option<(String, String)> {
    let parts: Vec<_> = identifier.split(':').collect();
    if parts.len() < 3 || parts[0] != "wa" {
        return None;
    }
    Some((parts[1].to_string(), parts[2..].join(":")))
}

pub(crate) async fn find_or_create_conversation(
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

pub(crate) async fn select_campaign_contact_row(
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

pub(crate) async fn org_connection_ids(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<String>, AppError> {
    sqlx::query_scalar::<_, String>(r#"SELECT id FROM "WhatsappConnection" WHERE "orgId" = $1"#)
        .bind(org_id)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

pub(crate) async fn scoped_conversation(
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

pub(crate) async fn load_conversation_by_id(
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

pub(crate) async fn load_message_by_id(
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

pub(crate) async fn publish_campaign_updated(
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

pub(crate) async fn publish_conversation_updated(
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

pub(crate) async fn publish_message_created(
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

pub(crate) async fn publish_message_updated(
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

pub(crate) async fn publish_message_send_failed(
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

pub(crate) fn display_text(content: &str) -> String {
    content.to_string()
}

pub(crate) fn preview_text(content: &str, max: usize) -> String {
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

pub(crate) fn media_kind_from_upload(
    filename: Option<&str>,
    mime_type: Option<&str>,
) -> &'static str {
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

pub(crate) async fn send_text_message(
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
