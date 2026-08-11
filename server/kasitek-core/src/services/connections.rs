use sqlx::{PgPool, Postgres, Transaction};

use crate::db::models::ExternalConnection;
use crate::error::AppError;

const MUTABLE_STATUSES: &[&str] = &["CONNECTED", "DISCONNECTED", "REVOKED"];

pub fn is_mutable_status(status: &str) -> bool {
    MUTABLE_STATUSES.contains(&status)
}

pub async fn sync_org_connections(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sync_whatsapp(&mut tx, org_id).await?;
    sync_social(&mut tx, org_id).await?;
    mark_missing_sources(&mut tx, org_id).await?;
    sync_capabilities(&mut tx, org_id).await?;
    sync_consumers(&mut tx, org_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn sync_whatsapp(tx: &mut Transaction<'_, Postgres>, org_id: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "externalAccountId",
            "displayName", status, "credentialStatus", "healthStatus", "webhookStatus",
            "lastCheckedAt", metadata, "createdAt", "updatedAt"
        )
        SELECT
            'ext_' || wc.id, wc."orgId", 'WHATSAPP', 'WHATSAPP', wc.id, wc."phoneNumberId",
            COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId"),
            'CONNECTED'::"ExternalConnectionStatus", 'ACTIVE',
            CASE WHEN wc.verified THEN 'HEALTHY' ELSE 'UNKNOWN' END,
            'UNKNOWN', wc."updatedAt",
            jsonb_build_object(
                'wabaId', wc."wabaId",
                'qualityRating', wc."currentQualityRating"::text,
                'dailyLimitEstimate', wc."dailyLimitEstimate",
                'verified', wc.verified
            ), wc."createdAt", wc."updatedAt"
        FROM "WhatsappConnection" wc
        WHERE wc."orgId" = $1
        ON CONFLICT ("orgId", "sourceType", "sourceId") DO UPDATE SET
            provider = EXCLUDED.provider,
            "externalAccountId" = EXCLUDED."externalAccountId",
            "displayName" = EXCLUDED."displayName",
            status = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt"
                    THEN EXCLUDED.status
                ELSE COALESCE(
                    "ExternalConnection"."statusOverride",
                    CASE WHEN "ExternalConnection"."healthStatus" = 'NEEDS_ATTENTION'
                        THEN 'NEEDS_ATTENTION'::"ExternalConnectionStatus"
                        ELSE EXCLUDED.status
                    END
                )
            END,
            "statusOverride" = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt" THEN NULL
                ELSE "ExternalConnection"."statusOverride"
            END,
            "credentialStatus" = EXCLUDED."credentialStatus",
            "healthStatus" = CASE WHEN "ExternalConnection"."lastCheckedAt" IS NULL
                THEN EXCLUDED."healthStatus" ELSE "ExternalConnection"."healthStatus" END,
            "lastCheckedAt" = COALESCE("ExternalConnection"."lastCheckedAt", EXCLUDED."lastCheckedAt"),
            metadata = EXCLUDED.metadata,
            "updatedAt" = NOW()
        "#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn sync_social(tx: &mut Transaction<'_, Postgres>, org_id: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "externalAccountId",
            "displayName", handle, status, "credentialStatus", "healthStatus", "webhookStatus",
            "lastCheckedAt", metadata, "createdAt", "updatedAt"
        )
        SELECT
            'ext_' || sc.id, sc."orgId", sc.platform::text, 'SOCIAL', sc.id,
            sc."externalAccountId", sc."displayName", sc.handle,
            CASE sc.status::text
                WHEN 'CONNECTED' THEN 'CONNECTED'::"ExternalConnectionStatus"
                WHEN 'NEEDS_REAUTH' THEN 'NEEDS_ATTENTION'::"ExternalConnectionStatus"
                ELSE 'DISCONNECTED'::"ExternalConnectionStatus"
            END,
            CASE WHEN sc.status::text = 'NEEDS_REAUTH' THEN 'EXPIRED' ELSE 'ACTIVE' END,
            CASE WHEN sc.status::text = 'CONNECTED' THEN 'HEALTHY' ELSE 'NEEDS_ATTENTION' END,
            'UNKNOWN', COALESCE(sc."lastSyncedAt", sc."updatedAt"), sc.metadata,
            sc."createdAt", sc."updatedAt"
        FROM "SocialChannelConnection" sc
        WHERE sc."orgId" = $1
        ON CONFLICT ("orgId", "sourceType", "sourceId") DO UPDATE SET
            provider = EXCLUDED.provider,
            "externalAccountId" = EXCLUDED."externalAccountId",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            status = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt"
                    AND EXCLUDED.status = 'CONNECTED'::"ExternalConnectionStatus"
                    THEN EXCLUDED.status
                ELSE COALESCE("ExternalConnection"."statusOverride", EXCLUDED.status)
            END,
            "statusOverride" = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt"
                    AND EXCLUDED.status = 'CONNECTED'::"ExternalConnectionStatus" THEN NULL
                ELSE "ExternalConnection"."statusOverride"
            END,
            "credentialStatus" = EXCLUDED."credentialStatus",
            "healthStatus" = EXCLUDED."healthStatus",
            "lastCheckedAt" = EXCLUDED."lastCheckedAt",
            metadata = EXCLUDED.metadata,
            "updatedAt" = NOW()
        "#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn mark_missing_sources(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "ExternalConnection" connection
        SET status = COALESCE(connection."statusOverride", 'DISCONNECTED'::"ExternalConnectionStatus"),
            "credentialStatus" = 'MISSING',
            "healthStatus" = 'NEEDS_ATTENTION',
            "lastError" = 'The provider-specific connection record no longer exists.',
            "updatedAt" = NOW()
        WHERE connection."orgId" = $1
          AND (
            (connection."sourceType" = 'WHATSAPP' AND NOT EXISTS (
                SELECT 1 FROM "WhatsappConnection" source
                WHERE source.id = connection."sourceId" AND source."orgId" = connection."orgId"
            ))
            OR
            (connection."sourceType" = 'SOCIAL' AND NOT EXISTS (
                SELECT 1 FROM "SocialChannelConnection" source
                WHERE source.id = connection."sourceId" AND source."orgId" = connection."orgId"
            ))
          )
        "#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn sync_capabilities(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"DELETE FROM "ExternalConnectionCapability" capability
           USING "ExternalConnection" connection
           WHERE capability."connectionId" = connection.id AND connection."orgId" = $1"#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "ExternalConnectionCapability" (
            id, "connectionId", key, enabled, "entitlementKey", "createdAt", "updatedAt"
        )
        SELECT
            'cap_' || md5(connection.id || capability.key), connection.id, capability.key,
            connection.status = 'CONNECTED'::"ExternalConnectionStatus", capability.entitlement_key,
            NOW(), NOW()
        FROM "ExternalConnection" connection
        CROSS JOIN LATERAL (
            SELECT * FROM (VALUES
                ('MESSAGING_INBOUND', NULL::text, ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
                ('MESSAGING_OUTBOUND', NULL::text, ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
                ('CAMPAIGNS_SEND', 'feature.campaigns.send', ARRAY['WHATSAPP']),
                ('TEMPLATES_MANAGE', 'feature.templates.manage', ARRAY['WHATSAPP']),
                ('AGENT_CHANNEL', 'feature.agents.manage', ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
                ('SOCIAL_PUBLISH', 'feature.content.publish', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'TIKTOK', 'BLUESKY', 'LINKEDIN', 'X', 'WHATSAPP_STATUS']),
                ('SOCIAL_ANALYTICS', 'feature.analytics.view', ARRAY['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X']),
                ('COMMENTS_MANAGE', 'feature.content.manage', ARRAY['FACEBOOK', 'INSTAGRAM', 'X']),
                ('MEDIA_PUBLISH', 'feature.content.publish', ARRAY['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X', 'WHATSAPP_STATUS']),
                ('CALLS_INBOUND', NULL::text, ARRAY['TWILIO']),
                ('CALLS_OUTBOUND', NULL::text, ARRAY['TWILIO']),
                ('CALLS_BROWSER', NULL::text, ARRAY['TWILIO'])
            ) AS definition(key, entitlement_key, providers)
            WHERE connection.provider = ANY(definition.providers)
        ) capability
        WHERE connection."orgId" = $1
        "#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn sync_consumers(tx: &mut Transaction<'_, Postgres>, org_id: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"DELETE FROM "ExternalConnectionConsumer" consumer
           USING "ExternalConnection" connection
           WHERE consumer."connectionId" = connection.id AND connection."orgId" = $1"#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO "ExternalConnectionConsumer" (
            id, "connectionId", "productKey", "createdAt", "updatedAt"
        )
        SELECT 'use_' || md5(connection.id || consumer.product_key), connection.id,
               consumer.product_key, NOW(), NOW()
        FROM "ExternalConnection" connection
        CROSS JOIN LATERAL (
            SELECT unnest(CASE connection.provider
                WHEN 'WHATSAPP' THEN ARRAY['inbox', 'campaigns', 'agents']
                WHEN 'FACEBOOK' THEN ARRAY['inbox', 'content', 'agents']
                WHEN 'INSTAGRAM' THEN ARRAY['inbox', 'content', 'agents']
                WHEN 'TWILIO' THEN ARRAY['calls', 'inbox']
                ELSE ARRAY['content']
            END) AS product_key
        ) consumer
        WHERE connection."orgId" = $1
        "#,
    )
    .bind(org_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn list_connections(
    pool: &PgPool,
    org_id: &str,
) -> Result<Vec<ExternalConnection>, AppError> {
    sync_org_connections(pool, org_id).await?;
    sqlx::query_as::<_, ExternalConnection>(
        r#"
        SELECT connection.id, connection.provider,
               connection."externalAccountId" AS external_account_id,
               connection."displayName" AS display_name, connection.handle,
               connection.status::text AS status,
               connection."credentialStatus" AS credential_status,
               connection."healthStatus" AS health_status,
               connection."webhookStatus" AS webhook_status,
               connection."lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
               connection."lastError" AS last_error, connection.metadata,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'key', capability.key,
                       'enabled', capability.enabled,
                       'entitlementKey', capability."entitlementKey"
                   ) ORDER BY capability.key)
                   FROM "ExternalConnectionCapability" capability
                   WHERE capability."connectionId" = connection.id
               ), '[]'::jsonb) AS capabilities,
               COALESCE((
                   SELECT jsonb_agg(consumer."productKey" ORDER BY consumer."productKey")
                   FROM "ExternalConnectionConsumer" consumer
                   WHERE consumer."connectionId" = connection.id
               ), '[]'::jsonb) AS consumers,
               connection."createdAt" AT TIME ZONE 'UTC' AS created_at,
               connection."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnection" connection
        WHERE connection."orgId" = $1
        ORDER BY
            CASE connection.status WHEN 'NEEDS_ATTENTION' THEN 0 WHEN 'CONNECTED' THEN 1 ELSE 2 END,
            connection.provider, connection."displayName"
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn update_status(
    pool: &PgPool,
    org_id: &str,
    id: &str,
    status: &str,
) -> Result<ExternalConnection, AppError> {
    if !is_mutable_status(status) {
        return Err(AppError::BadRequest(
            "Status must be CONNECTED, DISCONNECTED, or REVOKED".to_string(),
        ));
    }

    let override_status = if status == "CONNECTED" {
        None
    } else {
        Some(status)
    };
    let updated = sqlx::query_as::<_, (String, String)>(
        r#"
        UPDATE "ExternalConnection"
        SET "statusOverride" = CAST($1 AS "ExternalConnectionStatus"),
            status = CAST($2 AS "ExternalConnectionStatus"),
            "credentialStatus" = CASE WHEN $2 = 'REVOKED' THEN 'REVOKED' ELSE "credentialStatus" END,
            "healthStatus" = CASE WHEN $2 = 'CONNECTED' THEN "healthStatus" ELSE 'NEEDS_ATTENTION' END,
            "updatedAt" = NOW()
        WHERE id = $3 AND "orgId" = $4
        RETURNING id, "sourceType"
        "#,
    )
    .bind(override_status)
    .bind(status)
    .bind(id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?;

    let Some((_, source_type)) = updated else {
        return Err(AppError::NotFound("Connection not found".to_string()));
    };

    if source_type == "SOCIAL" {
        let provider_status = match status {
            "CONNECTED" => "CONNECTED",
            "DISCONNECTED" => "DISCONNECTED",
            _ => "NEEDS_REAUTH",
        };
        sqlx::query(
            r#"
            UPDATE "SocialChannelConnection"
            SET status = CAST($1 AS "SocialChannelStatus"), "updatedAt" = NOW()
            WHERE id = (SELECT "sourceId" FROM "ExternalConnection" WHERE id = $2 AND "orgId" = $3)
              AND "orgId" = $3
            "#,
        )
        .bind(provider_status)
        .bind(id)
        .bind(org_id)
        .execute(pool)
        .await?;
    }

    list_connections(pool, org_id)
        .await?
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))
}

