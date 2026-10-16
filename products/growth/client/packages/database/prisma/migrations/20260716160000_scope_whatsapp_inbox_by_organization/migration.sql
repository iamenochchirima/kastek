-- Older WhatsApp conversations predate direct workspace ownership. Their
-- identifier includes the connection ID, which provides the authoritative org.
UPDATE "Conversation" conversation
SET "orgId" = connection."orgId",
    "updatedAt" = NOW()
FROM "WhatsappConnection" connection
WHERE conversation.channel = 'whatsapp'
  AND conversation."customerIdentifier" LIKE 'wa:%'
  AND connection.id = split_part(conversation."customerIdentifier", ':', 2)
  AND connection."orgId" IS NOT NULL
  AND conversation."orgId" IS DISTINCT FROM connection."orgId";

UPDATE "Conversation" conversation
SET "orgId" = channel."orgId",
    "updatedAt" = NOW()
FROM "SocialChannelConnection" channel
WHERE conversation.channel IN ('facebook', 'instagram')
  AND conversation."customerIdentifier" LIKE 'meta:%'
  AND channel.id = split_part(conversation."customerIdentifier", ':', 2)
  AND channel."orgId" IS NOT NULL
  AND conversation."orgId" IS DISTINCT FROM channel."orgId";
