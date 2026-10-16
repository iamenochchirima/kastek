import { parseSerdeValueJson } from "../json.js";
import { createId } from "@paralleldrive/cuid2";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import {
  canonicalJson,
  SerdeFloat,
  integer,
  wireInteger,
  timestamp,
} from "@kasitek-labs/server-support/json";
import { grantSystemCredits } from "./credits.js";
import type { Units } from "./credits.js";
import {
  qualifyReferral,
  reverseReferral,
  expireAttributions,
} from "./referrals.js";
import type { ReferralRewardConfig } from "./referrals.js";
type Row = Record<string, unknown>;
const SQL = {
  list_manual_grants: [
    '\n        SELECT id, "orgId" AS org_id, key, value,\n               "startsAt" AT TIME ZONE \'UTC\' AS starts_at,\n               "endsAt" AT TIME ZONE \'UTC\' AS ends_at,\n               reason, "createdById" AS created_by_id\n        FROM "OrganizationEntitlementGrant"\n        WHERE "orgId" = $1 AND source = \'MANUAL\'::"EntitlementSource"\n        ORDER BY "createdAt" DESC\n    ',
  ],
  create_manual_grant: [
    '\n        INSERT INTO "OrganizationEntitlementGrant" (id, "orgId", key, value, source, "startsAt", "endsAt", reason, "createdById", "createdAt", "updatedAt")\n        VALUES ($1, $2, $3, $4, \'MANUAL\'::"EntitlementSource", NOW(), $5, $6, $7, NOW(), NOW())\n        RETURNING id, "orgId" AS org_id, key, value,\n                  "startsAt" AT TIME ZONE \'UTC\' AS starts_at,\n                  "endsAt" AT TIME ZONE \'UTC\' AS ends_at,\n                  reason, "createdById" AS created_by_id\n    ',
  ],
  expire_manual_grant: [
    '\n        UPDATE "OrganizationEntitlementGrant" SET "endsAt" = NOW(), "updatedAt" = NOW()\n        WHERE id = $1 AND "orgId" = $2 AND source = \'MANUAL\'::"EntitlementSource"\n          AND ("endsAt" IS NULL OR "endsAt" > NOW())\n    ',
  ],
  record_paystack_event: [
    '\n        INSERT INTO "PaystackWebhookEvent" (\n            id, "eventKey", "eventType", payload, status, "receivedAt", "processedAt"\n        )\n        VALUES ($1, $2, $3, $4, \'PROCESSING\', NOW(), NOW())\n        ON CONFLICT ("eventKey") DO UPDATE SET\n            "eventType" = EXCLUDED."eventType",\n            payload = EXCLUDED.payload,\n            status = \'PROCESSING\',\n            "errorMessage" = NULL,\n            "processedAt" = NOW()\n        WHERE "PaystackWebhookEvent".status IN (\'FAILED\', \'RECEIVED\')\n           OR (\n                "PaystackWebhookEvent".status = \'PROCESSING\'\n                AND (\n                    "PaystackWebhookEvent"."processedAt" IS NULL\n                    OR "PaystackWebhookEvent"."processedAt" < NOW() - INTERVAL \'10 minutes\'\n                )\n           )\n        RETURNING id\n        ',
  ],
  finish_paystack_event: [
    '\n        UPDATE "PaystackWebhookEvent" SET status = $2, "errorMessage" = $3, "processedAt" = NOW()\n        WHERE "eventKey" = $1 AND status = \'PROCESSING\'\n    ',
  ],
  claim_paystack_webhook_retry: [
    '\n        UPDATE "PaystackWebhookEvent"\n        SET status = \'PROCESSING\', "errorMessage" = NULL, "processedAt" = NOW()\n        WHERE "eventKey" = $1\n          AND (\n            status IN (\'FAILED\', \'RECEIVED\')\n            OR (\n                status = \'PROCESSING\'\n                AND (\n                    "processedAt" IS NULL\n                    OR "processedAt" < NOW() - INTERVAL \'10 minutes\'\n                )\n            )\n          )\n        RETURNING payload\n        ',
  ],
  retry_failed_paystack_events: [
    '\n        SELECT "eventKey" AS event_key\n        FROM "PaystackWebhookEvent"\n        WHERE status = \'FAILED\'\n           OR status = \'RECEIVED\'\n           OR (\n                status = \'PROCESSING\'\n                AND (\n                    "processedAt" IS NULL\n                    OR "processedAt" < NOW() - INTERVAL \'10 minutes\'\n                )\n           )\n        ORDER BY "receivedAt" ASC\n        LIMIT $1\n        ',
  ],
  process_provider_event: [
    '\n                UPDATE "OrganizationSubscription" SET "providerSubscriptionId" = $1, status = \'ACTIVE\'::"OrganizationSubscriptionStatus", "updatedAt" = NOW()\n                WHERE id = (\n                  SELECT subscription.id FROM "OrganizationSubscription" subscription\n                  JOIN "ProductPlan" plan ON plan.id = subscription."planId"\n                  WHERE subscription.provider = $2 AND subscription."providerCustomerId" = $3\n                    AND plan."paystackPlanCode" = $4\n                  ORDER BY subscription."createdAt" DESC LIMIT 1\n                )\n            ',
  ],
  checkout_org: [
    '\n        SELECT "orgId" FROM "BillingCheckout" WHERE provider = $1 AND reference = $2\n    ',
  ],
  process_refund: [
    '\n        SELECT checkout.id, checkout."orgId", checkout."planId",\n               COALESCE((checkout."providerResponse"->>\'amountMinor\')::bigint, plan."amountMinor"::bigint),\n               checkout."providerResponse"->>\'subscriptionId\'\n        FROM "BillingCheckout" checkout\n        JOIN "ProductPlan" plan ON plan.id = checkout."planId"\n        WHERE checkout.provider = $1 AND checkout.reference = $2\n        FOR UPDATE\n    ',
    '\n        UPDATE "OrganizationSubscription"\n        SET status = \'CANCELLED\'::"OrganizationSubscriptionStatus", "cancelledAt" = NOW(),\n            "cancelAtPeriodEnd" = false, "updatedAt" = NOW()\n        WHERE "orgId" = $1 AND "planId" = $2 AND provider = $3\n          AND "providerSubscriptionId" = $4\n    ',
    '\n        UPDATE "BillingCheckout" SET status = \'REVERSED\', "updatedAt" = NOW() WHERE id = $1\n    ',
  ],
  update_subscription_status: [
    '\n        UPDATE "OrganizationSubscription"\n        SET status = CAST($3 AS "OrganizationSubscriptionStatus"), "cancelAtPeriodEnd" = $4,\n            "cancelledAt" = CASE WHEN $3 = \'CANCELLED\' THEN NOW() ELSE "cancelledAt" END,\n            "updatedAt" = NOW()\n        WHERE provider = $1 AND "providerSubscriptionId" = $2\n    ',
  ],
  mark_subscription_disabled: [
    '\n        SELECT "orgId"\n        FROM "OrganizationSubscription"\n        WHERE provider = $1 AND "providerSubscriptionId" = $2\n        ',
  ],
  activate_checkout: [
    '\n        SELECT id, "orgId", "planId", status FROM "BillingCheckout"\n        WHERE reference = $1 AND provider = $2 FOR UPDATE\n    ',
    '\n            SELECT id,\n                   "currentPeriodStart" AT TIME ZONE \'UTC\',\n                   "currentPeriodEnd" AT TIME ZONE \'UTC\'\n            FROM "OrganizationSubscription"\n            WHERE "orgId" = $1 AND "planId" = $2 AND provider = $3\n              AND status IN (\n                \'ACTIVE\'::"OrganizationSubscriptionStatus",\n                \'GRACE\'::"OrganizationSubscriptionStatus",\n                \'PAST_DUE\'::"OrganizationSubscriptionStatus"\n              )\n            ORDER BY "createdAt" DESC\n            LIMIT 1\n            ',
    '\n        UPDATE "OrganizationSubscription" subscription\n        SET status = \'CANCELLED\'::"OrganizationSubscriptionStatus", "cancelledAt" = NOW(), "updatedAt" = NOW()\n        WHERE subscription."orgId" = $1\n          AND subscription.status IN (\'TRIAL\'::"OrganizationSubscriptionStatus", \'ACTIVE\'::"OrganizationSubscriptionStatus", \'GRACE\'::"OrganizationSubscriptionStatus")\n          AND subscription."planId" IN (\n            SELECT sibling.id FROM "ProductPlan" sibling\n            WHERE sibling."productId" = (SELECT "productId" FROM "ProductPlan" WHERE id = $2)\n          )\n    ',
    '\n        INSERT INTO "OrganizationSubscription" (\n          id, "orgId", "planId", status, "startedAt", "currentPeriodStart", "currentPeriodEnd",\n          "cancelAtPeriodEnd", provider, "providerCustomerId", "providerSubscriptionId", "createdAt", "updatedAt"\n        )\n        SELECT $1, $2, $3, \'ACTIVE\'::"OrganizationSubscriptionStatus", NOW(), NOW(),\n               NOW() + CASE WHEN plan.interval = \'YEARLY\'::"BillingInterval"\n                            THEN INTERVAL \'1 year\' ELSE INTERVAL \'1 month\' END,\n               false, $4, $5, $6, NOW(), NOW()\n        FROM "ProductPlan" plan WHERE plan.id = $3\n        ON CONFLICT ("providerSubscriptionId") DO UPDATE SET\n          status = \'ACTIVE\'::"OrganizationSubscriptionStatus", "cancelledAt" = NULL, "updatedAt" = NOW()\n    ',
    '\n        SELECT id FROM "OrganizationSubscription"\n        WHERE "orgId" = $1 AND provider = $2 AND "providerSubscriptionId" = $3\n        ',
    '\n        UPDATE "BillingCheckout"\n        SET status = \'COMPLETED\', "completedAt" = NOW(),\n            "providerResponse" = COALESCE("providerResponse", \'{}\'::jsonb) ||\n              jsonb_strip_nulls(jsonb_build_object(\n                \'customerId\', $2::text,\n                \'subscriptionId\', $3::text\n              )),\n            "updatedAt" = NOW()\n        WHERE id = $1\n    ',
    '\n        INSERT INTO "BillingInvoice" (\n          id, "invoiceNumber", "orgId", "checkoutId", "subscriptionId", provider,\n          "providerTransactionId", status, currency, "amountMinor", "issuedAt", "paidAt",\n          "createdAt", "updatedAt"\n        )\n        SELECT $1, \'KS-\' || checkout.reference, checkout."orgId", checkout.id, $2, checkout.provider,\n               checkout.reference, \'PAID\', plan.currency,\n               COALESCE((checkout."providerResponse"->>\'amountMinor\')::integer, plan."amountMinor"),\n               NOW(), NOW(), NOW(), NOW()\n        FROM "BillingCheckout" checkout\n        JOIN "ProductPlan" plan ON plan.id = checkout."planId"\n        WHERE checkout.id = $3\n        ON CONFLICT ("checkoutId") DO UPDATE SET\n          "subscriptionId" = EXCLUDED."subscriptionId",\n          "providerTransactionId" = EXCLUDED."providerTransactionId",\n          "updatedAt" = NOW()\n        ',
    '\n        SELECT "currentPeriodStart" AT TIME ZONE \'UTC\', "currentPeriodEnd" AT TIME ZONE \'UTC\'\n        FROM "OrganizationSubscription" WHERE id = $1\n        ',
  ],
  grant_paid_period_credits: [
    'SELECT "creditsPerPeriod" FROM "ProductPlan" WHERE id = $1',
  ],
  process_recurring_charge: [
    '\n            SELECT invoice."orgId", subscription."planId", invoice."subscriptionId",\n                   invoice."periodStart" AT TIME ZONE \'UTC\',\n                   invoice."periodEnd" AT TIME ZONE \'UTC\'\n            FROM "BillingInvoice" invoice\n            JOIN "OrganizationSubscription" subscription\n              ON subscription.id = invoice."subscriptionId"\n            WHERE invoice."invoiceNumber" = $1\n            ',
    '\n        SELECT subscription.id, subscription."orgId", subscription."planId",\n               subscription."currentPeriodStart" AT TIME ZONE \'UTC\',\n               subscription."currentPeriodEnd" AT TIME ZONE \'UTC\',\n               plan.interval::text, plan.currency, plan."amountMinor"\n        FROM "OrganizationSubscription" subscription\n        JOIN "ProductPlan" plan ON plan.id = subscription."planId"\n        WHERE subscription.provider = $1 AND subscription."providerSubscriptionId" = $2\n        FOR UPDATE\n        ',
    "\n        SELECT $1::timestamptz + CASE WHEN $2 = 'YEARLY' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END\n        ",
    '\n        UPDATE "OrganizationSubscription"\n        SET status = \'ACTIVE\'::"OrganizationSubscriptionStatus",\n            "currentPeriodStart" = $2, "currentPeriodEnd" = $3,\n            "cancelAtPeriodEnd" = false, "updatedAt" = NOW()\n        WHERE id = $1\n        ',
    '\n        INSERT INTO "BillingInvoice" (\n            id, "invoiceNumber", "orgId", "checkoutId", "subscriptionId", provider,\n            "providerInvoiceId", "providerTransactionId", status, currency, "amountMinor",\n            "periodStart", "periodEnd", "issuedAt", "paidAt", "createdAt", "updatedAt"\n        )\n        VALUES (\n            $1, $2, $3, NULL, $4, $5, $6, $7, \'PAID\', $8, $9,\n            $10, $11, NOW(), NOW(), NOW(), NOW()\n        )\n        ',
  ],
  list_available_plans: [
    '\n        SELECT plan.key, product.key AS product_key, plan.name, plan.interval::text AS interval,\n               plan.currency, plan."amountMinor" AS amount_minor,\n               plan."creditsPerPeriod" AS credits_per_period,\n               (plan."paystackPlanCode" IS NOT NULL) AS checkout_ready\n        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"\n        WHERE plan.active = true AND product.active = true\n        ORDER BY product.name, plan."amountMinor" ASC NULLS LAST, plan.name\n    ',
  ],
  get_available_plan_details: [
    '\n        SELECT plan.key, product.key AS product_key, plan.name, plan.interval::text AS interval,\n               plan.currency, plan."amountMinor" AS amount_minor,\n               plan."creditsPerPeriod" AS credits_per_period,\n               (plan."paystackPlanCode" IS NOT NULL) AS checkout_ready\n        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"\n        WHERE plan.key = $1 AND plan.active = true AND product.active = true\n        ',
    '\n        SELECT entitlement.key, entitlement.value\n        FROM "PlanEntitlement" entitlement\n        JOIN "ProductPlan" candidate ON candidate.id = entitlement."planId"\n        WHERE candidate.id = (\n            SELECT id FROM "ProductPlan" WHERE key = $1\n        )\n        ORDER BY entitlement.key\n        ',
  ],
  admin_catalog: [
    '\n        SELECT key, name, description, active FROM "Product" ORDER BY name\n    ',
    '\n        SELECT plan.key, product.key, plan.name, plan.interval::text, plan.currency,\n               plan."amountMinor", plan."creditsPerPeriod", plan.active, plan."paystackPlanCode"\n        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"\n        ORDER BY product.name, plan.name\n    ',
    '\n        SELECT plan.key, entitlement.key, entitlement.value\n        FROM "PlanEntitlement" entitlement\n        JOIN "ProductPlan" plan ON plan.id = entitlement."planId"\n        ORDER BY plan.key, entitlement.key\n    ',
  ],
  upsert_product: [
    '\n        INSERT INTO "Product" (id, key, name, description, active, "createdAt", "updatedAt")\n        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())\n        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,\n          active = EXCLUDED.active, "updatedAt" = NOW()\n        RETURNING key, name, description, active\n    ',
  ],
  upsert_plan: [
    '\n        INSERT INTO "ProductPlan" (id, "productId", key, name, interval, currency, "amountMinor", "creditsPerPeriod", active, "paystackPlanCode", "createdAt", "updatedAt")\n        SELECT $1, product.id, $3, $4, CAST($5 AS "BillingInterval"), $6, $7, $8, $9, $10, NOW(), NOW()\n        FROM "Product" product WHERE product.key = $2\n        ON CONFLICT (key) DO UPDATE SET "productId" = EXCLUDED."productId", name = EXCLUDED.name,\n          interval = EXCLUDED.interval, currency = EXCLUDED.currency, "amountMinor" = EXCLUDED."amountMinor",\n          "creditsPerPeriod" = EXCLUDED."creditsPerPeriod", active = EXCLUDED.active,\n          "paystackPlanCode" = EXCLUDED."paystackPlanCode", "updatedAt" = NOW()\n        RETURNING key, name, interval::text, currency, "amountMinor", "creditsPerPeriod", active, "paystackPlanCode"\n    ',
  ],
  upsert_plan_entitlement: [
    '\n        INSERT INTO "PlanEntitlement" (id, "planId", key, value, "createdAt", "updatedAt")\n        SELECT $1, plan.id, $3, $4, NOW(), NOW() FROM "ProductPlan" plan WHERE plan.key = $2\n        ON CONFLICT ("planId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()\n        RETURNING key, value\n    ',
  ],
  create_checkout: [
    '\n        SELECT plan.id, plan."paystackPlanCode", product.key, plan.name,\n               plan."amountMinor", plan.currency\n        FROM "ProductPlan" plan JOIN "Product" product ON product.id = plan."productId"\n        WHERE plan.key = $1 AND plan.active = true AND product.active = true\n    ',
    '\n            SELECT "authorizationUrl", reference FROM "BillingCheckout"\n            WHERE "orgId" = $1 AND provider = $2 AND "idempotencyKey" = $3\n              AND status = \'PENDING\' AND "planId" = $4 AND "authorizationUrl" IS NOT NULL\n        ',
    '\n        INSERT INTO "BillingCheckout" (id, reference, "idempotencyKey", "orgId", "planId", "userId", email, provider, status, "createdAt", "updatedAt")\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \'PENDING\', NOW(), NOW())\n        ON CONFLICT ("orgId", provider, "idempotencyKey") DO NOTHING\n    ',
    '\n            SELECT reference, "planId", "authorizationUrl", status FROM "BillingCheckout"\n            WHERE "orgId" = $1 AND provider = $2 AND "idempotencyKey" = $3\n        ',
    'UPDATE "BillingCheckout" SET status = \'FAILED\', "updatedAt" = NOW() WHERE reference = $1',
    '\n        UPDATE "BillingCheckout"\n        SET "authorizationUrl" = $2,\n            "providerResponse" = jsonb_build_object(\'reference\', $3::text),\n            "updatedAt" = NOW()\n        WHERE reference = $1\n    ',
  ],
  verify_checkout: [
    '\n        SELECT status FROM "BillingCheckout"\n        WHERE reference = $1 AND "orgId" = $2 AND provider = $3\n    ',
  ],
  record_verification_response: [
    '\n        UPDATE "BillingCheckout"\n        SET "providerResponse" = $3,\n            "providerTransactionId" = COALESCE($4, "providerTransactionId"),\n            "providerAuthorizationId" = COALESCE($5, "providerAuthorizationId"),\n            "updatedAt" = NOW()\n        WHERE reference = $1 AND provider = $2\n    ',
  ],
  list_reconciliation_issues: [
    '\n        SELECT id, fingerprint, "orgId" AS org_id, provider,\n               "resourceType" AS resource_type, "resourceId" AS resource_id,\n               "issueType" AS issue_type, status, details,\n               "detectedAt" AT TIME ZONE \'UTC\' AS detected_at,\n               "resolvedAt" AT TIME ZONE \'UTC\' AS resolved_at\n        FROM "BillingReconciliationIssue"\n        WHERE $1::text IS NULL OR status = $1\n        ORDER BY "detectedAt" DESC LIMIT 200\n    ',
  ],
  upsert_reconciliation_issue: [
    '\n        INSERT INTO "BillingReconciliationIssue" (\n          id, fingerprint, "orgId", provider, "resourceType", "resourceId", "issueType",\n          status, details, "detectedAt", "createdAt", "updatedAt"\n        ) VALUES ($1, $2, $3, $4, $5, $6, $7, \'OPEN\', $8, NOW(), NOW(), NOW())\n        ON CONFLICT (fingerprint) DO UPDATE SET\n          status = \'OPEN\', details = EXCLUDED.details, "detectedAt" = NOW(),\n          "resolvedAt" = NULL, "updatedAt" = NOW()\n    ',
  ],
  resolve_reconciliation_issue: [
    '\n        UPDATE "BillingReconciliationIssue"\n        SET status = \'RESOLVED\', "resolvedAt" = NOW(), "updatedAt" = NOW()\n        WHERE fingerprint = $1 AND status = \'OPEN\'\n    ',
  ],
  reconcile_billing: [
    '\n        SELECT reference FROM "BillingCheckout"\n        WHERE provider = $1 AND status = \'PENDING\'\n          AND "createdAt" < NOW() - INTERVAL \'30 seconds\'\n        ORDER BY "createdAt" ASC LIMIT $2\n    ',
    '\n        SELECT id, "orgId", "providerSubscriptionId", "cancelAtPeriodEnd"\n        FROM "OrganizationSubscription"\n        WHERE provider = $1 AND "providerSubscriptionId" IS NOT NULL\n          AND status IN (\n            \'ACTIVE\'::"OrganizationSubscriptionStatus",\n            \'PAST_DUE\'::"OrganizationSubscriptionStatus",\n            \'GRACE\'::"OrganizationSubscriptionStatus"\n          )\n        ORDER BY "updatedAt" ASC LIMIT $2\n    ',
    '\n                        UPDATE "BillingInvoice"\n                        SET "providerInvoiceId" = $1, "updatedAt" = NOW()\n                        WHERE "subscriptionId" = $2 AND provider = $3\n                          AND "providerInvoiceId" IS NULL\n                        ',
    '\n                    SELECT status::text FROM "OrganizationSubscription" WHERE id = $1\n                ',
    '\n                        UPDATE "OrganizationSubscription"\n                        SET status = CAST($2 AS "OrganizationSubscriptionStatus"),\n                            "cancelAtPeriodEnd" = $3,\n                            "currentPeriodStart" = COALESCE($4, "currentPeriodStart"),\n                            "currentPeriodEnd" = COALESCE($5, "currentPeriodEnd"),\n                            "cancelledAt" = CASE WHEN $2 = \'CANCELLED\' THEN NOW() ELSE "cancelledAt" END,\n                            "updatedAt" = NOW()\n                        WHERE id = $1\n                    ',
    "\n        SELECT COUNT(*)::bigint FROM \"BillingReconciliationIssue\"\n        WHERE provider = $1 AND status = 'OPEN'\n    ",
  ],
  get_billing_summary: [
    '\n        SELECT key, name, description\n        FROM "Product"\n        WHERE active = true\n        ORDER BY name ASC\n        ',
    '\n        SELECT key, value\n        FROM "OrganizationEntitlementGrant"\n        WHERE "orgId" = $1\n          AND "startsAt" <= NOW()\n          AND ("endsAt" IS NULL OR "endsAt" > NOW())\n        UNION ALL\n        SELECT entitlement.key, entitlement.value\n        FROM "OrganizationSubscription" subscription\n        JOIN "ProductPlan" plan ON plan.id = subscription."planId"\n        JOIN "PlanEntitlement" entitlement ON entitlement."planId" = plan.id\n        WHERE subscription."orgId" = $1\n          AND subscription.status IN (\'TRIAL\'::"OrganizationSubscriptionStatus", \'ACTIVE\'::"OrganizationSubscriptionStatus", \'GRACE\'::"OrganizationSubscriptionStatus")\n        ',
    '\n        SELECT subscription.id, product.key AS "productKey", plan.name AS "planName", subscription.status::text AS status,\n               subscription."currentPeriodStart" AT TIME ZONE \'UTC\' AS "currentPeriodStart",\n               subscription."currentPeriodEnd" AT TIME ZONE \'UTC\' AS "currentPeriodEnd",\n               subscription."trialEndsAt" AT TIME ZONE \'UTC\' AS "trialEndsAt",\n               subscription."cancelAtPeriodEnd" AS "cancelAtPeriodEnd"\n        FROM "OrganizationSubscription" subscription\n        JOIN "ProductPlan" plan ON plan.id = subscription."planId"\n        JOIN "Product" product ON product.id = plan."productId"\n        WHERE subscription."orgId" = $1\n        ORDER BY subscription."createdAt" DESC\n        ',
    '\n        SELECT "productKey", "metricKey", COALESCE(SUM(quantity), 0)::bigint AS quantity\n        FROM "UsageEvent"\n        WHERE "orgId" = $1\n          AND "occurredAt" >= date_trunc(\'month\', NOW())\n        GROUP BY "productKey", "metricKey"\n        ',
    '\n        SELECT checkout.reference, product.name AS product_name, plan.name AS plan_name,\n               checkout.status, plan.currency, plan."amountMinor" AS amount_minor,\n               checkout."completedAt" AT TIME ZONE \'UTC\' AS completed_at,\n               checkout."createdAt" AT TIME ZONE \'UTC\' AS created_at\n        FROM "BillingCheckout" checkout\n        JOIN "ProductPlan" plan ON plan.id = checkout."planId"\n        JOIN "Product" product ON product.id = plan."productId"\n        WHERE checkout."orgId" = $1\n        ORDER BY checkout."createdAt" DESC LIMIT 25\n    ',
    '\n        SELECT invoice."invoiceNumber" AS invoice_number, product.name AS product_name,\n               plan.name AS plan_name, invoice.status, invoice.currency,\n               invoice."amountMinor" AS amount_minor,\n               invoice."issuedAt" AT TIME ZONE \'UTC\' AS issued_at,\n               invoice."paidAt" AT TIME ZONE \'UTC\' AS paid_at\n        FROM "BillingInvoice" invoice\n        JOIN "BillingCheckout" checkout ON checkout.id = invoice."checkoutId"\n        JOIN "ProductPlan" plan ON plan.id = checkout."planId"\n        JOIN "Product" product ON product.id = plan."productId"\n        WHERE invoice."orgId" = $1\n        ORDER BY invoice."issuedAt" DESC LIMIT 25\n        ',
  ],
  get_billing_usage: [
    "\n        SELECT CASE\n                 WHEN EXISTS (\n                     SELECT 1 FROM pg_timezone_names\n                     WHERE name = COALESCE(NULLIF(\"reportingTimezone\", ''), 'UTC')\n                 ) THEN COALESCE(NULLIF(\"reportingTimezone\", ''), 'UTC')\n                 ELSE 'UTC'\n               END\n        FROM \"Organization\"\n        WHERE id = $1\n        ",
    "SELECT (NOW() AT TIME ZONE $1)::date",
    "\n        SELECT (((NOW() AT TIME ZONE $1)::date - $2::integer)::timestamp AT TIME ZONE $1)\n        ",
    '\n        SELECT (("createdAt" AT TIME ZONE \'UTC\') AT TIME ZONE $4)::date AS date,\n               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used\n        FROM "CreditUsageEvent"\n        WHERE "orgId" = $1\n          AND status = \'COMPLETED\'\n          AND "createdAt" >= $2\n          AND "createdAt" <= $3\n        GROUP BY 1\n        ORDER BY 1 ASC\n        ',
    '\n        SELECT (("occurredAt" AT TIME ZONE \'UTC\') AT TIME ZONE $3)::date AS date,\n               COALESCE(SUM(quantity), 0)::bigint AS operations\n        FROM "UsageEvent"\n        WHERE "orgId" = $1\n          AND "occurredAt" >= $2\n          AND "occurredAt" <= $4\n        GROUP BY 1\n        ORDER BY 1 ASC\n        ',
    '\n        SELECT (("createdAt" AT TIME ZONE \'UTC\') AT TIME ZONE $4)::date AS date,\n               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used\n        FROM "CreditUsageEvent"\n        WHERE "orgId" = $1\n          AND status = \'COMPLETED\'\n          AND "createdAt" >= $2\n          AND "createdAt" < $3\n        GROUP BY 1\n        ORDER BY 1 ASC\n        ',
    '\n        SELECT (("occurredAt" AT TIME ZONE \'UTC\') AT TIME ZONE $3)::date AS date,\n               COALESCE(SUM(quantity), 0)::bigint AS operations\n        FROM "UsageEvent"\n        WHERE "orgId" = $1\n          AND "occurredAt" >= $2\n          AND "occurredAt" < $4\n        GROUP BY 1\n        ORDER BY 1 ASC\n        ',
    '\n        SELECT "actionKey" AS action_key,\n               COALESCE(SUM("creditsCharged"), 0)::bigint AS credits_used,\n               COUNT(*)::bigint AS operations\n        FROM "CreditUsageEvent"\n        WHERE "orgId" = $1\n          AND status = \'COMPLETED\'\n          AND "createdAt" >= $2\n          AND "createdAt" <= $3\n        GROUP BY "actionKey"\n        ORDER BY credits_used DESC, action_key ASC\n        ',
  ],
  set_subscription_enabled: [
    '\n        SELECT "providerSubscriptionId" FROM "OrganizationSubscription"\n        WHERE id = $1 AND "orgId" = $2 AND provider = $3\n    ',
    '\n        UPDATE "OrganizationSubscription" SET "cancelAtPeriodEnd" = $2,\n          status = CASE WHEN $3 THEN \'ACTIVE\'::"OrganizationSubscriptionStatus" ELSE status END,\n          "cancelledAt" = CASE WHEN $3 THEN NULL ELSE "cancelledAt" END, "updatedAt" = NOW()\n        WHERE id = $1 AND "orgId" = $4\n    ',
  ],
  capability_is_enabled: [
    '\n        WITH candidate AS (\n          SELECT key, value\n          FROM "OrganizationEntitlementGrant"\n          WHERE "orgId" = $1\n            AND key = ANY(ARRAY[$2, $3])\n            AND "startsAt" <= NOW()\n            AND ("endsAt" IS NULL OR "endsAt" > NOW())\n            AND jsonb_typeof(value) = \'boolean\'\n          UNION ALL\n          SELECT entitlement.key, entitlement.value\n          FROM "OrganizationSubscription" subscription\n          JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"\n          WHERE subscription."orgId" = $1\n            AND entitlement.key = ANY(ARRAY[$2, $3])\n            AND subscription.status IN (\n              \'TRIAL\'::"OrganizationSubscriptionStatus",\n              \'ACTIVE\'::"OrganizationSubscriptionStatus",\n              \'GRACE\'::"OrganizationSubscriptionStatus"\n            )\n            AND jsonb_typeof(entitlement.value) = \'boolean\'\n        ),\n        current_value AS (\n          SELECT bool_or((value #>> \'{}\')::boolean) AS enabled\n          FROM candidate WHERE key = $2\n        ),\n        legacy_value AS (\n          SELECT bool_or((value #>> \'{}\')::boolean) AS enabled\n          FROM candidate WHERE key = $3\n        )\n        SELECT COALESCE(\n          (SELECT enabled FROM current_value),\n          (SELECT enabled FROM legacy_value),\n          false\n        )\n        ',
  ],
  meter_limit: [
    '\n        WITH candidate AS (\n          SELECT key, value FROM "OrganizationEntitlementGrant"\n          WHERE "orgId" = $1 AND key = ANY(ARRAY[$2, $3]) AND "startsAt" <= NOW()\n            AND ("endsAt" IS NULL OR "endsAt" > NOW()) AND jsonb_typeof(value) = \'number\'\n          UNION ALL\n          SELECT entitlement.key, entitlement.value\n          FROM "OrganizationSubscription" subscription\n          JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"\n          WHERE subscription."orgId" = $1 AND entitlement.key = ANY(ARRAY[$2, $3])\n            AND subscription.status IN (\'TRIAL\'::"OrganizationSubscriptionStatus", \'ACTIVE\'::"OrganizationSubscriptionStatus", \'GRACE\'::"OrganizationSubscriptionStatus")\n            AND jsonb_typeof(entitlement.value) = \'number\'\n        ),\n        current_value AS (\n          SELECT MAX((value #>> \'{}\')::bigint) AS value FROM candidate WHERE key = $2\n        ),\n        legacy_value AS (\n          SELECT MAX((value #>> \'{}\')::bigint) AS value FROM candidate WHERE key = $3\n        )\n        SELECT COALESCE(\n          (SELECT value FROM current_value),\n          (SELECT value FROM legacy_value)\n        )\n    ',
  ],
  require_meter_available: [
    '\n        SELECT COALESCE(SUM(quantity), 0)::bigint FROM "UsageEvent"\n        WHERE "orgId" = $1\n          AND (\n            ("productKey" = \'workspace\' AND "metricKey" = $2)\n            OR ("productKey" = $3 AND "metricKey" = $4)\n          )\n          AND "occurredAt" >= date_trunc(\'month\', NOW())\n    ',
  ],
  record_meter_usage: [
    '\n        INSERT INTO "UsageEvent" (id, "orgId", "productKey", "metricKey", quantity, "sourceType", "sourceId", "idempotencyKey", "occurredAt", "createdAt")\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())\n        ON CONFLICT ("idempotencyKey") DO NOTHING\n    ',
  ],
} as const;
export const CAPABILITIES = [
  {
    key: "feature.agents.manage",
    name: "AI agents",
    description: "Create, configure, and deploy workspace agents.",
    legacy: "product.agents.enabled",
  },
  {
    key: "feature.campaigns.manage",
    name: "Campaigns",
    description: "Create and manage customer messaging campaigns.",
    legacy: "product.reach.enabled",
  },
  {
    key: "feature.campaigns.send",
    name: "Campaign sending",
    description: "Launch campaigns and send messages to campaign recipients.",
    legacy: "product.reach.enabled",
  },
  {
    key: "feature.bookings.access",
    name: "Bookings",
    description: "Manage workspace booking services and appointments.",
    legacy: "product.bookings.enabled",
  },
  {
    key: "feature.templates.manage",
    name: "Message templates",
    description: "Create and manage reusable provider message templates.",
    legacy: "product.reach.enabled",
  },
  {
    key: "feature.contacts.access",
    name: "Contacts",
    description: "Access and manage workspace customer records.",
    legacy: "product.crm.enabled",
  },
  {
    key: "feature.content.manage",
    name: "Content workspace",
    description: "Plan, create, schedule, and manage multi-platform content.",
    legacy: "product.social.enabled",
  },
  {
    key: "feature.content.publish",
    name: "Content publishing",
    description: "Publish approved content to connected social accounts.",
    legacy: "product.social.enabled",
  },
  {
    key: "feature.analytics.view",
    name: "Analytics",
    description: "View workspace, campaign, and connected-channel analytics.",
    legacy: "product.social.enabled",
  },
  {
    key: "feature.inbox.access",
    name: "Shared inbox",
    description: "Access connected customer conversations in one inbox.",
    legacy: "product.inbox.enabled",
  },
] as const;
export const METERS = [
  {
    key: "agent_deployments",
    name: "Agent deployments",
    description: "Agent deployment operations during the current month.",
  },
  {
    key: "campaign_recipients",
    name: "Campaign recipients",
    description: "Recipients processed by campaigns during the current month.",
  },
  {
    key: "social_publishes",
    name: "Published content",
    description: "Social publishing operations during the current month.",
  },
  {
    key: "public_api_requests",
    name: "Public API requests",
    description: "Authenticated public API requests during the current month.",
  },
] as const;
const bad = (message: string): never => {
  throw new ApiError(400, "bad_request", message);
};
const missing = (message: string): never => {
  throw new ApiError(404, "not_found", message);
};
const fail = (message: string): never => {
  throw new ApiError(500, "internal_error", message);
};
const object = (value: unknown): Row =>
  value &&
  typeof value === "object" &&
  !(value instanceof SerdeFloat) &&
  !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const external = (value: unknown): string | null =>
  value instanceof SerdeFloat
    ? canonicalJson(value)
    : typeof value === "string" && value.trim()
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : null;
const i64 = (value: unknown, allowString = false): bigint | null => {
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    !(allowString && typeof value === "string")
  )
    return null;
  try {
    const n = integer(value as Units);
    return n >= -9223372036854775808n && n <= 9223372036854775807n ? n : null;
  } catch {
    return null;
  }
};
const date = (value: unknown): Date | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value)
    : null;
