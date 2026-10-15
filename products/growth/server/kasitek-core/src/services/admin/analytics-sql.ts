export const LOAD_KPIS_0 = `SELECT COUNT(*) FROM "Organization"`;

export const LOAD_KPIS_1 = `SELECT COUNT(*) FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2`;

export const LOAD_KPIS_2 = `SELECT COUNT(DISTINCT org_id)
        FROM (
          SELECT "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
        ) activity
        WHERE org_id IS NOT NULL`;

export const LOAD_KPIS_3 = `SELECT COUNT(*) FROM "User"`;

export const LOAD_KPIS_4 = `SELECT COUNT(*) FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2`;

export const LOAD_KPIS_5 = `SELECT COUNT(DISTINCT owner_id)
        FROM (
          SELECT o."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2
          UNION ALL
          SELECT o."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2
          UNION ALL
          SELECT o."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2
        ) activity`;

export const LOAD_KPIS_6 = `SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')`;

export const LOAD_KPIS_7 = `SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" = 'TRIAL'`;

export const LOAD_KPIS_8 = `SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "status" = 'PAST_DUE'`;

export const LOAD_KPIS_9 = `SELECT COALESCE(SUM("amountMinor"), 0)::BIGINT FROM "BillingInvoice" WHERE "status" = 'PAID' AND "paidAt" >= $1 AND "paidAt" < $2`;

export const LOAD_KPIS_10 = `SELECT COALESCE(SUM(
          CASE WHEN plan.interval = 'YEARLY' THEN COALESCE(plan."amountMinor", 0) / 12 ELSE COALESCE(plan."amountMinor", 0) END
        ), 0)::BIGINT
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')`;

export const LOAD_KPIS_11 = `SELECT COUNT(*) FROM "BillingCheckout" WHERE "status" IN ('FAILED', 'ABANDONED') AND "updatedAt" >= $1 AND "updatedAt" < $2`;

export const LOAD_KPIS_12 = `SELECT COALESCE(SUM("quantity"), 0)::BIGINT FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2`;

export const LOAD_KPIS_13 = `SELECT COALESCE(SUM("quantity"), 0)::BIGINT FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 AND (LOWER("metricKey") LIKE '%fail%' OR LOWER("metricKey") LIKE '%error%')`;

export const LOAD_KPIS_14 = `SELECT COALESCE(SUM("creditsCharged"), 0)::BIGINT FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2`;

export const LOAD_DAILY_0 = `SELECT date_trunc('day', "createdAt") AS bucket, COUNT(*)::BIGINT AS value FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket`;

export const LOAD_DAILY_1 = `SELECT date_trunc('day', "createdAt") AS bucket, COUNT(*)::BIGINT AS value FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket`;

export const LOAD_DAILY_2 = `SELECT bucket, COUNT(DISTINCT org_id)::BIGINT AS value
        FROM (
          SELECT date_trunc('day', "occurredAt") AS bucket, "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
          UNION ALL
          SELECT date_trunc('day', "createdAt") AS bucket, "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
        ) activity
        WHERE org_id IS NOT NULL
        GROUP BY bucket ORDER BY bucket`;

export const LOAD_DAILY_3 = `SELECT date_trunc('day', "occurredAt") AS bucket, COALESCE(SUM("quantity"), 0)::BIGINT AS operations, COALESCE(SUM(CASE WHEN LOWER("metricKey") LIKE '%fail%' OR LOWER("metricKey") LIKE '%error%' THEN "quantity" ELSE 0 END), 0)::BIGINT AS failures FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY bucket ORDER BY bucket`;

export const LOAD_DAILY_4 = `SELECT date_trunc('day', "paidAt") AS bucket, COALESCE(SUM("amountMinor"), 0)::BIGINT AS value FROM "BillingInvoice" WHERE "status" = 'PAID' AND "paidAt" IS NOT NULL AND "paidAt" >= $1 AND "paidAt" < $2 GROUP BY bucket ORDER BY bucket`;

export const LOAD_DAILY_5 = `SELECT date_trunc('day', "createdAt") AS bucket, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS value FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY bucket ORDER BY bucket`;

