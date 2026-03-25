use actix_multipart::Multipart;
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use crate::db::models::{
    ConversationRow, MessageRow, WhatsappCampaignCreateRequest, WhatsappCampaignRecipientRow,
    WhatsappCampaignRow, WhatsappConnectionPublic, WhatsappConnectionRow,
    WhatsappContactImportInvalidRow, WhatsappContactListQuery, WhatsappContactRow,
    WhatsappContactUpdateRequest, WhatsappReactionRequest, WhatsappSendMessageRequest,
    WhatsappStartConversationRequest, WhatsappTemplateRow,
};
use crate::error::AppError;
use crate::services::realtime;
use crate::services::social::{decrypt_social_secret, encrypt_social_secret};

const GRAPH_BASE: &str = "https://graph.facebook.com/v19.0";

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

async fn fetch_graph_json<T: serde::de::DeserializeOwned>(_url: &str, init: reqwest::RequestBuilder) -> Result<T, AppError> {
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

async fn fetch_connection_phone(access_token: &str, phone_number_id: &str) -> Result<GraphPhoneNumber, AppError> {
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
        reqwest::Client::new()
            .post(&url)
            .json(&json!({
                "subscribed_fields": [
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
        .ok_or_else(|| AppError::Internal("Meta OAuth exchange did not return an access token".to_string()))?;
    let long_url = format!(
        "{GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id={}&client_secret={}&fb_exchange_token={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
        urlencoding::encode(first_token)
    );
    let long: Result<Value, AppError> = fetch_graph_json(&long_url, reqwest::Client::new().get(&long_url)).await;
    Ok(long
        .ok()
        .and_then(|value| value.get("access_token").and_then(|token| token.as_str()).map(ToString::to_string))
        .unwrap_or_else(|| first_token.to_string()))
}

async fn resolve_waba_id(access_token: &str, preferred_waba_id: Option<&str>) -> Result<String, AppError> {
    if let Some(waba_id) = preferred_waba_id.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(waba_id.to_string());
    }
    let url = format!(
        "{GRAPH_BASE}/me/businesses?fields=id,owned_whatsapp_business_accounts{{id}},client_whatsapp_business_accounts{{id}}&access_token={}",
        urlencoding::encode(access_token)
    );
    let payload: Value = fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let businesses = payload.get("data").and_then(|value| value.as_array()).cloned().unwrap_or_default();
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
    resolved
        .map(ToString::to_string)
        .ok_or_else(|| AppError::BadRequest("No WhatsApp Business Account found for this Meta account".to_string()))
}

async fn resolve_phone_number(access_token: &str, waba_id: &str, preferred_phone_number_id: Option<&str>) -> Result<GraphPhoneNumber, AppError> {
    let url = format!(
        "{GRAPH_BASE}/{waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token={}",
        urlencoding::encode(access_token)
    );
    let payload: Value = fetch_graph_json(&url, reqwest::Client::new().get(&url)).await?;
    let phones = payload.get("data").and_then(|value| value.as_array()).cloned().unwrap_or_default();
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
    SELECT id, "userId" AS user_id, "phoneNumberId" AS phone_number_id,
           "phoneDisplayNumber" AS phone_display_number, "accessTokenEncrypted" AS access_token_encrypted,
           "wabaId" AS waba_id, "currentQualityRating"::text AS current_quality_rating,
           "dailyLimitEstimate" AS daily_limit_estimate, verified,
           "createdAt" AT TIME ZONE 'UTC' AS created_at,
           "updatedAt" AT TIME ZONE 'UTC' AS updated_at
    FROM "WhatsappConnection"
    "#
}

pub async fn list_connections(pool: &PgPool, user_id: &str) -> Result<Vec<WhatsappConnectionPublic>, AppError> {
    let sql = format!(
        "{} WHERE \"userId\" = $1 ORDER BY \"createdAt\" DESC",
        select_connection_sql()
    );
    let rows = sqlx::query_as::<_, WhatsappConnectionRow>(&sql)
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn get_connection_row(pool: &PgPool, user_id: &str, connection_id: &str) -> Result<Option<WhatsappConnectionRow>, AppError> {
    let sql = format!(
        "{} WHERE id = $1 AND \"userId\" = $2 LIMIT 1",
        select_connection_sql()
    );
    sqlx::query_as::<_, WhatsappConnectionRow>(&sql)
        .bind(connection_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn connect_manual_connection(
    pool: &PgPool,
    user_id: &str,
    waba_id: &str,
    phone_number_id: &str,
    access_token: &str,
    phone_display_number: Option<&str>,
) -> Result<Value, AppError> {
    if waba_id.trim().is_empty() || phone_number_id.trim().is_empty() || access_token.trim().is_empty() {
        return Err(AppError::BadRequest(
            "WABA ID, phone number ID, and access token are required".to_string(),
        ));
    }

    let phone = fetch_connection_phone(access_token, phone_number_id).await?;
    let existing_other = sqlx::query_scalar::<_, String>(
        r#"SELECT "userId" FROM "WhatsappConnection" WHERE "phoneNumberId" = $1 LIMIT 1"#,
    )
    .bind(phone_number_id)
    .fetch_optional(pool)
    .await?;
    if existing_other.as_deref().is_some_and(|owner| owner != user_id) {
        return Err(AppError::Conflict(
            "This WhatsApp number is already connected to another account".to_string(),
        ));
    }

    let encrypted = encrypt_social_secret(access_token)?;
    let connection_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "WhatsappConnection" (
            id, "userId", "phoneNumberId", "phoneDisplayNumber", "accessTokenEncrypted",
            "wabaId", "currentQualityRating", "dailyLimitEstimate", verified, "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, CAST($7 AS "WhatsappConnectionQualityRating"), $8, $9, NOW(), NOW()
        )
        ON CONFLICT ("phoneNumberId")
        DO UPDATE SET
            "userId" = EXCLUDED."userId",
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

    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(
        &format!(
            "{} WHERE \"userId\" = $1 AND \"phoneNumberId\" = $2 LIMIT 1",
            select_connection_sql()
        ),
    )
    .bind(user_id)
    .bind(phone_number_id)
    .fetch_one(pool)
    .await?;

    let webhook_result = subscribe_waba_webhook(access_token, waba_id).await.err();
    let template_sync = sync_connection_templates(pool, user_id, &connection.id).await.ok();

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

pub async fn sync_connection_templates(pool: &PgPool, user_id: &str, connection_id: &str) -> Result<Value, AppError> {
    let connection = get_connection_row(pool, user_id, connection_id)
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
            .and_then(|parts| parts.iter().find(|part| part.component_type.as_deref() == Some("HEADER")))
            .and_then(|part| part.text.clone());
        let body = template
            .components
            .as_ref()
            .and_then(|parts| parts.iter().find(|part| part.component_type.as_deref() == Some("BODY")))
            .and_then(|part| part.text.clone());
        let footer = template
            .components
            .as_ref()
            .and_then(|parts| parts.iter().find(|part| part.component_type.as_deref() == Some("FOOTER")))
            .and_then(|part| part.text.clone());
        let buttons = template
            .components
            .as_ref()
            .and_then(|parts| parts.iter().find(|part| part.component_type.as_deref() == Some("BUTTONS")))
            .and_then(|part| part.buttons.clone());

        sqlx::query(
            r#"
            INSERT INTO "WhatsappTemplate" (
                id, "userId", "connectionId", "templateName", language, category, header, body, footer,
                buttons, "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, $4, $5, CAST($6 AS "WhatsappTemplateCategory"), $7, $8, $9,
                $10, $11, CAST($12 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
            )
            ON CONFLICT ("userId", "templateName", language)
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

pub async fn refresh_connection(pool: &PgPool, user_id: &str, connection_id: &str) -> Result<Value, AppError> {
    let connection = get_connection_row(pool, user_id, connection_id)
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
    .bind(estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref()).unwrap_or(default_daily_limit()))
    .bind(connection_id)
    .execute(pool)
    .await?;

    let refreshed = get_connection_row(pool, user_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    Ok(json!({
        "connection": WhatsappConnectionPublic::from(refreshed),
        "messagingLimitTier": phone.messaging_limit_tier
    }))
}

pub async fn update_connection_access_token(
    pool: &PgPool,
    user_id: &str,
    connection_id: &str,
    access_token: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row(pool, user_id, connection_id)
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
    .bind(connection_label(&phone, connection.phone_display_number.as_deref()))
    .bind(map_quality_rating(phone.quality_rating.as_deref()))
    .bind(
        phone.code_verification_status.as_deref() == Some("VERIFIED")
            || phone.name_status.as_deref() == Some("APPROVED"),
    )
    .bind(estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref()).unwrap_or(default_daily_limit()))
    .bind(connection_id)
    .execute(pool)
    .await?;

    let updated = get_connection_row(pool, user_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    let webhook_error = subscribe_waba_webhook(access_token, &updated.waba_id).await.err();

    Ok(json!({
        "connection": WhatsappConnectionPublic::from(updated),
        "webhookSubscribed": webhook_error.is_none(),
        "webhookError": webhook_error.map(|error| error.to_string())
    }))
}

pub async fn connection_health(pool: &PgPool, user_id: &str, connection_id: &str) -> Result<Value, AppError> {
    let connection = get_connection_row(pool, user_id, connection_id)
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
        match fetch_graph_json::<GraphSubscribedApps>(&url, reqwest::Client::new().get(&url)).await {
            Ok(apps) => {
                let app_id = std::env::var("AUTH_META_APP_ID")
                    .ok()
                    .or_else(|| std::env::var("NEXT_PUBLIC_META_APP_ID").ok());
                webhook_subscribed = apps
                    .data
                    .unwrap_or_default()
                    .iter()
                    .any(|app| app_id.as_ref().map(|id| app.id.as_deref() == Some(id.as_str())).unwrap_or(true));
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
    connection_id: &str,
    template_name: &str,
    language: &str,
    category: &str,
    header: Option<&str>,
    body: &str,
    footer: Option<&str>,
) -> Result<Value, AppError> {
    let connection = get_connection_row(pool, user_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    if template_name.trim().is_empty() || language.trim().is_empty() || body.trim().is_empty() {
        return Err(AppError::BadRequest("Template name, language, and body are required".to_string()));
    }
    let normalized_name = template_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' { ch } else { '_' })
        .collect::<String>();
    let category = map_template_category(Some(category))
        .ok_or_else(|| AppError::BadRequest("Invalid template category".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;

    let components = json!([
        if header.map(|value| !value.trim().is_empty()).unwrap_or(false) {
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
        if footer.map(|value| !value.trim().is_empty()).unwrap_or(false) {
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
            id, "userId", "connectionId", "templateName", language, category, header, body, footer,
            "variablesCount", status, "lastSynced", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, CAST($6 AS "WhatsappTemplateCategory"), $7, $8, $9,
            $10, CAST($11 AS "WhatsappTemplateStatus"), NOW(), NOW(), NOW()
        )
        ON CONFLICT ("userId", "templateName", language)
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
    .bind(connection_id)
    .bind(&normalized_name)
    .bind(language.trim())
    .bind(&category)
    .bind(header.map(|value| value.trim()).filter(|value| !value.is_empty()))
    .bind(body.trim())
    .bind(footer.map(|value| value.trim()).filter(|value| !value.is_empty()))
    .bind(variables_count(Some(body.trim())))
    .bind(map_template_status(response.get("status").and_then(|value| value.as_str())))
    .execute(pool)
    .await?;

    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AS last_synced, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappTemplate"
        WHERE "userId" = $1 AND "templateName" = $2 AND language = $3
        LIMIT 1
        "#,
    )
    .bind(user_id)
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

pub async fn list_contacts(
    pool: &PgPool,
    user_id: &str,
    query: WhatsappContactListQuery,
) -> Result<Value, AppError> {
    let contacts = sqlx::query_as::<_, WhatsappContactRow>(
        r#"
        SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
               "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
               "lastMarketingSent" AS last_marketing_sent, excluded, notes,
               "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappContact"
        WHERE "userId" = $1
          AND (
            COALESCE($2, '') = ''
            OR COALESCE("fullName", '') ILIKE ('%' || $2 || '%')
            OR phone ILIKE ('%' || $2 || '%')
            OR COALESCE(location, '') ILIKE ('%' || $2 || '%')
            OR EXISTS (
              SELECT 1
              FROM unnest(tags) AS tag_value
              WHERE tag_value ILIKE $2
            )
          )
          AND (
            COALESCE($3, 'all') = 'all'
            OR ("optIn" = true AND $3 = 'true')
            OR ("optIn" = false AND $3 = 'false')
          )
          AND (
            COALESCE($4, 'all') = 'all'
            OR (excluded = true AND $4 = 'true')
            OR (excluded = false AND $4 = 'false')
          )
          AND (
            COALESCE($5, '') = ''
            OR EXISTS (
              SELECT 1
              FROM unnest(tags) AS tag_filter
              WHERE tag_filter = $5
            )
          )
          AND (
            COALESCE($6, '') = ''
            OR COALESCE(location, '') ILIKE ('%' || $6 || '%')
          )
        ORDER BY "createdAt" DESC
        LIMIT 500
        "#,
    )
    .bind(user_id)
    .bind(query.q.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(query.opt_in.as_deref())
    .bind(query.excluded.as_deref())
    .bind(query.tag.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(query.location.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .fetch_all(pool)
    .await?;

    Ok(json!({ "contacts": contacts }))
}

pub async fn update_contact(
    pool: &PgPool,
    user_id: &str,
    contact_id: &str,
    input: WhatsappContactUpdateRequest,
) -> Result<Value, AppError> {
    let existing = select_contact_row(pool, user_id, contact_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Contact not found".to_string()))?;

    let normalized_phone = match input.phone.as_deref() {
        Some(phone) => {
            let normalized = normalize_phone(phone);
            if normalized.is_empty() {
                return Err(AppError::BadRequest("Invalid phone number format".to_string()));
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
            WHERE "userId" = $1 AND phone = $2 AND id <> $3
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .bind(phone)
        .bind(contact_id)
        .fetch_optional(pool)
        .await?;
        if duplicate.is_some() {
            return Err(AppError::Conflict("A contact with this phone already exists".to_string()));
        }
    }

    let tags = input.tags.as_ref().map(|value| sanitize_tags(value));
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

    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "fullName" = COALESCE($1, "fullName"),
            phone = COALESCE($2, phone),
            location = COALESCE($3, location),
            tags = COALESCE($4, tags),
            notes = COALESCE($5, notes),
            "optIn" = COALESCE($6, "optIn"),
            "optInSource" = $7,
            "optInDate" = $8,
            excluded = COALESCE($9, excluded),
            "updatedAt" = NOW()
        WHERE id = $10 AND "userId" = $11
        "#,
    )
    .bind(input.full_name.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()))
    .bind(normalized_phone)
    .bind(input.location.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()))
    .bind(tags.as_ref())
    .bind(input.notes.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()))
    .bind(opt_in)
    .bind(opt_in_source)
    .bind(opt_in_date)
    .bind(input.excluded)
    .bind(contact_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    let contact = select_contact_row(pool, user_id, contact_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload contact".to_string()))?;

    Ok(json!({ "contact": contact }))
}

pub async fn import_contacts(pool: &PgPool, user_id: &str, mut payload: Multipart) -> Result<Value, AppError> {
    let mut csv_bytes = Vec::new();
    let mut default_opt_in = false;

    while let Some(field) = payload.next().await {
        let mut field = field.map_err(|_| AppError::BadRequest("Failed to read multipart payload".to_string()))?;
        let Some(name) = field.name() else { continue };
        let name = name.to_string();
        let mut bytes = Vec::new();
        while let Some(chunk) = field.next().await {
            let chunk = chunk.map_err(|_| AppError::BadRequest("Failed to read multipart field".to_string()))?;
            bytes.extend_from_slice(&chunk);
        }
        if name == "file" {
            csv_bytes = bytes;
        } else if name == "defaultOptIn" {
            default_opt_in = parse_bool_like(std::str::from_utf8(&bytes).unwrap_or("")).unwrap_or(false);
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
    let mut deduped: HashMap<String, (Option<String>, Option<String>, Vec<String>, Option<String>, bool, Option<String>, Option<chrono::DateTime<Utc>>)> = HashMap::new();
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
            &["phone", "Phone", "mobile", "Mobile", "whatsapp", "whatsappNumber", "number"],
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

        let explicit_opt_in = pick_first(&row, &["optIn", "opt_in", "optedIn", "subscribed", "consent"])
            .and_then(parse_bool_like);
        deduped.insert(
            phone,
            (
                pick_first(&row, &["fullName", "name", "Name", "contactName"]).map(ToString::to_string),
                pick_first(&row, &["location", "city", "province", "region"]).map(ToString::to_string),
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
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
                   "lastMarketingSent" AS last_marketing_sent, excluded, notes,
                   "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappContact"
            WHERE "userId" = $1 AND phone = ANY($2)
            "#,
        )
        .bind(user_id)
        .bind(&phones)
        .fetch_all(pool)
        .await?
    };
    let existing_by_phone = existing_contacts
        .into_iter()
        .map(|contact| (contact.phone.clone(), contact))
        .collect::<HashMap<_, _>>();

    let mut created = 0usize;
    let mut updated = 0usize;

    for (phone, (full_name, location, tags, notes, opt_in, opt_in_source, opt_in_date)) in deduped {
        if let Some(existing) = existing_by_phone.get(&phone) {
            sqlx::query(
                r#"
                UPDATE "WhatsappContact"
                SET "fullName" = $1,
                    location = $2,
                    tags = $3,
                    notes = $4,
                    "optIn" = $5,
                    "optInSource" = $6,
                    "optInDate" = $7,
                    "updatedAt" = NOW()
                WHERE id = $8
                "#,
            )
            .bind(full_name.as_deref())
            .bind(location.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(notes.as_deref())
            .bind(opt_in)
            .bind(opt_in_source)
            .bind(if opt_in {
                existing.opt_in_date.or(opt_in_date)
            } else {
                None
            })
            .bind(&existing.id)
            .execute(pool)
            .await?;
            updated += 1;
        } else {
            sqlx::query(
                r#"
                INSERT INTO "WhatsappContact" (
                    id, "userId", phone, "fullName", tags, location, notes,
                    "optIn", "optInSource", "optInDate", excluded, "createdAt", "updatedAt"
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, NOW(), NOW())
                "#,
            )
            .bind(cuid2::create_id())
            .bind(user_id)
            .bind(&phone)
            .bind(full_name.as_deref())
            .bind(sanitize_tags(&tags))
            .bind(location.as_deref())
            .bind(notes.as_deref())
            .bind(opt_in)
            .bind(opt_in_source)
            .bind(opt_in_date)
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

async fn get_campaign_row(pool: &PgPool, user_id: &str, campaign_id: &str) -> Result<Option<WhatsappCampaignRow>, AppError> {
    sqlx::query_as::<_, WhatsappCampaignRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateId" AS template_id,
               name, description, "templateName" AS template_name, "templateLanguage" AS template_language,
               "variableMappings" AS variable_mappings, status::text AS status, "scheduledAt" AS scheduled_at,
               "launchedAt" AS launched_at, "completedAt" AS completed_at, "totalRecipients" AS total_recipients,
               "sentCount" AS sent_count, "deliveredCount" AS delivered_count, "readCount" AS read_count,
               "failedCount" AS failed_count, "blockedCount" AS blocked_count, "unsubscribedCount" AS unsubscribed_count,
               "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappCampaign"
        WHERE id = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(campaign_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

pub async fn list_campaigns(pool: &PgPool, user_id: &str) -> Result<Value, AppError> {
    let campaigns = sqlx::query_as::<_, WhatsappCampaignRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateId" AS template_id,
               name, description, "templateName" AS template_name, "templateLanguage" AS template_language,
               "variableMappings" AS variable_mappings, status::text AS status, "scheduledAt" AS scheduled_at,
               "launchedAt" AS launched_at, "completedAt" AS completed_at, "totalRecipients" AS total_recipients,
               "sentCount" AS sent_count, "deliveredCount" AS delivered_count, "readCount" AS read_count,
               "failedCount" AS failed_count, "blockedCount" AS blocked_count, "unsubscribedCount" AS unsubscribed_count,
               "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappCampaign"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(json!({ "campaigns": campaigns }))
}

pub async fn create_campaign(
    pool: &PgPool,
    user_id: &str,
    input: &WhatsappCampaignCreateRequest,
) -> Result<Value, AppError> {
    let name = input.name.as_deref().map(str::trim).filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Campaign name is required".to_string()))?;
    let connection_id = input.connection_id.as_deref().unwrap_or("");
    let template_id = input.template_id.as_deref().unwrap_or("");
    let scheduled_at = parse_scheduled_at(input.scheduled_at.clone())?;

    let connection = get_connection_row(pool, user_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AS last_synced, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappTemplate"
        WHERE id = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(template_id)
    .bind(user_id)
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
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
                   "lastMarketingSent" AS last_marketing_sent, excluded, notes,
                   "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappContact"
            WHERE "userId" = $1 AND id = ANY($2)
            "#,
        )
        .bind(user_id)
        .bind(recipient_ids)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
                   "lastMarketingSent" AS last_marketing_sent, excluded, notes,
                   "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappContact"
            WHERE "userId" = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    };

    let mut eligible_ids = Vec::new();
    let mut skipped = json!({
        "notOptedIn": 0,
        "excluded": 0,
        "cooldown": 0
    });
    for contact in &contacts {
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

    let campaign_id = cuid2::create_id();
    sqlx::query(
        r#"
        INSERT INTO "WhatsappCampaign" (
            id, "userId", "connectionId", "templateId", name, description, "templateName", "templateLanguage",
            "variableMappings", status, "scheduledAt", "totalRecipients", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            CAST($10 AS "WhatsappCampaignStatus"), $11, $12, NOW(), NOW()
        )
        "#,
    )
    .bind(&campaign_id)
    .bind(user_id)
    .bind(&connection.id)
    .bind(&template.id)
    .bind(name)
    .bind(input.description.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()))
    .bind(&template.template_name)
    .bind(&template.language)
    .bind(&input.variable_mappings)
    .bind(if scheduled_at.map(|v| v > Utc::now()).unwrap_or(false) { "SCHEDULED" } else { "DRAFT" })
    .bind(scheduled_at)
    .bind(eligible_ids.len() as i32)
    .execute(pool)
    .await?;

    for contact_id in &eligible_ids {
        sqlx::query(
            r#"
            INSERT INTO "WhatsappCampaignRecipient" (id, "campaignId", "contactId", status, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, 'PENDING'::"WhatsappRecipientStatus", NOW(), NOW())
            "#,
        )
        .bind(cuid2::create_id())
        .bind(&campaign_id)
        .bind(contact_id)
        .execute(pool)
        .await?;
    }

    let campaign = get_campaign_row(pool, user_id, &campaign_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload campaign".to_string()))?;

    Ok(json!({
        "campaign": campaign,
        "createdRecipients": eligible_ids.len(),
        "skipped": skipped
    }))
}

pub async fn get_campaign(pool: &PgPool, user_id: &str, campaign_id: &str) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, user_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let recipients = sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
        r#"
        SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
               "waMessageId" AS wa_message_id, "sentAt" AS sent_at, "deliveredAt" AS delivered_at,
               "readAt" AS read_at, "failedAt" AS failed_at, "errorCode" AS error_code,
               "errorMessage" AS error_message, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappCampaignRecipient"
        WHERE "campaignId" = $1
        ORDER BY "createdAt" ASC
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

pub async fn launch_campaign(
    pool: &PgPool,
    user_id: &str,
    campaign_id: &str,
    scheduled_at: Option<String>,
) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, user_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM "WhatsappCampaignRecipient"
        WHERE "campaignId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'FAILED'::"WhatsappRecipientStatus")
        "#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    if recipient_ids.is_empty() {
        return Err(AppError::BadRequest("Campaign has no recipients to launch".to_string()));
    }
    if campaign.total_recipients > get_connection_row(pool, user_id, &campaign.connection_id)
        .await?
        .and_then(|c| c.daily_limit_estimate)
        .unwrap_or(i32::MAX)
    {
        return Err(AppError::Conflict(format!(
            "Campaign size ({}) exceeds estimated daily portfolio limit ({})",
            campaign.total_recipients,
            get_connection_row(pool, user_id, &campaign.connection_id).await?.and_then(|c| c.daily_limit_estimate).unwrap_or(i32::MAX)
        )));
    }
    let requested_scheduled_at = parse_scheduled_at(scheduled_at)?.or(campaign.scheduled_at);
    let should_schedule = requested_scheduled_at.map(|dt| dt > Utc::now()).unwrap_or(false);

    sqlx::query(
        r#"
        UPDATE "WhatsappCampaignRecipient"
        SET status = 'QUEUED'::"WhatsappRecipientStatus", "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = NOW()
        WHERE id = ANY($1)
        "#,
    )
    .bind(&recipient_ids)
    .execute(pool)
    .await?;

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
    .bind(if should_schedule { "SCHEDULED" } else { "SENDING" })
    .bind(requested_scheduled_at)
    .bind(should_schedule)
    .bind(campaign_id)
    .execute(pool)
    .await?;

    Ok(json!({
        "campaignId": campaign_id,
        "queuedRecipients": recipient_ids.len(),
        "scheduledAt": requested_scheduled_at,
        "status": if should_schedule { "SCHEDULED" } else { "SENDING" }
    }))
}

pub async fn pause_campaign(pool: &PgPool, user_id: &str, campaign_id: &str) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, user_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    if campaign.status != "SENDING" && campaign.status != "SCHEDULED" {
        return Err(AppError::BadRequest("Only active or scheduled campaigns can be paused".to_string()));
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
    Ok(json!({ "campaignId": campaign_id, "pausedRecipients": result.rows_affected(), "status": "PAUSED" }))
}

pub async fn resume_campaign(pool: &PgPool, user_id: &str, campaign_id: &str, scheduled_at: Option<String>) -> Result<Value, AppError> {
    let campaign = get_campaign_row(pool, user_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    if campaign.status != "PAUSED" {
        return Err(AppError::BadRequest("Only paused campaigns can be resumed".to_string()));
    }
    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId" = $1 AND status = 'PENDING'::"WhatsappRecipientStatus""#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    if recipient_ids.is_empty() {
        return Err(AppError::BadRequest("Campaign has no paused recipients to resume".to_string()));
    }
    let requested_scheduled_at = parse_scheduled_at(scheduled_at)?.or(campaign.scheduled_at);
    let should_schedule = requested_scheduled_at.map(|dt| dt > Utc::now()).unwrap_or(false);
    sqlx::query(r#"UPDATE "WhatsappCampaignRecipient" SET status = 'QUEUED'::"WhatsappRecipientStatus", "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = NOW() WHERE id = ANY($1)"#)
        .bind(&recipient_ids)
        .execute(pool)
        .await?;
    sqlx::query(r#"UPDATE "WhatsappCampaign" SET status = CAST($1 AS "WhatsappCampaignStatus"), "scheduledAt" = $2, "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $3"#)
        .bind(if should_schedule { "SCHEDULED" } else { "SENDING" })
        .bind(requested_scheduled_at)
        .bind(campaign_id)
        .execute(pool)
        .await?;
    Ok(json!({ "campaignId": campaign_id, "resumedRecipients": recipient_ids.len(), "status": if should_schedule { "SCHEDULED" } else { "SENDING" } }))
}

pub async fn cancel_campaign(pool: &PgPool, user_id: &str, campaign_id: &str) -> Result<Value, AppError> {
    let _campaign = get_campaign_row(pool, user_id, campaign_id)
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
          AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus", 'FAILED'::"WhatsappRecipientStatus")
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
    Ok(json!({ "campaignId": campaign_id, "cancelledRecipients": result.rows_affected(), "status": "FAILED" }))
}

pub async fn retry_failed_campaign(pool: &PgPool, user_id: &str, campaign_id: &str) -> Result<Value, AppError> {
    let _campaign = get_campaign_row(pool, user_id, campaign_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Campaign not found".to_string()))?;
    let recipient_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId" = $1 AND status = 'FAILED'::"WhatsappRecipientStatus""#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    if recipient_ids.is_empty() {
        return Err(AppError::BadRequest("Campaign has no failed recipients to retry".to_string()));
    }
    sqlx::query(r#"UPDATE "WhatsappCampaignRecipient" SET status = 'QUEUED'::"WhatsappRecipientStatus", "errorCode" = NULL, "errorMessage" = NULL, "failedAt" = NULL, "updatedAt" = NOW() WHERE id = ANY($1)"#)
        .bind(&recipient_ids)
        .execute(pool)
        .await?;
    sqlx::query(r#"UPDATE "WhatsappCampaign" SET status = 'SENDING'::"WhatsappCampaignStatus", "launchedAt" = NOW(), "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $1"#)
        .bind(campaign_id)
        .execute(pool)
        .await?;
    Ok(json!({ "campaignId": campaign_id, "retriedRecipients": recipient_ids.len(), "status": "SENDING" }))
}

pub async fn recompute_campaign_stats(pool: &PgPool, campaign_id: &str) -> Result<(), AppError> {
    let counts = sqlx::query_as::<_, (String, i64)>(
        r#"
        SELECT status::text, COUNT(*)::bigint
        FROM "WhatsappCampaignRecipient"
        WHERE "campaignId" = $1
        GROUP BY status
        "#,
    )
    .bind(campaign_id)
    .fetch_all(pool)
    .await?;
    let mut map = std::collections::HashMap::new();
    for (status, count) in counts {
        map.insert(status, count as i32);
    }
    let pending = map.get("PENDING").copied().unwrap_or(0) + map.get("QUEUED").copied().unwrap_or(0);
    let campaign = sqlx::query_scalar::<_, String>(r#"SELECT status::text FROM "WhatsappCampaign" WHERE id = $1"#)
        .bind(campaign_id)
        .fetch_optional(pool)
        .await?;
    if campaign.is_none() {
        return Ok(());
    }
    sqlx::query(
        r#"
        UPDATE "WhatsappCampaign"
        SET "sentCount" = $1,
            "deliveredCount" = $2,
            "readCount" = $3,
            "failedCount" = $4,
            "blockedCount" = $5,
            "unsubscribedCount" = $6,
            status = CASE
                WHEN $7 = 0 AND status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus", 'PAUSED'::"WhatsappCampaignStatus")
                    THEN 'COMPLETED'::"WhatsappCampaignStatus"
                ELSE status
            END,
            "completedAt" = CASE
                WHEN $7 = 0 AND status IN ('SENDING'::"WhatsappCampaignStatus", 'SCHEDULED'::"WhatsappCampaignStatus", 'PAUSED'::"WhatsappCampaignStatus")
                    THEN NOW()
                ELSE "completedAt"
            END,
            "updatedAt" = NOW()
        WHERE id = $8
        "#,
    )
    .bind(map.get("SENT").copied().unwrap_or(0) + map.get("DELIVERED").copied().unwrap_or(0) + map.get("READ").copied().unwrap_or(0))
    .bind(map.get("DELIVERED").copied().unwrap_or(0) + map.get("READ").copied().unwrap_or(0))
    .bind(map.get("READ").copied().unwrap_or(0))
    .bind(map.get("FAILED").copied().unwrap_or(0))
    .bind(map.get("BLOCKED").copied().unwrap_or(0))
    .bind(map.get("UNSUBSCRIBED").copied().unwrap_or(0))
    .bind(pending)
    .bind(campaign_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn build_body_parameters(contact: &WhatsappContactRow, mappings: Option<&Vec<Value>>) -> Vec<String> {
    let Some(mappings) = mappings else { return Vec::new(); };
    mappings.iter().map(|mapping| {
        let source = mapping.get("source").and_then(|v| v.as_str()).unwrap_or("contact");
        let key = mapping.get("key").and_then(|v| v.as_str()).unwrap_or("");
        if source == "static" {
            return key.to_string();
        }
        match key {
            "fullName" | "name" => contact.full_name.clone().unwrap_or_default(),
            "phone" => contact.phone.clone(),
            "location" => contact.location.clone().unwrap_or_default(),
            "tags" => contact.tags.join(", "),
            _ => String::new(),
        }
    }).collect()
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
            "WhatsApp Cloud API send failed ({}): {}",
            status,
            raw.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("Unknown error")
        )));
    }
    let message_id = raw.get("messages").and_then(|v| v.get(0)).and_then(|v| v.get("id")).and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("WhatsApp Cloud API did not return a message id".to_string()))?;
    Ok((message_id.to_string(), raw))
}

fn parse_failure_message(error: &AppError) -> (Option<String>, String, bool) {
    let message = error.to_string();
    let lower = message.to_lowercase();
    let blocked = lower.contains("blocked") || lower.contains("131026") || lower.contains("131048");
    (None, message, blocked)
}

pub async fn process_queued_campaign_recipients(pool: &PgPool, limit: i64) -> Result<i64, AppError> {
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
    let mut processed = 0;
    for recipient_id in recipient_ids {
        let row = sqlx::query_as::<_, (String, String, String, String, String, String, Option<Value>)>(
            r#"
            SELECT r.id, c.id, c."connectionId", c."templateName", c."templateLanguage", ct.id, c."variableMappings"
            FROM "WhatsappCampaignRecipient" r
            JOIN "WhatsappCampaign" c ON c.id = r."campaignId"
            JOIN "WhatsappContact" ct ON ct.id = r."contactId"
            WHERE r.id = $1
            "#,
        )
        .bind(&recipient_id)
        .fetch_optional(pool)
        .await?;
        if row.is_none() {
            continue;
        }
        let recipient = sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
            r#"
            SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
                   "waMessageId" AS wa_message_id, "sentAt" AS sent_at, "deliveredAt" AS delivered_at,
                   "readAt" AS read_at, "failedAt" AS failed_at, "errorCode" AS error_code,
                   "errorMessage" AS error_message, "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappCampaignRecipient" WHERE id = $1
            "#,
        )
        .bind(&recipient_id)
        .fetch_one(pool)
        .await?;
        if recipient.status != "QUEUED" {
            continue;
        }
        let contact = sqlx::query_as::<_, WhatsappContactRow>(
            r#"
            SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
                   "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
                   "lastMarketingSent" AS last_marketing_sent, excluded, notes,
                   "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappContact" WHERE id = $1
            "#,
        )
        .bind(&recipient.contact_id)
        .fetch_one(pool)
        .await?;
        let (reason, eligible) = contact_eligible(&contact);
        if !eligible {
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"), "errorCode" = $2, "errorMessage" = $3, "updatedAt" = NOW()
                WHERE id = $4
                "#,
            )
            .bind(if reason == "excluded" { "UNSUBSCRIBED" } else { "SKIPPED" })
            .bind(reason)
            .bind("Recipient no longer matches marketing safety requirements")
            .bind(&recipient_id)
            .execute(pool)
            .await?;
            recompute_campaign_stats(pool, &recipient.campaign_id).await?;
            processed += 1;
            continue;
        }
        let campaign = sqlx::query_as::<_, WhatsappCampaignRow>(
            r#"
            SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateId" AS template_id,
                   name, description, "templateName" AS template_name, "templateLanguage" AS template_language,
                   "variableMappings" AS variable_mappings, status::text AS status, "scheduledAt" AS scheduled_at,
                   "launchedAt" AS launched_at, "completedAt" AS completed_at, "totalRecipients" AS total_recipients,
                   "sentCount" AS sent_count, "deliveredCount" AS delivered_count, "readCount" AS read_count,
                   "failedCount" AS failed_count, "blockedCount" AS blocked_count, "unsubscribedCount" AS unsubscribed_count,
                   "createdAt" AS created_at, "updatedAt" AS updated_at
            FROM "WhatsappCampaign" WHERE id = $1
            "#,
        )
        .bind(&recipient.campaign_id)
        .fetch_one(pool)
        .await?;
        let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!("{} WHERE id = $1", select_connection_sql()))
            .bind(&campaign.connection_id)
            .fetch_one(pool)
            .await?;
        let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
        let mappings = campaign.variable_mappings.as_ref().and_then(|v| v.as_array());
        let body_parameters = build_body_parameters(&contact, mappings);
        match send_marketing_template(
            &connection.phone_number_id,
            &access_token,
            &contact.phone,
            &campaign.template_name,
            &campaign.template_language,
            &body_parameters,
        ).await {
            Ok((message_id, raw)) => {
                sqlx::query(
                    r#"
                    UPDATE "WhatsappCampaignRecipient"
                    SET status = 'SENT'::"WhatsappRecipientStatus", "waMessageId" = $1, "sentAt" = NOW(),
                        "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = NOW()
                    WHERE id = $2
                    "#,
                )
                .bind(&message_id)
                .bind(&recipient_id)
                .execute(pool)
                .await?;
                sqlx::query(r#"UPDATE "WhatsappContact" SET "lastMarketingSent" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
                    .bind(&contact.id)
                    .execute(pool)
                    .await?;
                sqlx::query(
                    r#"
                    INSERT INTO "WhatsappSendEvent" (
                        id, "userId", "connectionId", "campaignId", "recipientId", "contactId", phone, "templateName",
                        status, "whatsappMessageId", "requestPayload", "responsePayload", "createdAt"
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                            'SENT'::"WhatsappRecipientStatus", $9, $10, $11, NOW())
                    "#,
                )
                .bind(cuid2::create_id())
                .bind(&campaign.user_id)
                .bind(&campaign.connection_id)
                .bind(&campaign.id)
                .bind(&recipient_id)
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
            }
            Err(error) => {
                let (code, message, blocked) = parse_failure_message(&error);
                let status = if blocked { "BLOCKED" } else { "FAILED" };
                sqlx::query(
                    r#"
                    UPDATE "WhatsappCampaignRecipient"
                    SET status = CAST($1 AS "WhatsappRecipientStatus"), "failedAt" = NOW(),
                        "errorCode" = $2, "errorMessage" = $3, "updatedAt" = NOW()
                    WHERE id = $4
                    "#,
                )
                .bind(status)
                .bind(code)
                .bind(&message)
                .bind(&recipient_id)
                .execute(pool)
                .await?;
            }
        }
        recompute_campaign_stats(pool, &recipient.campaign_id).await?;
        processed += 1;
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
        WHERE channel = 'whatsapp' AND "customerIdentifier" = $1
        LIMIT 1
        "#,
    )
    .bind(&identifier)
    .fetch_optional(pool)
    .await?;
    if let Some((id, unread_count, last_message_at)) = existing {
        if let Some(name) = customer_name {
            sqlx::query(r#"UPDATE "Conversation" SET "customerName" = $1 WHERE id = $2"#)
                .bind(name)
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
        INSERT INTO "Conversation" (id, channel, "customerIdentifier", "customerName", status, "lastMessageAt", "unreadCount", "createdAt", "updatedAt")
        VALUES ($1, 'whatsapp', $2, $3, 'active', $4, 0, NOW(), NOW())
        "#,
    )
    .bind(&id)
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
        return if valid_e164(&cleaned) { cleaned } else { String::new() };
    }
    if let Some(rest) = cleaned.strip_prefix("00") {
        let candidate = format!("+{rest}");
        return if valid_e164(&candidate) {
            candidate
        } else {
            String::new()
        };
    }
    let digits = cleaned.chars().filter(|ch| ch.is_ascii_digit()).collect::<String>();
    if digits.is_empty() {
        return String::new();
    }
    let default_country = std::env::var("WHATSAPP_DEFAULT_COUNTRY_CODE")
        .unwrap_or_else(|_| "+27".to_string());
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

async fn select_contact_row(pool: &PgPool, user_id: &str, contact_id: &str) -> Result<Option<WhatsappContactRow>, AppError> {
    sqlx::query_as::<_, WhatsappContactRow>(
        r#"
        SELECT id, "userId" AS user_id, phone, "fullName" AS full_name, tags, location,
               "optIn" AS opt_in, "optInSource" AS opt_in_source, "optInDate" AS opt_in_date,
               "lastMarketingSent" AS last_marketing_sent, excluded, notes,
               "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappContact"
        WHERE id = $1 AND "userId" = $2
        LIMIT 1
        "#,
    )
    .bind(contact_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

fn get_inbound_text(message: &Value) -> Option<String> {
    message.get("text").and_then(|v| v.get("body")).and_then(|v| v.as_str()).map(|s| s.to_string())
        .or_else(|| message.get("button").and_then(|v| v.get("text")).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

fn get_media_content(message: &Value) -> Option<String> {
    for kind in ["image", "video", "audio", "document", "sticker"] {
        if let Some(media) = message.get(kind) {
            if let Some(media_id) = media.get("id").and_then(|v| v.as_str()) {
                return Some(format!("__kasiai_wa_media_v1__:{}", json!({
                    "version": 1,
                    "kind": kind,
                    "mediaId": media_id,
                    "mimeType": media.get("mime_type").and_then(|v| v.as_str()),
                    "caption": media.get("caption").and_then(|v| v.as_str()),
                    "filename": media.get("filename").and_then(|v| v.as_str()),
                    "sha256": media.get("sha256").and_then(|v| v.as_str())
                })));
            }
        }
    }
    None
}

async fn handle_status(pool: &PgPool, status_payload: &Value) -> Result<(), AppError> {
    let Some(message_id) = status_payload.get("id").and_then(|v| v.as_str()) else { return Ok(()); };
    let next_status = match status_payload.get("status").and_then(|v| v.as_str()) {
        Some("sent") => "SENT",
        Some("delivered") => "DELIVERED",
        Some("read") => "READ",
        Some("failed") => "FAILED",
        _ => return Ok(()),
    };
    let timestamp = status_payload.get("timestamp").and_then(|v| v.as_str())
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(|secs| chrono::DateTime::<Utc>::from_timestamp(secs, 0))
        .unwrap_or_else(Utc::now);

    if let Some(recipient) = sqlx::query_as::<_, WhatsappCampaignRecipientRow>(
        r#"
        SELECT id, "campaignId" AS campaign_id, "contactId" AS contact_id, status::text AS status,
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
    .await? {
        if recipient.status != next_status {
            sqlx::query(
                r#"
                UPDATE "WhatsappCampaignRecipient"
                SET status = CAST($1 AS "WhatsappRecipientStatus"),
                    "deliveredAt" = CASE WHEN $1 = 'DELIVERED' THEN $2 ELSE "deliveredAt" END,
                    "readAt" = CASE WHEN $1 = 'READ' THEN $2 ELSE "readAt" END,
                    "failedAt" = CASE WHEN $1 IN ('FAILED','BLOCKED') THEN $2 ELSE "failedAt" END,
                    "updatedAt" = NOW()
                WHERE id = $3
                "#,
            )
            .bind(next_status)
            .bind(timestamp)
            .bind(&recipient.id)
            .execute(pool)
            .await?;
            recompute_campaign_stats(pool, &recipient.campaign_id).await?;
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
            if let Some((connection_id, _)) = parse_conversation_identifier(&conversation.customer_identifier) {
                let user_id = sqlx::query_scalar::<_, String>(
                    r#"SELECT "userId" FROM "WhatsappConnection" WHERE id = $1 LIMIT 1"#,
                )
                .bind(&connection_id)
                .fetch_optional(pool)
                .await?;
                if let Some(user_id) = user_id {
                    publish_message_updated(
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

async fn handle_incoming_messages(pool: &PgPool, value: &Value) -> Result<(), AppError> {
    let phone_number_id = value.get("metadata").and_then(|v| v.get("phone_number_id")).and_then(|v| v.as_str());
    let Some(phone_number_id) = phone_number_id else { return Ok(()); };
    let connection = sqlx::query_as::<_, WhatsappConnectionRow>(&format!("{} WHERE \"phoneNumberId\" = $1 LIMIT 1", select_connection_sql()))
        .bind(phone_number_id)
        .fetch_optional(pool)
        .await?;
    let Some(connection) = connection else { return Ok(()); };
    let contacts = value.get("contacts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let messages = value.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for message in messages {
        let from = message.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let normalized_phone = normalize_phone(from);
        let text = get_inbound_text(&message);
        let media = get_media_content(&message);
        if text.is_none() && media.is_none() {
            continue;
        }
        let profile_name = contacts.iter().find(|contact| contact.get("wa_id").and_then(|v| v.as_str()) == Some(from))
            .and_then(|contact| contact.get("profile"))
            .and_then(|profile| profile.get("name"))
            .and_then(|v| v.as_str());
        let (conversation_id, unread_count, _last) =
            find_or_create_conversation(pool, &connection.id, &normalized_phone, profile_name).await?;
        let contact_id = {
            let existing = sqlx::query_scalar::<_, String>(
                r#"SELECT id FROM "WhatsappContact" WHERE "userId" = $1 AND phone = $2 LIMIT 1"#,
            )
            .bind(&connection.user_id)
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
                        INSERT INTO "WhatsappContact" (id, "userId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
                        VALUES ($1, $2, $3, $4, ARRAY[]::text[], false, false, NOW(), NOW())
                        "#,
                    )
                    .bind(&id)
                    .bind(&connection.user_id)
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

        let stop = text.as_deref().map(|t| ["stop","unsubscribe","cancel","end","optout","opt-out"].contains(&t.trim().to_lowercase().as_str())).unwrap_or(false);
        if stop {
            sqlx::query(r#"UPDATE "WhatsappContact" SET excluded = true, "optIn" = false, notes = $1, "updatedAt" = NOW() WHERE id = $2"#)
                .bind(format!("Unsubscribed via STOP keyword on {}", Utc::now().to_rfc3339()))
                .bind(&contact_id)
                .execute(pool)
                .await?;
            let campaign_ids = sqlx::query_scalar::<_, String>(
                r#"SELECT "campaignId" FROM "WhatsappCampaignRecipient" WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus")"#,
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
                WHERE "contactId" = $1 AND status IN ('PENDING'::"WhatsappRecipientStatus", 'QUEUED'::"WhatsappRecipientStatus")
                "#,
            )
            .bind(&contact_id)
            .execute(pool)
            .await?;
            for campaign_id in campaign_ids {
                recompute_campaign_stats(pool, &campaign_id).await?;
            }
        }
    }
    Ok(())
}

pub async fn process_webhook_payload(pool: &PgPool, payload: Value) -> Result<(), AppError> {
    let entries = payload.get("entry").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for entry in entries {
        let changes = entry.get("changes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for change in changes {
            let value = change.get("value").cloned().unwrap_or(Value::Null);
            let statuses = value.get("statuses").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            for status in statuses {
                handle_status(pool, &status).await?;
            }
            handle_incoming_messages(pool, &value).await?;
        }
    }
    Ok(())
}

async fn user_connection_ids(pool: &PgPool, user_id: &str) -> Result<Vec<String>, AppError> {
    sqlx::query_scalar::<_, String>(r#"SELECT id FROM "WhatsappConnection" WHERE "userId" = $1"#)
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

async fn scoped_conversation(pool: &PgPool, user_id: &str, conversation_id: &str) -> Result<Option<ConversationRow>, AppError> {
    let connection_ids = user_connection_ids(pool, user_id).await?;
    if connection_ids.is_empty() {
        return Ok(None);
    }
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,
               status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
               "unreadCount" AS unread_count,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation"
        WHERE id = $1
          AND channel = 'whatsapp'
          AND EXISTS (
            SELECT 1
            FROM unnest($2::text[]) AS connection_id
            WHERE "customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(&connection_ids)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)
}

async fn load_conversation_by_id(pool: &PgPool, conversation_id: &str) -> Result<Option<ConversationRow>, AppError> {
    sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,
               status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
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

async fn load_message_by_id(pool: &PgPool, message_id: &str) -> Result<Option<MessageRow>, AppError> {
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

async fn publish_event_best_effort(user_id: &str, event: Value) {
    if let Err(error) = realtime::publish_whatsapp_event(user_id, &event).await {
        log::warn!("failed to publish whatsapp realtime event: {}", error);
    }
}

async fn publish_conversation_updated(pool: &PgPool, user_id: &str, conversation_id: &str) -> Result<(), AppError> {
    let Some(conversation) = load_conversation_by_id(pool, conversation_id).await? else {
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
        user_id,
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
                "unreadCount": conversation.unread_count
            }
        }),
    )
    .await;
    Ok(())
}

async fn publish_message_created(pool: &PgPool, user_id: &str, message_id: &str) -> Result<(), AppError> {
    let Some(message) = load_message_by_id(pool, message_id).await? else {
        return Ok(());
    };
    let conversation = load_conversation_by_id(pool, &message.conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
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
        user_id,
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
    user_id: &str,
    conversation_id: &str,
    message_id: &str,
    whatsapp_status: &str,
    error_code: Option<&str>,
    error_message: Option<&str>,
) {
    publish_event_best_effort(
        user_id,
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

async fn publish_message_send_failed(user_id: &str, conversation_id: &str, error: &str, text: Option<&str>) {
    publish_event_best_effort(
        user_id,
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
            let inner = value.get("content").and_then(|v| v.as_str()).unwrap_or(content).to_string();
            let preview = value.get("replyPreview").and_then(|v| v.as_str()).map(|v| v.to_string());
            let reply_to = value
                .get("replyToWhatsappMessageId")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .or_else(|| value.get("replyToMessageId").and_then(|v| v.as_str()).map(|v| v.to_string()));
            return (inner, preview, reply_to);
        }
    }
    (content.to_string(), None, None)
}

fn parse_stored_media(content: &str) -> Option<Value> {
    const MEDIA_PREFIX: &str = "__kasiai_wa_media_v1__:";
    let (inner, _, _) = unwrap_reply_envelope(content);
    inner.strip_prefix(MEDIA_PREFIX).and_then(|raw| serde_json::from_str::<Value>(raw).ok())
}

fn parse_stored_reaction(content: &str) -> Option<Value> {
    const REACTION_PREFIX: &str = "__kasiai_wa_reaction_v1__:";
    let (inner, _, _) = unwrap_reply_envelope(content);
    inner.strip_prefix(REACTION_PREFIX).and_then(|raw| serde_json::from_str::<Value>(raw).ok())
}

fn display_text(content: &str) -> String {
    let (inner, _, _) = unwrap_reply_envelope(content);
    if let Some(reaction) = parse_stored_reaction(&inner) {
        let emoji = reaction.get("emoji").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        return if emoji.is_empty() { "Removed reaction".to_string() } else { format!("Reacted {}", emoji) };
    }
    if let Some(media) = parse_stored_media(&inner) {
        if let Some(caption) = media.get("caption").and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()) {
            return caption.to_string();
        }
        let kind = media.get("kind").and_then(|v| v.as_str()).unwrap_or("media");
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
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' { ch } else { '_' })
        .collect()
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
            "WhatsApp Cloud API text send failed ({}): {}",
            status,
            raw.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("Unknown error")
        )));
    }
    let message_id = raw.get("messages").and_then(|v| v.get(0)).and_then(|v| v.get("id")).and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("WhatsApp Cloud API text send did not return a message id".to_string()))?;
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

    Ok((job.user_id, job.conversation_id, job.id, Some(whatsapp_message_id)))
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
            publish_message_updated(&user_id, &conversation_id, &message_id, "SENT", None, None).await;
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
                &user_id,
                &conversation_id,
                &message_id,
                "FAILED",
                Some("SEND_FAILED"),
                Some(&error.to_string()),
            )
            .await;
            publish_message_send_failed(&user_id, &conversation_id, &error.to_string(), Some(&text)).await;
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
            raw.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("Unknown error")
        )));
    }
    Ok(raw)
}

async fn mark_message_read_api(phone_number_id: &str, access_token: &str, message_id: &str) -> Result<(), AppError> {
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
            raw.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("Unknown error")
        )));
    }
    Ok(())
}

async fn get_media_metadata(access_token: &str, media_id: &str) -> Result<(String, Option<String>), AppError> {
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
            raw.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("Unknown error")
        )));
    }
    let download_url = raw.get("url").and_then(|v| v.as_str()).ok_or_else(|| AppError::Internal("WhatsApp media lookup did not return a download URL".to_string()))?;
    let mime_type = raw.get("mime_type").and_then(|v| v.as_str()).map(|v| v.to_string());
    Ok((download_url.to_string(), mime_type))
}

async fn download_media_bytes(access_token: &str, media_id: &str) -> Result<(Vec<u8>, String), AppError> {
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
            if raw.is_empty() { "Unknown error" } else { &raw }
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

pub async fn list_inbox_conversations(pool: &PgPool, user_id: &str) -> Result<Value, AppError> {
    let connection_ids = user_connection_ids(pool, user_id).await?;
    if connection_ids.is_empty() {
        return Ok(json!({ "conversations": [] }));
    }
    let conversations = sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT
            id,
            channel,
            "customerIdentifier" AS customer_identifier,
            "customerName" AS customer_name,
            status,
            "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            "unreadCount" AS unread_count,
            "createdAt" AT TIME ZONE 'UTC' AS created_at,
            "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation"
        WHERE channel = 'whatsapp'
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) AS connection_id
            WHERE "customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        ORDER BY "lastMessageAt" DESC
        "#
    )
    .bind(&connection_ids)
    .fetch_all(pool)
    .await?;
    let mut result = Vec::with_capacity(conversations.len());
    for conversation in conversations {
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
        let last_message_content = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT content FROM "Message" WHERE "conversationId" = $1 ORDER BY timestamp DESC LIMIT 1"#,
        )
        .bind(&conversation.id)
        .fetch_optional(pool)
        .await?
        .flatten();
        result.push(json!({
            "id": conversation.id,
            "customerName": conversation.customer_name,
            "phone": phone,
            "status": conversation.status,
            "lastMessageAt": conversation.last_message_at,
            "unreadCount": conversation.unread_count,
            "connectionId": if connection_id.is_empty() { None::<String> } else { Some(connection_id) },
            "connectionLabel": connection_label,
            "lastMessage": last_message_content
                .as_deref()
                .map(|content| preview_text(content, 180))
                .unwrap_or_else(|| "No messages yet".to_string()),
        }));
    }
    Ok(json!({ "conversations": result }))
}

pub async fn inbox_unread_count(pool: &PgPool, user_id: &str) -> Result<Value, AppError> {
    let connection_ids = user_connection_ids(pool, user_id).await?;
    if connection_ids.is_empty() {
        return Ok(json!({ "unreadCount": 0 }));
    }
    let count = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        SELECT SUM("unreadCount")::bigint
        FROM "Conversation"
        WHERE channel = 'whatsapp'
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) AS connection_id
            WHERE "customerIdentifier" LIKE ('wa:' || connection_id || ':%')
          )
        "#
    )
    .bind(&connection_ids)
    .fetch_one(pool)
    .await?
    .unwrap_or(0);
    Ok(json!({ "unreadCount": count }))
}

pub async fn start_inbox_conversation(pool: &PgPool, user_id: &str, input: &WhatsappStartConversationRequest) -> Result<Value, AppError> {
    let connection_id = input.connection_id.as_deref().unwrap_or("");
    let template_id = input.template_id.as_deref().unwrap_or("");
    let normalized_phone = normalize_phone(input.phone.as_deref().unwrap_or(""));
    if connection_id.is_empty() || template_id.is_empty() || normalized_phone.is_empty() {
        return Err(AppError::BadRequest("Connection, template, and recipient phone are required".to_string()));
    }
    let connection = get_connection_row(pool, user_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("WhatsApp connection not found".to_string()))?;
    let template = sqlx::query_as::<_, WhatsappTemplateRow>(
        r#"
        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,
               language, category::text AS category, header, body, footer, buttons,
               "variablesCount" AS variables_count, status::text AS status,
               "lastSynced" AS last_synced, "createdAt" AS created_at, "updatedAt" AS updated_at
        FROM "WhatsappTemplate"
        WHERE id = $1 AND "userId" = $2 AND status = 'APPROVED'::"WhatsappTemplateStatus"
        LIMIT 1
        "#
    )
    .bind(template_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Approved template not found".to_string()))?;
    if template.connection_id.as_deref().is_some_and(|id| id != connection.id) {
        return Err(AppError::BadRequest("Selected template does not belong to this WhatsApp connection".to_string()));
    }
    let body_parameters = input.body_parameters.clone().unwrap_or_default();
    if body_parameters.len() as i32 != template.variables_count {
        return Err(AppError::BadRequest(format!(
            "This template expects {} variable{}.",
            template.variables_count,
            if template.variables_count == 1 { "" } else { "s" }
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
    let (conversation_id, _, _) = find_or_create_conversation(pool, &connection.id, &normalized_phone, input.customer_name.as_deref()).await?;
    let contact_id = if let Some(id) = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "WhatsappContact" WHERE "userId" = $1 AND phone = $2 LIMIT 1"#
    )
    .bind(user_id)
    .bind(&normalized_phone)
    .fetch_optional(pool)
    .await? {
        id
    } else {
        let id = cuid2::create_id();
        sqlx::query(
            r#"INSERT INTO "WhatsappContact" (id, "userId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, ARRAY[]::text[], false, false, NOW(), NOW())"#,
        )
        .bind(&id)
        .bind(user_id)
        .bind(&normalized_phone)
        .bind(input.customer_name.as_deref())
        .execute(pool)
        .await?;
        id
    };
    let rendered = template.body.clone().unwrap_or_else(|| "Template message sent.".to_string());
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

pub async fn list_conversation_messages(pool: &PgPool, user_id: &str, conversation_id: &str) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, user_id, conversation_id)
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
    let mapped = messages.into_iter().map(|message| {
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
    }).collect::<Vec<_>>();
    Ok(json!({ "messages": mapped }))
}

pub async fn send_conversation_message(pool: &PgPool, user_id: &str, conversation_id: &str, input: WhatsappSendMessageRequest) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, user_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    let text = input.text.as_deref().map(str::trim).filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::BadRequest("Reply text or media file is required".to_string()))?;
    parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let mut persisted_content = text.to_string();
    if let Some(reply_to_message_id) = input.reply_to_message_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
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
        let target_wa_id = reply_target.whatsapp_message_id.clone()
            .ok_or_else(|| AppError::BadRequest("This message cannot be replied to yet. Try again in a few seconds.".to_string()))?;
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
        "#
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
        log::warn!("failed to enqueue whatsapp inbox message {}: {}", created_message_id, error);
    }
    Ok(json!({ "success": true, "queued": true, "messageId": created_message_id }))
}

pub async fn mark_conversation_read(pool: &PgPool, user_id: &str, conversation_id: &str) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, user_id, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".to_string()))?;
    sqlx::query(r#"UPDATE "Conversation" SET "unreadCount" = 0, "lastReadAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#)
        .bind(&conversation.id)
        .execute(pool)
        .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row(pool, user_id, &connection_id).await?;
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
                        let _ = mark_message_read_api(&connection.phone_number_id, &access_token, wa_id).await;
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
    let ids = unread_messages.into_iter().map(|m| m.id).collect::<Vec<_>>();
    if !ids.is_empty() {
        sqlx::query(r#"UPDATE "Message" SET "whatsappStatus" = 'READ' WHERE id = ANY($1)"#)
            .bind(&ids)
            .execute(pool)
            .await?;
    }
    publish_conversation_updated(pool, user_id, &conversation.id).await?;
    Ok(json!({ "success": true }))
}

pub async fn send_message_reaction(pool: &PgPool, user_id: &str, conversation_id: &str, message_id: &str, input: WhatsappReactionRequest) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, user_id, conversation_id)
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
    let target_wa_id = target_message.whatsapp_message_id.clone()
        .ok_or_else(|| AppError::BadRequest("Target message is not available for reactions yet".to_string()))?;
    let (connection_id, phone) = parse_conversation_identifier(&conversation.customer_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation identifier".to_string()))?;
    let connection = get_connection_row(pool, user_id, &connection_id)
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
        "#
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

pub async fn delete_conversation_message(pool: &PgPool, user_id: &str, conversation_id: &str, message_id: &str) -> Result<Value, AppError> {
    let conversation = scoped_conversation(pool, user_id, conversation_id)
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

pub async fn download_message_media(pool: &PgPool, user_id: &str, message_id: &str) -> Result<actix_web::HttpResponse, AppError> {
    let connection_ids = user_connection_ids(pool, user_id).await?;
    if connection_ids.is_empty() {
        return Err(AppError::NotFound("Media message not found".to_string()));
    }
    let message = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT m.id, m."conversationId" AS conversation_id, m.sender, m.content, m."whatsappMessageId" AS whatsapp_message_id,
               m."whatsappStatus" AS whatsapp_status, m."errorCode" AS error_code, m."errorMessage" AS error_message, m.timestamp
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
    let media_id = media.get("mediaId").and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("Message does not contain media".to_string()))?;
    let conversation_identifier = sqlx::query_scalar::<_, String>(r#"SELECT "customerIdentifier" FROM "Conversation" WHERE id = $1"#)
        .bind(&message.conversation_id)
        .fetch_one(pool)
        .await?;
    let (connection_id, _) = parse_conversation_identifier(&conversation_identifier)
        .ok_or_else(|| AppError::BadRequest("Invalid conversation".to_string()))?;
    let connection = get_connection_row(pool, user_id, &connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
    let access_token = decrypt_social_secret(&connection.access_token_encrypted)?;
    let (bytes, content_type) = download_media_bytes(&access_token, media_id).await?;
    let extension = media.get("mimeType").and_then(|v| v.as_str()).and_then(|v| v.split('/').nth(1)).unwrap_or("bin");
    let fallback_name = format!("whatsapp-media-{}.{}", message.id, extension);
    let filename = sanitize_filename(media.get("filename").and_then(|v| v.as_str()).unwrap_or(&fallback_name));
    Ok(actix_web::HttpResponse::Ok()
        .append_header(("Content-Type", content_type))
        .append_header(("Content-Disposition", format!("inline; filename=\"{}\"", filename)))
        .append_header(("Cache-Control", "private, max-age=60"))
        .body(bytes))
}
