//! Safe, bounded platform activity for Admin investigation.
//!
//! Activity is intentionally separate from analytics: aggregates answer how much happened while
//! this endpoint answers what happened and when. Only indexed identifiers and validated metadata
//! are returned; message bodies, prompts, provider payloads, credentials, and payment secrets are
//! never part of this projection.

use std::collections::{HashSet, VecDeque};

use actix_web::{web, HttpRequest, HttpResponse};
use async_stream::stream as async_stream;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::{
    controllers::admin_analytics::{authorize_analytics, report_window},
    error::AppError,
    middleware::extract_admin,
};

const DEFAULT_LIMIT: i64 = 40;
const MAX_LIMIT: i64 = 100;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityQuery {
    pub days: Option<i64>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub domain: Option<String>,
    pub action: Option<String>,
    pub status: Option<String>,
    pub severity: Option<String>,
    pub organization_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityResponse {
    items: Vec<ActivityItem>,
    next_cursor: Option<String>,
    has_more: bool,
    data_as_of: DateTime<Utc>,
    source: &'static str,
    coverage: &'static str,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActivityItem {
    id: String,
    occurred_at: DateTime<Utc>,
    source: String,
    domain: String,
    action: String,
    status: String,
    severity: String,
    actor_type: Option<String>,
    actor_id: Option<String>,
    organization_id: Option<String>,
    resource_type: String,
    resource_id: String,
    correlation_id: Option<String>,
    metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
struct Cursor {
    occurred_at: DateTime<Utc>,
    id: String,
}

pub async fn list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ActivityQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    validate_query(&query)?;
    let (start, end, _) = report_window(query.days)?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    let cursor = decode_cursor(query.cursor.as_deref());
    let rows = query_rows(
        pool.get_ref(),
        &query,
        start,
        end,
        cursor.as_ref(),
        limit + 1,
    )
    .await?;
    let has_more = rows.len() as i64 > limit;
    let items = if has_more {
        rows[..limit as usize].to_vec()
    } else {
        rows
    };
    let next_cursor = if has_more {
        items
            .last()
            .map(|item| encode_cursor(item.occurred_at, &item.id))
    } else {
        None
    };

    Ok(HttpResponse::Ok().json(ActivityResponse {
        items,
        next_cursor,
        has_more,
        data_as_of: Utc::now(),
        source: "core_authoritative",
        coverage: "Core immutable and transactional event records; projection-backed Agent Platform events are not included yet",
    }))
}

/// A bounded SSE stream. The database query remains the source of truth; the stream only reduces
/// polling latency for events already committed to Core. Reconnects can fall back to the cursor
/// endpoint without losing the selected filters.
pub async fn stream(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ActivityQuery>,
) -> Result<HttpResponse, AppError> {
    let admin = extract_admin(&req, pool.get_ref()).await?;
    authorize_analytics(&req, pool.get_ref(), &admin).await?;
    validate_query(&query)?;
    let query = query.into_inner();
    let pool = pool.get_ref().clone();
    let output = async_stream! {
        let mut seen = HashSet::<String>::new();
        let mut seen_order = VecDeque::<String>::new();
        loop {
            let (start, end, _) = match report_window(query.days) {
                Ok(value) => value,
                Err(error) => {
                    let payload = json!({"error": error.to_string()});
                    yield Ok::<Bytes, actix_web::Error>(Bytes::from(format!("event: error\ndata: {}\n\n", payload)));
                    break;
                }
            };
            let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
            match query_rows(&pool, &query, start, end, None, limit).await {
                Ok(items) => {
                    for item in items.into_iter().rev() {
                        if !seen.insert(item.id.clone()) {
                            continue;
                        }
                        seen_order.push_back(item.id.clone());
                        if seen_order.len() > 500 {
                            if let Some(expired) = seen_order.pop_front() {
                                seen.remove(&expired);
                            }
                        }
                        match serde_json::to_string(&item) {
                            Ok(payload) => yield Ok::<Bytes, actix_web::Error>(Bytes::from(format!("event: activity\ndata: {payload}\n\n"))),
                            Err(error) => yield Err(actix_web::error::ErrorInternalServerError(error)),
                        }
                    }
                    yield Ok::<Bytes, actix_web::Error>(Bytes::from(": heartbeat\n\n"));
                }
                Err(error) => {
                    let payload = json!({"error": error.to_string()});
                    yield Ok::<Bytes, actix_web::Error>(Bytes::from(format!("event: error\ndata: {payload}\n\n")));
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    };
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache, no-transform"))
        .insert_header(("Connection", "keep-alive"))
        .streaming(output))
}

fn validate_query(query: &ActivityQuery) -> Result<(), AppError> {
    if query
        .limit
        .is_some_and(|value| !(1..=MAX_LIMIT).contains(&value))
    {
        return Err(AppError::BadRequest(format!(
            "Activity limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    for (label, value) in [
        ("domain", query.domain.as_deref()),
        ("action", query.action.as_deref()),
        ("status", query.status.as_deref()),
        ("severity", query.severity.as_deref()),
        ("organizationId", query.organization_id.as_deref()),
    ] {
        if value.is_some_and(|value| value.trim().is_empty() || value.len() > 160) {
            return Err(AppError::BadRequest(format!(
                "Activity {label} filter is invalid"
            )));
        }
    }
    if query
        .cursor
        .as_deref()
        .is_some_and(|value| decode_cursor(Some(value)).is_none())
    {
        return Err(AppError::BadRequest(
            "Activity cursor is invalid".to_string(),
        ));
    }
    Ok(())
}

async fn query_rows(
    pool: &PgPool,
    query: &ActivityQuery,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    cursor: Option<&Cursor>,
    limit: i64,
) -> Result<Vec<ActivityItem>, AppError> {
    let rows = sqlx::query(
        r#"
        WITH events AS (
          SELECT
            usage.id,
            (usage."occurredAt" AT TIME ZONE 'UTC') AS occurred_at,
            'core'::text AS source,
            'usage'::text AS domain,
            usage."metricKey"::text AS action,
            'RECORDED'::text AS status,
            'info'::text AS severity,
            'system'::text AS actor_type,
            NULL::text AS actor_id,
            usage."orgId" AS organization_id,
            'usage_event'::text AS resource_type,
            usage.id AS resource_id,
            NULL::text AS correlation_id,
            jsonb_build_object('productKey', usage."productKey", 'quantity', usage.quantity) AS metadata
          FROM "UsageEvent" usage
          WHERE usage."occurredAt" >= $1 AND usage."occurredAt" < $2
          UNION ALL
          SELECT conversation.id, (conversation."createdAt" AT TIME ZONE 'UTC'), 'core', 'conversations', 'conversation.created', UPPER(conversation.status), 'info', 'system', NULL, conversation."orgId", 'conversation', conversation.id, NULL, jsonb_build_object('channel', conversation.channel)
          FROM "Conversation" conversation
          WHERE conversation."orgId" IS NOT NULL AND conversation."createdAt" >= $1 AND conversation."createdAt" < $2
          UNION ALL
          SELECT message.id, (message."timestamp" AT TIME ZONE 'UTC'), 'core', 'messaging', CASE WHEN message.sender = 'bot' THEN 'message.sent' ELSE 'message.received' END, 'RECORDED', 'info', message.sender, NULL, conversation."orgId", 'message', message.id, NULL, jsonb_build_object('channel', conversation.channel, 'sender', message.sender, 'contentType', message."contentType")
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2
          UNION ALL
          SELECT send.id, (send."createdAt" AT TIME ZONE 'UTC'), 'core', 'campaigns', 'campaign.message', send.status::text, CASE WHEN send.status::text IN ('FAILED', 'BLOCKED') THEN 'error' ELSE 'info' END, 'system', NULL, send."orgId", 'whatsapp_send_event', send.id, NULL, jsonb_build_object('campaignId', send."campaignId", 'templateName', send."templateName")
          FROM "WhatsappSendEvent" send
          WHERE send."orgId" IS NOT NULL AND send."createdAt" >= $1 AND send."createdAt" < $2
          UNION ALL
          SELECT job.id, (job."createdAt" AT TIME ZONE 'UTC'), 'core', 'content', 'content.publish', job.status::text, CASE WHEN job.status::text = 'FAILED' THEN 'error' ELSE 'info' END, 'system', NULL, job."orgId", 'social_publish_job', job.id, NULL, jsonb_build_object('platform', job.platform::text)
          FROM "SocialPublishJob" job
          WHERE job."orgId" IS NOT NULL AND job."createdAt" >= $1 AND job."createdAt" < $2
          UNION ALL
          SELECT checkout.id, (checkout."updatedAt" AT TIME ZONE 'UTC'), 'core', 'billing', 'billing.checkout', checkout.status, CASE WHEN checkout.status IN ('FAILED', 'ABANDONED') THEN 'error' ELSE 'info' END, 'system', NULL, checkout."orgId", 'billing_checkout', checkout.id, NULL, jsonb_build_object('provider', checkout.provider, 'reference', checkout.reference)
          FROM "BillingCheckout" checkout
          WHERE checkout."updatedAt" >= $1 AND checkout."updatedAt" < $2
          UNION ALL
          SELECT invoice.id, (invoice."issuedAt" AT TIME ZONE 'UTC'), 'core', 'billing', 'billing.invoice', invoice.status, CASE WHEN invoice.status IN ('FAILED', 'VOID', 'REFUNDED') THEN 'warning' ELSE 'info' END, 'system', NULL, invoice."orgId", 'billing_invoice', invoice.id, NULL, jsonb_build_object('invoiceNumber', invoice."invoiceNumber", 'currency', invoice.currency, 'amountMinor', invoice."amountMinor")
          FROM "BillingInvoice" invoice
          WHERE invoice."issuedAt" >= $1 AND invoice."issuedAt" < $2
          UNION ALL
          SELECT webhook.id, (webhook."receivedAt" AT TIME ZONE 'UTC'), 'core', 'billing', webhook."eventType", webhook.status, CASE WHEN webhook.status IN ('FAILED', 'ERROR') THEN 'error' ELSE 'info' END, 'provider', NULL, NULL, 'paystack_webhook', webhook.id, NULL, jsonb_build_object('provider', 'paystack')
          FROM "PaystackWebhookEvent" webhook
          WHERE webhook."receivedAt" >= $1 AND webhook."receivedAt" < $2
          UNION ALL
          SELECT ledger.id, (ledger."createdAt" AT TIME ZONE 'UTC'), 'core', 'credits', ledger.type, 'RECORDED', CASE WHEN ledger.amount < 0 THEN 'warning' ELSE 'info' END, COALESCE(ledger."sourceType", 'system'), ledger."createdByAdminId", ledger."orgId", 'credit_ledger_entry', ledger.id, NULL, jsonb_build_object('amount', ledger.amount, 'sourceType', ledger."sourceType")
          FROM "CreditLedgerEntry" ledger
          WHERE ledger."createdAt" >= $1 AND ledger."createdAt" < $2
          UNION ALL
          SELECT notification.id, (notification."createdAt" AT TIME ZONE 'UTC'), 'core', 'notifications', notification."eventType", notification.severity::text, LOWER(notification.severity::text), notification."actorType", notification."actorId", NULL, 'notification_event', notification.id, NULL, jsonb_build_object('entityType', notification."entityType", 'entityId', notification."entityId")
          FROM "NotificationEvent" notification
          WHERE notification."createdAt" >= $1 AND notification."createdAt" < $2
          UNION ALL
          SELECT audit.id, (audit."createdAt" AT TIME ZONE 'UTC'), 'core', 'security', audit.action, 'RECORDED', 'warning', 'admin', audit."actorId", access_grant."organizationId", 'support_access_audit', audit.id, NULL, jsonb_build_object('resourceType', access_grant."resourceType", 'resourceId', access_grant."resourceId")
          FROM "AdminSupportAccessAuditEvent" audit JOIN "AdminSupportAccessGrant" access_grant ON access_grant.id = audit."grantId"
          WHERE audit."createdAt" >= $1 AND audit."createdAt" < $2
          UNION ALL
          SELECT audit.id, (audit."createdAt" AT TIME ZONE 'UTC'), 'core', 'security', audit.action, 'RECORDED', 'warning', 'admin', audit."actorId", NULL, 'webhook_replay_audit', audit.id, NULL, jsonb_build_object('commandId', audit."commandId")
          FROM "AdminWebhookReplayAuditEvent" audit
          WHERE audit."createdAt" >= $1 AND audit."createdAt" < $2
          UNION ALL
          SELECT issue.id, (issue."detectedAt" AT TIME ZONE 'UTC'), 'core', 'data_quality', issue."issueType", issue.status, CASE WHEN issue.status = 'OPEN' THEN 'critical' ELSE 'info' END, 'system', NULL, issue."orgId", 'billing_reconciliation_issue', issue.id, NULL, jsonb_build_object('resourceType', issue."resourceType", 'provider', issue.provider)
          FROM "BillingReconciliationIssue" issue
          WHERE issue."detectedAt" >= $1 AND issue."detectedAt" < $2
          UNION ALL
          SELECT export.id, (export."createdAt" AT TIME ZONE 'UTC'), 'core', 'reports', 'report.export', export.status, 'info', 'admin', export."adminId", NULL, 'report_export', export.id, NULL, jsonb_build_object('reportKey', export."reportKey", 'days', export.days, 'format', export.format)
          FROM "AdminReportExportAuditEvent" export
          WHERE export."createdAt" >= $1 AND export."createdAt" < $2
        )
        SELECT id, occurred_at, source, domain, action, status, severity, actor_type, actor_id,
          organization_id, resource_type, resource_id, correlation_id, metadata
        FROM events
        WHERE ($3::timestamptz IS NULL OR occurred_at < $3 OR (occurred_at = $3 AND id < COALESCE($4, '')))
          AND ($5::text IS NULL OR domain = $5)
          AND ($6::text IS NULL OR action = $6)
          AND ($7::text IS NULL OR status = $7)
          AND ($8::text IS NULL OR severity = $8)
          AND ($9::text IS NULL OR organization_id = $9)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $10
        "#,
    )
    .bind(start.naive_utc())
    .bind(end.naive_utc())
    .bind(cursor.map(|value| value.occurred_at))
    .bind(cursor.map(|value| value.id.as_str()))
    .bind(query.domain.as_deref())
    .bind(query.action.as_deref())
    .bind(query.status.as_deref())
    .bind(query.severity.as_deref())
    .bind(query.organization_id.as_deref())
    .bind(limit)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            Ok(ActivityItem {
                id: row.try_get("id")?,
                occurred_at: row.try_get("occurred_at")?,
                source: row.try_get("source")?,
                domain: row.try_get("domain")?,
                action: row.try_get("action")?,
                status: row.try_get("status")?,
                severity: row.try_get("severity")?,
                actor_type: row.try_get("actor_type")?,
                actor_id: row.try_get("actor_id")?,
                organization_id: row.try_get("organization_id")?,
                resource_type: row.try_get("resource_type")?,
                resource_id: row.try_get("resource_id")?,
                correlation_id: row.try_get("correlation_id")?,
                metadata: row.try_get("metadata")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}

fn encode_cursor(occurred_at: DateTime<Utc>, id: &str) -> String {
    STANDARD.encode(format!("{}|{}", occurred_at.to_rfc3339(), id))
}

fn decode_cursor(value: Option<&str>) -> Option<Cursor> {
    let value = value?;
    let raw = STANDARD.decode(value).ok()?;
    let raw = String::from_utf8(raw).ok()?;
    let separator = raw.rfind('|')?;
    let occurred_at = DateTime::parse_from_rfc3339(&raw[..separator])
        .ok()?
        .with_timezone(&Utc);
    Some(Cursor {
        occurred_at,
        id: raw[separator + 1..].to_string(),
    })
}
