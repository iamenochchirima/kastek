export const LOAD_CAPABILITY_STATES_0 = `SELECT capability."connectionId" AS connection_id,
               connection.provider,
               capability.key AS capability,
               capability.enabled,
               capability."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnectionCapability" capability
        INNER JOIN "ExternalConnection" connection
            ON connection.id = capability."connectionId"
        WHERE connection."orgId" = $1
        ORDER BY capability."connectionId", capability.key`;

export const LOAD_CONNECTION_STATES_0 = `SELECT id, provider, status::text AS status,
               "credentialStatus" AS credential_status,
               "healthStatus" AS health_status,
               "webhookStatus" AS webhook_status,
               "lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnection"
        WHERE "orgId" = $1
        FOR UPDATE`;

export const LOAD_CONNECTION_STATE_0 = `SELECT id, provider, status::text AS status,
               "credentialStatus" AS credential_status,
               "healthStatus" AS health_status,
               "webhookStatus" AS webhook_status,
               "lastCheckedAt" AT TIME ZONE 'UTC' AS last_checked_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "ExternalConnection"
        WHERE "orgId" = $1 AND id = $2`;

export const SYNC_WHATSAPP_0 = `INSERT INTO "ExternalConnection" (
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
                'verified', wc.verified,
                'authMethod', wc."authMethod",
                'permissions', COALESCE(wc."providerPermissions"->'permissions', '[]'::jsonb),
                'permissionsInspected', wc."providerPermissions" IS NOT NULL,
                'capabilityChecks', COALESCE(wc."providerPermissions"->'capabilityChecks', '{}'::jsonb),
                'permissionEvidence', 'meta_permissions_endpoint'
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
            "updatedAt" = NOW()`;

export const SYNC_SOCIAL_0 = `INSERT INTO "ExternalConnection" (
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
            "updatedAt" = NOW()`;

export const SYNC_EMAIL_0 = `INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "externalAccountId",
            "displayName", handle, status, "credentialStatus", "healthStatus", "webhookStatus",
            "lastCheckedAt", metadata, "createdAt", "updatedAt"
        )
        SELECT
            'ext_' || ec.id, ec."orgId", ec.provider, 'EMAIL', ec.id, ec."externalAccountId",
            ec."displayName", ec."emailAddress",
            CASE ec.status
                WHEN 'CONNECTED' THEN 'CONNECTED'::"ExternalConnectionStatus"
                WHEN 'NEEDS_ATTENTION' THEN 'NEEDS_ATTENTION'::"ExternalConnectionStatus"
                ELSE 'DISCONNECTED'::"ExternalConnectionStatus"
            END,
            CASE WHEN ec.status = 'CONNECTED' THEN 'ACTIVE' ELSE 'EXPIRED' END,
            CASE WHEN ec."healthStatus" = 'HEALTHY' THEN 'HEALTHY' ELSE 'NEEDS_ATTENTION' END,
            'UNKNOWN', COALESCE(ec."lastSyncedAt", ec."updatedAt"),
            jsonb_build_object(
                'channelType', 'email',
                'provider', lower(ec.provider),
                'emailAddress', ec."emailAddress",
                'syncStatus', ec."syncStatus",
                'scopes', ec.scopes
            ),
            ec."createdAt", ec."updatedAt"
        FROM "EmailConnection" ec
        WHERE ec."orgId" = $1
        ON CONFLICT ("orgId", "sourceType", "sourceId") DO UPDATE SET
            provider = EXCLUDED.provider,
            "externalAccountId" = EXCLUDED."externalAccountId",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            status = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt"
                    THEN EXCLUDED.status
                ELSE COALESCE("ExternalConnection"."statusOverride", EXCLUDED.status)
            END,
            "statusOverride" = CASE
                WHEN EXCLUDED."updatedAt" > "ExternalConnection"."updatedAt" THEN NULL
                ELSE "ExternalConnection"."statusOverride"
            END,
            "credentialStatus" = EXCLUDED."credentialStatus",
            "healthStatus" = EXCLUDED."healthStatus",
            "lastCheckedAt" = EXCLUDED."lastCheckedAt",
            metadata = EXCLUDED.metadata,
            "updatedAt" = NOW()`;

