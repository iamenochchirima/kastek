CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "OrganizationInvitation"
  ADD COLUMN "tokenHash" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3);

UPDATE "OrganizationInvitation"
SET "tokenHash" = encode(digest(token, 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;

ALTER TABLE "OrganizationInvitation"
  ALTER COLUMN "tokenHash" SET NOT NULL;

CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key"
  ON "OrganizationInvitation"("tokenHash");
CREATE INDEX "OrganizationInvitation_tokenHash_idx"
  ON "OrganizationInvitation"("tokenHash");

DROP INDEX IF EXISTS "OrganizationInvitation_token_key";
DROP INDEX IF EXISTS "OrganizationInvitation_token_idx";
ALTER TABLE "OrganizationInvitation" DROP COLUMN token;
