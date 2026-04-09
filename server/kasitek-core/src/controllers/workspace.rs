use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;

use crate::error::AppError;
use crate::middleware::extract_user;
use crate::services::whatsapp;

pub async fn summary(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user = extract_user(&req, pool.get_ref()).await?;
    let user_id = user.id;

    let now = Utc::now();
    let since_30_days = now - Duration::days(30);
    let since_24_hours = now - Duration::hours(24);

    let connections = whatsapp::list_connections(pool.get_ref(), &user_id).await?;

    let (
        bot_count,
        social_post_count,
        template_status_rows,
        campaign_summary_row,
        active_campaigns,
        recent_campaign_rows,
        total_contacts,
        opted_in_contacts,
        excluded_contacts,
        send_breakdown_rows,
        review_queue_rows,
        campaign_send_rows,
    ) = tokio::try_join!(
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "BotConfiguration" WHERE "userId" = $1"#)
            .bind(&user_id)
            .fetch_one(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "SocialPost" WHERE "userId" = $1"#)
            .bind(&user_id)
            .fetch_one(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT status::text AS status, COUNT(*) AS count
            FROM "WhatsappTemplate"
            WHERE "userId" = $1
            GROUP BY status
            "#,
        )
        .bind(&user_id)
        .fetch_all(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT
                COUNT(*) AS total_campaigns,
                COALESCE(SUM("totalRecipients"), 0) AS total_recipients,
                COALESCE(SUM("deliveredCount"), 0) AS delivered_count,
                COALESCE(SUM("readCount"), 0) AS read_count,
                COALESCE(SUM("failedCount"), 0) AS failed_count,
                COALESCE(SUM("blockedCount"), 0) AS blocked_count
            FROM "WhatsappCampaign"
            WHERE "userId" = $1
            "#,
        )
        .bind(&user_id)
        .fetch_one(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*) FROM "WhatsappCampaign"
            WHERE "userId" = $1
              AND status IN (
                'DRAFT'::"WhatsappCampaignStatus",
                'SCHEDULED'::"WhatsappCampaignStatus",
                'SENDING'::"WhatsappCampaignStatus",
                'PAUSED'::"WhatsappCampaignStatus"
              )
            "#,
        )
        .bind(&user_id)
        .fetch_one(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT
                c.id,
                c.name,
                c.status::text AS status,
                c."totalRecipients" AS total_recipients,
                c."deliveredCount" AS delivered_count,
                c."readCount" AS read_count,
                c."templateName" AS template_name,
                COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label
            FROM "WhatsappCampaign" c
            LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
            WHERE c."userId" = $1
            ORDER BY c."updatedAt" DESC
            LIMIT 5
            "#,
        )
        .bind(&user_id)
        .fetch_all(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM "WhatsappContact" WHERE "userId" = $1"#)
            .bind(&user_id)
            .fetch_one(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "WhatsappContact" WHERE "userId" = $1 AND "optIn" = true"#,
        )
        .bind(&user_id)
        .fetch_one(pool.get_ref()),
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM "WhatsappContact" WHERE "userId" = $1 AND excluded = true"#,
        )
        .bind(&user_id)
        .fetch_one(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT status::text AS status, COUNT(*) AS count
            FROM "WhatsappSendEvent"
            WHERE "userId" = $1 AND "createdAt" >= $2
            GROUP BY status
            "#,
        )
        .bind(&user_id)
        .bind(since_30_days)
        .fetch_all(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT
                t.id,
                t."templateName" AS template_name,
                t.status::text AS status,
                t.body,
                COALESCE(c."phoneDisplayNumber", c."phoneNumberId") AS connection_label
            FROM "WhatsappTemplate" t
            LEFT JOIN "WhatsappConnection" c ON c.id = t."connectionId"
            WHERE t."userId" = $1
              AND t.status IN ('PENDING'::"WhatsappTemplateStatus", 'REJECTED'::"WhatsappTemplateStatus")
            ORDER BY t."updatedAt" DESC
            LIMIT 4
            "#,
        )
        .bind(&user_id)
        .fetch_all(pool.get_ref()),
        sqlx::query(
            r#"
            SELECT c."connectionId" AS connection_id, COUNT(*) AS count
            FROM "WhatsappCampaignRecipient" r
            JOIN "WhatsappCampaign" c ON c.id = r."campaignId"
            WHERE c."userId" = $1
              AND r."sentAt" >= $2
            GROUP BY c."connectionId"
            "#,
        )
        .bind(&user_id)
        .bind(since_24_hours)
        .fetch_all(pool.get_ref()),
    )?;

    let template_status_map = template_status_rows
        .into_iter()
        .map(|row| (row.get::<String, _>("status"), row.get::<i64, _>("count")))
        .collect::<HashMap<_, _>>();

    let send_status_map = send_breakdown_rows
        .into_iter()
        .map(|row| (row.get::<String, _>("status"), row.get::<i64, _>("count")))
        .collect::<HashMap<_, _>>();

    let sent_by_connection = campaign_send_rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("connection_id"),
                row.get::<i64, _>("count"),
            )
        })
        .collect::<HashMap<_, _>>();

    let connections = connections
        .into_iter()
        .map(|connection| {
            let sent_last_24h = *sent_by_connection.get(&connection.id).unwrap_or(&0);
            json!({
                "id": connection.id,
                "phoneDisplayNumber": connection.phone_display_number,
                "phoneNumberId": connection.phone_number_id,
                "currentQualityRating": connection.current_quality_rating,
                "dailyLimitEstimate": connection.daily_limit_estimate,
                "verified": connection.verified,
                "createdAt": connection.created_at,
                "stats": {
                    "sentLast24h": sent_last_24h,
                    "estimatedRemainingToday": connection.daily_limit_estimate.map(|limit| std::cmp::max(limit - sent_last_24h as i32, 0)),
                }
            })
        })
        .collect::<Vec<_>>();

    let recent_campaigns = recent_campaign_rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name"),
                "status": row.get::<String, _>("status"),
                "totalRecipients": row.get::<i32, _>("total_recipients"),
                "deliveredCount": row.get::<i32, _>("delivered_count"),
                "readCount": row.get::<i32, _>("read_count"),
                "templateName": row.get::<String, _>("template_name"),
                "connectionLabel": row.get::<Option<String>, _>("connection_label"),
            })
        })
        .collect::<Vec<_>>();

    let review_queue = review_queue_rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "templateName": row.get::<String, _>("template_name"),
                "status": row.get::<String, _>("status"),
                "body": row.get::<Option<String>, _>("body"),
                "connectionLabel": row.get::<Option<String>, _>("connection_label"),
            })
        })
        .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(json!({
        "summary": {
            "botCount": bot_count,
            "socialPostCount": social_post_count,
            "connections": connections,
            "templateStatusMap": template_status_map,
            "campaignsAggregate": {
                "totalCampaigns": campaign_summary_row.get::<i64, _>("total_campaigns"),
                "totalRecipients": campaign_summary_row.get::<i64, _>("total_recipients"),
                "deliveredCount": campaign_summary_row.get::<i64, _>("delivered_count"),
                "readCount": campaign_summary_row.get::<i64, _>("read_count"),
                "failedCount": campaign_summary_row.get::<i64, _>("failed_count"),
                "blockedCount": campaign_summary_row.get::<i64, _>("blocked_count"),
            },
            "activeCampaigns": active_campaigns,
            "recentCampaigns": recent_campaigns,
            "contactsAggregate": {
                "total": total_contacts,
                "optedIn": opted_in_contacts,
                "excluded": excluded_contacts,
            },
            "sendStatusMap": send_status_map,
            "reviewQueue": review_queue,
        }
    })))
}
