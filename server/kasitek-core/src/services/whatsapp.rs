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
    WhatsappConnectionPublic, WhatsappConnectionRow, WhatsappContactImportInvalidRow,
    WhatsappContactListQuery, WhatsappContactListRenameRequest, WhatsappContactRow,
    WhatsappContactUpdateRequest, WhatsappListContactRow, WhatsappReactionRequest,
    WhatsappSendMessageRequest, WhatsappStartConversationRequest, WhatsappTemplateListQuery,
    WhatsappTemplateRow,
};
use crate::error::AppError;
use crate::services::billing;
use crate::services::push::{send_push_notification_to_user, PushNotificationPayload};
use crate::services::realtime;
use crate::services::social::{decrypt_social_secret, encrypt_social_secret};
use crate::services::whatsapp_calls;

const GRAPH_BASE: &str = "https://graph.facebook.com/v19.0";

async fn forward_call_webhook_to_calls_service(
    config: &AppConfig,
    value: &Value,
) -> Result<bool, AppError> {
    let Some(base_url) = config
        .kasitek_calls_url
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    else {
        return Ok(false);
    };

    let has_calls = value
        .get("calls")
        .and_then(|payload| payload.as_array())
        .map(|calls| !calls.is_empty())
        .unwrap_or(false);
    if !has_calls {
        return Ok(false);
    }

    reqwest::Client::new()
        .post(format!(
            "{}/api/webhooks/whatsapp/calls/provider",
            base_url.trim_end_matches('/')
        ))
        .json(value)
        .send()
        .await?
        .error_for_status()?;

    Ok(true)
}

#[derive(serde::Deserialize)]
struct GraphErrorEnvelope {
    error: Option<GraphError>,
}

#[derive(serde::Deserialize)]
struct GraphError {
    message: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, serde::Deserialize)]
struct GraphPhoneNumber {
    id: String,
    display_phone_number: Option<String>,
    verified_name: Option<String>,
    quality_rating: Option<String>,
    code_verification_status: Option<String>,
    name_status: Option<String>,
    messaging_limit_tier: Option<String>,
}

#[derive(serde::Deserialize)]
struct GraphTemplatesResponse {
    data: Option<Vec<GraphTemplate>>,
}

#[derive(Clone, serde::Deserialize)]
struct GraphTemplate {
    name: Option<String>,
    language: Option<String>,
    status: Option<String>,
    category: Option<String>,
    components: Option<Vec<GraphTemplateComponent>>,
}

#[derive(Clone, serde::Deserialize)]
struct GraphTemplateComponent {
    #[serde(rename = "type")]
    component_type: Option<String>,
    text: Option<String>,
    buttons: Option<Vec<Value>>,
}

#[derive(serde::Deserialize)]
struct GraphSubscribedApps {
    data: Option<Vec<GraphApp>>,
}

#[derive(serde::Deserialize)]
struct GraphApp {
    id: Option<String>,
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

fn map_quality_rating(value: Option<&str>) -> String {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "GREEN" => "GREEN".to_string(),
        Some(value) if value == "YELLOW" => "YELLOW".to_string(),
        Some(value) if value == "RED" => "RED".to_string(),
        _ => "UNKNOWN".to_string(),
    }
}

fn estimate_daily_limit_from_tier(value: Option<&str>) -> Option<i32> {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "TIER_1" => Some(1000),
        Some(value) if value == "TIER_2" => Some(10_000),
        Some(value) if value == "TIER_3" => Some(100_000),
        Some(value) if value == "TIER_4" => Some(1_000_000),
        _ => None,
    }
}

fn default_daily_limit() -> i32 {
    std::env::var("WHATSAPP_DEFAULT_DAILY_LIMIT")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(250)
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

fn map_template_status(value: Option<&str>) -> String {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "APPROVED" => "APPROVED".to_string(),
        Some(value) if value == "PENDING" => "PENDING".to_string(),
        Some(value) if value == "REJECTED" => "REJECTED".to_string(),
        _ => "DISABLED".to_string(),
    }
}

fn map_template_category(value: Option<&str>) -> Option<String> {
    match value.map(|v| v.to_uppercase()) {
        Some(value) if value == "MARKETING" => Some("MARKETING".to_string()),
        Some(value) if value == "UTILITY" => Some("UTILITY".to_string()),
        Some(value) if value == "AUTHENTICATION" => Some("AUTHENTICATION".to_string()),
        _ => None,
    }
}

fn connection_label(phone: &GraphPhoneNumber, manual: Option<&str>) -> Option<String> {
    manual
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| phone.verified_name.clone())
        .or_else(|| phone.display_phone_number.clone())
}

fn variables_count(body: Option<&str>) -> i32 {
    body.map(|value| {
        value
            .match_indices("{{")
            .filter(|(index, _)| value[*index..].contains("}}"))
            .count() as i32
    })
    .unwrap_or(0)
}

async fn fetch_graph_json<T: serde::de::DeserializeOwned>(
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

async fn fetch_connection_phone(
    access_token: &str,
    phone_number_id: &str,
) -> Result<GraphPhoneNumber, AppError> {
    let url = format!(
        "{GRAPH_BASE}/{phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token={}",
        urlencoding::encode(access_token)
    );
    fetch_graph_json(&url, reqwest::Client::new().get(&url)).await
}

async fn subscribe_waba_webhook(access_token: &str, waba_id: &str) -> Result<(), AppError> {
    let url = format!("{GRAPH_BASE}/{waba_id}/subscribed_apps");
    let _: Value = fetch_graph_json(
        &url,
        reqwest::Client::new().post(&url).json(&json!({
            "subscribed_fields": [
                "calls",
                "messages",
                "message_template_status_update",
                "message_template_quality_update",
                "message_template_components_update"
            ],
            "access_token": access_token
        })),
    )
    .await?;
    Ok(())
}

async fn exchange_code_for_access_token(code: &str) -> Result<String, AppError> {
    let client_id = std::env::var("AUTH_META_APP_ID")
        .map_err(|_| AppError::Internal("AUTH_META_APP_ID is required".to_string()))?;
    let client_secret = std::env::var("AUTH_META_APP_SECRET")
        .map_err(|_| AppError::Internal("AUTH_META_APP_SECRET is required".to_string()))?;
    let short_url = format!(
        "{GRAPH_BASE}/oauth/access_token?client_id={}&client_secret={}&code={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
        urlencoding::encode(code)
    );
    let short: Value = fetch_graph_json(&short_url, reqwest::Client::new().get(&short_url)).await?;
    let first_token = short
        .get("access_token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            AppError::Internal("Meta OAuth exchange did not return an access token".to_string())
        })?;
    let long_url = format!(
        "{GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id={}&client_secret={}&fb_exchange_token={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
        urlencoding::encode(first_token)
    );
    let long: Result<Value, AppError> =
        fetch_graph_json(&long_url, reqwest::Client::new().get(&long_url)).await;
    Ok(long
        .ok()
        .and_then(|value| {
            value
                .get("access_token")
                .and_then(|token| token.as_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| first_token.to_string()))
}

async fn resolve_waba_id(
    access_token: &str,
    preferred_waba_id: Option<&str>,
) -> Result<String, AppError> {
    if let Some(waba_id) = preferred_waba_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(waba_id.to_string());
    }
    let url = format!(
        "{GRAPH_BASE}/me/businesses?fields=id,owned_whatsapp_business_accounts{{id}},client_whatsapp_business_accounts{{id}}&access_token={}",
        urlencoding::encode(access_token)
    );
    let payload: Value = fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let businesses = payload
        .get("data")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let resolved = businesses.iter().find_map(|business| {
        business
            .get("owned_whatsapp_business_accounts")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
            .or_else(|| {
                business
                    .get("client_whatsapp_business_accounts")
                    .and_then(|value| value.as_array())
                    .and_then(|items| items.first())
                    .and_then(|value| value.get("id"))
                    .and_then(|value| value.as_str())
            })
    });
    resolved.map(ToString::to_string).ok_or_else(|| {
        AppError::BadRequest("No WhatsApp Business Account found for this Meta account".to_string())
    })
}

async fn resolve_phone_number(
    access_token: &str,
    waba_id: &str,
    preferred_phone_number_id: Option<&str>,
) -> Result<GraphPhoneNumber, AppError> {
    let url = format!(
        "{GRAPH_BASE}/{waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token={}",
        urlencoding::encode(access_token)
    );
    let payload: Value = fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let phones = payload
        .get("data")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if phones.is_empty() {
        return Err(AppError::BadRequest(
            "No phone numbers found under the selected WhatsApp Business Account".to_string(),
        ));
    }
    if let Some(preferred) = preferred_phone_number_id {
        if let Some(exact) = phones
            .iter()
            .find(|phone| phone.get("id").and_then(|value| value.as_str()) == Some(preferred))
        {
            return serde_json::from_value(exact.clone())
                .map_err(|_| AppError::Internal("Failed to decode phone number".to_string()));
        }
    }
    serde_json::from_value(phones[0].clone())
        .map_err(|_| AppError::Internal("Failed to decode phone number".to_string()))
}

fn select_connection_sql() -> &'static str {
    r#"
    SELECT id, "userId" AS user_id, "orgId" AS org_id, "phoneNumberId" AS phone_number_id,
           "phoneDisplayNumber" AS phone_display_number, "accessTokenEncrypted" AS access_token_encrypted,
           "wabaId" AS waba_id, "currentQualityRating"::text AS current_quality_rating,
           "dailyLimitEstimate" AS daily_limit_estimate, verified,
           "createdAt" AT TIME ZONE 'UTC' AS created_at,
           "updatedAt" AT TIME ZONE 'UTC' AS updated_at
    FROM "WhatsappConnection"
    "#
}

