-- Product catalogue, organisation subscriptions, feature grants, and usage events.
-- Payment providers are intentionally not coupled to entitlement enforcement.

CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "OrganizationSubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "EntitlementSource" AS ENUM ('PLAN', 'TRIAL', 'MANUAL', 'MIGRATION');

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_key_key" ON "Product"("key");

CREATE TABLE "ProductPlan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "amountMinor" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "paystackPlanCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductPlan_key_key" ON "ProductPlan"("key");
CREATE UNIQUE INDEX "ProductPlan_paystackPlanCode_key" ON "ProductPlan"("paystackPlanCode");
CREATE INDEX "ProductPlan_productId_active_idx" ON "ProductPlan"("productId", "active");

CREATE TABLE "PlanEntitlement" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanEntitlement_planId_key_key" ON "PlanEntitlement"("planId", "key");
CREATE INDEX "PlanEntitlement_key_idx" ON "PlanEntitlement"("key");

CREATE TABLE "OrganizationSubscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "OrganizationSubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationSubscription_providerSubscriptionId_key" ON "OrganizationSubscription"("providerSubscriptionId");
CREATE INDEX "OrganizationSubscription_orgId_status_idx" ON "OrganizationSubscription"("orgId", "status");
CREATE INDEX "OrganizationSubscription_planId_status_idx" ON "OrganizationSubscription"("planId", "status");

CREATE TABLE "OrganizationEntitlementGrant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" "EntitlementSource" NOT NULL DEFAULT 'MANUAL',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationEntitlementGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrganizationEntitlementGrant_orgId_key_startsAt_endsAt_idx"
  ON "OrganizationEntitlementGrant"("orgId", "key", "startsAt", "endsAt");

CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");
CREATE INDEX "UsageEvent_orgId_productKey_metricKey_occurredAt_idx"
  ON "UsageEvent"("orgId", "productKey", "metricKey", "occurredAt");

ALTER TABLE "ProductPlan" ADD CONSTRAINT "ProductPlan_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanEntitlement" ADD CONSTRAINT "PlanEntitlement_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ProductPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ProductPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationEntitlementGrant" ADD CONSTRAINT "OrganizationEntitlementGrant_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Product" ("id", "key", "name", "description", "active", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'agents', 'KasiAgents', 'AI agents, deployments, and automation.', true, NOW(), NOW()),
  (gen_random_uuid()::text, 'reach', 'KasiReach', 'Campaigns, templates, and outbound messaging.', true, NOW(), NOW()),
  (gen_random_uuid()::text, 'social', 'KasiSocial', 'Social content, publishing, and reporting.', true, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;

-- Preserve access to product areas that an existing organisation already uses.
INSERT INTO "OrganizationEntitlementGrant" ("id", "orgId", "key", "value", "source", "reason", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o.id, 'product.agents.enabled', 'true'::jsonb, 'MIGRATION'::"EntitlementSource", 'Existing agent configuration', NOW(), NOW()
FROM "Organization" o
WHERE EXISTS (SELECT 1 FROM "BotConfiguration" b WHERE b."orgId" = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM "OrganizationEntitlementGrant" grant
    WHERE grant."orgId" = o.id AND grant.key = 'product.agents.enabled'
  );

INSERT INTO "OrganizationEntitlementGrant" ("id", "orgId", "key", "value", "source", "reason", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o.id, 'product.reach.enabled', 'true'::jsonb, 'MIGRATION'::"EntitlementSource", 'Existing outbound messaging data', NOW(), NOW()
FROM "Organization" o
WHERE (
    EXISTS (SELECT 1 FROM "WhatsappConnection" c WHERE c."orgId" = o.id)
    OR EXISTS (SELECT 1 FROM "WhatsappContact" c WHERE c."orgId" = o.id)
    OR EXISTS (SELECT 1 FROM "WhatsappCampaign" c WHERE c."orgId" = o.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "OrganizationEntitlementGrant" grant
    WHERE grant."orgId" = o.id AND grant.key = 'product.reach.enabled'
  );

INSERT INTO "OrganizationEntitlementGrant" ("id", "orgId", "key", "value", "source", "reason", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o.id, 'product.social.enabled', 'true'::jsonb, 'MIGRATION'::"EntitlementSource", 'Existing social channels or publishing data', NOW(), NOW()
FROM "Organization" o
WHERE (
    EXISTS (SELECT 1 FROM "SocialChannelConnection" c WHERE c."orgId" = o.id)
    OR EXISTS (SELECT 1 FROM "SocialPost" p WHERE p."orgId" = o.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "OrganizationEntitlementGrant" grant
    WHERE grant."orgId" = o.id AND grant.key = 'product.social.enabled'
  );
