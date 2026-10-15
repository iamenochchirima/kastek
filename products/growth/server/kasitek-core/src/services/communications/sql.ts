// SQL preserved from services/calls.rs.
export const sync = `
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", "conversationId", "whatsappSessionId",
            direction, status, "fromPhone", "toPhone", "agentLabel", "startedAt", "answeredAt", "endedAt",
            "durationSeconds", "errorCode", "errorMessage", "rawPayload", "createdAt", "updatedAt"
        )
        SELECT
            'call_' || session.id, $1, 'WHATSAPP', session."waCallId", external.id, session."conversationId", session.id,
            session.direction::text, session.status::text, session."fromPhone", session."toPhone", session."agentLabel",
            session."startedAt", session."answeredAt", session."endedAt", session."durationSeconds", session."errorCode",
            session."errorMessage", session."rawPayload", session."createdAt", session."updatedAt"
        FROM "WhatsappCallSession" session
        INNER JOIN "WhatsappConnection" connection ON connection.id = session."connectionId"
        LEFT JOIN "ExternalConnection" external
          ON external."orgId" = $1
         AND external."sourceType" = 'WHATSAPP'
         AND external."sourceId" = connection.id
        WHERE connection."orgId" = $1
        ON CONFLICT ("whatsappSessionId") DO UPDATE SET
            "providerCallId" = EXCLUDED."providerCallId",
            "connectionId" = EXCLUDED."connectionId",
            "conversationId" = EXCLUDED."conversationId",
            status = EXCLUDED.status,
            "agentLabel" = EXCLUDED."agentLabel",
            "startedAt" = EXCLUDED."startedAt",
            "answeredAt" = EXCLUDED."answeredAt",
            "endedAt" = EXCLUDED."endedAt",
            "durationSeconds" = EXCLUDED."durationSeconds",
            "errorCode" = EXCLUDED."errorCode",
            "errorMessage" = EXCLUDED."errorMessage",
            "rawPayload" = EXCLUDED."rawPayload",
            "updatedAt" = EXCLUDED."updatedAt"
        `;

export const list = `
        SELECT call.id, call.provider, call."providerCallId" AS provider_call_id,
               call."connectionId" AS connection_id, call."conversationId" AS conversation_id,
               call.direction, call.status, call."fromPhone" AS from_phone, call."toPhone" AS to_phone,
               call."agentLabel" AS agent_label, call."startedAt" AT TIME ZONE 'UTC' AS started_at,
               call."answeredAt" AT TIME ZONE 'UTC' AS answered_at, call."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               call."durationSeconds" AS duration_seconds, call."errorCode" AS error_code,
               call."errorMessage" AS error_message, connection."displayName" AS connection_label,
               conversation."customerName" AS conversation_customer_name,
               call."createdAt" AT TIME ZONE 'UTC' AS created_at,
               call."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "CommunicationCall" call
        LEFT JOIN "ExternalConnection" connection ON connection.id = call."connectionId"
        LEFT JOIN "Conversation" conversation ON conversation.id = call."conversationId"
        WHERE call."orgId" = $1
        ORDER BY COALESCE(call."startedAt", call."createdAt") DESC
        `;

export const summary = `
        SELECT COUNT(*)::bigint,
               COUNT(*) FILTER (WHERE direction = 'INBOUND')::bigint,
               COUNT(*) FILTER (WHERE direction = 'OUTBOUND')::bigint,
               COUNT(*) FILTER (WHERE status IN ('RINGING', 'CONNECTING', 'ACTIVE'))::bigint,
               COUNT(*) FILTER (WHERE status = 'MISSED')::bigint,
               COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint
        FROM "CommunicationCall"
        WHERE "orgId" = $1
          AND "createdAt" >= NOW() - ($2 * INTERVAL '1 day')
        `;

export const lookupNumber = `
        SELECT id, "orgId" AS org_id, "externalAccountId" AS phone_number
        FROM "ExternalConnection"
        WHERE provider = 'TWILIO'
          AND "sourceType" = 'VOICE'
          AND regexp_replace(COALESCE("externalAccountId", ''), '[^0-9]', '', 'g')
              = regexp_replace($1, '[^0-9]', '', 'g')
        LIMIT 1
        `;

export const record = `
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", direction, status,
            "fromPhone", "toPhone", "startedAt", "endedAt", "durationSeconds", "rawPayload",
            "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', $3, $4, $5, $6, $7, $8,
                NOW(), CASE WHEN $6 IN ('COMPLETED', 'MISSED', 'FAILED', 'CANCELLED') THEN NOW() ELSE NULL END,
                $9, $10, NOW(), NOW())
        ON CONFLICT (provider, "providerCallId") DO UPDATE SET
            status = EXCLUDED.status,
            direction = EXCLUDED.direction,
            "fromPhone" = EXCLUDED."fromPhone",
            "toPhone" = EXCLUDED."toPhone",
            "endedAt" = CASE WHEN EXCLUDED.status IN ('COMPLETED', 'MISSED', 'FAILED', 'CANCELLED')
                THEN NOW() ELSE "CommunicationCall"."endedAt" END,
            "durationSeconds" = COALESCE(EXCLUDED."durationSeconds", "CommunicationCall"."durationSeconds"),
            "rawPayload" = EXCLUDED."rawPayload",
            "updatedAt" = NOW()
        RETURNING id
        `;

export const lookupBrowser = `
        SELECT id, "orgId" AS org_id, "externalAccountId" AS phone_number
        FROM "ExternalConnection"
        WHERE id = $1 AND "orgId" = $2 AND provider = 'TWILIO' AND "sourceType" = 'VOICE'
        LIMIT 1
        `;

export const recordBrowser = `
        INSERT INTO "CommunicationCall" (
            id, "orgId", provider, "providerCallId", "connectionId", direction, status,
            "fromPhone", "toPhone", "startedAt", "rawPayload", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', $3, $4, 'OUTBOUND', 'CONNECTING', $5, $6, NOW(), $7, NOW(), NOW())
        ON CONFLICT (provider, "providerCallId") DO UPDATE SET
            status = 'CONNECTING', "connectionId" = EXCLUDED."connectionId",
            "fromPhone" = EXCLUDED."fromPhone", "toPhone" = EXCLUDED."toPhone",
            "rawPayload" = EXCLUDED."rawPayload", "updatedAt" = NOW()
        `;

export const existingConnection = `SELECT id FROM "ExternalConnection" WHERE "orgId" = $1 AND "sourceType" = 'VOICE' AND "sourceId" = $2 FOR UPDATE`;

export const createConnection = `
        INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "externalAccountId", "displayName",
            status, "credentialStatus", "healthStatus", "webhookStatus", metadata, "createdAt", "updatedAt"
        )
        VALUES ($1, $2, 'TWILIO', 'VOICE', $3, $4, $5, 'NOT_CONNECTED', 'MISSING', 'UNKNOWN', 'UNKNOWN',
                jsonb_build_object('phoneNumber', $4::text), NOW(), NOW())
        ON CONFLICT ("orgId", "sourceType", "sourceId") DO UPDATE SET
            "displayName" = EXCLUDED."displayName", "externalAccountId" = EXCLUDED."externalAccountId",
            metadata = EXCLUDED.metadata, "updatedAt" = NOW()
        RETURNING id, "displayName", "externalAccountId", "updatedAt" AT TIME ZONE 'UTC'
        `;
