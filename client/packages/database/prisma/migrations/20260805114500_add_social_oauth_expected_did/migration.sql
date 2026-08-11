ALTER TABLE "SocialOAuthAuthorization"
ADD COLUMN "expectedDid" TEXT;

DELETE FROM "SocialOAuthAuthorization";

ALTER TABLE "SocialOAuthAuthorization"
ALTER COLUMN "expectedDid" SET NOT NULL;
