export const GET_SOCIAL_CHANNEL_BY_EXTERNAL_ACCOUNT_0 = `SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,
               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,
               metadata, "lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at, "createdAt" AT TIME ZONE 'UTC' AS created_at, "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "SocialChannelConnection"
        WHERE "orgId" = $1 AND platform = '{platform}'::"SocialPlatform" AND "externalAccountId" = $2
        LIMIT 1`;

export const UPSERT_PROVIDER_CONNECTION_0 = `INSERT INTO "SocialChannelConnection" (id, "userId", "orgId", platform, status, "displayName", handle,
          "externalAccountId", "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,'{platform}'::"SocialPlatform",'CONNECTED'::"SocialChannelStatus",$4,$5,$6,$7,$8,$9,NOW(),NOW(),NOW())
        ON CONFLICT ("orgId", platform, "externalAccountId") DO UPDATE SET "userId"=EXCLUDED."userId",
          status='CONNECTED'::"SocialChannelStatus", "displayName"=EXCLUDED."displayName", handle=EXCLUDED.handle,
          "accessToken"=EXCLUDED."accessToken", "refreshToken"=EXCLUDED."refreshToken", metadata=EXCLUDED.metadata,
          "lastSyncedAt"=NOW(), "updatedAt"=NOW()`;

export const UPSERT_META_CONNECTIONS_FOR_ORG_0 = `INSERT INTO "SocialChannelConnection" (
                id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
                "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
            )
            VALUES (
                $1, $2, $3, 'FACEBOOK'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
                $7, $8, $9, NOW(), NOW(), NOW()
            )
            ON CONFLICT ("orgId", platform, "externalAccountId")
            DO UPDATE SET
                status = 'CONNECTED'::"SocialChannelStatus",
                "displayName" = EXCLUDED."displayName",
                handle = EXCLUDED.handle,
                "accessToken" = EXCLUDED."accessToken",
                "refreshToken" = EXCLUDED."refreshToken",
                metadata = EXCLUDED.metadata,
                "lastSyncedAt" = NOW(),
                "updatedAt" = NOW()`;

export const UPSERT_META_CONNECTIONS_FOR_ORG_1 = `INSERT INTO "SocialChannelConnection" (
                    id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
                    "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
                )
                VALUES (
                    $1, $2, $3, 'INSTAGRAM'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
                    $7, $8, $9, NOW(), NOW(), NOW()
                )
                ON CONFLICT ("orgId", platform, "externalAccountId")
                DO UPDATE SET
                    status = 'CONNECTED'::"SocialChannelStatus",
                    "displayName" = EXCLUDED."displayName",
                    handle = EXCLUDED.handle,
                    "accessToken" = EXCLUDED."accessToken",
                    "refreshToken" = EXCLUDED."refreshToken",
                    metadata = EXCLUDED.metadata,
                    "lastSyncedAt" = NOW(),
                    "updatedAt" = NOW()`;

export const UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_0 = `SELECT EXISTS (
                SELECT 1
                FROM "SocialChannelConnection"
                WHERE "orgId" = $1
                  AND platform = 'INSTAGRAM'::"SocialPlatform"
                  AND "externalAccountId" = $2
            )`;

export const UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_1 = `UPDATE "SocialChannelConnection"
                SET "externalAccountId" = $1,
                    "updatedAt" = NOW()
                WHERE "orgId" = $2
                  AND platform = 'INSTAGRAM'::"SocialPlatform"
                  AND metadata->>'authMethod' = 'instagram_login'
                  AND (
                      "externalAccountId" = $3
                      OR metadata->>'instagramAppScopedId' = $3
                  )`;

export const UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_2 = `INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'INSTAGRAM'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
            $7, NULL, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            "userId" = EXCLUDED."userId",
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = NULL,
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()`;

export const UPSERT_X_CONNECTION_FOR_ORG_0 = `INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'X'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, $5, $6,
            $7, $8, $9, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            handle = EXCLUDED.handle,
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = EXCLUDED."refreshToken",
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()`;

export const UPSERT_LINKEDIN_CONNECTION_FOR_ORG_0 = `INSERT INTO "SocialChannelConnection" (
            id, "userId", "orgId", platform, status, "displayName", handle, "externalAccountId",
            "accessToken", "refreshToken", metadata, "lastSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, 'LINKEDIN'::"SocialPlatform", 'CONNECTED'::"SocialChannelStatus", $4, NULL, $5,
            $6, $7, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT ("orgId", platform, "externalAccountId")
        DO UPDATE SET
            status = 'CONNECTED'::"SocialChannelStatus",
            "displayName" = EXCLUDED."displayName",
            "accessToken" = EXCLUDED."accessToken",
            "refreshToken" = EXCLUDED."refreshToken",
            metadata = EXCLUDED.metadata,
            "lastSyncedAt" = NOW(),
            "updatedAt" = NOW()`;
