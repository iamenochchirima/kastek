export const SAVE_0 = `INSERT INTO "AdminSavedReport" (id, name, "reportKey", config, "createdById", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id, name, "reportKey", config,
                  "createdById", ("createdAt" AT TIME ZONE 'UTC') AS created_at,
                  ("updatedAt" AT TIME ZONE 'UTC') AS updated_at`;

export const REMOVE_0 = `DELETE FROM "AdminSavedReport" WHERE id = $1 AND "createdById" = $2`;

export const EXPORT_0 = `INSERT INTO "AdminReportExportAuditEvent" (id, "adminId", "reportKey", days, format, status, "createdAt") VALUES ($1, $2, $3, $4, 'csv', 'REQUESTED', NOW())`;

export const EXPORT_1 = `UPDATE "AdminReportExportAuditEvent" SET status = 'FAILED' WHERE id = $1`;

export const EXPORT_2 = `UPDATE "AdminReportExportAuditEvent" SET status = 'SUCCEEDED' WHERE id = $1`;

export const LOAD_SAVED_REPORTS_0 = `SELECT report.id, report.name, report."reportKey", report.config,
               report."createdById", admin.name AS created_by_name,
               (report."createdAt" AT TIME ZONE 'UTC') AS created_at,
               (report."updatedAt" AT TIME ZONE 'UTC') AS updated_at
        FROM "AdminSavedReport" report
        JOIN "AdminUser" admin ON admin.id = report."createdById"
        WHERE report."createdById" = $1
        ORDER BY report."updatedAt" DESC
        LIMIT $2`;

export const WRITE_PLATFORM_OVERVIEW_0 = `WITH days AS (
          SELECT generate_series(
            date_trunc('day', $1::timestamp),
            date_trunc('day', ($2::timestamp - interval '1 microsecond')),
            interval '1 day'
          )::date AS date
        ), organizations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
        ), users AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
        ), active AS (
          SELECT date, COUNT(DISTINCT org_id)::BIGINT AS value FROM (
            SELECT date_trunc('day', "createdAt")::date AS date, "orgId" AS org_id
            FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL
            SELECT date_trunc('day', "createdAt")::date, "orgId"
            FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          ) activity GROUP BY date
        ), operations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(organizations.value, 0)::BIGINT AS new_organizations,
          COALESCE(users.value, 0)::BIGINT AS new_users,
          COALESCE(active.value, 0)::BIGINT AS active_organizations,
          COALESCE(operations.value, 0)::BIGINT AS operations,
          0::BIGINT AS collected_revenue_minor
        FROM days
        LEFT JOIN organizations USING (date)
        LEFT JOIN users USING (date)
        LEFT JOIN active USING (date)
        LEFT JOIN operations USING (date)
        ORDER BY days.date`;

export const WRITE_USAGE_DAILY_0 = `WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        ), operations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), conversations AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), messages AS (
          SELECT date_trunc('day', message."timestamp")::date AS date, COUNT(*)::BIGINT AS value
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2 GROUP BY 1
        ), calls AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "CommunicationCall" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), sends AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(operations.value, 0)::BIGINT AS operations,
          COALESCE(conversations.value, 0)::BIGINT AS conversations,
          COALESCE(messages.value, 0)::BIGINT AS messages,
          COALESCE(calls.value, 0)::BIGINT AS calls,
          COALESCE(sends.value, 0)::BIGINT AS campaign_sends,
          0::BIGINT AS credits_consumed
        FROM days
        LEFT JOIN operations USING (date)
        LEFT JOIN conversations USING (date)
        LEFT JOIN messages USING (date)
        LEFT JOIN calls USING (date)
        LEFT JOIN sends USING (date)
        ORDER BY days.date`;

export const WRITE_REVENUE_DAILY_0 = `WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        )
        SELECT days.date,
          0::BIGINT AS collected_revenue_minor,
          0::BIGINT AS refunds_minor,
          0::BIGINT AS paid_invoices,
          0::BIGINT AS failed_checkouts
        FROM days ORDER BY days.date`;

export const WRITE_CUSTOMER_COHORTS_0 = `SELECT organization.id, organization.name,
          NULL::text AS plan,
          COUNT(event.id)::BIGINT AS operations,
          COUNT(DISTINCT date_trunc('day', event."createdAt"))::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "PublicApiRequest" event ON event."orgId" = organization.id
          AND event."createdAt" >= $1 AND event."createdAt" < $2
        GROUP BY organization.id, organization.name
        ORDER BY operations DESC, active_days DESC, organization.name
        LIMIT 500`;