const subscriptionCode = (value: Row): string | null =>
  text(value.subscription_code) ??
  text(object(value.subscription).subscription_code);
async function rows(
  db: Pool | PoolClient,
  sql: string,
  args: unknown[] = [],
): Promise<Row[]> {
  return (await db.query(sql, args)).rows;
}
async function first(
  db: Pool | PoolClient,
  sql: string,
  args: unknown[] = [],
): Promise<Row | undefined> {
  return (await rows(db, sql, args))[0];
}
async function tuples(
  db: Pool | PoolClient,
  sql: string,
  args: unknown[] = [],
): Promise<unknown[][]> {
  return (await db.query({ text: sql, values: args, rowMode: "array" })).rows;
}
async function tuple(
  db: Pool | PoolClient,
  sql: string,
  args: unknown[] = [],
): Promise<unknown[] | undefined> {
  return (await tuples(db, sql, args))[0];
}
const camel = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      ["credits_per_period", "quantity", "credits_used", "operations"].includes(
        k,
      ) && v != null
        ? wireInteger(v as Units)
        : v,
    ]),
  );
export interface VerifiedTransaction {
  successful: boolean;
  reference: string;
  amount_minor: bigint | null;
  currency: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  provider_transaction_id: string | null;
  provider_authorization_id: string | null;
}
export interface VerifiedSubscription {
  subscription_id: string;
  state: string;
  current_period_start: Date | null;
  current_period_end: Date | null;
  provider_invoice_id: string | null;
}
export type ProviderEvent =
  | {
      kind: "charge_succeeded";
      reference: string;
      customer_id: string | null;
      subscription_id: string | null;
      transaction_id: string | null;
      invoice_id: string | null;
      amount_minor: bigint | null;
      currency: string | null;
    }
  | {
      kind: "subscription_created";
      subscription_id: string;
      customer_id: string;
      plan_code: string;
    }
  | {
      kind:
        | "subscription_not_renewing"
        | "subscription_disabled"
        | "invoice_payment_failed";
      subscription_id: string;
    }
  | {
      kind: "refund_processed";
      transaction_reference: string;
      amount_minor: bigint | null;
    }
  | { kind: "dispute_opened"; transaction_reference: string }
  | { kind: "ignored" };
