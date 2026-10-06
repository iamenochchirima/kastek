export const LIST_INBOX_CONVERSATIONS_0 = `SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c."unreadCount" AS unread_count,
            scc.id AS channel_connection_id,
            scc."displayName" AS channel_label,
            last_message.content AS last_message_content
        FROM "Conversation" c
        JOIN "SocialChannelConnection" scc
          ON scc.id = split_part(c."customerIdentifier", ':', 2)
        JOIN "ExternalConnection" connection
          ON connection.id = c."externalConnectionId"
         AND connection."orgId" = c."orgId"
        LEFT JOIN LATERAL (
            SELECT m.content
            FROM "Message" m
            WHERE m."conversationId" = c.id
            ORDER BY m.timestamp DESC
            LIMIT 1
        ) last_message ON true
        WHERE c.channel IN ('facebook', 'instagram')
          AND c."orgId" = $1
          AND scc."orgId" = $1
          AND c."customerIdentifier" LIKE 'meta:%'
        ORDER BY c."lastMessageAt" DESC`;

export const LIST_INBOX_CONVERSATIONS_1 = `SELECT
            c.id,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c."unreadCount" AS unread_count,
            source."sourceId" AS email_connection_id,
            source."displayName" || ' · ' || COALESCE(source.handle, '') AS connection_label,
            last_message.content AS last_message_content,
            last_message.subject AS last_message_subject,
            last_message.from_address AS last_message_from
        FROM "Conversation" c
        JOIN "ExternalConnection" source
          ON source.id = c."externalConnectionId"
         AND source."orgId" = c."orgId"
         AND source."sourceType" = 'EMAIL'
        LEFT JOIN LATERAL (
            SELECT m.content,
                   m."providerMetadata"->>'subject' AS subject,
                   m."providerMetadata"->>'from' AS from_address
            FROM "Message" m
            WHERE m."conversationId" = c.id
            ORDER BY m.timestamp DESC
            LIMIT 1
        ) last_message ON true
        WHERE c.channel = 'email'
          AND c."orgId" = $1
        ORDER BY c."lastMessageAt" DESC`;

export const DOWNLOAD_MESSAGE_ATTACHMENT_0 = `SELECT
            c.channel,
            attachment.kind,
            attachment."providerMediaId",
            attachment."mimeType",
            attachment."fileName",
            attachment.metadata AS attachment_metadata,
            channel.platform::text,
            channel."accessToken",
            channel.metadata AS channel_metadata,
            message."providerMetadata"
        FROM "MessageAttachment" attachment
        JOIN "Message" message ON message.id = attachment."messageId"
        JOIN "Conversation" c ON c.id = message."conversationId"
        JOIN "SocialChannelConnection" channel
          ON channel.id = split_part(c."customerIdentifier", ':', 2)
         AND channel."orgId" = c."orgId"
        WHERE attachment.id = $1
          AND message.id = $2
          AND c."orgId" = $3
          AND c.channel IN ('facebook', 'instagram')
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
        LIMIT 1`;

export const SEND_CONVERSATION_MESSAGE_0 = `SELECT id, "conversationId" AS conversation_id, sender, content,
                       "whatsappMessageId" AS whatsapp_message_id,
                       "whatsappStatus" AS whatsapp_status,
                       "providerMessageId" AS provider_message_id,
                       "providerStatus" AS provider_status,
                       "errorCode" AS error_code,
                       "errorMessage" AS error_message,
                       timestamp AT TIME ZONE 'UTC' AS timestamp
                FROM "Message"
                WHERE id = $1 AND "conversationId" = $2
                LIMIT 1`;

export const SEND_CONVERSATION_MESSAGE_1 = `INSERT INTO "Message" (
            id, "conversationId", sender, content, "contentType",
            "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'PROCESSING', $4, $5)`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_0 = `SELECT id, content, "providerMessageId" AS provider_message_id,
                          "providerMetadata" AS provider_metadata
                   FROM "Message"
                   WHERE id = $1 AND "conversationId" = $2
                   LIMIT 1`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_1 = `SELECT id, content, "providerMessageId" AS provider_message_id,
                      "providerMetadata" AS provider_metadata
               FROM "Message"
               WHERE "conversationId" = $1 AND sender = 'customer'
               ORDER BY timestamp DESC
               LIMIT 1`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_2 = `INSERT INTO "Message" (
               id, "conversationId", sender, content, "contentType",
               "providerMessageId", "providerStatus", "providerMetadata", timestamp
           ) VALUES ($1, $2, 'bot', $3, 'TEXT', $4, 'SENDING', $5, $6)`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_3 = `UPDATE "Message"
                   SET "providerMessageId" = COALESCE($1, "providerMessageId"),
                       "providerStatus" = 'SENT', "errorCode" = NULL, "errorMessage" = NULL
                   WHERE id = $2 AND "conversationId" = $3`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_4 = `UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW()
                   WHERE id = $1 AND "orgId" = $2`;

