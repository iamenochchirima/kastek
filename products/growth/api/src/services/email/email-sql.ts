export const SYNC_ALL_CONNECTIONS_0 = `SELECT binding."orgId", binding."emailConnectionId"
           FROM "EmailInboxBinding" binding
           JOIN "EmailConnection" connection ON connection.id = binding."emailConnectionId"
           WHERE binding.status = 'ACTIVE' AND connection.status = 'CONNECTED'
           ORDER BY COALESCE(binding."lastSyncedAt", binding."createdAt") ASC
           LIMIT $1`;

export const SYNC_CONNECTION_0 = `SELECT status, "lastSyncedAt" AT TIME ZONE 'UTC'
           FROM "EmailInboxBinding"
           WHERE "orgId" = $1 AND "emailConnectionId" = $2`;

export const SYNC_CONNECTION_1 = `UPDATE "EmailInboxBinding"
           SET "inboundStatus" = 'SYNCING', "lastError" = NULL, "updatedAt" = NOW()
           WHERE "orgId" = $1 AND "emailConnectionId" = $2
             AND status = 'ACTIVE'
             AND ("inboundStatus" <> 'SYNCING' OR "updatedAt" < NOW() - INTERVAL '10 minutes')
           RETURNING id`;

export const SET_SYNC_STATE_0 = `UPDATE "EmailInboxBinding"
           SET "inboundStatus" = $1,
               "lastError" = $2,
               "lastSyncedAt" = CASE WHEN $1 = 'READY' THEN NOW() ELSE "lastSyncedAt" END,
               "updatedAt" = NOW()
           WHERE "orgId" = $3 AND "emailConnectionId" = $4`;

export const SET_SYNC_STATE_1 = `UPDATE "EmailConnection"
           SET "syncStatus" = $1,
               "lastSyncedAt" = CASE WHEN $1 = 'READY' THEN NOW() ELSE "lastSyncedAt" END,
               "lastError" = $2,
               "healthStatus" = CASE WHEN $1 IN ('READY', 'SYNCING') THEN 'HEALTHY' ELSE 'NEEDS_ATTENTION' END,
               "updatedAt" = NOW()
           WHERE "orgId" = $3 AND id = $4`;

export const PERSIST_INBOX_MESSAGE_0 = `INSERT INTO "Conversation" (
               id, channel, "customerIdentifier", "customerName", status,
               "lastMessageAt", "unreadCount", "orgId", "externalConnectionId", "createdAt", "updatedAt"
           ) VALUES ($1, 'email', $2, $3, 'active', $4, 0, $5, $6, NOW(), NOW())
           ON CONFLICT (channel, "customerIdentifier") DO UPDATE SET
               "customerName" = COALESCE(EXCLUDED."customerName", "Conversation"."customerName"),
               "externalConnectionId" = COALESCE("Conversation"."externalConnectionId", EXCLUDED."externalConnectionId"),
               "updatedAt" = NOW()
           RETURNING id`;

export const PERSIST_INBOX_MESSAGE_1 = `INSERT INTO "Message" (
               id, "conversationId", sender, content, "contentType",
               "providerMessageId", "providerStatus", "providerMetadata", timestamp
           ) VALUES ($1, $2, $3, $4, 'TEXT', $5, $6, $7, $8)
           ON CONFLICT ("conversationId", "providerMessageId") DO NOTHING
           RETURNING id`;

export const PERSIST_INBOX_MESSAGE_2 = `UPDATE "Conversation"
           SET "lastMessageAt" = GREATEST("lastMessageAt", $1),
               "unreadCount" = "unreadCount" + $2,
               status = 'active', "updatedAt" = NOW()
           WHERE id = $3`;
