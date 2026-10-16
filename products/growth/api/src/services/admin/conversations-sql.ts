export const LIST_CONVERSATIONS_0 = `SELECT id, "orgId", "customerId", channel, "customerIdentifier", "customerName", status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS "lastMessageAt",
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        FROM "Conversation"
        WHERE "orgId" = $1
        ORDER BY "lastMessageAt" DESC`;

export const GET_CONVERSATION_0 = `SELECT id, "orgId", "customerId", channel, "customerIdentifier", "customerName", status,
               "lastMessageAt" AT TIME ZONE 'UTC' AS "lastMessageAt",
               "createdAt" AT TIME ZONE 'UTC' AS "createdAt"
        FROM "Conversation"
        WHERE id = $1
        LIMIT 1`;

export const GET_CONVERSATION_1 = `SELECT id, "conversationId", sender AS role, content, timestamp
        FROM "Message"
        WHERE "conversationId" = $1
        ORDER BY timestamp ASC`;