pub async fn list_connections(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<WhatsappConnectionPublic>, AppError> {
    let sql = format!(
        "{} WHERE \"orgId\" = $1 ORDER BY \"createdAt\" DESC",
        select_connection_sql()
    );
    let rows = sqlx::query_as::<_, WhatsappConnectionRow>(&sql)
        .bind(org_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[derive(Debug, Clone)]
pub struct WhatsappProvisioningConnection {
    pub id: String,
    pub phone_number_id: String,
    pub phone_display_number: Option<String>,
    pub access_token: String,
    pub waba_id: String,
}

async fn get_connection_row_for_org(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Option<WhatsappConnectionRow>, AppError> {
    let sql = format!(
        "{} WHERE id = $1 AND \"orgId\" = $2 LIMIT 1",
        select_connection_sql()
    );
    sqlx::query_as::<_, WhatsappConnectionRow>(&sql)
        .bind(connection_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn get_connection_for_provisioning(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Option<WhatsappProvisioningConnection>, AppError> {
    let sql = format!(
        "{} WHERE id = $1 AND \"orgId\" = $2 LIMIT 1",
        select_connection_sql()
    );
    let row = sqlx::query_as::<_, WhatsappConnectionRow>(&sql)
        .bind(connection_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?;
    row.map(|row| {
        Ok(WhatsappProvisioningConnection {
            id: row.id,
            phone_number_id: row.phone_number_id,
            phone_display_number: row.phone_display_number,
            access_token: decrypt_social_secret(&row.access_token_encrypted)?,
            waba_id: row.waba_id,
        })
    })
    .transpose()
}

pub async fn connect_manual_connection(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    waba_id: &str,
    phone_number_id: &str,
    access_token: &str,
    phone_display_number: Option<&str>,
) -> Result<Value, AppError> {
    if waba_id.trim().is_empty()
        || phone_number_id.trim().is_empty()
        || access_token.trim().is_empty()
    {
        return Err(AppError::BadRequest(
            "WABA ID, phone number ID, and access token are required".to_string(),
        ));
    }

    let phone = fetch_connection_phone(access_token, phone_number_id).await?;
    let existing_other = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT "orgId" FROM "WhatsappConnection" WHERE "phoneNumberId" = $1 LIMIT 1"#,
    )
    .bind(phone_number_id)
    .fetch_optional(pool)
    .await?;
    if existing_other
        .flatten()
        .as_deref()
        .is_some_and(|owner| owner != org_id)
    {
        return Err(AppError::Conflict(
            "This WhatsApp number is already connected to another account".to_string(),
        ));
    }

    let encrypted = encrypt_social_secret(access_token)?;
    let connection_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "WhatsappConnection" (
            id, "userId", "orgId", "phoneNumberId", "phoneDisplayNumber", "accessTokenEncrypted",
            "wabaId", "currentQualityRating", "dailyLimitEstimate", verified, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, CAST($8 AS "WhatsappConnectionQualityRating"), $9, $10, NOW(), NOW()
        )
        ON CONFLICT ("phoneNumberId")
        DO UPDATE SET
            "userId" = EXCLUDED."userId",
            "orgId" = EXCLUDED."orgId",
            "phoneDisplayNumber" = EXCLUDED."phoneDisplayNumber",
            "accessTokenEncrypted" = EXCLUDED."accessTokenEncrypted",
            "wabaId" = EXCLUDED."wabaId",
            "currentQualityRating" = EXCLUDED."currentQualityRating",
            "dailyLimitEstimate" = EXCLUDED."dailyLimitEstimate",
            verified = EXCLUDED.verified,
            "updatedAt" = NOW()
        "#,
    )
    .bind(&connection_id)
    .bind(user_id)
    .bind(org_id)
    .bind(phone_number_id)
    .bind(connection_label(&phone, phone_display_number))
    .bind(encrypted)
    .bind(waba_id.trim())
    .bind(map_quality_rating(phone.quality_rating.as_deref()))
    .bind(estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref()).unwrap_or(default_daily_limit()))
    .bind(
        phone.code_verification_status.as_deref() == Some("VERIFIED")
            || phone.name_status.as_deref() == Some("APPROVED"),
    )
    .execute(pool)
    .await?;

    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!(
        "{} WHERE \"orgId\" = $1 AND \"phoneNumberId\" = $2 LIMIT 1",
        select_connection_sql()
    ))
    .bind(org_id)
    .bind(phone_number_id)
    .fetch_one(pool)
    .await?;

    let webhook_result = subscribe_waba_webhook(access_token, waba_id).await.err();
    let template_sync = sync_connection_templates(pool, user_id, org_id, &connection.id)
        .await
        .ok();

    Ok(json!({
        "connection": WhatsappConnectionPublic::from(connection),
        "webhookSubscribed": webhook_result.is_none(),
        "webhookError": webhook_result.map(|err| err.to_string()),
        "templateSync": template_sync.unwrap_or(json!({
            "attempted": true,
            "success": false
        }))
    }))
}

pub async fn complete_embedded_signup(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    code: &str,
    waba_id: Option<&str>,
    phone_number_id: Option<&str>,
) -> Result<Value, AppError> {
    let mut diagnostics = Vec::new();
    let access_token = exchange_code_for_access_token(code).await?;
    diagnostics.push(json!({
        "step": "exchange_code",
        "ok": true,
        "detail": "Authorization code exchanged for access token."
    }));
    let resolved_waba_id = resolve_waba_id(&access_token, waba_id).await?;
    diagnostics.push(json!({
        "step": "resolve_waba",
        "ok": true,
        "detail": format!("Selected WABA: {}", resolved_waba_id)
    }));
    let phone = resolve_phone_number(&access_token, &resolved_waba_id, phone_number_id).await?;
    diagnostics.push(json!({
        "step": "resolve_phone",
        "ok": true,
        "detail": format!("Selected phone number id: {}", phone.id)
    }));

    let result = connect_manual_connection(
        pool,
        user_id,
        org_id,
        &resolved_waba_id,
        &phone.id,
        &access_token,
        phone.display_phone_number.as_deref(),
    )
    .await?;

    let mut merged = result;
    if let Some(object) = merged.as_object_mut() {
        object.insert("diagnostics".to_string(), Value::Array(diagnostics));
    }
    Ok(merged)
}

pub async fn sync_connection_templates(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    connection_id: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let url = format!(
        "{GRAPH_BASE}/{}/message_templates?fields=name,language,status,category,components&limit=250&access_token={}",
        connection.waba_id,
        urlencoding::encode(&access_token)
    );
    let response: GraphTemplatesResponse =
        fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let fetched = response.data.as_ref().map(|items| items.len()).unwrap_or(0);
    let templates = response.data.unwrap_or_default();
    let mut synced = 0;

    for template in templates.iter() {
        let Some(category) = map_template_category(template.category.as_deref()) else {
            continue;
        };
        let Some(template_name) = template.name.as_ref() else {
            continue;
        };
        let Some(language) = template.language.as_ref() else {
            continue;
        };
        let header = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("HEADER"))
            })
            .and_then(|part| part.text.clone());
        let body = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("BODY"))
            })
            .and_then(|part| part.text.clone());
        let footer = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("FOOTER"))
            })
            .and_then(|part| part.text.clone());
        let buttons = template
            .components
            .as_ref()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part.component_type.as_deref() == Some("BUTTONS"))
            })
            .and_then(|part| part.buttons.clone());

        sqlx::query(
            r#"
            INSERT INTO "WhatsappTemplate" (
                id, "userId", "orgId", "connectionId", "templateName", language, category, header, body, footer,
                buttons, "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, CAST($7 AS "WhatsappTemplateCategory"), $8, $9, $10,
                $11, $12, CAST($13 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
            )
            ON CONFLICT ("orgId", "templateName", language)
            DO UPDATE SET
                "connectionId" = EXCLUDED."connectionId",
                category = EXCLUDED.category,
                header = EXCLUDED.header,
                body = EXCLUDED.body,
                footer = EXCLUDED.footer,
                buttons = EXCLUDED.buttons,
                "variablesCount" = EXCLUDED."variablesCount",
                status = EXCLUDED.status,
                "lastSynced" = NOW(),
                "updatedAt" = NOW()
            "#,
        )
        .bind(cuid2::create_id())
        .bind(user_id)
        .bind(org_id)
        .bind(&connection.id)
        .bind(template_name)
        .bind(language)
        .bind(category)
        .bind(&header)
        .bind(&body)
        .bind(&footer)
        .bind(buttons.map(Value::Array))
        .bind(variables_count(body.as_deref()))
        .bind(map_template_status(template.status.as_deref()))
        .execute(pool)
        .await?;

        synced += 1;
    }

    Ok(json!({
        "connectionId": connection.id,
        "fetched": fetched,
        "synced": synced
    }))
}