export const MARK_MISSING_SOURCES_0 = `UPDATE "ExternalConnection" connection
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
            OR
            (connection."sourceType" = 'EMAIL' AND NOT EXISTS (
                SELECT 1 FROM "EmailConnection" source
                WHERE source.id = connection."sourceId" AND source."orgId" = connection."orgId"
            ))
          )`;

export const SYNC_CAPABILITIES_0 = `DELETE FROM "ExternalConnectionCapability" capability
           USING "ExternalConnection" connection
           WHERE capability."connectionId" = connection.id AND connection."orgId" = $1`;

export const SYNC_CAPABILITIES_1 = `INSERT INTO "ExternalConnectionCapability" (
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
                ('SOCIAL_POST_DELETE', 'feature.content.manage', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'BLUESKY', 'LINKEDIN', 'X']),
                ('CALLS_INBOUND', NULL::text, ARRAY['TWILIO']),
                ('CALLS_OUTBOUND', NULL::text, ARRAY['TWILIO']),
                ('CALLS_BROWSER', NULL::text, ARRAY['TWILIO']),
                ('EMAIL_INBOUND', NULL::text, ARRAY['GOOGLE', 'MICROSOFT']),
                ('EMAIL_READ', NULL::text, ARRAY['GOOGLE', 'MICROSOFT']),
                ('EMAIL_OUTBOUND', NULL::text, ARRAY['GOOGLE', 'MICROSOFT']),
                ('EMAIL_REPLY', NULL::text, ARRAY['GOOGLE', 'MICROSOFT']),
                ('AGENT_EMAIL', 'feature.agents.manage', ARRAY['GOOGLE', 'MICROSOFT'])
            ) AS definition(key, entitlement_key, providers)
            WHERE connection.provider = ANY(definition.providers)
              AND (
                (
                    definition.key NOT IN ('EMAIL_INBOUND', 'EMAIL_READ', 'EMAIL_OUTBOUND', 'EMAIL_REPLY', 'AGENT_EMAIL')
                    OR connection."sourceType" = 'EMAIL'
                )
                AND (
                    definition.key <> 'SOCIAL_POST_DELETE'
                    OR connection.provider <> 'INSTAGRAM'
                    OR connection.metadata->>'authMethod' = 'meta_login'
                )
              )
        ) capability
        WHERE connection."orgId" = $1`;

export const SYNC_CONSUMERS_0 = `DELETE FROM "ExternalConnectionConsumer" consumer
           USING "ExternalConnection" connection
           WHERE consumer."connectionId" = connection.id AND connection."orgId" = $1`;

export const SYNC_CONSUMERS_1 = `INSERT INTO "ExternalConnectionConsumer" (
            id, "connectionId", "productKey", "createdAt", "updatedAt"
        )
        SELECT 'use_' || md5(connection.id || consumer.product_key), connection.id,
               consumer.product_key, NOW(), NOW()
        FROM "ExternalConnection" connection
        CROSS JOIN LATERAL (
            SELECT unnest(CASE
                WHEN connection."sourceType" = 'EMAIL' THEN ARRAY['inbox', 'agents']
                WHEN connection.provider = 'WHATSAPP' THEN ARRAY['inbox', 'campaigns', 'agents']
                WHEN connection.provider = 'FACEBOOK' THEN ARRAY['inbox', 'content', 'agents']
                WHEN connection.provider = 'INSTAGRAM' THEN ARRAY['inbox', 'content', 'agents']
                WHEN connection.provider = 'TWILIO' THEN ARRAY['calls', 'inbox']
                ELSE ARRAY['content']
            END) AS product_key
        ) consumer
        WHERE connection."orgId" = $1`;

export const LIST_CONNECTIONS_0 = `SELECT connection.id, connection.provider,
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
            connection.provider, connection."displayName"`;

export const UPDATE_STATUS_0 = `SELECT status::text,"updatedAt" FROM "ExternalConnection" WHERE id = $1 AND "orgId" = $2 FOR UPDATE`;

