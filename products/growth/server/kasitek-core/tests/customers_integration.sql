BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('customer-test-owner-a', 'customer-test-owner-a@example.test', NOW(), NOW()),
  ('customer-test-owner-b', 'customer-test-owner-b@example.test', NOW(), NOW());

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('customer-test-org-a', 'Customer Test A', 'customer-test-a', 'customer-test-owner-a', NOW(), NOW()),
  ('customer-test-org-b', 'Customer Test B', 'customer-test-b', 'customer-test-owner-b', NOW(), NOW());

INSERT INTO "Customer" (id, "orgId", "displayName", "createdAt", "updatedAt") VALUES
  ('customer-test-a-1', 'customer-test-org-a', 'Alex', NOW(), NOW()),
  ('customer-test-a-2', 'customer-test-org-a', 'Alex', NOW(), NOW()),
  ('customer-test-b-1', 'customer-test-org-b', 'Alex', NOW(), NOW());

INSERT INTO "CustomerIdentity" (
  id, "orgId", "customerId", channel, "externalId", "identityKey", "createdAt", "updatedAt"
) VALUES
  ('identity-test-wa-a', 'customer-test-org-a', 'customer-test-a-1', 'whatsapp', '+27820000001', 'whatsapp:+27820000001', NOW(), NOW()),
  ('identity-test-wa-b', 'customer-test-org-b', 'customer-test-b-1', 'whatsapp', '+27820000001', 'whatsapp:+27820000001', NOW(), NOW());

INSERT INTO "CustomerIdentity" (
  id, "orgId", "customerId", channel, "scopeId", "externalId", "identityKey", "createdAt", "updatedAt"
) VALUES
  ('identity-test-meta-a-1', 'customer-test-org-a', 'customer-test-a-1', 'instagram', 'channel-a', 'participant-1', 'instagram:channel-a:participant-1', NOW(), NOW()),
  ('identity-test-meta-a-2', 'customer-test-org-a', 'customer-test-a-2', 'instagram', 'channel-b', 'participant-1', 'instagram:channel-b:participant-1', NOW(), NOW());

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "Customer" WHERE "orgId" = 'customer-test-org-a' AND "displayName" = 'Alex') <> 2 THEN
    RAISE EXCEPTION 'customers with matching display names were incorrectly merged';
  END IF;

  IF (SELECT COUNT(*) FROM "CustomerIdentity" WHERE "identityKey" = 'whatsapp:+27820000001') <> 2 THEN
    RAISE EXCEPTION 'the same provider identity was not isolated between organizations';
  END IF;

  IF (SELECT COUNT(*) FROM "CustomerIdentity" WHERE "orgId" = 'customer-test-org-a' AND "externalId" = 'participant-1') <> 2 THEN
    RAISE EXCEPTION 'Meta identities from separate channel scopes were incorrectly merged';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO "CustomerIdentity" (
      id, "orgId", "customerId", channel, "externalId", "identityKey", "createdAt", "updatedAt"
    ) VALUES (
      'identity-test-duplicate', 'customer-test-org-a', 'customer-test-a-2', 'whatsapp',
      '+27820000001', 'whatsapp:+27820000001', NOW(), NOW()
    );
    RAISE EXCEPTION 'duplicate organization identity was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO "CustomerIdentity" (
      id, "orgId", "customerId", channel, "externalId", "identityKey", "createdAt", "updatedAt"
    ) VALUES (
      'identity-test-cross-org', 'customer-test-org-a', 'customer-test-b-1', 'whatsapp',
      '+27820000002', 'whatsapp:+27820000002', NOW(), NOW()
    );
    RAISE EXCEPTION 'cross-organization customer identity link was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
