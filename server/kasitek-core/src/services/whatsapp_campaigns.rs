//! WhatsApp campaign lifecycle and delivery worker boundary.
//!
//! Campaign creation, recipient snapshots, lifecycle transitions, delivery
//! claims, provider sends, retries, and reconciliation live here while the
//! stable `whatsapp::` exports remain available to existing callers.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;

use crate::analytics;
use crate::db::models::{
    WhatsappCampaignCreateRequest, WhatsappCampaignRecipientDetailRow,
    WhatsappCampaignRecipientRow, WhatsappCampaignRow, WhatsappConnectionRow, WhatsappContactRow,
    WhatsappTemplateRow,
};
use crate::error::AppError;
use crate::services::billing;
use crate::services::social::decrypt_social_secret;

use super::whatsapp::{
    campaign_processing_timeout, contact_eligible, contact_matches_audience,
    get_connection_row_for_org, metadata_string, parse_scheduled_at, publish_campaign_updated,
    sanitize_list_label, select_campaign_contact_row, select_connection_sql, whatsapp_http_client,
    GRAPH_BASE,
};
pub(crate) async fn get_campaign_row(
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

pub(crate) fn build_body_parameters(
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

pub(crate) async fn send_marketing_template(
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
        let occurred_at = Utc::now();
        let mut transaction = pool.begin().await?;
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
        .execute(&mut *transaction)
        .await?;
        analytics::campaigns::enqueue_recipient_sent(
            &mut transaction,
            org_id,
            &recipient.campaign_id,
            recipient_id,
            "whatsapp",
            "meta",
            occurred_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!("Failed to queue Campaign analytics fact: {error}"))
        })?;
        transaction.commit().await?;

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
            let occurred_at = Utc::now();
            let mut transaction = pool.begin().await?;
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
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"UPDATE "WhatsappContact" SET "lastMarketingSent" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
            )
            .bind(&contact.id)
            .execute(&mut *transaction)
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
            .execute(&mut *transaction)
            .await?;
            analytics::campaigns::enqueue_recipient_sent(
                &mut transaction,
                org_id,
                &campaign.id,
                recipient_id,
                "whatsapp",
                "meta",
                occurred_at,
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!("Failed to queue Campaign analytics fact: {error}"))
            })?;
            transaction.commit().await?;

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
