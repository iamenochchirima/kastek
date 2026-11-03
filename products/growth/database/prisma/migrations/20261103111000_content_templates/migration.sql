CREATE TABLE "ContentTemplate" (
  id TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, category TEXT, content TEXT NOT NULL,
  channels TEXT[] NOT NULL, variants JSONB NOT NULL DEFAULT '[]', fields JSONB NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "creatorId" TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  "updatedById" TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  "sourcePostId" TEXT, "sourceKey" TEXT, "inputDigest" TEXT, "lastMutationKey" TEXT, "lastMutationDigest" TEXT,
  "archivedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("orgId", "sourceKey")
);
CREATE INDEX "ContentTemplate_org_archive_created_idx" ON "ContentTemplate" ("orgId", "archivedAt", "createdAt" DESC, id DESC);
CREATE INDEX "ContentTemplate_org_category_idx" ON "ContentTemplate" ("orgId", category);
CREATE TABLE "ContentTemplateMedia" (
  id TEXT PRIMARY KEY, "templateId" TEXT NOT NULL REFERENCES "ContentTemplate"(id) ON DELETE CASCADE,
  "assetId" TEXT NOT NULL REFERENCES "ContentMediaAsset"(id) ON DELETE RESTRICT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0, "altText" TEXT,
  UNIQUE ("templateId", "sortOrder"), UNIQUE ("templateId", "assetId")
);
CREATE INDEX "ContentTemplateMedia_asset_idx" ON "ContentTemplateMedia" ("assetId");
CREATE TABLE "ContentTemplateMutation" (
  "orgId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "operationKey" TEXT NOT NULL, "templateId" TEXT NOT NULL REFERENCES "ContentTemplate"(id) ON DELETE CASCADE,
  action TEXT NOT NULL, "inputDigest" TEXT NOT NULL, result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("orgId", "operationKey")
);
CREATE INDEX "ContentTemplateMutation_template_idx" ON "ContentTemplateMutation" ("templateId");
