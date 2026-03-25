ALTER TABLE "WhatsappContact"
    ADD COLUMN IF NOT EXISTS "listLabel" text NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS metadata jsonb;

UPDATE "WhatsappContact"
SET "listLabel" = 'default'
WHERE COALESCE("listLabel", '') = '';

ALTER TABLE "WhatsappCampaign"
    ADD COLUMN IF NOT EXISTS "listLabel" text,
    ADD COLUMN IF NOT EXISTS "defaultBatchSize" integer;

CREATE INDEX IF NOT EXISTS "WhatsappContact_userId_listLabel_idx"
    ON "WhatsappContact" ("userId", "listLabel");

CREATE INDEX IF NOT EXISTS "WhatsappCampaign_userId_listLabel_idx"
    ON "WhatsappCampaign" ("userId", "listLabel");