pub async fn refresh_connection(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let phone = fetch_connection_phone(&access_token, &connection.phone_number_id).await?;

    sqlx::query(
        r#"
        UPDATE "WhatsappConnection"
        SET "phoneDisplayNumber" = $1,
            "currentQualityRating" = CAST($2 AS "WhatsappConnectionQualityRating"),
            verified = $3,
            "dailyLimitEstimate" = $4,
            "updatedAt" = NOW()
        WHERE id = $5
        "#,
    )
    .bind(connection_label(&phone, None))
    .bind(map_quality_rating(phone.quality_rating.as_deref()))
    .bind(
        phone.code_verification_status.as_deref() == Some("VERIFIED")
            || phone.name_status.as_deref() == Some("APPROVED"),
    )
    .bind(
        estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref())
            .unwrap_or(default_daily_limit()),
    )
    .bind(connection_id)
    .execute(pool)
    .await?;

    let refreshed = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    Ok(json!({
        "connection": WhatsappConnectionPublic::from(refreshed),
        "messagingLimitTier": phone.messaging_limit_tier
    }))
}

pub async fn update_connection_access_token(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
    access_token: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    if access_token.trim().is_empty() {
        return Err(AppError::BadRequest("Access token is required".to_string()));
    }
    let phone = fetch_connection_phone(access_token, &connection.phone_number_id).await?;
    let encrypted = encrypt_social_secret(access_token)?;

    sqlx::query(
        r#"
        UPDATE "WhatsappConnection"
        SET "accessTokenEncrypted" = $1,
            "phoneDisplayNumber" = $2,
            "currentQualityRating" = CAST($3 AS "WhatsappConnectionQualityRating"),
            verified = $4,
            "dailyLimitEstimate" = $5,
            "updatedAt" = NOW()
        WHERE id = $6
        "#,
    )
    .bind(encrypted)
    .bind(connection_label(
        &phone,
        connection.phone_display_number.as_deref(),
    ))
    .bind(map_quality_rating(phone.quality_rating.as_deref()))
    .bind(
        phone.code_verification_status.as_deref() == Some("VERIFIED")
            || phone.name_status.as_deref() == Some("APPROVED"),
    )
    .bind(
        estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref())
            .unwrap_or(default_daily_limit()),
    )
    .bind(connection_id)
    .execute(pool)
    .await?;

    let updated = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    let webhook_error = subscribe_waba_webhook(access_token, &updated.waba_id)
        .await
        .err();

    Ok(json!({
        "connection": WhatsappConnectionPublic::from(updated),
        "webhookSubscribed": webhook_error.is_none(),
        "webhookError": webhook_error.map(|error| error.to_string())
    }))
}

pub async fn connection_health(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let mut token_valid = false;
    let mut webhook_subscribed = false;
    let mut steps = Vec::new();
    let mut quality_rating = connection.current_quality_rating.clone();

    match fetch_connection_phone(&token, &connection.phone_number_id).await {
        Ok(phone) => {
            token_valid = true;
            quality_rating = map_quality_rating(phone.quality_rating.as_deref());
            steps.push(json!({
                "step": "token_validation",
                "ok": true,
                "detail": "Access token can query phone number details."
            }));
        }
        Err(error) => {
            steps.push(json!({
                "step": "token_validation",
                "ok": false,
                "detail": error.to_string()
            }));
        }
    }

    if token_valid {
        let url = format!(
            "{GRAPH_BASE}/{}/subscribed_apps?access_token={}",
            connection.waba_id,
            urlencoding::encode(&token)
        );
        match fetch_graph_json::<GraphSubscribedApps>(&url, reqwest::Client::new().get(&url)).await
        {
            Ok(apps) => {
                let app_id = std::env::var("AUTH_META_APP_ID")
                    .ok()
                    .or_else(|| std::env::var("NEXT_PUBLIC_META_APP_ID").ok());
                webhook_subscribed = apps.data.unwrap_or_default().iter().any(|app| {
                    app_id
                        .as_ref()
                        .map(|id| app.id.as_deref() == Some(id.as_str()))
                        .unwrap_or(true)
                });
                steps.push(json!({
                    "step": "webhook_subscription",
                    "ok": webhook_subscribed,
                    "detail": if webhook_subscribed {
                        "WABA is subscribed to this app for webhooks."
                    } else {
                        "WABA is not subscribed to this app. Reconnect or resubscribe."
                    }
                }));
            }
            Err(error) => {
                steps.push(json!({
                    "step": "webhook_subscription",
                    "ok": false,
                    "detail": error.to_string()
                }));
            }
        }
    }

    Ok(json!({
        "connection": {
            "id": connection.id,
            "wabaId": connection.waba_id,
            "phoneNumberId": connection.phone_number_id,
            "phoneDisplayNumber": connection.phone_display_number,
            "qualityRating": quality_rating,
            "verified": connection.verified,
            "dailyLimitEstimate": connection.daily_limit_estimate,
            "updatedAt": connection.updated_at,
        },
        "tokenValid": token_valid,
        "webhookSubscribed": webhook_subscribed,
        "healthy": token_valid && webhook_subscribed,
        "steps": steps
    }))
}

