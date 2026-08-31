use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::analytics;
use crate::db::models::ExternalConnection;
use crate::error::AppError;

use super::connection_permissions;

const MUTABLE_STATUSES: &[&str] = &["CONNECTED", "DISCONNECTED", "REVOKED"];

#[derive(Clone, Debug, Eq, PartialEq, sqlx::FromRow)]
struct ConnectionState {
    id: String,
    provider: String,
    status: String,
    credential_status: String,
    health_status: String,
    webhook_status: String,
    last_checked_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq, sqlx::FromRow)]
struct CapabilityState {
    connection_id: String,
    provider: String,
    capability: String,
    enabled: bool,
    updated_at: DateTime<Utc>,
}

pub fn is_mutable_status(status: &str) -> bool {
    MUTABLE_STATUSES.contains(&status)
}

pub async fn sync_org_connections(pool: &PgPool, org_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let before = load_connection_states(&mut tx, org_id).await?;
    let before_capabilities = load_capability_states(&mut tx, org_id).await?;
    sync_whatsapp(&mut tx, org_id).await?;
    sync_social(&mut tx, org_id).await?;
    mark_missing_sources(&mut tx, org_id).await?;
    sync_capabilities(&mut tx, org_id).await?;
    let after_capabilities = load_capability_states(&mut tx, org_id).await?;
    enqueue_capability_changes(&mut tx, org_id, &before_capabilities, &after_capabilities).await?;
    sync_consumers(&mut tx, org_id).await?;
    let after = load_connection_states(&mut tx, org_id).await?;
    enqueue_state_changes(&mut tx, org_id, &before, &after).await?;
    analytics::connections::enqueue_manifest(&mut tx, org_id, after.len() as i64, Utc::now())
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Connections source manifest: {error}"
            ))
        })?;
    tx.commit().await?;
    Ok(())
}

async fn load_capability_states(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<BTreeMap<(String, String), CapabilityState>, AppError> {
    let rows = sqlx::query_as::<_, CapabilityState>(
        r#"
        SELECT capability."connectionId" AS connection_id,
               connection.provider,
               capability.key AS capability,
               capability.enabled,
               capability."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnectionCapability" capability
        INNER JOIN "ExternalConnection" connection
            ON connection.id = capability."connectionId"
        WHERE connection."orgId" = $1
        ORDER BY capability."connectionId", capability.key
        "#,
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|state| {
            (
                (state.connection_id.clone(), state.capability.clone()),
                state,
            )
        })
        .collect())
}

async fn enqueue_capability_changes(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    before: &BTreeMap<(String, String), CapabilityState>,
    after: &BTreeMap<(String, String), CapabilityState>,
) -> Result<(), AppError> {
    for (key, state) in after {
        let changed = before.get(key).is_none_or(|previous| {
            previous.enabled != state.enabled || previous.provider != state.provider
        });
        if !changed {
            continue;
        }
        analytics::connections::enqueue_capability_lifecycle(
            tx,
            org_id,
            &state.connection_id,
            &state.provider,
            &state.capability,
            state.enabled,
            state.updated_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Connections capability analytics fact: {error}"
            ))
        })?;
    }
    Ok(())
}

async fn load_connection_states(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
) -> Result<HashMap<String, ConnectionState>, AppError> {
    let rows = sqlx::query_as::<_, ConnectionState>(
        r#"
        SELECT id, provider, status::text AS status,
               "credentialStatus" AS credential_status,
               "healthStatus" AS health_status,
               "webhookStatus" AS webhook_status,
               "lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnection"
        WHERE "orgId" = $1
        FOR UPDATE
        "#,
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|state| (state.id.clone(), state))
        .collect())
}

