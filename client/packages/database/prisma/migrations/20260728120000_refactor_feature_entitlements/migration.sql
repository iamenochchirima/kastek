-- Access is granted through stable workspace capabilities. Products and plans remain
-- billing/catalog records, but application authorization no longer depends on their names.

INSERT INTO "Product" (id, key, name, description, active, "createdAt", "updatedAt")
VALUES (
  'product_workspace',
  'workspace',
  'KasiTek Workspace',
  'Workspace subscription and feature access.',
  true,
  NOW(),
  NOW()
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    active = true,
    "updatedAt" = NOW();

-- Copy legacy organization grants to the capabilities they previously unlocked.
INSERT INTO "OrganizationEntitlementGrant" (
  id, "orgId", key, value, source, "startsAt", "endsAt", reason,
  "createdById", "createdAt", "updatedAt"
)
SELECT
  'feature_' || md5(grant_row.id || mapping.feature_key),
  grant_row."orgId",
  mapping.feature_key,
  grant_row.value,
  grant_row.source,
  grant_row."startsAt",
  grant_row."endsAt",
  COALESCE(grant_row.reason, 'Migrated from ' || grant_row.key),
  grant_row."createdById",
  grant_row."createdAt",
  NOW()
FROM "OrganizationEntitlementGrant" grant_row
JOIN (
  VALUES
    ('product.agents.enabled', 'feature.agents.manage'),
    ('product.reach.enabled', 'feature.campaigns.manage'),
    ('product.reach.enabled', 'feature.campaigns.send'),
    ('product.reach.enabled', 'feature.templates.manage'),
    ('product.crm.enabled', 'feature.contacts.access'),
    ('product.inbox.enabled', 'feature.inbox.access'),
    ('product.social.enabled', 'feature.content.manage'),
    ('product.social.enabled', 'feature.content.publish'),
    ('product.social.enabled', 'feature.analytics.view')
) AS mapping(legacy_key, feature_key)
  ON mapping.legacy_key = grant_row.key
ON CONFLICT (id) DO NOTHING;

-- Copy legacy plan entitlements so existing subscriptions grant the same access
-- without relying on runtime product-name checks.
INSERT INTO "PlanEntitlement" (
  id, "planId", key, value, "createdAt", "updatedAt"
)
SELECT
  'feature_' || md5(entitlement.id || mapping.feature_key),
  entitlement."planId",
  mapping.feature_key,
  entitlement.value,
  entitlement."createdAt",
  NOW()
FROM "PlanEntitlement" entitlement
JOIN (
  VALUES
    ('product.agents.enabled', 'feature.agents.manage'),
    ('product.reach.enabled', 'feature.campaigns.manage'),
    ('product.reach.enabled', 'feature.campaigns.send'),
    ('product.reach.enabled', 'feature.templates.manage'),
    ('product.crm.enabled', 'feature.contacts.access'),
    ('product.inbox.enabled', 'feature.inbox.access'),
    ('product.social.enabled', 'feature.content.manage'),
    ('product.social.enabled', 'feature.content.publish'),
    ('product.social.enabled', 'feature.analytics.view')
) AS mapping(legacy_key, feature_key)
  ON mapping.legacy_key = entitlement.key
ON CONFLICT ("planId", key) DO NOTHING;

-- Convert the known product-scoped limits into workspace meter limits.
INSERT INTO "OrganizationEntitlementGrant" (
  id, "orgId", key, value, source, "startsAt", "endsAt", reason,
  "createdById", "createdAt", "updatedAt"
)
SELECT
  'meter_' || md5(grant_row.id || mapping.meter_key),
  grant_row."orgId",
  mapping.meter_key,
  grant_row.value,
  grant_row.source,
  grant_row."startsAt",
  grant_row."endsAt",
  COALESCE(grant_row.reason, 'Migrated from ' || grant_row.key),
  grant_row."createdById",
  grant_row."createdAt",
  NOW()
FROM "OrganizationEntitlementGrant" grant_row
JOIN (
  VALUES
    ('limit.agents.deployments', 'limit.agent_deployments'),
    ('limit.reach.campaign_recipients', 'limit.campaign_recipients'),
    ('limit.social.publishes', 'limit.social_publishes')
) AS mapping(legacy_key, meter_key)
  ON mapping.legacy_key = grant_row.key
ON CONFLICT (id) DO NOTHING;

INSERT INTO "PlanEntitlement" (
  id, "planId", key, value, "createdAt", "updatedAt"
)
SELECT
  'meter_' || md5(entitlement.id || mapping.meter_key),
  entitlement."planId",
  mapping.meter_key,
  entitlement.value,
  entitlement."createdAt",
  NOW()
FROM "PlanEntitlement" entitlement
JOIN (
  VALUES
    ('limit.agents.deployments', 'limit.agent_deployments'),
    ('limit.reach.campaign_recipients', 'limit.campaign_recipients'),
    ('limit.social.publishes', 'limit.social_publishes')
) AS mapping(legacy_key, meter_key)
  ON mapping.legacy_key = entitlement.key
ON CONFLICT ("planId", key) DO NOTHING;

UPDATE "ExternalConnectionCapability"
SET "entitlementKey" = CASE key
  WHEN 'CAMPAIGNS_SEND' THEN 'feature.campaigns.send'
  WHEN 'TEMPLATES_MANAGE' THEN 'feature.templates.manage'
  WHEN 'AGENT_CHANNEL' THEN 'feature.agents.manage'
  WHEN 'SOCIAL_PUBLISH' THEN 'feature.content.publish'
  WHEN 'SOCIAL_ANALYTICS' THEN 'feature.analytics.view'
  WHEN 'COMMENTS_MANAGE' THEN 'feature.content.manage'
  WHEN 'MEDIA_PUBLISH' THEN 'feature.content.publish'
  ELSE "entitlementKey"
END,
"updatedAt" = NOW()
WHERE key IN (
  'CAMPAIGNS_SEND',
  'TEMPLATES_MANAGE',
  'AGENT_CHANNEL',
  'SOCIAL_PUBLISH',
  'SOCIAL_ANALYTICS',
  'COMMENTS_MANAGE',
  'MEDIA_PUBLISH'
);

UPDATE "ExternalConnectionConsumer"
SET "productKey" = CASE "productKey"
  WHEN 'reach' THEN 'campaigns'
  WHEN 'social' THEN 'content'
  ELSE "productKey"
END,
"updatedAt" = NOW()
WHERE "productKey" IN ('reach', 'social');
