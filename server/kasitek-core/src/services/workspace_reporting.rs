//! Organization-scoped reporting projections for Agent Platform consumers.
//!
//! This module deliberately returns aggregate counts and status buckets only.
//! It is separate from the browser workspace summary because the Agent
//! boundary must not depend on a user session or call back into Agent Platform.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::error::AppError;

const CONNECTION_STATUS_SQL: &str = r#"
    SELECT status::text AS status, COUNT(*)::bigint AS count
    FROM "ExternalConnection"
    WHERE "orgId" = $1
    GROUP BY status
    ORDER BY status
"#;
const CONTENT_POST_COUNT_SQL: &str =
    r#"SELECT COUNT(*)::bigint FROM "SocialPost" WHERE "orgId" = $1"#;
const CONTACT_COUNT_SQL: &str =
    r#"SELECT COUNT(*)::bigint FROM "WhatsappContact" WHERE "orgId" = $1"#;
const OPTED_IN_CONTACT_COUNT_SQL: &str = r#"
    SELECT COUNT(DISTINCT "contactId")::bigint
    FROM "WhatsappContactListMembership"
    WHERE "orgId" = $1 AND "optIn" = true
"#;
const EXCLUDED_CONTACT_COUNT_SQL: &str = r#"
    SELECT COUNT(DISTINCT "contactId")::bigint
    FROM "WhatsappContactListMembership"
    WHERE "orgId" = $1 AND excluded = true
"#;
const CONVERSATION_COUNT_SQL: &str =
    r#"SELECT COUNT(*)::bigint FROM "Conversation" WHERE "orgId" = $1"#;
const UNREAD_CONVERSATION_COUNT_SQL: &str = r#"
    SELECT COUNT(*)::bigint
    FROM "Conversation"
    WHERE "orgId" = $1 AND "unreadCount" > 0
"#;
const BOOKING_STATUS_SQL: &str = r#"
    SELECT status::text AS status, COUNT(*)::bigint AS count
    FROM "Booking"
    WHERE "orgId" = $1
    GROUP BY status
    ORDER BY status
"#;
const CAMPAIGN_STATUS_SQL: &str = r#"
    SELECT status::text AS status, COUNT(*)::bigint AS count
    FROM "WhatsappCampaign"
    WHERE "orgId" = $1
    GROUP BY status
    ORDER BY status
"#;
const TEMPLATE_STATUS_SQL: &str = r#"
    SELECT status::text AS status, COUNT(*)::bigint AS count
    FROM "WhatsappTemplate"
    WHERE "orgId" = $1
    GROUP BY status
    ORDER BY status
"#;

#[cfg(test)]
const AGENT_REPORT_QUERIES: [&str; 10] = [
    CONNECTION_STATUS_SQL,
    CONTENT_POST_COUNT_SQL,
    CONTACT_COUNT_SQL,
    OPTED_IN_CONTACT_COUNT_SQL,
    EXCLUDED_CONTACT_COUNT_SQL,
    CONVERSATION_COUNT_SQL,
    UNREAD_CONVERSATION_COUNT_SQL,
    BOOKING_STATUS_SQL,
    CAMPAIGN_STATUS_SQL,
    TEMPLATE_STATUS_SQL,
];

fn status_buckets(rows: Vec<sqlx::postgres::PgRow>) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            json!({
                "status": row.get::<String, _>("status"),
                "count": row.get::<i64, _>("count"),
            })
        })
        .collect()
}

/// Return a redacted aggregate workspace report. Every query is explicitly
/// organization-scoped and no provider credentials, message bodies, contact
/// values, or user-specific filters are included.
pub async fn agent_report(pool: &PgPool, org_id: &str) -> Result<Value, AppError> {
    let (
        connection_status_rows,
        content_post_count,
        contact_count,
        opted_in_contact_count,
        excluded_contact_count,
        conversation_count,
        unread_conversation_count,
        booking_status_rows,
        campaign_status_rows,
        template_status_rows,
    ) = tokio::try_join!(
        sqlx::query(CONNECTION_STATUS_SQL)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query_scalar::<_, i64>(CONTENT_POST_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(CONTACT_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(OPTED_IN_CONTACT_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(EXCLUDED_CONTACT_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(CONVERSATION_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query_scalar::<_, i64>(UNREAD_CONVERSATION_COUNT_SQL)
            .bind(org_id)
            .fetch_one(pool),
        sqlx::query(BOOKING_STATUS_SQL).bind(org_id).fetch_all(pool),
        sqlx::query(CAMPAIGN_STATUS_SQL)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(TEMPLATE_STATUS_SQL)
            .bind(org_id)
            .fetch_all(pool),
    )?;

    Ok(json!({
        "organizationId": org_id,
        "connections": {
            "total": connection_status_rows.iter().map(|row| row.get::<i64, _>("count")).sum::<i64>(),
            "byStatus": status_buckets(connection_status_rows),
        },
        "content": { "postCount": content_post_count },
        "contacts": {
            "total": contact_count,
            "optedIn": opted_in_contact_count,
            "excluded": excluded_contact_count,
        },
        "inbox": {
            "conversationCount": conversation_count,
            "unreadConversationCount": unread_conversation_count,
        },
        "bookings": { "total": booking_status_rows.iter().map(|row| row.get::<i64, _>("count")).sum::<i64>(), "byStatus": status_buckets(booking_status_rows) },
        "campaigns": { "total": campaign_status_rows.iter().map(|row| row.get::<i64, _>("count")).sum::<i64>(), "byStatus": status_buckets(campaign_status_rows) },
        "templates": { "total": template_status_rows.iter().map(|row| row.get::<i64, _>("count")).sum::<i64>(), "byStatus": status_buckets(template_status_rows) },
    }))
}

#[cfg(test)]
mod tests {
    use super::AGENT_REPORT_QUERIES;

    #[test]
    fn every_agent_report_query_is_organization_scoped() {
        for query in AGENT_REPORT_QUERIES {
            assert!(
                query.contains("\"orgId\" = $1"),
                "agent report query is missing its organization boundary: {query}"
            );
        }
    }

    #[test]
    fn agent_report_queries_do_not_filter_by_acting_user() {
        for query in AGENT_REPORT_QUERIES {
            assert!(
                !query.contains("\"userId\""),
                "agent report query would hide shared records from team members: {query}"
            );
        }
    }
}