pub async fn source_is_connected(
    pool: &PgPool,
    org_id: &str,
    source_type: &str,
    source_id: &str,
) -> Result<bool, AppError> {
    let connected = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM "ExternalConnection"
            WHERE "orgId" = $1 AND "sourceType" = $2 AND "sourceId" = $3
              AND status = 'CONNECTED'::"ExternalConnectionStatus"
        )
        "#,
    )
    .bind(org_id)
    .bind(source_type)
    .bind(source_id)
    .fetch_one(pool)
    .await?;
    Ok(connected)
}

pub async fn record_source_health(
    pool: &PgPool,
    org_id: &str,
    source_type: &str,
    source_id: &str,
    healthy: bool,
    webhook_status: Option<&str>,
    error: Option<&str>,
) -> Result<(), AppError> {
    sync_org_connections(pool, org_id).await?;
    record_synced_source_health(
        pool,
        org_id,
        source_type,
        source_id,
        healthy,
        webhook_status,
        error,
    )
    .await
}

pub async fn record_synced_source_health(
    pool: &PgPool,
    org_id: &str,
    source_type: &str,
    source_id: &str,
    healthy: bool,
    webhook_status: Option<&str>,
    error: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE "ExternalConnection"
        SET "healthStatus" = $1,
            "webhookStatus" = COALESCE($2, "webhookStatus"),
            "lastCheckedAt" = NOW(),
            "lastError" = $3,
            status = CASE
                WHEN "statusOverride" IS NOT NULL THEN "statusOverride"
                WHEN $4 THEN 'CONNECTED'::"ExternalConnectionStatus"
                ELSE 'NEEDS_ATTENTION'::"ExternalConnectionStatus"
            END,
            "updatedAt" = NOW()
        WHERE "orgId" = $5 AND "sourceType" = $6 AND "sourceId" = $7
        "#,
    )
    .bind(if healthy {
        "HEALTHY"
    } else {
        "NEEDS_ATTENTION"
    })
    .bind(webhook_status)
    .bind(error)
    .bind(healthy)
    .bind(org_id)
    .bind(source_type)
    .bind(source_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_mutable_status, list_connections, source_is_connected, update_status};

    #[test]
    fn only_explicit_lifecycle_actions_are_mutable() {
        assert!(is_mutable_status("CONNECTED"));
        assert!(is_mutable_status("DISCONNECTED"));
        assert!(is_mutable_status("REVOKED"));
        assert!(!is_mutable_status("CONNECTING"));
        assert!(!is_mutable_status("NEEDS_ATTENTION"));
    }

    #[tokio::test]
    #[ignore = "requires a seeded PostgreSQL database"]
    async fn database_sync_preserves_organization_ownership() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("database connection failed");

        let org_a = list_connections(&pool, "org_connections_a")
            .await
            .expect("organization A sync failed");
        let org_b = list_connections(&pool, "org_connections_b")
            .await
            .expect("organization B sync failed");

        assert_eq!(org_a.len(), 2);
        assert_eq!(org_b.len(), 1);
        assert!(org_a.iter().all(|connection| connection.id != org_b[0].id));
        assert!(org_a.iter().any(|connection| {
            connection.provider == "WHATSAPP"
                && connection
                    .consumers
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item == "campaigns"))
        }));

        let whatsapp = org_a
            .iter()
            .find(|connection| connection.provider == "WHATSAPP")
            .expect("WhatsApp connection missing");
        update_status(&pool, "org_connections_a", &whatsapp.id, "DISCONNECTED")
            .await
            .expect("disconnect failed");
        assert!(
            !source_is_connected(&pool, "org_connections_a", "WHATSAPP", "wa_connections_a")
                .await
                .expect("status lookup failed")
        );
        assert!(
            source_is_connected(&pool, "org_connections_b", "SOCIAL", "social_connections_b")
                .await
                .is_ok()
        );
    }
}
