-- WhatsApp connections and templates are shared workspace resources. Keep one
-- template record per workspace while preserving campaign references.
DROP INDEX IF EXISTS "WhatsappTemplate_userId_templateName_language_key";

CREATE TEMP TABLE "_WhatsappTemplateDuplicate" ON COMMIT DROP AS
SELECT id AS "duplicateId", "keepId"
FROM (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY "orgId", "templateName", language
      ORDER BY "updatedAt" DESC, id
    ) AS "keepId",
    ROW_NUMBER() OVER (
      PARTITION BY "orgId", "templateName", language
      ORDER BY "updatedAt" DESC, id
    ) AS position
  FROM "WhatsappTemplate"
  WHERE "orgId" IS NOT NULL
) ranked
WHERE position > 1;

UPDATE "WhatsappCampaign" campaign
SET "templateId" = duplicate."keepId"
FROM "_WhatsappTemplateDuplicate" duplicate
WHERE campaign."templateId" = duplicate."duplicateId";

DELETE FROM "WhatsappTemplate" template
USING "_WhatsappTemplateDuplicate" duplicate
WHERE template.id = duplicate."duplicateId";

CREATE UNIQUE INDEX "WhatsappTemplate_orgId_templateName_language_key"
  ON "WhatsappTemplate"("orgId", "templateName", language);