export const SEND_EMAIL_CONVERSATION_MESSAGE_5 = `UPDATE "Message" SET "providerStatus" = 'FAILED', "errorCode" = 'EMAIL_SEND_FAILED', "errorMessage" = $1 WHERE id = $2`;

export const RETRY_CONVERSATION_MESSAGE_0 = `UPDATE "Message"
        SET "providerStatus" = 'PROCESSING',
            "errorCode" = NULL,
            "errorMessage" = NULL
        WHERE id = $1
          AND "conversationId" = $2
          AND sender = 'bot'
          AND "contentType" = 'TEXT'
          AND "providerStatus" = 'FAILED'
        RETURNING id, "conversationId" AS conversation_id, sender, content,
                  "whatsappMessageId" AS whatsapp_message_id,
                  "whatsappStatus" AS whatsapp_status,
                  "providerMessageId" AS provider_message_id,
                  "providerStatus" AS provider_status,
                  "errorCode" AS error_code,
                  "errorMessage" AS error_message,
                  timestamp AT TIME ZONE 'UTC' AS timestamp`;

export const RETRY_CONVERSATION_MESSAGE_1 = `SELECT "referencedProviderMessageId"
        FROM "MessageReference"
        WHERE "messageId" = $1
        LIMIT 1`;

export const RETRY_EMAIL_CONVERSATION_MESSAGE_0 = `UPDATE "Message"
           SET "providerStatus" = 'SENDING', "errorCode" = NULL, "errorMessage" = NULL
           WHERE id = $1 AND "conversationId" = $2 AND sender = 'bot' AND "providerStatus" = 'FAILED'
           RETURNING id, content, "providerMessageId" AS provider_message_id,
                     "providerMetadata" AS provider_metadata`;

export const RETRY_EMAIL_CONVERSATION_MESSAGE_1 = `UPDATE "Message" SET "providerMessageId" = COALESCE($1, "providerMessageId"),
                   "providerStatus" = 'SENT', "errorCode" = NULL, "errorMessage" = NULL WHERE id = $2`;

export const RETRY_EMAIL_CONVERSATION_MESSAGE_2 = `UPDATE "Message" SET "providerStatus" = 'FAILED', "errorCode" = 'EMAIL_SEND_FAILED', "errorMessage" = $1 WHERE id = $2`;

export const DELIVER_META_TEXT_MESSAGE_0 = `UPDATE "Message"
            SET "providerStatus" = 'FAILED',
                "errorCode" = 'META_SEND_FAILED',
                "errorMessage" = $1
            WHERE id = $2`;

export const TRY_DELIVER_META_TEXT_MESSAGE_0 = `WITH updated_message AS (
            UPDATE "Message"
            SET "providerMessageId" = $1,
                "providerStatus" = 'SENT',
                "errorCode" = NULL,
                "errorMessage" = NULL
            WHERE id = $2
            RETURNING 1
        )
        UPDATE "Conversation"
        SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW()
        WHERE id = $3
          AND EXISTS (SELECT 1 FROM updated_message)`;

export const DELIVER_AGENT_META_MESSAGE_0 = `SELECT "providerMessageId", "providerStatus"
        FROM "Message"
        WHERE "conversationId" = $1
          AND "providerMetadata"->>'_kasitek_agent_idempotency_key' = $2
        ORDER BY timestamp DESC
        LIMIT 1`;

export const DELIVER_AGENT_META_MESSAGE_1 = `INSERT INTO "Message" (id, "conversationId", sender, content, "contentType", "providerStatus", "providerMetadata", timestamp)
        VALUES ($1, $2, 'bot', $3, 'TEXT', 'SENDING', $4::jsonb, $5)`;

export const DELIVER_AGENT_META_MESSAGE_2 = `UPDATE "Conversation" SET "lastMessageAt" = NOW(), status = 'active', "updatedAt" = NOW() WHERE id = $1 AND "orgId" = $2`;

export const DELIVER_AGENT_META_MESSAGE_3 = `UPDATE "Message" SET "providerMessageId" = $1, "providerStatus" = 'SENT', "errorCode" = NULL, "errorMessage" = NULL WHERE id = $2 AND "conversationId" = $3`;

