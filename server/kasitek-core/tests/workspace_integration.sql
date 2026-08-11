-- Workspace summary integration fixture.
-- Agent counts and attention now come from the Agent Platform service; this
-- fixture only verifies that the active organization membership boundary is
-- preserved in the core database.
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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OrganizationMember"
    WHERE "orgId" = 'workspace-org-a' AND "userId" = 'workspace-owner-b'
  ) THEN
    RAISE EXCEPTION 'cross-organization user unexpectedly has workspace membership';
  END IF;
END $$;

ROLLBACK;
