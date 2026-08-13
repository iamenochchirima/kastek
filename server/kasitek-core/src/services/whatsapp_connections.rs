//! WhatsApp connection lifecycle and health boundary.
//!
//! Connection setup owns Meta/WABA discovery, encrypted token persistence,
//! webhook subscription, health checks, and organization-scoped connection
//! reads. The stable `whatsapp::` exports are retained for existing callers.

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::db::models::{WhatsappConnectionPublic, WhatsappConnectionRow};
use crate::error::AppError;
use crate::services::connections;
use crate::services::social::{decrypt_social_secret, encrypt_social_secret};

use super::whatsapp::{fetch_graph_json, GRAPH_BASE};
use super::whatsapp_templates::sync_connection_templates;

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
struct GraphSubscribedApps {
    data: Option<Vec<GraphApp>>,
}

#[derive(serde::Deserialize)]
struct GraphApp {
    id: Option<String>,
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

fn connection_label(phone: &GraphPhoneNumber, manual: Option<&str>) -> Option<String> {
    manual
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| phone.verified_name.clone())
        .or_else(|| phone.display_phone_number.clone())
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

pub(crate) fn select_connection_sql() -> &'static str {
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

async fn get_connection_row_for_org_including_inactive(
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

pub(crate) async fn get_connection_row_for_org(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Option<WhatsappConnectionRow>, AppError> {
    let row = get_connection_row_for_org_including_inactive(pool, org_id, connection_id).await?;
    if row.is_none() {
        return Ok(None);
    }
    if connections::source_is_connected(pool, org_id, "WHATSAPP", connection_id).await? {
        Ok(row)
    } else {
        Err(AppError::Conflict(
            "This WhatsApp connection is not active. Reconnect it from Connections.".to_string(),
        ))
    }
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
    .bind(
        estimate_daily_limit_from_tier(phone.messaging_limit_tier.as_deref())
            .unwrap_or(default_daily_limit()),
    )
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
    let webhook_error_message = webhook_result.as_ref().map(ToString::to_string);
    connections::record_source_health(
        pool,
        org_id,
        "WHATSAPP",
        &connection.id,
        webhook_result.is_none(),
        Some(if webhook_result.is_none() {
            "HEALTHY"
        } else {
            "FAILED"
        }),
        webhook_error_message.as_deref(),
    )
    .await?;
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

pub async fn refresh_connection(
    pool: &PgPool,
    org_id: &str,
    connection_id: &str,
) -> Result<Value, AppError> {
    let connection = get_connection_row_for_org_including_inactive(pool, org_id, connection_id)
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

    let refreshed = get_connection_row_for_org_including_inactive(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    connections::record_source_health(pool, org_id, "WHATSAPP", connection_id, true, None, None)
        .await?;
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
    let connection = get_connection_row_for_org_including_inactive(pool, org_id, connection_id)
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

    let updated = get_connection_row_for_org_including_inactive(pool, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::Internal("Failed to reload connection".to_string()))?;
    let webhook_error = subscribe_waba_webhook(access_token, &updated.waba_id)
        .await
        .err();
    let webhook_error_message = webhook_error.as_ref().map(ToString::to_string);
    connections::record_source_health(
        pool,
        org_id,
        "WHATSAPP",
        connection_id,
        webhook_error.is_none(),
        Some(if webhook_error.is_none() {
            "HEALTHY"
        } else {
            "FAILED"
        }),
        webhook_error_message.as_deref(),
    )
    .await?;

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
    let connection = get_connection_row_for_org_including_inactive(pool, org_id, connection_id)
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

    connections::record_source_health(
        pool,
        org_id,
        "WHATSAPP",
        connection_id,
        token_valid && webhook_subscribed,
        Some(if webhook_subscribed {
            "HEALTHY"
        } else {
            "FAILED"
        }),
        if token_valid && webhook_subscribed {
            None
        } else {
            Some("WhatsApp token validation or webhook subscription failed")
        },
    )
    .await?;

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
