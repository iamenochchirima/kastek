CREATE TABLE "GrowthAgentReview" (
  id TEXT PRIMARY KEY, "orgId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "actorId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "taskId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "featureId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL, "requestDigest" TEXT NOT NULL, "payloadDigest" TEXT NOT NULL,
  draft JSONB NOT NULL, context JSONB, "contextRevision" TEXT, "destinationRevisions" JSONB NOT NULL,
  "rootReviewId" TEXT NOT NULL, "supersededBy" TEXT, state TEXT NOT NULL DEFAULT 'proposed', result JSONB,
  "decisionRequestId" TEXT, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "GrowthAgentReview_state_check" CHECK (state IN ('proposed','approved','rejected','executing','saved','failed','uncertain','expired')),
  CONSTRAINT "GrowthAgentReview_orgId_actorId_operationId_key" UNIQUE("orgId","actorId","operationId")
);
CREATE INDEX "GrowthAgentReview_orgId_actorId_taskId_createdAt_idx" ON "GrowthAgentReview"("orgId","actorId","taskId","createdAt");
CREATE INDEX "GrowthAgentReview_rootReviewId_idx" ON "GrowthAgentReview"("rootReviewId");