pub async fn create_template(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    connection_id: &str,
    template_name: &str,
    language: &str,
    category: &str,
    header: Option<&str>,
    body: &str,
    footer: Option<&str>,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    if template_name.trim().is_empty() || language.trim().is_empty() || body.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Template name, language, and body are required".to_string(),
        ));
    }
    let normalized_name = template_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let category = map_template_category(Some(category))
        .ok_or_else(|| AppError::BadRequest("Invalid template category".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;

    let components = json!([
        if header
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            json!({
                "type": "HEADER",
                "format": "TEXT",
                "text": header.unwrap().trim()
            })
        } else {
            Value::Null
        },
        json!({
            "type": "BODY",
            "text": body.trim()
        }),
        if footer
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            json!({
                "type": "FOOTER",
                "text": footer.unwrap().trim()
            })
        } else {
            Value::Null
        }
    ]);
    let filtered_components = Value::Array(
        components
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|value| !value.is_null())
            .collect(),
    );

    let url = format!("{GRAPH_BASE}/{}/message_templates", connection.waba_id);
    let response: Value = fetch_graph_json(
        &url,
        reqwest::Client::new()
            .post(&url)
            .bearer_auth(access_token)
            .json(&json!({
                "name": normalized_name,
                "category": category,
                "language": language.trim(),
                "components": filtered_components
            })),
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "WhatsappTemplate" (
            id, "userId", "orgId", "connectionId", "templateName", language, category, header, body, footer,
            "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, CAST($7 AS "WhatsappTemplateCategory"), $8, $9, $10,
            $11, CAST($12 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", "templateName", language)
        DO UPDATE SET
            "connectionId" = EXCLUDED."connectionId",
            category = EXCLUDED.category,
            header = EXCLUDED.header,
            body = EXCLUDED.body,
            footer = EXCLUDED.footer,
            "variablesCount" = EXCLUDED."variablesCount",
            status = EXCLUDED.status,
            "lastSynced" = NOW(),
            "updatedAt" = NOW()
        "#,
    )
    .bind(cuid2::create_id())
    .bind(user_id)
    .bind(org_id)
    .bind(connection_id)
    .bind(&normalized_name)
    .bind(language.trim())
    .bind(&category)
    .bind(
        header
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(body.trim())
    .bind(
        footer
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(variables_count(Some(body.trim())))
    .bind(map_template_status(
        response.get("status").and_then(|value| value.as_str()),
    ))
    .execute(pool)
    .await?;

    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AT TIME ZONE 'UTC' AS last_synced, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappTemplate"
        WHERE "orgId" = $1 AND "templateName" = $2 AND language = $3
        LIMIT 1
        "#,
    )
    .bind(org_id)
    .bind(&normalized_name)
    .bind(language.trim())
    .fetch_one(pool)
    .await?;

    Ok(json!({
        "template": template,
        "metaTemplateId": response.get("id").and_then(|value| value.as_str()),
        "status": response.get("status").and_then(|value| value.as_str()).unwrap_or("PENDING")
    }))
}

pub async fn list_templates(
    pool: &PgPool,
    org_id: &str,
    query: WhatsappTemplateListQuery,
) -> Result<Value, AppError> {
    let requested_status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_uppercase);

    let templates = sqlx::query(
        r#"
        SELECT
            t.id,
            t."templateName" AS template_name,
            t.language,
            t.category::text AS category,
            t.status::text AS status,
            t."variablesCount" AS variables_count,
            t.header,
            t.body,
            t.footer,
            t.buttons,
            t."lastSynced" AT TIME ZONE 'UTC' AS last_synced,
            t."connectionId" AS connection_id,
            COALESCE(c."phoneDisplayNumber", c."phoneNumberId") AS connection_label
        FROM "WhatsappTemplate" t
        LEFT JOIN "WhatsappConnection" c ON c.id = t."connectionId"
        WHERE t."orgId" = $1
          AND ($2::text IS NULL OR t.status::text = $2)
        ORDER BY t."updatedAt" DESC
        "#,
    )
    .bind(org_id)
    .bind(requested_status)
    .fetch_all(pool)
    .await?;

    let templates = templates
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "templateName": row.get::<String, _>("template_name"),
                "language": row.get::<String, _>("language"),
                "category": row.get::<String, _>("category"),
                "status": row.get::<String, _>("status"),
                "variablesCount": row.get::<i32, _>("variables_count"),
                "header": row.get::<Option<String>, _>("header"),
                "body": row.get::<Option<String>, _>("body"),
                "footer": row.get::<Option<String>, _>("footer"),
                "buttons": row.get::<Option<Value>, _>("buttons"),
                "lastSynced": row.get::<Option<chrono::DateTime<Utc>>, _>("last_synced"),
                "connectionId": row.get::<Option<String>, _>("connection_id"),
                "connectionLabel": row.get::<Option<String>, _>("connection_label").unwrap_or_else(|| "-".to_string()),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "templates": templates }))
}

pub async fn list_contacts(
    pool: &PgPool,
    org_id: &str,
    query: WhatsappContactListQuery,
) -> Result<Value, AppError> {
    let requested_limit = query.limit.unwrap_or(500);
    let normalized_limit = requested_limit.clamp(1, 10_000);

    let contacts = sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
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
        WHERE m."orgId" = $1
          AND (
            COALESCE($2, '') = ''
            OR COALESCE(m."fullName", c."fullName", '') ILIKE ('%' || $2 || '%')
            OR c.phone ILIKE ('%' || $2 || '%')
            OR COALESCE(m.location, c.location, '') ILIKE ('%' || $2 || '%')
            OR EXISTS (
              SELECT 1
              FROM unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_value
              WHERE tag_value ILIKE $2
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_each_text(COALESCE(m.metadata, '{}'::jsonb)) AS metadata_entry
              WHERE metadata_entry.value ILIKE ('%' || $2 || '%')
            )
          )
          AND (
            COALESCE($3, 'all') = 'all'
            OR (m."optIn" = true AND $3 = 'true')
            OR (m."optIn" = false AND $3 = 'false')
          )
          AND (
            COALESCE($4, 'all') = 'all'
            OR (m.excluded = true AND $4 = 'true')
            OR (m.excluded = false AND $4 = 'false')
          )
          AND (
            COALESCE($5, '') = ''
            OR EXISTS (
              SELECT 1
              FROM unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_filter
              WHERE tag_filter = $5
            )
          )
          AND (
            COALESCE($6, '') = ''
            OR COALESCE(m.location, c.location, '') ILIKE ('%' || $6 || '%')
          )
          AND (
            COALESCE($7, '') = ''
            OR m."listLabel" = $7
          )
        ORDER BY m."createdAt" DESC
        LIMIT $8
        "#,
    )
    .bind(org_id)
    .bind(
        query
            .q
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(query.opt_in.as_deref())
    .bind(query.excluded.as_deref())
    .bind(
        query
            .tag
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        query
            .location
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        query
            .list_label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(normalized_limit)
    .fetch_all(pool)
    .await?;

    let (total_contacts, opted_in_contacts, excluded_contacts, tag_rows, list_rows) = tokio::try_join!(
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "WhatsappContact" WHERE "orgId" = $1"#)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(DISTINCT "contactId") FROM "WhatsappContactListMembership" WHERE "orgId" = $1 AND "optIn" = true"#,
        )
        .bind(org_id)
        .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(DISTINCT "contactId") FROM "WhatsappContactListMembership" WHERE "orgId" = $1 AND excluded = true"#,
        )
        .bind(org_id)
        .fetch_one(pool),
        sqlx::query_scalar::<_, Vec<String>>(r#"SELECT COALESCE(tags, ARRAY[]::text[]) FROM "WhatsappContactListMembership" WHERE "orgId" = $1"#)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(
            r#"
            SELECT
                "listLabel" AS list_label,
                COUNT(DISTINCT "contactId")::bigint AS total_contacts,
                MIN(NULLIF(location, '')) AS primary_location,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT metadata_key), NULL) AS metadata_keys
            FROM "WhatsappContactListMembership"
            LEFT JOIN LATERAL jsonb_object_keys(COALESCE(metadata, '{}'::jsonb)) AS metadata_key ON TRUE
            WHERE "orgId" = $1
            GROUP BY "listLabel"
            ORDER BY "listLabel" ASC
            "#,
        )
        .bind(org_id)
        .fetch_all(pool),
    )?;

    let mut tag_options = tag_rows
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    tag_options.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));

    let lists = list_rows
        .into_iter()
        .map(|row| {
            let metadata_keys = row
                .get::<Option<Vec<Option<String>>>, _>("metadata_keys")
                .unwrap_or_default()
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            json!({
                "label": row.get::<String, _>("list_label"),
                "totalContacts": row.get::<i64, _>("total_contacts"),
                "primaryLocation": row.get::<Option<String>, _>("primary_location"),
                "metadataKeys": metadata_keys,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "contacts": contacts,
        "lists": lists,
        "tagOptions": tag_options,
        "stats": {
            "totalContacts": total_contacts,
            "optedInContacts": opted_in_contacts,
            "excludedContacts": excluded_contacts,
        }
    }))
}

