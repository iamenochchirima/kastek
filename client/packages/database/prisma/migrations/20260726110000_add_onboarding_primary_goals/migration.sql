ALTER TABLE "OrganizationOnboardingProfile"
  ADD COLUMN "primaryGoals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "OrganizationOnboardingProfile"
SET "primaryGoals" = ARRAY["primaryGoal"]
WHERE "primaryGoal" IS NOT NULL AND "primaryGoal" <> '';
