CREATE TABLE "OrganizationOnboardingProfile" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    website TEXT,
    "primaryGoal" TEXT,
    "teamRole" TEXT,
    industry TEXT,
    "referralSource" TEXT,
    "completedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationOnboardingProfile_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "OrganizationOnboardingProfile_orgId_key" ON "OrganizationOnboardingProfile"("orgId");

ALTER TABLE "OrganizationOnboardingProfile"
  ADD CONSTRAINT "OrganizationOnboardingProfile_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;
