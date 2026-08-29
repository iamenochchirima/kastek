-- Early-access applications now move directly from new to an approval or rejection decision.
-- Preserve historical review metadata and events, but normalize legacy rows so no application
-- remains stranded in the removed reviewing state.
UPDATE "ProductWaitlistEntry"
SET status = 'new', "updatedAt" = CURRENT_TIMESTAMP
WHERE status = 'reviewing';

DROP INDEX IF EXISTS "ProductWaitlistEntry_active_email_key";

CREATE UNIQUE INDEX "ProductWaitlistEntry_active_email_key"
  ON "ProductWaitlistEntry" (lower(email))
  WHERE status IN ('new', 'approved', 'invited', 'active');