export interface BillingProvider {
  readonly name: string;
  initializeCheckout(request: {
    email: string;
    plan_code: string;
    amount_minor: Units;
    currency: string;
    reference: string;
    callback_url: string;
    metadata: unknown;
  }): Promise<{ authorization_url: string; reference: string }>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  verifySubscription(subscriptionId: string): Promise<VerifiedSubscription>;
  setSubscriptionEnabled(
    subscriptionId: string,
    enabled: boolean,
  ): Promise<void>;
  verifyWebhook(payload: Buffer, signature: string): boolean;
  parseWebhook(value: unknown): ProviderEvent;
}
export function parseVerifiedTransaction(value: unknown): VerifiedTransaction {
  const data = object(value),
    reference = text(data.reference);
  if (!reference?.trim()) bad("Paystack reference is missing");
  return {
    successful: data.status === "success",
    reference: reference!,
    amount_minor: i64(data.amount),
    currency: text(data.currency),
    customer_id: text(object(data.customer).customer_code),
    subscription_id: subscriptionCode(data),
    provider_transaction_id: external(data.id),
    provider_authorization_id: external(
      object(data.authorization).authorization_code,
    ),
  };
}
export function parseVerifiedSubscription(
  value: unknown,
): VerifiedSubscription {
  const data = object(value),
    id = subscriptionCode(data);
  if (id == null) bad("Paystack subscription code is missing");
  const invoice = object(data.most_recent_invoice);
  return {
    subscription_id: id!,
    state: text(data.status) ?? "unknown",
    current_period_start: date(invoice.period_start),
    current_period_end:
      date(invoice.period_end) ?? date(data.next_payment_date),
    provider_invoice_id: external(invoice.invoice_code) ?? external(invoice.id),
  };
}
export class PaystackProvider implements BillingProvider {
  readonly name = "paystack";
  private readonly baseUrl: string;
  constructor(
    private readonly secret: string,
    baseUrl = "https://api.paystack.co",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  private async request(
    path: string,
    body?: unknown,
    allowEmpty = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : canonicalJson(body),
      });
    } catch {
      throw new ApiError(500, "internal_error", "External request failed");
    }
    let result: Row;
    try {
      result = object(parseSerdeValueJson(await response.text()));
    } catch {
      throw new ApiError(500, "internal_error", "Invalid Paystack response");
    }
    if (
      !response.ok ||
      result.status !== true ||
      (!allowEmpty && result.data == null)
    )
      bad(text(result.message) ?? "Paystack request failed");
    return result.data;
  }
  async initializeCheckout(
    request: Parameters<BillingProvider["initializeCheckout"]>[0],
  ): Promise<{ authorization_url: string; reference: string }> {
    const data = object(
      await this.request("/transaction/initialize", {
        email: request.email,
        amount: wireInteger(request.amount_minor),
        currency: request.currency,
        plan: request.plan_code,
        reference: request.reference,
        callback_url: request.callback_url,
        metadata: request.metadata,
      }),
    );
    if (
      typeof data.authorization_url !== "string" ||
      typeof data.reference !== "string"
    )
      fail("Invalid Paystack checkout response");
    return {
      authorization_url: data.authorization_url as string,
      reference: data.reference as string,
    };
  }
  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    return parseVerifiedTransaction(
      await this.request(
        `/transaction/verify/${encodeURIComponent(reference)}`,
      ),
    );
  }
  async verifySubscription(id: string): Promise<VerifiedSubscription> {
    return parseVerifiedSubscription(
      await this.request(`/subscription/${encodeURIComponent(id)}`),
    );
  }
  async setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
    const data = object(
        await this.request(`/subscription/${encodeURIComponent(id)}`),
      ),
      token = text(data.email_token);
    if (!token) bad("Paystack subscription management token is missing");
    await this.request(
      `/subscription/${enabled ? "enable" : "disable"}`,
      { code: id, token },
      true,
    );
  }
  verifyWebhook(payload: Buffer, signature: string): boolean {
    const hex = signature.trim();
    if (!/^[a-f0-9]{128}$/i.test(hex)) return false;
    const expected = createHmac("sha512", this.secret).update(payload).digest();
    return timingSafeEqual(expected, Buffer.from(hex, "hex"));
  }
  parseWebhook(value: unknown): ProviderEvent {
    const event = object(value),
      kind = text(event.event);
    if (kind == null) bad("Paystack event type is missing");
    if (!("data" in event)) bad("Paystack webhook data is missing");
    const data = object(event.data),
      subscription = subscriptionCode(data),
      transaction =
        text(data.transaction_reference) ??
        text(object(data.transaction).reference);
    const requiredSubscription = (): string =>
      subscription ?? bad("Paystack subscription code is missing");
    switch (kind) {
      case "charge.success":
        if (data.status !== "success") return { kind: "ignored" };
        return {
          kind: "charge_succeeded",
          reference:
            text(data.reference) ?? bad("Paystack reference is missing"),
          customer_id: text(object(data.customer).customer_code),
          subscription_id: subscription,
          transaction_id: external(data.id),
          invoice_id:
            external(data.invoice_code) ??
            external(object(data.invoice).invoice_code),
          amount_minor: i64(data.amount),
          currency: text(data.currency),
        };
      case "subscription.create":
        return {
          kind: "subscription_created",
          subscription_id: requiredSubscription(),
          customer_id:
            text(object(data.customer).customer_code) ??
            bad("Paystack customer code is missing"),
          plan_code:
            text(object(data.plan).plan_code) ??
            bad("Paystack plan code is missing"),
        };
      case "subscription.not_renew":
        return {
          kind: "subscription_not_renewing",
          subscription_id: requiredSubscription(),
        };
      case "subscription.disable":
        return {
          kind: "subscription_disabled",
          subscription_id: requiredSubscription(),
        };
      case "invoice.payment_failed":
        return {
          kind: "invoice_payment_failed",
          subscription_id: requiredSubscription(),
        };
      case "refund.processed":
        return {
          kind: "refund_processed",
          transaction_reference:
            transaction ??
            bad("Paystack refund transaction reference is missing"),
          amount_minor: i64(data.amount, true),
        };
      case "charge.dispute.create":
        return {
          kind: "dispute_opened",
          transaction_reference:
            transaction ??
            bad("Paystack dispute transaction reference is missing"),
        };
      default:
        return { kind: "ignored" };
    }
  }
}
export function paystackEventKey(value: unknown): string {
  const event = object(value),
    kind = text(event.event);
  if (kind == null) bad("Paystack event type is missing");
  const data = object(event.data);
  const identity =
    "id" in data
      ? canonicalJson(data.id)
      : (text(data.reference) ??
        text(data.subscription_code) ??
        createHash("sha512").update(canonicalJson(value)).digest("hex"));
  return `${kind}:${identity}`;
}
export async function recordPaystackEvent(
  pool: Pool,
  key: string,
  value: unknown,
): Promise<boolean> {
  return (
    (await first(pool, SQL.record_paystack_event[0], [
      createId(),
      key,
      text(object(value).event) ?? "unknown",
      canonicalJson(value),
    ])) != null
  );
}
export async function finishPaystackEvent(
  pool: Pool,
  key: string,
  status: string,
  error: string | null,
): Promise<void> {
  await pool.query(SQL.finish_paystack_event[0], [key, status, error]);
}
export const billingEnforcementEnabled = (): boolean =>
  ["1", "true", "yes", "on"].includes(
    (process.env.KASITEK_BILLING_ENFORCEMENT ?? "").trim().toLowerCase(),
  );