export const LOAD_PRODUCT_MIX_0 = `SELECT "productKey" AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey" ORDER BY value DESC, key LIMIT 12`;

export const LOAD_PLAN_MIX_0 = `SELECT product.name AS product, plan.name AS plan, COUNT(subscription.id)::BIGINT AS subscriptions
        FROM "OrganizationSubscription" subscription
        JOIN "ProductPlan" plan ON plan.id = subscription."planId"
        JOIN "Product" product ON product.id = plan."productId"
        WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
        GROUP BY product.name, plan.name
        ORDER BY subscriptions DESC, product.name, plan.name
        LIMIT 20`;

export const LOAD_TOP_ORGANIZATIONS_0 = `SELECT
          organization.id,
          organization.name,
          current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT date_trunc('day', event."occurredAt"))::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event
          ON event."orgId" = organization.id
         AND event."occurredAt" >= $1
         AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription
          JOIN "ProductPlan" plan ON plan.id = subscription."planId"
          JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id
            AND subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL')
          ORDER BY subscription."createdAt" DESC
          LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        HAVING COALESCE(SUM(event.quantity), 0) > 0
        ORDER BY operations DESC, active_days DESC, organization.name
        LIMIT $3`;

export const LOAD_USAGE_DAILY_0 = `WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), usage AS (
          SELECT ("occurredAt" AT TIME ZONE 'UTC')::date AS date, COALESCE(SUM("quantity"), 0)::BIGINT AS operations
          FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY 1
        ), conversations AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS conversations
          FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), messages AS (
          SELECT (message."timestamp" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS messages
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2 GROUP BY 1
        ), calls AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS calls
          FROM "CommunicationCall" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), sends AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS campaign_sends
          FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), credits AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COALESCE(SUM("creditsCharged"), 0)::BIGINT AS credits_consumed
          FROM "CreditUsageEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(usage.operations, 0)::BIGINT AS operations,
          COALESCE(conversations.conversations, 0)::BIGINT AS conversations,
          COALESCE(messages.messages, 0)::BIGINT AS messages,
          COALESCE(calls.calls, 0)::BIGINT AS calls,
          COALESCE(sends.campaign_sends, 0)::BIGINT AS campaign_sends,
          COALESCE(credits.credits_consumed, 0)::BIGINT AS credits_consumed
        FROM days
        LEFT JOIN usage ON usage.date = days.date
        LEFT JOIN conversations ON conversations.date = days.date
        LEFT JOIN messages ON messages.date = days.date
        LEFT JOIN calls ON calls.date = days.date
        LEFT JOIN sends ON sends.date = days.date
        LEFT JOIN credits ON credits.date = days.date
        ORDER BY days.date`;

export const LOAD_USAGE_PRODUCT_MIX_0 = `SELECT "productKey" AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey" ORDER BY value DESC, key LIMIT 16`;

export const LOAD_USAGE_METRIC_MIX_0 = `SELECT CONCAT("productKey", ':', "metricKey") AS key, COALESCE(SUM("quantity"), 0)::BIGINT AS value FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 GROUP BY "productKey", "metricKey" ORDER BY value DESC, key LIMIT 16`;

export const LOAD_USAGE_CHANNEL_MIX_0 = `SELECT channel AS key, COUNT(*)::BIGINT AS value FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 GROUP BY channel ORDER BY value DESC, key`;

export const LOAD_CAMPAIGN_FUNNEL_0 = `SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "WhatsappSendEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY "status" ORDER BY value DESC, key`;

export const LOAD_CONNECTION_MIX_0 = `SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "ExternalConnection" GROUP BY "status" ORDER BY value DESC, key`;

export const LOAD_CREDIT_LIFECYCLE_0 = `SELECT "type" AS kind, COALESCE(SUM("amount"), 0)::BIGINT AS amount FROM "CreditLedgerEntry" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY "type" ORDER BY kind`;

