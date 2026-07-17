-- Agent execution events may be associated with a canonical customer in the
-- same organisation. Deployment records remain workspace-level.
ALTER TABLE "BotEvent" ADD COLUMN "customerId" TEXT;

ALTER TABLE "BotEvent"
    ADD CONSTRAINT "BotEvent_customerId_fkey"
    FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BotEvent_customerId_createdAt_idx"
    ON "BotEvent"("customerId", "createdAt");