export function mergeEntitlementValue(
  existing: unknown,
  next: unknown,
): unknown {
  if (typeof existing === "boolean" && typeof next === "boolean")
    return existing || next;
  const a = i64(existing),
    b = i64(next);
  return a != null && b != null ? wireInteger(a > b ? a : b) : next;
}
export const subscriptionGrantsAccess = (status: string): boolean =>
  ["TRIAL", "ACTIVE", "GRACE"].includes(status);
export function internalSubscriptionState(
  state: string,
): [string, boolean] | undefined {
  switch (state) {
    case "active":
      return ["ACTIVE", false];
    case "non-renewing":
      return ["ACTIVE", true];
    case "attention":
      return ["PAST_DUE", false];
    case "completed":
    case "cancelled":
      return ["CANCELLED", false];
    default:
      return undefined;
  }
}
const legacyMeter = (key: string): [string, string] | undefined =>
  key === "agent_deployments"
    ? ["agents", "deployments"]
    : key === "campaign_recipients"
      ? ["reach", "campaign_recipients"]
      : key === "social_publishes"
        ? ["social", "publishes"]
        : undefined;
function canonicalMeter(product: string, key: string): string | undefined {
  return METERS.find((m) =>
    product === "workspace"
      ? m.key === key
      : legacyMeter(m.key)?.join(":") === `${product}:${key}`,
  )?.key;
}
function capability(key: string) {
  return CAPABILITIES.find((def) => def.key === key);
}
function allows(
  values: Map<string, unknown>,
  definition: (typeof CAPABILITIES)[number],
): boolean {
  const current = values.get(definition.key),
    legacy = values.get(definition.legacy);
  return typeof current === "boolean"
    ? current
    : typeof legacy === "boolean"
      ? legacy
      : false;
}
function catalogKey(raw: string): string {
  const key = raw.trim();
  if (!/^[a-z0-9._-]{1,80}$/.test(key))
    bad(
      "Keys must use lowercase letters, numbers, dots, hyphens, or underscores",
    );
  return key;
}
function entitlementKey(raw: string): string {
  const key = catalogKey(raw);
  if (!capability(key) && !METERS.some((m) => `limit.${m.key}` === key))
    bad(
      "Entitlements must use a registered feature key or workspace meter limit",
    );
  return key;
}
export async function listManualGrants(
  pool: Pool,
  orgId: string,
): Promise<Row[]> {
  return (await rows(pool, SQL.list_manual_grants[0], [orgId])).map(camel);
}
export async function createManualGrant(
  pool: Pool,
  orgId: string,
  key: string,
  value: unknown,
  endsAt: Date | null,
  reason: string,
  actorId: string,
): Promise<Row> {
  key = entitlementKey(key);
  reason = reason.trim();
  if (!key || !reason) bad("Grant key and reason are required");
  if (endsAt != null && endsAt.getTime() <= Date.now())
    bad("Grant expiry must be in the future");
  return camel(
    (await first(pool, SQL.create_manual_grant[0], [
      createId(),
      orgId,
      key,
      canonicalJson(value),
      endsAt,
      reason,
      actorId,
    ]))!,
  );
}
export async function expireManualGrant(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<boolean> {
  return (
    (await pool.query(SQL.expire_manual_grant[0], [id, orgId])).rowCount === 1
  );
}
export async function listAvailablePlans(pool: Pool): Promise<Row[]> {
  return (await rows(pool, SQL.list_available_plans[0])).map(camel);
}
export async function getAvailablePlanDetails(
  pool: Pool,
  key: string,
): Promise<Row> {
  const plan = await first(pool, SQL.get_available_plan_details[0], [key]);
  if (!plan) missing("Plan not found");
  const entitlements = (
    await rows(pool, SQL.get_available_plan_details[1], [key])
  ).flatMap((row) => {
    const key = String(row.key),
      meter = key.startsWith("limit.")
        ? METERS.find((m) => `limit.${m.key}` === key)
        : undefined,
      feature = capability(key);
    const def = meter ?? feature;
    return def
      ? [
          {
            key,
            name: def.name,
            description: def.description,
            kind: meter ? "limit" : "feature",
            value: row.value,
          },
        ]
      : [];
  });
  return { ...camel(plan!), entitlements };
}
export async function adminCatalog(pool: Pool): Promise<Row> {
  const products = await rows(pool, SQL.admin_catalog[0]),
    plans = (await tuples(pool, SQL.admin_catalog[1])).map(
      ([
        key,
        productKey,
        name,
        interval,
        currency,
        amountMinor,
        credits,
        active,
        paystackPlanCode,
      ]) => ({
        key,
        productKey,
        name,
        interval,
        currency,
        amountMinor,
        creditsPerPeriod:
          credits == null ? null : wireInteger(credits as Units),
        active,
        paystackPlanCode,
      }),
    ),
    entitlements = (await tuples(pool, SQL.admin_catalog[2])).map(
      ([planKey, key, value]) => ({ planKey, key, value }),
    );
  return {
    products,
    plans,
    entitlements,
    accessDefinitions: [
      ...CAPABILITIES.map((d) => ({
        key: d.key,
        name: d.name,
        kind: "capability",
      })),
      ...METERS.map((d) => ({
        key: `limit.${d.key}`,
        name: d.name,
        kind: "meter",
      })),
    ],
  };
}
export async function upsertProduct(
  pool: Pool,
  key: string,
  name: string,
  description: string | null,
  active: boolean,
): Promise<Row> {
  key = catalogKey(key);
  name = name.trim();
  if (!name) bad("Product name is required");
  return (await first(pool, SQL.upsert_product[0], [
    createId(),
    key,
    name,
    description,
    active,
  ]))!;
}
export async function upsertPlan(
  pool: Pool,
  productKey: string,
  key: string,
  name: string,
  interval: string,
  currency: string,
  amountMinor: number | null,
  creditsPerPeriod: Units | null,
  active: boolean,
  paystackPlanCode: string | null,
): Promise<Row> {
  key = catalogKey(key);
  productKey = catalogKey(productKey);
  interval = interval.trim().toUpperCase();
  if (!["MONTHLY", "YEARLY"].includes(interval))
    bad("Plan interval must be MONTHLY or YEARLY");
  currency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) bad("Currency must be a three-letter code");
  if (
    (amountMinor != null && amountMinor < 0) ||
    (creditsPerPeriod != null && integer(creditsPerPeriod) <= 0n) ||
    !name.trim()
  )
    bad("Plan name and a non-negative amount are required");
  const result = await first(pool, SQL.upsert_plan[0], [
    createId(),
    productKey,
    key,
    name.trim(),
    interval,
    currency,
    amountMinor,
    creditsPerPeriod,
    active,
    paystackPlanCode?.trim() || null,
  ]);
  if (!result) missing("Product not found");
  return {
    ...result,
    creditsPerPeriod:
      result!.creditsPerPeriod == null
        ? null
        : wireInteger(result!.creditsPerPeriod as Units),
  };
}
export async function upsertPlanEntitlement(
  pool: Pool,
  planKey: string,
  key: string,
  value: unknown,
): Promise<Row> {
  planKey = catalogKey(planKey);
  key = entitlementKey(key);
  if (!["boolean", "number", "string", "bigint"].includes(typeof value))
    bad("Entitlement values must be boolean, number, or string");
  const result = await first(pool, SQL.upsert_plan_entitlement[0], [
    createId(),
    planKey,
    key,
    canonicalJson(value),
  ]);
  if (!result) missing("Plan not found");
  return { planKey, ...result };
}
export async function requireCapability(
  pool: Pool,
  orgId: string,
  key: string,
): Promise<void> {
  const definition = capability(key);
  if (!definition) fail(`Unknown capability: ${key}`);
  if (!billingEnforcementEnabled()) return;
  const enabled = await tuple(pool, SQL.capability_is_enabled[0], [
    orgId,
    definition!.key,
    definition!.legacy,
  ]);
  if (enabled?.[0] !== true)
    throw new ApiError(
      403,
      "forbidden",
      `${definition!.name} is not included in this workspace's current plan`,
    );
}
export async function meterLimit(
  pool: Pool,
  orgId: string,
  key: string,
): Promise<bigint | null> {
  if (!billingEnforcementEnabled()) return null;
  const legacy = legacyMeter(key);
  const value = (
    await tuple(pool, SQL.meter_limit[0], [
      orgId,
      `limit.${key}`,
      legacy ? `limit.${legacy[0]}.${legacy[1]}` : "",
    ])
  )?.[0];
  return value == null ? null : integer(value as Units);
}
export async function requireMeterAvailable(
  pool: Pool,
  orgId: string,
  key: string,
  quantity: Units,
): Promise<void> {
  const limit = await meterLimit(pool, orgId, key);
  if (limit == null) return;
  const legacy = legacyMeter(key);
  const used = (await tuple(pool, SQL.require_meter_available[0], [
    orgId,
    key,
    legacy?.[0] ?? "",
    legacy?.[1] ?? "",
  ]))![0];
  if (integer(used as Units) + integer(quantity) > limit)
    throw new ApiError(
      403,
      "forbidden",
      `The ${key} monthly limit for this workspace has been reached`,
    );
}
export async function recordMeterUsage(
  pool: Pool,
  orgId: string,
  key: string,
  quantity: number,
  sourceType: string,
  sourceId: string,
  idempotencyKey: string,
): Promise<boolean> {
  return (
    (
      await pool.query(SQL.record_meter_usage[0], [
        createId(),
        orgId,
        "workspace",
        key,
        quantity,
        sourceType,
        sourceId,
        idempotencyKey,
      ])
    ).rowCount === 1
  );
}
export async function createCheckout(
  pool: Pool,
  provider: BillingProvider,
  frontendUrl: string,
  orgId: string,
  userId: string,
  email: string,
  planKey: string,
  key: string,
): Promise<Row> {
  key = key.trim();
  if (!key || Buffer.byteLength(key) > 128)
    bad("A valid checkout idempotency key is required");
  const plan = await tuple(pool, SQL.create_checkout[0], [planKey]);
  if (!plan) missing("Active plan not found");
  const [planId, planCode, productKey, planName, amount, currency] = plan!;
  if (typeof planCode !== "string" || !planCode.trim())
    bad("This plan is not connected to Paystack yet");
  if (amount == null)
    bad("This plan does not have a configured checkout amount");
  if (integer(amount as Units) <= 0n)
    bad("This plan must have a positive checkout amount");
  const existing = await tuple(pool, SQL.create_checkout[1], [
    orgId,
    provider.name,
    key,
    planId,
  ]);
  if (existing)
    return {
      authorizationUrl: existing[0],
      reference: existing[1],
      planName,
      reused: true,
    };
  const reference = `ks_${createId()}`;
  if (
    (
      await pool.query(SQL.create_checkout[2], [
        createId(),
        reference,
        key,
        orgId,
        planId,
        userId,
        email,
        provider.name,
      ])
    ).rowCount === 0
  ) {
    const current = (await tuple(pool, SQL.create_checkout[3], [
      orgId,
      provider.name,
      key,
    ]))!;
    if (current[1] !== planId)
      bad("The checkout idempotency key is already used for another plan");
    if (current[2] != null)
      return {
        authorizationUrl: current[2],
        reference: current[0],
        planName,
        reused: true,
      };
    bad(`Checkout ${current[0]} is already being initialised (${current[3]})`);
  }
  let result: Awaited<ReturnType<BillingProvider["initializeCheckout"]>>;
  try {
    result = await provider.initializeCheckout({
      email,
      plan_code: planCode as string,
      amount_minor: integer(amount as Units),
      currency: currency as string,
      reference,
      callback_url: `${frontendUrl.replace(/\/+$/, "")}/billing?payment=complete`,
      metadata: { orgId, planKey, productKey },
    });
  } catch (error) {
    await pool.query(SQL.create_checkout[4], [reference]);
    throw error;
  }
  await pool.query(SQL.create_checkout[5], [
    reference,
    result.authorization_url,
    result.reference,
  ]);
  return {
    authorizationUrl: result.authorization_url,
    reference: result.reference,
    planName,
  };
}
export async function recordVerificationResponse(
  pool: Pool,
  provider: string,
  reference: string,
  value: VerifiedTransaction,
): Promise<void> {
  await pool.query(SQL.record_verification_response[0], [
    reference,
    provider,
    canonicalJson({
      reference: value.reference,
      successful: value.successful,
      amountMinor:
        value.amount_minor == null ? null : wireInteger(value.amount_minor),
      currency: value.currency,
      customerId: value.customer_id,
      subscriptionId: value.subscription_id,
      transactionId: value.provider_transaction_id,
      authorizationId: value.provider_authorization_id,
    }),
    value.provider_transaction_id,
    value.provider_authorization_id,
  ]);
}
export async function verifyCheckout(
  pool: Pool,
  provider: BillingProvider,
  orgId: string,
  reference: string,
  config: ReferralRewardConfig,
): Promise<Row> {
  const status = (
    await tuple(pool, SQL.verify_checkout[0], [reference, orgId, provider.name])
  )?.[0];
  if (status == null) missing("Checkout not found");
  if (status === "COMPLETED")
    return {
      reference,
      status: "completed",
      activated: await activateCheckout(
        pool,
        provider.name,
        reference,
        null,
        null,
        config,
      ),
    };
  if (status !== "PENDING")
    return { reference, status: "failed", activated: false };
  const result = await provider.verifyTransaction(reference);
  await recordVerificationResponse(pool, provider.name, reference, result);
  if (result.reference !== reference)
    bad("Payment reference did not match the checkout");
  if (!result.successful)
    return { reference, status: "pending", activated: false };
  return {
    reference,
    status: "completed",
    activated: await activateCheckout(
      pool,
      provider.name,
      reference,
      result.customer_id,
      result.subscription_id,
      config,
    ),
  };
}
export async function grantPaidPeriodCredits(
  pool: Pool,
  orgId: string,
  subscriptionId: string,
  planId: string,
  start: Date,
  end: Date,
  reference: string,
  key: string,
): Promise<void> {
  const amount = (
    await tuple(pool, SQL.grant_paid_period_credits[0], [planId])
  )?.[0];
  if (amount == null) return;
  if (integer(amount as Units) <= 0n)
    fail("Configured plan credit allowance must be positive");
  await grantSystemCredits(
    pool,
    orgId,
    amount as Units,
    "PLAN",
    end,
    "Paid subscription period credits",
    reference,
    {
      subscriptionId,
      planId,
      periodStart: timestamp(start),
      periodEnd: timestamp(end),
    },
    key,
  );
}
export async function activateCheckout(
  pool: Pool,
  provider: string,
  reference: string,
  customer: string | null,
  providerSubscription: string | null,
  config: ReferralRewardConfig,
): Promise<boolean> {
  const activation = await transaction(pool, async (client) => {
    const checkout = await tuple(client, SQL.activate_checkout[0], [
      reference,
      provider,
    ]);
    if (!checkout) return null;
    const [id, orgId, planId, status] = checkout;
    if (status === "COMPLETED") {
      const current = await tuple(client, SQL.activate_checkout[1], [
        orgId,
        planId,
        provider,
      ]);
      if (!current) fail("Completed checkout subscription was not found");
      return {
        orgId: String(orgId),
        planId: String(planId),
        subscriptionId: String(current![0]),
        start: current![1] as Date,
        end: current![2] as Date,
      };
    }
    if (status !== "PENDING") return null;
    const sub = providerSubscription ?? `${provider}-charge:${reference}`;
    await client.query(SQL.activate_checkout[2], [orgId, planId]);
    await client.query(SQL.activate_checkout[3], [
      createId(),
      orgId,
      planId,
      provider,
      customer,
      sub,
    ]);
    const local = (await tuple(client, SQL.activate_checkout[4], [
      orgId,
      provider,
      sub,
    ]))![0];
    await client.query(SQL.activate_checkout[5], [id, customer, sub]);
    await client.query(SQL.activate_checkout[6], [createId(), local, id]);
    return {
      orgId: String(orgId),
      planId: String(planId),
      subscriptionId: String(local),
      start: null,
      end: null,
    };
  });
  if (!activation) return false;
  const period = activation.start
    ? [activation.start, activation.end]
    : (await tuple(pool, SQL.activate_checkout[7], [
        activation.subscriptionId,
      ]))!;
  await grantPaidPeriodCredits(
    pool,
    activation.orgId,
    activation.subscriptionId,
    activation.planId,
    period[0] as Date,
    period[1] as Date,
    reference,
    `paid-activation:${reference}`,
  );
  await qualifyReferral(pool, activation.orgId, reference, config);
  return true;
}
export async function processRecurringCharge(
  pool: Pool,
  provider: string,
  reference: string,
  providerSubscription: string | null,
  transactionId: string | null,
  invoiceId: string | null,
  amount: bigint | null,
  currency: string | null,
): Promise<boolean> {
  if (!providerSubscription) return false;
  const number = `KS-${provider}-${reference}`;
  const result = await transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`billing-invoice:${number}`],
    );
    const existing = await tuple(client, SQL.process_recurring_charge[0], [
      number,
    ]);
    if (existing) {
      if (existing[3] == null || existing[4] == null)
        fail("Recurring invoice period is missing");
      return existing;
    }
    const sub = await tuple(client, SQL.process_recurring_charge[1], [
      provider,
      providerSubscription,
    ]);
    if (!sub)
      throw new ApiError(
        409,
        "conflict",
        "Recurring payment arrived before its local subscription was linked",
      );
    const [id, orgId, planId, , end, interval, planCurrency, planAmount] = sub,
      start = (end as Date | null) ?? new Date(),
      finish = (await tuple(client, SQL.process_recurring_charge[2], [
        start,
        interval,
      ]))![0];
    await client.query(SQL.process_recurring_charge[3], [id, start, finish]);
    await client.query(SQL.process_recurring_charge[4], [
      createId(),
      number,
      orgId,
      id,
      provider,
      invoiceId,
      transactionId ?? reference,
      currency ?? planCurrency,
      amount ?? planAmount,
      start,
      finish,
    ]);
    return [orgId, planId, id, start, finish];
  });
  await grantPaidPeriodCredits(
    pool,
    String(result[0]),
    String(result[2]),
    String(result[1]),
    result[3] as Date,
    result[4] as Date,
    reference,
    `paid-invoice:${number}`,
  );
  return true;
}
export async function upsertReconciliationIssue(
  pool: Pool,
  orgId: string | null,
  provider: string,
  resourceType: string,
  resourceId: string,
  issueType: string,
  details: unknown,
): Promise<void> {
  await pool.query(SQL.upsert_reconciliation_issue[0], [
    createId(),
    `${provider}:${resourceType}:${resourceId}:${issueType}`,
    orgId,
    provider,
    resourceType,
    resourceId,
    issueType,
    canonicalJson(details),
  ]);
}
export async function resolveReconciliationIssue(
  pool: Pool,
  provider: string,
  resourceType: string,
  resourceId: string,
  issueType: string,
): Promise<void> {
  await pool.query(SQL.resolve_reconciliation_issue[0], [
    `${provider}:${resourceType}:${resourceId}:${issueType}`,
  ]);
}
export async function listReconciliationIssues(
  pool: Pool,
  status: string | null,
): Promise<Row[]> {
  return (await rows(pool, SQL.list_reconciliation_issues[0], [status])).map(
    camel,
  );
}
async function checkoutOrg(
  pool: Pool,
  provider: string,
  reference: string,
): Promise<string | null> {
  const value = (
    await tuple(pool, SQL.checkout_org[0], [provider, reference])
  )?.[0];
  return value == null ? null : String(value);
}
async function updateSubscriptionStatus(
  pool: Pool,
  provider: string,
  id: string,
  status: string,
  cancel: boolean,
): Promise<boolean> {
  return (
    (
      await pool.query(SQL.update_subscription_status[0], [
        provider,
        id,
        status,
        cancel,
      ])
    ).rowCount === 1
  );
}
export async function processRefund(
  pool: Pool,
  provider: string,
  reference: string,
  amount: bigint | null,
): Promise<boolean> {
  const result = await transaction(pool, async (client) => {
    const checkout = await tuple(client, SQL.process_refund[0], [
      provider,
      reference,
    ]);
    if (!checkout) return null;
    const [id, orgId, planId, total, sub] = checkout;
    if (amount == null || total == null)
      return { orgId: String(orgId), issue: "refund_amount_unverified", total };
    if (amount < integer(total as Units))
      return { orgId: String(orgId), issue: "partial_refund_processed", total };
    await client.query(SQL.process_refund[1], [
      orgId,
      planId,
      provider,
      sub ?? `${provider}-charge:${reference}`,
    ]);
    await client.query(SQL.process_refund[2], [id]);
    return { orgId: String(orgId), issue: null, total };
  });
  if (!result) return false;
  if (result.issue)
    await upsertReconciliationIssue(
      pool,
      result.orgId,
      provider,
      "transaction",
      reference,
      result.issue,
      {
        refundAmountMinor: amount == null ? null : wireInteger(amount),
        transactionAmountMinor:
          result.total == null ? null : wireInteger(result.total as Units),
      },
    );
  else
    await reverseReferral(
      pool,
      result.orgId,
      "Initial payment was fully refunded",
      `${provider}:refund:${reference}`,
    );
  return true;
}
export async function processProviderEvent(
  pool: Pool,
  provider: string,
  event: ProviderEvent,
  config: ReferralRewardConfig,
): Promise<boolean> {
  switch (event.kind) {
    case "charge_succeeded":
      if (
        await activateCheckout(
          pool,
          provider,
          event.reference,
          event.customer_id,
          event.subscription_id,
          config,
        )
      )
        return true;
      return processRecurringCharge(
        pool,
        provider,
        event.reference,
        event.subscription_id,
        event.transaction_id,
        event.invoice_id,
        event.amount_minor,
        event.currency,
      );
    case "subscription_created":
      return (
        (
          await pool.query(SQL.process_provider_event[0], [
            event.subscription_id,
            provider,
            event.customer_id,
            event.plan_code,
          ])
        ).rowCount === 1
      );
    case "subscription_not_renewing":
      return updateSubscriptionStatus(
        pool,
        provider,
        event.subscription_id,
        "ACTIVE",
        true,
      );
    case "invoice_payment_failed":
      return updateSubscriptionStatus(
        pool,
        provider,
        event.subscription_id,
        "PAST_DUE",
        false,
      );
    case "subscription_disabled": {
      const row = await tuple(pool, SQL.mark_subscription_disabled[0], [
        provider,
        event.subscription_id,
      ]);
      const updated = await updateSubscriptionStatus(
        pool,
        provider,
        event.subscription_id,
        "CANCELLED",
        false,
      );
      if (updated)
        await upsertReconciliationIssue(
          pool,
          row == null ? null : String(row[0]),
          provider,
          "subscription",
          event.subscription_id,
          "subscription_disabled",
          {
            reference: event.subscription_id,
            referralReviewRequired: true,
            referralPolicy: "manual_review",
          },
        );
      return updated;
    }
    case "refund_processed":
      return processRefund(
        pool,
        provider,
        event.transaction_reference,
        event.amount_minor,
      );
    case "dispute_opened":
      await upsertReconciliationIssue(
        pool,
        await checkoutOrg(pool, provider, event.transaction_reference),
        provider,
        "transaction",
        event.transaction_reference,
        "dispute_opened",
        {
          reference: event.transaction_reference,
          referralReviewRequired: true,
          referralPolicy: "manual_review",
        },
      );
      return true;
    case "ignored":
      return false;
  }
}
export async function retryFailedPaystackEvents(
  pool: Pool,
  provider: BillingProvider,
  limit: number,
  config: ReferralRewardConfig,
): Promise<number> {
  const keys = await tuples(pool, SQL.retry_failed_paystack_events[0], [
    Math.min(200, Math.max(1, limit)),
  ]);
  let attempted = 0;
  for (const [key] of keys) {
    const payload = await tuple(pool, SQL.claim_paystack_webhook_retry[0], [
      key,
    ]);
    if (!payload) continue;
    attempted++;
    let processed: boolean;
    try {
      const event = provider.parseWebhook(payload[0]);
      processed = await processProviderEvent(
        pool,
        provider.name,
        event,
        config,
      );
    } catch (error) {
      await finishPaystackEvent(pool, String(key), "FAILED", String(error));
      continue;
    }
    await finishPaystackEvent(
      pool,
      String(key),
      processed ? "PROCESSED" : "IGNORED",
      null,
    );
  }
  return attempted;
}
export async function setSubscriptionEnabled(
  pool: Pool,
  provider: BillingProvider,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const sub = (
    await tuple(pool, SQL.set_subscription_enabled[0], [
      id,
      orgId,
      provider.name,
    ])
  )?.[0];
  if (sub == null) missing("Subscription not found");
  await provider.setSubscriptionEnabled(String(sub), enabled);
  await pool.query(SQL.set_subscription_enabled[1], [
    id,
    !enabled,
    enabled,
    orgId,
  ]);
}
const providerStateDebug = (state: string): string =>
  ({
    active: "Active",
    "non-renewing": "NonRenewing",
    attention: "Attention",
    completed: "Completed",
    cancelled: "Cancelled",
  })[state] ?? `Unknown(${JSON.stringify(state)})`;
