CREATE TYPE "ExternalConnectionStatus" AS ENUM (
    'NOT_CONNECTED',
    'CONNECTING',
    'CONNECTED',
    'NEEDS_ATTENTION',
    'DISCONNECTED',
    'REVOKED'
);

CREATE TABLE "ExternalConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "status" "ExternalConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "statusOverride" "ExternalConnectionStatus",
    "credentialStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "webhookStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalConnectionCapability" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "entitlementKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalConnectionCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalConnectionConsumer" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalConnectionConsumer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalConnection_orgId_sourceType_sourceId_key"
    ON "ExternalConnection"("orgId", "sourceType", "sourceId");
CREATE INDEX "ExternalConnection_orgId_status_idx" ON "ExternalConnection"("orgId", "status");
CREATE INDEX "ExternalConnection_orgId_provider_idx" ON "ExternalConnection"("orgId", "provider");
CREATE UNIQUE INDEX "ExternalConnectionCapability_connectionId_key_key"
    ON "ExternalConnectionCapability"("connectionId", "key");
CREATE INDEX "ExternalConnectionCapability_key_enabled_idx"
    ON "ExternalConnectionCapability"("key", "enabled");
CREATE UNIQUE INDEX "ExternalConnectionConsumer_connectionId_productKey_key"
    ON "ExternalConnectionConsumer"("connectionId", "productKey");
CREATE INDEX "ExternalConnectionConsumer_productKey_idx"
    ON "ExternalConnectionConsumer"("productKey");

ALTER TABLE "ExternalConnection"
    ADD CONSTRAINT "ExternalConnection_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalConnectionCapability"
    ADD CONSTRAINT "ExternalConnectionCapability_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalConnectionConsumer"
    ADD CONSTRAINT "ExternalConnectionConsumer_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ExternalConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ExternalConnection" (
    "id", "orgId", "provider", "sourceType", "sourceId", "externalAccountId",
    "displayName", "status", "credentialStatus", "healthStatus", "webhookStatus",
    "lastCheckedAt", "metadata", "createdAt", "updatedAt"
)
SELECT
    'ext_' || wc."id", wc."orgId", 'WHATSAPP', 'WHATSAPP', wc."id", wc."phoneNumberId",
    COALESCE(wc."phoneDisplayNumber", wc."phoneNumberId"), 'CONNECTED', 'ACTIVE',
    CASE WHEN wc."verified" THEN 'HEALTHY' ELSE 'UNKNOWN' END, 'UNKNOWN', wc."updatedAt",
    jsonb_build_object(
        'wabaId', wc."wabaId",
        'qualityRating', wc."currentQualityRating"::text,
        'dailyLimitEstimate', wc."dailyLimitEstimate"
    ), wc."createdAt", wc."updatedAt"
FROM "WhatsappConnection" wc
WHERE wc."orgId" IS NOT NULL
ON CONFLICT ("orgId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "ExternalConnection" (
    "id", "orgId", "provider", "sourceType", "sourceId", "externalAccountId",
    "displayName", "handle", "status", "credentialStatus", "healthStatus", "webhookStatus",
    "lastCheckedAt", "metadata", "createdAt", "updatedAt"
)
SELECT
    'ext_' || sc."id", sc."orgId", sc."platform"::text, 'SOCIAL', sc."id", sc."externalAccountId",
    sc."displayName", sc."handle",
    CASE sc."status"::text
        WHEN 'CONNECTED' THEN 'CONNECTED'::"ExternalConnectionStatus"
        WHEN 'NEEDS_REAUTH' THEN 'NEEDS_ATTENTION'::"ExternalConnectionStatus"
        ELSE 'DISCONNECTED'::"ExternalConnectionStatus"
    END,
    CASE WHEN sc."status"::text = 'NEEDS_REAUTH' THEN 'EXPIRED' ELSE 'ACTIVE' END,
    CASE WHEN sc."status"::text = 'CONNECTED' THEN 'HEALTHY' ELSE 'NEEDS_ATTENTION' END,
    'UNKNOWN', COALESCE(sc."lastSyncedAt", sc."updatedAt"), sc."metadata", sc."createdAt", sc."updatedAt"
FROM "SocialChannelConnection" sc
WHERE sc."orgId" IS NOT NULL
ON CONFLICT ("orgId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "ExternalConnectionCapability" (
    "id", "connectionId", "key", "enabled", "entitlementKey", "createdAt", "updatedAt"
)
SELECT
    'cap_' || md5(connection."id" || capability."key"), connection."id", capability."key",
    connection."status" = 'CONNECTED'::"ExternalConnectionStatus", capability."entitlementKey",
    NOW(), NOW()
FROM "ExternalConnection" connection
CROSS JOIN LATERAL (
    SELECT * FROM (VALUES
        ('MESSAGING_INBOUND', NULL::text, ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
        ('MESSAGING_OUTBOUND', NULL::text, ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
        ('CAMPAIGNS_SEND', 'product.reach.enabled', ARRAY['WHATSAPP']),
        ('TEMPLATES_MANAGE', 'product.reach.enabled', ARRAY['WHATSAPP']),
        ('AGENT_CHANNEL', 'product.agents.enabled', ARRAY['WHATSAPP', 'FACEBOOK', 'INSTAGRAM']),
        ('SOCIAL_PUBLISH', 'product.social.enabled', ARRAY['FACEBOOK', 'INSTAGRAM', 'THREADS', 'LINKEDIN', 'X', 'WHATSAPP_STATUS']),
        ('SOCIAL_ANALYTICS', 'product.social.enabled', ARRAY['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X']),
        ('COMMENTS_MANAGE', 'product.social.enabled', ARRAY['FACEBOOK', 'INSTAGRAM', 'X']),
        ('MEDIA_PUBLISH', 'product.social.enabled', ARRAY['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'WHATSAPP_STATUS'])
    ) AS definition("key", "entitlementKey", providers)
    WHERE connection."provider" = ANY(definition.providers)
) capability;

INSERT INTO "ExternalConnectionConsumer" (
    "id", "connectionId", "productKey", "createdAt", "updatedAt"
)
SELECT
    'use_' || md5(connection."id" || consumer."productKey"), connection."id",
    consumer."productKey", NOW(), NOW()
FROM "ExternalConnection" connection
CROSS JOIN LATERAL (
    SELECT unnest(CASE connection."provider"
        WHEN 'WHATSAPP' THEN ARRAY['inbox', 'reach', 'agents']
        WHEN 'FACEBOOK' THEN ARRAY['inbox', 'social', 'agents']
        WHEN 'INSTAGRAM' THEN ARRAY['inbox', 'social', 'agents']
        ELSE ARRAY['social']
    END) AS "productKey"
) consumer;
