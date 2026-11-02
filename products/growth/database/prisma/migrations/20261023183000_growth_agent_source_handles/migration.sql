CREATE TABLE "GrowthAgentSourceHandle" (
  id text PRIMARY KEY CHECK(id ~ '^growth-resource:[a-f0-9]{64}$'),
  "orgId" text NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "actorId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "actorIssuer" text NOT NULL,
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "GrowthAgentSourceHandle_orgId_actorId_idx" ON "GrowthAgentSourceHandle"("orgId","actorId");
