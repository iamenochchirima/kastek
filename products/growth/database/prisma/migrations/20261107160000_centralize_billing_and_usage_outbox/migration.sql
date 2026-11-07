-- Central billing now owns subscriptions, invoices, credits, entitlements and
-- referrals. Growth keeps only a durable usage outbox for forwarding product
-- usage to the billing service.

DROP TABLE IF EXISTS "BillingInvoice" CASCADE;
DROP TABLE IF EXISTS "BillingCheckout" CASCADE;
DROP TABLE IF EXISTS "BillingReconciliationIssue" CASCADE;
DROP TABLE IF EXISTS "PaystackWebhookEvent" CASCADE;
DROP TABLE IF EXISTS "OrganizationSubscription" CASCADE;
DROP TABLE IF EXISTS "PlanEntitlement" CASCADE;
DROP TABLE IF EXISTS "ProductPlan" CASCADE;
DROP TABLE IF EXISTS "Product" CASCADE;
DROP TABLE IF EXISTS "OrganizationEntitlementGrant" CASCADE;
DROP TABLE IF EXISTS "UsageEvent" CASCADE;
DROP TABLE IF EXISTS "CreditAdminOperation" CASCADE;
DROP TABLE IF EXISTS "CreditUsageEvent" CASCADE;
DROP TABLE IF EXISTS "CreditReservation" CASCADE;
DROP TABLE IF EXISTS "CreditLedgerEntry" CASCADE;
DROP TABLE IF EXISTS "CreditGrant" CASCADE;
DROP TABLE IF EXISTS "CreditAccount" CASCADE;
DROP TABLE IF EXISTS "ReferralAttribution" CASCADE;
DROP TABLE IF EXISTS "ReferralCode" CASCADE;

DROP TYPE IF EXISTS "BillingInterval";
DROP TYPE IF EXISTS "OrganizationSubscriptionStatus";
DROP TYPE IF EXISTS "EntitlementSource";

ALTER TABLE "ProductWaitlistEntry" DROP COLUMN IF EXISTS "entitlementGrantIds";
ALTER TABLE "ProductWaitlistEntry" DROP COLUMN IF EXISTS "creditGrantId";

CREATE TABLE IF NOT EXISTS "BillingUsageOutbox" (
  "id" text PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "meterKey" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "sourceType" text NOT NULL,
  "sourceId" text NOT NULL,
  "idempotencyKey" text NOT NULL UNIQUE,
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
  "deliveredAt" timestamptz,
  "lastError" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "BillingUsageOutbox_pending_idx"
  ON "BillingUsageOutbox" ("deliveredAt", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "BillingUsageOutbox_org_idx"
  ON "BillingUsageOutbox" ("orgId");