pub async fn export_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
) -> Result<actix_web::HttpResponse, AppError> {
    let list_label = sanitize_list_label(Some(label));
    let contacts = sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
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
        WHERE m."orgId" = $1
          AND m."listLabel" = $2
        ORDER BY m."createdAt" ASC
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_all(pool)
    .await?;

    if contacts.is_empty() {
        return Err(AppError::NotFound("Contact list not found".to_string()));
    }

    let mut metadata_keys = contacts
        .iter()
        .flat_map(|contact| {
            contact
                .metadata
                .as_ref()
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|metadata| metadata.keys().cloned())
        })
        .collect::<Vec<_>>();
    metadata_keys.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    metadata_keys.dedup();

    let mut writer = csv::Writer::from_writer(Vec::new());
    let mut headers = vec![
        "phone".to_string(),
        "fullName".to_string(),
        "location".to_string(),
        "tags".to_string(),
        "notes".to_string(),
        "optIn".to_string(),
        "excluded".to_string(),
        "listLabel".to_string(),
    ];
    headers.extend(metadata_keys.iter().cloned());
    writer
        .write_record(&headers)
        .map_err(|_| AppError::Internal("Failed to build CSV export".to_string()))?;

    for contact in contacts {
        let metadata = contact.metadata.as_ref().and_then(Value::as_object);
        let mut row = vec![
            contact.phone,
            contact.full_name.unwrap_or_default(),
            contact.location.unwrap_or_default(),
            contact.tags.join(", "),
            contact.notes.unwrap_or_default(),
            contact.opt_in.to_string(),
            contact.excluded.to_string(),
            contact.list_label,
        ];
        row.extend(metadata_keys.iter().map(|key| {
            metadata
                .and_then(|values| values.get(key))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }));
        writer
            .write_record(&row)
            .map_err(|_| AppError::Internal("Failed to build CSV export".to_string()))?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|_| AppError::Internal("Failed to finalize CSV export".to_string()))?;
    let filename = sanitize_filename(&format!("{list_label}.csv"));

    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", "text/csv; charset=utf-8"))
        .append_header((
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}

pub async fn update_contact(
    pool: &PgPool,
    org_id: &str,
    contact_id: &str,
    input: WhatsappContactUpdateRequest,
) -> Result<Value, AppError> {
    let existing = select_list_contact_row(pool, org_id, contact_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Contact not found".to_string()))?;

    let normalized_phone = match input.phone.as_deref() {
        Some(phone) => {
            let normalized = normalize_phone(phone);
            if normalized.is_empty() {
                return Err(AppError::BadRequest(
                    "Invalid phone number format".to_string(),
                ));
            }
            Some(normalized)
        }
        None => None,
    };

    if let Some(phone) = normalized_phone.as_deref() {
        let duplicate = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM "WhatsappContact"
            WHERE "orgId" = $1 AND phone = $2 AND id <> $3
            LIMIT 1
            "#,
        )
        .bind(org_id)
        .bind(phone)
        .bind(&existing.contact_id)
        .fetch_optional(pool)
        .await?;
        if duplicate.is_some() {
            return Err(AppError::Conflict(
                "A contact with this phone already exists".to_string(),
            ));
        }
    }

    let tags = input.tags.as_ref().map(|value| sanitize_tags(value));
    let list_label = input
        .list_label
        .as_deref()
        .map(|value| sanitize_list_label(Some(value)));
    let opt_in = input.opt_in;
    let opt_in_source = if opt_in.is_some() {
        Some("dashboard".to_string())
    } else {
        existing.opt_in_source.clone()
    };
    let opt_in_date = match opt_in {
        Some(true) => existing.opt_in_date.or(Some(Utc::now())),
        Some(false) => None,
        None => existing.opt_in_date,
    };

    if let Some(phone) = normalized_phone {
        sqlx::query(
            r#"
            UPDATE "WhatsappContact"
            SET phone = $1, "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(phone)
        .bind(&existing.contact_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    if let Some(next_label) = list_label.as_deref() {
        let duplicate_membership = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM "WhatsappContactListMembership"
            WHERE "orgId" = $1
              AND "contactId" = $2
              AND "listLabel" = $3
              AND id <> $4
            LIMIT 1
            "#,
        )
        .bind(org_id)
        .bind(&existing.contact_id)
        .bind(next_label)
        .bind(contact_id)
        .fetch_optional(pool)
        .await?;
        if duplicate_membership.is_some() {
            return Err(AppError::Conflict(
                "This contact is already in that list".to_string(),
            ));
        }
    }

    sqlx::query(
        r#"
        UPDATE "WhatsappContactListMembership"
        SET "fullName" = COALESCE($1, "fullName"),
            location = COALESCE($2, location),
            tags = COALESCE($3, tags),
            notes = COALESCE($4, notes),
            "listLabel" = COALESCE($5, "listLabel"),
            metadata = COALESCE($6, metadata),
            "optIn" = COALESCE($7, "optIn"),
            "optInSource" = $8,
            "optInDate" = $9,
            excluded = COALESCE($10, excluded),
            "updatedAt" = NOW()
        WHERE id = $11 AND "orgId" = $12
        "#,
    )
    .bind(
        input
            .full_name
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(
        input
            .location
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(tags.as_ref())
    .bind(
        input
            .notes
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty()),
    )
    .bind(list_label)
    .bind(input.metadata.as_ref())
    .bind(opt_in)
    .bind(opt_in_source)
    .bind(opt_in_date)
    .bind(input.excluded)
    .bind(contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    let contact = select_list_contact_row(pool, org_id, contact_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload contact".to_string()))?;

    Ok(json!({ "contact": contact }))
}

pub async fn import_contacts(
    pool: &PgPool,
    user_id: &str,
    org_id: &str,
    mut payload: Multipart,
) -> Result<Value, AppError> {
    let mut csv_bytes = Vec::new();
    let mut default_opt_in = false;
    let mut requested_list_label: Option<String> = None;

    while let Some(field) = payload.next().await {
        let mut field = field
            .map_err(|_| AppError::BadRequest("Failed to read multipart payload".to_string()))?;
        let Some(name) = field.name() else { continue };
        let name = name.to_string();
        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk
                .map_err(|_| AppError::BadRequest("Failed to read multipart field".to_string()))?;
            bytes.extend_from_slice(&chunk);
        }
        if name == "file" {
            csv_bytes = bytes;
        } else if name == "defaultOptIn" {
            default_opt_in =
                parse_bool_like(std::str::from_utf8(&bytes).unwrap_or("")).unwrap_or(false);
        } else if name == "listLabel" {
            let raw = std::str::from_utf8(&bytes).unwrap_or("").trim().to_string();
            if !raw.is_empty() {
                requested_list_label = Some(raw);
            }
        }
    }

    if csv_bytes.is_empty() {
        return Err(AppError::BadRequest(
            "CSV file is required in form-data field: file".to_string(),
        ));
    }

    let csv_text = String::from_utf8(csv_bytes)
        .map_err(|_| AppError::BadRequest("CSV file must be valid UTF-8 text".to_string()))?;
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(csv_text.as_bytes());
    let headers = reader
        .headers()
        .map_err(|_| AppError::BadRequest("Failed to parse CSV headers".to_string()))?
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Err(AppError::BadRequest("CSV has no rows".to_string()));
    }

    let mut invalid_rows = Vec::new();
    let mut total_rows = 0usize;
    let mut deduped: HashMap<
        String,
        (
            Option<String>,
            Option<String>,
            Vec<String>,
            Option<String>,
            bool,
            Option<String>,
            Option<chrono::DateTime<Utc>>,
            String,
            Option<Value>,
        ),
    > = HashMap::new();
    let now = Utc::now();

    for (index, record) in reader.records().enumerate() {
        total_rows += 1;
        let record = match record {
            Ok(value) => value,
            Err(_) => {
                invalid_rows.push(WhatsappContactImportInvalidRow {
                    index,
                    error: "Failed to parse CSV row".to_string(),
                    row: HashMap::new(),
                });
                continue;
            }
        };
        let row = headers
            .iter()
            .cloned()
            .zip(record.iter().map(ToString::to_string))
            .collect::<HashMap<_, _>>();
        let Some(phone_raw) = pick_first(
            &row,
            &[
                "phone",
                "Phone",
                "mobile",
                "Mobile",
                "whatsapp",
                "whatsappNumber",
                "number",
            ],
        ) else {
            invalid_rows.push(WhatsappContactImportInvalidRow {
                index,
                error: "Missing phone column".to_string(),
                row,
            });
            continue;
        };
        let phone = normalize_phone(phone_raw);
        if phone.is_empty() {
            invalid_rows.push(WhatsappContactImportInvalidRow {
                index,
                error: format!("Invalid phone format: {phone_raw}"),
                row,
            });
            continue;
        }

        let explicit_opt_in = pick_first(
            &row,
            &["optIn", "opt_in", "optedIn", "subscribed", "consent"],
        )
        .and_then(parse_bool_like);
        let list_label = sanitize_list_label(
            pick_first(&row, &["listLabel", "list"]).or(requested_list_label.as_deref()),
        );
        let metadata = extract_contact_metadata(&row);
        deduped.insert(
            phone,
            (
                pick_first(&row, &["fullName", "name", "Name", "contactName"])
                    .map(ToString::to_string),
                pick_first(&row, &["location", "city", "province", "region"])
                    .map(ToString::to_string),
                parse_csv_tags(pick_first(&row, &["tags", "segment", "groups"])),
                pick_first(&row, &["notes", "note"]).map(ToString::to_string),
                explicit_opt_in.unwrap_or(default_opt_in),
                pick_first(&row, &["optInSource", "consentSource"])
                    .map(ToString::to_string)
                    .or_else(|| explicit_opt_in.map(|_| "csv-import".to_string())),
                if explicit_opt_in == Some(true) || default_opt_in {
                    Some(now)
                } else {
                    None
                },
                list_label,
                metadata,
            ),
        );
    }

    if deduped.is_empty() && invalid_rows.is_empty() {
        return Err(AppError::BadRequest("CSV has no rows".to_string()));
    }

    let phones = deduped.keys().cloned().collect::<Vec<_>>();
    let existing_contacts = if phones.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, COALESCE(tags, ARRAY[]::text[]) AS tags, location,
                   COALESCE("listLabel", 'default') AS list_label, metadata,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AT TIME ZONE 'UTC' AS opt_in_date,
                   "lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent, excluded, notes,
                   "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
            FROM "WhatsappContact"
            WHERE "orgId" = $1 AND phone = ANY($2)
            "#,
        )
        .bind(org_id)
        .bind(&phones)
        .fetch_all(pool)
        .await?
    };
    let existing_by_phone = existing_contacts
        .into_iter()
        .map(|contact| (contact.phone.clone(), contact))
        .collect::<HashMap<_, _>>();

    let existing_contact_ids = existing_by_phone
        .values()
        .map(|contact| contact.id.clone())
        .collect::<Vec<_>>();
    let existing_memberships = if existing_contact_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            r#"
            SELECT id, "contactId" AS contact_id, "listLabel" AS list_label
            FROM "WhatsappContactListMembership"
            WHERE "orgId" = $1 AND "contactId" = ANY($2)
            "#,
        )
        .bind(org_id)
        .bind(&existing_contact_ids)
        .fetch_all(pool)
        .await?
    };
    let existing_membership_by_contact_and_label = existing_memberships
        .into_iter()
        .map(|row| {
            (
                (
                    row.get::<String, _>("contact_id"),
                    row.get::<String, _>("list_label"),
                ),
                row.get::<String, _>("id"),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut created = 0usize;
    let mut updated = 0usize;

    for (
        phone,
        (
            full_name,
            location,
            tags,
            notes,
            opt_in,
            opt_in_source,
            opt_in_date,
            list_label,
            metadata,
        ),
    ) in deduped
    {
        let (contact_id, existing_opt_in_date) = if let Some(existing) =
            existing_by_phone.get(&phone)
        {
            sqlx::query(
                r#"
                UPDATE "WhatsappContact"
                SET "fullName" = COALESCE("fullName", $1),
                    location = COALESCE(location, $2),
                    "optIn" = CASE WHEN $3 THEN true ELSE "optIn" END,
                    "optInSource" = CASE
                        WHEN $3 AND "optInSource" IS NULL THEN $4
                        ELSE "optInSource"
                    END,
                    "optInDate" = CASE
                        WHEN $3 THEN COALESCE("optInDate", $5)
                        ELSE "optInDate"
                    END,
                    "updatedAt" = NOW()
                WHERE id = $6
                "#,
            )
            .bind(full_name.as_deref())
            .bind(location.as_deref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(opt_in_date)
            .bind(&existing.id)
            .execute(pool)
            .await?;
            (existing.id.clone(), existing.opt_in_date)
        } else {
            let contact_id = cuid2::create_id();
            sqlx::query(
                    r#"
                INSERT INTO "WhatsappContact" (
                    id, "userId", "orgId", phone, "fullName", tags, location, notes, "listLabel", metadata,
                    "optIn", "optInSource", "optInDate", excluded, "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NOW(), NOW())
                "#,
                )
                .bind(&contact_id)
                .bind(user_id)
                .bind(org_id)
                .bind(&phone)
                .bind(full_name.as_deref())
                .bind(Vec::<String>::new())
                .bind(location.as_deref())
                .bind(None::<&str>)
                .bind(&list_label)
                .bind(None::<&Value>)
                .bind(opt_in)
                .bind(opt_in_source.as_deref())
                .bind(opt_in_date)
                .execute(pool)
                .await?;
            (contact_id, None)
        };

        if let Some(existing_membership_id) =
            existing_membership_by_contact_and_label.get(&(contact_id.clone(), list_label.clone()))
        {
            sqlx::query(
                r#"
                UPDATE "WhatsappContactListMembership"
                SET "fullName" = $1,
                    location = $2,
                    tags = $3,
                    notes = $4,
                    metadata = $5,
                    "optIn" = $6,
                    "optInSource" = $7,
                    "optInDate" = $8,
                    excluded = false,
                    "updatedAt" = NOW()
                WHERE id = $9
                "#,
            )
            .bind(full_name.as_deref())
            .bind(location.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(notes.as_deref())
            .bind(metadata.as_ref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(if opt_in {
                existing_opt_in_date.or(opt_in_date)
            } else {
                None
            })
            .bind(existing_membership_id)
            .execute(pool)
            .await?;
            updated += 1;
        } else {
            sqlx::query(
                r#"
                INSERT INTO "WhatsappContactListMembership" (
                    id, "userId", "orgId", "contactId", "listLabel", "fullName", tags, location, metadata,
                    "optIn", "optInSource", "optInDate", excluded, notes, "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, NOW(), NOW())
                "#,
            )
            .bind(cuid2::create_id())
            .bind(user_id)
            .bind(org_id)
            .bind(&contact_id)
            .bind(&list_label)
            .bind(full_name.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(location.as_deref())
            .bind(metadata.as_ref())
            .bind(opt_in)
            .bind(opt_in_source.as_deref())
            .bind(opt_in_date)
            .bind(notes.as_deref())
            .execute(pool)
            .await?;
            created += 1;
        }
    }

    Ok(json!({
        "summary": {
            "totalRows": total_rows,
            "validRows": created + updated,
            "invalidRows": invalid_rows.len(),
            "created": created,
            "updated": updated
        },
        "invalidRows": invalid_rows.into_iter().take(100).collect::<Vec<_>>()
    }))
}

pub async fn rename_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
    input: &WhatsappContactListRenameRequest,
) -> Result<Value, AppError> {
    let current_label = sanitize_list_label(Some(label));
    let next_label = sanitize_list_label(input.next_label.as_deref());
    if current_label == next_label {
        return Ok(json!({ "label": next_label, "renamedContacts": 0, "updatedCampaigns": 0 }));
    }

    let updated_memberships = sqlx::query(
        r#"
        UPDATE "WhatsappContactListMembership"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND "listLabel" = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND COALESCE("listLabel", 'default') = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    let updated_campaigns = sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET "listLabel" = $1, "updatedAt" = NOW()
        WHERE "orgId" = $2 AND COALESCE("listLabel", 'default') = $3
        "#,
    )
    .bind(&next_label)
    .bind(org_id)
    .bind(&current_label)
    .execute(pool)
    .await?;

    Ok(json!({
        "label": next_label,
        "renamedContacts": updated_memberships.rows_affected(),
        "updatedCampaigns": updated_campaigns.rows_affected(),
    }))
}

pub async fn delete_contact_list(
    pool: &PgPool,
    org_id: &str,
    label: &str,
) -> Result<Value, AppError> {
    let list_label = sanitize_list_label(Some(label));
    let active_campaign_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM "WhatsappCampaign"
        WHERE "orgId" = $1
          AND COALESCE("listLabel", 'default') = $2
          AND status IN (
            'DRAFT'::"WhatsappCampaignStatus",
            'SCHEDULED'::"WhatsappCampaignStatus",
            'SENDING'::"WhatsappCampaignStatus",
            'PAUSED'::"WhatsappCampaignStatus"
          )
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_one(pool)
    .await?;

    if active_campaign_count > 0 {
        return Err(AppError::Conflict(
            "This list is still attached to active campaigns".to_string(),
        ));
    }

    let contact_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "contactId"
        FROM "WhatsappContactListMembership"
        WHERE "orgId" = $1 AND "listLabel" = $2
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .fetch_all(pool)
    .await?;

    let deleted_contacts = sqlx::query(
        r#"
        DELETE FROM "WhatsappContactListMembership"
        WHERE "orgId" = $1 AND "listLabel" = $2
        "#,
    )
    .bind(org_id)
    .bind(&list_label)
    .execute(pool)
    .await?;

    if !contact_ids.is_empty() {
        sqlx::query(
            r#"
            UPDATE "WhatsappContact" c
            SET "listLabel" = COALESCE(
                    (
                        SELECT m."listLabel"
                        FROM "WhatsappContactListMembership" m
                        WHERE m."contactId" = c.id
                          AND m."orgId" = $1
                        ORDER BY m."createdAt" ASC
                        LIMIT 1
                    ),
                    'default'
                ),
                "updatedAt" = NOW()
            WHERE c."orgId" = $1
              AND c.id = ANY($2)
              AND COALESCE(c."listLabel", 'default') = $3
            "#,
        )
        .bind(org_id)
        .bind(&contact_ids)
        .bind(&list_label)
        .execute(pool)
        .await?;
    }

    Ok(json!({
        "label": list_label,
        "deletedContacts": deleted_contacts.rows_affected(),
    }))
}

fn parse_scheduled_at(value: Option<String>) -> Result<Option<chrono::DateTime<Utc>>, AppError> {
    match value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| AppError::BadRequest("Scheduled time is invalid".to_string())),
        None => Ok(None),
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

fn sanitize_list_label(input: Option<&str>) -> String {
    let normalized = input.map(normalize_list_label).unwrap_or_default();
    if normalized.is_empty() {
        "default".to_string()
    } else {
        normalized
    }
}

fn extract_contact_metadata(row: &HashMap<String, String>) -> Option<Value> {
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
    billing::require_usage_available(
        pool,
        org_id,
        "reach",
        "campaign_recipients",
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

    if let Err(error) = billing::require_product_access(pool, org_id, "reach").await {
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

            billing::record_usage(
                pool,
                org_id,
                "reach",
                "campaign_recipients",
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
) -> Result<(String, i32, chrono::DateTime<Utc>), AppError> {
    let identifier = build_conversation_identifier(connection_id, phone);
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
        if let Some(name) = customer_name {
            sqlx::query(
                r#"UPDATE "Conversation" SET "customerName" = $1, "orgId" = $2 WHERE id = $3"#,
            )
            .bind(name)
            .bind(org_id)
            .bind(&id)
            .execute(pool)
            .await?;
        }
        return Ok((id, unread_count, last_message_at));
    }
    let id = cuid2::create_id();
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO "Conversation" (id, "orgId", channel, "customerIdentifier", "customerName", status, "lastMessageAt", "unreadCount", "createdAt", "updatedAt")
        VALUES ($1, $2, 'whatsapp', $3, $4, 'active', $5, 0, NOW(), NOW())
        "#,
    )
    .bind(&id)
    .bind(org_id)
    .bind(&identifier)
    .bind(customer_name)
    .bind(now)
    .execute(pool)
    .await?;
    Ok((id, 0, now))
}

fn normalize_phone(raw: &str) -> String {
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

fn sanitize_tags(tags: &[String]) -> Vec<String> {
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

fn parse_bool_like(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" => Some(true),
        "false" | "0" | "no" | "n" => Some(false),
        _ => None,
    }
}

fn pick_first<'a>(row: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| row.get(*key))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn parse_csv_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(ToString::to_string)
        .collect()
}

async fn select_list_contact_row(
    pool: &PgPool,
    org_id: &str,
    membership_id: &str,
) -> Result<Option<WhatsappListContactRow>, AppError> {
    sqlx::query_as::<_, WhatsappListContactRow>(
        r#"
        SELECT
            m.id,
            m."contactId" AS contact_id,
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

fn get_media_content(message: &Value) -> Option<String> {
    for kind in ["image", "video", "audio", "document", "sticker"] {
        if let Some(media) = message.get(kind) {
            if let Some(media_id) = media.get("id").and_then(|v| v.as_str()) {
                return Some(format!(
                    "__kasiai_wa_media_v1__:{}",
                    json!({
                        "version": 1,
                        "kind": kind,
                        "mediaId": media_id,
                        "mimeType": media.get("mime_type").and_then(|v| v.as_str()),
                        "caption": media.get("caption").and_then(|v| v.as_str()),
                        "filename": media.get("filename").and_then(|v| v.as_str()),
                        "sha256": media.get("sha256").and_then(|v| v.as_str())
                    })
                ));
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
        let media = get_media_content(&message);
        if text.is_none() && media.is_none() {
            continue;
        }
        let profile_name = contacts
            .iter()
            .find(|contact| contact.get("wa_id").and_then(|v| v.as_str()) == Some(from))
            .and_then(|contact| contact.get("profile"))
            .and_then(|profile| profile.get("name"))
            .and_then(|v| v.as_str());
        let (conversation_id, unread_count, _last) = find_or_create_conversation(
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
        let content = text.clone().or(media).unwrap_or_default();
        let message_id = cuid2::create_id();
        let wa_message_id = message.get("id").and_then(|v| v.as_str());
        sqlx::query(
            r#"
            INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappMessageId", timestamp)
            VALUES ($1, $2, 'customer', $3, $4, NOW())
            "#,
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&content)
        .bind(wa_message_id)
        .execute(pool)
        .await?;
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
            }
            if !forward_call_webhook_to_calls_service(config, &value).await? {
                whatsapp_calls::ingest_webhook_calls(pool, config, &value).await?;
            }
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
            "message": {
                "id": message.id,
                "sender": message.sender,
                "content": message.content,
                "timestamp": message.timestamp,
                "whatsappStatus": message.whatsapp_status,
            }
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

fn unwrap_reply_envelope(content: &str) -> (String, Option<String>, Option<String>) {
    const REPLY_PREFIX: &str = "__kasiai_wa_reply_v1__:";
    if let Some(raw) = content.strip_prefix(REPLY_PREFIX) {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            let inner = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or(content)
                .to_string();
            let preview = value
                .get("replyPreview")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let reply_to = value
                .get("replyToWhatsappMessageId")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .or_else(|| {
                    value
                        .get("replyToMessageId")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                });
            return (inner, preview, reply_to);
        }
    }
    (content.to_string(), None, None)
}

fn parse_stored_media(content: &str) -> Option<Value> {
    const MEDIA_PREFIX: &str = "__kasiai_wa_media_v1__:";
    let (inner, _, _) = unwrap_reply_envelope(content);
    inner
        .strip_prefix(MEDIA_PREFIX)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
}

fn parse_stored_reaction(content: &str) -> Option<Value> {
    const REACTION_PREFIX: &str = "__kasiai_wa_reaction_v1__:";
    let (inner, _, _) = unwrap_reply_envelope(content);
    inner
        .strip_prefix(REACTION_PREFIX)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
}

fn display_text(content: &str) -> String {
    let (inner, _, _) = unwrap_reply_envelope(content);
    if let Some(reaction) = parse_stored_reaction(&inner) {
        let emoji = reaction
            .get("emoji")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        return if emoji.is_empty() {
            "Removed reaction".to_string()
        } else {
            format!("Reacted {}", emoji)
        };
    }
    if let Some(media) = parse_stored_media(&inner) {
        if let Some(caption) = media
            .get("caption")
            .and_then(|v| v.as_str())
            .filter(|v| !v.trim().is_empty())
        {
            return caption.to_string();
        }
        let kind = media
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("media");
        let mut chars = kind.chars();
        return match chars.next() {
            Some(first) => format!("{}{} attachment", first.to_uppercase(), chars.as_str()),
            None => "Media attachment".to_string(),
        };
    }
    inner
}

fn preview_text(content: &str, max: usize) -> String {
    let text = display_text(content);
    if text.len() > max {
        format!("{}...", &text[..max])
    } else {
        text
    }
}

fn sanitize_filename(input: &str) -> String {
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

fn build_stored_media_content(
    kind: &str,
    media_id: &str,
    mime_type: Option<&str>,
    caption: Option<&str>,
    filename: Option<&str>,
    sha256: Option<&str>,
) -> String {
    format!(
        "__kasiai_wa_media_v1__:{}",
        json!({
            "version": 1,
            "kind": kind,
            "mediaId": media_id,
            "mimeType": mime_type,
            "caption": caption,
            "filename": filename,
            "sha256": sha256,
        })
    )
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
    let (text, _, reply_to_whatsapp_message_id) = unwrap_reply_envelope(&job.content);
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
        &text,
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
    let (conversation_id, _, _) = find_or_create_conversation(
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
    let messages = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE "conversationId" = $1
        ORDER BY timestamp ASC
        "#
    )
    .bind(&conversation.id)
    .fetch_all(pool)
    .await?;
    let mapped = messages
        .into_iter()
        .map(|message| {
            json!({
                "id": message.id,
                "sender": message.sender,
                "whatsappMessageId": message.whatsapp_message_id,
                "content": message.content,
                "text": display_text(&message.content),
                "time": message.timestamp,
                "status": message.whatsapp_status,
                "canReply": message.whatsapp_message_id.is_some(),
                "canReact": message.whatsapp_message_id.is_some(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "messages": mapped }))
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
    let mut persisted_content = text.to_string();
    if let Some(reply_to_message_id) = input
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
        persisted_content = format!(
            "__kasiai_wa_reply_v1__:{}",
            json!({
                "version": 1,
                "replyToMessageId": reply_target.id,
                "replyToWhatsappMessageId": target_wa_id,
                "replyPreview": preview_text(&reply_target.content, 180),
                "content": text
            })
        );
    }
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
        INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, 'QUEUED', NOW())
        "#,
    )
    .bind(&created_message_id)
    .bind(&conversation.id)
    .bind(&persisted_content)
    .execute(pool)
    .await?;
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

    let reply_target_wa_id = if let Some(reply_target_message_id) = reply_to_message_id
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
        Some(reply_target.whatsapp_message_id.clone().ok_or_else(|| {
            AppError::BadRequest(
                "This message cannot be replied to yet. Try again in a few seconds.".to_string(),
            )
        })?)
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
        reply_target_wa_id.as_deref(),
    )
    .await?;

    let mut persisted_content = build_stored_media_content(
        media_kind,
        &uploaded_media_id,
        mime_type.as_deref(),
        caption.as_deref(),
        Some(&final_filename),
        sha256.as_deref(),
    );

    if let Some(reply_target_message_id) = reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(reply_target) = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT id, "conversationId" AS conversation_id, sender, content, "whatsappMessageId" AS whatsapp_message_id,
                   "whatsappStatus" AS whatsapp_status, "errorCode" AS error_code, "errorMessage" AS error_message,
                   timestamp AT TIME ZONE 'UTC' AS timestamp
            FROM "Message"
            WHERE id = $1 AND "conversationId" = $2
            LIMIT 1
            "#
        )
        .bind(reply_target_message_id)
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        {
            persisted_content = format!(
                "__kasiai_wa_reply_v1__:{}",
                json!({
                    "version": 1,
                    "replyToMessageId": reply_target.id,
                    "replyToWhatsappMessageId": reply_target.whatsapp_message_id,
                    "replyPreview": preview_text(&reply_target.content, 180),
                    "content": persisted_content
                })
            );
        }
    }

    let message_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappMessageId", "whatsappStatus", timestamp)
        VALUES ($1, $2, 'bot', $3, $4, 'SENT', NOW())
        "#,
    )
    .bind(&message_id)
    .bind(&conversation.id)
    .bind(&persisted_content)
    .bind(&whatsapp_message_id)
    .execute(pool)
    .await?;
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
    sqlx::query(
        r#"
        INSERT INTO "Message" (id, "conversationId", sender, content, timestamp)
        VALUES ($1, $2, 'bot', $3, NOW())
        "#,
    )
    .bind(cuid2::create_id())
    .bind(&conversation.id)
    .bind(format!(
        "__kasiai_wa_reaction_v1__:{}",
        json!({
            "version": 1,
            "emoji": if remove { "" } else { &emoji },
            "targetWhatsappMessageId": target_wa_id,
            "targetMessageId": target_message.id,
            "actorIdentifier": format!("bot:{}", connection.id),
        })
    ))
    .execute(pool)
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

pub async fn download_message_media(
    pool: &PgPool,
    org_id: &str,
    message_id: &str,
) -> Result<actix_web::HttpResponse, AppError> {
    let connection_ids = org_connection_ids(pool, org_id).await?;
    if connection_ids.is_empty() {
        return Err(AppError::NotFound("Media message not found".to_string()));
    }
    let message = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT m.id, m."conversationId" AS conversation_id, m.sender, m.content, m."whatsappMessageId" AS whatsapp_message_id,
               m."whatsappStatus" AS whatsapp_status, m."errorCode" AS error_code, m."errorMessage" AS error_message,
               m.timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE m.id = $1
          AND c.channel = 'whatsapp'
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS connection_id
            WHERE c."customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        LIMIT 1
        "#
    )
    .bind(message_id)
    .bind(&connection_ids)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Media message not found".to_string()))?;
    let media = parse_stored_media(&message.content)
        .ok_or_else(|| AppError::BadRequest("Message does not contain media".to_string()))?;
    let media_id = media
        .get("mediaId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("Message does not contain media".to_string()))?;
    let conversation_identifier = sqlx::query_scalar::<_, String>(
        r#"SELECT "customerIdentifier" FROM "Conversation" WHERE id = $1"#,
    )
    .bind(&message.conversation_id)
    .fetch_one(pool)
    .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row_for_org(pool, org_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (bytes, content_type) = download_media_bytes(&access_token, media_id).await?;
    let extension = media
        .get("mimeType")
        .and_then(|v| v.as_str())
        .and_then(|v| v.split('/').nth(1))
        .unwrap_or("bin");
    let fallback_name = format!("whatsapp-media-{}.{}", message.id, extension);
    let filename = sanitize_filename(
        media
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or(&fallback_name),
    );
    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", content_type))
        .append_header((
            "Content-Disposition",
            format!("inline; filename=\"{}\"", filename),
        ))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}
