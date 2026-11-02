ALTER TABLE "AdminWebhookReplayCommand"
 ADD COLUMN "customerId" TEXT REFERENCES "Organization"(id) ON DELETE RESTRICT,
 ADD COLUMN "operationId" TEXT UNIQUE,
 ADD COLUMN "requestDigest" TEXT,
 ADD COLUMN reason TEXT;
CREATE INDEX "AdminWebhookReplayCommand_customer_history_idx" ON "AdminWebhookReplayCommand"("customerId",id);
CREATE TABLE "AdminCustomerReplayApproval" (
 id TEXT PRIMARY KEY,
 "commandId" TEXT NOT NULL REFERENCES "AdminWebhookReplayCommand"(id) ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL,
 digest TEXT NOT NULL,
 reason TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
 UNIQUE("commandId","actorId")
);
ALTER TABLE "AdminWebhookReplayCommand" ADD COLUMN "settledStatus" TEXT CHECK ("settledStatus" IN ('confirmed','failed'));
CREATE FUNCTION settle_admin_customer_replay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('DELIVERED','FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
  UPDATE "AdminWebhookReplayCommand"
   SET "settledStatus"=CASE WHEN NEW.status='DELIVERED' THEN 'confirmed' ELSE 'failed' END,"updatedAt"=now()
   WHERE "deliveryId"=NEW.id AND "customerId" IS NOT NULL AND status='completed' AND "settledStatus" IS NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER settle_admin_customer_replay AFTER UPDATE OF status ON "PublicApiWebhookDelivery"
 FOR EACH ROW EXECUTE FUNCTION settle_admin_customer_replay();