async fn load_connection_state(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    connection_id: &str,
) -> Result<Option<ConnectionState>, AppError> {
    sqlx::query_as::<_, ConnectionState>(
        r#"
        SELECT id, provider, status::text AS status,
               "credentialStatus" AS credential_status,
               "healthStatus" AS health_status,
               "webhookStatus" AS webhook_status,
               "lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnection"
        WHERE "orgId" = $1 AND id = $2
        "#,
    )
    .bind(org_id)
    .bind(connection_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(AppError::from)
}

async fn enqueue_state_changes(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    before: &HashMap<String, ConnectionState>,
    after: &HashMap<String, ConnectionState>,
) -> Result<(), AppError> {
    for state in after.values() {
        let Some(previous) = before.get(&state.id) else {
            analytics::connections::enqueue_lifecycle(
                tx,
                org_id,
                &state.id,
                &state.provider,
                "created",
                &state.status,
                &state.credential_status,
                &state.health_status,
                &state.webhook_status,
                state.updated_at,
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to queue Connections analytics fact: {error}"
                ))
            })?;
            continue;
        };

        if previous.status != state.status {
            analytics::connections::enqueue_lifecycle(
                tx,
                org_id,
                &state.id,
                &state.provider,
                analytics::connections::lifecycle_action(&state.status),
                &state.status,
                &state.credential_status,
                &state.health_status,
                &state.webhook_status,
                state.updated_at,
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to queue Connections analytics fact: {error}"
                ))
            })?;
        }

        if previous.health_status != state.health_status
            || previous.credential_status != state.credential_status
            || previous.webhook_status != state.webhook_status
            || previous.last_checked_at != state.last_checked_at
        {
            analytics::connections::enqueue_health_check(
                tx,
                org_id,
                &state.id,
                &state.provider,
                &state.status,
                &state.health_status,
                &state.credential_status,
                &state.webhook_status,
                state.health_status == "HEALTHY",
                state.last_checked_at.unwrap_or(state.updated_at),
            )
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to queue Connections analytics fact: {error}"
                ))
            })?;
        }
    }
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
                ('SOCIAL_PUBLISH', 'feature.content.publish', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'TIKTOK', 'BLUESKY', 'LINKEDIN', 'X']),
                ('SOCIAL_ANALYTICS', 'feature.analytics.view', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'TIKTOK', 'BLUESKY', 'LINKEDIN', 'X']),
                ('COMMENTS_MANAGE', 'feature.content.manage', ARRAY['FACEBOOK', 'INSTAGRAM', 'X']),
                ('MEDIA_PUBLISH', 'feature.content.publish', ARRAY['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X']),
                ('SOCIAL_POST_DELETE', 'feature.content.manage', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'LINKEDIN', 'X']),
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
    connection_permissions::sync_permission_inventory(pool, org_id).await?;
    let mut connections = sqlx::query_as::<_, ExternalConnection>(
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
                   SELECT jsonb_agg(jsonb_build_object(
                       'key', permission.key,
                       'state', permission.state,
                       'requestable', permission.requestable,
                       'reasonCode', permission."reasonCode",
                       'authMode', permission."authMode",
                       'verificationSource', permission."verificationSource",
                       'observedAt', permission."observedAt" AT TIME ZONE 'UTC'
                   ) ORDER BY permission.key)
                   FROM "ExternalConnectionPermission" permission
                   WHERE permission."connectionId" = connection.id
               ), '[]'::jsonb) AS permissions,
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
    .map_err(AppError::from)?;

    for connection in &mut connections {
        connection.permissions = serde_json::to_value(
            connection_permissions::permission_snapshots(
                &connection.provider,
                connection.metadata.as_ref(),
            )
            .into_iter()
            .map(|snapshot| snapshot.definition)
            .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| serde_json::json!([]));
    }
    Ok(connections)
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

    let mut tx = pool.begin().await?;
    let previous_status = sqlx::query_scalar::<_, String>(
        r#"SELECT status::text FROM "ExternalConnection" WHERE id = $1 AND "orgId" = $2 FOR UPDATE"#,
    )
    .bind(id)
    .bind(org_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(previous_status) = previous_status else {
        return Err(AppError::NotFound("Connection not found".to_string()));
    };

    let override_status = if status == "CONNECTED" {
        None
    } else {
        Some(status)
    };
    let source_type = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE "ExternalConnection"
        SET "statusOverride" = CAST($1 AS "ExternalConnectionStatus"),
            status = CAST($2 AS "ExternalConnectionStatus"),
            "credentialStatus" = CASE WHEN $2 = 'REVOKED' THEN 'REVOKED' ELSE "credentialStatus" END,
            "healthStatus" = CASE WHEN $2 = 'CONNECTED' THEN "healthStatus" ELSE 'NEEDS_ATTENTION' END,
            "updatedAt" = NOW()
        WHERE id = $3 AND "orgId" = $4
        RETURNING "sourceType"
        "#,
    )
    .bind(override_status)
    .bind(status)
    .bind(id)
    .bind(org_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(source_type) = source_type else {
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
        .execute(&mut *tx)
        .await?;
    }

    if previous_status != status {
        let state = load_connection_state(&mut tx, org_id, id)
            .await?
            .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))?;
        analytics::connections::enqueue_lifecycle(
            &mut tx,
            org_id,
            &state.id,
            &state.provider,
            analytics::connections::lifecycle_action(&state.status),
            &state.status,
            &state.credential_status,
            &state.health_status,
            &state.webhook_status,
            state.updated_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Connections analytics fact: {error}"
            ))
        })?;
    }
    tx.commit().await?;

    list_connections(pool, org_id)
        .await?
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| AppError::NotFound("Connection not found".to_string()))
}

