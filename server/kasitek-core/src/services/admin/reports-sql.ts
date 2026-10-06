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
            SELECT date_trunc('day', "occurredAt")::date AS date, "orgId" AS org_id
            FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
            UNION ALL
            SELECT date_trunc('day', "createdAt")::date, "orgId"
            FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL
            SELECT date_trunc('day', "createdAt")::date, "orgId"
            FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          ) activity GROUP BY date
        ), usage AS (
          SELECT date_trunc('day', "occurredAt")::date AS date, COALESCE(SUM(quantity), 0)::BIGINT AS value
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
        ), revenue AS (
          SELECT date_trunc('day', "paidAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS value
          FROM "BillingInvoice"
          WHERE status = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(organizations.value, 0)::BIGINT AS new_organizations,
          COALESCE(users.value, 0)::BIGINT AS new_users,
          COALESCE(active.value, 0)::BIGINT AS active_organizations,
          COALESCE(usage.value, 0)::BIGINT AS operations,
          COALESCE(revenue.value, 0)::BIGINT AS collected_revenue_minor
        FROM days
        LEFT JOIN organizations USING (date)
        LEFT JOIN users USING (date)
        LEFT JOIN active USING (date)
        LEFT JOIN usage USING (date)
        LEFT JOIN revenue USING (date)
        ORDER BY days.date`;

export const WRITE_USAGE_DAILY_0 = `WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        ), usage AS (
          SELECT date_trunc('day', "occurredAt")::date AS date, COALESCE(SUM(quantity), 0)::BIGINT AS value
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
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
        ), credits AS (
          SELECT date_trunc('day', "createdAt")::date AS date, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS value
          FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(usage.value, 0)::BIGINT AS operations,
          COALESCE(conversations.value, 0)::BIGINT AS conversations,
          COALESCE(messages.value, 0)::BIGINT AS messages,
          COALESCE(calls.value, 0)::BIGINT AS calls,
          COALESCE(sends.value, 0)::BIGINT AS campaign_sends,
          COALESCE(credits.value, 0)::BIGINT AS credits_consumed
        FROM days
        LEFT JOIN usage USING (date)
        LEFT JOIN conversations USING (date)
        LEFT JOIN messages USING (date)
        LEFT JOIN calls USING (date)
        LEFT JOIN sends USING (date)
        LEFT JOIN credits USING (date)
        ORDER BY days.date`;

export const WRITE_REVENUE_DAILY_0 = `WITH days AS (
          SELECT generate_series(date_trunc('day', $1::timestamp), date_trunc('day', ($2::timestamp - interval '1 microsecond')), interval '1 day')::date AS date
        ), paid AS (
          SELECT date_trunc('day', "paidAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS amount, COUNT(*)::BIGINT AS invoices
          FROM "BillingInvoice" WHERE status = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY 1
        ), refunds AS (
          SELECT date_trunc('day', "updatedAt")::date AS date, COALESCE(SUM("amountMinor"), 0)::BIGINT AS amount
          FROM "BillingInvoice" WHERE status = 'REFUNDED' AND "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        ), failed AS (
          SELECT date_trunc('day', "updatedAt")::date AS date, COUNT(*)::BIGINT AS value
          FROM "BillingCheckout" WHERE status IN ('FAILED', 'ABANDONED') AND "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(paid.amount, 0)::BIGINT AS collected_revenue_minor,
          COALESCE(refunds.amount, 0)::BIGINT AS refunds_minor,
          COALESCE(paid.invoices, 0)::BIGINT AS paid_invoices,
          COALESCE(failed.value, 0)::BIGINT AS failed_checkouts
        FROM days LEFT JOIN paid USING (date) LEFT JOIN refunds USING (date) LEFT JOIN failed USING (date)
        ORDER BY days.date`;

export const WRITE_CUSTOMER_COHORTS_0 = `SELECT organization.id, organization.name,
          current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT date_trunc('day', event."occurredAt"))::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event ON event."orgId" = organization.id AND event."occurredAt" >= $1 AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription
          JOIN "ProductPlan" plan ON plan.id = subscription."planId"
          JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id AND subscription.status IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
          ORDER BY subscription."createdAt" DESC LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        ORDER BY operations DESC, active_days DESC, organization.name
        LIMIT 500`;