export const DELIVER_AGENT_META_MESSAGE_4 = `UPDATE "Message" SET "providerStatus" = 'FAILED', "errorCode" = $1, "errorMessage" = $2 WHERE id = $3 AND "conversationId" = $4`;

export const MARK_CONVERSATION_READ_0 = `UPDATE "Conversation"
        SET "unreadCount" = 0, "lastReadAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1`;

export const PROCESS_META_WEBHOOK_PAYLOAD_0 = `SELECT id, "conversationId" AS conversation_id, sender, content,
                           "whatsappMessageId" AS whatsapp_message_id,
                           "whatsappStatus" AS whatsapp_status,
                           "providerMessageId" AS provider_message_id,
                           "providerStatus" AS provider_status,
                           "errorCode" AS error_code,
                           "errorMessage" AS error_message,
                           timestamp AT TIME ZONE 'UTC' AS timestamp
                    FROM "Message"
                    WHERE "conversationId" = $1 AND "providerMessageId" = $2
                    LIMIT 1`;

export const PROCESS_META_WEBHOOK_PAYLOAD_1 = `INSERT INTO "Message" (
                    id, "conversationId", sender, content, "contentType",
                    "providerMessageId", "providerStatus", "providerMetadata", timestamp
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT ("conversationId", "providerMessageId") DO NOTHING
                RETURNING id`;

export const PROCESS_META_WEBHOOK_PAYLOAD_2 = `UPDATE "Conversation"
                SET "lastMessageAt" = $1,
                    status = 'active',
                    "unreadCount" = "unreadCount" + $2, "updatedAt" = NOW()
                WHERE id = $3`;

export const SCOPED_CONVERSATION_0 = `SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c.starred,
            c."unreadCount" AS unread_count,
            c."createdAt" AT TIME ZONE 'UTC' AS created_at,
            c."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation" c
        WHERE c.id = $1
          AND c."orgId" = $2
        LIMIT 1`;

export const SCOPED_META_CONVERSATION_0 = `SELECT
            c.id,
            c.channel,
            c."customerIdentifier" AS customer_identifier,
            c."customerName" AS customer_name,
            c.status,
            c."lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
            c."lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
            c."unreadCount" AS unread_count,
            scc.id AS channel_connection_id,
            scc."displayName" AS channel_label,
            scc.platform::text AS platform,
            scc."externalAccountId" AS external_account_id,
            scc."accessToken" AS access_token,
            scc.metadata
        FROM "Conversation" c
        JOIN "SocialChannelConnection" scc
          ON scc.id = split_part(c."customerIdentifier", ':', 2)
         AND scc."orgId" = $2
         AND scc.status = 'CONNECTED'::"SocialChannelStatus"
        JOIN "ExternalConnection" connection
          ON connection.id = c."externalConnectionId"
         AND connection."orgId" = $2
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
        WHERE c.id = $1
          AND c."orgId" = $2
          AND c.channel IN ('facebook', 'instagram')
          AND c."customerIdentifier" LIKE 'meta:%'
        LIMIT 1`;

export const SCOPED_EMAIL_CONVERSATION_0 = `SELECT c.id,
                  email.provider,
                  email."emailAddress" AS email_address,
                  c."customerIdentifier" AS customer_identifier,
                  binding."outboundStatus" AS outbound_status
           FROM "Conversation" c
           JOIN "ExternalConnection" source
             ON source.id = c."externalConnectionId"
            AND source."orgId" = c."orgId"
            AND source."sourceType" = 'EMAIL'
           JOIN "EmailConnection" email
             ON email.id = source."sourceId"
            AND email."orgId" = c."orgId"
           JOIN "EmailInboxBinding" binding
             ON binding."emailConnectionId" = email.id
            AND binding."orgId" = c."orgId"
            AND binding.status = 'ACTIVE'
           WHERE c.id = $1 AND c."orgId" = $2 AND c.channel = 'email'
           LIMIT 1`;

export const RESOLVE_META_CHANNEL_0 = `SELECT
            channel.id,
            connection.id AS external_connection_id,
            channel."userId" AS user_id,
            channel."orgId" AS org_id,
            channel.platform::text AS platform,
            channel."displayName" AS display_name,
            channel."externalAccountId" AS external_account_id,
            channel."accessToken" AS access_token,
            channel.metadata
        FROM "SocialChannelConnection" channel
        JOIN "ExternalConnection" connection
          ON connection."orgId" = channel."orgId"
         AND connection."sourceType" = 'SOCIAL'
         AND connection."sourceId" = channel.id
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
        WHERE channel.platform = $1::"SocialPlatform"
          AND (
              channel."externalAccountId" = $2
              OR (
                  $1 = 'INSTAGRAM'
                  AND (
                      channel.metadata->>'instagramAccountId' = $2
                      OR channel.metadata->>'instagramUserId' = $2
                      OR channel.metadata->>'instagramAppScopedId' = $2
                  )
              )
          )
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
          AND channel."orgId" IS NOT NULL
        LIMIT 2`;