pub async fn update_status_by_identity(
    pool: &PgPool,
    org_id: &str,
    provider: &str,
    display_name: &str,
    handle: Option<&str>,
    status: &str,
) -> Result<ExternalConnection, AppError> {
    let ids = sqlx::query_scalar::<_, String>(
        r#"SELECT id
           FROM "ExternalConnection"
           WHERE "orgId" = $1
             AND LOWER(provider) = LOWER($2)
             AND LOWER("displayName") = LOWER($3)
             AND ($4::text IS NULL OR LOWER(COALESCE(handle, '')) = LOWER($4))
           ORDER BY id"#,
    )
    .bind(org_id)
    .bind(provider.trim())
    .bind(display_name.trim())
    .bind(handle.map(str::trim).filter(|value| !value.is_empty()))
    .fetch_all(pool)
    .await?;

    let id = match ids.as_slice() {
        [] => return Err(AppError::NotFound("Connection not found".to_string())),
        [id] => id,
        _ => {
            return Err(AppError::BadRequest(
                "Multiple connections match; specify the account handle".to_string(),
            ));
        }
    };
    update_status(pool, org_id, id, status).await
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

pub fn provider_sync_failure_class(error: &AppError) -> &'static str {
    match error.code() {
        "unauthorized" => "authentication",
        "unsupported_principal" | "forbidden" => "authorization",
        "rate_limited" => "rate_limited",
        "service_unavailable" | "bad_gateway" | "gateway_timeout" => "provider_unavailable",
        "bad_request" => "provider_rejected",
        "not_found" => "not_found",
        "internal_error" => "internal",
        _ => "unknown",
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn record_provider_sync_outcome(
    pool: &PgPool,
    org_id: &str,
    source_id: &str,
    provider: &str,
    operation: &str,
    attempt_id: &str,
    outcome: &str,
    failure_class: &str,
    duration_ms: i64,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    // ExternalConnection IDs are intentionally deterministic (`ext_<source-id>`) so a provider
    // attempt can be recorded without rebuilding the full connection projection on every refresh.
    let connection_id = format!("ext_{source_id}");
    let occurred_at = Utc::now();
    analytics::connections::enqueue_sync_attempt(
        &mut tx,
        org_id,
        &connection_id,
        provider,
        attempt_id,
        operation,
        outcome,
        failure_class,
        duration_ms.clamp(0, 86_400_000),
        occurred_at,
    )
    .await
    .map_err(|error| {
        AppError::Internal(format!(
            "Failed to queue Connections synchronization analytics fact: {error}"
        ))
    })?;
    if failure_class == "rate_limited" {
        analytics::connections::enqueue_rate_limit(
            &mut tx,
            org_id,
            &connection_id,
            provider,
            operation,
            "provider",
            None,
            occurred_at,
        )
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to queue Connections rate-limit analytics fact: {error}"
            ))
        })?;
    }
    tx.commit().await?;
    Ok(())
}