export async function reconcileBilling(
  pool: Pool,
  provider: BillingProvider,
  limit: number,
  config: ReferralRewardConfig,
): Promise<Row> {
  limit = Math.min(200, Math.max(1, limit));
  await expireAttributions(pool, limit);
  const retries = await retryFailedPaystackEvents(
      pool,
      provider,
      limit,
      config,
    ),
    references = await tuples(pool, SQL.reconcile_billing[0], [
      provider.name,
      limit,
    ]);
  let completed = 0,
    pending = 0,
    failed = 0,
    subscriptionsUpdated = 0;
  for (const [raw] of references) {
    const reference = String(raw);
    let verified: VerifiedTransaction;
    try {
      verified = await provider.verifyTransaction(reference);
    } catch (error) {
      await upsertReconciliationIssue(
        pool,
        await checkoutOrg(pool, provider.name, reference),
        provider.name,
        "transaction",
        reference,
        "verification_failed",
        { error: String(error) },
      );
      failed++;
      continue;
    }
    await recordVerificationResponse(pool, provider.name, reference, verified);
    if (verified.reference !== reference) {
      await upsertReconciliationIssue(
        pool,
        await checkoutOrg(pool, provider.name, reference),
        provider.name,
        "transaction",
        reference,
        "reference_mismatch",
        { expected: reference, received: verified.reference },
      );
      failed++;
    } else if (!verified.successful) pending++;
    else if (
      await activateCheckout(
        pool,
        provider.name,
        reference,
        verified.customer_id,
        verified.subscription_id,
        config,
      )
    )
      completed++;
    else failed++;
  }
  const subscriptions = await tuples(pool, SQL.reconcile_billing[1], [
    provider.name,
    limit,
  ]);
  for (const [localId, orgId, raw, cancel] of subscriptions) {
    const id = String(raw);
    let verified: VerifiedSubscription;
    try {
      verified = await provider.verifySubscription(id);
    } catch (error) {
      await upsertReconciliationIssue(
        pool,
        String(orgId),
        provider.name,
        "subscription",
        id,
        "verification_failed",
        { error: String(error) },
      );
      failed++;
      continue;
    }
    if (verified.provider_invoice_id)
      await pool.query(SQL.reconcile_billing[2], [
        verified.provider_invoice_id,
        localId,
        provider.name,
      ]);
    const normalized = internalSubscriptionState(verified.state);
    if (!normalized) {
      await upsertReconciliationIssue(
        pool,
        String(orgId),
        provider.name,
        "subscription",
        id,
        "unknown_provider_status",
        { state: providerStateDebug(verified.state) },
      );
      failed++;
      continue;
    }
    const [status, cancelAtPeriodEnd] = normalized,
      current = (await tuple(pool, SQL.reconcile_billing[3], [localId]))![0];
    if (current !== status || cancel !== cancelAtPeriodEnd) {
      await upsertReconciliationIssue(
        pool,
        String(orgId),
        provider.name,
        "subscription",
        id,
        "state_mismatch",
        {
          internalStatus: current,
          providerState: providerStateDebug(verified.state),
          correctedStatus: status,
        },
      );
      await pool.query(SQL.reconcile_billing[4], [
        localId,
        status,
        cancelAtPeriodEnd,
        verified.current_period_start,
        verified.current_period_end,
      ]);
      subscriptionsUpdated++;
    } else
      await resolveReconciliationIssue(
        pool,
        provider.name,
        "subscription",
        id,
        "state_mismatch",
      );
    await resolveReconciliationIssue(
      pool,
      provider.name,
      "subscription",
      id,
      "verification_failed",
    );
  }
  const open = (await tuple(pool, SQL.reconcile_billing[5], [
    provider.name,
  ]))![0];
  return {
    checked: references.length,
    completed,
    pending,
    failed,
    subscriptionsChecked: subscriptions.length,
    subscriptionsUpdated,
    openIssues: wireInteger(open as Units),
    webhookRetries: retries,
  };
}
export async function getBillingSummary(
  pool: Pool,
  orgId: string,
): Promise<Row> {
  const enforced = billingEnforcementEnabled(),
    productRows = await rows(pool, SQL.get_billing_summary[0]),
    values = new Map<string, unknown>();
  for (const row of await rows(pool, SQL.get_billing_summary[1], [orgId]))
    values.set(
      String(row.key),
      mergeEntitlementValue(values.get(String(row.key)), row.value),
    );
  const features = CAPABILITIES.map((d) => ({
      key: d.key,
      name: d.name,
      description: d.description,
      enabled: !enforced || allows(values, d),
    })),
    subscriptions = new Map<string, Row>();
  for (const row of await rows(pool, SQL.get_billing_summary[2], [orgId]))
    if (!subscriptions.has(String(row.productKey)))
      subscriptions.set(String(row.productKey), row);
  const usage = new Map<string, Row>(),
    meterUsage = new Map<string, bigint>();
  for (const row of await rows(pool, SQL.get_billing_summary[3], [orgId])) {
    const product = String(row.productKey),
      key = String(row.metricKey),
      amount = integer(row.quantity as Units),
      meter = canonicalMeter(product, key);
    if (meter) meterUsage.set(meter, (meterUsage.get(meter) ?? 0n) + amount);
    const current = usage.get(product) ?? {};
    current[key] = wireInteger(amount);
    usage.set(product, current);
  }
  const meters = METERS.map((d) => {
    const legacy = legacyMeter(d.key),
      limit =
        i64(values.get(`limit.${d.key}`)) ??
        (legacy ? i64(values.get(`limit.${legacy[0]}.${legacy[1]}`)) : null);
    return {
      key: d.key,
      name: d.name,
      description: d.description,
      used: wireInteger(meterUsage.get(d.key) ?? 0n),
      limit: enforced && limit != null ? wireInteger(limit) : null,
    };
  });
  const products = productRows.map((product) => {
    const key = String(product.key),
      subscription = subscriptions.get(key),
      hasAccess =
        !enforced ||
        values.get(`product.${key}.enabled`) === true ||
        (subscription != null &&
          subscriptionGrantsAccess(String(subscription.status))),
      limits: Row = {};
    for (const [name, value] of values) {
      const prefix = `limit.${key}.`,
        amount = i64(value);
      if (name.startsWith(prefix) && amount != null)
        limits[name.slice(prefix.length)] = wireInteger(amount);
    }
    return {
      ...product,
      hasAccess,
      state: hasAccess ? "enabled" : "upgrade_required",
      planName: subscription?.planName ?? null,
      subscriptionStatus: subscription?.status ?? null,
      subscriptionId: subscription?.id ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      usage: usage.get(key) ?? {},
      limits,
    };
  });
  return {
    orgId,
    features,
    meters,
    products,
    manualGrants: (await listManualGrants(pool, orgId)).filter(
      (row) =>
        row.endsAt == null || (row.endsAt as Date).getTime() > Date.now(),
    ),
    payments: (await rows(pool, SQL.get_billing_summary[4], [orgId])).map(
      camel,
    ),
    invoices: (await rows(pool, SQL.get_billing_summary[5], [orgId])).map(
      camel,
    ),
  };
}
const dateKey = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
const dayOffset = (value: string, days: number): string =>
  new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
