// SQL retained from services/workspace_reporting.rs; all reads are organization scoped.
export const CONNECTION_STATUS_SQL = '\n    SELECT status::text AS status, COUNT(*)::bigint AS count\n    FROM "ExternalConnection"\n    WHERE "orgId" = $1\n    GROUP BY status\n    ORDER BY status\n';
export const CONTENT_POST_COUNT_SQL = 'SELECT COUNT(*)::bigint FROM "SocialPost" WHERE "orgId" = $1';
export const CONTACT_COUNT_SQL = 'SELECT COUNT(*)::bigint FROM "WhatsappContact" WHERE "orgId" = $1';
export const OPTED_IN_CONTACT_COUNT_SQL = '\n    SELECT COUNT(DISTINCT "contactId")::bigint\n    FROM "WhatsappContactListMembership"\n    WHERE "orgId" = $1 AND "optIn" = true\n';
export const EXCLUDED_CONTACT_COUNT_SQL = '\n    SELECT COUNT(DISTINCT "contactId")::bigint\n    FROM "WhatsappContactListMembership"\n    WHERE "orgId" = $1 AND excluded = true\n';
export const CONVERSATION_COUNT_SQL = 'SELECT COUNT(*)::bigint FROM "Conversation" WHERE "orgId" = $1';
export const UNREAD_CONVERSATION_COUNT_SQL = '\n    SELECT COUNT(*)::bigint\n    FROM "Conversation"\n    WHERE "orgId" = $1 AND "unreadCount" > 0\n';
export const BOOKING_STATUS_SQL = '\n    SELECT status::text AS status, COUNT(*)::bigint AS count\n    FROM "Booking"\n    WHERE "orgId" = $1\n    GROUP BY status\n    ORDER BY status\n';
export const CAMPAIGN_STATUS_SQL = '\n    SELECT status::text AS status, COUNT(*)::bigint AS count\n    FROM "WhatsappCampaign"\n    WHERE "orgId" = $1\n    GROUP BY status\n    ORDER BY status\n';
export const TEMPLATE_STATUS_SQL = '\n    SELECT status::text AS status, COUNT(*)::bigint AS count\n    FROM "WhatsappTemplate"\n    WHERE "orgId" = $1\n    GROUP BY status\n    ORDER BY status\n';
