export const CREATE_OAUTH_STATE_0 = `INSERT INTO "EmailOAuthState" (
             "id", "orgId", "userId", "provider", "stateHash", "redirectUri", "returnPath", "expiresAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

export const CONSUME_OAUTH_STATE_0 = `DELETE FROM "EmailOAuthState"
           WHERE "stateHash" = $1 AND "expiresAt" > NOW() AND "consumedAt" IS NULL
           RETURNING id, "orgId" AS org_id, "userId" AS user_id, provider,
                     "redirectUri" AS redirect_uri, "returnPath" AS return_path`;

export const UPSERT_CONNECTION_FROM_TOKENS_0 = `INSERT INTO "EmailConnection" (
             "id", "orgId", "userId", "provider", "externalAccountId", "emailAddress", "displayName",
             "accessToken", "refreshToken", "tokenExpiresAt", "scopes", "status", "healthStatus", "syncStatus", "metadata", "updatedAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONNECTED','HEALTHY','NOT_CONFIGURED',$12,NOW())
           ON CONFLICT ("orgId", "provider", "externalAccountId") DO UPDATE SET
             "userId" = EXCLUDED."userId", "emailAddress" = EXCLUDED."emailAddress", "displayName" = EXCLUDED."displayName",
             "accessToken" = EXCLUDED."accessToken", "refreshToken" = COALESCE(EXCLUDED."refreshToken", "EmailConnection"."refreshToken"),
             "tokenExpiresAt" = EXCLUDED."tokenExpiresAt", "scopes" = EXCLUDED."scopes", "status" = 'CONNECTED',
             "healthStatus" = 'HEALTHY', "syncStatus" = 'NOT_CONFIGURED', "lastError" = NULL, "updatedAt" = NOW()
           RETURNING "id"`;

export const UPSERT_CONNECTION_FROM_TOKENS_1 = `SELECT id FROM "EmailConnection"
           WHERE "orgId" = $1 AND provider = $2 AND "externalAccountId" = $3`;

export const ENSURE_INBOX_BINDING_0 = `SELECT scopes FROM "EmailConnection"
           WHERE id = $1 AND "orgId" = $2`;

export const ENSURE_INBOX_BINDING_1 = `INSERT INTO "EmailInboxBinding" (
               id, "orgId", "emailConnectionId", status,
               "inboundStatus", "outboundStatus", "createdAt", "updatedAt"
           ) VALUES ($1, $2, $3, 'ACTIVE', $4, $5, NOW(), NOW())
           ON CONFLICT ("emailConnectionId") DO UPDATE SET
               "orgId" = EXCLUDED."orgId",
               "inboundStatus" = CASE
                   WHEN "EmailInboxBinding".status = 'ACTIVE' THEN
                       CASE WHEN "EmailInboxBinding"."inboundStatus" = 'SYNCING'
                            THEN 'SYNCING' ELSE EXCLUDED."inboundStatus" END
                   ELSE "EmailInboxBinding"."inboundStatus"
               END,
               "outboundStatus" = CASE
                   WHEN "EmailInboxBinding".status = 'ACTIVE' THEN EXCLUDED."outboundStatus"
                   ELSE "EmailInboxBinding"."outboundStatus"
               END,
               "updatedAt" = NOW()`;

export const LIST_0 = `SELECT connection.id, connection.provider, connection."externalAccountId" AS external_account_id, connection."emailAddress" AS email_address,
                  connection."displayName" AS display_name, connection.status, connection."healthStatus" AS health_status,
                  connection."syncStatus" AS sync_status, connection."lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  connection."lastError" AS last_error, connection.scopes,
                  connection."createdAt" AT TIME ZONE 'UTC' AS created_at, connection."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
                  COALESCE(binding.status, 'UNBOUND') AS inbox_status,
                  COALESCE(binding."inboundStatus", 'UNCONFIGURED') AS inbound_status,
                  COALESCE(binding."outboundStatus", 'UNCONFIGURED') AS outbound_status
           FROM "EmailConnection" connection
           LEFT JOIN "EmailInboxBinding" binding ON binding."emailConnectionId" = connection.id
           WHERE connection."orgId" = $1 ORDER BY provider, "emailAddress"`;

export const GET_CONNECTION_0 = `SELECT connection.id, connection.provider, connection."externalAccountId" AS external_account_id, connection."emailAddress" AS email_address,
                  connection."displayName" AS display_name, connection.status, connection."healthStatus" AS health_status,
                  connection."syncStatus" AS sync_status, connection."lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  connection."lastError" AS last_error, connection.scopes,
                  connection."createdAt" AT TIME ZONE 'UTC' AS created_at, connection."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
                  COALESCE(binding.status, 'UNBOUND') AS inbox_status,
                  COALESCE(binding."inboundStatus", 'UNCONFIGURED') AS inbound_status,
                  COALESCE(binding."outboundStatus", 'UNCONFIGURED') AS outbound_status
           FROM "EmailConnection" connection
           LEFT JOIN "EmailInboxBinding" binding ON binding."emailConnectionId" = connection.id
           WHERE connection."orgId" = $1 AND connection.provider = $2 AND connection."externalAccountId" = $3`;

export const GET_CONNECTION_BY_ID_0 = `SELECT connection.id, connection.provider, connection."externalAccountId" AS external_account_id, connection."emailAddress" AS email_address,
                  connection."displayName" AS display_name, connection.status, connection."healthStatus" AS health_status,
                  connection."syncStatus" AS sync_status, connection."lastSyncedAt" AT TIME ZONE 'UTC' AS last_synced_at,
                  connection."lastError" AS last_error, connection.scopes,
                  connection."createdAt" AT TIME ZONE 'UTC' AS created_at, connection."updatedAt" AT TIME ZONE 'UTC' AS updated_at,
                  COALESCE(binding.status, 'UNBOUND') AS inbox_status,
                  COALESCE(binding."inboundStatus", 'UNCONFIGURED') AS inbound_status,
                  COALESCE(binding."outboundStatus", 'UNCONFIGURED') AS outbound_status
           FROM "EmailConnection" connection
           LEFT JOIN "EmailInboxBinding" binding ON binding."emailConnectionId" = connection.id
           WHERE connection."orgId" = $1 AND connection.id = $2`;

export const RESOLVE_EMAIL_CREDENTIAL_0 = `SELECT id, provider, "emailAddress" AS email_address,
                  "accessToken" AS access_token, "refreshToken" AS refresh_token,
                  "tokenExpiresAt" AT TIME ZONE 'UTC' AS token_expires_at
           FROM "EmailConnection"
           WHERE "orgId" = $1 AND status = 'CONNECTED'
             AND ($2::text IS NULL OR provider = $2)
             AND ($3::text IS NULL OR lower("emailAddress") = lower($3) OR lower("displayName") = lower($3))
           ORDER BY provider, "emailAddress"`;

export const RESOLVE_EMAIL_CREDENTIAL_BY_ID_0 = `SELECT id, provider, "emailAddress" AS email_address,
                  "accessToken" AS access_token, "refreshToken" AS refresh_token,
                  "tokenExpiresAt" AT TIME ZONE 'UTC' AS token_expires_at
           FROM "EmailConnection"
           WHERE id = $1 AND "orgId" = $2 AND status = 'CONNECTED'`;

export const ACCESS_TOKEN_0 = `UPDATE "EmailConnection" SET "accessToken" = $1, "refreshToken" = COALESCE($2, "refreshToken"), "tokenExpiresAt" = $3, "updatedAt" = NOW() WHERE id = $4`;