function dailyUsage(
  start: string,
  count: number,
  credits: Row[],
  operations: Row[],
): Row[] {
  const byDate = new Map<string, { credits: bigint; operations: bigint }>();
  for (const row of credits) {
    const key = dateKey(row.date),
      current = byDate.get(key) ?? { credits: 0n, operations: 0n };
    current.credits += integer(row.credits_used as Units);
    byDate.set(key, current);
  }
  for (const row of operations) {
    const key = dateKey(row.date),
      current = byDate.get(key) ?? { credits: 0n, operations: 0n };
    current.operations += integer(row.operations as Units);
    byDate.set(key, current);
  }
  return Array.from({ length: count }, (_, index) => {
    const date = dayOffset(start, index),
      current = byDate.get(date);
    return {
      date,
      creditsUsed: wireInteger(current?.credits ?? 0n),
      operations: wireInteger(current?.operations ?? 0n),
    };
  });
}
export async function getBillingUsage(
  pool: Pool,
  orgId: string,
  days: number,
): Promise<Row> {
  days = Math.max(7, Math.min(90, days));
  const now = new Date(),
    timezone = String(
      (await tuple(pool, SQL.get_billing_usage[0], [orgId]))?.[0] ?? "UTC",
    ),
    today = dateKey(
      (await tuple(pool, SQL.get_billing_usage[1], [timezone]))![0],
    ),
    firstDay = dayOffset(today, 1 - days),
    start = (await tuple(pool, SQL.get_billing_usage[2], [
      timezone,
      days - 1,
    ]))![0] as Date,
    credit = await rows(pool, SQL.get_billing_usage[3], [
      orgId,
      start,
      now,
      timezone,
    ]),
    operations = await rows(pool, SQL.get_billing_usage[4], [
      orgId,
      start,
      timezone,
      now,
    ]),
    daily = dailyUsage(firstDay, days, credit, operations),
    previousStart = new Date(start.getTime() - days * 86400000),
    previousDaily = dailyUsage(
      dayOffset(firstDay, -days),
      days,
      await rows(pool, SQL.get_billing_usage[5], [
        orgId,
        previousStart,
        start,
        timezone,
      ]),
      await rows(pool, SQL.get_billing_usage[6], [
        orgId,
        previousStart,
        timezone,
        start,
      ]),
    ),
    breakdown = (
      await rows(pool, SQL.get_billing_usage[7], [orgId, start, now])
    ).map((row) => ({
      key: row.action_key,
      creditsUsed: wireInteger(row.credits_used as Units),
      operations: wireInteger(row.operations as Units),
    }));
  return {
    rangeStart: start,
    rangeEnd: now,
    timezone,
    granularity: "day",
    daily,
    previousDaily,
    creditsUsed: wireInteger(
      daily.reduce((sum, row) => sum + integer(row.creditsUsed as Units), 0n),
    ),
    operations: wireInteger(
      daily.reduce((sum, row) => sum + integer(row.operations as Units), 0n),
    ),
    breakdown,
  };
}