export const RESOLVE_META_CHANNEL_1 = `SELECT
            channel.id,
            connection.id AS external_connection_id,
            channel."userId" AS user_id,
            channel."orgId" AS org_id,
            channel.platform::text AS platform,
            channel."displayName" AS display_name,
            channel."externalAccountId" AS external_account_id,
            channel."accessToken" AS access_token,
            channel.metadata
        FROM "SocialChannelConnection" channel
        JOIN "ExternalConnection" connection
          ON connection."orgId" = channel."orgId"
         AND connection."sourceType" = 'SOCIAL'
         AND connection."sourceId" = channel.id
         AND connection.status = 'CONNECTED'::"ExternalConnectionStatus"
        WHERE channel.platform = 'INSTAGRAM'::"SocialPlatform"
          AND COALESCE(channel.metadata->>'pageId', '') = $1
          AND channel.status = 'CONNECTED'::"SocialChannelStatus"
          AND channel."orgId" IS NOT NULL
        LIMIT 2`;

export const FIND_OR_CREATE_META_CONVERSATION_0 = `INSERT INTO "Conversation" (
            id, channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "orgId", "externalConnectionId", "customerId",
            "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, $3, $4, $5, NOW(), 0, $6,
            $7,
            $8, NOW(), NOW()
        )
        ON CONFLICT (channel, "customerIdentifier") DO UPDATE SET
            "customerName" = COALESCE(EXCLUDED."customerName", "Conversation"."customerName"),
            "customerId" = COALESCE("Conversation"."customerId", EXCLUDED."customerId"),
            "externalConnectionId" = COALESCE(
                "Conversation"."externalConnectionId",
                EXCLUDED."externalConnectionId"
            ),
            "updatedAt" = NOW()
        WHERE "Conversation"."orgId" = EXCLUDED."orgId"
        RETURNING id, "unreadCount", (xmax = 0) AS created`;

export const RESOLVE_META_CUSTOMER_NAME_0 = `SELECT "customerName"
        FROM "Conversation"
        WHERE channel = $1
          AND "customerIdentifier" = $2
          AND "orgId" = $3
        LIMIT 1`;

export const LOAD_META_MESSAGE_ANALYTICS_ROWS_0 = `SELECT message.id,
               message."conversationId" AS conversation_id,
               conversation.channel,
               message.sender,
               message."contentType"::text AS message_type,
               message."providerMetadata" AS provider_metadata,
               conversation."orgId" AS org_id
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE message.id = ANY($1)`;

export const ENQUEUE_META_SOURCE_MANIFEST_0 = `SELECT COUNT(*)::bigint
        FROM "Message" message
        JOIN "Conversation" conversation
          ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation.channel IN ('facebook', 'instagram')`;

export const APPLY_META_DELIVERY_EVENT_0 = `UPDATE "Message" message
                SET "providerStatus" = 'DELIVERED', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation
                WHERE message."conversationId" = conversation.id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND message."providerMessageId" = ANY($3)
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED', 'DELIVERED')
                RETURNING message.id`;

export const APPLY_META_DELIVERY_EVENT_1 = `UPDATE "Message" message
                SET "providerStatus" = 'DELIVERED', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation
                WHERE message."conversationId" = conversation.id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND conversation.channel = $3
                  AND conversation."customerIdentifier" = $4
                  AND message.sender = 'bot'
                  AND message.timestamp <= to_timestamp($5::double precision / 1000.0)
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED', 'DELIVERED')
                RETURNING message.id`;

export const APPLY_META_DELIVERY_EVENT_2 = `SELECT message."providerMessageId"
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation."externalConnectionId" = $2
          AND message."providerMessageId" = ANY($3)`;

export const SYNC_MISSING_META_OUTBOUND_MESSAGE_0 = `INSERT INTO "Message" (
            id, "conversationId", sender, content, "contentType",
            "providerMessageId", "providerStatus", "providerMetadata", timestamp
        )
        VALUES ($1, $2, 'bot', $3, $4, $5, 'DELIVERED', $6, $7)
        ON CONFLICT ("conversationId", "providerMessageId") DO NOTHING
        RETURNING id`;

