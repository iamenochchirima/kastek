CREATE TABLE "SocialPostInsightObservation" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "publishJobId" TEXT NOT NULL,
    platform "SocialPlatform" NOT NULL,
    "metricKey" TEXT NOT NULL,
    value BIGINT,
    availability TEXT NOT NULL DEFAULT 'available',
    "providerMetricKey" TEXT,
    "observationKey" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "adapterVersion" TEXT NOT NULL,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostInsightObservation_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "SocialPostInsightObservation_observationKey_key"
  ON "SocialPostInsightObservation"("observationKey");
CREATE INDEX "SocialPostInsightObservation_orgId_postId_platform_observedAt_idx"
  ON "SocialPostInsightObservation"("orgId", "postId", platform, "observedAt");
CREATE INDEX "SocialPostInsightObservation_publishJobId_metricKey_observedAt_idx"
  ON "SocialPostInsightObservation"("publishJobId", "metricKey", "observedAt");
CREATE INDEX "SocialPostInsightObservation_orgId_platform_metricKey_observedAt_idx"
  ON "SocialPostInsightObservation"("orgId", platform, "metricKey", "observedAt");
CREATE INDEX "SocialPostInsightObservation_availability_fetchedAt_idx"
  ON "SocialPostInsightObservation"(availability, "fetchedAt");

ALTER TABLE "SocialPostInsightObservation"
  ADD CONSTRAINT "SocialPostInsightObservation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SocialPostInsightObservation_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "SocialPost"(id)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SocialPostInsightObservation_publishJobId_fkey"
  FOREIGN KEY ("publishJobId") REFERENCES "SocialPublishJob"(id)
  ON DELETE CASCADE ON UPDATE CASCADE;
