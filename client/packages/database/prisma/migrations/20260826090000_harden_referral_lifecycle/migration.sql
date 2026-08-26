ALTER TABLE "ReferralCode"
  ADD COLUMN "attributionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "disabledReason" TEXT;

UPDATE "ReferralCode"
SET "attributionCount" = "redemptionCount";

UPDATE "ReferralCode"
SET "redemptionCount" = 0;

UPDATE "ReferralCode" AS code
SET "redemptionCount" = COALESCE(qualified.count, 0)
FROM (
  SELECT "codeId", COUNT(*)::integer AS count
  FROM "ReferralAttribution"
  WHERE status IN ('QUALIFIED', 'AWARDED', 'REVERSED')
  GROUP BY "codeId"
) AS qualified
WHERE code.id = qualified."codeId";

ALTER TABLE "ReferralAttribution"
  ADD COLUMN "attributionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "awardedAt" TIMESTAMP(3),
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversalReason" TEXT,
  ADD COLUMN "referrerRewardCredits" INTEGER,
  ADD COLUMN "refereeRewardCredits" INTEGER,
  ADD COLUMN "rewardExpiryDays" INTEGER,
  ADD COLUMN "programVersion" TEXT;

UPDATE "ReferralAttribution"
SET "attributionExpiresAt" = "attributedAt" + INTERVAL '90 days'
WHERE "attributionExpiresAt" IS NULL;

UPDATE "ReferralAttribution"
SET "awardedAt" = COALESCE("qualifiedAt", "updatedAt")
WHERE status IN ('AWARDED', 'REVERSED') AND "awardedAt" IS NULL;

ALTER TABLE "ReferralAttribution"
  DROP CONSTRAINT "ReferralAttribution_status_check";

ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_status_check"
  CHECK (status IN ('ATTRIBUTED', 'QUALIFIED', 'AWARDED', 'EXPIRED', 'REJECTED', 'REVERSED'));

CREATE INDEX "ReferralAttribution_status_attributionExpiresAt_idx"
  ON "ReferralAttribution"(status, "attributionExpiresAt");

CREATE UNIQUE INDEX "ReferralAttribution_qualificationReference_key"
  ON "ReferralAttribution"("qualificationReference");
