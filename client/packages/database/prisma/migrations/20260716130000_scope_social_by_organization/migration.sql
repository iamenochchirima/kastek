-- Social accounts belong to a workspace. Multiple members must reuse the same
-- provider account instead of creating one copy per connecting user.
DROP INDEX IF EXISTS "SocialChannelConnection_userId_platform_externalAccountId_key";

CREATE TEMP TABLE "_SocialChannelDuplicate" ON COMMIT DROP AS
SELECT id AS "duplicateId", "keepId"
FROM (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY "orgId", platform, "externalAccountId"
      ORDER BY "createdAt", id
    ) AS "keepId",
    ROW_NUMBER() OVER (
      PARTITION BY "orgId", platform, "externalAccountId"
      ORDER BY "createdAt", id
    ) AS position
  FROM "SocialChannelConnection"
  WHERE "orgId" IS NOT NULL AND "externalAccountId" IS NOT NULL
) ranked
WHERE position > 1;

UPDATE "SocialPost" post
SET "primaryChannelId" = duplicate."keepId"
FROM "_SocialChannelDuplicate" duplicate
WHERE post."primaryChannelId" = duplicate."duplicateId";

UPDATE "SocialPublishJob" job
SET "channelConnectionId" = duplicate."keepId"
FROM "_SocialChannelDuplicate" duplicate
WHERE job."channelConnectionId" = duplicate."duplicateId";

DELETE FROM "SocialChannelConnection" channel
USING "_SocialChannelDuplicate" duplicate
WHERE channel.id = duplicate."duplicateId";

CREATE UNIQUE INDEX "SocialChannelConnection_orgId_platform_externalAccountId_key"
  ON "SocialChannelConnection"("orgId", platform, "externalAccountId");

CREATE INDEX IF NOT EXISTS "SocialChannelConnection_orgId_status_idx"
  ON "SocialChannelConnection"("orgId", status);
