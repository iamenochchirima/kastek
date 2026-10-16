export const SQL: Record<string, string[]> = {
  list_call_rows: [
    `SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE wc."orgId" = $1
        ORDER BY COALESCE(s."startedAt", s."createdAt") DESC`,
  ],
  scoped_call_row: [
    `SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE s.id = $1 AND wc."orgId" = $2
        LIMIT 1`,
  ],
  call_row_by_wa_call_id: [
    `SELECT s.id,
               s."userId" AS user_id,
               s."connectionId" AS connection_id,
               s."conversationId" AS conversation_id,
               s.direction::text AS direction,
               s.status::text AS status,
               s."waCallId" AS wa_call_id,
               s."fromPhone" AS from_phone,
               s."toPhone" AS to_phone,
               s."agentLabel" AS agent_label,
               s."startedAt" AT TIME ZONE 'UTC' AS started_at,
               s."answeredAt" AT TIME ZONE 'UTC' AS answered_at,
               s."endedAt" AT TIME ZONE 'UTC' AS ended_at,
               s."durationSeconds" AS duration_seconds,
               s."errorCode" AS error_code,
               s."errorMessage" AS error_message,
               s."rawPayload" AS raw_payload,
               c."customerName" AS conversation_customer_name,
               COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label,
               s."createdAt" AT TIME ZONE 'UTC' AS created_at,
               s."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        LEFT JOIN "Conversation" c ON c.id = s."conversationId"
        WHERE s."waCallId" = $1
        LIMIT 1`,
  ],
  call_event_rows: [
    `SELECT id,
               "sessionId" AS session_id,
               "eventType" AS event_type,
               status::text AS status,
               payload,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "WhatsappCallEvent"
        WHERE "sessionId" = $1
        ORDER BY "createdAt" ASC`,
  ],
  call_signal_rows: [
    `SELECT id,
               "sessionId" AS session_id,
               "eventType" AS event_type,
               status::text AS status,
               payload,
               "createdAt" AT TIME ZONE 'UTC' AS created_at
        FROM "WhatsappCallEvent"
        WHERE "sessionId" = $1
          AND "eventType" LIKE 'call.signal.%'
        ORDER BY "createdAt" ASC`,
  ],
  append_call_event: [
    `INSERT INTO "WhatsappCallEvent" (id, "sessionId", "eventType", status, payload, "createdAt")
        VALUES ($1, $2, $3, CAST($4 AS "WhatsappCallStatus"), $5, NOW())`,
  ],
  load_meta_offer_session: [
    `SELECT payload
        FROM "WhatsappCallEvent"
        WHERE "sessionId" = $1
          AND "eventType" = 'call.webhook.connect'
        ORDER BY "createdAt" DESC
        LIMIT 1`,
  ],
  load_call_connection_auth: [
    `SELECT "phoneNumberId" AS phone_number_id,
               "accessTokenEncrypted" AS access_token_encrypted
        FROM "WhatsappConnection"
        WHERE id = $1
        LIMIT 1`,
  ],
  find_or_create_conversation: [
    `SELECT id
        FROM "Conversation"
        WHERE "orgId" = $1 AND channel = 'whatsapp' AND "customerIdentifier" = $2
        LIMIT 1`,
    `UPDATE "Conversation" SET "customerName" = $1, "customerId" = COALESCE("customerId", $2), "updatedAt" = NOW() WHERE id = $3 AND "orgId" = $4`,
    `UPDATE "Conversation" SET "customerId" = COALESCE("customerId", $1), "updatedAt" = NOW() WHERE id = $2 AND "orgId" = $3`,
    `INSERT INTO "Conversation" (
            id, "orgId", channel, "customerIdentifier", "customerName", status,
            "lastMessageAt", "unreadCount", "externalConnectionId", "customerId",
            "createdAt", "updatedAt"
        )
        VALUES (
            $1, $2, 'whatsapp', $3, $4, 'active', $5, 0,
            (SELECT id FROM "ExternalConnection"
             WHERE "orgId" = $2 AND "sourceType" = 'WHATSAPP' AND "sourceId" = $6
             LIMIT 1),
            $7, NOW(), NOW()
        )`,
  ],
  ingest_webhook_calls: [
    `SELECT id,
               "userId",
               "orgId",
               "phoneNumberId",
               "phoneDisplayNumber"
        FROM "WhatsappConnection"
        WHERE "phoneNumberId" = $1
        LIMIT 1`,
    `UPDATE "WhatsappCallSession"
                SET "conversationId" = COALESCE($1, "conversationId"),
                    direction = CAST($2 AS "WhatsappCallDirection"),
                    status = CAST($3 AS "WhatsappCallStatus"),
                    "fromPhone" = $4,
                    "toPhone" = $5,
                    "startedAt" = COALESCE($6, "startedAt"),
                    "answeredAt" = COALESCE($7, "answeredAt"),
                    "endedAt" = COALESCE($8, "endedAt"),
                    "durationSeconds" = COALESCE($9, "durationSeconds"),
                    "errorCode" = COALESCE($10, "errorCode"),
                    "errorMessage" = COALESCE($11, "errorMessage"),
                    "rawPayload" = $12,
                    "updatedAt" = NOW()
                WHERE id = $13`,
    `INSERT INTO "WhatsappCallSession" (
                    id, "userId", "connectionId", "conversationId", direction, status, "waCallId",
                    "fromPhone", "toPhone", "rawPayload", "startedAt", "answeredAt", "endedAt",
                    "durationSeconds", "errorCode", "errorMessage", "createdAt", "updatedAt"
                )
                VALUES (
                    $1, $2, $3, $4, CAST($5 AS "WhatsappCallDirection"), CAST($6 AS "WhatsappCallStatus"), $7,
                    $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
                )`,
  ],
  call_summary: [
    `SELECT COUNT(*)::bigint AS total_calls,
               COUNT(*) FILTER (WHERE direction = 'INBOUND'::"WhatsappCallDirection")::bigint AS inbound_calls,
               COUNT(*) FILTER (WHERE direction = 'OUTBOUND'::"WhatsappCallDirection")::bigint AS outbound_calls,
               COUNT(*) FILTER (WHERE status = 'RINGING'::"WhatsappCallStatus")::bigint AS ringing_calls,
               COUNT(*) FILTER (WHERE status = 'ACTIVE'::"WhatsappCallStatus")::bigint AS active_calls,
               COUNT(*) FILTER (WHERE status = 'COMPLETED'::"WhatsappCallStatus")::bigint AS completed_calls,
               COUNT(*) FILTER (WHERE status = 'MISSED'::"WhatsappCallStatus")::bigint AS missed_calls,
               COUNT(*) FILTER (WHERE status = 'FAILED'::"WhatsappCallStatus")::bigint AS failed_calls,
               COUNT(*) FILTER (WHERE status = 'REJECTED'::"WhatsappCallStatus")::bigint AS rejected_calls,
               COUNT(*) FILTER (WHERE s."createdAt" >= NOW() - CAST($2 AS interval))::bigint AS recent_calls
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        WHERE wc."orgId" = $1`,
    `SELECT to_char(date_trunc('day', s."createdAt"), 'YYYY-MM-DD') AS day,
               COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE direction = 'INBOUND'::"WhatsappCallDirection")::bigint AS inbound,
               COUNT(*) FILTER (WHERE status = 'MISSED'::"WhatsappCallStatus")::bigint AS missed,
               COUNT(*) FILTER (WHERE status = 'COMPLETED'::"WhatsappCallStatus")::bigint AS completed
        FROM "WhatsappCallSession" s
        INNER JOIN "WhatsappConnection" wc ON wc.id = s."connectionId"
        WHERE wc."orgId" = $1
          AND s."createdAt" >= NOW() - CAST($2 AS interval)
        GROUP BY 1
        ORDER BY 1 DESC`,
  ],
  apply_call_action: [
    `UPDATE "WhatsappCallSession"
        SET status = CAST($1 AS "WhatsappCallStatus"),
            "answeredAt" = $2,
            "endedAt" = $3,
            "durationSeconds" = COALESCE($4, "durationSeconds"),
            "updatedAt" = NOW()
        FROM "WhatsappConnection" wc
        WHERE "WhatsappCallSession".id = $5
          AND wc.id = "WhatsappCallSession"."connectionId"
          AND wc."orgId" = $6`,
  ],
};