export const REVENUE_0 = `SELECT "status" AS key, COUNT(*)::BIGINT AS value FROM "BillingCheckout" WHERE "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY "status" ORDER BY value DESC, key`;

export const REVENUE_1 = `SELECT "status" AS key, COUNT(*)::BIGINT AS value FROM "BillingInvoice" WHERE "issuedAt" >= $1 AND "issuedAt" < $2 GROUP BY "status" ORDER BY value DESC, key`;

export const REVENUE_2 = `SELECT "status"::text AS key, COUNT(*)::BIGINT AS value FROM "OrganizationSubscription" GROUP BY "status" ORDER BY value DESC, key`;

export const REVENUE_3 = `SELECT COALESCE(SUM(CASE WHEN plan.interval = 'YEARLY' THEN COALESCE(plan."amountMinor", 0) / 12 ELSE COALESCE(plan."amountMinor", 0) END), 0)::BIGINT FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')`;

export const LOAD_REVENUE_DAILY_0 = `WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), invoices AS (
          SELECT (COALESCE("paidAt", "issuedAt") AT TIME ZONE 'UTC')::date AS date,
            COALESCE(SUM(CASE WHEN "status" = 'PAID' THEN COALESCE("amountMinor", 0) ELSE 0 END), 0)::BIGINT AS collected_revenue_minor,
            COALESCE(SUM(CASE WHEN "status" IN ('REFUNDED', 'PARTIALLY_REFUNDED') THEN COALESCE("amountMinor", 0) ELSE 0 END), 0)::BIGINT AS refunds_minor,
            COUNT(*) FILTER (WHERE "status" = 'PAID')::BIGINT AS paid_invoices
          FROM "BillingInvoice"
          WHERE ("paidAt" >= $1 AND "paidAt" < $2) OR ("issuedAt" >= $1 AND "issuedAt" < $2)
          GROUP BY 1
        ), checkouts AS (
          SELECT ("updatedAt" AT TIME ZONE 'UTC')::date AS date,
            COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'ABANDONED'))::BIGINT AS failed_payments
          FROM "BillingCheckout" WHERE "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY 1
        ), subscriptions AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS new_subscriptions
          FROM "OrganizationSubscription" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), cancellations AS (
          SELECT ("cancelledAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS cancellations
          FROM "OrganizationSubscription" WHERE "cancelledAt" IS NOT NULL AND "cancelledAt" >= $1 AND "cancelledAt" < $2 GROUP BY 1
        )
        SELECT days.date,
          COALESCE(invoices.collected_revenue_minor, 0)::BIGINT AS collected_revenue_minor,
          COALESCE(invoices.refunds_minor, 0)::BIGINT AS refunds_minor,
          COALESCE(invoices.paid_invoices, 0)::BIGINT AS paid_invoices,
          COALESCE(checkouts.failed_payments, 0)::BIGINT AS failed_payments,
          COALESCE(subscriptions.new_subscriptions, 0)::BIGINT AS new_subscriptions,
          COALESCE(cancellations.cancellations, 0)::BIGINT AS cancellations
        FROM days LEFT JOIN invoices ON invoices.date = days.date
        LEFT JOIN checkouts ON checkouts.date = days.date
        LEFT JOIN subscriptions ON subscriptions.date = days.date
        LEFT JOIN cancellations ON cancellations.date = days.date
        ORDER BY days.date`;

export const CUSTOMERS_0 = `SELECT COUNT(*) FROM "Organization"`;

export const CUSTOMERS_1 = `SELECT COUNT(*) FROM "User"`;

export const CUSTOMERS_2 = `SELECT COUNT(DISTINCT owner_id) FROM (SELECT o."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2 UNION ALL SELECT o."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2 UNION ALL SELECT o."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" o ON o.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2) activity`;

export const CUSTOMERS_3 = `SELECT COUNT(DISTINCT "orgId") FROM "OrganizationSubscription" WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'GRACE')`;

export const CUSTOMERS_4 = `SELECT COUNT(DISTINCT "orgId") FROM "OrganizationSubscription" WHERE "status" = 'TRIAL'`;

