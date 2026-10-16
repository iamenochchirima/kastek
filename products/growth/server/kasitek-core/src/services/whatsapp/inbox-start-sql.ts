// Existing approved-template inbox conversation lifecycle.
export const START_CONVERSATION_0 =
  '\n        SELECT id, "userId" AS user_id, "connectionId" AS connection_id, "templateName" AS template_name,\n               language, category::text AS category, header, body, footer, buttons,\n               "variablesCount" AS variables_count, status::text AS status,\n               "lastSynced" AT TIME ZONE \'UTC\' AS last_synced, "createdAt" AT TIME ZONE \'UTC\' AS created_at, "updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "WhatsappTemplate"\n        WHERE id = $1 AND "orgId" = $2 AND status = \'APPROVED\'::"WhatsappTemplateStatus"\n        LIMIT 1\n        ';
export const START_CONVERSATION_1 =
  'SELECT id FROM "WhatsappContact" WHERE "orgId" = $1 AND phone = $2 LIMIT 1';
export const START_CONVERSATION_2 =
  'INSERT INTO "WhatsappContact" (id, "userId", "orgId", phone, "fullName", tags, "optIn", excluded, "createdAt", "updatedAt")\n               VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, NOW(), NOW())';
export const START_CONVERSATION_3 =
  '\n        UPDATE "WhatsappContact"\n        SET "customerId" = $1, "updatedAt" = NOW()\n        WHERE id = $2 AND "orgId" = $3\n        ';
export const START_CONVERSATION_4 =
  '\n        INSERT INTO "Message" (id, "conversationId", sender, content, "whatsappMessageId", "providerMetadata", timestamp)\n        VALUES ($1, $2, \'bot\', $3, $4, $5::jsonb, $6)\n        ';
export const START_CONVERSATION_5 =
  'UPDATE "Conversation" SET "lastMessageAt" = $1, status = \'active\', "customerName" = COALESCE($2, "customerName"), "updatedAt" = NOW() WHERE id = $3';