export const SYNC_MISSING_META_OUTBOUND_MESSAGE_1 = `UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", $2),
            status = 'active',
            "updatedAt" = NOW()
        WHERE id = $1`;

export const APPLY_META_READ_EVENT_0 = `WITH receipt_targets AS (
                    SELECT source."conversationId" AS conversation_id,
                           MAX(source.timestamp) AS read_through
                    FROM "Message" source
                    JOIN "Conversation" source_conversation
                      ON source_conversation.id = source."conversationId"
                    WHERE source_conversation."orgId" = $1
                      AND source_conversation."externalConnectionId" = $2
                      AND source."providerMessageId" = ANY($3)
                    GROUP BY source."conversationId"
                )
                UPDATE "Message" message
                SET "providerStatus" = 'READ', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation, receipt_targets target
                WHERE message."conversationId" = conversation.id
                  AND message."conversationId" = target.conversation_id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND message.sender = 'bot'
                  AND message.timestamp <= target.read_through
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED')
                RETURNING message.id`;

export const APPLY_META_READ_EVENT_1 = `UPDATE "Message" message
                SET "providerStatus" = 'READ', "errorCode" = NULL, "errorMessage" = NULL
                FROM "Conversation" conversation
                WHERE message."conversationId" = conversation.id
                  AND conversation."orgId" = $1
                  AND conversation."externalConnectionId" = $2
                  AND conversation.channel = $3
                  AND conversation."customerIdentifier" = $4
                  AND message.sender = 'bot'
                  AND message.timestamp <= to_timestamp($5::double precision / 1000.0)
                  AND COALESCE(message."providerStatus", '') NOT IN ('READ', 'FAILED')
                RETURNING message.id`;

export const APPLY_META_REACTION_EVENT_0 = `SELECT message.id, message."conversationId"
        FROM "Message" message
        JOIN "Conversation" conversation ON conversation.id = message."conversationId"
        WHERE conversation."orgId" = $1
          AND conversation."externalConnectionId" = $2
          AND conversation.channel = $3
          AND message."providerMessageId" = $4
        ORDER BY message.timestamp DESC
        LIMIT 1`;

export const PUBLISH_MESSAGE_UPDATED_0 = `SELECT id, "conversationId" AS conversation_id, sender, content,
               "whatsappMessageId" AS whatsapp_message_id,
               "whatsappStatus" AS whatsapp_status,
               "providerMessageId" AS provider_message_id,
               "providerStatus" AS provider_status,
               "errorCode" AS error_code,
               "errorMessage" AS error_message,
               timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1
        LIMIT 1`;

export const PUBLISH_MESSAGE_CREATED_0 = `SELECT
            id,
            "conversationId" AS conversation_id,
            sender,
            content,
            "whatsappMessageId" AS whatsapp_message_id,
            "whatsappStatus" AS whatsapp_status,
            "providerMessageId" AS provider_message_id,
            "providerStatus" AS provider_status,
            "errorCode" AS error_code,
            "errorMessage" AS error_message,
            timestamp AT TIME ZONE 'UTC' AS timestamp
        FROM "Message"
        WHERE id = $1
        LIMIT 1`;

export const CONVERSATION_CHANNEL_CONTEXT_0 = `SELECT COALESCE("phoneDisplayNumber", "phoneNumberId") FROM "WhatsappConnection" WHERE id = $1 LIMIT 1`;

export const CONVERSATION_CHANNEL_CONTEXT_1 = `SELECT "displayName" FROM "SocialChannelConnection" WHERE id = $1 LIMIT 1`;

export const CONVERSATION_CHANNEL_CONTEXT_2 = `SELECT source."displayName", source.handle
                       FROM "ExternalConnection" source
                       WHERE source."sourceType" = 'EMAIL' AND source."sourceId" = $1
                       LIMIT 1`;

export const CONVERSATION_ORG_ID_0 = `SELECT "orgId" FROM "Conversation" WHERE id = $1 AND "orgId" IS NOT NULL`;

export const LOAD_CONVERSATION_BY_ID_0 = `SELECT id, channel, "customerIdentifier" AS customer_identifier, "customerName" AS customer_name,
               status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS last_message_at,
               "lastReadAt" AT TIME ZONE 'UTC' AS last_read_at,
               starred,
               "unreadCount" AS unread_count,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "Conversation"
        WHERE id = $1
        LIMIT 1`;

