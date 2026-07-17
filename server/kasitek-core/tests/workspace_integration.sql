BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('workspace-owner-a', 'workspace-owner-a@example.test', NOW(), NOW()),
  ('workspace-member-a', 'workspace-member-a@example.test', NOW(), NOW()),
  ('workspace-owner-b', 'workspace-owner-b@example.test', NOW(), NOW());

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('workspace-org-a', 'Workspace A', 'workspace-integration-a', 'workspace-owner-a', NOW(), NOW()),
  ('workspace-org-b', 'Workspace B', 'workspace-integration-b', 'workspace-owner-b', NOW(), NOW());

INSERT INTO "OrganizationMember" (
  id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt"
) VALUES
  ('workspace-membership-owner-a', 'workspace-org-a', 'workspace-owner-a', 'OWNER', NOW(), NOW(), NOW()),
  ('workspace-membership-member-a', 'workspace-org-a', 'workspace-member-a', 'MEMBER', NOW(), NOW(), NOW()),
  ('workspace-membership-owner-b', 'workspace-org-b', 'workspace-owner-b', 'OWNER', NOW(), NOW(), NOW());

INSERT INTO "BotConfiguration" (
  id, "userId", "orgId", name, type, status, "createdAt", "updatedAt"
) VALUES
  ('workspace-bot-owner-a', 'workspace-owner-a', 'workspace-org-a', 'Owner-created bot', 'support', 'active', NOW(), NOW()),
  ('workspace-bot-member-a', 'workspace-member-a', 'workspace-org-a', 'Member-created bot', 'support', 'active', NOW(), NOW()),
  ('workspace-bot-owner-b', 'workspace-owner-b', 'workspace-org-b', 'Other organization bot', 'support', 'active', NOW(), NOW());

DO $$
BEGIN
  IF (
    SELECT COUNT(*) FROM "BotConfiguration" WHERE "orgId" = 'workspace-org-a'
  ) <> 2 THEN
    RAISE EXCEPTION 'workspace summary did not include records created by both organization members';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BotConfiguration"
    WHERE "orgId" = 'workspace-org-a' AND id = 'workspace-bot-owner-b'
  ) THEN
    RAISE EXCEPTION 'workspace summary scope leaked a record from another organization';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "OrganizationMember"
    WHERE "orgId" = 'workspace-org-a' AND "userId" = 'workspace-owner-b'
  ) THEN
    RAISE EXCEPTION 'cross-organization user unexpectedly has workspace membership';
  END IF;
END $$;

ROLLBACK;