export const ACTIVE_ORGANIZATIONS_IN_RANGE_0 = `SELECT COUNT(DISTINCT org_id) FROM (SELECT "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2 UNION ALL SELECT "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2) activity WHERE org_id IS NOT NULL`;

export const LOAD_CUSTOMER_DAILY_0 = `WITH days AS (
          SELECT generate_series($1::timestamp, date_trunc('day', $2::timestamp), interval '1 day')::date AS date
        ), new_orgs AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS value FROM "Organization" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), new_users AS (
          SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, COUNT(*)::BIGINT AS value FROM "User" WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1
        ), active_orgs AS (
          SELECT date, COUNT(DISTINCT org_id)::BIGINT AS value FROM (
            SELECT ("occurredAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "UsageEvent" WHERE "occurredAt" >= $1 AND "occurredAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "Conversation" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "PublicApiRequest" WHERE "createdAt" >= $1 AND "createdAt" < $2
            UNION ALL SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS date, "orgId" AS org_id FROM "WhatsappSendEvent" WHERE "orgId" IS NOT NULL AND "createdAt" >= $1 AND "createdAt" < $2
          ) activity WHERE org_id IS NOT NULL GROUP BY date
        ), active_users AS (
          SELECT date, COUNT(DISTINCT owner_id)::BIGINT AS value FROM (
            SELECT (event."occurredAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "UsageEvent" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."occurredAt" >= $1 AND event."occurredAt" < $2
            UNION ALL SELECT (event."createdAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "Conversation" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."orgId" IS NOT NULL AND event."createdAt" >= $1 AND event."createdAt" < $2
            UNION ALL SELECT (event."createdAt" AT TIME ZONE 'UTC')::date AS date, organization."ownerId" AS owner_id FROM "PublicApiRequest" event JOIN "Organization" organization ON organization.id = event."orgId" WHERE event."createdAt" >= $1 AND event."createdAt" < $2
          ) activity GROUP BY date
        )
        SELECT days.date, COALESCE(new_orgs.value, 0)::BIGINT AS new_organizations, COALESCE(active_orgs.value, 0)::BIGINT AS active_organizations, COALESCE(new_users.value, 0)::BIGINT AS new_users, COALESCE(active_users.value, 0)::BIGINT AS active_users
        FROM days LEFT JOIN new_orgs ON new_orgs.date = days.date LEFT JOIN active_orgs ON active_orgs.date = days.date LEFT JOIN new_users ON new_users.date = days.date LEFT JOIN active_users ON active_users.date = days.date ORDER BY days.date`;

export const LOAD_CUSTOMER_PLAN_MIX_0 = `SELECT CONCAT(product.name, ' · ', plan.name) AS key, COUNT(DISTINCT subscription."orgId")::BIGINT AS value FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" JOIN "Product" product ON product.id = plan."productId" WHERE subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL') GROUP BY product.name, plan.name ORDER BY value DESC, key`;

export const LOAD_CUSTOMER_COHORTS_0 = `SELECT organization.id, organization.name, current_plan.plan,
          COALESCE(SUM(event.quantity), 0)::BIGINT AS operations,
          COUNT(DISTINCT (event."occurredAt" AT TIME ZONE 'UTC')::date)::BIGINT AS active_days
        FROM "Organization" organization
        LEFT JOIN "UsageEvent" event ON event."orgId" = organization.id AND event."occurredAt" >= $1 AND event."occurredAt" < $2
        LEFT JOIN LATERAL (
          SELECT CONCAT(product.name, ' · ', plan.name) AS plan
          FROM "OrganizationSubscription" subscription JOIN "ProductPlan" plan ON plan.id = subscription."planId" JOIN "Product" product ON product.id = plan."productId"
          WHERE subscription."orgId" = organization.id AND subscription."status" IN ('ACTIVE', 'PAST_DUE', 'GRACE', 'TRIAL') ORDER BY subscription."createdAt" DESC LIMIT 1
        ) current_plan ON TRUE
        GROUP BY organization.id, organization.name, current_plan.plan
        {}
        ORDER BY {}
        LIMIT 10`;
