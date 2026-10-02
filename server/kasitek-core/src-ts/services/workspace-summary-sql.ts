export const SOCIAL_POST_COUNT_SQL = `SELECT COUNT(*) FROM "SocialPost" WHERE "orgId" = $1`;

export const TEMPLATE_STATUS_SQL = `SELECT status::text AS status, COUNT(*) AS count
    FROM "WhatsappTemplate"
    WHERE "orgId" = $1
    GROUP BY status`;

export const CAMPAIGN_SUMMARY_SQL = `SELECT
        COUNT(*) AS total_campaigns,
        COALESCE(SUM("totalRecipients"), 0) AS total_recipients,
        COALESCE(SUM("deliveredCount"), 0) AS delivered_count,
        COALESCE(SUM("readCount"), 0) AS read_count,
        COALESCE(SUM("failedCount"), 0) AS failed_count,
        COALESCE(SUM("blockedCount"), 0) AS blocked_count
    FROM "WhatsappCampaign"
    WHERE "orgId" = $1`;

export const ACTIVE_CAMPAIGNS_SQL = `SELECT COUNT(*) FROM "WhatsappCampaign"
    WHERE "orgId" = $1
      AND status IN (
        'DRAFT'::"WhatsappCampaignStatus",
        'SCHEDULED'::"WhatsappCampaignStatus",
        'SENDING'::"WhatsappCampaignStatus",
        'PAUSED'::"WhatsappCampaignStatus"
      )`;

export const RECENT_CAMPAIGNS_SQL = `SELECT
        c.id,
        c.name,
        c.status::text AS status,
        c."totalRecipients" AS total_recipients,
        c."deliveredCount" AS delivered_count,
        c."readCount" AS read_count,
        c."templateName" AS template_name,
        COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId") AS connection_label
    FROM "WhatsappCampaign" c
    LEFT JOIN "WhatsappConnection" wc ON wc.id = c."connectionId"
    WHERE c."orgId" = $1
    ORDER BY c."updatedAt" DESC
    LIMIT 5`;

export const TOTAL_CONTACTS_SQL = `SELECT COUNT(*) FROM "WhatsappContact" WHERE "orgId" = $1`;

export const OPTED_IN_CONTACTS_SQL = `SELECT COUNT(*) FROM "WhatsappContact" WHERE "orgId" = $1 AND "optIn" = true`;

export const EXCLUDED_CONTACTS_SQL = `SELECT COUNT(*) FROM "WhatsappContact" WHERE "orgId" = $1 AND excluded = true`;

export const SEND_BREAKDOWN_SQL = `SELECT status::text AS status, COUNT(*) AS count
    FROM "WhatsappSendEvent"
    WHERE "orgId" = $1 AND "createdAt" >= $2
    GROUP BY status`;

export const REVIEW_QUEUE_SQL = `SELECT
        t.id,
        t."templateName" AS template_name,
        t.status::text AS status,
        t.body,
        COALESCE(c."phoneDisplayNumber", c."phoneNumberId") AS connection_label
    FROM "WhatsappTemplate" t
    LEFT JOIN "WhatsappConnection" c ON c.id = t."connectionId"
    WHERE t."orgId" = $1
      AND t.status IN ('PENDING'::"WhatsappTemplateStatus", 'REJECTED'::"WhatsappTemplateStatus")
    ORDER BY t."updatedAt" DESC
    LIMIT 4`;

export const CAMPAIGN_SENDS_SQL = `SELECT c."connectionId" AS connection_id, COUNT(*) AS count
    FROM "WhatsappCampaignRecipient" r
    JOIN "WhatsappCampaign" c ON c.id = r."campaignId"
    WHERE c."orgId" = $1
      AND r."sentAt" >= $2
    GROUP BY c."connectionId"`;

export const UNREAD_CONVERSATIONS_SQL = `SELECT COUNT(*) FROM "Conversation" WHERE "orgId" = $1 AND "unreadCount" > 0`;

export const SOCIAL_ATTENTION_SQL = `SELECT COUNT(*) FROM "SocialPost" WHERE "orgId" = $1 AND status IN ('FAILED', 'DRAFT')`;

export const CONNECTION_ATTENTION_SQL = `SELECT COUNT(*) FROM "ExternalConnection" WHERE "orgId" = $1
      AND (status IN ('DISCONNECTED', 'REVOKED', 'NEEDS_ATTENTION') OR "healthStatus" = 'NEEDS_ATTENTION')`;