pub fn health_incident_transition(
    previous_health_status: Option<&str>,
    healthy: bool,
) -> Option<(&'static str, &'static str)> {
    match (previous_health_status, healthy) {
        (Some("NEEDS_ATTENTION"), true) => Some(("resolved", "provider_health_recovered")),
        (previous, false) if previous != Some("NEEDS_ATTENTION") => {
            Some(("opened", "provider_health_failed"))
        }
        _ => None,
    }
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
    let mut tx = pool.begin().await?;
    let previous_health_status = sqlx::query_scalar::<_, String>(
        r#"
        SELECT "healthStatus"
        FROM "ExternalConnection"
        WHERE "orgId" = $1 AND "sourceType" = $2 AND "sourceId" = $3
        FOR UPDATE
        "#,
    )
    .bind(org_id)
    .bind(source_type)
    .bind(source_id)
    .fetch_optional(&mut *tx)
    .await?;
    let state = sqlx::query_as::<_, ConnectionState>(
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
        RETURNING id, provider, status::text AS status,
                  "credentialStatus" AS credential_status,
                  "healthStatus" AS health_status,
                  "webhookStatus" AS webhook_status,
                  "lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
                  "updatedAt" AT TIME ZONE 'UTC' AS updated_at
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
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(state) = state {
        let occurred_at = state.last_checked_at.unwrap_or(state.updated_at);
        if let Some((action, reason_code)) =
            health_incident_transition(previous_health_status.as_deref(), healthy)
        {
            analytics::connections::enqueue_incident_lifecycle(
                &mut tx,
                org_id,
                &state.id,
                &state.provider,
                "connection_health",
                action,
                "critical",
                reason_code,
                occurred_at,
            )
            .await
            .map_err(|analytics_error| {
                AppError::Internal(format!(
                    "Failed to queue Connections incident analytics fact: {analytics_error}"
                ))
            })?;
        }
        analytics::connections::enqueue_health_check(
            &mut tx,
            org_id,
            &state.id,
            &state.provider,
            &state.status,
            &state.health_status,
            &state.credential_status,
            &state.webhook_status,
            healthy,
            occurred_at,
        )
        .await
        .map_err(|analytics_error| {
            AppError::Internal(format!(
                "Failed to queue Connections analytics fact: {analytics_error}"
            ))
        })?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        health_incident_transition, is_mutable_status, list_connections,
        provider_sync_failure_class, source_is_connected, update_status,
    };
    use crate::error::AppError;

    #[test]
    fn only_explicit_lifecycle_actions_are_mutable() {
        assert!(is_mutable_status("CONNECTED"));
        assert!(is_mutable_status("DISCONNECTED"));
        assert!(is_mutable_status("REVOKED"));
        assert!(!is_mutable_status("CONNECTING"));
        assert!(!is_mutable_status("NEEDS_ATTENTION"));
    }

    #[test]
    fn provider_sync_errors_are_reduced_to_bounded_classes() {
        assert_eq!(
            provider_sync_failure_class(&AppError::Unauthorized),
            "authentication"
        );
        assert_eq!(
            provider_sync_failure_class(&AppError::TooManyRequests("retry".to_string())),
            "rate_limited"
        );
        assert_eq!(
            provider_sync_failure_class(&AppError::BadRequest("provider rejected".to_string())),
            "provider_rejected"
        );
        assert_eq!(
            provider_sync_failure_class(&AppError::Internal("secret detail".to_string())),
            "internal"
        );
    }

    #[test]
    fn health_incidents_only_emit_on_state_boundaries() {
        assert_eq!(
            health_incident_transition(Some("HEALTHY"), false),
            Some(("opened", "provider_health_failed"))
        );
        assert_eq!(
            health_incident_transition(Some("NEEDS_ATTENTION"), true),
            Some(("resolved", "provider_health_recovered"))
        );
        assert_eq!(
            health_incident_transition(Some("NEEDS_ATTENTION"), false),
            None
        );
        assert_eq!(health_incident_transition(Some("UNKNOWN"), true), None);
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
