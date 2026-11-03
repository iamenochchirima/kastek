ALTER TABLE "ContentMediaAsset"
  ADD COLUMN IF NOT EXISTS "displayName" TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "defaultAltText" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS "ContentMediaAsset_library_idx" ON "ContentMediaAsset" ("orgId", "archivedAt", kind, "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS "ContentMediaAsset_tags_idx" ON "ContentMediaAsset" USING GIN(tags);
CREATE TABLE IF NOT EXISTS "ContentMediaLibraryMutation" (
  "orgId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  action TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  result JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("orgId", "operationKey")
);