export const UPDATE_STATUS_1 = `UPDATE "ExternalConnection"
        SET "statusOverride" = CAST($1 AS "ExternalConnectionStatus"),
            status = CAST($2 AS "ExternalConnectionStatus"),
            "credentialStatus" = CASE WHEN $2 = 'REVOKED' THEN 'REVOKED' ELSE "credentialStatus" END,
            "healthStatus" = CASE WHEN $2 = 'CONNECTED' THEN "healthStatus" ELSE 'NEEDS_ATTENTION' END,
            "updatedAt" = NOW()
        WHERE id = $3 AND "orgId" = $4
        RETURNING "sourceType", "sourceId"`;

export const UPDATE_STATUS_2 = `UPDATE "SocialChannelConnection"
            SET status = CAST($1 AS "SocialChannelStatus"), "updatedAt" = NOW()
            WHERE id = $2
              AND "orgId" = $3`;

export const UPDATE_STATUS_3 = `UPDATE "EmailConnection"
               SET status = $1,
                   "healthStatus" = CASE WHEN $1 = 'CONNECTED' THEN 'HEALTHY' ELSE 'NEEDS_ATTENTION' END,
                   "syncStatus" = CASE WHEN $1 = 'CONNECTED' THEN 'NOT_CONFIGURED' ELSE 'BLOCKED' END,
                   "lastError" = CASE WHEN $1 = 'CONNECTED' THEN NULL ELSE 'connection_disconnected' END,
                   "updatedAt" = NOW()
               WHERE id = $2 AND "orgId" = $3`;

export const UPDATE_STATUS_4 = `UPDATE "EmailInboxBinding"
               SET status = CASE WHEN $1 = 'CONNECTED' THEN 'ACTIVE' ELSE 'PAUSED' END,
                   "inboundStatus" = CASE
                       WHEN $1 <> 'CONNECTED' THEN 'BLOCKED'
                       WHEN EXISTS (
                           SELECT 1 FROM "EmailConnection" connection
                           WHERE connection.id = $2
                             AND ('https://www.googleapis.com/auth/gmail.readonly' = ANY(connection.scopes) OR 'Mail.Read' = ANY(connection.scopes))
                       ) THEN 'PENDING'
                       ELSE 'BLOCKED'
                   END,
                   "outboundStatus" = CASE
                       WHEN $1 <> 'CONNECTED' THEN 'BLOCKED'
                       WHEN EXISTS (
                           SELECT 1 FROM "EmailConnection" connection
                           WHERE connection.id = $2
                             AND ('https://www.googleapis.com/auth/gmail.send' = ANY(connection.scopes) OR 'Mail.Send' = ANY(connection.scopes))
                       ) THEN 'READY'
                       ELSE 'BLOCKED'
                   END,
                   "lastError" = CASE WHEN $1 = 'CONNECTED' THEN NULL ELSE 'connection_disconnected' END,
                   "updatedAt" = NOW()
               WHERE "emailConnectionId" = $2 AND "orgId" = $3`;

export const UPDATE_STATUS_BY_IDENTITY_0 = `SELECT id
           FROM "ExternalConnection"
           WHERE "orgId" = $1
             AND LOWER(provider) = LOWER($2)
             AND LOWER("displayName") = LOWER($3)
             AND ($4::text IS NULL OR LOWER(COALESCE(handle, '')) = LOWER($4))
           ORDER BY id`;

export const SOURCE_IS_CONNECTED_0 = `SELECT EXISTS (
            SELECT 1 FROM "ExternalConnection"
            WHERE "orgId" = $1 AND "sourceType" = $2 AND "sourceId" = $3
              AND status = 'CONNECTED'::"ExternalConnectionStatus"
        )`;

export const RECORD_SYNCED_SOURCE_HEALTH_0 = `SELECT "healthStatus"
        FROM "ExternalConnection"
        WHERE "orgId" = $1 AND "sourceType" = $2 AND "sourceId" = $3
        FOR UPDATE`;

export const RECORD_SYNCED_SOURCE_HEALTH_1 = `UPDATE "ExternalConnection"
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
                  "updatedAt" AT TIME ZONE 'UTC' AS updated_at`;
