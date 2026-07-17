use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::error::AppError;

pub fn whatsapp_identity_key(phone: &str) -> String {
    format!("whatsapp:{}", phone.trim())
}

pub fn meta_identity_key(channel: &str, scope_id: &str, external_id: &str) -> String {
    format!(
        "{}:{}:{}",
        channel.trim().to_ascii_lowercase(),
        scope_id.trim(),
        external_id.trim()
    )
}

async fn organization_customer(
    pool: &PgPool,
    org_id: &str,
    customer_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM "Customer" WHERE id = $1 AND "orgId" = $2 LIMIT 1"#,
    )
    .bind(customer_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn ensure_customer_identity(
    pool: &PgPool,
    org_id: &str,
    channel: &str,
    scope_id: Option<&str>,
    external_id: &str,
    identity_key: &str,
    display_name: Option<&str>,
    preferred_customer_id: Option<&str>,
) -> Result<String, AppError> {
    let display_name = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(customer_id) = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "CustomerIdentity"
        SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
        WHERE "orgId" = $2 AND "identityKey" = $3
        RETURNING "customerId"
        "#,
    )
    .bind(display_name)
    .bind(org_id)
    .bind(identity_key)
    .fetch_optional(pool)
    .await?
    {
        sqlx::query(
            r#"
            UPDATE "Customer"
            SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
            WHERE id = $2 AND "orgId" = $3
            "#,
        )
        .bind(display_name)
        .bind(&customer_id)
        .bind(org_id)
        .execute(pool)
        .await?;
        return Ok(customer_id);
    }

    let preferred_customer_id = match preferred_customer_id {
        Some(customer_id) => organization_customer(pool, org_id, customer_id).await?,
        None => None,
    };
    let created_customer_id = preferred_customer_id.is_none().then(cuid2::create_id);
    let customer_id = preferred_customer_id
        .as_ref()
        .or(created_customer_id.as_ref())
        .expect("a preferred or generated customer id must be available");

    if created_customer_id.is_some() {
        sqlx::query(
            r#"
            INSERT INTO "Customer" (id, "orgId", "displayName", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, NOW(), NOW())
            "#,
        )
        .bind(customer_id)
        .bind(org_id)
        .bind(display_name)
        .execute(pool)
        .await?;
    }

    let identity_id = cuid2::create_id();
    let resolved_customer_id = sqlx::query_scalar::<_, String>(
        r#"
        INSERT INTO "CustomerIdentity" (
            id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey",
            "displayName", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT ("orgId", "identityKey") DO UPDATE SET
            "displayName" = COALESCE("CustomerIdentity"."displayName", EXCLUDED."displayName"),
            "updatedAt" = NOW()
        RETURNING "customerId"
        "#,
    )
    .bind(identity_id)
    .bind(org_id)
    .bind(customer_id)
    .bind(channel)
    .bind(scope_id)
    .bind(external_id)
    .bind(identity_key)
    .bind(display_name)
    .fetch_one(pool)
    .await?;

    if created_customer_id
        .as_deref()
        .is_some_and(|created_id| created_id != resolved_customer_id)
    {
        sqlx::query(
            r#"
            DELETE FROM "Customer"
            WHERE id = $1 AND "orgId" = $2
              AND NOT EXISTS (
                SELECT 1 FROM "CustomerIdentity" identity WHERE identity."customerId" = $1
              )
            "#,
        )
        .bind(customer_id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE "Customer"
        SET "displayName" = COALESCE("displayName", $1), "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(display_name)
    .bind(&resolved_customer_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    Ok(resolved_customer_id)
}

pub async fn ensure_whatsapp_customer(
    pool: &PgPool,
    org_id: &str,
    phone: &str,
    display_name: Option<&str>,
    preferred_customer_id: Option<&str>,
) -> Result<String, AppError> {
    ensure_customer_identity(
        pool,
        org_id,
        "whatsapp",
        None,
        phone,
        &whatsapp_identity_key(phone),
        display_name,
        preferred_customer_id,
    )
    .await
}

pub async fn ensure_meta_customer(
    pool: &PgPool,
    org_id: &str,
    channel: &str,
    scope_id: &str,
    external_id: &str,
    display_name: Option<&str>,
) -> Result<String, AppError> {
    ensure_customer_identity(
        pool,
        org_id,
        channel,
        Some(scope_id),
        external_id,
        &meta_identity_key(channel, scope_id, external_id),
        display_name,
        None,
    )
    .await
}

pub async fn link_whatsapp_contact(
    pool: &PgPool,
    org_id: &str,
    contact_id: &str,
    phone: &str,
    display_name: Option<&str>,
) -> Result<String, AppError> {
    let preferred_customer_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "customerId"
        FROM "WhatsappContact"
        WHERE id = $1 AND "orgId" = $2 AND "customerId" IS NOT NULL
        LIMIT 1
        "#,
    )
    .bind(contact_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?;
    let customer_id = ensure_whatsapp_customer(
        pool,
        org_id,
        phone,
        display_name,
        preferred_customer_id.as_deref(),
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE "WhatsappContact"
        SET "customerId" = $1, "updatedAt" = NOW()
        WHERE id = $2 AND "orgId" = $3
        "#,
    )
    .bind(&customer_id)
    .bind(contact_id)
    .bind(org_id)
    .execute(pool)
    .await?;

    Ok(customer_id)
}

const CUSTOMER_DETAIL_QUERIES: [&str; 6] = [
    r#"
        SELECT id, "displayName" AS display_name, metadata,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Customer"
        WHERE id = $1 AND "orgId" = $2
        LIMIT 1
    "#,
    r#"
        SELECT id, channel, "scopeId" AS scope_id, "externalId" AS external_id,
               "displayName" AS display_name, metadata,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "CustomerIdentity"
        WHERE "customerId" = $1 AND "orgId" = $2
        ORDER BY channel ASC, "createdAt" ASC
    "#,
    r#"
        SELECT id, phone, "fullName" AS full_name, COALESCE(tags, ARRAY[]::text[]) AS tags,
               "listLabel" AS list_label, "optIn" AS opt_in, "optInSource" AS opt_in_source,
               "optInDate" AT TIME ZONE 'UTC' AS opt_in_date, excluded, notes,
               "lastMarketingSent" AT TIME ZONE 'UTC' AS last_marketing_sent
        FROM "WhatsappContact"
        WHERE "customerId" = $1 AND "orgId" = $2
        ORDER BY "updatedAt" DESC
    "#,
    r#"
        SELECT conversation.id, conversation.channel,
               conversation."customerIdentifier" AS customer_identifier,
               conversation."customerName" AS customer_name,
               conversation.status,
               conversation."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               conversation."unreadCount" AS unread_count,
               connection."displayName" AS connection_label
        FROM "Conversation" conversation
        LEFT JOIN "ExternalConnection" connection
          ON connection.id = conversation."externalConnectionId"
         AND connection."orgId" = conversation."orgId"
        WHERE conversation."customerId" = $1 AND conversation."orgId" = $2
        ORDER BY conversation."lastMessageAt" DESC
        LIMIT 25
    "#,
    r#"
        SELECT campaign.id, campaign.name, campaign.status::text AS status,
               campaign."templateName" AS template_name,
               campaign."sentCount" AS sent_count,
               campaign."deliveredCount" AS delivered_count,
               campaign."readCount" AS read_count,
               MAX(recipient."sentAt") AT TIME ZONE 'UTC' AS last_sent_at
        FROM "WhatsappCampaignRecipient" recipient
        JOIN "WhatsappContact" contact ON contact.id = recipient."contactId"
        JOIN "WhatsappCampaign" campaign ON campaign.id = recipient."campaignId"
        WHERE contact."customerId" = $1
          AND contact."orgId" = $2
          AND campaign."orgId" = $2
        GROUP BY campaign.id
        ORDER BY MAX(recipient."sentAt") DESC NULLS LAST, campaign."updatedAt" DESC
        LIMIT 25
    "#,
    r#"
        SELECT event.id, event."eventType" AS event_type, event.channel, event.status,
               event."conversationId" AS conversation_id,
               event."responseTimeMs" AS response_time_ms, event.metadata,
               event."createdAt" AT TIME ZONE 'UTC' AS created_at,
               bot.name AS bot_name
        FROM "BotEvent" event
        JOIN "BotConfiguration" bot
          ON bot.id = event."botId" AND bot."orgId" = event."orgId"
        WHERE event."customerId" = $1 AND event."orgId" = $2
        ORDER BY event."createdAt" DESC
        LIMIT 25
    "#,
];

pub async fn get_customer_detail(
    pool: &PgPool,
    org_id: &str,
    customer_id: &str,
) -> Result<Option<Value>, AppError> {
    let customer = sqlx::query(CUSTOMER_DETAIL_QUERIES[0])
        .bind(customer_id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?;
    let Some(customer) = customer else {
        return Ok(None);
    };

    let (identities, contacts, conversations, campaigns, agent_events) = tokio::try_join!(
        sqlx::query(CUSTOMER_DETAIL_QUERIES[1])
            .bind(customer_id)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(CUSTOMER_DETAIL_QUERIES[2])
            .bind(customer_id)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(CUSTOMER_DETAIL_QUERIES[3])
            .bind(customer_id)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(CUSTOMER_DETAIL_QUERIES[4])
            .bind(customer_id)
            .bind(org_id)
            .fetch_all(pool),
        sqlx::query(CUSTOMER_DETAIL_QUERIES[5])
            .bind(customer_id)
            .bind(org_id)
            .fetch_all(pool),
    )?;

    Ok(Some(json!({
        "customer": {
            "id": customer.get::<String, _>("id"),
            "displayName": customer.get::<Option<String>, _>("display_name"),
            "metadata": customer.get::<Option<Value>, _>("metadata"),
            "createdAt": customer.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            "updatedAt": customer.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        },
        "identities": identities.into_iter().map(|identity| json!({
            "id": identity.get::<String, _>("id"),
            "channel": identity.get::<String, _>("channel"),
            "scopeId": identity.get::<Option<String>, _>("scope_id"),
            "externalId": identity.get::<String, _>("external_id"),
            "displayName": identity.get::<Option<String>, _>("display_name"),
            "metadata": identity.get::<Option<Value>, _>("metadata"),
            "createdAt": identity.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        })).collect::<Vec<_>>(),
        "contacts": contacts.into_iter().map(|contact| json!({
            "id": contact.get::<String, _>("id"),
            "phone": contact.get::<String, _>("phone"),
            "fullName": contact.get::<Option<String>, _>("full_name"),
            "tags": contact.get::<Vec<String>, _>("tags"),
            "listLabel": contact.get::<String, _>("list_label"),
            "optIn": contact.get::<bool, _>("opt_in"),
            "optInSource": contact.get::<Option<String>, _>("opt_in_source"),
            "optInDate": contact.get::<Option<chrono::DateTime<chrono::Utc>>, _>("opt_in_date"),
            "excluded": contact.get::<bool, _>("excluded"),
            "notes": contact.get::<Option<String>, _>("notes"),
            "lastMarketingSent": contact.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_marketing_sent"),
        })).collect::<Vec<_>>(),
        "conversations": conversations.into_iter().map(|conversation| json!({
            "id": conversation.get::<String, _>("id"),
            "channel": conversation.get::<String, _>("channel"),
            "customerIdentifier": conversation.get::<String, _>("customer_identifier"),
            "customerName": conversation.get::<Option<String>, _>("customer_name"),
            "status": conversation.get::<String, _>("status"),
            "lastMessageAt": conversation.get::<chrono::DateTime<chrono::Utc>, _>("last_message_at"),
            "unreadCount": conversation.get::<i32, _>("unread_count"),
            "connectionLabel": conversation.get::<Option<String>, _>("connection_label"),
        })).collect::<Vec<_>>(),
        "campaigns": campaigns.into_iter().map(|campaign| json!({
            "id": campaign.get::<String, _>("id"),
            "name": campaign.get::<String, _>("name"),
            "status": campaign.get::<String, _>("status"),
            "templateName": campaign.get::<String, _>("template_name"),
            "sentCount": campaign.get::<i32, _>("sent_count"),
            "deliveredCount": campaign.get::<i32, _>("delivered_count"),
            "readCount": campaign.get::<i32, _>("read_count"),
            "lastSentAt": campaign.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_sent_at"),
        })).collect::<Vec<_>>(),
        "agentEvents": agent_events.into_iter().map(|event| json!({
            "id": event.get::<String, _>("id"),
            "eventType": event.get::<String, _>("event_type"),
            "channel": event.get::<Option<String>, _>("channel"),
            "status": event.get::<Option<String>, _>("status"),
            "conversationId": event.get::<Option<String>, _>("conversation_id"),
            "responseTimeMs": event.get::<Option<i32>, _>("response_time_ms"),
            "metadata": event.get::<Option<Value>, _>("metadata"),
            "createdAt": event.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            "botName": event.get::<String, _>("bot_name"),
        })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::{meta_identity_key, whatsapp_identity_key, CUSTOMER_DETAIL_QUERIES};

    #[test]
    fn whatsapp_identity_is_phone_scoped() {
        assert_eq!(
            whatsapp_identity_key("+27821234567"),
            "whatsapp:+27821234567"
        );
    }

    #[test]
    fn meta_identity_includes_channel_connection_scope() {
        assert_ne!(
            meta_identity_key("instagram", "channel-a", "participant-1"),
            meta_identity_key("instagram", "channel-b", "participant-1")
        );
        assert_ne!(
            meta_identity_key("facebook", "channel-a", "participant-1"),
            meta_identity_key("instagram", "channel-a", "participant-1")
        );
    }

    #[test]
    fn display_names_are_not_part_of_identity_keys() {
        assert_eq!(
            meta_identity_key("facebook", "channel-a", "participant-1"),
            "facebook:channel-a:participant-1"
        );
    }

    #[test]
    fn customer_detail_queries_are_scoped_to_the_active_organization() {
        for query in CUSTOMER_DETAIL_QUERIES {
            assert!(
                query.contains("\"orgId\" = $2"),
                "customer detail query is missing an organization boundary: {query}"
            );
        }
    }
}
