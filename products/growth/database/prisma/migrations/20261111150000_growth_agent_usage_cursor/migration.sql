CREATE TABLE "GrowthAgentUsageCursor" (
  "orgId" text PRIMARY KEY,
  "since" text NOT NULL,
  "updatedAt" timestamptz(6) NOT NULL DEFAULT now()
);
