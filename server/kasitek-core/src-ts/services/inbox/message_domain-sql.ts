export const LIST_TIMELINE_MESSAGES_0 = `SELECT
            m.id,
            m."conversationId" AS conversation_id,
            m.sender,
            m.content,
            m."contentType" AS content_type,
            m."whatsappMessageId" AS whatsapp_message_id,
            m."whatsappStatus" AS whatsapp_status,
            m."providerMessageId" AS provider_message_id,
            m."providerStatus" AS provider_status,
            m."errorCode" AS error_code,
            m."errorMessage" AS error_message,
            m."editedAt" AT TIME ZONE 'UTC' AS edited_at,
            m."deletedAt" AT TIME ZONE 'UTC' AS deleted_at,
            m.timestamp AT TIME ZONE 'UTC' AS timestamp,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', attachment.id,
                    'kind', attachment.kind,
                    'providerMediaId', attachment."providerMediaId",
                    'mimeType', attachment."mimeType",
                    'fileName', attachment."fileName",
                    'byteSize', attachment."byteSize",
                    'checksum', attachment.checksum,
                    'width', attachment.width,
                    'height', attachment.height,
                    'durationMs', attachment."durationMs",
                    'downloadStatus', attachment."downloadStatus",
                    'scanStatus', attachment."scanStatus",
                    'metadata', attachment.metadata
                ) ORDER BY attachment."createdAt" ASC)
                FROM "MessageAttachment" attachment
                WHERE attachment."messageId" = m.id
            ), '[]'::jsonb) AS attachments,
            (
                SELECT jsonb_build_object(
                    'messageId', reference."referencedMessageId",
                    'providerMessageId', reference."referencedProviderMessageId",
                    'kind', reference.kind,
                    'previewText', reference."previewText",
                    'previewKind', reference."previewKind"
                )
                FROM "MessageReference" reference
                WHERE reference."messageId" = m.id
            ) AS reference,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', reaction.id,
                    'emoji', reaction.emoji,
                    'actorIdentifier', reaction."actorIdentifier",
                    'active', reaction.active,
                    'occurredAt', reaction."occurredAt"
                ) ORDER BY reaction."occurredAt" ASC)
                FROM "MessageReaction" reaction
                WHERE reaction."messageId" = m.id
                  AND reaction.active = true
            ), '[]'::jsonb) AS reactions
        FROM "Message" m
        WHERE m."conversationId" = $1
        ORDER BY m.timestamp ASC`;

export const LIST_ACTIVE_REACTIONS_0 = `SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', reaction.id,
            'emoji', reaction.emoji,
            'actorIdentifier', reaction."actorIdentifier",
            'active', reaction.active,
            'occurredAt', reaction."occurredAt"
        ) ORDER BY reaction."occurredAt" ASC), '[]'::jsonb)
        FROM "MessageReaction" reaction
        WHERE reaction."messageId" = $1
          AND reaction.active = true`;

export const CREATE_REFERENCE_0 = `INSERT INTO "MessageReference" (
            id, "messageId", "referencedMessageId", "referencedProviderMessageId",
            kind, "previewText", "previewKind", "createdAt"
        ) VALUES ($1, $2, $3, $4, 'REPLY', $5, $6, NOW())`;

export const CREATE_ATTACHMENT_0 = `INSERT INTO "MessageAttachment" (
            id, "messageId", "providerMediaId", kind, "mimeType", "fileName", checksum,
            "downloadStatus", "scanStatus", metadata, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROVIDER_AVAILABLE', 'NOT_SCANNED', $8, NOW(), NOW())`;

export const UPSERT_REACTION_0 = `INSERT INTO "MessageReaction" (
            id, "messageId", "actorIdentifier", emoji, "providerEventId", active,
            "occurredAt", metadata, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW(), NOW())
        ON CONFLICT ("messageId", "actorIdentifier") DO UPDATE SET
            emoji = EXCLUDED.emoji,
            "providerEventId" = EXCLUDED."providerEventId",
            active = EXCLUDED.active,
            "occurredAt" = EXCLUDED."occurredAt",
            metadata = EXCLUDED.metadata,
            "updatedAt" = NOW()`;

export const RECORD_EVENT_0 = `INSERT INTO "MessageEvent" (
            id, "conversationId", "messageId", "providerEventId", kind, metadata,
            "occurredAt", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT ("conversationId", "providerEventId") DO NOTHING`;
