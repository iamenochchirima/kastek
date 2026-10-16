// Queries copied from the existing Rust controllers; database ownership is unchanged.
export const PROFILE_SQL_0 = `
        UPDATE "User"
        SET
            name = $1,
            phone = $2,
            image = $3,
            "updatedAt" = NOW()
        WHERE id = $4
        RETURNING
            id,
            name,
            email,
            phone,
            image,
            password,
            "emailVerified" AT TIME ZONE 'UTC' AS "emailVerified",
            "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        `;

export const PROFILE_SQL_1 = `UPDATE "User" SET phone = $1, "updatedAt" = NOW() WHERE id = $2`;

export const ONBOARDING_SQL_0 = `SELECT o.id AS "orgId", o.name AS "orgName", p.website, p."primaryGoal", COALESCE(p."primaryGoals", ARRAY[]::TEXT[]) AS "primaryGoals", p."teamRole", p.industry,
                  p."referralSource", p."completedAt" AT TIME ZONE 'UTC' AS "completedAt",
                  p."skippedAt" AT TIME ZONE 'UTC' AS "skippedAt"
           FROM "Organization" o
           LEFT JOIN "OrganizationOnboardingProfile" p ON p."orgId" = o.id
           WHERE o.id = $1`;

export const ONBOARDING_SQL_1 = `INSERT INTO "OrganizationOnboardingProfile" (
                id, "orgId", website, "primaryGoal", "primaryGoals", "teamRole", industry, "referralSource",
                "completedAt", "skippedAt", "createdAt", "updatedAt"
            ) VALUES ($1, $2, $3, $4, COALESCE($5, ARRAY[]::TEXT[]), $6, $7, $8,
                CASE WHEN $9 THEN NOW() ELSE NULL END,
                CASE WHEN $10 THEN NOW() ELSE NULL END, NOW(), NOW())
            ON CONFLICT ("orgId") DO UPDATE SET
                website = COALESCE(EXCLUDED.website, "OrganizationOnboardingProfile".website),
                "primaryGoal" = COALESCE(EXCLUDED."primaryGoal", "OrganizationOnboardingProfile"."primaryGoal"),
                "primaryGoals" = COALESCE($5, "OrganizationOnboardingProfile"."primaryGoals"),
                "teamRole" = COALESCE(EXCLUDED."teamRole", "OrganizationOnboardingProfile"."teamRole"),
                industry = COALESCE(EXCLUDED.industry, "OrganizationOnboardingProfile".industry),
                "referralSource" = COALESCE(EXCLUDED."referralSource", "OrganizationOnboardingProfile"."referralSource"),
                "completedAt" = CASE WHEN $9 THEN NOW() ELSE "OrganizationOnboardingProfile"."completedAt" END,
                "skippedAt" = CASE WHEN $10 THEN NOW() ELSE "OrganizationOnboardingProfile"."skippedAt" END,
                "updatedAt" = NOW()`;

export const PRODUCT_TOUR_SQL_0 = `SELECT p."primaryGoal", t.status, t."currentStep",
                  p."completedAt" AT TIME ZONE 'UTC' AS "completedAt",
                  p."skippedAt" AT TIME ZONE 'UTC' AS "skippedAt"
           FROM "Organization" o
           LEFT JOIN "OrganizationOnboardingProfile" p ON p."orgId" = o.id
           LEFT JOIN "UserProductTour" t ON t."orgId" = o.id AND t."userId" = $2
           WHERE o.id = $1`;

export const PRODUCT_TOUR_SQL_1 = `INSERT INTO "UserProductTour" (
              id, "userId", "orgId", status, "currentStep", "startedAt", "completedAt", "dismissedAt", "createdAt", "updatedAt"
            ) VALUES (
              $1, $2, $3, $4, $5,
              CASE WHEN $4 IN ('IN_PROGRESS', 'COMPLETED') THEN NOW() ELSE NULL END,
              CASE WHEN $4 = 'COMPLETED' THEN NOW() ELSE NULL END,
              CASE WHEN $4 = 'DISMISSED' THEN NOW() ELSE NULL END, NOW(), NOW()
            ) ON CONFLICT ("userId", "orgId") DO UPDATE SET
              status = EXCLUDED.status,
              "currentStep" = EXCLUDED."currentStep",
              "startedAt" = CASE WHEN EXCLUDED.status = 'IN_PROGRESS' THEN COALESCE("UserProductTour"."startedAt", NOW()) ELSE "UserProductTour"."startedAt" END,
              "completedAt" = CASE WHEN EXCLUDED.status = 'COMPLETED' THEN NOW() WHEN EXCLUDED.status = 'PENDING' THEN NULL ELSE "UserProductTour"."completedAt" END,
              "dismissedAt" = CASE WHEN EXCLUDED.status = 'DISMISSED' THEN NOW() WHEN EXCLUDED.status = 'PENDING' THEN NULL ELSE "UserProductTour"."dismissedAt" END,
              "updatedAt" = NOW()`;
