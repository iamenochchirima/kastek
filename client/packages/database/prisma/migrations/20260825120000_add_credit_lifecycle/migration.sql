ALTER TABLE "ProductPlan"
  ADD COLUMN "creditsPerPeriod" BIGINT;

ALTER TABLE "ProductPlan"
  ADD CONSTRAINT "ProductPlan_creditsPerPeriod_check"
  CHECK ("creditsPerPeriod" IS NULL OR "creditsPerPeriod" > 0);

CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "maxRedemptions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReferralCode_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT "ReferralCode_redemption_check" CHECK ("redemptionCount" >= 0 AND ("maxRedemptions" IS NULL OR "maxRedemptions" > 0))
);

CREATE UNIQUE INDEX "ReferralCode_orgId_key" ON "ReferralCode"("orgId");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE INDEX "ReferralCode_status_createdAt_idx" ON "ReferralCode"("status", "createdAt");
ALTER TABLE "ReferralCode"
  ADD CONSTRAINT "ReferralCode_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReferralAttribution" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "referrerOrgId" TEXT NOT NULL,
    "refereeOrgId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ATTRIBUTED',
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "qualificationReference" TEXT,
    "referrerGrantId" TEXT,
    "refereeGrantId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReferralAttribution_status_check" CHECK ("status" IN ('ATTRIBUTED', 'QUALIFIED', 'AWARDED', 'REJECTED'))
);

CREATE UNIQUE INDEX "ReferralAttribution_refereeOrgId_key" ON "ReferralAttribution"("refereeOrgId");
CREATE UNIQUE INDEX "ReferralAttribution_codeId_refereeOrgId_key" ON "ReferralAttribution"("codeId", "refereeOrgId");
CREATE INDEX "ReferralAttribution_referrerOrgId_status_idx" ON "ReferralAttribution"("referrerOrgId", "status");
CREATE INDEX "ReferralAttribution_status_qualifiedAt_idx" ON "ReferralAttribution"("status", "qualifiedAt");
ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_codeId_fkey"
  FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_referrerOrgId_fkey"
  FOREIGN KEY ("referrerOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_refereeOrgId_fkey"
  FOREIGN KEY ("refereeOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
