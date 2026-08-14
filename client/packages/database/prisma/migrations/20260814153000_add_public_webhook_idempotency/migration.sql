ALTER TABLE "PublicApiWebhookSubscription"
    ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "PublicApiWebhookSubscription_orgId_idempotencyKey_key"
    ON "PublicApiWebhookSubscription"("orgId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
